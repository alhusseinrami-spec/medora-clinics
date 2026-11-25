-- Release 6: commercial platform. Configurable plans, one subscription per workspace with trials, renewals and
-- cancellation, manually recorded subscription payments, plan limits enforced by the database, support requests,
-- platform settings and the super-admin functions. Super admins never read patient or clinical data: their
-- functions return workspace metadata and counts only.

-- ---------- Platform settings ----------
CREATE TABLE platform_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform_settings (key, value) VALUES
  ('trial_days', '14'),
  ('grace_days', '7'),
  ('default_plan_independent_practice', '"professional"'),
  ('default_plan_medical_center', '"medical_center"'),
  ('currency', '"USD"'),
  ('signups_open', 'true'),
  ('support_email', '"support@medora.example"');
GRANT SELECT ON platform_settings TO medora_app;
ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY platform_settings_read ON platform_settings FOR SELECT USING (true);

CREATE FUNCTION platform_setting(p_key text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT value FROM platform_settings WHERE key = p_key $$;

-- ---------- Plans: prices, limits and features are data, edited from the super-admin console ----------
ALTER TABLE plans
  ADD COLUMN description    text,
  ADD COLUMN yearly_price   numeric(10,2),
  ADD COLUMN currency       text NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD','LBP')),
  ADD COLUMN max_locations  int,
  ADD COLUMN max_patients   int,
  ADD COLUMN applies_to     text[] NOT NULL DEFAULT ARRAY['independent_practice','medical_center'],
  ADD COLUMN is_public      boolean NOT NULL DEFAULT true,
  ADD COLUMN is_active      boolean NOT NULL DEFAULT true,
  ADD COLUMN sort_order     int NOT NULL DEFAULT 0,
  ADD COLUMN updated_at     timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT plans_limits_ck CHECK (coalesce(max_doctors,1) >= 1 AND coalesce(max_assistants,0) >= 0 AND coalesce(max_locations,1) >= 1 AND coalesce(max_patients,1) >= 1),
  ADD CONSTRAINT plans_price_ck CHECK (coalesce(monthly_price,0) >= 0 AND coalesce(yearly_price,0) >= 0);

-- Feature keys the application checks. Anything not listed is part of every plan.
CREATE TABLE plan_features (
  code        text PRIMARY KEY,
  description text NOT NULL
);
INSERT INTO plan_features (code, description) VALUES
  ('specialty_templates','Specialty templates and custom fields'),
  ('finance','Expenses, commissions and the financial overview'),
  ('insurance','Insurance companies, policies and claims'),
  ('whatsapp','WhatsApp messages, automation and inbox'),
  ('patient_app','Patient app invitations and online requests'),
  ('departments','Departments'),
  ('advanced_analytics','Advanced analytics');
GRANT SELECT ON plan_features TO medora_app;

UPDATE plans SET description = 'One doctor with an assistant: patients, appointments, prescriptions, invoices.', monthly_price = 19, yearly_price = 190,
  max_doctors = 1, max_assistants = 1, max_locations = 1, applies_to = ARRAY['independent_practice'], sort_order = 1,
  features = '{"specialty_templates": false, "finance": false, "insurance": false, "whatsapp": false, "patient_app": false, "departments": false, "advanced_analytics": false}'
  WHERE code = 'solo';
UPDATE plans SET description = 'One doctor and a full team: specialty templates, finance, insurance, WhatsApp automation, patient app.', monthly_price = 49, yearly_price = 490,
  max_doctors = 1, max_assistants = 5, max_locations = 2, applies_to = ARRAY['independent_practice'], sort_order = 2,
  features = '{"specialty_templates": true, "finance": true, "insurance": true, "whatsapp": true, "patient_app": true, "departments": false, "advanced_analytics": true}'
  WHERE code = 'professional';
UPDATE plans SET description = 'Several doctors, departments, shared scheduling and central administration.', monthly_price = 149, yearly_price = 1490,
  max_doctors = 15, max_assistants = 30, max_locations = 3, applies_to = ARRAY['medical_center'], sort_order = 3,
  features = '{"specialty_templates": true, "finance": true, "insurance": true, "whatsapp": true, "patient_app": true, "departments": true, "advanced_analytics": true}'
  WHERE code = 'medical_center';
UPDATE plans SET description = 'Several branches, no limits, dedicated configuration. Priced per agreement.', monthly_price = NULL, yearly_price = NULL,
  max_doctors = NULL, max_assistants = NULL, max_locations = NULL, applies_to = ARRAY['independent_practice','medical_center'], sort_order = 4, is_public = true,
  features = '{"specialty_templates": true, "finance": true, "insurance": true, "whatsapp": true, "patient_app": true, "departments": true, "advanced_analytics": true}'
  WHERE code = 'enterprise';

ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY plans_read ON plans FOR SELECT USING (is_active OR app_is_platform_admin());

-- ---------- Subscriptions: exactly one per workspace, with a history of events ----------
ALTER TABLE subscriptions
  ADD COLUMN billing_cycle        text NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly','yearly')),
  ADD COLUMN price_override       numeric(10,2) CHECK (price_override >= 0),
  ADD COLUMN cancel_at_period_end boolean NOT NULL DEFAULT false,
  ADD COLUMN cancelled_at         timestamptz,
  ADD COLUMN suspended_reason     text,
  ADD COLUMN notes                text,
  ADD COLUMN updated_at           timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT subscriptions_org_uq UNIQUE (organization_id);

CREATE TABLE subscription_events (
  id              bigserial PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind            text NOT NULL,
  from_plan       text, to_plan text, from_status text, to_status text,
  details         jsonb,
  actor_user_id   uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscription_events_org_idx ON subscription_events (organization_id, created_at DESC);
GRANT SELECT ON subscription_events TO medora_app;
ALTER TABLE subscription_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY subscription_events_read ON subscription_events FOR SELECT USING (app_is_platform_admin() OR (app_is_member(organization_id) AND app_has_perm('org.manage')));

CREATE TABLE subscription_payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  amount          numeric(12,2) NOT NULL CHECK (amount > 0),
  currency        text NOT NULL CHECK (currency IN ('USD','LBP')),
  method          text NOT NULL CHECK (method IN ('cash','bank_transfer','card','omt','whish','cheque','other')),
  reference       text,
  status          text NOT NULL DEFAULT 'paid' CHECK (status IN ('paid','refunded')),
  period_start    date NOT NULL,
  period_end      date NOT NULL CHECK (period_end > period_start),
  plan_code       text NOT NULL REFERENCES plans(code),
  recorded_by     uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  refunded_at     timestamptz
);
CREATE INDEX subscription_payments_org_idx ON subscription_payments (organization_id, created_at DESC);
GRANT SELECT ON subscription_payments TO medora_app;
ALTER TABLE subscription_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY subscription_payments_read ON subscription_payments FOR SELECT USING (app_is_platform_admin() OR (app_is_member(organization_id) AND app_has_perm('org.manage')));

-- The policy from 004 let admins write directly; all writes now go through the functions below.
DROP POLICY subscriptions_admin ON subscriptions;
REVOKE INSERT, UPDATE, DELETE ON subscriptions FROM medora_app;

-- Effective state of a workspace's subscription. "usable" decides whether the workspace may change data.
CREATE FUNCTION org_subscription(p_org uuid)
RETURNS TABLE (plan_code text, plan_name text, status text, effective_status text, usable boolean, billing_cycle text,
  trial_ends_at timestamptz, current_period_end timestamptz, cancel_at_period_end boolean, features jsonb,
  max_doctors int, max_assistants int, max_locations int, max_patients int, price numeric, currency text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH s AS (
    SELECT s.*, p.name, p.features, p.max_doctors, p.max_assistants, p.max_locations, p.max_patients, p.currency,
           coalesce(s.price_override, CASE WHEN s.billing_cycle = 'yearly' THEN p.yearly_price ELSE p.monthly_price END) AS price,
           make_interval(days => coalesce((platform_setting('grace_days'))::int, 7)) AS grace
      FROM subscriptions s JOIN plans p ON p.code = s.plan_code WHERE s.organization_id = p_org)
  SELECT plan_code, name, status,
         CASE WHEN status = 'trial' AND trial_ends_at <= now() THEN 'trial_expired'
              WHEN status IN ('active','past_due') AND current_period_end IS NOT NULL AND current_period_end + grace <= now() THEN 'expired'
              WHEN status = 'active' AND current_period_end IS NOT NULL AND current_period_end <= now() THEN 'past_due'
              ELSE status END,
         CASE WHEN status = 'trial' THEN trial_ends_at > now()
              WHEN status IN ('active','past_due') THEN current_period_end IS NULL OR current_period_end + grace > now()
              ELSE false END,
         billing_cycle, trial_ends_at, current_period_end, cancel_at_period_end, features,
         max_doctors, max_assistants, max_locations, max_patients, price, currency
    FROM s
$$;

CREATE FUNCTION org_usage(p_org uuid)
RETURNS TABLE (doctors int, assistants int, locations int, patients int, appointments_30d int, messages_30d int, storage_bytes bigint, members int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    (SELECT count(*) FROM memberships WHERE organization_id = p_org AND status = 'active' AND role_code = 'doctor')::int,
    (SELECT count(*) FROM memberships WHERE organization_id = p_org AND status = 'active' AND role_code NOT IN ('doctor','center_owner'))::int,
    (SELECT count(*) FROM locations WHERE organization_id = p_org)::int,
    (SELECT count(*) FROM patients WHERE organization_id = p_org AND archived_at IS NULL)::int,
    (SELECT count(*) FROM appointments WHERE organization_id = p_org AND starts_at > now() - interval '30 days')::int,
    (SELECT count(*) FROM whatsapp_messages WHERE organization_id = p_org AND direction = 'outbound' AND created_at > now() - interval '30 days')::int,
    (SELECT coalesce(sum(size_bytes), 0) FROM medical_documents WHERE organization_id = p_org)::bigint,
    (SELECT count(DISTINCT user_id) FROM memberships WHERE organization_id = p_org AND status = 'active')::int
$$;

CREATE FUNCTION sub_event(p_org uuid, p_kind text, p_from_plan text, p_to_plan text, p_from_status text, p_to_status text, p_details jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO subscription_events (organization_id, kind, from_plan, to_plan, from_status, to_status, details, actor_user_id)
  VALUES (p_org, p_kind, p_from_plan, p_to_plan, p_from_status, p_to_status, p_details, app_user_id())
$$;

-- Every new workspace starts a free trial on the default plan for its kind. The signups_open setting can close
-- new workspaces (invited staff and patients can still join existing ones).
CREATE FUNCTION organizations_start_trial() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE plan text; days int;
BEGIN
  IF NOT coalesce((platform_setting('signups_open'))::boolean, true) THEN
    RAISE EXCEPTION 'New workspaces cannot be opened right now. Contact MEDORA support.' USING ERRCODE = 'P0001';
  END IF;
  plan := platform_setting('default_plan_' || NEW.kind) #>> '{}';
  days := coalesce((platform_setting('trial_days'))::int, 14);
  INSERT INTO subscriptions (organization_id, plan_code, status, trial_ends_at) VALUES (NEW.id, plan, 'trial', now() + make_interval(days => days));
  INSERT INTO subscription_events (organization_id, kind, to_plan, to_status, details, actor_user_id)
  VALUES (NEW.id, 'trial_started', plan, 'trial', jsonb_build_object('days', days), NEW.created_by);
  RETURN NEW;
END $$;
CREATE TRIGGER organizations_start_trial AFTER INSERT ON organizations FOR EACH ROW EXECUTE FUNCTION organizations_start_trial();

-- Existing workspaces (development data) get a trial too.
INSERT INTO subscriptions (organization_id, plan_code, status, trial_ends_at)
SELECT o.id, platform_setting('default_plan_' || o.kind) #>> '{}', 'trial', now() + interval '14 days'
  FROM organizations o WHERE NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.organization_id = o.id);

-- ---------- Plan limits, enforced by the database whatever the caller ----------
CREATE FUNCTION plan_limit_check(p_org uuid, p_what text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s record; u record; lim int; used int; label text;
BEGIN
  SELECT * INTO s FROM org_subscription(p_org);
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO u FROM org_usage(p_org);
  IF p_what = 'doctor' THEN lim := s.max_doctors; used := u.doctors; label := 'doctors';
  ELSIF p_what = 'assistant' THEN lim := s.max_assistants; used := u.assistants; label := 'staff accounts besides doctors';
  ELSIF p_what = 'location' THEN lim := s.max_locations; used := u.locations; label := 'locations';
  ELSIF p_what = 'patient' THEN lim := s.max_patients; used := u.patients; label := 'patients';
  END IF;
  IF lim IS NOT NULL AND used > lim THEN
    RAISE EXCEPTION 'Your % plan allows % %. Upgrade the plan to add more.', s.plan_name, lim, label USING ERRCODE = 'P0001';
  END IF;
END $$;

CREATE FUNCTION memberships_plan_limit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'active' AND NEW.role_code <> 'center_owner'
     AND (TG_OP = 'INSERT' OR OLD.status <> 'active' OR OLD.role_code <> NEW.role_code) THEN
    PERFORM plan_limit_check(NEW.organization_id, CASE WHEN NEW.role_code = 'doctor' THEN 'doctor' ELSE 'assistant' END);
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER memberships_plan_limit AFTER INSERT OR UPDATE OF status, role_code ON memberships
  DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION memberships_plan_limit();

CREATE FUNCTION locations_plan_limit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN PERFORM plan_limit_check(NEW.organization_id, 'location'); RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER locations_plan_limit AFTER INSERT ON locations DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION locations_plan_limit();

CREATE FUNCTION patients_plan_limit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN PERFORM plan_limit_check(NEW.organization_id, 'patient'); RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER patients_plan_limit AFTER INSERT ON patients DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION patients_plan_limit();

-- ---------- Workspace side: change plan, cycle, cancel at period end, resume ----------
-- Changing plan is allowed to any active public plan for this kind of workspace whose limits fit current usage.
-- No card payments are taken here: billing is recorded by MEDORA (see subscription_payments).
CREATE FUNCTION org_change_plan(p_plan text, p_cycle text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE org uuid := app_org_id(); s record; p record; u record; k text;
BEGIN
  IF NOT (app_is_member(org) AND app_has_perm('org.manage')) THEN RAISE EXCEPTION 'Only the workspace administrator can change the plan' USING ERRCODE = '42501'; END IF;
  SELECT * INTO s FROM subscriptions WHERE organization_id = org FOR UPDATE;
  SELECT kind INTO k FROM organizations WHERE id = org;
  SELECT * INTO p FROM plans WHERE code = p_plan AND is_active AND is_public;
  IF NOT FOUND OR NOT (k = ANY (p.applies_to)) THEN RAISE EXCEPTION 'This plan is not available for this workspace'; END IF;
  IF p.monthly_price IS NULL THEN RAISE EXCEPTION 'The % plan is arranged with MEDORA directly. Send a support request.', p.name; END IF;
  IF s.status = 'suspended' THEN RAISE EXCEPTION 'This subscription is suspended. Contact MEDORA support.'; END IF;
  SELECT * INTO u FROM org_usage(org);
  IF (p.max_doctors IS NOT NULL AND u.doctors > p.max_doctors) OR (p.max_assistants IS NOT NULL AND u.assistants > p.max_assistants)
     OR (p.max_locations IS NOT NULL AND u.locations > p.max_locations) OR (p.max_patients IS NOT NULL AND u.patients > p.max_patients) THEN
    RAISE EXCEPTION 'Current usage is above the limits of the % plan. Remove staff or locations first.', p.name;
  END IF;
  UPDATE subscriptions SET plan_code = p_plan, billing_cycle = p_cycle, price_override = NULL, updated_at = now() WHERE organization_id = org;
  PERFORM sub_event(org, CASE WHEN p.sort_order > (SELECT sort_order FROM plans WHERE code = s.plan_code) THEN 'upgraded' ELSE 'downgraded' END,
    s.plan_code, p_plan, s.status, s.status, jsonb_build_object('cycle', p_cycle));
END $$;

CREATE FUNCTION org_set_cancel(p_cancel boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE org uuid := app_org_id(); s record;
BEGIN
  IF NOT (app_is_member(org) AND app_has_perm('org.manage')) THEN RAISE EXCEPTION 'Only the workspace administrator can cancel' USING ERRCODE = '42501'; END IF;
  SELECT * INTO s FROM subscriptions WHERE organization_id = org FOR UPDATE;
  IF s.status IN ('cancelled','suspended') THEN RAISE EXCEPTION 'This subscription is already %', s.status; END IF;
  IF s.status = 'trial' AND p_cancel THEN
    UPDATE subscriptions SET status = 'cancelled', cancelled_at = now(), updated_at = now() WHERE organization_id = org;
    PERFORM sub_event(org, 'cancelled', s.plan_code, s.plan_code, s.status, 'cancelled', NULL);
    RETURN;
  END IF;
  UPDATE subscriptions SET cancel_at_period_end = p_cancel, updated_at = now() WHERE organization_id = org;
  PERFORM sub_event(org, CASE WHEN p_cancel THEN 'cancel_scheduled' ELSE 'cancel_withdrawn' END, s.plan_code, s.plan_code, s.status, s.status, NULL);
END $$;

-- ---------- Support requests ----------
CREATE TABLE support_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  user_id         uuid NOT NULL REFERENCES users(id),
  category        text NOT NULL CHECK (category IN ('billing','plan','technical','account','other')),
  subject         text NOT NULL CHECK (length(subject) BETWEEN 3 AND 200),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','closed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE support_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  uuid NOT NULL REFERENCES support_requests(id) ON DELETE CASCADE,
  author_id   uuid NOT NULL REFERENCES users(id),
  from_staff  boolean NOT NULL DEFAULT false,
  body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_requests_status_idx ON support_requests (status, updated_at DESC);
CREATE INDEX support_messages_req_idx ON support_messages (request_id, created_at);
GRANT SELECT, INSERT ON support_requests, support_messages TO medora_app;
GRANT UPDATE (status, updated_at) ON support_requests TO medora_app;
ALTER TABLE support_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY support_requests_read ON support_requests FOR SELECT USING (user_id = app_user_id() OR app_is_platform_admin());
CREATE POLICY support_requests_insert ON support_requests FOR INSERT WITH CHECK (
  user_id = app_user_id() AND status = 'open' AND (organization_id IS NULL OR app_is_member(organization_id)));
CREATE POLICY support_requests_update ON support_requests FOR UPDATE USING (user_id = app_user_id() OR app_is_platform_admin())
  WITH CHECK (user_id = app_user_id() OR app_is_platform_admin());
CREATE POLICY support_messages_read ON support_messages FOR SELECT USING (
  EXISTS (SELECT 1 FROM support_requests r WHERE r.id = request_id AND (r.user_id = app_user_id() OR app_is_platform_admin())));
CREATE POLICY support_messages_insert ON support_messages FOR INSERT WITH CHECK (
  author_id = app_user_id() AND from_staff = app_is_platform_admin()
  AND EXISTS (SELECT 1 FROM support_requests r WHERE r.id = request_id AND (r.user_id = app_user_id() OR app_is_platform_admin())));

-- ---------- Super-admin functions (each checks the caller first) ----------
CREATE FUNCTION admin_assert() RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN IF NOT app_is_platform_admin() THEN RAISE EXCEPTION 'Platform administrators only' USING ERRCODE = '42501'; END IF; END $$;

-- Workspaces with owner, plan and usage counts. No patient or clinical content.
CREATE FUNCTION admin_workspaces()
RETURNS TABLE (id uuid, name text, kind text, status text, created_at timestamptz, owner_name text, owner_email text,
  plan_code text, sub_status text, effective_status text, trial_ends_at timestamptz, current_period_end timestamptz, cancel_at_period_end boolean,
  price numeric, billing_cycle text, doctors int, assistants int, patients int, appointments_30d int, last_activity timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  PERFORM admin_assert();
  RETURN QUERY
  SELECT o.id, o.name, o.kind, o.status, o.created_at, u.full_name, u.email,
         s.plan_code, s.status, s.effective_status, s.trial_ends_at, s.current_period_end, s.cancel_at_period_end, s.price, s.billing_cycle,
         g.doctors, g.assistants, g.patients, g.appointments_30d,
         (SELECT max(se.last_seen_at) FROM sessions se JOIN memberships m ON m.user_id = se.user_id WHERE m.organization_id = o.id)
    FROM organizations o LEFT JOIN users u ON u.id = o.created_by
    CROSS JOIN LATERAL org_subscription(o.id) s CROSS JOIN LATERAL org_usage(o.id) g
   ORDER BY o.created_at DESC;
END $$;

CREATE FUNCTION admin_users(p_search text)
RETURNS TABLE (id uuid, email text, full_name text, status text, is_platform_admin boolean, mfa_enabled boolean, created_at timestamptz,
  last_seen_at timestamptz, workspaces jsonb, patient_records int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  PERFORM admin_assert();
  RETURN QUERY
  SELECT u.id, u.email, u.full_name, u.status, u.is_platform_admin, u.mfa_enabled, u.created_at,
         (SELECT max(last_seen_at) FROM sessions s WHERE s.user_id = u.id),
         coalesce((SELECT jsonb_agg(jsonb_build_object('organization_id', o.id, 'name', o.name, 'role', m.role_code, 'status', m.status) ORDER BY o.name)
                     FROM memberships m JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = u.id), '[]'::jsonb),
         (SELECT count(*) FROM patient_accounts pa WHERE pa.user_id = u.id AND pa.revoked_at IS NULL)::int
    FROM users u
   WHERE p_search IS NULL OR u.email ILIKE '%' || p_search || '%' OR u.full_name ILIKE '%' || p_search || '%'
   ORDER BY u.created_at DESC LIMIT 200;
END $$;

CREATE FUNCTION admin_overview() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE r jsonb;
BEGIN
  PERFORM admin_assert();
  WITH subs AS (SELECT o.kind, s.* FROM organizations o CROSS JOIN LATERAL org_subscription(o.id) s)
  SELECT jsonb_build_object(
    'workspaces', (SELECT count(*) FROM organizations),
    'independent_practices', (SELECT count(*) FROM organizations WHERE kind = 'independent_practice'),
    'medical_centers', (SELECT count(*) FROM organizations WHERE kind = 'medical_center'),
    'suspended_workspaces', (SELECT count(*) FROM organizations WHERE status = 'suspended'),
    'users', (SELECT count(*) FROM users WHERE status = 'active'),
    'doctors', (SELECT count(DISTINCT user_id) FROM memberships WHERE role_code = 'doctor' AND status = 'active'),
    'patient_app_users', (SELECT count(DISTINCT user_id) FROM patient_accounts WHERE revoked_at IS NULL),
    'active_users_7d', (SELECT count(DISTINCT user_id) FROM sessions WHERE last_seen_at > now() - interval '7 days'),
    'by_status', (SELECT coalesce(jsonb_object_agg(effective_status, n), '{}') FROM (SELECT effective_status, count(*) n FROM subs GROUP BY 1) x),
    'by_plan', (SELECT coalesce(jsonb_object_agg(plan_code, n), '{}') FROM (SELECT plan_code, count(*) n FROM subs GROUP BY 1) x),
    'mrr', (SELECT coalesce(sum(CASE WHEN billing_cycle = 'yearly' THEN price / 12 ELSE price END), 0) FROM subs WHERE effective_status IN ('active','past_due')),
    'trials_ending_7d', (SELECT count(*) FROM subs WHERE status = 'trial' AND trial_ends_at BETWEEN now() AND now() + interval '7 days'),
    'payments_30d', (SELECT coalesce(sum(amount) FILTER (WHERE currency = 'USD'), 0) FROM subscription_payments WHERE status = 'paid' AND created_at > now() - interval '30 days'),
    'open_support', (SELECT count(*) FROM support_requests WHERE status = 'open'),
    'appointments_30d', (SELECT count(*) FROM appointments WHERE starts_at > now() - interval '30 days'),
    'messages_30d', (SELECT count(*) FROM whatsapp_messages WHERE direction = 'outbound' AND created_at > now() - interval '30 days'),
    'signups', (SELECT coalesce(jsonb_agg(jsonb_build_object('month', m, 'workspaces', n) ORDER BY m), '[]') FROM (
                 SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') m, count(*) n FROM organizations
                  WHERE created_at > date_trunc('month', now()) - interval '11 months' GROUP BY 1) x)
  ) INTO r;
  RETURN r;
END $$;

CREATE FUNCTION admin_set_org_status(p_org uuid, p_status text, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE old text;
BEGIN
  PERFORM admin_assert();
  SELECT status INTO old FROM organizations WHERE id = p_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Workspace not found'; END IF;
  UPDATE organizations SET status = p_status WHERE id = p_org;
  PERFORM sub_event(p_org, CASE WHEN p_status = 'suspended' THEN 'workspace_suspended' ELSE 'workspace_reactivated' END, NULL, NULL, old, p_status, jsonb_build_object('reason', p_reason));
  INSERT INTO audit_log (actor_user_id, organization_id, action, entity_type, entity_id, details)
  VALUES (app_user_id(), p_org, 'admin.workspace_' || p_status, 'organization', p_org, jsonb_build_object('reason', p_reason));
END $$;

CREATE FUNCTION admin_set_user_status(p_user uuid, p_status text, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM admin_assert();
  IF p_user = app_user_id() THEN RAISE EXCEPTION 'You cannot suspend your own account'; END IF;
  UPDATE users SET status = p_status WHERE id = p_user;
  IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;
  IF p_status = 'suspended' THEN UPDATE sessions SET revoked_at = now() WHERE user_id = p_user AND revoked_at IS NULL; END IF;
  INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, details)
  VALUES (app_user_id(), 'admin.user_' || p_status, 'user', p_user, jsonb_build_object('reason', p_reason));
END $$;

-- Plan, status, cycle, trial end, period end and price override in one audited call.
CREATE FUNCTION admin_update_subscription(p_org uuid, p_plan text, p_status text, p_cycle text, p_trial_ends timestamptz,
  p_period_end timestamptz, p_price numeric, p_clear_price boolean, p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s record;
BEGIN
  PERFORM admin_assert();
  SELECT * INTO s FROM subscriptions WHERE organization_id = p_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Workspace not found'; END IF;
  UPDATE subscriptions SET
    plan_code = coalesce(p_plan, plan_code), status = coalesce(p_status, status), billing_cycle = coalesce(p_cycle, billing_cycle),
    trial_ends_at = coalesce(p_trial_ends, trial_ends_at), current_period_end = coalesce(p_period_end, current_period_end),
    price_override = CASE WHEN p_clear_price THEN NULL ELSE coalesce(p_price, price_override) END,
    cancelled_at = CASE WHEN p_status = 'cancelled' AND s.status <> 'cancelled' THEN now() WHEN p_status IS NOT NULL AND p_status <> 'cancelled' THEN NULL ELSE cancelled_at END,
    cancel_at_period_end = CASE WHEN p_status IS NOT NULL AND p_status <> s.status THEN false ELSE cancel_at_period_end END,
    suspended_reason = CASE WHEN p_status = 'suspended' THEN p_note WHEN p_status IS NOT NULL THEN NULL ELSE suspended_reason END,
    notes = coalesce(p_note, notes), updated_at = now()
  WHERE organization_id = p_org;
  PERFORM sub_event(p_org, 'admin_change', s.plan_code, coalesce(p_plan, s.plan_code), s.status, coalesce(p_status, s.status),
    jsonb_strip_nulls(jsonb_build_object('cycle', p_cycle, 'trial_ends_at', p_trial_ends, 'period_end', p_period_end, 'price', p_price, 'cleared_price', p_clear_price, 'note', p_note)));
  INSERT INTO audit_log (actor_user_id, organization_id, action, entity_type, entity_id, details)
  VALUES (app_user_id(), p_org, 'admin.subscription_update', 'organization', p_org, jsonb_build_object('plan', p_plan, 'status', p_status));
END $$;

-- Recording a payment renews the subscription: active until the end of the period paid for.
CREATE FUNCTION admin_record_payment(p_org uuid, p_amount numeric, p_currency text, p_method text, p_reference text, p_months int) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s record; start_d date; end_d date; pid uuid;
BEGIN
  PERFORM admin_assert();
  IF p_months NOT BETWEEN 1 AND 36 THEN RAISE EXCEPTION 'A payment covers 1 to 36 months'; END IF;
  SELECT * INTO s FROM subscriptions WHERE organization_id = p_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Workspace not found'; END IF;
  IF s.status = 'suspended' THEN RAISE EXCEPTION 'Reactivate the subscription before recording a payment'; END IF;
  start_d := greatest(current_date, coalesce(s.current_period_end::date, current_date));
  end_d := (start_d + make_interval(months => p_months))::date;
  INSERT INTO subscription_payments (organization_id, amount, currency, method, reference, period_start, period_end, plan_code, recorded_by)
  VALUES (p_org, p_amount, p_currency, p_method, nullif(trim(p_reference), ''), start_d, end_d, s.plan_code, app_user_id()) RETURNING id INTO pid;
  UPDATE subscriptions SET status = 'active', current_period_end = end_d::timestamptz, cancel_at_period_end = false, cancelled_at = NULL, updated_at = now()
   WHERE organization_id = p_org;
  PERFORM sub_event(p_org, CASE WHEN s.status = 'trial' THEN 'activated' ELSE 'renewed' END, s.plan_code, s.plan_code, s.status, 'active',
    jsonb_build_object('payment', pid, 'amount', p_amount, 'currency', p_currency, 'until', end_d));
  INSERT INTO audit_log (actor_user_id, organization_id, action, entity_type, entity_id, details)
  VALUES (app_user_id(), p_org, 'admin.subscription_payment', 'subscription_payment', pid, jsonb_build_object('amount', p_amount, 'currency', p_currency));
  RETURN pid;
END $$;

CREATE FUNCTION admin_refund_payment(p_payment uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p record;
BEGIN
  PERFORM admin_assert();
  UPDATE subscription_payments SET status = 'refunded', refunded_at = now() WHERE id = p_payment AND status = 'paid' RETURNING * INTO p;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found or already refunded'; END IF;
  PERFORM sub_event(p.organization_id, 'payment_refunded', NULL, NULL, NULL, NULL, jsonb_build_object('payment', p_payment, 'amount', p.amount));
  INSERT INTO audit_log (actor_user_id, organization_id, action, entity_type, entity_id)
  VALUES (app_user_id(), p.organization_id, 'admin.subscription_refund', 'subscription_payment', p_payment);
END $$;

CREATE FUNCTION admin_upsert_plan(p_code text, p_name text, p_description text, p_monthly numeric, p_yearly numeric, p_currency text,
  p_max_doctors int, p_max_assistants int, p_max_locations int, p_max_patients int, p_features jsonb, p_applies_to text[],
  p_is_public boolean, p_is_active boolean, p_sort int) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM admin_assert();
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_features) k WHERE k NOT IN (SELECT code FROM plan_features)) THEN RAISE EXCEPTION 'Unknown feature in plan'; END IF;
  IF NOT p_is_active AND EXISTS (SELECT 1 FROM subscriptions WHERE plan_code = p_code AND status IN ('trial','active','past_due')) THEN
    RAISE EXCEPTION 'Workspaces are still on this plan. Move them to another plan first.';
  END IF;
  INSERT INTO plans (code, name, description, monthly_price, yearly_price, currency, max_doctors, max_assistants, max_locations, max_patients, features, applies_to, is_public, is_active, sort_order)
  VALUES (p_code, p_name, p_description, p_monthly, p_yearly, p_currency, p_max_doctors, p_max_assistants, p_max_locations, p_max_patients, p_features, p_applies_to, p_is_public, p_is_active, p_sort)
  ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, monthly_price = EXCLUDED.monthly_price, yearly_price = EXCLUDED.yearly_price,
    currency = EXCLUDED.currency, max_doctors = EXCLUDED.max_doctors, max_assistants = EXCLUDED.max_assistants, max_locations = EXCLUDED.max_locations,
    max_patients = EXCLUDED.max_patients, features = EXCLUDED.features, applies_to = EXCLUDED.applies_to, is_public = EXCLUDED.is_public,
    is_active = EXCLUDED.is_active, sort_order = EXCLUDED.sort_order, updated_at = now();
  INSERT INTO audit_log (actor_user_id, action, entity_type, details) VALUES (app_user_id(), 'admin.plan_saved', 'plan', jsonb_build_object('code', p_code));
END $$;

CREATE FUNCTION admin_set_setting(p_key text, p_value jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM admin_assert();
  UPDATE platform_settings SET value = p_value, updated_by = app_user_id(), updated_at = now() WHERE key = p_key;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown setting %', p_key; END IF;
  INSERT INTO audit_log (actor_user_id, action, entity_type, details) VALUES (app_user_id(), 'admin.setting', 'platform_setting', jsonb_build_object('key', p_key, 'value', p_value));
END $$;

CREATE FUNCTION admin_subscription_detail(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM admin_assert();
  RETURN jsonb_build_object(
    'events', coalesce((SELECT jsonb_agg(to_jsonb(e) - 'organization_id' ORDER BY e.created_at DESC) FROM (SELECT e.*, u.full_name AS actor_name FROM subscription_events e LEFT JOIN users u ON u.id = e.actor_user_id WHERE e.organization_id = p_org ORDER BY e.created_at DESC LIMIT 50) e), '[]'),
    'payments', coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.created_at DESC) FROM subscription_payments p WHERE p.organization_id = p_org), '[]'),
    'members', coalesce((SELECT jsonb_agg(jsonb_build_object('name', u.full_name, 'email', u.email, 'role', m.role_code, 'status', m.status) ORDER BY m.role_code)
                         FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = p_org), '[]'),
    'usage', (SELECT to_jsonb(g) FROM org_usage(p_org) g));
END $$;


-- Admin actions on a workspace are audited against that workspace.
DROP POLICY audit_insert ON audit_log;
CREATE POLICY audit_insert ON audit_log FOR INSERT WITH CHECK (
  actor_user_id = app_user_id() AND (organization_id IS NULL OR app_is_member(organization_id) OR app_is_platform_admin()));

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO medora_app;
