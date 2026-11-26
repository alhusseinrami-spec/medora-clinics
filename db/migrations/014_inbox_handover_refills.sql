-- Inbox handover and prescription refill requests.
-- A WhatsApp conversation is handled automatically until a team member takes it over, and goes back to automatic
-- when they hand it back. In automatic mode the clinic recognises refill requests; anything it cannot handle is
-- flagged "needs a person" with the reason. A future AI receptionist plugs into the same automatic mode.

-- ---------- Handover ----------
ALTER TABLE whatsapp_conversations
  ADD COLUMN handled_by         text NOT NULL DEFAULT 'auto' CHECK (handled_by IN ('auto','staff')),
  ADD COLUMN needs_staff        boolean NOT NULL DEFAULT false,
  ADD COLUMN needs_staff_reason text CHECK (needs_staff_reason IN ('unknown_number','message','asked_for_person','no_prescription')),
  ADD COLUMN taken_at           timestamptz;
CREATE INDEX wa_conv_needs_staff_idx ON whatsapp_conversations (organization_id) WHERE needs_staff;

-- ---------- Refill requests ----------
CREATE TABLE refill_requests (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id),
  patient_id           uuid NOT NULL,
  prescription_id      uuid NOT NULL REFERENCES prescriptions(id),   -- the prescription to renew
  doctor_membership_id uuid NOT NULL,                                -- its prescriber decides
  conversation_id      uuid REFERENCES whatsapp_conversations(id),
  source               text NOT NULL CHECK (source IN ('whatsapp','staff')),
  note                 text,
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  decision_note        text,
  decided_by           uuid REFERENCES users(id),
  decided_at           timestamptz,
  new_prescription_id  uuid REFERENCES prescriptions(id),
  created_by           uuid REFERENCES users(id),                    -- NULL = from the patient's WhatsApp message
  created_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (patient_id, organization_id) REFERENCES patients(id, organization_id),
  FOREIGN KEY (doctor_membership_id, organization_id) REFERENCES memberships(id, organization_id),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK (status <> 'approved' OR new_prescription_id IS NOT NULL)
);
CREATE UNIQUE INDEX refill_one_pending ON refill_requests (prescription_id) WHERE status = 'pending';
CREATE INDEX refill_org_idx ON refill_requests (organization_id, status, created_at DESC);
GRANT SELECT, INSERT ON refill_requests TO medora_app;
GRANT UPDATE (status, decision_note, decided_by, decided_at, new_prescription_id) ON refill_requests TO medora_app;
ALTER TABLE refill_requests ENABLE ROW LEVEL SECURITY;
-- The prescribing doctor and those acting for them, and the front desk (WhatsApp or appointments), see a request.
CREATE POLICY refill_read ON refill_requests FOR SELECT USING (
  app_is_member(organization_id) AND app_can_see_patient(patient_id, organization_id)
  AND ((app_has_perm('prescription.view') AND (app_acts_for(doctor_membership_id) OR app_is_org_wide()))
       OR app_has_perm('whatsapp.send') OR app_has_perm('appointment.manage')));
CREATE POLICY refill_insert ON refill_requests FOR INSERT WITH CHECK (
  app_is_member(organization_id) AND app_can_see_patient(patient_id, organization_id)
  AND (app_has_perm('whatsapp.send') OR app_has_perm('prescription.create') OR app_has_perm('appointment.manage'))
  AND created_by = app_user_id() AND status = 'pending' AND source = 'staff');
-- Only the prescribing doctor decides.
CREATE POLICY refill_decide ON refill_requests FOR UPDATE USING (
  app_is_member(organization_id) AND app_has_perm('prescription.create') AND status = 'pending'
  AND doctor_membership_id IN (SELECT m.id FROM memberships m WHERE m.user_id = app_user_id()))
  WITH CHECK (status IN ('approved','denied') AND decided_by = app_user_id());

-- Short WhatsApp text about a refill, in the patient's language. No medication names: messages carry no medical content.
CREATE FUNCTION refill_message_text(p_lang text, p_kind text, p_doctor text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_kind
    WHEN 'received' THEN CASE p_lang
      WHEN 'fr' THEN 'Nous avons bien reçu votre demande de renouvellement d''ordonnance. ' || p_doctor || ' va l''examiner et nous vous tiendrons informé.'
      WHEN 'ar' THEN 'وصلنا طلبك لتجديد الوصفة الطبية. سيراجعه ' || p_doctor || ' وسنعلمك بالنتيجة.'
      ELSE 'We received your request to renew your prescription. ' || p_doctor || ' will review it and we will let you know.' END
    WHEN 'approved' THEN CASE p_lang
      WHEN 'fr' THEN p_doctor || ' a renouvelé votre ordonnance. Vous pouvez la récupérer à la clinique.'
      WHEN 'ar' THEN 'وافق ' || p_doctor || ' على تجديد وصفتك. يمكنك استلامها من العيادة.'
      ELSE p_doctor || ' approved your prescription renewal. You can pick it up at the clinic.' END
    ELSE CASE p_lang
      WHEN 'fr' THEN p_doctor || ' ne peut pas renouveler votre ordonnance sans vous voir. Répondez à ce message pour prendre rendez-vous.'
      WHEN 'ar' THEN 'لا يمكن لـ' || p_doctor || ' تجديد وصفتك من دون رؤيتك. ردّ على هذه الرسالة لحجز موعد.'
      ELSE p_doctor || ' cannot renew your prescription without seeing you. Reply to this message to book a visit.' END
  END
$$;

-- Queues the patient's WhatsApp message about a request (sent by the worker, inside message hours and only with consent).
-- Callable by the deciding doctor; the webhook path calls it internally.
CREATE FUNCTION refill_queue_message(p_request uuid, p_kind text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; sid uuid;
BEGIN
  SELECT rr.*, p.preferred_language AS lang, u.full_name AS doctor_name INTO r
    FROM refill_requests rr JOIN patients p ON p.id = rr.patient_id
    JOIN memberships m ON m.id = rr.doctor_membership_id JOIN users u ON u.id = m.user_id WHERE rr.id = p_request;
  IF r.id IS NULL THEN RETURN NULL; END IF;
  IF app_user_id() IS NOT NULL AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.id = r.doctor_membership_id AND m.user_id = app_user_id()) THEN
    RAISE EXCEPTION 'not your refill request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_kind NOT IN ('received','approved','denied') THEN RAISE EXCEPTION 'unknown refill message'; END IF;
  -- Only for a patient who agreed to WhatsApp messages; otherwise the team tells them (the API says so).
  IF NOT coalesce((SELECT pc.opted_in FROM patient_consents pc WHERE pc.patient_id = r.patient_id AND pc.channel = 'whatsapp'), false) THEN RETURN NULL; END IF;
  INSERT INTO scheduled_messages (organization_id, purpose, patient_id, message, send_at, created_by, dedupe_key)
  VALUES (r.organization_id, 'announcement', r.patient_id, refill_message_text(r.lang, p_kind, r.doctor_name), now(), app_user_id(), 'refill:' || p_kind || ':' || r.id)
  ON CONFLICT (organization_id, dedupe_key) DO NOTHING RETURNING id INTO sid;
  RETURN sid;
END $$;

-- The prescription a renewal is for: the given one or the patient's latest issued one. The front desk may ask for a
-- renewal without being able to read prescriptions, so this looks it up for them, inside their workspace only.
CREATE FUNCTION refill_source(p_patient uuid, p_prescription uuid) RETURNS TABLE (id uuid, prescribed_by uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.id, r.prescribed_by FROM prescriptions r
   WHERE r.patient_id = p_patient AND r.organization_id = app_org_id() AND r.status = 'issued'
     AND app_is_member(r.organization_id) AND app_can_see_patient(p_patient, r.organization_id)
     AND (p_prescription IS NULL OR r.id = p_prescription)
   ORDER BY r.issued_at DESC LIMIT 1
$$;

-- Tells the prescribing doctor a renewal is waiting.
CREATE FUNCTION refill_notify_doctor(p_request uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO notifications (user_id, kind, payload)
  SELECT m.user_id, 'refill_request', jsonb_build_object('organization_id', rr.organization_id, 'refill_id', rr.id, 'patient_id', rr.patient_id)
    FROM refill_requests rr JOIN memberships m ON m.id = rr.doctor_membership_id
   WHERE rr.id = p_request AND m.status = 'active' AND m.user_id IS DISTINCT FROM app_user_id()
     AND (app_user_id() IS NULL OR app_is_member(rr.organization_id))
$$;

-- ---------- Inbound messages: same as before, plus the automatic handling ----------
CREATE OR REPLACE FUNCTION comm_inbound(p_phone_number_id text, p_from text, p_body text, p_meta_id text, p_at timestamptz)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE acc record; conv record; rx record; pid uuid; msg uuid; req uuid; reason text; stopped boolean := false;
        digits text := regexp_replace(p_from, '\D', '', 'g'); n int;
BEGIN
  SELECT * INTO acc FROM whatsapp_accounts WHERE phone_number_id = p_phone_number_id AND is_active;
  IF acc.id IS NULL THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM whatsapp_messages WHERE meta_message_id = p_meta_id) THEN RETURN NULL; END IF;  -- Meta retries
  SELECT count(*), min(p.id::text)::uuid INTO n, pid FROM patients p
   WHERE p.organization_id = acc.organization_id AND p.archived_at IS NULL
     AND comm_wa_number(coalesce(nullif(p.whatsapp_number, ''), p.phone)) = digits;
  IF n <> 1 THEN pid := NULL; END IF;
  INSERT INTO whatsapp_conversations (organization_id, account_id, patient_id, contact_number, last_inbound_at, last_message_at, unread, status)
  VALUES (acc.organization_id, acc.id, pid, digits, now(), now(), 1, 'open')
  ON CONFLICT (account_id, contact_number) DO UPDATE SET last_inbound_at = now(), last_message_at = now(),
    unread = whatsapp_conversations.unread + 1, status = 'open', patient_id = coalesce(whatsapp_conversations.patient_id, EXCLUDED.patient_id)
  RETURNING * INTO conv;
  INSERT INTO whatsapp_messages (organization_id, conversation_id, direction, body, meta_message_id, status, created_at, status_at)
  VALUES (acc.organization_id, conv.id, 'inbound', p_body, p_meta_id, 'received', now(), p_at) RETURNING id INTO msg;
  IF conv.patient_id IS NOT NULL AND upper(trim(p_body)) IN ('STOP','UNSUBSCRIBE','ARRET','ARRÊT','STOPP','إلغاء','الغاء','توقف') THEN
    stopped := true;
    INSERT INTO patient_consents (patient_id, organization_id, channel, opted_in, source)
    VALUES (conv.patient_id, acc.organization_id, 'whatsapp', false, 'patient_reply')
    ON CONFLICT (patient_id, channel) DO UPDATE SET opted_in = false, source = 'patient_reply', recorded_by = NULL, recorded_at = now();
    UPDATE scheduled_messages SET status = 'cancelled', reason = 'opted_out' WHERE patient_id = conv.patient_id AND status = 'pending';
  END IF;

  -- Automatic handling, while no team member has taken the conversation over.
  IF conv.handled_by = 'auto' AND NOT stopped THEN
    IF conv.patient_id IS NOT NULL AND p_body ~* '(refill|renew|repeat prescription|renouvel|ordonnance|تجديد|وصفة|روشت)' THEN
      SELECT r.id, r.prescribed_by INTO rx FROM prescriptions r
       WHERE r.patient_id = conv.patient_id AND r.organization_id = acc.organization_id AND r.status = 'issued'
       ORDER BY r.issued_at DESC LIMIT 1;
      IF rx.id IS NULL THEN reason := 'no_prescription';
      ELSE
        INSERT INTO refill_requests (organization_id, patient_id, prescription_id, doctor_membership_id, conversation_id, source, note)
        VALUES (acc.organization_id, conv.patient_id, rx.id, rx.prescribed_by, conv.id, 'whatsapp', left(p_body, 500))
        ON CONFLICT (prescription_id) WHERE status = 'pending' DO NOTHING RETURNING id INTO req;
        IF req IS NOT NULL THEN
          PERFORM refill_queue_message(req, 'received');
          PERFORM refill_notify_doctor(req);
        END IF;
      END IF;
    ELSIF p_body ~* '(human|person|someone|agent|staff|secretar|quelqu|personne|secrétaire|موظف|انسان|إنسان|سكرتير|حدا)' THEN reason := 'asked_for_person';
    ELSIF conv.patient_id IS NULL THEN reason := 'unknown_number';
    ELSE reason := 'message';
    END IF;
    IF reason IS NOT NULL THEN
      UPDATE whatsapp_conversations SET needs_staff = true, needs_staff_reason = reason WHERE id = conv.id;
    END IF;
  END IF;

  INSERT INTO notifications (user_id, kind, payload)
  SELECT DISTINCT m.user_id, 'whatsapp_message', jsonb_build_object('organization_id', acc.organization_id, 'conversation_id', conv.id, 'patient_id', conv.patient_id)
    FROM memberships m JOIN membership_permissions mp ON mp.membership_id = m.id AND mp.permission_code = 'whatsapp.send'
   WHERE m.organization_id = acc.organization_id AND m.status = 'active'
     AND (m.role_code IN ('center_owner','center_admin','receptionist','accountant','insurance_admin')
          OR m.id = acc.membership_id OR m.id = conv.assigned_to
          OR m.id IN (SELECT aa.assistant_membership_id FROM assistant_assignments aa WHERE aa.doctor_membership_id = acc.membership_id)
          OR (acc.membership_id IS NULL AND (SELECT kind FROM organizations WHERE id = acc.organization_id) = 'independent_practice'));
  PERFORM pg_notify('comm_events', json_build_object('type', 'whatsapp', 'organization_id', acc.organization_id, 'conversation_id', conv.id)::text);
  RETURN msg;
END $$;

-- A reply typed in the inbox also takes the conversation over (the team is now handling it).
CREATE OR REPLACE FUNCTION comm_record_reply(p_conversation uuid, p_body text, p_meta_id text, p_status text, p_error text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c record; msg uuid;
BEGIN
  SELECT * INTO c FROM whatsapp_conversations WHERE id = p_conversation;
  IF c.id IS NULL OR NOT app_can_see_conversation(c.organization_id, c.account_id, c.assigned_to) THEN RAISE EXCEPTION 'conversation not found' USING ERRCODE = 'insufficient_privilege'; END IF;
  INSERT INTO whatsapp_messages (organization_id, conversation_id, direction, body, meta_message_id, status, error, sent_by, status_at)
  VALUES (c.organization_id, c.id, 'outbound', p_body, p_meta_id, p_status, p_error, app_user_id(), now()) RETURNING id INTO msg;
  IF p_status = 'sent' THEN
    UPDATE whatsapp_conversations SET last_message_at = now(), last_outbound_at = now(), unread = 0,
      handled_by = 'staff', needs_staff = false, needs_staff_reason = NULL, taken_at = coalesce(CASE WHEN handled_by = 'staff' THEN taken_at END, now())
     WHERE id = c.id;
  END IF;
  RETURN msg;
END $$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO medora_app;
