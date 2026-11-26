import type { Request } from 'express';
import type { Permission } from '@medora/shared';

export interface AuthInfo { userId: string; sessionId: string; mfaPending: boolean }
export interface Membership { id: string; role_code: string; specialty_code: string | null; department_id: string | null }
export interface TenantInfo {
  userId: string;
  orgId: string;
  orgKind: 'independent_practice' | 'medical_center';
  memberships: Membership[];
  permissions: Set<Permission>;
  /** Doctor memberships this user acts for: their own and the doctors they assist. */
  actingDoctors: string[];
  orgWide: boolean;
  /** This user's own doctor membership in the org, if any. */
  doctorMembershipId: string | null;
  /** The workspace's subscription: plan features and whether data may be changed. */
  plan: { code: string; status: string; effectiveStatus: string; usable: boolean; features: Record<string, boolean> };
}
export interface AppRequest extends Request { auth?: AuthInfo; tenant?: TenantInfo }
