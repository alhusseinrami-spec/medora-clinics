-- MEDORA CLINICS: migration 008, Release 4 communication.
-- WhatsApp Business (Cloud API) numbers per workspace or per doctor, message templates in en/fr/ar,
-- automation settings, patient consent and opt-out, a scheduled-message queue (reminders, confirmations,
-- follow-ups), the shared inbox, and real-time notification events.
-- Rule kept throughout: reminder texts never carry medical details (no diagnosis, no medication, no results).

-- ---------- Permissions ----------
-- The owner of a center can connect the center's WhatsApp number and run its messaging by default.
INSERT INTO role_default_permissions (role_code, permission_code) VALUES ('center_owner', 'whatsapp.send') ON CONFLICT DO NOTHING;
INSERT INTO membership_permissions (membership_id, permission_code)
SELECT id, 'whatsapp.send' FROM memberships WHERE role_code = 'center_owner' ON CONFLICT DO NOTHING;

-- ---------- Phone numbers ----------
-- WhatsApp numbers in international digits, same rule as the API: '+' or '00' prefix kept as given, otherwise a local
-- number gets the country code (Lebanon) and loses its leading 0. 03 123 456 -> 9613123456.
CREATE FUNCTION comm_wa_number(raw text, cc text DEFAULT '961') RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN length(d) BETWEEN 8 AND 15 THEN d END FROM (
    SELECT regexp_replace(CASE
      WHEN t LIKE '+%' THEN substr(t, 2)
      WHEN t LIKE '00%' THEN substr(t, 3)
      WHEN t LIKE cc || '%' AND length(t) > 8 THEN t
      ELSE cc || regexp_replace(t, '^0', '') END, '\D', '', 'g') AS d
    FROM (SELECT regexp_replace(trim(coalesce(raw, '')), '[^0-9+]', '', 'g') AS t) x) y
$$;

-- ---------- WhatsApp numbers ----------
DROP POLICY wa_accounts_rw ON whatsapp_accounts;
ALTER TABLE whatsapp_accounts
  DROP COLUMN access_token_ref,
  ADD COLUMN waba_id          text,
  ADD COLUMN access_token_enc text,                 -- AES-256-GCM, never returned by the API
  ADD COLUMN last_error       text,
  ADD COLUMN connected_at     timestamptz,
  ADD COLUMN created_by       uuid REFERENCES users(id),
  ADD COLUMN created_at       timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN is_active        boolean NOT NULL DEFAULT true,
  ADD CONSTRAINT wa_accounts_id_org_uq UNIQUE (id, organization_id),
  ADD CONSTRAINT wa_accounts_member_same_org FOREIGN KEY (membership_id, organization_id) REFERENCES memberships(id, organization_id);
-- One active number per doctor, and one workspace-wide number.
CREATE UNIQUE INDEX wa_accounts_one_per_scope ON whatsapp_accounts (organization_id, coalesce(membership_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE is_active;
-- The API role can read everything except the token.
REVOKE SELECT, UPDATE ON whatsapp_accounts FROM medora_app;
GRANT SELECT (id, organization_id, membership_id, phone_number_id, display_number, waba_id, status, last_error, connected_at, created_by, created_at, is_active)
  ON whatsapp_accounts TO medora_app;
GRANT UPDATE (display_number, waba_id, access_token_enc, status, last_error, connected_at, is_active, phone_number_id) ON whatsapp_accounts TO medora_app;

-- Who may see a number and its conversations: workspace-wide staff, or the doctor it belongs to (and their assistants).
CREATE FUNCTION app_can_use_wa_account(p_org uuid, p_member uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT app_is_member(p_org) AND app_has_perm('whatsapp.send')
     AND (app_is_org_wide() OR (p_member IS NOT NULL AND app_acts_for(p_member)))
$$;
CREATE POLICY wa_accounts_read ON whatsapp_accounts FOR SELECT USING (app_can_use_wa_account(organization_id, membership_id));
-- Connecting a number: workspace-wide numbers need org.manage; a doctor connects their own.
CREATE POLICY wa_accounts_insert ON whatsapp_accounts FOR INSERT WITH CHECK (
  app_is_member(organization_id) AND app_has_perm('whatsapp.send')
  AND ((membership_id IS NULL AND app_has_perm('org.manage'))
    OR (membership_id IS NOT NULL AND (app_has_perm('org.manage') OR membership_id IN (SELECT id FROM memberships WHERE user_id = app_user_id())))));
CREATE POLICY wa_accounts_update ON whatsapp_accounts FOR UPDATE USING (
  app_can_use_wa_account(organization_id, membership_id)
  AND (app_has_perm('org.manage') OR membership_id IN (SELECT id FROM memberships WHERE user_id = app_user_id())));

-- ---------- Templates ----------
DROP POLICY msg_templates_read ON message_templates;
DROP POLICY msg_templates_write ON message_templates;
ALTER TABLE message_templates
  DROP CONSTRAINT message_templates_purpose_check,
  ADD CONSTRAINT message_templates_purpose_check CHECK (purpose IN ('confirmation','reminder_24h','reminder_2h','follow_up',
    'vaccination','treatment','reschedule','cancellation','payment','announcement')),
  ADD COLUMN updated_by uuid REFERENCES users(id),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX message_templates_uq ON message_templates (coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), purpose, language);
CREATE POLICY msg_templates_read ON message_templates FOR SELECT USING (organization_id IS NULL OR app_is_member(organization_id));
CREATE POLICY msg_templates_write ON message_templates FOR ALL
  USING (organization_id IS NOT NULL AND app_is_member(organization_id) AND app_has_perm('whatsapp.send') AND app_has_perm('template.manage'))
  WITH CHECK (organization_id IS NOT NULL AND app_is_member(organization_id) AND app_has_perm('whatsapp.send') AND app_has_perm('template.manage'));

-- Platform defaults. Placeholders: {patient} {doctor} {clinic} {date} {time} {amount} {message}. No medical content.
INSERT INTO message_templates (organization_id, purpose, language, body) VALUES
  (NULL,'confirmation','en','Hello {patient}, your appointment with {doctor} at {clinic} is booked for {date} at {time}.'),
  (NULL,'confirmation','fr','Bonjour {patient}, votre rendez-vous avec {doctor} à {clinic} est fixé le {date} à {time}.'),
  (NULL,'confirmation','ar','مرحباً {patient}، تم حجز موعدك مع {doctor} في {clinic} بتاريخ {date} الساعة {time}.'),
  (NULL,'reminder_24h','en','Reminder: {patient}, you have an appointment with {doctor} at {clinic} tomorrow, {date} at {time}.'),
  (NULL,'reminder_24h','fr','Rappel : {patient}, vous avez rendez-vous avec {doctor} à {clinic} demain, le {date} à {time}.'),
  (NULL,'reminder_24h','ar','تذكير: {patient}، لديك موعد مع {doctor} في {clinic} غداً، {date} الساعة {time}.'),
  (NULL,'reminder_2h','en','Reminder: {patient}, your appointment with {doctor} at {clinic} is today at {time}.'),
  (NULL,'reminder_2h','fr','Rappel : {patient}, votre rendez-vous avec {doctor} à {clinic} est aujourd''hui à {time}.'),
  (NULL,'reminder_2h','ar','تذكير: {patient}، موعدك مع {doctor} في {clinic} اليوم الساعة {time}.'),
  (NULL,'reschedule','en','{patient}, your appointment with {doctor} at {clinic} has moved to {date} at {time}.'),
  (NULL,'reschedule','fr','{patient}, votre rendez-vous avec {doctor} à {clinic} est déplacé au {date} à {time}.'),
  (NULL,'reschedule','ar','{patient}، تم تغيير موعدك مع {doctor} في {clinic} إلى {date} الساعة {time}.'),
  (NULL,'cancellation','en','{patient}, your appointment with {doctor} at {clinic} on {date} at {time} has been cancelled. Reply to book a new time.'),
  (NULL,'cancellation','fr','{patient}, votre rendez-vous avec {doctor} à {clinic} le {date} à {time} est annulé. Répondez pour fixer une autre date.'),
  (NULL,'cancellation','ar','{patient}، تم إلغاء موعدك مع {doctor} في {clinic} بتاريخ {date} الساعة {time}. ردّ على هذه الرسالة لحجز موعد جديد.'),
  (NULL,'follow_up','en','Hello {patient}, {doctor} at {clinic} would like to see you again around {date}. Reply to book your follow-up visit.'),
  (NULL,'follow_up','fr','Bonjour {patient}, {doctor} à {clinic} souhaite vous revoir vers le {date}. Répondez pour fixer votre visite de suivi.'),
  (NULL,'follow_up','ar','مرحباً {patient}، يودّ {doctor} في {clinic} رؤيتك مجدداً في حدود {date}. ردّ لحجز موعد المتابعة.'),
  (NULL,'vaccination','en','Hello {patient}, a vaccination visit is due around {date} at {clinic}. Reply to book a time.'),
  (NULL,'vaccination','fr','Bonjour {patient}, une visite de vaccination est prévue vers le {date} à {clinic}. Répondez pour fixer un horaire.'),
  (NULL,'vaccination','ar','مرحباً {patient}، موعد التلقيح يقترب في حدود {date} في {clinic}. ردّ لحجز موعد.'),
  (NULL,'treatment','en','Hello {patient}, this is a reminder from {clinic} about the treatment plan {doctor} gave you. Reply if you have questions.'),
  (NULL,'treatment','fr','Bonjour {patient}, un rappel de {clinic} concernant le traitement prescrit par {doctor}. Répondez si vous avez des questions.'),
  (NULL,'treatment','ar','مرحباً {patient}، هذا تذكير من {clinic} بخطة العلاج التي وصفها {doctor}. ردّ إذا كان لديك أي سؤال.'),
  (NULL,'payment','en','Hello {patient}, a balance of {amount} is open at {clinic}. Thank you for settling it at your next visit.'),
  (NULL,'payment','fr','Bonjour {patient}, un solde de {amount} reste à régler à {clinic}. Merci de le régler lors de votre prochaine visite.'),
  (NULL,'payment','ar','مرحباً {patient}، يوجد رصيد مستحق بقيمة {amount} لدى {clinic}. نشكرك على تسديده في زيارتك القادمة.'),
  (NULL,'announcement','en','{clinic}: {message}'),
  (NULL,'announcement','fr','{clinic} : {message}'),
  (NULL,'announcement','ar','{clinic}: {message}');

-- ---------- Automation settings ----------
DROP POLICY automation_rw ON automation_settings;
ALTER TABLE automation_settings
  ADD CONSTRAINT automation_purpose_check CHECK (purpose IN ('confirmation','reminder_24h','reminder_2h','follow_up','reschedule','cancellation')),
  ADD COLUMN send_hour   int CHECK (send_hour BETWEEN 0 AND 23),   -- for day-based messages (follow-ups), local time
  ADD COLUMN updated_by  uuid REFERENCES users(id),
  ADD COLUMN updated_at  timestamptz NOT NULL DEFAULT now();
CREATE POLICY automation_read ON automation_settings FOR SELECT USING (app_is_member(organization_id));
CREATE POLICY automation_write ON automation_settings FOR ALL USING (app_is_member(organization_id) AND app_has_perm('org.manage') AND app_has_perm('whatsapp.send'))
  WITH CHECK (app_is_member(organization_id) AND app_has_perm('org.manage') AND app_has_perm('whatsapp.send'));
-- An independent doctor manages their own practice settings (they hold org.manage there).

-- ---------- Consent and opt-out ----------
DROP POLICY consents_rw ON patient_consents;
ALTER TABLE patient_consents
  ADD COLUMN organization_id uuid REFERENCES organizations(id),
  ADD COLUMN recorded_by     uuid REFERENCES users(id),
  ADD COLUMN source          text NOT NULL DEFAULT 'staff' CHECK (source IN ('staff','patient_reply','import'));
UPDATE patient_consents c SET organization_id = p.organization_id FROM patients p WHERE p.id = c.patient_id;
ALTER TABLE patient_consents ALTER COLUMN organization_id SET NOT NULL,
  ADD CONSTRAINT consents_patient_same_org FOREIGN KEY (patient_id, organization_id) REFERENCES patients(id, organization_id);
CREATE TRIGGER patient_consents_fill_org BEFORE INSERT ON patient_consents FOR EACH ROW EXECUTE FUNCTION fill_org_from_patient();
CREATE POLICY consents_read ON patient_consents FOR SELECT USING (app_can_see_patient(patient_id, organization_id));
CREATE POLICY consents_write ON patient_consents FOR ALL
  USING (app_can_see_patient(patient_id, organization_id) AND (app_has_perm('patient.register') OR app_has_perm('whatsapp.send')))
  WITH CHECK (app_can_see_patient(patient_id, organization_id) AND (app_has_perm('patient.register') OR app_has_perm('whatsapp.send')));
-- History of consent changes (who, when, how), never edited.
CREATE TABLE consent_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  patient_id      uuid NOT NULL,
  channel         text NOT NULL,
  opted_in        boolean NOT NULL,
  source          text NOT NULL,
  recorded_by     uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (patient_id, organization_id) REFERENCES patients(id, organization_id)
);
CREATE FUNCTION consent_log() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.opted_in IS DISTINCT FROM OLD.opted_in THEN
    INSERT INTO consent_events (organization_id, patient_id, channel, opted_in, source, recorded_by)
    VALUES (NEW.organization_id, NEW.patient_id, NEW.channel, NEW.opted_in, NEW.source, NEW.recorded_by);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER patient_consents_log AFTER INSERT OR UPDATE ON patient_consents FOR EACH ROW EXECUTE FUNCTION consent_log();
GRANT SELECT ON consent_events TO medora_app;
REVOKE INSERT, UPDATE, DELETE ON consent_events FROM medora_app;
ALTER TABLE consent_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY consent_events_read ON consent_events FOR SELECT USING (app_can_see_patient(patient_id, organization_id));

-- ---------- Conversations and messages ----------
DROP POLICY wa_conversations_rw ON whatsapp_conversations;
DROP POLICY wa_messages_rw ON whatsapp_messages;
ALTER TABLE whatsapp_conversations
  ADD COLUMN organization_id  uuid REFERENCES organizations(id),
  ADD COLUMN status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  ADD COLUMN unread           int NOT NULL DEFAULT 0,
  ADD COLUMN last_message_at  timestamptz,
  ADD COLUMN last_outbound_at timestamptz,
  ADD COLUMN created_at       timestamptz NOT NULL DEFAULT now();
UPDATE whatsapp_conversations c SET organization_id = a.organization_id FROM whatsapp_accounts a WHERE a.id = c.account_id;
ALTER TABLE whatsapp_conversations ALTER COLUMN organization_id SET NOT NULL,
  ADD CONSTRAINT wa_conv_account_same_org FOREIGN KEY (account_id, organization_id) REFERENCES whatsapp_accounts(id, organization_id),
  ADD CONSTRAINT wa_conv_patient_same_org FOREIGN KEY (patient_id, organization_id) REFERENCES patients(id, organization_id),
  ADD CONSTRAINT wa_conv_assignee_same_org FOREIGN KEY (assigned_to, organization_id) REFERENCES memberships(id, organization_id),
  ADD CONSTRAINT wa_conv_id_org_uq UNIQUE (id, organization_id);
CREATE INDEX wa_conv_org_idx ON whatsapp_conversations (organization_id, last_message_at DESC);

ALTER TABLE whatsapp_messages
  DROP CONSTRAINT whatsapp_messages_status_check,
  ADD CONSTRAINT whatsapp_messages_status_check CHECK (status IN ('queued','sent','delivered','read','failed','received')),
  ADD COLUMN organization_id uuid REFERENCES organizations(id),
  ADD COLUMN purpose         text,
  ADD COLUMN error           text,
  ADD COLUMN status_at       timestamptz;
UPDATE whatsapp_messages m SET organization_id = c.organization_id FROM whatsapp_conversations c WHERE c.id = m.conversation_id;
ALTER TABLE whatsapp_messages ALTER COLUMN organization_id SET NOT NULL,
  ADD CONSTRAINT wa_msg_conv_same_org FOREIGN KEY (conversation_id, organization_id) REFERENCES whatsapp_conversations(id, organization_id);
CREATE INDEX wa_msg_conv_idx ON whatsapp_messages (conversation_id, created_at);
-- Message history is a record: the API may add messages and nothing else. Status changes come from Meta's webhook.
REVOKE UPDATE, DELETE ON whatsapp_messages FROM medora_app;

CREATE FUNCTION app_can_see_conversation(p_org uuid, p_account uuid, p_assigned uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT app_is_member(p_org) AND app_has_perm('whatsapp.send') AND (
    app_is_org_wide()
    OR EXISTS (SELECT 1 FROM whatsapp_accounts a WHERE a.id = p_account AND a.membership_id IS NOT NULL AND app_acts_for(a.membership_id))
    OR (p_assigned IS NOT NULL AND (app_acts_for(p_assigned) OR p_assigned IN (SELECT id FROM memberships WHERE user_id = app_user_id()))))
$$;
CREATE POLICY wa_conversations_read ON whatsapp_conversations FOR SELECT USING (app_can_see_conversation(organization_id, account_id, assigned_to));
CREATE POLICY wa_conversations_update ON whatsapp_conversations FOR UPDATE USING (app_can_see_conversation(organization_id, account_id, assigned_to))
  WITH CHECK (app_is_member(organization_id));
CREATE POLICY wa_conversations_insert ON whatsapp_conversations FOR INSERT WITH CHECK (app_can_see_conversation(organization_id, account_id, assigned_to));
CREATE POLICY wa_messages_read ON whatsapp_messages FOR SELECT USING (EXISTS (SELECT 1 FROM whatsapp_conversations c WHERE c.id = conversation_id));
CREATE POLICY wa_messages_insert ON whatsapp_messages FOR INSERT WITH CHECK (
  direction = 'outbound' AND sent_by = app_user_id() AND EXISTS (SELECT 1 FROM whatsapp_conversations c WHERE c.id = conversation_id));
REVOKE DELETE ON whatsapp_conversations FROM medora_app;

-- ---------- Scheduled messages (the queue) ----------
CREATE TABLE scheduled_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  purpose         text NOT NULL CHECK (purpose IN ('confirmation','reminder_24h','reminder_2h','follow_up',
                    'vaccination','treatment','reschedule','cancellation','payment','announcement')),
  patient_id      uuid NOT NULL,
  appointment_id  uuid REFERENCES appointments(id),
  appointment_starts_at timestamptz,          -- the time the message talks about; checked again before sending
  consultation_id uuid REFERENCES consultations(id),
  invoice_id      uuid REFERENCES invoices(id),
  message         text,                       -- announcement text only
  about_date      date,                       -- the date a vaccination or treatment reminder refers to
  send_at         timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','skipped','failed','cancelled')),
  reason          text,                       -- why it was skipped or failed
  message_id      uuid REFERENCES whatsapp_messages(id),
  dedupe_key      text,
  attempts        int NOT NULL DEFAULT 0,
  claimed_at      timestamptz,
  created_by      uuid REFERENCES users(id),  -- NULL = automation
  created_at      timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz,
  FOREIGN KEY (patient_id, organization_id) REFERENCES patients(id, organization_id),
  UNIQUE (organization_id, dedupe_key)
);
CREATE INDEX scheduled_messages_due_idx ON scheduled_messages (send_at) WHERE status = 'pending';
CREATE INDEX scheduled_messages_patient_idx ON scheduled_messages (patient_id, created_at DESC);
GRANT SELECT, INSERT ON scheduled_messages TO medora_app;
GRANT UPDATE (status, reason) ON scheduled_messages TO medora_app;   -- cancelling a pending message
ALTER TABLE scheduled_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY scheduled_read ON scheduled_messages FOR SELECT USING (
  app_is_member(organization_id) AND app_has_perm('whatsapp.send') AND app_can_see_patient(patient_id, organization_id));
CREATE POLICY scheduled_insert ON scheduled_messages FOR INSERT WITH CHECK (
  app_is_member(organization_id) AND app_has_perm('whatsapp.send') AND app_can_see_patient(patient_id, organization_id)
  AND created_by = app_user_id() AND status = 'pending');
CREATE POLICY scheduled_cancel ON scheduled_messages FOR UPDATE USING (
  app_is_member(organization_id) AND app_has_perm('whatsapp.send') AND app_can_see_patient(patient_id, organization_id) AND status = 'pending')
  WITH CHECK (status = 'cancelled');

-- Event messages (confirmation, reschedule, cancellation), queued by the API in the same transaction as the change,
-- only when the workspace switched that automation on. Runs with the caller's identity checks.
CREATE FUNCTION comm_queue_event(p_purpose text, p_appointment uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE a record; r uuid;
BEGIN
  SELECT id, organization_id, patient_id, starts_at, is_walk_in INTO a FROM appointments WHERE id = p_appointment;
  IF a.id IS NULL OR NOT app_is_member(a.organization_id) OR a.is_walk_in THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM automation_settings s WHERE s.organization_id = a.organization_id AND s.purpose = p_purpose AND s.enabled) THEN RETURN NULL; END IF;
  IF p_purpose <> 'cancellation' AND a.starts_at < now() THEN RETURN NULL; END IF;
  -- A newer event replaces pending ones for the same visit (e.g. two quick reschedules send one message).
  UPDATE scheduled_messages SET status = 'cancelled', reason = 'superseded'
   WHERE appointment_id = a.id AND status = 'pending' AND purpose IN ('confirmation','reschedule','cancellation');
  IF p_purpose IN ('reschedule','cancellation') THEN
    UPDATE scheduled_messages SET status = 'cancelled', reason = 'appointment_changed'
     WHERE appointment_id = a.id AND status = 'pending' AND purpose IN ('reminder_24h','reminder_2h');
  END IF;
  INSERT INTO scheduled_messages (organization_id, purpose, patient_id, appointment_id, appointment_starts_at, send_at, created_by, dedupe_key)
  VALUES (a.organization_id, p_purpose, a.patient_id, a.id, a.starts_at, now(), app_user_id(),
          p_purpose || ':' || a.id || ':' || extract(epoch FROM a.starts_at)::bigint || ':' || extract(epoch FROM clock_timestamp())::bigint)
  ON CONFLICT DO NOTHING RETURNING id INTO r;
  RETURN r;
END $$;

-- Reminders and follow-ups are planned by the background worker (no user identity), only for workspaces that enabled them.
CREATE FUNCTION comm_plan() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int := 0; k int;
BEGIN
  -- A worker that stopped mid-send leaves rows in 'sending': retry them (at most 3 attempts).
  UPDATE scheduled_messages SET status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'pending' END,
         reason = CASE WHEN attempts >= 3 THEN 'worker_interrupted' ELSE reason END
   WHERE status = 'sending' AND claimed_at < now() - interval '10 minutes';
  -- Appointment reminders: every visit whose reminder time has come within the last hour (missed ones are not sent late).
  INSERT INTO scheduled_messages (organization_id, purpose, patient_id, appointment_id, appointment_starts_at, send_at, dedupe_key)
  SELECT a.organization_id, s.purpose, a.patient_id, a.id, a.starts_at, a.starts_at + make_interval(mins => s.offset_minutes),
         s.purpose || ':' || a.id || ':' || extract(epoch FROM a.starts_at)::bigint
    FROM automation_settings s
    JOIN organizations o ON o.id = s.organization_id AND o.status = 'active'
    JOIN appointments a ON a.organization_id = s.organization_id
   WHERE s.enabled AND s.purpose IN ('reminder_24h','reminder_2h') AND s.offset_minutes IS NOT NULL
     AND a.status IN ('scheduled','confirmed') AND NOT a.is_walk_in
     AND a.starts_at > now()
     AND a.starts_at + make_interval(mins => s.offset_minutes) BETWEEN now() - interval '1 hour' AND now() + interval '5 minutes'
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
  -- Follow-ups: N days before the follow-up date written in a signed consultation, at the chosen local hour,
  -- unless the patient already has an appointment with that doctor from today on.
  INSERT INTO scheduled_messages (organization_id, purpose, patient_id, consultation_id, send_at, dedupe_key)
  SELECT c.organization_id, 'follow_up', c.patient_id, c.id, now(), 'follow_up:' || c.id
    FROM automation_settings s
    JOIN organizations o ON o.id = s.organization_id AND o.status = 'active'
    JOIN consultations c ON c.organization_id = s.organization_id
   WHERE s.enabled AND s.purpose = 'follow_up' AND c.status = 'signed' AND c.follow_up_date IS NOT NULL
     AND c.follow_up_date - coalesce(s.follow_up_days, 2) <= (now() AT TIME ZONE o.timezone)::date
     AND c.follow_up_date >= (now() AT TIME ZONE o.timezone)::date
     AND extract(hour FROM now() AT TIME ZONE o.timezone) >= coalesce(s.send_hour, 10)
     AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id = c.patient_id AND a.doctor_membership_id = c.doctor_membership_id
                      AND a.starts_at >= date_trunc('day', now()) AND a.status NOT IN ('cancelled','no_show'))
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
  RETURN n;
END $$;

-- The worker claims due messages with everything needed to send them (including the decrypted-at-the-edge token blob).
CREATE FUNCTION comm_claim_due(p_limit int) RETURNS TABLE (
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
    SELECT sm.id FROM scheduled_messages sm WHERE sm.status = 'pending' AND sm.send_at <= now()
     ORDER BY sm.send_at LIMIT p_limit FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE scheduled_messages sm SET status = 'sending', attempts = sm.attempts + 1, claimed_at = now() FROM due WHERE sm.id = due.id RETURNING sm.*
  )
  SELECT c.id, c.organization_id, c.purpose, c.message, c.send_at, c.appointment_starts_at,
         p.id, p.full_name, coalesce(nullif(p.whatsapp_number, ''), p.phone), p.preferred_language,
         coalesce((SELECT pc.opted_in FROM patient_consents pc WHERE pc.patient_id = p.id AND pc.channel = 'whatsapp'), false),
         a.status, a.starts_at,
         du.full_name, o.name, o.timezone, coalesce(con.follow_up_date, c.about_date),
         (SELECT b.total - b.credited - b.paid FROM invoice_balances b WHERE b.invoice_id = c.invoice_id), i.currency,
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

-- Records the outcome; a sent message is added to the conversation with that number (created if needed).
CREATE FUNCTION comm_finish(p_id uuid, p_status text, p_reason text, p_account uuid, p_to text, p_body text, p_meta_id text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE sm record; conv uuid; msg uuid;
BEGIN
  SELECT * INTO sm FROM scheduled_messages WHERE id = p_id AND status = 'sending' FOR UPDATE;
  IF sm.id IS NULL THEN RETURN NULL; END IF;
  IF p_status = 'sent' THEN
    INSERT INTO whatsapp_conversations (organization_id, account_id, patient_id, contact_number, last_message_at, last_outbound_at)
    VALUES (sm.organization_id, p_account, sm.patient_id, p_to, now(), now())
    ON CONFLICT (account_id, contact_number) DO UPDATE SET last_message_at = now(), last_outbound_at = now(),
      patient_id = coalesce(whatsapp_conversations.patient_id, EXCLUDED.patient_id)
    RETURNING id INTO conv;
    INSERT INTO whatsapp_messages (organization_id, conversation_id, direction, body, meta_message_id, status, sent_by, purpose, status_at)
    VALUES (sm.organization_id, conv, 'outbound', p_body, p_meta_id, 'sent', sm.created_by, sm.purpose, now()) RETURNING id INTO msg;
  END IF;
  UPDATE scheduled_messages SET status = p_status, reason = p_reason, message_id = msg, processed_at = now() WHERE id = p_id;
  RETURN msg;
END $$;

-- Inbound message from Meta's webhook. Matches the number to the right workspace and, when unambiguous, to a patient.
-- Opt-out words switch WhatsApp consent off. Notifies the people who handle that inbox.
CREATE FUNCTION comm_inbound(p_phone_number_id text, p_from text, p_body text, p_meta_id text, p_at timestamptz)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE acc record; conv record; pid uuid; msg uuid; digits text := regexp_replace(p_from, '\D', '', 'g'); n int;
BEGIN
  SELECT * INTO acc FROM whatsapp_accounts WHERE phone_number_id = p_phone_number_id AND is_active;
  IF acc.id IS NULL THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM whatsapp_messages WHERE meta_message_id = p_meta_id) THEN RETURN NULL; END IF;  -- Meta retries
  SELECT count(*), min(p.id::text)::uuid INTO n, pid FROM patients p
   WHERE p.organization_id = acc.organization_id AND p.archived_at IS NULL
     AND comm_wa_number(coalesce(nullif(p.whatsapp_number, ''), p.phone)) = digits;
  IF n <> 1 THEN pid := NULL; END IF;
  -- Ordering and "unanswered" use the time we received it (Meta's timestamp has whole seconds only); status_at keeps Meta's time.
  INSERT INTO whatsapp_conversations (organization_id, account_id, patient_id, contact_number, last_inbound_at, last_message_at, unread, status)
  VALUES (acc.organization_id, acc.id, pid, digits, now(), now(), 1, 'open')
  ON CONFLICT (account_id, contact_number) DO UPDATE SET last_inbound_at = now(), last_message_at = now(),
    unread = whatsapp_conversations.unread + 1, status = 'open', patient_id = coalesce(whatsapp_conversations.patient_id, EXCLUDED.patient_id)
  RETURNING * INTO conv;
  INSERT INTO whatsapp_messages (organization_id, conversation_id, direction, body, meta_message_id, status, created_at, status_at)
  VALUES (acc.organization_id, conv.id, 'inbound', p_body, p_meta_id, 'received', now(), p_at) RETURNING id INTO msg;
  IF conv.patient_id IS NOT NULL AND upper(trim(p_body)) IN ('STOP','UNSUBSCRIBE','ARRET','ARRÊT','STOPP','إلغاء','الغاء','توقف') THEN
    INSERT INTO patient_consents (patient_id, organization_id, channel, opted_in, source)
    VALUES (conv.patient_id, acc.organization_id, 'whatsapp', false, 'patient_reply')
    ON CONFLICT (patient_id, channel) DO UPDATE SET opted_in = false, source = 'patient_reply', recorded_by = NULL, recorded_at = now();
    UPDATE scheduled_messages SET status = 'cancelled', reason = 'opted_out' WHERE patient_id = conv.patient_id AND status = 'pending';
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

-- Delivery status from Meta's webhook (sent -> delivered -> read, or failed). Never goes backwards.
CREATE FUNCTION comm_status(p_meta_id text, p_status text, p_error text, p_at timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE m record; rank_old int; rank_new int;
BEGIN
  SELECT * INTO m FROM whatsapp_messages WHERE meta_message_id = p_meta_id AND direction = 'outbound' FOR UPDATE;
  IF m.id IS NULL THEN RETURN false; END IF;
  rank_old := array_position(ARRAY['queued','sent','delivered','read'], m.status);
  rank_new := array_position(ARRAY['queued','sent','delivered','read'], p_status);
  IF p_status = 'failed' THEN
    UPDATE whatsapp_messages SET status = 'failed', error = p_error, status_at = p_at WHERE id = m.id;
  ELSIF rank_new IS NOT NULL AND (rank_old IS NULL OR rank_new > rank_old) AND m.status <> 'failed' THEN
    UPDATE whatsapp_messages SET status = p_status, status_at = p_at WHERE id = m.id;
  ELSE RETURN false; END IF;
  PERFORM pg_notify('comm_events', json_build_object('type', 'whatsapp', 'organization_id', m.organization_id, 'conversation_id', m.conversation_id)::text);
  RETURN true;
END $$;

-- Token of a number, for sending a reply typed in the inbox. Only for a number the caller may use.
CREATE FUNCTION comm_account_token(p_account uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT access_token_enc FROM whatsapp_accounts a WHERE a.id = p_account AND a.is_active AND app_can_use_wa_account(a.organization_id, a.membership_id)
$$;
-- Records an outbound message typed in the inbox (status from the send attempt).
CREATE FUNCTION comm_record_reply(p_conversation uuid, p_body text, p_meta_id text, p_status text, p_error text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c record; msg uuid;
BEGIN
  SELECT * INTO c FROM whatsapp_conversations WHERE id = p_conversation;
  IF c.id IS NULL OR NOT app_can_see_conversation(c.organization_id, c.account_id, c.assigned_to) THEN RAISE EXCEPTION 'conversation not found' USING ERRCODE = 'insufficient_privilege'; END IF;
  INSERT INTO whatsapp_messages (organization_id, conversation_id, direction, body, meta_message_id, status, error, sent_by, status_at)
  VALUES (c.organization_id, c.id, 'outbound', p_body, p_meta_id, p_status, p_error, app_user_id(), now()) RETURNING id INTO msg;
  IF p_status = 'sent' THEN UPDATE whatsapp_conversations SET last_message_at = now(), last_outbound_at = now(), unread = 0 WHERE id = c.id; END IF;
  RETURN msg;
END $$;

-- ---------- Real-time notifications ----------
CREATE FUNCTION notifications_push() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('comm_events', json_build_object('type', 'notification', 'user_id', NEW.user_id, 'kind', NEW.kind)::text);
  RETURN NEW;
END $$;
CREATE TRIGGER notifications_push AFTER INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION notifications_push();

REVOKE EXECUTE ON FUNCTION comm_plan(), comm_claim_due(int), comm_finish(uuid, text, text, uuid, text, text, text),
  comm_inbound(text, text, text, text, timestamptz), comm_status(text, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO medora_app;
