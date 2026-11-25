import type { Tx } from '../db/db.service.js';

/** Appends to the immutable audit log inside the caller's transaction. */
export async function audit(t: Tx, actor: string, orgId: string | null, action: string, entityType: string, entityId: string | null, details?: object) {
  await t.q(`INSERT INTO audit_log(actor_user_id, organization_id, action, entity_type, entity_id, details) VALUES ($1,$2,$3,$4,$5,$6)`,
    [actor, orgId, action, entityType, entityId, details ? JSON.stringify(details) : null]);
}
