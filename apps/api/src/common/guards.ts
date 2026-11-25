import { CanActivate, ExecutionContext, ForbiddenException, HttpException, Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Permission } from '@medora/shared';
import { Db } from '../db/db.service.js';
import { sha256 } from './crypto.js';
import { ALLOW_MFA_PENDING, BILLING_EXEMPT, FEATURE, PERMS, PLATFORM_ADMIN, PUBLIC, TENANT } from './decorators.js';
import { config } from '../config.js';
import type { AppRequest, TenantInfo } from './types.js';

export const SESSION_COOKIE = 'medora_session';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function tokenFrom(req: { headers: Record<string, any>; cookies?: Record<string, string> }): string | undefined {
  const h = req.headers['authorization'];
  if (typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7);
  return req.cookies?.[SESSION_COOKIE];
}

/** Resolves the session for every request except @Public routes. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private db: Db) {}
  async canActivate(ctx: ExecutionContext) {
    const targets = [ctx.getHandler(), ctx.getClass()];
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC, targets);
    const token = tokenFrom(req as any);
    if (token) {
      const s = await this.db.tx({}, (t) => t.one(`SELECT * FROM auth_find_session($1)`, [sha256(token)]));
      if (s && s.user_status === 'active') req.auth = { userId: s.user_id, sessionId: s.session_id, mfaPending: s.mfa_pending };
    }
    if (isPublic) return true;
    if (!req.auth) throw new UnauthorizedException('Sign in required');
    if (req.auth.mfaPending && !this.reflector.getAllAndOverride<boolean>(ALLOW_MFA_PENDING, targets)) {
      throw new UnauthorizedException({ message: 'Two-factor code required', mfaRequired: true });
    }
    return true;
  }
}

/** Loads the active workspace (X-Org-Id) and checks permissions. The database re-checks everything through RLS. */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private reflector: Reflector, private db: Db) {}
  async canActivate(ctx: ExecutionContext) {
    const targets = [ctx.getHandler(), ctx.getClass()];
    const perms = this.reflector.getAllAndOverride<Permission[] | { any: Permission[] }>(PERMS, targets);
    const feature = this.reflector.getAllAndOverride<string>(FEATURE, targets);
    const needsTenant = perms !== undefined || feature !== undefined || this.reflector.getAllAndOverride<boolean>(TENANT, targets);
    if (!needsTenant) return true;
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    if (!req.auth) throw new UnauthorizedException();
    const orgId = req.headers['x-org-id'];
    if (typeof orgId !== 'string' || !UUID.test(orgId)) throw new BadRequestException('X-Org-Id header with the active workspace is required');
    const tenant = await this.db.tx({ userId: req.auth.userId, orgId }, async (t) => {
      const memberships = await t.q(`SELECT m.id, m.role_code, m.specialty_code, m.department_id, o.kind
        FROM memberships m JOIN organizations o ON o.id = m.organization_id
        WHERE m.user_id = $1 AND m.organization_id = $2 AND m.status = 'active' AND o.status = 'active'`, [req.auth!.userId, orgId]);
      if (!memberships.length) return null;
      const permRows = await t.q(`SELECT DISTINCT permission_code FROM membership_permissions WHERE membership_id = ANY($1)`, [memberships.map((m) => m.id)]);
      const acting = await t.q(`SELECT app_acting_doctors() AS id`);
      const wide = await t.one(`SELECT app_is_org_wide() AS w`);
      const sub = await t.one(`SELECT plan_code, status, effective_status, usable, features FROM org_subscription($1)`, [orgId]);
      const info: TenantInfo = {
        userId: req.auth!.userId, orgId, orgKind: memberships[0].kind,
        memberships: memberships.map(({ kind, ...m }) => m),
        permissions: new Set(permRows.map((r) => r.permission_code)),
        actingDoctors: acting.map((r) => r.id), orgWide: wide.w,
        doctorMembershipId: memberships.find((m) => m.role_code === 'doctor')?.id ?? null,
        plan: sub ? { code: sub.plan_code, status: sub.status, effectiveStatus: sub.effective_status, usable: sub.usable, features: sub.features ?? {} }
          : { code: 'none', status: 'none', effectiveStatus: 'none', usable: false, features: {} },
      };
      return info;
    });
    if (!tenant) throw new ForbiddenException('You are not an active member of this workspace');
    req.tenant = tenant;
    if (feature && tenant.plan.features[feature] !== true) {
      throw new ForbiddenException({ message: 'Your plan does not include this feature. Upgrade the plan in Settings, Subscription.', feature, code: 'plan_feature' });
    }
    // An expired trial or unpaid subscription keeps everything readable but stops changes, except billing and support.
    if (!tenant.plan.usable && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !this.reflector.getAllAndOverride<boolean>(BILLING_EXEMPT, targets)) {
      throw new HttpException({ message: 'The subscription of this workspace is not active. Records stay readable; renew the plan to make changes.', code: 'subscription_inactive', status: tenant.plan.effectiveStatus }, 402);
    }
    if (perms) {
      const list = Array.isArray(perms) ? perms : perms.any;
      const ok = Array.isArray(perms) ? list.every((p) => tenant.permissions.has(p)) : list.some((p) => tenant.permissions.has(p));
      if (!ok) throw new ForbiddenException({ message: 'You do not have permission for this action', required: list });
    }
    return true;
  }
}

/** Super-admin console: the user must be a platform administrator (and, in production, use two-factor sign-in). */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(private reflector: Reflector, private db: Db) {}
  async canActivate(ctx: ExecutionContext) {
    if (!this.reflector.getAllAndOverride<boolean>(PLATFORM_ADMIN, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    if (!req.auth) throw new UnauthorizedException();
    const u = await this.db.tx({ userId: req.auth.userId }, (t) => t.one(`SELECT is_platform_admin, mfa_enabled FROM users WHERE id = $1`, [req.auth!.userId]));
    if (!u?.is_platform_admin) throw new ForbiddenException('Platform administrators only');
    if (config.requireAdminMfa && !u.mfa_enabled) throw new ForbiddenException({ message: 'Turn on two-factor sign-in before using the admin console', code: 'admin_mfa_required' });
    return true;
  }
}
