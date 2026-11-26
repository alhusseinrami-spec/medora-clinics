import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Permission } from '@medora/shared';
import type { AppRequest } from './types.js';

export const PUBLIC = 'medora:public';
export const ALLOW_MFA_PENDING = 'medora:mfa-pending';
export const TENANT = 'medora:tenant';
export const PERMS = 'medora:perms';
export const FEATURE = 'medora:feature';
export const BILLING_EXEMPT = 'medora:billing-exempt';
export const PLATFORM_ADMIN = 'medora:platform-admin';

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

/** Route belongs to a plan feature (see plan_features). Refused with 403 when the workspace's plan does not include it. */
export const RequireFeature = (feature: string) => SetMetadata(FEATURE, feature);
/** Writes stay allowed when the subscription is inactive (billing and support pages). */
export const BillingExempt = () => SetMetadata(BILLING_EXEMPT, true);
/** MEDORA platform administrators only (super-admin console). */
export const PlatformAdmin = () => SetMetadata(PLATFORM_ADMIN, true);

export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AppRequest>().auth!);
export const Ctx = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AppRequest>().tenant!);
