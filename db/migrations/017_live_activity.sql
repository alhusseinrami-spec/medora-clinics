-- Live activity across the workspace: when a visit was cancelled or marked missed, so the owner's live feed and the
-- front desk can see it as it happens (the waiting room already has arrival, call-in and completion times).

ALTER TABLE appointments ADD COLUMN cancelled_at timestamptz;

CREATE FUNCTION appointment_cancel_time() RETURNS trigger AS $$
BEGIN
  IF NEW.status IN ('cancelled','no_show') AND OLD.status IS DISTINCT FROM NEW.status THEN NEW.cancelled_at := COALESCE(NEW.cancelled_at, now()); END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SET search_path = public;
CREATE TRIGGER appointments_cancel_time BEFORE UPDATE OF status ON appointments
  FOR EACH ROW EXECUTE FUNCTION appointment_cancel_time();

CREATE INDEX appointments_org_created ON appointments (organization_id, created_at);
CREATE INDEX appointments_org_arrived ON appointments (organization_id, arrived_at) WHERE arrived_at IS NOT NULL;

-- The owner's live feed shows requests from the patient app too (who asked, for when); answering them stays with
-- staff who manage appointments.
CREATE POLICY appt_requests_owner_read ON appointment_requests FOR SELECT USING (
  app_is_member(organization_id) AND app_is_org_wide() AND app_has_perm('report.view'));
