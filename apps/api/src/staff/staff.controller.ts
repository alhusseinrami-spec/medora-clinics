import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Module, NotFoundException, Param, Patch, Post, Put } from '@nestjs/common';
import { PERMISSION_CODES, STAFF_ROLES, isGrantable, type Permission } from '@medora/shared';
import { Db } from '../db/db.service.js';
import { config } from '../config.js';
import { Auth, Ctx, Public, RequirePerm, Tenant } from '../common/decorators.js';
import type { AuthInfo, TenantInfo } from '../common/types.js';
import { parse, v } from '../common/validate.js';
import { audit } from '../common/audit.js';
import { newToken, sha256 } from '../common/crypto.js';

const id = (x: string) => parse({ id: v.uuid() }, { id: x }).id;
const INVITABLE = STAFF_ROLES.filter((r) => r !== 'center_owner');

@Controller('staff')
export class StaffController {
  constructor(private db: Db) {}

  /** Everyone in the workspace sees the team list; permission details only for those who manage them. */
  @Tenant() @Get()
  async list(@Ctx() c: TenantInfo) {
    const canSeePerms = c.permissions.has('permission.manage') || c.permissions.has('staff.manage');
    return this.db.tx(c, async (t) => {
      const rows = await t.q(`SELECT m.id, m.user_id, u.full_name, u.email, m.role_code, m.specialty_code, m.department_id, m.title,
          m.license_number, m.nssf_provider_number, m.note_template, m.consultation_fee, m.status, m.created_at,
          COALESCE((SELECT array_agg(permission_code ORDER BY permission_code) FROM membership_permissions WHERE membership_id=m.id), '{}') AS permissions,
          COALESCE((SELECT array_agg(doctor_membership_id) FROM assistant_assignments WHERE assistant_membership_id=m.id), '{}') AS assists
        FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 ORDER BY m.role_code, u.full_name`, [c.orgId]);
      return rows.map((r) => (canSeePerms || r.user_id === c.userId ? r : { ...r, permissions: undefined, email: undefined }));
    });
  }

  @RequirePerm('staff.manage') @Post('invitations')
  async invite(@Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({
      email: v.email(), role: v.enum(...INVITABLE), specialty: v.str(2, 40).optional(), departmentId: v.uuid().optional(),
      consultationFee: v.num(0, 1e7).optional(), assignToDoctorMembershipId: v.uuid().optional(),
    }, body);
    if (b.role === 'doctor' && !b.specialty) throw new BadRequestException('A doctor invitation needs a specialty');
    if (c.orgKind === 'independent_practice' && !['assistant', 'receptionist', 'accountant'].includes(b.role)) {
      throw new BadRequestException('An independent practice can add assistants, receptionists and accountants. Create a medical center to add doctors.');
    }
    const token = newToken();
    return this.db.tx(c, async (t) => {
      if (b.assignToDoctorMembershipId) {
        const d = await t.one(`SELECT role_code FROM memberships WHERE id=$1 AND organization_id=$2`, [b.assignToDoctorMembershipId, c.orgId]);
        if (d?.role_code !== 'doctor') throw new BadRequestException('Assistants can only be assigned to a doctor of this workspace');
      }
      const org = await t.one(`SELECT name FROM organizations WHERE id=$1`, [c.orgId]);
      const inv = await t.one(`INSERT INTO invitations(organization_id,email,role_code,specialty_code,department_id,consultation_fee,assign_to_doctor_membership_id,token_hash,invited_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, email, role_code, expires_at`,
        [c.orgId, b.email, b.role, b.specialty ?? null, b.departmentId ?? null, b.consultationFee ?? null, b.assignToDoctorMembershipId ?? null, sha256(token), c.userId]);
      const acceptUrl = `${config.webBaseUrl}/invite/${token}`;
      const email = await t.one(`INSERT INTO outbound_emails(organization_id,to_email,purpose,subject,body,status) VALUES ($1,$2,'invitation',$3,$4,$5) RETURNING status`,
        [c.orgId, b.email, `You are invited to ${org.name} on MEDORA CLINICS`, `Accept your invitation: ${acceptUrl}`, config.emailProviderConfigured ? 'queued' : 'awaiting_credentials']);
      await audit(t, c.userId, c.orgId, 'invitation.create', 'invitation', inv.id, { email: b.email, role: b.role });
      // The inviter gets the link to share directly; email delivery depends on a configured provider.
      return { ...inv, acceptUrl, emailDelivery: email.status };
    });
  }

  @RequirePerm('staff.manage') @Get('invitations')
  invitations(@Ctx() c: TenantInfo) {
    return this.db.tx(c, (t) => t.q(`SELECT i.id, i.email, i.role_code, i.specialty_code, i.created_at, i.expires_at, i.accepted_at, i.revoked_at, u.full_name AS invited_by
      FROM invitations i JOIN users u ON u.id=i.invited_by WHERE i.organization_id=$1 ORDER BY i.created_at DESC`, [c.orgId]));
  }

  @RequirePerm('staff.manage') @Delete('invitations/:id')
  async revokeInvitation(@Param('id') iid: string, @Ctx() c: TenantInfo) {
    const r = await this.db.tx(c, async (t) => {
      const x = await t.q(`UPDATE invitations SET revoked_at=now() WHERE id=$1 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id`, [id(iid)]);
      if (x.length) await audit(t, c.userId, c.orgId, 'invitation.revoke', 'invitation', iid);
      return x;
    });
    if (!r.length) throw new NotFoundException();
    return { ok: true };
  }

  @RequirePerm('staff.manage') @Patch(':id')
  async updateMember(@Param('id') mid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ status: v.enum('active', 'suspended').optional(), consultationFee: v.num(0, 1e7).nullable(), departmentId: v.uuid().nullable(),
      title: v.str(1, 80).nullable(), specialty: v.str(2, 40).optional(), licenseNumber: v.str(2, 60).nullable(),
      nssfProviderNumber: v.str(2, 60).nullable(), noteTemplate: v.enum('standard', 'soap').optional() }, body);
    return this.db.tx(c, async (t) => {
      const m = await t.one(`SELECT * FROM memberships WHERE id=$1 AND organization_id=$2`, [id(mid), c.orgId]);
      if (!m) throw new NotFoundException();
      if (b.status === 'suspended' && m.user_id === c.userId) throw new BadRequestException('You cannot suspend yourself');
      if (b.status === 'suspended' && m.role_code === 'center_owner') {
        const owners = await t.one(`SELECT count(*)::int n FROM memberships WHERE organization_id=$1 AND role_code='center_owner' AND status='active'`, [c.orgId]);
        if (owners.n <= 1) throw new BadRequestException('A center needs at least one active owner');
      }
      const pick = <T>(val: T | undefined, cur: T) => (val === undefined ? cur : val);
      const r = await t.one(`UPDATE memberships SET status=$2, consultation_fee=$3, department_id=$4, title=$5, specialty_code=$6, license_number=$7,
        nssf_provider_number=$8, note_template=$9 WHERE id=$1
        RETURNING id, role_code, status, consultation_fee, department_id, title, specialty_code, license_number, nssf_provider_number, note_template`,
        [m.id, pick(b.status, m.status), pick(b.consultationFee, m.consultation_fee), pick(b.departmentId, m.department_id), pick(b.title, m.title),
          pick(b.specialty, m.specialty_code), pick(b.licenseNumber, m.license_number),
          pick(b.nssfProviderNumber, m.nssf_provider_number), pick(b.noteTemplate, m.note_template)]);
      await audit(t, c.userId, c.orgId, 'membership.update', 'membership', m.id, b);
      return r;
    });
  }

  /**
   * Set a member's permission switches. You can't change your own; staff managers can change anyone else,
   * a doctor only the assistants assigned to them; nobody grants a permission they don't hold;
   * prescription.create only ever goes to doctors (also enforced by a database trigger).
   */
  @RequirePerm('permission.manage') @Put(':id/permissions')
  async setPermissions(@Param('id') mid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ permissions: v.array(v.enum(...PERMISSION_CODES), PERMISSION_CODES.length) }, body);
    const wanted = new Set<Permission>(b.permissions);
    return this.db.tx(c, async (t) => {
      const m = await t.one(`SELECT id, user_id, role_code FROM memberships WHERE id=$1 AND organization_id=$2`, [id(mid), c.orgId]);
      if (!m) throw new NotFoundException();
      if (m.user_id === c.userId) throw new ForbiddenException('You cannot change your own permissions');
      if (!c.permissions.has('staff.manage')) {
        const assigned = await t.one(`SELECT 1 FROM assistant_assignments WHERE assistant_membership_id=$1 AND doctor_membership_id=$2`, [m.id, c.doctorMembershipId]);
        if (!assigned) throw new ForbiddenException('You can only change permissions of assistants assigned to you');
      }
      const current = new Set<Permission>((await t.q(`SELECT permission_code FROM membership_permissions WHERE membership_id=$1`, [m.id])).map((r) => r.permission_code));
      const add = [...wanted].filter((p) => !current.has(p));
      const remove = [...current].filter((p) => !wanted.has(p));
      for (const p of add) {
        if (!isGrantable(m.role_code, p)) throw new BadRequestException(`${p} cannot be granted to a ${m.role_code}`);
        if (!c.permissions.has(p)) throw new ForbiddenException(`You cannot grant ${p} because you do not hold it`);
      }
      for (const p of remove) if (!c.permissions.has(p) && !c.permissions.has('staff.manage')) throw new ForbiddenException(`You cannot remove ${p}`);
      if (remove.length) await t.q(`DELETE FROM membership_permissions WHERE membership_id=$1 AND permission_code = ANY($2)`, [m.id, remove]);
      for (const p of add) await t.q(`INSERT INTO membership_permissions(membership_id,permission_code,granted_by) VALUES ($1,$2,$3)`, [m.id, p, c.userId]);
      if (add.length || remove.length) await audit(t, c.userId, c.orgId, 'permission.change', 'membership', m.id, { added: add, removed: remove });
      return { membershipId: m.id, permissions: [...wanted].sort(), added: add, removed: remove };
    });
  }

  @RequirePerm('staff.manage') @Post(':id/assignments')
  async assign(@Param('id') mid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ doctorMembershipId: v.uuid() }, body);
    return this.db.tx(c, async (t) => {
      const a = await t.one(`SELECT role_code FROM memberships WHERE id=$1 AND organization_id=$2`, [id(mid), c.orgId]);
      if (!a || !['assistant', 'receptionist'].includes(a.role_code)) throw new BadRequestException('Only assistants and receptionists can be assigned to doctors');
      await t.q(`INSERT INTO assistant_assignments VALUES ($1,$2) ON CONFLICT DO NOTHING`, [mid, b.doctorMembershipId]);
      await audit(t, c.userId, c.orgId, 'assistant.assign', 'membership', mid, { doctor: b.doctorMembershipId });
      return { ok: true };
    });
  }

  @RequirePerm('staff.manage') @Delete(':id/assignments/:doctorId')
  async unassign(@Param('id') mid: string, @Param('doctorId') did: string, @Ctx() c: TenantInfo) {
    await this.db.tx(c, async (t) => {
      await t.q(`DELETE FROM assistant_assignments WHERE assistant_membership_id=$1 AND doctor_membership_id=$2`, [id(mid), id(did)]);
      await audit(t, c.userId, c.orgId, 'assistant.unassign', 'membership', mid, { doctor: did });
    });
    return { ok: true };
  }
}

@Controller('invitations')
export class InvitationsController {
  constructor(private db: Db) {}

  @Public() @Get(':token')
  async preview(@Param('token') token: string) {
    const r = await this.db.tx({}, (t) => t.one(`SELECT * FROM app_invitation_preview($1)`, [sha256(token)]));
    if (!r) throw new NotFoundException('Invitation not found');
    return r;
  }

  /** Accepting adds a membership to the SAME account: a doctor joining a center is never duplicated. */
  @Post(':token/accept') @HttpCode(200)
  accept(@Param('token') token: string, @Auth() a: AuthInfo) {
    return this.db.tx({ userId: a.userId }, (t) => t.one(`SELECT * FROM app_accept_invitation($1)`, [sha256(token)]));
  }
}

@Module({ controllers: [StaffController, InvitationsController] })
export class StaffModule {}
