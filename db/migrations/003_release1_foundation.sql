-- MEDORA CLINICS: migration 003, Release 1 foundation.
-- Auth (sessions, MFA, recovery), invitations, role default permissions, more specialties,
-- patient numbering, specialty profiles, cross-tenant composite foreign keys.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------- Specialties: localized names + the "prepared" specialties ----------
ALTER TABLE specialties
  ADD COLUMN names jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN has_full_preset boolean NOT NULL DEFAULT false;
INSERT INTO specialties (code, name) VALUES
  ('ophthalmology','Ophthalmology'), ('ent','ENT'), ('neurology','Neurology'),
  ('gastroenterology','Gastroenterology'), ('endocrinology','Endocrinology'),
  ('urology','Urology'), ('psychiatry','Psychiatry'), ('physiotherapy','Physiotherapy'),
  ('other','Other specialty');
UPDATE specialties SET has_full_preset = true
 WHERE code IN ('pediatrics','obgyn','orthopedics','dentistry','dermatology','cardiology','general_practice');
UPDATE specialties SET names = jsonb_build_object('en', name) || CASE code
  WHEN 'pediatrics'       THEN '{"ar":"طب الأطفال","fr":"Pédiatrie"}'
  WHEN 'obgyn'            THEN '{"ar":"أمراض النساء والتوليد","fr":"Gynécologie-obstétrique"}'
  WHEN 'orthopedics'      THEN '{"ar":"جراحة العظام","fr":"Orthopédie"}'
  WHEN 'dentistry'        THEN '{"ar":"طب الأسنان","fr":"Dentisterie"}'
  WHEN 'dermatology'      THEN '{"ar":"الأمراض الجلدية","fr":"Dermatologie"}'
  WHEN 'cardiology'       THEN '{"ar":"أمراض القلب","fr":"Cardiologie"}'
  WHEN 'general_practice' THEN '{"ar":"الطب العام","fr":"Médecine générale"}'
  WHEN 'ophthalmology'    THEN '{"ar":"طب العيون","fr":"Ophtalmologie"}'
  WHEN 'ent'              THEN '{"ar":"أنف وأذن وحنجرة","fr":"ORL"}'
  WHEN 'neurology'        THEN '{"ar":"طب الأعصاب","fr":"Neurologie"}'
  WHEN 'gastroenterology' THEN '{"ar":"أمراض الجهاز الهضمي","fr":"Gastro-entérologie"}'
  WHEN 'endocrinology'    THEN '{"ar":"الغدد الصماء","fr":"Endocrinologie"}'
  WHEN 'urology'          THEN '{"ar":"المسالك البولية","fr":"Urologie"}'
  WHEN 'psychiatry'       THEN '{"ar":"الطب النفسي","fr":"Psychiatrie"}'
  WHEN 'physiotherapy'    THEN '{"ar":"العلاج الفيزيائي","fr":"Kinésithérapie"}'
  ELSE '{"ar":"اختصاص آخر","fr":"Autre spécialité"}' END::jsonb;

-- ---------- Permissions and role defaults (section 3) ----------
INSERT INTO permissions (code, description) VALUES
  ('org.manage','Manage workspace profile, locations, rooms, departments'),
  ('staff.manage','Invite, assign and suspend staff'),
  ('permission.manage','Change staff permissions'),
  ('insurance.manage','Manage insurance providers, policies and claims'),
  ('template.manage','Customize specialty templates');

CREATE TABLE role_default_permissions (
  role_code       text NOT NULL REFERENCES roles(code),
  permission_code text NOT NULL REFERENCES permissions(code),
  PRIMARY KEY (role_code, permission_code)
);
INSERT INTO role_default_permissions (role_code, permission_code)
SELECT r, p FROM (VALUES
  ('center_owner', ARRAY['org.manage','staff.manage','permission.manage','finance.view','report.view']),
  ('center_admin', ARRAY['org.manage','staff.manage','permission.manage','patient.register','patient.file.read','appointment.manage','report.view']),
  ('doctor',       ARRAY['patient.register','patient.file.read','patient.history.read','clinical_notes.read','appointment.manage',
                         'prescription.view','prescription.create','document.upload','payment.register','finance.view',
                         'insurance.manage','whatsapp.send','report.view','template.manage','permission.manage']),
  ('assistant',    ARRAY['patient.register','patient.file.read','appointment.manage','document.upload']),
  ('receptionist', ARRAY['patient.register','patient.file.read','appointment.manage','payment.register']),
  ('accountant',   ARRAY['payment.register','finance.view','report.view']),
  ('insurance_admin', ARRAY['insurance.manage'])
) AS d(r, ps), unnest(ps) AS p;

-- prescription.create can only be held by a doctor membership, whatever the switches say.
CREATE FUNCTION enforce_prescriber_grant() RETURNS trigger AS $$
BEGIN
  IF NEW.permission_code = 'prescription.create'
     AND (SELECT role_code FROM memberships WHERE id = NEW.membership_id) <> 'doctor' THEN
    RAISE EXCEPTION 'prescription.create can only be granted to a doctor';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER membership_permissions_prescriber BEFORE INSERT OR UPDATE ON membership_permissions
  FOR EACH ROW EXECUTE FUNCTION enforce_prescriber_grant();

-- ---------- Users, sessions, MFA, recovery ----------
ALTER TABLE users
  ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  ADD COLUMN mfa_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN mfa_secret_enc text,               -- AES-256-GCM, key from environment
  ADD COLUMN failed_logins int NOT NULL DEFAULT 0,
  ADD COLUMN locked_until timestamptz,
  ADD COLUMN theme text NOT NULL DEFAULT 'system' CHECK (theme IN ('system','light','dark'));
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,            -- sha256 of the opaque token; token never stored
  mfa_pending  boolean NOT NULL DEFAULT false,  -- password ok, TOTP still required
  user_agent   text,
  ip           text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE password_resets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Outgoing email. With no provider configured, rows stay 'awaiting_credentials' and nothing is sent.
CREATE TABLE outbound_emails (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  to_email    text NOT NULL,
  purpose     text NOT NULL,
  subject     text NOT NULL,
  body        text NOT NULL,
  status      text NOT NULL DEFAULT 'awaiting_credentials' CHECK (status IN ('awaiting_credentials','queued','sent','failed')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- Organizations, memberships, invitations ----------
ALTER TABLE organizations
  ADD COLUMN created_by uuid REFERENCES users(id),
  ADD COLUMN phone text, ADD COLUMN email text, ADD COLUMN address text,
  ADD COLUMN default_language text NOT NULL DEFAULT 'en' CHECK (default_language IN ('en','ar','fr')),
  ADD COLUMN timezone text NOT NULL DEFAULT 'Asia/Beirut',
  ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended'));

ALTER TABLE memberships
  ADD COLUMN title text,                              -- e.g. "Pediatrician"
  ADD CONSTRAINT memberships_id_org_uq UNIQUE (id, organization_id);
ALTER TABLE locations ADD CONSTRAINT locations_id_org_uq UNIQUE (id, organization_id);
ALTER TABLE departments ADD CONSTRAINT departments_id_org_uq UNIQUE (id, organization_id);

CREATE TABLE invitations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email               text NOT NULL,
  role_code           text NOT NULL REFERENCES roles(code) CHECK (role_code NOT IN ('super_admin','patient')),
  specialty_code      text REFERENCES specialties(code),
  department_id       uuid REFERENCES departments(id),
  consultation_fee    numeric(12,2),
  assign_to_doctor_membership_id uuid REFERENCES memberships(id) ON DELETE CASCADE,
  token_hash          text NOT NULL UNIQUE,
  invited_by          uuid NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL DEFAULT now() + interval '7 days',
  accepted_at         timestamptz,
  accepted_user_id    uuid REFERENCES users(id),
  revoked_at          timestamptz
);
CREATE INDEX invitations_org_idx ON invitations (organization_id);

-- ---------- Patients ----------
ALTER TABLE patients
  ADD COLUMN created_by uuid REFERENCES users(id),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN archived_at timestamptz,
  ADD CONSTRAINT patients_sex_check CHECK (sex IS NULL OR sex IN ('female','male','other','unknown')),
  ADD CONSTRAINT patients_id_org_uq UNIQUE (id, organization_id);
CREATE INDEX patients_name_trgm ON patients USING gin (lower(full_name) gin_trgm_ops);

-- Automatic per-organization patient number, e.g. P-000123.
CREATE TABLE patient_counters (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  last_number     int NOT NULL DEFAULT 0
);
CREATE FUNCTION patients_before_insert() RETURNS trigger AS $$
DECLARE n int;
BEGIN
  IF NEW.patient_number IS NULL THEN
    INSERT INTO patient_counters (organization_id, last_number) VALUES (NEW.organization_id, 1)
    ON CONFLICT (organization_id) DO UPDATE SET last_number = patient_counters.last_number + 1
    RETURNING last_number INTO n;
    NEW.patient_number := 'P-' || lpad(n::text, 6, '0');
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
CREATE TRIGGER patients_numbering BEFORE INSERT ON patients
  FOR EACH ROW EXECUTE FUNCTION patients_before_insert();

-- Patient data captured through the specialty engine (one profile per specialty per patient).
CREATE TABLE patient_specialty_profiles (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  patient_id          uuid NOT NULL,
  specialty_code      text NOT NULL REFERENCES specialties(code),
  template_version_id uuid NOT NULL REFERENCES template_versions(id),
  data                jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by          uuid REFERENCES users(id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (patient_id, specialty_code),
  FOREIGN KEY (patient_id, organization_id) REFERENCES patients(id, organization_id) ON DELETE CASCADE
);

-- Templates: doctor forks of presets, activity flag.
ALTER TABLE clinical_templates
  ADD COLUMN based_on_template_id uuid REFERENCES clinical_templates(id),
  ADD COLUMN is_active boolean NOT NULL DEFAULT true;
ALTER TABLE clinical_templates DROP CONSTRAINT clinical_templates_kind_check;
ALTER TABLE clinical_templates ADD CONSTRAINT clinical_templates_kind_check CHECK (kind IN
  ('examination','clinical_note','prescription','treatment_plan','patient_form','measurement_set','patient_profile','dashboard'));
ALTER TABLE template_versions ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

-- ---------- Scheduling: cross-tenant safety and lifecycle stamps ----------
ALTER TABLE appointments
  ADD COLUMN created_by uuid REFERENCES users(id),
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN started_at timestamptz,
  ADD COLUMN completed_at timestamptz,
  ADD COLUMN cancelled_reason text,
  ADD CONSTRAINT appointments_patient_same_org FOREIGN KEY (patient_id, organization_id)
      REFERENCES patients(id, organization_id),
  ADD CONSTRAINT appointments_doctor_same_org FOREIGN KEY (doctor_membership_id, organization_id)
      REFERENCES memberships(id, organization_id),
  ADD CONSTRAINT appointments_location_same_org FOREIGN KEY (location_id, organization_id)
      REFERENCES locations(id, organization_id),
  ADD CONSTRAINT appointments_department_same_org FOREIGN KEY (department_id, organization_id)
      REFERENCES departments(id, organization_id);
ALTER TABLE services ADD CONSTRAINT services_id_org_uq UNIQUE (id, organization_id);
ALTER TABLE appointments ADD CONSTRAINT appointments_service_same_org FOREIGN KEY (service_id, organization_id)
      REFERENCES services(id, organization_id);
ALTER TABLE invoices ADD CONSTRAINT invoices_patient_same_org FOREIGN KEY (patient_id, organization_id)
      REFERENCES patients(id, organization_id);

-- A room must belong to the appointment's organization (rooms reach the org through their location).
CREATE FUNCTION appointments_room_same_org() RETURNS trigger AS $$
BEGIN
  IF NEW.room_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM rooms r JOIN locations l ON l.id = r.location_id
        WHERE r.id = NEW.room_id AND l.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'room belongs to another organization';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
CREATE TRIGGER appointments_room_check BEFORE INSERT OR UPDATE OF room_id ON appointments
  FOR EACH ROW EXECUTE FUNCTION appointments_room_same_org();

-- Lifecycle timestamps for the waiting room and call/complete.
CREATE OR REPLACE FUNCTION appointment_arrival() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'arrived' AND OLD.status IS DISTINCT FROM 'arrived' THEN
    NEW.arrived_at := COALESCE(NEW.arrived_at, now());
    INSERT INTO notifications (user_id, kind, payload)
    SELECT m.user_id, 'patient_arrived',
           jsonb_build_object('appointment_id', NEW.id, 'patient_id', NEW.patient_id,
                              'organization_id', NEW.organization_id, 'starts_at', NEW.starts_at)
    FROM memberships m WHERE m.id = NEW.doctor_membership_id;
    PERFORM pg_notify('waiting_room', json_build_object('organization_id', NEW.organization_id,
            'doctor_membership_id', NEW.doctor_membership_id, 'appointment_id', NEW.id, 'event', 'arrived')::text);
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'in_consultation' THEN NEW.called_at := COALESCE(NEW.called_at, now()); NEW.started_at := COALESCE(NEW.started_at, now()); END IF;
    IF NEW.status = 'completed' THEN NEW.completed_at := COALESCE(NEW.completed_at, now()); END IF;
    PERFORM pg_notify('waiting_room', json_build_object('organization_id', NEW.organization_id,
            'doctor_membership_id', NEW.doctor_membership_id, 'appointment_id', NEW.id, 'event', NEW.status)::text);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Invoice numbering touches the counter table regardless of the caller's row visibility.
ALTER FUNCTION invoices_before_insert() SECURITY DEFINER SET search_path = public;

-- Views must apply the caller's row-level security, not the view owner's.
ALTER VIEW waiting_room SET (security_invoker = true);
ALTER VIEW invoice_balances SET (security_invoker = true);
