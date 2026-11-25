-- MEDORA CLINICS: migration 002, modules from blueprint sections 4-10, 13, 15, 17
-- Applies on top of 001_core.sql. PostgreSQL 16.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------- Section 4: specialty engine ----------
INSERT INTO specialties (code, name) VALUES
  ('cardiology','Cardiology'),
  ('general_practice','General Practice');

-- Reusable, versioned templates (exam forms, notes, prescriptions, treatment plans, patient forms).
-- Published versions are immutable so saved records never change.
CREATE TABLE clinical_templates (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                 text NOT NULL CHECK (kind IN ('examination','clinical_note','prescription','treatment_plan','patient_form','measurement_set')),
  specialty_code       text REFERENCES specialties(code),
  owner_membership_id  uuid REFERENCES memberships(id) ON DELETE CASCADE, -- NULL = platform preset
  name                 text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE template_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id  uuid NOT NULL REFERENCES clinical_templates(id) ON DELETE CASCADE,
  version      int  NOT NULL,
  schema       jsonb NOT NULL,          -- field definitions incl. custom fields
  published_at timestamptz,
  UNIQUE (template_id, version)
);
CREATE FUNCTION template_version_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'published template versions are immutable; create a new version';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER template_versions_lock BEFORE UPDATE OR DELETE ON template_versions
  FOR EACH ROW EXECUTE FUNCTION template_version_immutable();

ALTER TABLE consultations
  ADD COLUMN template_version_id uuid REFERENCES template_versions(id),
  ADD COLUMN chief_complaint text,
  ADD COLUMN examination text,
  ADD COLUMN vital_signs jsonb,
  ADD COLUMN treatment_plan text,
  ADD COLUMN follow_up_instructions text;

-- ---------- Section 5: patient management ----------
ALTER TABLE patients
  ADD COLUMN patient_number   text,
  ADD COLUMN whatsapp_number  text,
  ADD COLUMN email            text,
  ADD COLUMN address          text,
  ADD COLUMN emergency_contact jsonb,
  ADD COLUMN blood_type       text,
  ADD COLUMN chronic_diseases text,
  ADD COLUMN current_medications text,
  ADD COLUMN medical_history  text,
  ADD COLUMN national_id      text,
  ADD COLUMN preferred_language text NOT NULL DEFAULT 'en' CHECK (preferred_language IN ('en','ar','fr'));
CREATE UNIQUE INDEX patients_number_uq ON patients (organization_id, patient_number);
CREATE INDEX patients_phone_idx ON patients (organization_id, phone);

-- Which doctors may see a patient (controlled record linking inside a center).
CREATE TABLE patient_memberships (
  patient_id    uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  linked_by     uuid REFERENCES users(id),
  linked_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (patient_id, membership_id)
);

-- Lab results, imaging, PDFs, photos (dermatology before/after), insurance cards.
CREATE TABLE medical_documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id       uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  consultation_id  uuid REFERENCES consultations(id),
  uploaded_by      uuid REFERENCES users(id),
  kind             text NOT NULL CHECK (kind IN ('lab_result','imaging','report','photo','insurance_card','other')),
  storage_key      text NOT NULL,      -- object storage key; files are encrypted at rest
  mime_type        text,
  shared_with_patient boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE diagnoses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id uuid NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
  code            text,                -- e.g. ICD-10, optional
  description     text NOT NULL
);

-- ---------- Section 6: appointments and waiting room ----------
CREATE TABLE services (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  membership_id    uuid REFERENCES memberships(id),
  name             text NOT NULL,
  default_minutes  int  NOT NULL DEFAULT 20,
  price            numeric(12,2) NOT NULL DEFAULT 0,
  currency         text NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD','LBP'))
);

CREATE TABLE working_hours (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  membership_id uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  location_id   uuid REFERENCES locations(id),
  weekday       int  NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  starts        time NOT NULL,
  ends          time NOT NULL,
  CHECK (ends > starts)
);
CREATE TABLE availability_exceptions (   -- breaks, holidays, leave
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  membership_id uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('break','holiday','leave')),
  during        tstzrange NOT NULL
);

ALTER TABLE appointments DROP CONSTRAINT appointments_status_check;
ALTER TABLE appointments
  ADD CONSTRAINT appointments_status_check CHECK (status IN
    ('scheduled','confirmed','arrived','waiting','in_consultation','completed','cancelled','no_show')),
  ADD COLUMN service_id    uuid REFERENCES services(id),
  ADD COLUMN location_id   uuid REFERENCES locations(id),
  ADD COLUMN department_id uuid REFERENCES departments(id),
  ADD COLUMN is_walk_in    boolean NOT NULL DEFAULT false,
  ADD COLUMN recurrence_rule text,          -- RFC 5545 RRULE
  ADD COLUMN notes         text,
  ADD COLUMN arrived_at    timestamptz,
  ADD COLUMN called_at     timestamptz;

-- Prevent double bookings for a doctor (cancelled / no-show slots are free again).
ALTER TABLE appointments ADD CONSTRAINT appointments_no_double_booking
  EXCLUDE USING gist (doctor_membership_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
  WHERE (status NOT IN ('cancelled','no_show'));

-- Live waiting room: one queue per doctor, ordered by arrival.
CREATE VIEW waiting_room AS
  SELECT a.id AS appointment_id, a.organization_id, a.doctor_membership_id, a.department_id,
         p.full_name AS patient_name, a.starts_at AS appointment_time, a.arrived_at,
         now() - a.arrived_at AS waiting_duration
  FROM appointments a JOIN patients p ON p.id = a.patient_id
  WHERE a.status IN ('arrived','waiting')
  ORDER BY a.arrived_at;

-- ---------- Section 7: prescriptions ----------
ALTER TABLE memberships ADD COLUMN license_number text;

CREATE TABLE medications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  strength    text,
  form        text
);
CREATE INDEX medications_name_idx ON medications (lower(name));

CREATE TABLE prescription_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prescription_id uuid NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
  medication_id   uuid REFERENCES medications(id),
  medication_name text NOT NULL,        -- snapshot as printed
  dosage          text,
  frequency       text,
  duration        text,
  instructions    text,
  notes           text
);
ALTER TABLE prescriptions
  ALTER COLUMN items DROP NOT NULL,
  ADD COLUMN status text NOT NULL DEFAULT 'issued' CHECK (status IN ('draft','issued','cancelled')),
  ADD COLUMN shared_with_patient boolean NOT NULL DEFAULT false;

-- ---------- Section 8: finance (USD/LBP, historical rates) ----------
CREATE TABLE exchange_rates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lbp_per_usd     numeric(14,2) NOT NULL CHECK (lbp_per_usd > 0),
  effective_from  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment_methods (
  code text PRIMARY KEY,
  name text NOT NULL
);
INSERT INTO payment_methods VALUES
  ('cash','Cash'),('card','Credit/debit card'),('bank_transfer','Bank transfer'),
  ('whish','Whish'),('omt','OMT'),('insurance','Insurance');

CREATE TABLE invoice_counters (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  last_number     int NOT NULL DEFAULT 0
);

CREATE TABLE invoices (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id),
  invoice_number       int  NOT NULL,
  kind                 text NOT NULL DEFAULT 'invoice' CHECK (kind IN ('invoice','credit_note')),
  patient_id           uuid NOT NULL REFERENCES patients(id),
  doctor_membership_id uuid REFERENCES memberships(id),
  appointment_id       uuid REFERENCES appointments(id),
  currency             text NOT NULL CHECK (currency IN ('USD','LBP')),
  lbp_per_usd          numeric(14,2) NOT NULL,   -- rate frozen on the transaction
  discount             numeric(14,2) NOT NULL DEFAULT 0,
  tax                  numeric(14,2) NOT NULL DEFAULT 0,
  issued_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, invoice_number)
);

-- Automatic per-organization invoice numbering, and rate snapshot if none given.
CREATE FUNCTION invoices_before_insert() RETURNS trigger AS $$
BEGIN
  INSERT INTO invoice_counters (organization_id, last_number) VALUES (NEW.organization_id, 1)
  ON CONFLICT (organization_id) DO UPDATE SET last_number = invoice_counters.last_number + 1
  RETURNING last_number INTO NEW.invoice_number;
  IF NEW.lbp_per_usd IS NULL THEN
    SELECT lbp_per_usd INTO NEW.lbp_per_usd FROM exchange_rates
     WHERE organization_id = NEW.organization_id AND effective_from <= now()
     ORDER BY effective_from DESC LIMIT 1;
    IF NEW.lbp_per_usd IS NULL THEN RAISE EXCEPTION 'no exchange rate configured'; END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER invoices_numbering BEFORE INSERT ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoices_before_insert();

CREATE TABLE invoice_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id  uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  service_id  uuid REFERENCES services(id),
  description text NOT NULL,
  quantity    numeric(10,2) NOT NULL DEFAULT 1,
  unit_price  numeric(14,2) NOT NULL,
  insurance_covered boolean NOT NULL DEFAULT false
);

CREATE TABLE payments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id     uuid NOT NULL REFERENCES invoices(id),
  method_code    text NOT NULL REFERENCES payment_methods(code),
  amount         numeric(14,2) NOT NULL,          -- negative = refund
  currency       text NOT NULL CHECK (currency IN ('USD','LBP')),
  lbp_per_usd    numeric(14,2) NOT NULL,
  received_by    uuid REFERENCES users(id),
  received_at    timestamptz NOT NULL DEFAULT now()
);

-- Balances in invoice currency (partial payments, outstanding).
CREATE VIEW invoice_balances AS
  SELECT i.id AS invoice_id, i.organization_id, i.currency,
         COALESCE((SELECT sum(quantity*unit_price) FROM invoice_items WHERE invoice_id=i.id),0)
           - i.discount + i.tax AS total,
         COALESCE((SELECT sum(CASE
             WHEN p.currency = i.currency THEN p.amount
             WHEN i.currency = 'USD' THEN p.amount / p.lbp_per_usd
             ELSE p.amount * p.lbp_per_usd END)
           FROM payments p WHERE p.invoice_id=i.id),0) AS paid
  FROM invoices i;

CREATE TABLE expenses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  membership_id   uuid REFERENCES memberships(id),   -- NULL = shared/center expense
  department_id   uuid REFERENCES departments(id),
  category        text NOT NULL,
  amount          numeric(14,2) NOT NULL,
  currency        text NOT NULL CHECK (currency IN ('USD','LBP')),
  lbp_per_usd     numeric(14,2) NOT NULL,
  spent_at        date NOT NULL DEFAULT current_date
);

CREATE TABLE commission_rules (    -- doctor vs center split
  membership_id   uuid PRIMARY KEY REFERENCES memberships(id) ON DELETE CASCADE,
  doctor_percent  numeric(5,2) NOT NULL CHECK (doctor_percent BETWEEN 0 AND 100)
);

-- ---------- Section 9: insurance (incl. NSSF) ----------
CREATE TABLE insurance_providers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id),  -- NULL = platform directory
  name            text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('nssf','private','other'))
);
CREATE TABLE insurance_policies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id      uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  provider_id     uuid NOT NULL REFERENCES insurance_providers(id),
  policy_number   text NOT NULL,
  coverage        jsonb,            -- covered / non-covered services, percentages
  card_document_id uuid REFERENCES medical_documents(id),
  valid_until     date
);
CREATE TABLE claims (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id      uuid NOT NULL REFERENCES invoices(id),
  policy_id       uuid NOT NULL REFERENCES insurance_policies(id),
  status          text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','submitted','approved','partially_approved','rejected','reimbursed')),
  amount_claimed  numeric(14,2) NOT NULL,
  amount_approved numeric(14,2),
  rejection_reason text,
  submitted_at    timestamptz,
  reimbursed_at   timestamptz
);
CREATE TABLE claim_documents (
  claim_id    uuid NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES medical_documents(id),
  PRIMARY KEY (claim_id, document_id)
);

-- ---------- Section 10: WhatsApp and notifications ----------
CREATE TABLE whatsapp_accounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  membership_id      uuid REFERENCES memberships(id),   -- NULL = center-wide number
  phone_number_id    text NOT NULL UNIQUE,              -- Meta Cloud API id
  display_number     text NOT NULL,
  access_token_ref   text,          -- reference into a secrets store, never the token itself
  status             text NOT NULL DEFAULT 'awaiting_credentials'
    CHECK (status IN ('awaiting_credentials','connected','disconnected'))
);
CREATE TABLE message_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id),
  purpose         text NOT NULL CHECK (purpose IN ('confirmation','reminder_24h','reminder_2h','follow_up',
                    'vaccination','treatment','reschedule','cancellation','payment','announcement')),
  language        text NOT NULL CHECK (language IN ('en','ar','fr')),
  meta_template_name text,          -- approved template name at Meta
  body            text NOT NULL
);
CREATE TABLE automation_settings (
  organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  purpose             text NOT NULL,
  enabled             boolean NOT NULL DEFAULT false,
  offset_minutes      int,          -- e.g. -1440 for 24h before
  follow_up_days      int,
  PRIMARY KEY (organization_id, purpose)
);
CREATE TABLE patient_consents (
  patient_id   uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  channel      text NOT NULL CHECK (channel IN ('whatsapp','sms','email')),
  opted_in     boolean NOT NULL,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (patient_id, channel)
);
CREATE TABLE whatsapp_conversations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  patient_id          uuid REFERENCES patients(id),
  contact_number      text NOT NULL,
  assigned_to         uuid REFERENCES memberships(id),
  last_inbound_at     timestamptz,
  UNIQUE (account_id, contact_number)
);
CREATE TABLE whatsapp_messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES whatsapp_conversations(id) ON DELETE CASCADE,
  direction        text NOT NULL CHECK (direction IN ('inbound','outbound')),
  template_id      uuid REFERENCES message_templates(id),
  body             text,
  meta_message_id  text UNIQUE,
  status           text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','sent','delivered','read','failed','received')),
  sent_by          uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL,       -- e.g. patient_arrived
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Waiting room: marking ARRIVED stamps the time and notifies the doctor.
CREATE FUNCTION appointment_arrival() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'arrived' AND OLD.status IS DISTINCT FROM 'arrived' THEN
    NEW.arrived_at := COALESCE(NEW.arrived_at, now());
    INSERT INTO notifications (user_id, kind, payload)
    SELECT m.user_id, 'patient_arrived',
           jsonb_build_object('appointment_id', NEW.id, 'patient_id', NEW.patient_id, 'starts_at', NEW.starts_at)
    FROM memberships m WHERE m.id = NEW.doctor_membership_id;
    PERFORM pg_notify('waiting_room', NEW.doctor_membership_id::text);  -- WebSocket fan-out hook
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER appointments_arrival BEFORE UPDATE OF status ON appointments
  FOR EACH ROW EXECUTE FUNCTION appointment_arrival();

-- ---------- Sections 15-16: plans, subscriptions, user language ----------
ALTER TABLE users
  ADD COLUMN interface_language text NOT NULL DEFAULT 'en' CHECK (interface_language IN ('en','ar','fr')),
  ADD COLUMN mfa_secret_ref text;

CREATE TABLE plans (
  code            text PRIMARY KEY,
  name            text NOT NULL,
  monthly_price   numeric(10,2),
  max_doctors     int,
  max_assistants  int,
  features        jsonb NOT NULL DEFAULT '{}'::jsonb
);
INSERT INTO plans (code, name, max_doctors, max_assistants) VALUES
  ('solo','Solo',1,1),('professional','Professional',1,NULL),
  ('medical_center','Medical Center',NULL,NULL),('enterprise','Enterprise',NULL,NULL);

CREATE TABLE subscriptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan_code       text NOT NULL REFERENCES plans(code),
  status          text NOT NULL CHECK (status IN ('trial','active','past_due','cancelled','suspended')),
  trial_ends_at   timestamptz,
  current_period_end timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
