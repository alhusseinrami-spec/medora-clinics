-- Doctor and front desk in step: the fee the doctor sets for a visit, which the front desk then collects.
-- The fee lives on the appointment (administrative data the front desk can already read), never on the confidential
-- consultation. When the visit is invoiced from the appointment, this fee becomes the invoice line.

ALTER TABLE appointments
  ADD COLUMN fee_amount   numeric(12,2) CHECK (fee_amount >= 0),
  ADD COLUMN fee_currency text CHECK (fee_currency IN ('USD','LBP')),
  ADD COLUMN fee_note     text CHECK (length(fee_note) <= 200),          -- "Consultation + ECG"; no clinical detail
  ADD COLUMN fee_set_at   timestamptz,
  ADD COLUMN fee_set_by   uuid REFERENCES users(id),
  ADD CONSTRAINT appointments_fee_currency CHECK (fee_amount IS NULL OR fee_currency IS NOT NULL);

-- A fee change tells live screens to refresh, like a status change does (ids only, no amounts or names).
CREATE FUNCTION appointment_fee_notify() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('waiting_room', json_build_object('organization_id', NEW.organization_id,
          'doctor_membership_id', NEW.doctor_membership_id, 'appointment_id', NEW.id, 'event', 'fee')::text);
  RETURN NEW;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
CREATE TRIGGER appointments_fee_notify AFTER UPDATE OF fee_amount, fee_currency ON appointments
  FOR EACH ROW WHEN (OLD.fee_amount IS DISTINCT FROM NEW.fee_amount OR OLD.fee_currency IS DISTINCT FROM NEW.fee_currency)
  EXECUTE FUNCTION appointment_fee_notify();

-- Live polling (hosts without a WebSocket) looks for recent calls, fees and completions in one workspace.
CREATE INDEX appointments_org_called ON appointments (organization_id, called_at) WHERE called_at IS NOT NULL;
CREATE INDEX appointments_org_fee ON appointments (organization_id, fee_set_at) WHERE fee_set_at IS NOT NULL;
