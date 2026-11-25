import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Permission } from '@medora/shared';
import { Db } from '../db/db.service.js';
import { sha256 } from './crypto.js';
import { ALLOW_MFA_PENDING, PERMS, PUBLIC, TENANT } from './decorators.js';
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
    const needsTenant = perms !== undefined || this.reflector.getAllAndOverride<boolean>(TENANT, targets);
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
      const info: TenantInfo = {
        userId: req.auth!.userId, orgId, orgKind: memberships[0].kind,
        memberships: memberships.map(({ kind, ...m }) => m),
        permissions: new Set(permRows.map((r) => r.permission_code)),
        actingDoctors: acting.map((r) => r.id), orgWide: wide.w,
        doctorMembershipId: memberships.find((m) => m.role_code === 'doctor')?.id ?? null,
      };
      return info;
    });
    if (!tenant) throw new ForbiddenException('You are not an active member of this workspace');
    req.tenant = tenant;
    if (perms) {
      const list = Array.isArray(perms) ? perms : perms.any;
      const ok = Array.isArray(perms) ? list.every((p) => tenant.permissions.has(p)) : list.some((p) => tenant.permissions.has(p));
      if (!ok) throw new ForbiddenException({ message: 'You do not have permission for this action', required: list });
    }
    return true;
  }
}
