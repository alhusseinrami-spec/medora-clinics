-- MEDORA CLINICS: migration 009, Release 5 mobile ecosystem (installable app, push notifications, patient portal).
-- Patients get their own accounts, linked to their record in each clinic that invited them. Everything a patient can
-- read or do goes through the portal_* functions below, which check the link for the signed-in user; the staff
-- tables' row-level security is unchanged, so a patient account never gains staff access.

-- ---------- Web push subscriptions (one per browser or installed app) ----------
CREATE TABLE push_subscriptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint     text NOT NULL UNIQUE,
  p256dh       text NOT NULL,
  auth         text NOT NULL,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  failures     int NOT NULL DEFAULT 0
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);
GRANT SELECT, INSERT, DELETE ON push_subscriptions TO medora_app;
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY push_own ON push_subscriptions FOR ALL USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());

-- The push sender (no user identity) reads a user's subscriptions and records delivery results.
CREATE FUNCTION push_targets(p_user uuid) RETURNS TABLE (id uuid, endpoint text, p256dh text, auth text, language text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id, s.endpoint, s.p256dh, s.auth, u.interface_language FROM push_subscriptions s JOIN users u ON u.id = s.user_id WHERE s.user_id = p_user
$$;
-- Live events carry the notification id and workspace, so a push can open the right screen and is sent once.
ALTER TABLE notifications ADD COLUMN pushed_at timestamptz;
CREATE FUNCTION push_claim(p_notification uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE notifications SET pushed_at = now() WHERE id = p_notification AND pushed_at IS NULL RETURNING true
$$;
CREATE OR REPLACE FUNCTION notifications_push() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('comm_events', json_build_object('type', 'notification', 'id', NEW.id, 'user_id', NEW.user_id, 'kind', NEW.kind,
    'organization_id', NEW.payload->>'organization_id')::text);
  RETURN NEW;
END $$;
CREATE FUNCTION push_result(p_id uuid, p_ok boolean, p_gone boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_gone THEN DELETE FROM push_subscriptions WHERE id = p_id;
  ELSIF p_ok THEN UPDATE push_subscriptions SET last_used_at = now(), failures = 0 WHERE id = p_id;
  ELSE UPDATE push_subscriptions SET failures = failures + 1 WHERE id = p_id;
       DELETE FROM push_subscriptions WHERE id = p_id AND failures >= 10;
  END IF;
END $$;

-- ---------- Patient accounts ----------
CREATE TABLE patient_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  patient_id      uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  invited_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  revoked_by      uuid REFERENCES users(id),
  FOREIGN KEY (patient_id, organization_id) REFERENCES patients(id, organization_id)
);
CREATE UNIQUE INDEX patient_accounts_active_uq ON patient_accounts (patient_id) WHERE revoked_at IS NULL;
CREATE INDEX patient_accounts_user_idx ON patient_accounts (user_id) WHERE revoked_at IS NULL;

CREATE TABLE patient_portal_invitations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  patient_id      uuid NOT NULL,
  email           text NOT NULL,
  token_hash      text NOT NULL UNIQUE,
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '14 days',
  accepted_at     timestamptz,
  accepted_by     uuid REFERENCES users(id),
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (patient_id, organization_id) REFERENCES patients(id, organization_id)
);

-- Staff who may see the patient may see and manage portal access (registering patients is front-desk work).
GRANT SELECT ON patient_accounts TO medora_app;
GRANT UPDATE (revoked_at, revoked_by) ON patient_accounts TO medora_app;
GRANT SELECT, INSERT ON patient_portal_invitations TO medora_app;
REVOKE SELECT (token_hash) ON patient_portal_invitations FROM medora_app;
ALTER TABLE patient_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_portal_invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY patient_accounts_staff_read ON patient_accounts FOR SELECT USING (app_can_see_patient(patient_id, organization_id));
CREATE POLICY patient_accounts_staff_revoke ON patient_accounts FOR UPDATE USING (app_can_see_patient(patient_id, organization_id) AND app_has_perm('patient.register'))
  WITH CHECK (revoked_by = app_user_id());
CREATE POLICY portal_invites_staff_read ON patient_portal_invitations FOR SELECT USING (app_can_see_patient(patient_id, organization_id));
CREATE POLICY portal_invites_staff_insert ON patient_portal_invitations FOR INSERT WITH CHECK (
  app_can_see_patient(patient_id, organization_id) AND app_has_perm('patient.register') AND created_by = app_user_id());
-- Column-level SELECT without token_hash needs explicit column grants.
REVOKE SELECT ON patient_portal_invitations FROM medora_app;
GRANT SELECT (id, organization_id, patient_id, email, expires_at, accepted_at, accepted_by, created_by, created_at) ON patient_portal_invitations TO medora_app;

-- Patients linked to the signed-in user (active links only, active clinics only).
CREATE FUNCTION portal_patient_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT pa.patient_id FROM patient_accounts pa JOIN organizations o ON o.id = pa.organization_id AND o.status = 'active'
   WHERE pa.user_id = app_user_id() AND pa.revoked_at IS NULL
$$;

-- Accepting an invitation: the signed-in user's email must be the invited one.
CREATE FUNCTION portal_accept_invitation(p_token_hash text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE inv record; uemail text; r uuid;
BEGIN
  SELECT * INTO inv FROM patient_portal_invitations WHERE token_hash = p_token_hash FOR UPDATE;
  IF inv.id IS NULL OR inv.accepted_at IS NOT NULL OR inv.expires_at < now() THEN
    RAISE EXCEPTION 'This invitation is no longer valid' USING ERRCODE = 'P0001';
  END IF;
  SELECT email INTO uemail FROM users WHERE id = app_user_id();
  IF uemail IS NULL OR lower(uemail) <> lower(inv.email) THEN
    RAISE EXCEPTION 'This invitation was sent to another email address' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM memberships WHERE user_id = app_user_id() AND organization_id = inv.organization_id) THEN
    RAISE EXCEPTION 'Staff of this clinic cannot use their account as a patient account here' USING ERRCODE = 'P0001';
  END IF;
  UPDATE patient_accounts SET revoked_at = now() WHERE patient_id = inv.patient_id AND revoked_at IS NULL AND user_id <> app_user_id();
  INSERT INTO patient_accounts (user_id, patient_id, organization_id, invited_by)
  SELECT app_user_id(), inv.patient_id, inv.organization_id, inv.created_by
   WHERE NOT EXISTS (SELECT 1 FROM patient_accounts WHERE patient_id = inv.patient_id AND user_id = app_user_id() AND revoked_at IS NULL)
  RETURNING id INTO r;
  UPDATE patient_portal_invitations SET accepted_at = now(), accepted_by = app_user_id() WHERE id = inv.id;
  INSERT INTO audit_log (actor_user_id, organization_id, action, entity_type, entity_id) VALUES (app_user_id(), inv.organization_id, 'portal.accept', 'patient', inv.patient_id);
  RETURN inv.patient_id;
END $$;

CREATE FUNCTION portal_invitation_preview(p_token_hash text) RETURNS TABLE (clinic text, email text, valid boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT o.name, i.email, i.accepted_at IS NULL AND i.expires_at > now()
    FROM patient_portal_invitations i JOIN organizations o ON o.id = i.organization_id WHERE i.token_hash = p_token_hash
$$;

-- ---------- What a patient sees ----------
CREATE FUNCTION portal_records() RETURNS TABLE (patient_id uuid, organization_id uuid, clinic text, clinic_phone text, clinic_address text,
  full_name text, patient_number text, phone text, whatsapp_number text, email text, address text, preferred_language text, whatsapp_consent boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id, o.id, o.name, o.phone, o.address, p.full_name, p.patient_number, p.phone, p.whatsapp_number, p.email, p.address, p.preferred_language,
         (SELECT opted_in FROM patient_consents c WHERE c.patient_id = p.id AND c.channel = 'whatsapp')
    FROM patients p JOIN organizations o ON o.id = p.organization_id WHERE p.id IN (SELECT portal_patient_ids()) ORDER BY o.name
$$;

CREATE FUNCTION portal_appointments() RETURNS TABLE (id uuid, patient_id uuid, clinic text, starts_at timestamptz, ends_at timestamptz, status text,
  doctor_name text, specialty_code text, service_name text, location_name text, location_address text, can_cancel boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.id, a.patient_id, o.name, a.starts_at, a.ends_at, a.status, u.full_name, m.specialty_code, s.name, l.name, l.address,
         a.status IN ('scheduled','confirmed') AND a.starts_at > now() + interval '2 hours'
    FROM appointments a JOIN organizations o ON o.id = a.organization_id
    JOIN memberships m ON m.id = a.doctor_membership_id JOIN users u ON u.id = m.user_id
    LEFT JOIN services s ON s.id = a.service_id LEFT JOIN locations l ON l.id = a.location_id
   WHERE a.patient_id IN (SELECT portal_patient_ids()) AND NOT a.is_walk_in
   ORDER BY a.starts_at DESC LIMIT 200
$$;

-- Only prescriptions the clinic issued AND shared with the patient.
CREATE FUNCTION portal_prescriptions() RETURNS TABLE (id uuid, patient_id uuid, clinic text, doctor_name text, issued_at timestamptz, status text, items jsonb, notes text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.id, r.patient_id, o.name, u.full_name, r.issued_at, r.status,
         coalesce((SELECT jsonb_agg(jsonb_build_object('medication', i.medication_name, 'dosage', i.dosage, 'frequency', i.frequency,
                    'duration', i.duration, 'instructions', i.instructions) ORDER BY i.position) FROM prescription_items i WHERE i.prescription_id = r.id), '[]'::jsonb),
         r.notes
    FROM prescriptions r JOIN organizations o ON o.id = r.organization_id
    JOIN memberships m ON m.id = r.prescribed_by JOIN users u ON u.id = m.user_id
   WHERE r.patient_id IN (SELECT portal_patient_ids()) AND r.shared_with_patient AND r.status IN ('issued','cancelled')
   ORDER BY r.issued_at DESC
$$;

CREATE FUNCTION portal_documents() RETURNS TABLE (id uuid, patient_id uuid, clinic text, title text, kind text, mime_type text, size_bytes bigint, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT d.id, d.patient_id, o.name, d.title, d.kind, d.mime_type, d.size_bytes, d.created_at
    FROM medical_documents d JOIN organizations o ON o.id = d.organization_id
   WHERE d.patient_id IN (SELECT portal_patient_ids()) AND d.shared_with_patient AND d.deleted_at IS NULL
   ORDER BY d.created_at DESC
$$;

-- File of a shared document, and an audit entry for the patient's view or download.
CREATE FUNCTION portal_document_file(p_id uuid, p_download boolean) RETURNS TABLE (storage_key text, mime_type text, filename text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d record;
BEGIN
  SELECT * INTO d FROM medical_documents WHERE id = p_id AND shared_with_patient AND deleted_at IS NULL AND patient_id IN (SELECT portal_patient_ids());
  IF d.id IS NULL THEN RETURN; END IF;
  INSERT INTO audit_log (actor_user_id, organization_id, action, entity_type, entity_id)
  VALUES (app_user_id(), d.organization_id, CASE WHEN p_download THEN 'portal.document_download' ELSE 'portal.document_view' END, 'document', d.id);
  RETURN QUERY SELECT d.storage_key, d.mime_type, coalesce(d.original_filename, d.title, 'document');
END $$;

CREATE FUNCTION portal_doctors(p_patient uuid) RETURNS TABLE (membership_id uuid, full_name text, specialty_code text, linked boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.id, u.full_name, m.specialty_code, EXISTS (SELECT 1 FROM patient_memberships pm WHERE pm.patient_id = p.id AND pm.membership_id = m.id)
    FROM patients p JOIN memberships m ON m.organization_id = p.organization_id AND m.role_code = 'doctor' AND m.status = 'active'
    JOIN users u ON u.id = m.user_id
   WHERE p.id = p_patient AND p.id IN (SELECT portal_patient_ids()) ORDER BY 4 DESC, u.full_name
$$;

-- ---------- Appointment requests ----------
CREATE TABLE appointment_requests (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id),
  patient_id           uuid NOT NULL,
  doctor_membership_id uuid,
  preferred_date       date NOT NULL,
  preferred_time       text NOT NULL CHECK (preferred_time IN ('morning','afternoon','evening','any')),
  note                 text,
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','cancelled')),
  appointment_id       uuid REFERENCES appointments(id),
  answer_note          text,
  answered_by          uuid REFERENCES users(id),
  answered_at          timestamptz,
  requested_by         uuid NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (patient_id, organization_id) REFERENCES patients(id, organization_id),
  FOREIGN KEY (doctor_membership_id, organization_id) REFERENCES memberships(id, organization_id)
);
CREATE INDEX appointment_requests_org_idx ON appointment_requests (organization_id, status, created_at DESC);
GRANT SELECT ON appointment_requests TO medora_app;
GRANT UPDATE (status, appointment_id, answer_note, answered_by, answered_at) ON appointment_requests TO medora_app;
ALTER TABLE appointment_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY appt_requests_staff_read ON appointment_requests FOR SELECT USING (
  app_is_member(organization_id) AND app_has_perm('appointment.manage') AND app_can_see_patient(patient_id, organization_id)
  AND (app_is_org_wide() OR doctor_membership_id IS NULL OR app_acts_for(doctor_membership_id)));
CREATE POLICY appt_requests_staff_answer ON appointment_requests FOR UPDATE USING (
  app_is_member(organization_id) AND app_has_perm('appointment.manage') AND app_can_see_patient(patient_id, organization_id) AND status = 'pending')
  WITH CHECK (answered_by = app_user_id() AND status IN ('accepted','declined'));

CREATE FUNCTION portal_request_appointment(p_patient uuid, p_doctor uuid, p_date date, p_time text, p_note text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p record; r uuid;
BEGIN
  SELECT id, organization_id INTO p FROM patients WHERE id = p_patient AND id IN (SELECT portal_patient_ids());
  IF p.id IS NULL THEN RAISE EXCEPTION 'Patient record not found' USING ERRCODE = 'P0001'; END IF;
  IF p_doctor IS NOT NULL AND NOT EXISTS (SELECT 1 FROM memberships WHERE id = p_doctor AND organization_id = p.organization_id AND role_code = 'doctor' AND status = 'active') THEN
    RAISE EXCEPTION 'Choose a doctor of this clinic' USING ERRCODE = 'P0001';
  END IF;
  IF p_date < current_date OR p_date > current_date + 180 THEN RAISE EXCEPTION 'Choose a date within the next six months' USING ERRCODE = 'P0001'; END IF;
  IF (SELECT count(*) FROM appointment_requests WHERE patient_id = p.id AND status = 'pending') >= 3 THEN
    RAISE EXCEPTION 'You already have three requests waiting for an answer' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO appointment_requests (organization_id, patient_id, doctor_membership_id, preferred_date, preferred_time, note, requested_by)
  VALUES (p.organization_id, p.id, p_doctor, p_date, p_time, nullif(trim(p_note), ''), app_user_id()) RETURNING id INTO r;
  -- Tell the people who book for that doctor (or the front desk).
  INSERT INTO notifications (user_id, kind, payload)
  SELECT DISTINCT m.user_id, 'appointment_request', jsonb_build_object('organization_id', p.organization_id, 'request_id', r)
    FROM memberships m JOIN membership_permissions mp ON mp.membership_id = m.id AND mp.permission_code = 'appointment.manage'
   WHERE m.organization_id = p.organization_id AND m.status = 'active'
     AND (m.role_code IN ('center_owner','center_admin','receptionist')
          OR (p_doctor IS NOT NULL AND (m.id = p_doctor OR m.id IN (SELECT assistant_membership_id FROM assistant_assignments WHERE doctor_membership_id = p_doctor)))
          OR (p_doctor IS NULL AND m.role_code IN ('doctor','assistant') AND (SELECT kind FROM organizations WHERE id = p.organization_id) = 'independent_practice'));
  INSERT INTO audit_log (actor_user_id, organization_id, action, entity_type, entity_id) VALUES (app_user_id(), p.organization_id, 'portal.request', 'appointment_request', r);
  RETURN r;
END $$;

CREATE FUNCTION portal_requests() RETURNS TABLE (id uuid, patient_id uuid, clinic text, doctor_name text, preferred_date date, preferred_time text, note text,
  status text, answer_note text, appointment_starts_at timestamptz, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.id, r.patient_id, o.name, u.full_name, r.preferred_date, r.preferred_time, r.note, r.status, r.answer_note, a.starts_at, r.created_at
    FROM appointment_requests r JOIN organizations o ON o.id = r.organization_id
    LEFT JOIN memberships m ON m.id = r.doctor_membership_id LEFT JOIN users u ON u.id = m.user_id
    LEFT JOIN appointments a ON a.id = r.appointment_id
   WHERE r.patient_id IN (SELECT portal_patient_ids()) ORDER BY r.created_at DESC LIMIT 50
$$;

CREATE FUNCTION portal_cancel_request(p_id uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE appointment_requests SET status = 'cancelled' WHERE id = p_id AND status = 'pending' AND patient_id IN (SELECT portal_patient_ids()) RETURNING true
$$;

-- A patient may cancel a booked visit up to 2 hours before it. Staff are notified; the slot frees up.
CREATE FUNCTION portal_cancel_appointment(p_id uuid, p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE a record;
BEGIN
  SELECT * INTO a FROM appointments WHERE id = p_id AND patient_id IN (SELECT portal_patient_ids()) FOR UPDATE;
  IF a.id IS NULL THEN RETURN false; END IF;
  IF a.status NOT IN ('scheduled','confirmed') OR a.starts_at <= now() + interval '2 hours' THEN
    RAISE EXCEPTION 'This appointment can no longer be cancelled online. Please call the clinic.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE appointments SET status = 'cancelled', cancelled_reason = 'Cancelled by the patient' || coalesce(': ' || nullif(trim(p_reason), ''), '') WHERE id = a.id;
  UPDATE scheduled_messages SET status = 'cancelled', reason = 'appointment_changed' WHERE appointment_id = a.id AND status = 'pending';
  INSERT INTO notifications (user_id, kind, payload)
  SELECT DISTINCT m.user_id, 'appointment_cancelled_by_patient', jsonb_build_object('organization_id', a.organization_id, 'appointment_id', a.id)
    FROM memberships m WHERE m.organization_id = a.organization_id AND m.status = 'active'
     AND (m.id = a.doctor_membership_id OR m.id IN (SELECT assistant_membership_id FROM assistant_assignments WHERE doctor_membership_id = a.doctor_membership_id)
          OR m.role_code IN ('center_owner','center_admin','receptionist'));
  INSERT INTO audit_log (actor_user_id, organization_id, action, entity_type, entity_id) VALUES (app_user_id(), a.organization_id, 'portal.cancel', 'appointment', a.id);
  RETURN true;
END $$;

-- The patient keeps their own contact details, language and WhatsApp consent up to date.
CREATE FUNCTION portal_update_profile(p_patient uuid, p_phone text, p_whatsapp text, p_email text, p_address text, p_language text, p_whatsapp_consent boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p record;
BEGIN
  SELECT id, organization_id INTO p FROM patients WHERE id = p_patient AND id IN (SELECT portal_patient_ids());
  IF p.id IS NULL THEN RETURN false; END IF;
  UPDATE patients SET phone = coalesce(nullif(trim(p_phone), ''), phone), whatsapp_number = nullif(trim(p_whatsapp), ''),
         email = nullif(trim(p_email), ''), address = nullif(trim(p_address), ''), preferred_language = coalesce(p_language, preferred_language)
   WHERE id = p.id;
  IF p_whatsapp_consent IS NOT NULL THEN
    INSERT INTO patient_consents (patient_id, organization_id, channel, opted_in, source, recorded_by)
    VALUES (p.id, p.organization_id, 'whatsapp', p_whatsapp_consent, 'patient_portal', app_user_id())
    ON CONFLICT (patient_id, channel) DO UPDATE SET opted_in = EXCLUDED.opted_in, source = 'patient_portal', recorded_by = EXCLUDED.recorded_by, recorded_at = now()
      WHERE patient_consents.opted_in IS DISTINCT FROM EXCLUDED.opted_in;
    IF NOT p_whatsapp_consent THEN UPDATE scheduled_messages SET status = 'cancelled', reason = 'opted_out' WHERE patient_id = p.id AND status = 'pending'; END IF;
  END IF;
  INSERT INTO audit_log (actor_user_id, organization_id, action, entity_type, entity_id) VALUES (app_user_id(), p.organization_id, 'portal.profile', 'patient', p.id);
  RETURN true;
END $$;
ALTER TABLE patient_consents DROP CONSTRAINT patient_consents_source_check,
  ADD CONSTRAINT patient_consents_source_check CHECK (source IN ('staff','patient_reply','patient_portal','import'));

-- Answering a request tells the patient (notification, and push if they installed the app).
CREATE FUNCTION appointment_request_answered() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status IN ('accepted','declined') AND OLD.status = 'pending' THEN
    INSERT INTO notifications (user_id, kind, payload)
    VALUES (NEW.requested_by, 'appointment_request_' || NEW.status, jsonb_build_object('request_id', NEW.id, 'appointment_id', NEW.appointment_id));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER appointment_requests_answered AFTER UPDATE OF status ON appointment_requests FOR EACH ROW EXECUTE FUNCTION appointment_request_answered();

REVOKE EXECUTE ON FUNCTION push_targets(uuid), push_result(uuid, boolean, boolean), push_claim(uuid) FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO medora_app;
