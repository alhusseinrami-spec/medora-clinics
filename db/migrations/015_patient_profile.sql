-- Richer patient file: a structured clinical summary (problems, allergies, medications, immunizations), dated
-- measurements with trends, prepaid session packages, a body map, an odontogram, before/after photo pairs,
-- custom fields, front-desk notes, Lebanese identifiers and per-purpose data-handling consents (Law 81/2018).
--
-- Clinical rows follow the medical-history rule: readable and writable only with patient.history.read, and only for
-- patients the caller may see. Packages and consents are administrative and follow the patient-file rule.

-- ---------- Identifiers, notes and custom fields ----------
ALTER TABLE patients
  ADD COLUMN nssf_number    text,                              -- National Social Security Fund number
  ADD COLUMN civil_registry text,                              -- place and register number (e.g. "Jdeideh 412")
  ADD COLUMN admin_notes    text,                              -- front-desk notes; no clinical content
  ADD COLUMN custom_fields  jsonb NOT NULL DEFAULT '[]'::jsonb  -- [{ "label": "...", "value": "..." }]
    CHECK (jsonb_typeof(custom_fields) = 'array' AND jsonb_array_length(custom_fields) <= 30);

-- ---------- Clinical summary items ----------
CREATE TABLE patient_clinical_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  patient_id      uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('problem','allergy','medication','immunization')),
  label           text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),   -- "Type 2 diabetes", "Penicillin", "Metformin 850 mg"
  detail          text CHECK (length(detail) <= 1000),                    -- reaction, dose and frequency, dose number...
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','chronic','resolved','stopped')),
  severity        text CHECK (severity IN ('mild','moderate','severe')),  -- allergies only
  code            text CHECK (length(code) <= 20),                        -- optional ICD-10 or ATC code
  started_on      date,
  ended_on        date,
  recorded_by     uuid NOT NULL REFERENCES users(id),
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES users(id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (patient_id, organization_id) REFERENCES patients(id, organization_id),
  CHECK (severity IS NULL OR kind = 'allergy'),
  CHECK (status IN ('active','resolved') OR kind IN ('problem','medication')),
  CHECK (status <> 'stopped' OR kind = 'medication'),
  CHECK (status <> 'chronic' OR kind = 'problem')
);
CREATE INDEX clinical_items_patient_idx ON patient_clinical_items (patient_id, kind, status);

-- ---------- Measurements ----------
CREATE TABLE patient_measurements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  patient_id      uuid NOT NULL,
  code            text NOT NULL CHECK (code IN ('weight','height','bmi','systolic','diastolic','heart_rate','temperature','spo2',
                                                 'fasting_glucose','hba1c','ldl','hdl','triglycerides','creatinine','egfr','tsh','hemoglobin','inr')),
  value           numeric(10,2) NOT NULL,
  measured_on     date NOT NULL,
  note            text CHECK (length(note) <= 300),
  recorded_by     uuid NOT NULL REFERENCES users(id),
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  removed_at      timestamptz,
  FOREIGN KEY (patient_id, organization_id) REFERENCES patients(id, organization_id)
);
CREATE INDEX measurements_patient_idx ON patient_measurements (patient_id, code, measured_on) WHERE removed_at IS NULL;

-- ---------- Body map ----------
CREATE TABLE patient_body_marks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id),
  patient_id        uuid NOT NULL,
  side              text NOT NULL CHECK (side IN ('front','back')),
  x                 numeric(5,2) NOT NULL CHECK (x BETWEEN 0 AND 100),   -- percent of the drawing's width
  y                 numeric(5,2) NOT NULL CHECK (y BETWEEN 0 AND 100),
  region            text NOT NULL CHECK (length(region) BETWEEN 1 AND 120),
  note              text CHECK (length(note) <= 2000),
  photo_document_id uuid REFERENCES medical_documents(id),
  recorded_by       uuid NOT NULL REFERENCES users(id),
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  removed_at        timestamptz,
  removed_by        uuid REFERENCES users(id),
  FOREIGN KEY (patient_id, organization_id) REFERENCES patients(id, organization_id)
);
CREATE INDEX body_marks_patient_idx ON patient_body_marks (patient_id) WHERE removed_at IS NULL;

-- ---------- Odontogram (FDI notation; every record is kept, the latest per tooth is shown) ----------
CREATE TABLE patient_tooth_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  patient_id      uuid NOT NULL,
  tooth           smallint NOT NULL CHECK ((tooth BETWEEN 11 AND 48 AND tooth % 10 BETWEEN 1 AND 8)
                                         OR (tooth BETWEEN 51 AND 85 AND tooth % 10 BETWEEN 1 AND 5)),
  condition       text NOT NULL CHECK (condition IN ('healthy','caries','filling','crown','root_canal','missing','implant',
                                                     'bridge','extraction_planned','fracture','sensitive','other')),
  surfaces        text CHECK (surfaces ~ '^[MODBLIP]{1,5}$'),   -- mesial, occlusal, distal, buccal, lingual, incisal, palatal
  note            text CHECK (length(note) <= 500),
  recorded_by     uuid NOT NULL REFERENCES users(id),
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (patient_id, organization_id) REFERENCES patients(id, organization_id)
);
CREATE INDEX tooth_records_patient_idx ON patient_tooth_records (patient_id, tooth, recorded_at DESC);

-- ---------- Before / after photo pairs ----------
CREATE TABLE patient_photo_pairs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id),
  patient_id         uuid NOT NULL,
  title              text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  before_document_id uuid NOT NULL REFERENCES medical_documents(id),
  after_document_id  uuid REFERENCES medical_documents(id),       -- added later, after treatment
  note               text CHECK (length(note) <= 1000),
  created_by         uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  removed_at         timestamptz,
  FOREIGN KEY (patient_id, organization_id) REFERENCES patients(id, organization_id),
  CHECK (after_document_id IS NULL OR after_document_id <> before_document_id)
);

-- ---------- Session packages (prepaid series: physiotherapy, laser, dressing changes...) ----------
CREATE TABLE patient_packages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  patient_id      uuid NOT NULL,
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  total_sessions  int NOT NULL CHECK (total_sessions BETWEEN 1 AND 200),
  price           numeric(14,2) CHECK (price >= 0),
  currency        text NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD','LBP')),
  expires_on      date,
  note            text CHECK (length(note) <= 500),
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  FOREIGN KEY (patient_id, organization_id) REFERENCES patients(id, organization_id)
);
CREATE TABLE package_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  package_id      uuid NOT NULL REFERENCES patient_packages(id),
  used_at         timestamptz NOT NULL DEFAULT now(),
  appointment_id  uuid REFERENCES appointments(id),
  note            text CHECK (length(note) <= 300),
  recorded_by     uuid NOT NULL REFERENCES users(id),
  voided_at       timestamptz,
  voided_by       uuid REFERENCES users(id)
);
CREATE INDEX package_sessions_pkg_idx ON package_sessions (package_id) WHERE voided_at IS NULL;

-- A package can never be used more times than it holds.
CREATE FUNCTION package_session_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pk record; used int;
BEGIN
  SELECT * INTO pk FROM patient_packages WHERE id = NEW.package_id FOR UPDATE;
  IF pk.closed_at IS NOT NULL THEN RAISE EXCEPTION 'This package is closed' USING ERRCODE = 'check_violation'; END IF;
  SELECT count(*) INTO used FROM package_sessions WHERE package_id = NEW.package_id AND voided_at IS NULL;
  IF used >= pk.total_sessions THEN RAISE EXCEPTION 'All sessions of this package are used' USING ERRCODE = 'check_violation'; END IF;
  NEW.organization_id := pk.organization_id;
  RETURN NEW;
END $$;
CREATE TRIGGER package_sessions_guard BEFORE INSERT ON package_sessions FOR EACH ROW EXECUTE FUNCTION package_session_guard();

-- ---------- Data-handling consents (append-only; the latest row per purpose is the current answer) ----------
CREATE TABLE patient_data_consents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  patient_id      uuid NOT NULL,
  purpose         text NOT NULL CHECK (purpose IN ('chart_access','family_proxy','diaspora_payer','insurance_claims','photos','research')),
  granted         boolean NOT NULL,
  detail          text CHECK (length(detail) <= 300),        -- the named family member, the paying relative...
  given_by        text NOT NULL CHECK (length(given_by) BETWEEN 2 AND 160),   -- patient or legal guardian
  recorded_by     uuid NOT NULL REFERENCES users(id),
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (patient_id, organization_id) REFERENCES patients(id, organization_id)
);
CREATE INDEX data_consents_patient_idx ON patient_data_consents (patient_id, purpose, recorded_at DESC);

-- ---------- Privileges and row-level security ----------
GRANT SELECT, INSERT ON patient_clinical_items, patient_measurements, patient_body_marks, patient_tooth_records,
  patient_photo_pairs, patient_packages, package_sessions, patient_data_consents TO medora_app;
GRANT UPDATE (status, detail, severity, code, started_on, ended_on, label, updated_by, updated_at) ON patient_clinical_items TO medora_app;
GRANT UPDATE (removed_at) ON patient_measurements TO medora_app;
GRANT UPDATE (removed_at, removed_by) ON patient_body_marks TO medora_app;
GRANT UPDATE (after_document_id, note, removed_at) ON patient_photo_pairs TO medora_app;
GRANT UPDATE (closed_at, note) ON patient_packages TO medora_app;
GRANT UPDATE (voided_at, voided_by) ON package_sessions TO medora_app;
-- patient_data_consents and patient_tooth_records are history: no UPDATE, no DELETE.

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['patient_clinical_items','patient_measurements','patient_body_marks','patient_tooth_records','patient_photo_pairs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format($p$CREATE POLICY %I ON %I FOR SELECT USING (
      app_has_perm('patient.history.read') AND app_can_see_patient(patient_id, organization_id))$p$, tbl || '_read', tbl);
    EXECUTE format($p$CREATE POLICY %I ON %I FOR INSERT WITH CHECK (
      app_has_perm('patient.history.read') AND app_can_see_patient(patient_id, organization_id))$p$, tbl || '_insert', tbl);
    EXECUTE format($p$CREATE POLICY %I ON %I FOR UPDATE USING (
      app_has_perm('patient.history.read') AND app_can_see_patient(patient_id, organization_id))$p$, tbl || '_update', tbl);
  END LOOP;
END $$;

ALTER TABLE patient_packages ENABLE ROW LEVEL SECURITY;
CREATE POLICY packages_read ON patient_packages FOR SELECT USING (
  app_has_perm('patient.file.read') AND app_can_see_patient(patient_id, organization_id));
CREATE POLICY packages_write ON patient_packages FOR INSERT WITH CHECK (
  (app_has_perm('payment.register') OR app_has_perm('appointment.manage')) AND app_can_see_patient(patient_id, organization_id)
  AND created_by = app_user_id());
CREATE POLICY packages_update ON patient_packages FOR UPDATE USING (
  (app_has_perm('payment.register') OR app_has_perm('appointment.manage')) AND app_can_see_patient(patient_id, organization_id));

ALTER TABLE package_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY package_sessions_read ON package_sessions FOR SELECT USING (
  app_is_member(organization_id) AND EXISTS (SELECT 1 FROM patient_packages p WHERE p.id = package_id));
CREATE POLICY package_sessions_insert ON package_sessions FOR INSERT WITH CHECK (
  app_has_perm('appointment.manage') AND recorded_by = app_user_id() AND EXISTS (SELECT 1 FROM patient_packages p WHERE p.id = package_id));
CREATE POLICY package_sessions_void ON package_sessions FOR UPDATE USING (
  (app_has_perm('payment.register') OR app_has_perm('appointment.manage')) AND EXISTS (SELECT 1 FROM patient_packages p WHERE p.id = package_id));

ALTER TABLE patient_data_consents ENABLE ROW LEVEL SECURITY;
CREATE POLICY data_consents_read ON patient_data_consents FOR SELECT USING (
  app_has_perm('patient.file.read') AND app_can_see_patient(patient_id, organization_id));
CREATE POLICY data_consents_insert ON patient_data_consents FOR INSERT WITH CHECK (
  app_has_perm('patient.register') AND app_can_see_patient(patient_id, organization_id) AND recorded_by = app_user_id());
