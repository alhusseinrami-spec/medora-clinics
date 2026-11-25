import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Permission } from '@medora/shared';
import type { AppRequest } from './types.js';

export const PUBLIC = 'medora:public';
export const ALLOW_MFA_PENDING = 'medora:mfa-pending';
export const TENANT = 'medora:tenant';
export const PERMS = 'medora:perms';

/** No session required. */
export const Public = () => SetMetadata(PUBLIC, true);
/** Allowed while the password step is done but the TOTP step is not. */
export const AllowMfaPending = () => SetMetadata(ALLOW_MFA_PENDING, true);
/** Route works inside the active workspace given by the X-Org-Id header. */
export const Tenant = () => SetMetadata(TENANT, true);
/** Requires every listed permission in the active workspace (implies @Tenant). */
export const RequirePerm = (...perms: Permission[]) => SetMetadata(PERMS, perms);
/** Requires at least one of the listed permissions (implies @Tenant). */
export const RequireAnyPerm = (...perms: Permission[]) => SetMetadata(PERMS, { any: perms });

export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AppRequest>().auth!);
export const Ctx = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AppRequest>().tenant!);
