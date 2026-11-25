-- MEDORA CLINICS: migration 006, Release 2 clinical records.
-- Consultations (draft -> signed, immutable once signed, addenda), diagnoses, medication catalog,
-- prescriptions (draft -> issued -> cancelled, immutable once issued), prescription templates,
-- and encrypted medical documents. Every table is tenant-scoped and covered by row-level security.

-- ---------- Consultations ----------
ALTER TABLE consultations
  ADD COLUMN organization_id     uuid REFERENCES organizations(id),
  ADD COLUMN status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','signed')),
  ADD COLUMN follow_up_date      date,
  ADD COLUMN signed_at           timestamptz,
  ADD COLUMN signed_by           uuid REFERENCES users(id),
  ADD COLUMN updated_at          timestamptz NOT NULL DEFAULT now();
UPDATE consultations c SET organization_id = p.organization_id FROM patients p WHERE p.id = c.patient_id;
ALTER TABLE consultations
  ALTER COLUMN organization_id SET NOT NULL,
  ADD CONSTRAINT consultations_id_org_uq UNIQUE (id, organization_id),
  ADD CONSTRAINT consultations_patient_same_org FOREIGN KEY (patient_id, organization_id) REFERENCES patients(id, organization_id),
  ADD CONSTRAINT consultations_doctor_same_org FOREIGN KEY (doctor_membership_id, organization_id) REFERENCES memberships(id, organization_id),
  ADD CONSTRAINT consultations_signed_consistent CHECK ((status = 'signed') = (signed_at IS NOT NULL));
ALTER TABLE appointments ADD CONSTRAINT appointments_id_org_uq UNIQUE (id, organization_id);
ALTER TABLE consultations ADD CONSTRAINT consultations_appointment_same_org
  FOREIGN KEY (appointment_id, organization_id) REFERENCES appointments(id, organization_id);
CREATE UNIQUE INDEX consultations_one_per_appointment ON consultations (appointment_id) WHERE appointment_id IS NOT NULL;
CREATE INDEX consultations_patient_idx ON consultations (patient_id, created_at DESC);

-- A signed consultation is a legal record: it can never be changed or deleted. Corrections go in addenda.
CREATE FUNCTION consultations_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'signed' THEN RAISE EXCEPTION 'a signed consultation cannot be deleted' USING ERRCODE = 'check_violation'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'signed' THEN
    RAISE EXCEPTION 'a signed consultation cannot be changed; add an addendum instead' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.patient_id <> OLD.patient_id OR NEW.doctor_membership_id <> OLD.doctor_membership_id OR NEW.organization_id <> OLD.organization_id THEN
    RAISE EXCEPTION 'consultation patient, doctor and workspace cannot change' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER consultations_guard BEFORE UPDATE OR DELETE ON consultations FOR EACH ROW EXECUTE FUNCTION consultations_guard();

-- Diagnoses follow their consultation: frozen once it is signed.
ALTER TABLE diagnoses ADD COLUMN position int NOT NULL DEFAULT 0, ADD COLUMN is_primary boolean NOT NULL DEFAULT false;
CREATE FUNCTION diagnoses_guard() RETURNS trigger AS $$
DECLARE cid uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.consultation_id ELSE NEW.consultation_id END;
BEGIN
  IF (SELECT status FROM consultations WHERE id = cid) = 'signed' THEN
    RAISE EXCEPTION 'diagnoses of a signed consultation cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
CREATE TRIGGER diagnoses_guard BEFORE INSERT OR UPDATE OR DELETE ON diagnoses FOR EACH ROW EXECUTE FUNCTION diagnoses_guard();

CREATE TABLE consultation_addenda (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id),
  consultation_id      uuid NOT NULL,
  author_membership_id uuid NOT NULL,
  body                 text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  created_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (consultation_id, organization_id) REFERENCES consultations(id, organization_id),
  FOREIGN KEY (author_membership_id, organization_id) REFERENCES memberships(id, organization_id)
);
CREATE FUNCTION addenda_guard() RETURNS trigger AS $$
BEGIN
  IF (SELECT status FROM consultations WHERE id = NEW.consultation_id) <> 'signed' THEN
    RAISE EXCEPTION 'addenda are for signed consultations; edit the draft instead' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
CREATE TRIGGER addenda_guard BEFORE INSERT ON consultation_addenda FOR EACH ROW EXECUTE FUNCTION addenda_guard();

-- ---------- Medication catalog ----------
-- Rows with organization_id NULL are the shared generic catalog; a workspace can add its own entries.
ALTER TABLE medications
  ADD COLUMN organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  ADD COLUMN route           text,
  ADD COLUMN created_by      uuid REFERENCES users(id),
  ADD COLUMN created_at      timestamptz NOT NULL DEFAULT now();
CREATE INDEX medications_trgm_idx ON medications USING gin (lower(name) gin_trgm_ops);
CREATE UNIQUE INDEX medications_unique ON medications (coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name), coalesce(lower(strength),''), coalesce(lower(form),''));

INSERT INTO medications (name, strength, form, route) VALUES
  ('Paracetamol','500 mg','tablet','oral'),('Paracetamol','120 mg/5 ml','syrup','oral'),('Paracetamol','250 mg/5 ml','syrup','oral'),
  ('Ibuprofen','400 mg','tablet','oral'),('Ibuprofen','100 mg/5 ml','suspension','oral'),('Diclofenac sodium','50 mg','tablet','oral'),
  ('Amoxicillin','500 mg','capsule','oral'),('Amoxicillin','250 mg/5 ml','suspension','oral'),
  ('Amoxicillin + clavulanic acid','1 g','tablet','oral'),('Amoxicillin + clavulanic acid','457 mg/5 ml','suspension','oral'),
  ('Azithromycin','500 mg','tablet','oral'),('Azithromycin','200 mg/5 ml','suspension','oral'),('Cefuroxime','500 mg','tablet','oral'),
  ('Ciprofloxacin','500 mg','tablet','oral'),('Metronidazole','500 mg','tablet','oral'),('Doxycycline','100 mg','capsule','oral'),
  ('Omeprazole','20 mg','capsule','oral'),('Pantoprazole','40 mg','tablet','oral'),('Domperidone','10 mg','tablet','oral'),
  ('Oral rehydration salts',NULL,'sachet','oral'),('Cetirizine','10 mg','tablet','oral'),('Desloratadine','0.5 mg/ml','syrup','oral'),
  ('Salbutamol','100 mcg/dose','inhaler','inhalation'),('Budesonide','0.5 mg/2 ml','nebuliser suspension','inhalation'),
  ('Prednisolone','5 mg','tablet','oral'),('Metformin','850 mg','tablet','oral'),('Gliclazide','60 mg','modified-release tablet','oral'),
  ('Amlodipine','5 mg','tablet','oral'),('Bisoprolol','5 mg','tablet','oral'),('Losartan','50 mg','tablet','oral'),
  ('Atorvastatin','20 mg','tablet','oral'),('Acetylsalicylic acid','81 mg','tablet','oral'),('Clopidogrel','75 mg','tablet','oral'),
  ('Furosemide','40 mg','tablet','oral'),('Folic acid','5 mg','tablet','oral'),('Ferrous sulfate','200 mg','tablet','oral'),
  ('Vitamin D3','50000 IU','capsule','oral'),('Levothyroxine','50 mcg','tablet','oral'),('Progesterone','200 mg','capsule','vaginal'),
  ('Clotrimazole','1%','cream','topical'),('Hydrocortisone','1%','cream','topical'),('Fusidic acid','2%','cream','topical'),
  ('Mupirocin','2%','ointment','topical'),('Tretinoin','0.025%','cream','topical'),('Benzoyl peroxide','5%','gel','topical'),
  ('Chlorhexidine mouthwash','0.12%','solution','oral rinse'),('Amoxicillin','1 g','tablet','oral'),('Tramadol','50 mg','capsule','oral')
ON CONFLICT DO NOTHING;

-- ---------- Prescriptions ----------
ALTER TABLE prescriptions
  ADD COLUMN organization_id uuid REFERENCES organizations(id),
  ADD COLUMN notes           text,
  ADD COLUMN issued_at       timestamptz,
  ADD COLUMN cancelled_at    timestamptz,
  ADD COLUMN cancel_reason   text,
  ADD COLUMN shared_at       timestamptz,
  ADD COLUMN updated_at      timestamptz NOT NULL DEFAULT now();
UPDATE prescriptions r SET organization_id = p.organization_id FROM patients p WHERE p.id = r.patient_id;
UPDATE prescriptions SET issued_at = created_at WHERE status <> 'draft' AND issued_at IS NULL;
ALTER TABLE prescriptions
  ALTER COLUMN organization_id SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'draft',
  ADD CONSTRAINT prescriptions_patient_same_org FOREIGN KEY (patient_id, organization_id) REFERENCES patients(id, organization_id),
  ADD CONSTRAINT prescriptions_doctor_same_org FOREIGN KEY (prescribed_by, organization_id) REFERENCES memberships(id, organization_id),
  ADD CONSTRAINT prescriptions_consultation_same_org FOREIGN KEY (consultation_id, organization_id) REFERENCES consultations(id, organization_id),
  ADD CONSTRAINT prescriptions_issued_consistent CHECK ((status = 'draft') = (issued_at IS NULL)),
  ADD CONSTRAINT prescriptions_cancel_consistent CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL));
CREATE INDEX prescriptions_patient_idx ON prescriptions (patient_id, created_at DESC);
ALTER TABLE prescription_items ADD COLUMN position int NOT NULL DEFAULT 0;

-- An issued prescription is frozen. Allowed afterwards: cancel it (once), or mark it shared with the patient.
CREATE FUNCTION prescriptions_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'an issued prescription cannot be deleted; cancel it instead' USING ERRCODE = 'check_violation'; END IF;
    RETURN OLD;
  END IF;
  IF NEW.patient_id <> OLD.patient_id OR NEW.prescribed_by <> OLD.prescribed_by OR NEW.organization_id <> OLD.organization_id
     OR NEW.consultation_id IS DISTINCT FROM OLD.consultation_id THEN
    RAISE EXCEPTION 'prescription patient, doctor, consultation and workspace cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'cancelled' AND (NEW.status <> 'cancelled' OR NEW.notes IS DISTINCT FROM OLD.notes
       OR NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason) THEN
    RAISE EXCEPTION 'a cancelled prescription cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'issued' AND (NEW.notes IS DISTINCT FROM OLD.notes OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
       OR NEW.status NOT IN ('issued','cancelled')) THEN
    RAISE EXCEPTION 'an issued prescription cannot be changed; cancel it and write a new one' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER prescriptions_guard BEFORE UPDATE OR DELETE ON prescriptions FOR EACH ROW EXECUTE FUNCTION prescriptions_guard();

CREATE FUNCTION prescription_items_guard() RETURNS trigger AS $$
DECLARE pid uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.prescription_id ELSE NEW.prescription_id END;
BEGIN
  IF (SELECT status FROM prescriptions WHERE id = pid) <> 'draft' THEN
    RAISE EXCEPTION 'items of an issued prescription cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
CREATE TRIGGER prescription_items_guard BEFORE INSERT OR UPDATE OR DELETE ON prescription_items FOR EACH ROW EXECUTE FUNCTION prescription_items_guard();

-- Reusable prescriptions a doctor saves (for example "Adult otitis media").
CREATE TABLE prescription_templates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_membership_id uuid NOT NULL,
  name                text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  items               jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array'),
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (owner_membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE CASCADE,
  UNIQUE (owner_membership_id, name)
);

-- ---------- Medical documents ----------
ALTER TABLE medical_documents
  ADD COLUMN organization_id   uuid REFERENCES organizations(id),
  ADD COLUMN title             text,
  ADD COLUMN original_filename text,
  ADD COLUMN size_bytes        bigint,
  ADD COLUMN sha256            text,
  ADD COLUMN storage_backend   text NOT NULL DEFAULT 'local' CHECK (storage_backend IN ('local','s3')),
  ADD COLUMN notes             text,
  ADD COLUMN deleted_at        timestamptz,
  ADD COLUMN deleted_by        uuid REFERENCES users(id);
UPDATE medical_documents d SET organization_id = p.organization_id FROM patients p WHERE p.id = d.patient_id;
ALTER TABLE medical_documents
  ALTER COLUMN organization_id SET NOT NULL,
  ADD CONSTRAINT documents_patient_same_org FOREIGN KEY (patient_id, organization_id) REFERENCES patients(id, organization_id) ON DELETE CASCADE,
  ADD CONSTRAINT documents_consultation_same_org FOREIGN KEY (consultation_id, organization_id) REFERENCES consultations(id, organization_id),
  ADD CONSTRAINT documents_size_limit CHECK (size_bytes IS NULL OR size_bytes BETWEEN 1 AND 15728640);
CREATE INDEX documents_patient_idx ON medical_documents (patient_id, created_at DESC) WHERE deleted_at IS NULL;

-- Stored bytes never change; only title, notes, kind, sharing and soft deletion may.
CREATE FUNCTION documents_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.storage_key <> OLD.storage_key OR NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
     OR NEW.patient_id <> OLD.patient_id OR NEW.organization_id <> OLD.organization_id OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by THEN
    RAISE EXCEPTION 'the stored file and its owner cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'a deleted document cannot be changed' USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER documents_guard BEFORE UPDATE ON medical_documents FOR EACH ROW EXECUTE FUNCTION documents_guard();

-- Convenience: a clinical row inherits its patient's workspace when none is given. The composite foreign keys
-- and the row-level security checks below still apply to the filled-in value.
CREATE FUNCTION fill_org_from_patient() RETURNS trigger AS $$
BEGIN
  IF NEW.organization_id IS NULL THEN
    NEW.organization_id := (SELECT organization_id FROM patients WHERE id = NEW.patient_id);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
CREATE TRIGGER consultations_fill_org BEFORE INSERT ON consultations FOR EACH ROW EXECUTE FUNCTION fill_org_from_patient();
CREATE TRIGGER prescriptions_fill_org BEFORE INSERT ON prescriptions FOR EACH ROW EXECUTE FUNCTION fill_org_from_patient();
CREATE TRIGGER documents_fill_org BEFORE INSERT ON medical_documents FOR EACH ROW EXECUTE FUNCTION fill_org_from_patient();

-- ---------- Grants ----------
GRANT SELECT, INSERT ON consultation_addenda TO medora_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON prescription_templates TO medora_app;
GRANT SELECT, INSERT ON medications TO medora_app;
REVOKE UPDATE, DELETE ON medications FROM medora_app;
REVOKE DELETE ON medical_documents FROM medora_app;   -- documents are soft-deleted only

-- ---------- Row-level security ----------
ALTER TABLE consultation_addenda ENABLE ROW LEVEL SECURITY;
ALTER TABLE prescription_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE medications ENABLE ROW LEVEL SECURITY;

-- Consultations: replace the Release 1 placeholders with workspace-pinned rules.
DROP POLICY consultations_read ON consultations;
DROP POLICY consultations_write ON consultations;
DROP POLICY consultations_update ON consultations;
CREATE POLICY consultations_read ON consultations FOR SELECT USING (
  app_is_member(organization_id) AND app_can_see_patient(patient_id, organization_id)
  AND app_can_read_clinical(patient_id, doctor_membership_id));
-- Only the doctor themself writes their consultation (assistants prepare the visit but do not author notes).
CREATE POLICY consultations_insert ON consultations FOR INSERT WITH CHECK (
  app_is_member(organization_id) AND app_can_see_patient(patient_id, organization_id) AND app_has_perm('clinical_notes.read')
  AND doctor_membership_id IN (SELECT m.id FROM memberships m WHERE m.user_id = app_user_id() AND m.organization_id = consultations.organization_id AND m.role_code = 'doctor'));
CREATE POLICY consultations_update ON consultations FOR UPDATE USING (
  app_is_member(organization_id)
  AND doctor_membership_id IN (SELECT m.id FROM memberships m WHERE m.user_id = app_user_id() AND m.role_code = 'doctor'))
  WITH CHECK (app_is_member(organization_id));
CREATE POLICY consultations_delete ON consultations FOR DELETE USING (
  status = 'draft' AND app_is_member(organization_id)
  AND doctor_membership_id IN (SELECT m.id FROM memberships m WHERE m.user_id = app_user_id() AND m.role_code = 'doctor'));

CREATE POLICY addenda_read ON consultation_addenda FOR SELECT USING (
  EXISTS (SELECT 1 FROM consultations c WHERE c.id = consultation_id));
CREATE POLICY addenda_insert ON consultation_addenda FOR INSERT WITH CHECK (
  app_is_member(organization_id) AND app_has_perm('clinical_notes.read')
  AND author_membership_id IN (SELECT m.id FROM memberships m WHERE m.user_id = app_user_id() AND m.role_code = 'doctor')
  AND EXISTS (SELECT 1 FROM consultations c WHERE c.id = consultation_id));

-- Medication catalog: shared generics for everyone signed in, plus the workspace's own entries.
CREATE POLICY medications_read ON medications FOR SELECT USING (
  app_user_id() IS NOT NULL AND (organization_id IS NULL OR app_is_member(organization_id)));
CREATE POLICY medications_insert ON medications FOR INSERT WITH CHECK (
  organization_id = app_org_id() AND app_is_member(organization_id) AND app_has_perm('prescription.create') AND created_by = app_user_id());

-- Prescriptions: pinned to the workspace in the session.
DROP POLICY prescriptions_read ON prescriptions;
DROP POLICY prescriptions_write ON prescriptions;
DROP POLICY prescriptions_update ON prescriptions;
CREATE POLICY prescriptions_read ON prescriptions FOR SELECT USING (
  app_is_member(organization_id) AND app_can_see_patient(patient_id, organization_id) AND app_has_perm('prescription.view')
  AND (app_acts_for(prescribed_by) OR app_can_read_clinical(patient_id, prescribed_by)));
CREATE POLICY prescriptions_insert ON prescriptions FOR INSERT WITH CHECK (
  app_is_member(organization_id) AND app_has_perm('prescription.create') AND app_can_see_patient(patient_id, organization_id)
  AND prescribed_by IN (SELECT m.id FROM memberships m WHERE m.user_id = app_user_id() AND m.organization_id = prescriptions.organization_id AND m.role_code = 'doctor'));
CREATE POLICY prescriptions_update ON prescriptions FOR UPDATE USING (
  app_is_member(organization_id) AND app_has_perm('prescription.create')
  AND prescribed_by IN (SELECT m.id FROM memberships m WHERE m.user_id = app_user_id()))
  WITH CHECK (app_is_member(organization_id));
CREATE POLICY prescriptions_delete ON prescriptions FOR DELETE USING (
  status = 'draft' AND prescribed_by IN (SELECT m.id FROM memberships m WHERE m.user_id = app_user_id()));

CREATE POLICY rx_templates_rw ON prescription_templates FOR ALL USING (
  app_is_member(organization_id) AND owner_membership_id IN (SELECT m.id FROM memberships m WHERE m.user_id = app_user_id()))
  WITH CHECK (app_is_member(organization_id) AND app_has_perm('prescription.create')
  AND owner_membership_id IN (SELECT m.id FROM memberships m WHERE m.user_id = app_user_id() AND m.role_code = 'doctor'));

-- Documents: reading needs the medical history permission (the uploader always sees what they uploaded).
DROP POLICY documents_rw ON medical_documents;
CREATE POLICY documents_read ON medical_documents FOR SELECT USING (
  app_is_member(organization_id) AND app_can_see_patient(patient_id, organization_id)
  AND (app_has_perm('patient.history.read') OR uploaded_by = app_user_id()));
CREATE POLICY documents_insert ON medical_documents FOR INSERT WITH CHECK (
  app_is_member(organization_id) AND app_has_perm('document.upload') AND app_can_see_patient(patient_id, organization_id)
  AND uploaded_by = app_user_id());
CREATE POLICY documents_update ON medical_documents FOR UPDATE USING (
  app_is_member(organization_id) AND app_can_see_patient(patient_id, organization_id) AND app_has_perm('document.upload')
  AND (app_has_perm('patient.history.read') OR uploaded_by = app_user_id()))
  WITH CHECK (app_is_member(organization_id));

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO medora_app;
