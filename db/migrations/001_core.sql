-- MEDORA CLINICS: core schema (draft from blueprint sections 2-4)
-- PostgreSQL 16. Multi-tenant via organizations + memberships.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- One account per person (doctors are never duplicated across centers). Section 2.C
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text UNIQUE NOT NULL,
  password_hash text,
  full_name     text NOT NULL,
  phone         text,
  is_platform_admin boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Independent practice or medical center. Section 2.A / 2.B
CREATE TABLE organizations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL CHECK (kind IN ('independent_practice','medical_center')),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE locations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  address         text
);

CREATE TABLE rooms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name        text NOT NULL
);

CREATE TABLE departments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL
);

-- Specialty engine registry. Section 4
CREATE TABLE specialties (
  code text PRIMARY KEY,
  name text NOT NULL
);
INSERT INTO specialties (code, name) VALUES
  ('pediatrics','Pediatrics'),
  ('obgyn','Gynecology and Obstetrics'),
  ('orthopedics','Orthopedics'),
  ('dentistry','Dentistry'),
  ('dermatology','Dermatology');

-- Roles from section 3
CREATE TABLE roles (
  code text PRIMARY KEY,
  name text NOT NULL
);
INSERT INTO roles (code, name) VALUES
  ('super_admin','Platform Super Administrator'),
  ('center_owner','Medical Center Owner'),
  ('center_admin','Center Administrator'),
  ('doctor','Doctor'),
  ('assistant','Doctor Assistant'),
  ('receptionist','Receptionist'),
  ('accountant','Accountant'),
  ('insurance_admin','Insurance Administrator'),
  ('patient','Patient');

CREATE TABLE permissions (
  code        text PRIMARY KEY,
  description text NOT NULL
);
INSERT INTO permissions (code, description) VALUES
  ('patient.register','Register patients'),
  ('patient.file.read','Open patient files'),
  ('patient.history.read','View medical history'),
  ('appointment.manage','Manage appointments'),
  ('prescription.view','View prescriptions'),
  ('prescription.create','Create or approve prescriptions'),
  ('document.upload','Upload documents'),
  ('payment.register','Register payments'),
  ('finance.view','View financial information'),
  ('whatsapp.send','WhatsApp communication'),
  ('report.view','View reports'),
  ('clinical_notes.read','Read confidential clinical notes');

-- A user's membership in an organization, with role, fees and settings. Section 2.C
CREATE TABLE memberships (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role_code       text NOT NULL REFERENCES roles(code),
  specialty_code  text REFERENCES specialties(code),
  department_id   uuid REFERENCES departments(id),
  consultation_fee numeric(12,2),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','suspended')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, organization_id, role_code)
);

-- Assistant linked to a specific doctor in a workplace. Section 3
CREATE TABLE assistant_assignments (
  assistant_membership_id uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  doctor_membership_id    uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  PRIMARY KEY (assistant_membership_id, doctor_membership_id)
);

-- Individually configurable grants per membership (explicit, no implicit admin access).
CREATE TABLE membership_permissions (
  membership_id   uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES permissions(code),
  granted_by      uuid REFERENCES users(id),
  granted_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (membership_id, permission_code)
);

CREATE TABLE patients (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users(id),   -- optional patient portal login
  full_name       text NOT NULL,
  date_of_birth   date,
  sex             text,
  phone           text,
  allergies       text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON patients (organization_id, full_name);

CREATE TABLE appointments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  doctor_membership_id uuid NOT NULL REFERENCES memberships(id),
  patient_id           uuid NOT NULL REFERENCES patients(id),
  room_id              uuid REFERENCES rooms(id),
  starts_at            timestamptz NOT NULL,
  ends_at              timestamptz NOT NULL,
  status               text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','confirmed','arrived','in_consultation','completed','cancelled','no_show')),
  CHECK (ends_at > starts_at)
);
CREATE INDEX ON appointments (doctor_membership_id, starts_at);

-- Encounter with specialty-specific data stored as validated JSON per specialty form.
CREATE TABLE consultations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id       uuid REFERENCES appointments(id),
  patient_id           uuid NOT NULL REFERENCES patients(id),
  doctor_membership_id uuid NOT NULL REFERENCES memberships(id),
  specialty_code       text NOT NULL REFERENCES specialties(code),
  clinical_notes       text,          -- confidential: needs clinical_notes.read
  specialty_data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE prescriptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id uuid REFERENCES consultations(id),
  patient_id      uuid NOT NULL REFERENCES patients(id),
  prescribed_by   uuid NOT NULL REFERENCES memberships(id),
  items           jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Only doctors may author prescriptions (section 3: assistants must not create/approve).
CREATE FUNCTION enforce_prescriber_is_doctor() RETURNS trigger AS $$
BEGIN
  IF (SELECT role_code FROM memberships WHERE id = NEW.prescribed_by) <> 'doctor' THEN
    RAISE EXCEPTION 'only a doctor membership can create a prescription';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER prescriptions_doctor_only BEFORE INSERT OR UPDATE ON prescriptions
  FOR EACH ROW EXECUTE FUNCTION enforce_prescriber_is_doctor();

-- Append-only audit log. Section 3
CREATE TABLE audit_log (
  id              bigserial PRIMARY KEY,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  actor_user_id   uuid REFERENCES users(id),
  organization_id uuid REFERENCES organizations(id),
  action          text NOT NULL,
  entity_type     text NOT NULL,
  entity_id       uuid,
  details         jsonb
);
CREATE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_no_change BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
