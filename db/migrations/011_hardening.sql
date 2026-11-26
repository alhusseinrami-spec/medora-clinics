-- Release 7: hardening. Rate limits shared by every API instance, and indexes found by the performance test.

CREATE UNLOGGED TABLE rate_limits (
  key          text NOT NULL,
  window_start timestamptz NOT NULL,
  hits         int NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);
-- Not readable by the app role: only through rate_hit().
REVOKE ALL ON rate_limits FROM medora_app;

-- Counts one hit for key in the current fixed window. Returns true while the key stays within the limit.
CREATE FUNCTION rate_hit(p_key text, p_limit int, p_window_seconds int) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE w timestamptz := to_timestamp(floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds); n int;
BEGIN
  INSERT INTO rate_limits (key, window_start, hits) VALUES (p_key, w, 1)
  ON CONFLICT (key, window_start) DO UPDATE SET hits = rate_limits.hits + 1 RETURNING hits INTO n;
  IF random() < 0.01 THEN DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'; END IF;
  RETURN n <= p_limit;
END $$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO medora_app;

-- ---------- Per-transaction cache for the row-level security checks ----------
-- The policies ask "is this user an active member, org-wide, which doctors do they act for, which permissions"
-- for every row. With tens of thousands of rows that cost seconds. The answers are computed once per transaction
-- (per user and workspace) and kept in transaction-local settings. Any change to memberships, assignments,
-- permissions or workspace status in the same transaction clears the cache, so checks never use stale rights.
CREATE FUNCTION app_ctx_load() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE k text := coalesce(current_setting('app.user_id', true), '') || ':' || coalesce(current_setting('app.org_id', true), '');
  uid uuid := app_user_id(); org uuid := app_org_id(); mem boolean; wide boolean; acting text; perms text;
BEGIN
  IF current_setting('app.ctx_key', true) IS NOT DISTINCT FROM k THEN RETURN; END IF;
  mem := org IS NOT NULL AND uid IS NOT NULL AND EXISTS (
    SELECT 1 FROM memberships m JOIN organizations o ON o.id = m.organization_id
     WHERE m.user_id = uid AND m.organization_id = org AND m.status = 'active' AND o.status = 'active');
  wide := mem AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = uid AND m.organization_id = org AND m.status = 'active'
                                AND m.role_code IN ('center_owner','center_admin','receptionist','accountant','insurance_admin'));
  SELECT string_agg(x::text, ',') INTO acting FROM (
    SELECT m.id AS x FROM memberships m WHERE mem AND m.user_id = uid AND m.organization_id = org AND m.role_code = 'doctor' AND m.status = 'active'
    UNION
    SELECT aa.doctor_membership_id FROM assistant_assignments aa JOIN memberships a ON a.id = aa.assistant_membership_id
     WHERE mem AND a.user_id = uid AND a.organization_id = org AND a.status = 'active') s;
  SELECT string_agg(DISTINCT mp.permission_code, ',') INTO perms FROM memberships m JOIN membership_permissions mp ON mp.membership_id = m.id
   WHERE mem AND m.user_id = uid AND m.organization_id = org AND m.status = 'active';
  PERFORM set_config('app.ctx_member', mem::text, true), set_config('app.ctx_wide', wide::text, true),
          set_config('app.ctx_acting', coalesce(acting, ''), true), set_config('app.ctx_perms', ',' || coalesce(perms, '') || ',', true),
          set_config('app.ctx_key', k, true);
END $$;

CREATE FUNCTION app_ctx_reset() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN PERFORM set_config('app.ctx_key', '', true); RETURN NULL; END $$;
CREATE TRIGGER memberships_ctx_reset AFTER INSERT OR UPDATE OR DELETE ON memberships FOR EACH STATEMENT EXECUTE FUNCTION app_ctx_reset();
CREATE TRIGGER assistant_assignments_ctx_reset AFTER INSERT OR UPDATE OR DELETE ON assistant_assignments FOR EACH STATEMENT EXECUTE FUNCTION app_ctx_reset();
CREATE TRIGGER membership_permissions_ctx_reset AFTER INSERT OR UPDATE OR DELETE ON membership_permissions FOR EACH STATEMENT EXECUTE FUNCTION app_ctx_reset();
CREATE TRIGGER organizations_ctx_reset AFTER INSERT OR UPDATE OR DELETE ON organizations FOR EACH STATEMENT EXECUTE FUNCTION app_ctx_reset();
CREATE TRIGGER users_ctx_reset AFTER UPDATE OF status ON users FOR EACH STATEMENT EXECUTE FUNCTION app_ctx_reset();

CREATE OR REPLACE FUNCTION app_is_member(org uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF org IS NULL OR org IS DISTINCT FROM app_org_id() THEN RETURN false; END IF;
  PERFORM app_ctx_load();
  RETURN current_setting('app.ctx_member')::boolean;
END $$;

CREATE OR REPLACE FUNCTION app_has_perm(perm text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM app_ctx_load();
  RETURN current_setting('app.ctx_member')::boolean AND position(',' || perm || ',' IN current_setting('app.ctx_perms')) > 0;
END $$;

CREATE OR REPLACE FUNCTION app_is_org_wide() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN PERFORM app_ctx_load(); RETURN current_setting('app.ctx_wide')::boolean; END $$;

CREATE OR REPLACE FUNCTION app_acting_doctors() RETURNS SETOF uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM app_ctx_load();
  RETURN QUERY SELECT x::uuid FROM unnest(string_to_array(nullif(current_setting('app.ctx_acting'), ''), ',')) x;
END $$;

CREATE OR REPLACE FUNCTION app_can_see_patient(pid uuid, org uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT app_is_member(org) THEN RETURN false; END IF;
  IF current_setting('app.ctx_wide')::boolean THEN RETURN true; END IF;
  RETURN EXISTS (SELECT 1 FROM patient_memberships pm WHERE pm.patient_id = pid
                    AND pm.membership_id = ANY (string_to_array(nullif(current_setting('app.ctx_acting'), ''), ',')::uuid[]));
END $$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO medora_app;

-- ---------- Indexes for workspace-wide lists and dashboards (found with perf/run.mjs on 20k patients) ----------
CREATE INDEX IF NOT EXISTS appointments_org_starts_idx ON appointments (organization_id, starts_at);
CREATE INDEX IF NOT EXISTS appointments_org_status_idx ON appointments (organization_id, status) WHERE status IN ('arrived','waiting','scheduled','confirmed');
CREATE INDEX IF NOT EXISTS patients_org_created_idx ON patients (organization_id, created_at);
CREATE INDEX IF NOT EXISTS patient_memberships_membership_idx ON patient_memberships (membership_id, patient_id);
