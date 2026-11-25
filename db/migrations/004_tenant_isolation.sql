-- MEDORA CLINICS: migration 004, tenant isolation with row-level security (blueprint section 17).
--
-- The API connects as role medora_app: not the table owner, no BYPASSRLS, so every policy applies.
-- Each API transaction runs:  SELECT set_config('app.user_id', $1, true), set_config('app.org_id', $2, true)
-- A forged app.org_id gives nothing: every check also requires an active membership of app.user_id.

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'medora_app') THEN
    CREATE ROLE medora_app NOLOGIN;   -- the setup script enables LOGIN with a password from the environment
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO medora_app;

-- ---------- Context helpers ----------
CREATE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
CREATE FUNCTION app_org_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;

-- These run as owner so they can read memberships without recursing into memberships' own policy.
CREATE FUNCTION app_is_member(org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT org IS NOT NULL AND org = app_org_id() AND EXISTS (
    SELECT 1 FROM memberships m JOIN organizations o ON o.id = m.organization_id
     WHERE m.user_id = app_user_id() AND m.organization_id = org
       AND m.status = 'active' AND o.status = 'active')
$$;

CREATE FUNCTION app_has_perm(perm text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT app_is_member(app_org_id()) AND EXISTS (
    SELECT 1 FROM memberships m JOIN membership_permissions mp ON mp.membership_id = m.id
     WHERE m.user_id = app_user_id() AND m.organization_id = app_org_id()
       AND m.status = 'active' AND mp.permission_code = perm)
$$;

-- Roles that work across all doctors of the organization (front desk, management, finance).
CREATE FUNCTION app_is_org_wide() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT app_is_member(app_org_id()) AND EXISTS (
    SELECT 1 FROM memberships m
     WHERE m.user_id = app_user_id() AND m.organization_id = app_org_id() AND m.status = 'active'
       AND m.role_code IN ('center_owner','center_admin','receptionist','accountant','insurance_admin'))
$$;

-- Doctor memberships the current user acts for: their own, plus doctors they assist.
CREATE FUNCTION app_acting_doctors() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.id FROM memberships m
   WHERE app_is_member(app_org_id()) AND m.user_id = app_user_id()
     AND m.organization_id = app_org_id() AND m.role_code = 'doctor' AND m.status = 'active'
  UNION
  SELECT aa.doctor_membership_id FROM assistant_assignments aa
    JOIN memberships a ON a.id = aa.assistant_membership_id
   WHERE app_is_member(app_org_id()) AND a.user_id = app_user_id()
     AND a.organization_id = app_org_id() AND a.status = 'active'
$$;

CREATE FUNCTION app_acts_for(doctor_membership uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT doctor_membership IN (SELECT app_acting_doctors()) $$;

-- Patient demographics: org-wide staff, or a doctor (or their assistant) the patient is linked to.
CREATE FUNCTION app_can_see_patient(pid uuid, org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT app_is_member(org) AND (app_is_org_wide() OR EXISTS (
    SELECT 1 FROM patient_memberships pm WHERE pm.patient_id = pid AND pm.membership_id IN (SELECT app_acting_doctors())))
$$;

-- Confidential clinical rows (consultations, diagnoses, prescriptions):
-- needs clinical_notes.read AND (treating doctor or their assistant, or a linked doctor, or org-wide staff).
CREATE FUNCTION app_can_read_clinical(pid uuid, doctor_membership uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT app_has_perm('clinical_notes.read') AND (
       app_acts_for(doctor_membership)
    OR app_is_org_wide()
    OR EXISTS (SELECT 1 FROM patient_memberships pm
                WHERE pm.patient_id = pid AND pm.membership_id IN (SELECT app_acting_doctors())))
$$;

-- Who may link a patient to a doctor: the target must be a doctor of the patient's organization that the
-- caller acts for (or the caller is org-wide front desk/management with patient.register), and the caller
-- must already see the patient, or have just registered it (no links yet). Linking an unseen patient
-- to yourself to gain access is therefore impossible.
CREATE FUNCTION app_can_link_patient(pid uuid, doctor_membership uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM patients p JOIN memberships m ON m.id = doctor_membership AND m.organization_id = p.organization_id
     WHERE p.id = pid AND app_is_member(p.organization_id) AND m.role_code = 'doctor' AND m.status = 'active'
       AND app_has_perm('patient.register')
       AND (app_acts_for(doctor_membership) OR app_is_org_wide())
       AND (app_can_see_patient(pid, p.organization_id)
            OR (p.created_by = app_user_id() AND NOT EXISTS (SELECT 1 FROM patient_memberships x WHERE x.patient_id = pid))))
$$;

CREATE FUNCTION app_is_platform_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM users WHERE id = app_user_id() AND is_platform_admin AND status = 'active')
$$;

-- ---------- Pre-authentication functions (no user context yet) ----------
CREATE FUNCTION auth_find_user(p_email text)
RETURNS TABLE (id uuid, password_hash text, status text, mfa_enabled boolean, mfa_secret_enc text,
               failed_logins int, locked_until timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id, password_hash, status, mfa_enabled, mfa_secret_enc, failed_logins, locked_until
    FROM users WHERE lower(email) = lower(p_email)
$$;

CREATE FUNCTION auth_record_login(p_user uuid, p_ok boolean) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE users SET
    failed_logins = CASE WHEN p_ok THEN 0 ELSE failed_logins + 1 END,
    locked_until  = CASE WHEN NOT p_ok AND failed_logins + 1 >= 5 THEN now() + interval '15 minutes'
                         WHEN p_ok THEN NULL ELSE locked_until END
  WHERE id = p_user
$$;

CREATE FUNCTION auth_find_session(p_token_hash text)
RETURNS TABLE (session_id uuid, user_id uuid, mfa_pending boolean, user_status text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE sessions s SET last_seen_at = now()
    FROM users u
   WHERE s.token_hash = p_token_hash AND u.id = s.user_id
     AND s.revoked_at IS NULL AND s.expires_at > now()
  RETURNING s.id, s.user_id, s.mfa_pending, u.status
$$;

CREATE FUNCTION auth_create_session(p_user uuid, p_token_hash text, p_mfa_pending boolean,
                                    p_ua text, p_ip text, p_ttl interval) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO sessions (user_id, token_hash, mfa_pending, user_agent, ip, expires_at)
  VALUES (p_user, p_token_hash, p_mfa_pending, p_ua, p_ip, now() + p_ttl) RETURNING id
$$;

CREATE FUNCTION auth_create_password_reset(p_email text, p_token_hash text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE uid uuid;
BEGIN
  SELECT id INTO uid FROM users WHERE lower(email) = lower(p_email) AND status = 'active';
  IF uid IS NULL THEN RETURN NULL; END IF;
  INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (uid, p_token_hash, now() + interval '30 minutes');
  INSERT INTO outbound_emails (to_email, purpose, subject, body)
  VALUES (p_email, 'password_reset', 'Reset your MEDORA CLINICS password',
          'A password reset was requested for your account. The link is valid for 30 minutes.');
  RETURN uid;
END $$;

CREATE FUNCTION auth_use_password_reset(p_token_hash text, p_new_hash text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE uid uuid;
BEGIN
  UPDATE password_resets SET used_at = now()
   WHERE token_hash = p_token_hash AND used_at IS NULL AND expires_at > now()
  RETURNING user_id INTO uid;
  IF uid IS NULL THEN RETURN NULL; END IF;
  UPDATE users SET password_hash = p_new_hash, failed_logins = 0, locked_until = NULL WHERE id = uid;
  UPDATE sessions SET revoked_at = now() WHERE user_id = uid AND revoked_at IS NULL;
  INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id) VALUES (uid, 'auth.password_reset', 'user', uid);
  RETURN uid;
END $$;

-- Create an organization and make the current user its first member (registration, or a doctor
-- opening an extra independent practice). Copies role default permissions.
CREATE FUNCTION app_create_organization(p_org uuid, p_kind text, p_name text, p_role text,
                                        p_specialty text, p_license text, p_fee numeric) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE uid uuid := app_user_id(); mid uuid := gen_random_uuid();
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF p_kind = 'independent_practice' AND p_role <> 'doctor' THEN
    RAISE EXCEPTION 'an independent practice is owned by a doctor';
  END IF;
  IF p_kind = 'medical_center' AND p_role NOT IN ('center_owner','doctor') THEN
    RAISE EXCEPTION 'a medical center is created by its owner';
  END IF;
  INSERT INTO organizations (id, kind, name, created_by) VALUES (p_org, p_kind, p_name, uid);
  INSERT INTO memberships (id, user_id, organization_id, role_code, specialty_code, license_number, consultation_fee)
  VALUES (mid, uid, p_org, p_role, p_specialty, p_license, p_fee);
  INSERT INTO membership_permissions (membership_id, permission_code, granted_by)
  SELECT mid, permission_code, uid FROM role_default_permissions WHERE role_code = p_role;
  IF p_kind = 'independent_practice' THEN   -- the practice owner also runs the workspace
    INSERT INTO membership_permissions (membership_id, permission_code, granted_by)
    VALUES (mid, 'org.manage', uid), (mid, 'staff.manage', uid) ON CONFLICT DO NOTHING;
  END IF;
  INSERT INTO invoice_counters (organization_id) VALUES (p_org);
  INSERT INTO audit_log (actor_user_id, organization_id, action, entity_type, entity_id, details)
  VALUES (uid, p_org, 'organization.create', 'organization', p_org, jsonb_build_object('kind', p_kind, 'role', p_role));
  RETURN mid;
END $$;

-- Accept an invitation as the signed-in user. The email must match the invited address.
CREATE FUNCTION app_accept_invitation(p_token_hash text) RETURNS TABLE (organization_id uuid, membership_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE inv invitations; uid uuid := app_user_id(); mid uuid;
BEGIN
  SELECT * INTO inv FROM invitations i WHERE i.token_hash = p_token_hash
     AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now();
  IF inv.id IS NULL THEN RAISE EXCEPTION 'invitation not found or expired'; END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = uid AND lower(email) = lower(inv.email)) THEN
    RAISE EXCEPTION 'invitation was sent to a different email address';
  END IF;
  SELECT id INTO mid FROM memberships m
   WHERE m.user_id = uid AND m.organization_id = inv.organization_id AND m.role_code = inv.role_code;
  IF mid IS NULL THEN
    mid := gen_random_uuid();
    INSERT INTO memberships (id, user_id, organization_id, role_code, specialty_code, department_id, consultation_fee)
    VALUES (mid, uid, inv.organization_id, inv.role_code, inv.specialty_code, inv.department_id, inv.consultation_fee);
    INSERT INTO membership_permissions (membership_id, permission_code, granted_by)
    SELECT mid, permission_code, inv.invited_by FROM role_default_permissions WHERE role_code = inv.role_code;
  ELSE
    UPDATE memberships SET status = 'active' WHERE id = mid;
  END IF;
  IF inv.assign_to_doctor_membership_id IS NOT NULL THEN
    INSERT INTO assistant_assignments VALUES (mid, inv.assign_to_doctor_membership_id) ON CONFLICT DO NOTHING;
  END IF;
  UPDATE invitations SET accepted_at = now(), accepted_user_id = uid WHERE id = inv.id;
  INSERT INTO audit_log (actor_user_id, organization_id, action, entity_type, entity_id, details)
  VALUES (uid, inv.organization_id, 'invitation.accept', 'membership', mid, jsonb_build_object('role', inv.role_code));
  RETURN QUERY SELECT inv.organization_id, mid;
END $$;

-- Duplicate detection across the whole organization, even for patients the caller can't open.
-- Returns only an id, a masked name and how it matched, so nothing confidential leaks.
CREATE FUNCTION app_find_duplicate_patients(p_name text, p_phone text, p_dob date)
RETURNS TABLE (patient_id uuid, masked_name text, match text, visible boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id,
         left(p.full_name, 1) || repeat('*', greatest(length(p.full_name) - 2, 1)) || right(p.full_name, 1),
         CASE WHEN p_phone IS NOT NULL AND regexp_replace(p.phone, '\D', '', 'g') = regexp_replace(p_phone, '\D', '', 'g') THEN 'phone'
              WHEN p_dob IS NOT NULL AND p.date_of_birth = p_dob THEN 'name_and_birth_date'
              ELSE 'similar_name' END,
         app_can_see_patient(p.id, p.organization_id)
    FROM patients p
   WHERE app_has_perm('patient.register') AND p.organization_id = app_org_id() AND p.archived_at IS NULL
     AND ( (p_phone IS NOT NULL AND length(regexp_replace(p_phone, '\D', '', 'g')) >= 6
            AND regexp_replace(p.phone, '\D', '', 'g') = regexp_replace(p_phone, '\D', '', 'g'))
        OR (similarity(lower(p.full_name), lower(p_name)) > 0.55
            AND (p_dob IS NULL OR p.date_of_birth IS NULL OR p.date_of_birth = p_dob)) )
   LIMIT 10
$$;

-- ---------- Grants ----------
GRANT SELECT ON specialties, roles, permissions, role_default_permissions, payment_methods, plans, medications TO medora_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO medora_app;
REVOKE INSERT, UPDATE, DELETE ON specialties, roles, permissions, role_default_permissions, payment_methods, plans FROM medora_app;
REVOKE ALL ON patient_counters, invoice_counters, password_resets FROM medora_app;
REVOKE UPDATE, DELETE ON audit_log FROM medora_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO medora_app;
-- Secrets never leave the database through ordinary queries.
REVOKE SELECT, UPDATE ON users FROM medora_app;
GRANT SELECT (id, email, full_name, phone, is_platform_admin, created_at, interface_language, status, mfa_enabled, theme) ON users TO medora_app;
GRANT UPDATE (full_name, phone, interface_language, theme, password_hash, mfa_enabled, mfa_secret_enc) ON users TO medora_app;
REVOKE INSERT ON users FROM medora_app;
GRANT INSERT (id, email, password_hash, full_name, phone, interface_language) ON users TO medora_app;
REVOKE SELECT ON sessions FROM medora_app;
GRANT SELECT (id, user_id, mfa_pending, user_agent, ip, created_at, last_seen_at, expires_at, revoked_at) ON sessions TO medora_app;

-- ---------- Enable RLS everywhere tenant data lives ----------
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','sessions','organizations','locations','rooms','departments','memberships','assistant_assignments',
    'membership_permissions','invitations','patients','patient_memberships','patient_specialty_profiles',
    'appointments','consultations','prescriptions','prescription_items','diagnoses','medical_documents',
    'clinical_templates','template_versions','services','working_hours','availability_exceptions',
    'exchange_rates','invoices','invoice_items','payments','expenses','commission_rules',
    'insurance_providers','insurance_policies','claims','claim_documents',
    'whatsapp_accounts','message_templates','automation_settings','patient_consents',
    'whatsapp_conversations','whatsapp_messages','notifications','subscriptions','audit_log','outbound_emails']
  LOOP EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t); END LOOP;
END $$;

-- ---------- Identity ----------
CREATE POLICY users_self_or_colleague ON users FOR SELECT USING (
  id = app_user_id() OR app_is_platform_admin()
  OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id AND m.organization_id = app_org_id()));
CREATE POLICY users_self_insert ON users FOR INSERT WITH CHECK (id = app_user_id());
CREATE POLICY users_self_update ON users FOR UPDATE USING (id = app_user_id()) WITH CHECK (id = app_user_id());

CREATE POLICY sessions_own ON sessions FOR SELECT USING (user_id = app_user_id());
CREATE POLICY sessions_own_revoke ON sessions FOR UPDATE USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
CREATE POLICY sessions_own_complete_mfa ON sessions FOR DELETE USING (user_id = app_user_id());

CREATE POLICY notifications_own ON notifications FOR ALL USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());

-- ---------- Organization structure ----------
-- Users see orgs they belong to (workspace switcher) even when another org is active.
CREATE POLICY orgs_member ON organizations FOR SELECT USING (
  app_is_platform_admin()
  OR EXISTS (SELECT 1 FROM memberships m WHERE m.organization_id = organizations.id AND m.user_id = app_user_id()));
CREATE POLICY orgs_manage ON organizations FOR UPDATE USING (app_is_member(id) AND app_has_perm('org.manage'))
  WITH CHECK (app_is_member(id));

CREATE POLICY memberships_read ON memberships FOR SELECT USING (user_id = app_user_id() OR app_is_member(organization_id));
CREATE POLICY memberships_manage ON memberships FOR UPDATE USING (app_is_member(organization_id) AND app_has_perm('staff.manage'))
  WITH CHECK (app_is_member(organization_id));

CREATE POLICY membership_permissions_read ON membership_permissions FOR SELECT USING (
  EXISTS (SELECT 1 FROM memberships m WHERE m.id = membership_id AND (m.user_id = app_user_id() OR app_is_member(m.organization_id))));
CREATE POLICY membership_permissions_write ON membership_permissions FOR ALL USING (
  app_has_perm('permission.manage') AND EXISTS (SELECT 1 FROM memberships m WHERE m.id = membership_id AND app_is_member(m.organization_id)))
  WITH CHECK (app_has_perm('permission.manage') AND EXISTS (SELECT 1 FROM memberships m WHERE m.id = membership_id AND app_is_member(m.organization_id)));

CREATE POLICY assistant_assignments_read ON assistant_assignments FOR SELECT USING (
  EXISTS (SELECT 1 FROM memberships m WHERE m.id = doctor_membership_id AND app_is_member(m.organization_id)));
CREATE POLICY assistant_assignments_write ON assistant_assignments FOR ALL USING (
  app_has_perm('staff.manage') AND EXISTS (SELECT 1 FROM memberships m WHERE m.id = doctor_membership_id AND app_is_member(m.organization_id)))
  WITH CHECK (app_has_perm('staff.manage')
    AND EXISTS (SELECT 1 FROM memberships d JOIN memberships a ON a.organization_id = d.organization_id
                 WHERE d.id = doctor_membership_id AND a.id = assistant_membership_id
                   AND d.role_code = 'doctor' AND app_is_member(d.organization_id)));

CREATE POLICY invitations_rw ON invitations FOR ALL USING (app_is_member(organization_id) AND app_has_perm('staff.manage'))
  WITH CHECK (app_is_member(organization_id) AND app_has_perm('staff.manage') AND invited_by = app_user_id());

CREATE POLICY locations_read ON locations FOR SELECT USING (app_is_member(organization_id));
CREATE POLICY locations_write ON locations FOR ALL USING (app_is_member(organization_id) AND app_has_perm('org.manage'))
  WITH CHECK (app_is_member(organization_id) AND app_has_perm('org.manage'));
CREATE POLICY departments_read ON departments FOR SELECT USING (app_is_member(organization_id));
CREATE POLICY departments_write ON departments FOR ALL USING (app_is_member(organization_id) AND app_has_perm('org.manage'))
  WITH CHECK (app_is_member(organization_id) AND app_has_perm('org.manage'));
CREATE POLICY rooms_read ON rooms FOR SELECT USING (EXISTS (SELECT 1 FROM locations l WHERE l.id = location_id));
CREATE POLICY rooms_write ON rooms FOR ALL USING (app_has_perm('org.manage') AND EXISTS (SELECT 1 FROM locations l WHERE l.id = location_id))
  WITH CHECK (app_has_perm('org.manage') AND EXISTS (SELECT 1 FROM locations l WHERE l.id = location_id));

CREATE POLICY services_read ON services FOR SELECT USING (app_is_member(organization_id));
CREATE POLICY services_write ON services FOR ALL USING (app_is_member(organization_id) AND (app_has_perm('org.manage') OR app_acts_for(membership_id)))
  WITH CHECK (app_is_member(organization_id) AND (app_has_perm('org.manage') OR app_acts_for(membership_id)));

CREATE POLICY working_hours_read ON working_hours FOR SELECT USING (EXISTS (SELECT 1 FROM memberships m WHERE m.id = membership_id AND app_is_member(m.organization_id)));
CREATE POLICY working_hours_write ON working_hours FOR ALL USING (app_acts_for(membership_id) OR app_has_perm('staff.manage') AND EXISTS (SELECT 1 FROM memberships m WHERE m.id = membership_id AND app_is_member(m.organization_id)))
  WITH CHECK (app_acts_for(membership_id) OR app_has_perm('staff.manage') AND EXISTS (SELECT 1 FROM memberships m WHERE m.id = membership_id AND app_is_member(m.organization_id)));
CREATE POLICY exceptions_read ON availability_exceptions FOR SELECT USING (EXISTS (SELECT 1 FROM memberships m WHERE m.id = membership_id AND app_is_member(m.organization_id)));
CREATE POLICY exceptions_write ON availability_exceptions FOR ALL USING (app_acts_for(membership_id) OR app_has_perm('staff.manage') AND EXISTS (SELECT 1 FROM memberships m WHERE m.id = membership_id AND app_is_member(m.organization_id)))
  WITH CHECK (app_acts_for(membership_id) OR app_has_perm('staff.manage') AND EXISTS (SELECT 1 FROM memberships m WHERE m.id = membership_id AND app_is_member(m.organization_id)));

-- ---------- Patients ----------
CREATE POLICY patients_read ON patients FOR SELECT USING (app_can_see_patient(id, organization_id));
CREATE POLICY patients_insert ON patients FOR INSERT WITH CHECK (app_is_member(organization_id) AND app_has_perm('patient.register'));
CREATE POLICY patients_update ON patients FOR UPDATE USING (app_can_see_patient(id, organization_id) AND app_has_perm('patient.register'))
  WITH CHECK (app_is_member(organization_id));

CREATE POLICY patient_links_read ON patient_memberships FOR SELECT USING (EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_id));
-- Linking: a patient can be linked to a doctor of the same org by org-wide staff with staff.manage,
-- or by whoever registered/sees the patient for the doctors they act for.
CREATE POLICY patient_links_write ON patient_memberships FOR INSERT WITH CHECK (app_can_link_patient(patient_id, membership_id));
CREATE POLICY patient_links_delete ON patient_memberships FOR DELETE USING (app_is_org_wide() AND app_has_perm('staff.manage')
  AND EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_id));

CREATE POLICY specialty_profiles_read ON patient_specialty_profiles FOR SELECT USING (
  app_can_see_patient(patient_id, organization_id) AND app_has_perm('patient.history.read'));
CREATE POLICY specialty_profiles_write ON patient_specialty_profiles FOR ALL USING (
  app_can_see_patient(patient_id, organization_id) AND app_has_perm('patient.history.read'))
  WITH CHECK (app_can_see_patient(patient_id, organization_id) AND app_has_perm('patient.history.read'));

CREATE POLICY documents_rw ON medical_documents FOR ALL USING (EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_id))
  WITH CHECK (app_has_perm('document.upload') AND EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_id));
CREATE POLICY consents_rw ON patient_consents FOR ALL USING (EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_id))
  WITH CHECK (EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_id));
CREATE POLICY policies_rw ON insurance_policies FOR ALL USING (EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_id))
  WITH CHECK (EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_id));

-- ---------- Scheduling ----------
CREATE POLICY appointments_read ON appointments FOR SELECT USING (
  app_is_member(organization_id) AND (app_is_org_wide() OR app_acts_for(doctor_membership_id)));
CREATE POLICY appointments_insert ON appointments FOR INSERT WITH CHECK (
  app_is_member(organization_id) AND app_has_perm('appointment.manage')
  AND (app_is_org_wide() OR app_acts_for(doctor_membership_id))
  AND app_can_see_patient(patient_id, organization_id));
CREATE POLICY appointments_update ON appointments FOR UPDATE USING (
  app_is_member(organization_id) AND app_has_perm('appointment.manage') AND (app_is_org_wide() OR app_acts_for(doctor_membership_id)))
  WITH CHECK (app_is_member(organization_id) AND (app_is_org_wide() OR app_acts_for(doctor_membership_id)));

-- ---------- Clinical (confidential) ----------
CREATE POLICY consultations_read ON consultations FOR SELECT USING (
  EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_id) AND app_can_read_clinical(patient_id, doctor_membership_id));
CREATE POLICY consultations_write ON consultations FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_id)
  AND doctor_membership_id IN (SELECT m.id FROM memberships m WHERE m.user_id = app_user_id() AND m.role_code = 'doctor'));
CREATE POLICY consultations_update ON consultations FOR UPDATE USING (
  doctor_membership_id IN (SELECT m.id FROM memberships m WHERE m.user_id = app_user_id() AND m.role_code = 'doctor'))
  WITH CHECK (EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_id));
CREATE POLICY diagnoses_read ON diagnoses FOR SELECT USING (EXISTS (SELECT 1 FROM consultations c WHERE c.id = consultation_id));
CREATE POLICY diagnoses_write ON diagnoses FOR ALL USING (EXISTS (SELECT 1 FROM consultations c WHERE c.id = consultation_id
  AND c.doctor_membership_id IN (SELECT m.id FROM memberships m WHERE m.user_id = app_user_id())))
  WITH CHECK (EXISTS (SELECT 1 FROM consultations c WHERE c.id = consultation_id
  AND c.doctor_membership_id IN (SELECT m.id FROM memberships m WHERE m.user_id = app_user_id())));
CREATE POLICY prescriptions_read ON prescriptions FOR SELECT USING (
  EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_id) AND app_has_perm('prescription.view')
  AND (app_acts_for(prescribed_by) OR app_can_read_clinical(patient_id, prescribed_by)));
CREATE POLICY prescriptions_write ON prescriptions FOR INSERT WITH CHECK (
  app_has_perm('prescription.create') AND EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_id)
  AND prescribed_by IN (SELECT m.id FROM memberships m WHERE m.user_id = app_user_id() AND m.organization_id = app_org_id()));
CREATE POLICY prescriptions_update ON prescriptions FOR UPDATE USING (
  prescribed_by IN (SELECT m.id FROM memberships m WHERE m.user_id = app_user_id()))
  WITH CHECK (app_has_perm('prescription.create'));
CREATE POLICY prescription_items_rw ON prescription_items FOR ALL USING (EXISTS (SELECT 1 FROM prescriptions r WHERE r.id = prescription_id))
  WITH CHECK (EXISTS (SELECT 1 FROM prescriptions r WHERE r.id = prescription_id
    AND r.prescribed_by IN (SELECT m.id FROM memberships m WHERE m.user_id = app_user_id())));

-- ---------- Specialty templates ----------
-- Platform presets (owner NULL) are readable by everyone signed in; doctor templates by their workspace.
CREATE POLICY templates_read ON clinical_templates FOR SELECT USING (
  app_user_id() IS NOT NULL AND (owner_membership_id IS NULL
   OR EXISTS (SELECT 1 FROM memberships m WHERE m.id = owner_membership_id AND (m.user_id = app_user_id() OR app_is_member(m.organization_id)))));
CREATE POLICY templates_write ON clinical_templates FOR ALL USING (
  app_has_perm('template.manage') AND owner_membership_id IN (SELECT m.id FROM memberships m WHERE m.user_id = app_user_id()))
  WITH CHECK (app_has_perm('template.manage') AND owner_membership_id IN (SELECT m.id FROM memberships m WHERE m.user_id = app_user_id()));
CREATE POLICY template_versions_read ON template_versions FOR SELECT USING (EXISTS (SELECT 1 FROM clinical_templates t WHERE t.id = template_id));
CREATE POLICY template_versions_write ON template_versions FOR ALL USING (EXISTS (SELECT 1 FROM clinical_templates t WHERE t.id = template_id
    AND t.owner_membership_id IN (SELECT m.id FROM memberships m WHERE m.user_id = app_user_id())))
  WITH CHECK (app_has_perm('template.manage') AND EXISTS (SELECT 1 FROM clinical_templates t WHERE t.id = template_id
    AND t.owner_membership_id IN (SELECT m.id FROM memberships m WHERE m.user_id = app_user_id())));

-- ---------- Finance and insurance ----------
CREATE POLICY rates_read ON exchange_rates FOR SELECT USING (app_is_member(organization_id));
CREATE POLICY rates_write ON exchange_rates FOR INSERT WITH CHECK (app_is_member(organization_id) AND app_has_perm('finance.view') AND app_has_perm('org.manage'));
CREATE POLICY invoices_read ON invoices FOR SELECT USING (app_is_member(organization_id)
  AND (app_has_perm('finance.view') OR app_has_perm('payment.register')) AND (app_is_org_wide() OR app_acts_for(doctor_membership_id)));
CREATE POLICY invoices_write ON invoices FOR INSERT WITH CHECK (app_is_member(organization_id) AND app_has_perm('payment.register')
  AND app_can_see_patient(patient_id, organization_id));
CREATE POLICY invoice_items_rw ON invoice_items FOR ALL USING (EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_id))
  WITH CHECK (EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_id) AND app_has_perm('payment.register'));
CREATE POLICY payments_read ON payments FOR SELECT USING (EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_id));
CREATE POLICY payments_write ON payments FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_id)
  AND app_has_perm('payment.register') AND received_by = app_user_id());
CREATE POLICY expenses_rw ON expenses FOR ALL USING (app_is_member(organization_id) AND app_has_perm('finance.view'))
  WITH CHECK (app_is_member(organization_id) AND app_has_perm('finance.view'));
CREATE POLICY commissions_rw ON commission_rules FOR ALL USING (EXISTS (SELECT 1 FROM memberships m WHERE m.id = membership_id AND app_is_member(m.organization_id)) AND app_has_perm('finance.view'))
  WITH CHECK (EXISTS (SELECT 1 FROM memberships m WHERE m.id = membership_id AND app_is_member(m.organization_id)) AND app_has_perm('org.manage'));
CREATE POLICY providers_read ON insurance_providers FOR SELECT USING (organization_id IS NULL OR app_is_member(organization_id));
CREATE POLICY providers_write ON insurance_providers FOR ALL USING (app_is_member(organization_id) AND app_has_perm('insurance.manage'))
  WITH CHECK (app_is_member(organization_id) AND app_has_perm('insurance.manage'));
CREATE POLICY claims_rw ON claims FOR ALL USING (EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_id) AND app_has_perm('insurance.manage'))
  WITH CHECK (EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_id) AND app_has_perm('insurance.manage'));
CREATE POLICY claim_documents_rw ON claim_documents FOR ALL USING (EXISTS (SELECT 1 FROM claims c WHERE c.id = claim_id))
  WITH CHECK (EXISTS (SELECT 1 FROM claims c WHERE c.id = claim_id));

-- ---------- Communication ----------
CREATE POLICY wa_accounts_rw ON whatsapp_accounts FOR ALL USING (app_is_member(organization_id) AND app_has_perm('whatsapp.send'))
  WITH CHECK (app_is_member(organization_id) AND app_has_perm('org.manage'));
CREATE POLICY msg_templates_read ON message_templates FOR SELECT USING (organization_id IS NULL OR app_is_member(organization_id));
CREATE POLICY msg_templates_write ON message_templates FOR ALL USING (app_is_member(organization_id) AND app_has_perm('whatsapp.send'))
  WITH CHECK (app_is_member(organization_id) AND app_has_perm('whatsapp.send'));
CREATE POLICY automation_rw ON automation_settings FOR ALL USING (app_is_member(organization_id))
  WITH CHECK (app_is_member(organization_id) AND app_has_perm('org.manage'));
CREATE POLICY wa_conversations_rw ON whatsapp_conversations FOR ALL USING (EXISTS (SELECT 1 FROM whatsapp_accounts a WHERE a.id = account_id))
  WITH CHECK (EXISTS (SELECT 1 FROM whatsapp_accounts a WHERE a.id = account_id));
CREATE POLICY wa_messages_rw ON whatsapp_messages FOR ALL USING (EXISTS (SELECT 1 FROM whatsapp_conversations c WHERE c.id = conversation_id))
  WITH CHECK (EXISTS (SELECT 1 FROM whatsapp_conversations c WHERE c.id = conversation_id));
CREATE POLICY outbound_emails_rw ON outbound_emails FOR ALL USING (app_is_member(organization_id) AND app_has_perm('staff.manage'))
  WITH CHECK (app_is_member(organization_id));

-- ---------- Platform ----------
CREATE POLICY subscriptions_read ON subscriptions FOR SELECT USING (app_is_platform_admin() OR (app_is_member(organization_id) AND app_has_perm('org.manage')));
CREATE POLICY subscriptions_admin ON subscriptions FOR ALL USING (app_is_platform_admin()) WITH CHECK (app_is_platform_admin());

-- ---------- Audit ----------
CREATE POLICY audit_insert ON audit_log FOR INSERT WITH CHECK (
  actor_user_id = app_user_id() AND (organization_id IS NULL OR app_is_member(organization_id)));
CREATE POLICY audit_read ON audit_log FOR SELECT USING (
  actor_user_id = app_user_id() OR (app_is_member(organization_id) AND app_has_perm('staff.manage')));

-- Lock down SECURITY DEFINER functions: callable by the app role only.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO medora_app;
