import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Module, NotFoundException, Param, Patch, Post, Req, Res, UnauthorizedException, BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { Db, Tx } from '../db/db.service.js';
import { config } from '../config.js';
import { AllowMfaPending, Auth, Public } from '../common/decorators.js';
import { SESSION_COOKIE } from '../common/guards.js';
import type { AppRequest, AuthInfo } from '../common/types.js';
import { parse, v } from '../common/validate.js';
import { audit } from '../common/audit.js';
import { burnPasswordCheck, decryptSecret, encryptSecret, hashPassword, newToken, newTotpSecret, sha256, verifyPassword, verifyTotp } from '../common/crypto.js';

const LANG = v.enum('en', 'ar', 'fr');
const SPECIALTY = v.str(2, 40);

const DEFAULT_HOURS = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, starts: '09:00', ends: '17:00' }));

@Controller('auth')
export class AuthController {
  constructor(private db: Db) {}

  private async startSession(res: Response, req: AppRequest, userId: string, mfaPending: boolean) {
    const token = newToken();
    await this.db.tx({}, (t) => t.q(`SELECT auth_create_session($1,$2,$3,$4,$5,$6)`, [
      userId, sha256(token), mfaPending, String(req.headers['user-agent'] ?? '').slice(0, 300), req.ip ?? null, `${config.sessionTtlHours} hours`]));
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/', maxAge: config.sessionTtlHours * 3600_000 });
    return token;
  }

  /** Creates the user row inside a transaction whose app.user_id is the new id (RLS: users can only insert themselves). */
  private async createUser(t: Tx, b: { email: string; password: string; fullName: string; phone?: string; language?: string }) {
    const id = randomUUID();
    await t.setUser(id);
    const exists = await t.one(`SELECT 1 FROM auth_find_user($1)`, [b.email]);
    if (exists) throw new BadRequestException({ message: 'An account with this email already exists. Sign in instead, then accept your invitation or add a workspace.', code: 'email_taken' });
    await t.q(`INSERT INTO users(id,email,password_hash,full_name,phone,interface_language) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, b.email, await hashPassword(b.password), b.fullName, b.phone ?? null, b.language ?? 'en']);
    return id;
  }

  private async specialtyExists(t: Tx, code: string) {
    if (!(await t.one(`SELECT 1 FROM specialties WHERE code=$1`, [code]))) throw new BadRequestException(`Unknown specialty ${code}`);
  }

  /** Independent doctor: account + private practice + first location + default service and hours, in one transaction. */
  @Public() @Post('register/doctor')
  async registerDoctor(@Body() body: unknown, @Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    const b = parse({
      fullName: v.str(2, 120), email: v.email(), password: v.password(), phone: v.str(5, 30).optional(), language: LANG.optional(),
      specialty: SPECIALTY, licenseNumber: v.str(2, 60), clinicName: v.str(2, 120), locationName: v.str(2, 120).optional(),
      address: v.str(2, 300).optional(), consultationFee: v.num(0, 1e7).optional(),
    }, body);
    const result = await this.db.tx({}, async (t) => {
      await this.specialtyExists(t, b.specialty);
      const userId = await this.createUser(t, b);
      const orgId = randomUUID();
      const { m: membershipId } = (await t.one(`SELECT app_create_organization($1,'independent_practice',$2,'doctor',$3,$4,$5) AS m`,
        [orgId, b.clinicName, b.specialty, b.licenseNumber, b.consultationFee ?? null]))!;
      await t.setOrg(orgId);
      await t.q(`UPDATE organizations SET address=$2, phone=$3, default_language=$4 WHERE id=$1`, [orgId, b.address ?? null, b.phone ?? null, b.language ?? 'en']);
      await t.q(`INSERT INTO locations(organization_id,name,address) VALUES ($1,$2,$3)`, [orgId, b.locationName ?? b.clinicName, b.address ?? null]);
      await t.q(`INSERT INTO services(organization_id,membership_id,name,default_minutes,price) VALUES ($1,$2,'Consultation',20,$3)`, [orgId, membershipId, b.consultationFee ?? 0]);
      for (const h of DEFAULT_HOURS) await t.q(`INSERT INTO working_hours(membership_id,weekday,starts,ends) VALUES ($1,$2,$3,$4)`, [membershipId, h.weekday, h.starts, h.ends]);
      await audit(t, userId, orgId, 'auth.register', 'user', userId, { kind: 'independent_practice' });
      return { userId, organizationId: orgId, membershipId };
    });
    await this.startSession(res, req, result.userId, false);
    return result;
  }

  /** Medical center: owner account + center organization + first location. Doctors and staff join by invitation. */
  @Public() @Post('register/center')
  async registerCenter(@Body() body: unknown, @Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    const b = parse({
      fullName: v.str(2, 120), email: v.email(), password: v.password(), phone: v.str(5, 30).optional(), language: LANG.optional(),
      centerName: v.str(2, 120), locationName: v.str(2, 120).optional(), address: v.str(2, 300).optional(),
    }, body);
    const result = await this.db.tx({}, async (t) => {
      const userId = await this.createUser(t, b);
      const orgId = randomUUID();
      const { m: membershipId } = (await t.one(`SELECT app_create_organization($1,'medical_center',$2,'center_owner',null,null,null) AS m`, [orgId, b.centerName]))!;
      await t.setOrg(orgId);
      await t.q(`UPDATE organizations SET address=$2, phone=$3, default_language=$4 WHERE id=$1`, [orgId, b.address ?? null, b.phone ?? null, b.language ?? 'en']);
      await t.q(`INSERT INTO locations(organization_id,name,address) VALUES ($1,$2,$3)`, [orgId, b.locationName ?? 'Main branch', b.address ?? null]);
      await audit(t, userId, orgId, 'auth.register', 'user', userId, { kind: 'medical_center' });
      return { userId, organizationId: orgId, membershipId };
    });
    await this.startSession(res, req, result.userId, false);
    return result;
  }

  @Public() @Post('login') @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    const b = parse({ email: v.email(), password: v.str(1, 200) }, body);
    const u = await this.db.tx({}, (t) => t.one(`SELECT * FROM auth_find_user($1)`, [b.email]));
    if (!u) { await burnPasswordCheck(b.password); throw new UnauthorizedException('Email or password is incorrect'); }
    if (u.locked_until && new Date(u.locked_until) > new Date()) throw new UnauthorizedException('Too many attempts. Try again in 15 minutes.');
    const ok = await verifyPassword(b.password, u.password_hash);
    await this.db.tx({}, (t) => t.q(`SELECT auth_record_login($1,$2)`, [u.id, ok]));
    if (!ok) throw new UnauthorizedException('Email or password is incorrect');
    if (u.status !== 'active') throw new ForbiddenException('This account is suspended');
    await this.startSession(res, req, u.id, u.mfa_enabled);
    await this.db.tx({ userId: u.id }, (t) => audit(t, u.id, null, u.mfa_enabled ? 'auth.login_password_ok' : 'auth.login', 'user', u.id));
    return { mfaRequired: u.mfa_enabled };
  }

  @AllowMfaPending() @Post('mfa/verify') @HttpCode(200)
  async mfaVerify(@Body() body: unknown, @Auth() a: AuthInfo) {
    const b = parse({ code: v.str(6, 6) }, body);
    return this.db.tx({ userId: a.userId }, async (t) => {
      const enc = (await t.one(`SELECT auth_my_mfa_secret() AS s`))!.s;
      if (!enc || !verifyTotp(decryptSecret(enc), b.code)) {
        await t.q(`SELECT auth_record_login($1,false)`, [a.userId]);
        throw new UnauthorizedException('That code is not valid');
      }
      await t.q(`UPDATE sessions SET mfa_pending=false WHERE id=$1`, [a.sessionId]);
      await audit(t, a.userId, null, 'auth.login', 'user', a.userId, { mfa: true });
      return { ok: true };
    });
  }

  /** Step 1 of enabling MFA: a new secret, stored encrypted, not active until confirmed with a code. */
  @Post('mfa/setup')
  async mfaSetup(@Auth() a: AuthInfo) {
    const secret = newTotpSecret();
    const email = await this.db.tx({ userId: a.userId }, async (t) => {
      const u = await t.one(`SELECT email, mfa_enabled FROM users WHERE id=$1`, [a.userId]);
      if (u.mfa_enabled) throw new BadRequestException('Two-factor authentication is already on');
      await t.q(`UPDATE users SET mfa_secret_enc=$2 WHERE id=$1`, [a.userId, encryptSecret(secret)]);
      return u.email as string;
    });
    return { secret, otpauthUrl: `otpauth://totp/MEDORA%20CLINICS:${encodeURIComponent(email)}?secret=${secret}&issuer=MEDORA%20CLINICS` };
  }

  @Post('mfa/enable') @HttpCode(200)
  async mfaEnable(@Body() body: unknown, @Auth() a: AuthInfo) {
    const b = parse({ code: v.str(6, 6) }, body);
    return this.db.tx({ userId: a.userId }, async (t) => {
      const enc = (await t.one(`SELECT auth_my_mfa_secret() AS s`))!.s;
      if (!enc || !verifyTotp(decryptSecret(enc), b.code)) throw new BadRequestException('That code is not valid');
      await t.q(`UPDATE users SET mfa_enabled=true WHERE id=$1`, [a.userId]);
      await audit(t, a.userId, null, 'auth.mfa_enabled', 'user', a.userId);
      return { mfaEnabled: true };
    });
  }

  @Post('mfa/disable') @HttpCode(200)
  async mfaDisable(@Body() body: unknown, @Auth() a: AuthInfo) {
    const b = parse({ code: v.str(6, 6), password: v.str(1, 200) }, body);
    return this.db.tx({ userId: a.userId }, async (t) => {
      const u = await t.one(`SELECT email FROM users WHERE id=$1`, [a.userId]);
      const full = await t.one(`SELECT * FROM auth_find_user($1)`, [u.email]);
      const enc = (await t.one(`SELECT auth_my_mfa_secret() AS s`))!.s;
      if (!(await verifyPassword(b.password, full.password_hash)) || !enc || !verifyTotp(decryptSecret(enc), b.code)) throw new BadRequestException('Password or code is not valid');
      await t.q(`UPDATE users SET mfa_enabled=false, mfa_secret_enc=NULL WHERE id=$1`, [a.userId]);
      await audit(t, a.userId, null, 'auth.mfa_disabled', 'user', a.userId);
      return { mfaEnabled: false };
    });
  }

  @AllowMfaPending() @Post('logout') @HttpCode(200)
  async logout(@Auth() a: AuthInfo, @Res({ passthrough: true }) res: Response) {
    await this.db.tx({ userId: a.userId }, (t) => t.q(`UPDATE sessions SET revoked_at=now() WHERE id=$1`, [a.sessionId]));
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  /** The signed-in user and every workspace they belong to (one account, many workplaces). */
  @Get('me')
  async me(@Auth() a: AuthInfo) {
    return this.db.tx({ userId: a.userId }, async (t) => {
      const user = await t.one(`SELECT id, email, full_name, phone, interface_language, theme, mfa_enabled, is_platform_admin FROM users WHERE id=$1`, [a.userId]);
      const workspaces = await t.q(`SELECT o.id AS organization_id, o.name, o.kind, m.id AS membership_id, m.role_code, m.specialty_code, m.status
        FROM memberships m JOIN organizations o ON o.id = m.organization_id
        WHERE m.user_id=$1 AND o.status='active' ORDER BY o.name, m.role_code`, [a.userId]);
      return { user, workspaces };
    });
  }

  @Patch('me')
  async updateMe(@Body() body: unknown, @Auth() a: AuthInfo) {
    const b = parse({ fullName: v.str(2, 120).optional(), phone: v.str(5, 30).nullable(), interfaceLanguage: LANG.optional(), theme: v.enum('system', 'light', 'dark').optional() }, body);
    return this.db.tx({ userId: a.userId }, (t) => t.one(`UPDATE users SET full_name=COALESCE($2,full_name), phone=CASE WHEN $3::boolean THEN $4 ELSE phone END,
        interface_language=COALESCE($5,interface_language), theme=COALESCE($6,theme) WHERE id=$1
        RETURNING id, email, full_name, phone, interface_language, theme`,
      [a.userId, b.fullName ?? null, b.phone !== undefined, b.phone ?? null, b.interfaceLanguage ?? null, b.theme ?? null]));
  }

  @Post('password/change') @HttpCode(200)
  async changePassword(@Body() body: unknown, @Auth() a: AuthInfo) {
    const b = parse({ currentPassword: v.str(1, 200), newPassword: v.password() }, body);
    return this.db.tx({ userId: a.userId }, async (t) => {
      const u = await t.one(`SELECT email FROM users WHERE id=$1`, [a.userId]);
      const full = await t.one(`SELECT * FROM auth_find_user($1)`, [u.email]);
      if (!(await verifyPassword(b.currentPassword, full.password_hash))) throw new BadRequestException('Current password is not correct');
      await t.q(`UPDATE users SET password_hash=$2 WHERE id=$1`, [a.userId, await hashPassword(b.newPassword)]);
      await t.q(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL`, [a.userId, a.sessionId]);
      await audit(t, a.userId, null, 'auth.password_changed', 'user', a.userId);
      return { ok: true };
    });
  }

  /** Account recovery. Always answers the same way so it does not reveal which emails have accounts. */
  @Public() @Post('password/forgot') @HttpCode(202)
  async forgot(@Body() body: unknown) {
    const b = parse({ email: v.email() }, body);
    const token = newToken();
    const uid = await this.db.tx({}, async (t) => (await t.one(`SELECT auth_create_password_reset($1,$2) AS u`, [b.email, sha256(token)]))!.u);
    const out: Record<string, unknown> = {
      message: 'If an account exists for this email, a reset link has been prepared.',
      emailDelivery: config.emailProviderConfigured ? 'queued' : 'awaiting_credentials',
    };
    // Without an email provider nothing can be delivered; in development the link is returned so the flow can be tested.
    if (!config.isProd && uid) out.devResetUrl = `${config.webBaseUrl}/reset?token=${token}`;
    return out;
  }

  @Public() @Post('password/reset') @HttpCode(200)
  async reset(@Body() body: unknown) {
    const b = parse({ token: v.str(20, 200), password: v.password() }, body);
    const uid = await this.db.tx({}, async (t) => (await t.one(`SELECT auth_use_password_reset($1,$2) AS u`, [sha256(b.token), await hashPassword(b.password)]))!.u);
    if (!uid) throw new BadRequestException('This reset link is invalid or has expired');
    return { ok: true };
  }

  @Get('sessions')
  async sessions(@Auth() a: AuthInfo) {
    const rows = await this.db.tx({ userId: a.userId }, (t) => t.q(`SELECT id, user_agent, ip, created_at, last_seen_at, expires_at FROM sessions
      WHERE user_id=$1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC`, [a.userId]));
    return rows.map((r) => ({ ...r, current: r.id === a.sessionId }));
  }

  @Delete('sessions/:id')
  async revoke(@Param('id') id: string, @Auth() a: AuthInfo) {
    const n = await this.db.tx({ userId: a.userId }, (t) => t.q(`UPDATE sessions SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL RETURNING id`, [parse({ id: v.uuid() }, { id }).id]));
    if (!n.length) throw new NotFoundException();
    return { ok: true };
  }
}

/** Opening an additional workspace with the same account (a doctor who also runs a private practice). */
@Controller('workspaces')
export class WorkspacesController {
  constructor(private db: Db) {}
  @Post()
  async create(@Body() body: unknown, @Auth() a: AuthInfo) {
    const b = parse({ kind: v.enum('independent_practice', 'medical_center'), name: v.str(2, 120), specialty: SPECIALTY.optional(), licenseNumber: v.str(2, 60).optional(), consultationFee: v.num(0, 1e7).optional() }, body);
    if (b.kind === 'independent_practice' && (!b.specialty || !b.licenseNumber)) throw new BadRequestException('A practice needs your specialty and license number');
    return this.db.tx({ userId: a.userId }, async (t) => {
      const orgId = randomUUID();
      const role = b.kind === 'independent_practice' ? 'doctor' : 'center_owner';
      const { m } = (await t.one(`SELECT app_create_organization($1,$2,$3,$4,$5,$6,$7) AS m`, [orgId, b.kind, b.name, role, b.specialty ?? null, b.licenseNumber ?? null, b.consultationFee ?? null]))!;
      await t.setOrg(orgId);
      await t.q(`INSERT INTO locations(organization_id,name) VALUES ($1,$2)`, [orgId, b.name]);
      if (role === 'doctor') {
        await t.q(`INSERT INTO services(organization_id,membership_id,name,default_minutes,price) VALUES ($1,$2,'Consultation',20,$3)`, [orgId, m, b.consultationFee ?? 0]);
        for (const h of DEFAULT_HOURS) await t.q(`INSERT INTO working_hours(membership_id,weekday,starts,ends) VALUES ($1,$2,$3,$4)`, [m, h.weekday, h.starts, h.ends]);
      }
      return { organizationId: orgId, membershipId: m };
    });
  }
}

@Module({ controllers: [AuthController, WorkspacesController] })
export class AuthModule {}
