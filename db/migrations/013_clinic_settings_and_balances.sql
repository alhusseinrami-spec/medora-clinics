-- Clinic settings, outstanding balances, overbooking, emergency access and message hours.

-- ---------- Workspace and doctor settings ----------
ALTER TABLE organizations
  ADD COLUMN legal_name                text,
  ADD COLUMN tax_id                    text,
  -- Can every doctor of the workspace open every patient's file? Off: only the patient's own doctors (default).
  ADD COLUMN share_patients_between_doctors boolean NOT NULL DEFAULT false,
  ADD COLUMN allow_overbooking         boolean NOT NULL DEFAULT false,
  ADD COLUMN doctors_manage_absences   boolean NOT NULL DEFAULT true,
  ADD COLUMN day_sheet_phones          boolean NOT NULL DEFAULT false,
  -- Reminders and other automatic messages go out only inside this window, in the workspace time zone.
  ADD COLUMN message_window_start      time NOT NULL DEFAULT '08:00',
  ADD COLUMN message_window_end        time NOT NULL DEFAULT '20:00',
  ADD CONSTRAINT organizations_message_window CHECK (message_window_end > message_window_start);

ALTER TABLE memberships
  ADD COLUMN nssf_provider_number text,
  ADD COLUMN note_template        text NOT NULL DEFAULT 'standard' CHECK (note_template IN ('standard','soap'));
COMMENT ON COLUMN memberships.license_number IS 'Order of Physicians (or Dentists) registration number';

-- ---------- Forgiven balances ----------
-- Forgiving what a patient owes closes the balance without counting any income. Never edited or deleted.
CREATE TABLE balance_writeoffs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  invoice_id      uuid NOT NULL,
  amount          numeric(14,2) NOT NULL CHECK (amount > 0),   -- in the invoice's currency
  reason          text NOT NULL,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (invoice_id, organization_id) REFERENCES invoices(id, organization_id)
);
CREATE INDEX balance_writeoffs_org_idx ON balance_writeoffs (organization_id, created_at);
CREATE INDEX balance_writeoffs_invoice_idx ON balance_writeoffs (invoice_id);
ALTER TABLE balance_writeoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE balance_writeoffs FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON balance_writeoffs TO medora_app;
CREATE POLICY writeoffs_read ON balance_writeoffs FOR SELECT USING (app_is_member(organization_id) AND EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_id));
CREATE POLICY writeoffs_insert ON balance_writeoffs FOR INSERT WITH CHECK (
  app_is_member(organization_id) AND created_by = app_user_id() AND app_has_perm('finance.view')
  AND EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_id AND i.status = 'issued' AND i.kind = 'invoice'));

-- The balance view gains what was forgiven and the remaining balance (new columns go last).
CREATE OR REPLACE VIEW invoice_balances WITH (security_invoker = true) AS
  WITH lines AS (
    SELECT i.id, coalesce(sum(it.quantity * it.unit_price), 0) AS subtotal,
           coalesce(sum(it.quantity * it.unit_price) FILTER (WHERE it.insurance_covered), 0) AS covered_subtotal
      FROM invoices i LEFT JOIN invoice_items it ON it.invoice_id = i.id GROUP BY i.id),
  base AS (
  SELECT i.id AS invoice_id, i.organization_id, i.currency, i.kind, i.status,
         l.subtotal, l.covered_subtotal, i.discount, i.tax,
         l.subtotal - i.discount + i.tax AS total,
         coalesce((SELECT sum(cl.subtotal - cn.discount + cn.tax) FROM invoices cn JOIN lines cl ON cl.id = cn.id
                    WHERE cn.credit_for_invoice_id = i.id AND cn.status = 'issued'), 0) AS credited,
         coalesce((SELECT sum(CASE WHEN p.currency = i.currency THEN p.amount
                                   WHEN i.currency = 'USD' THEN p.amount / p.lbp_per_usd
                                   ELSE p.amount * p.lbp_per_usd END)
                     FROM payments p WHERE p.invoice_id = i.id), 0) AS paid,
         coalesce((SELECT sum(w.amount) FROM balance_writeoffs w WHERE w.invoice_id = i.id), 0) AS forgiven
    FROM invoices i JOIN lines l ON l.id = i.id)
  SELECT invoice_id, organization_id, currency, kind, status, subtotal, covered_subtotal, discount, tax, total, credited, paid,
         forgiven, total - credited - paid - forgiven AS balance
    FROM base;
GRANT SELECT ON invoice_balances TO medora_app;

-- ---------- Deliberate overbooking ----------
-- With the workspace setting on, staff may double-book a doctor by giving a reason. Such slots are marked
-- and audited; the double-booking guard ignores them. With the setting off, the guard stays absolute.
ALTER TABLE appointments ADD COLUMN overbook_reason text;
ALTER TABLE appointments DROP CONSTRAINT appointments_no_double_booking;
ALTER TABLE appointments ADD CONSTRAINT appointments_no_double_booking
  EXCLUDE USING gist (doctor_membership_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
  WHERE (status NOT IN ('cancelled','no_show') AND NOT is_walk_in AND overbook_reason IS NULL);
CREATE FUNCTION appointments_overbook_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.overbook_reason IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.overbook_reason IS DISTINCT FROM NEW.overbook_reason)
     AND NOT (SELECT allow_overbooking FROM organizations WHERE id = NEW.organization_id) THEN
    RAISE EXCEPTION 'Overbooking is switched off for this workspace';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
CREATE TRIGGER appointments_overbook_guard BEFORE INSERT OR UPDATE OF overbook_reason ON appointments
  FOR EACH ROW EXECUTE FUNCTION appointments_overbook_guard();

-- ---------- Emergency access ----------
-- A doctor covering for a colleague can open a patient file that is private to another doctor, for 12 hours,
-- after giving a reason. Every opening is recorded and shown to the workspace managers.
CREATE TABLE emergency_access (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  patient_id      uuid NOT NULL,
  membership_id   uuid NOT NULL,   -- the doctor who opened the file
  reason          text NOT NULL,
  opened_at       timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '12 hours',
  FOREIGN KEY (patient_id, organization_id) REFERENCES patients(id, organization_id),
  FOREIGN KEY (membership_id, organization_id) REFERENCES memberships(id, organization_id)
);
CREATE INDEX emergency_access_member_idx ON emergency_access (membership_id, expires_at);
ALTER TABLE emergency_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE emergency_access FORCE ROW LEVEL SECURITY;
GRANT SELECT ON emergency_access TO medora_app;
-- Managers see the whole log; a doctor sees their own openings. Rows are only created by app_emergency_open().
CREATE POLICY emergency_access_read ON emergency_access FOR SELECT USING (
  app_is_member(organization_id) AND (app_has_perm('staff.manage') OR app_has_perm('org.manage') OR membership_id IN (SELECT app_acting_doctors())));

-- The per-transaction context gains two answers: does this doctor see every patient of the workspace
-- (sharing switched on), and which patients have they opened in an emergency (still valid).
CREATE OR REPLACE FUNCTION app_ctx_load() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE k text := coalesce(current_setting('app.user_id', true), '') || ':' || coalesce(current_setting('app.org_id', true), '');
  uid uuid := app_user_id(); org uuid := app_org_id(); mem boolean; wide boolean; acting text; perms text; shared boolean; emerg text;
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
  -- Sharing applies to doctors themselves (not their assistants).
  shared := mem AND EXISTS (SELECT 1 FROM memberships m JOIN organizations o ON o.id = m.organization_id
                             WHERE m.user_id = uid AND m.organization_id = org AND m.role_code = 'doctor' AND m.status = 'active'
                               AND o.share_patients_between_doctors);
  SELECT string_agg(DISTINCT e.patient_id::text, ',') INTO emerg FROM emergency_access e JOIN memberships m ON m.id = e.membership_id
   WHERE mem AND m.user_id = uid AND e.organization_id = org AND e.expires_at > now();
  PERFORM set_config('app.ctx_member', mem::text, true), set_config('app.ctx_wide', wide::text, true),
          set_config('app.ctx_acting', coalesce(acting, ''), true), set_config('app.ctx_perms', ',' || coalesce(perms, '') || ',', true),
          set_config('app.ctx_shared', shared::text, true), set_config('app.ctx_emerg', coalesce(emerg, ''), true),
          set_config('app.ctx_key', k, true);
END $$;
CREATE TRIGGER emergency_access_ctx_reset AFTER INSERT OR UPDATE OR DELETE ON emergency_access FOR EACH STATEMENT EXECUTE FUNCTION app_ctx_reset();

CREATE FUNCTION app_extra_patient_access(pid uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM app_ctx_load();
  RETURN current_setting('app.ctx_shared')::boolean
      OR pid = ANY (string_to_array(nullif(current_setting('app.ctx_emerg'), ''), ',')::uuid[]);
END $$;

CREATE OR REPLACE FUNCTION app_can_see_patient(pid uuid, org uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT app_is_member(org) THEN RETURN false; END IF;
  IF current_setting('app.ctx_wide')::boolean THEN RETURN true; END IF;
  IF app_extra_patient_access(pid) THEN RETURN true; END IF;
  RETURN EXISTS (SELECT 1 FROM patient_memberships pm WHERE pm.patient_id = pid
                    AND pm.membership_id = ANY (string_to_array(nullif(current_setting('app.ctx_acting'), ''), ',')::uuid[]));
END $$;

CREATE OR REPLACE FUNCTION app_can_read_clinical(pid uuid, doctor_membership uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT app_has_perm('clinical_notes.read') AND (
       app_acts_for(doctor_membership)
    OR app_is_org_wide()
    OR app_extra_patient_access(pid)
    OR EXISTS (SELECT 1 FROM patient_memberships pm
                WHERE pm.patient_id = pid AND pm.membership_id IN (SELECT app_acting_doctors())))
$$;

-- Opens a patient file in an emergency. The doctor names the patient exactly (patient number or phone),
-- because they cannot search patients they do not see. Returns the patient id, or NULL when nothing matches.
CREATE FUNCTION app_emergency_open(p_query text, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE org uuid := app_org_id(); doc uuid; pid uuid; n int;
BEGIN
  IF NOT app_is_member(org) OR NOT app_has_perm('clinical_notes.read') THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT m.id INTO doc FROM memberships m WHERE m.user_id = app_user_id() AND m.organization_id = org AND m.role_code = 'doctor' AND m.status = 'active';
  IF doc IS NULL THEN RAISE EXCEPTION 'Only doctors can open a file in an emergency' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF length(coalesce(trim(p_reason), '')) < 5 THEN RAISE EXCEPTION 'Give the reason' USING ERRCODE = 'check_violation'; END IF;
  SELECT count(*), min(p.id::text)::uuid INTO n, pid FROM patients p
   WHERE p.organization_id = org
     AND (upper(p.patient_number) = upper(trim(p_query))
          OR regexp_replace(coalesce(p.phone, ''), '\D', '', 'g') = regexp_replace(p_query, '\D', '', 'g') AND length(regexp_replace(p_query, '\D', '', 'g')) >= 7);
  IF n <> 1 THEN RETURN NULL; END IF;
  INSERT INTO emergency_access (organization_id, patient_id, membership_id, reason) VALUES (org, pid, doc, trim(p_reason));
  INSERT INTO audit_log (actor_user_id, organization_id, action, entity_type, entity_id, details)
  VALUES (app_user_id(), org, 'patient.emergency_access', 'patient', pid, jsonb_build_object('reason', trim(p_reason)));
  RETURN pid;
END $$;

-- ---------- Message hours ----------
-- Automatic messages wait until the workspace message window opens (workspace time zone).
CREATE OR REPLACE FUNCTION comm_claim_due(p_limit int) RETURNS TABLE (
  id uuid, organization_id uuid, purpose text, message text, send_at timestamptz, appointment_starts_at timestamptz,
  patient_id uuid, patient_name text, patient_phone text, language text, consent boolean,
  appt_status text, appt_starts_at timestamptz, doctor_name text, clinic_name text, timezone text, follow_up_date date,
  balance numeric, currency text,
  account_id uuid, phone_number_id text, token_enc text, account_status text,
  body text, meta_template_name text, window_open boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT sm.id FROM scheduled_messages sm JOIN organizations so ON so.id = sm.organization_id WHERE sm.status = 'pending' AND sm.send_at <= now()
       AND (now() AT TIME ZONE so.timezone)::time >= so.message_window_start AND (now() AT TIME ZONE so.timezone)::time < so.message_window_end
     ORDER BY sm.send_at LIMIT p_limit FOR UPDATE OF sm SKIP LOCKED
  ), claimed AS (
    UPDATE scheduled_messages sm SET status = 'sending', attempts = sm.attempts + 1, claimed_at = now() FROM due WHERE sm.id = due.id RETURNING sm.*
  )
  SELECT c.id, c.organization_id, c.purpose, c.message, c.send_at, c.appointment_starts_at,
         p.id, p.full_name, coalesce(nullif(p.whatsapp_number, ''), p.phone), p.preferred_language,
         coalesce((SELECT pc.opted_in FROM patient_consents pc WHERE pc.patient_id = p.id AND pc.channel = 'whatsapp'), false),
         a.status, a.starts_at,
         du.full_name, o.name, o.timezone, coalesce(con.follow_up_date, c.about_date),
         (SELECT b.balance FROM invoice_balances b WHERE b.invoice_id = c.invoice_id), i.currency,
         acc.id, acc.phone_number_id, acc.access_token_enc, acc.status,
         coalesce(ot.body, pt.body), ot.meta_template_name,
         -- Free text is allowed only inside Meta's 24-hour window after the patient last wrote to this number.
         EXISTS (SELECT 1 FROM whatsapp_conversations wc WHERE wc.account_id = acc.id AND wc.last_inbound_at > now() - interval '24 hours'
                  AND wc.contact_number = comm_wa_number(coalesce(nullif(p.whatsapp_number, ''), p.phone)))
    FROM claimed c
    JOIN patients p ON p.id = c.patient_id
    JOIN organizations o ON o.id = c.organization_id
    LEFT JOIN appointments a ON a.id = c.appointment_id
    LEFT JOIN consultations con ON con.id = c.consultation_id
    LEFT JOIN invoices i ON i.id = c.invoice_id
    LEFT JOIN memberships dm ON dm.id = coalesce(a.doctor_membership_id, con.doctor_membership_id, i.doctor_membership_id)
    LEFT JOIN users du ON du.id = dm.user_id
    -- The visit's doctor's own number first, then the workspace number; for a message not tied to a visit
    -- (vaccination, announcement...), the number of a doctor the patient is linked to.
    LEFT JOIN LATERAL (SELECT w.* FROM whatsapp_accounts w WHERE w.organization_id = c.organization_id AND w.is_active
                        AND (w.membership_id = dm.id OR w.membership_id IS NULL
                             OR (dm.id IS NULL AND w.membership_id IN (SELECT pm.membership_id FROM patient_memberships pm WHERE pm.patient_id = p.id)))
                        ORDER BY (w.membership_id = dm.id) DESC NULLS LAST, (w.membership_id IS NULL) DESC, w.created_at LIMIT 1) acc ON true
    LEFT JOIN message_templates ot ON ot.organization_id = c.organization_id AND ot.purpose = c.purpose AND ot.language = p.preferred_language
    LEFT JOIN message_templates pt ON pt.organization_id IS NULL AND pt.purpose = c.purpose AND pt.language = p.preferred_language;
END $$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO medora_app;

CREATE INDEX IF NOT EXISTS prescriptions_org_created_idx ON prescriptions (organization_id, created_at DESC);
