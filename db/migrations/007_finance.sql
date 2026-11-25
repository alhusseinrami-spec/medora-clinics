-- MEDORA CLINICS: migration 007, Release 3 business management.
-- Invoices (draft -> issued -> void), gap-free numbering at issue, credit notes, receipts, refunds,
-- frozen exchange rates and commission splits, expenses, insurance directory, policies and claims.

-- ---------- Exchange rates: history is permanent ----------
ALTER TABLE exchange_rates ADD COLUMN created_by uuid REFERENCES users(id), ADD COLUMN note text;
REVOKE UPDATE, DELETE ON exchange_rates FROM medora_app;
CREATE INDEX exchange_rates_org_idx ON exchange_rates (organization_id, effective_from DESC);

CREATE FUNCTION app_current_rate(p_org uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT lbp_per_usd FROM exchange_rates WHERE organization_id = p_org AND effective_from <= now()
   ORDER BY effective_from DESC LIMIT 1
$$;

-- ---------- Counters ----------
ALTER TABLE invoice_counters ADD COLUMN last_credit_note int NOT NULL DEFAULT 0, ADD COLUMN last_receipt int NOT NULL DEFAULT 0;

-- ---------- Invoices ----------
ALTER TABLE invoices
  ALTER COLUMN invoice_number DROP NOT NULL,
  ALTER COLUMN issued_at DROP NOT NULL,
  ALTER COLUMN issued_at DROP DEFAULT,
  ADD COLUMN status               text NOT NULL DEFAULT 'issued' CHECK (status IN ('draft','issued','void')),
  ADD COLUMN department_id        uuid,
  ADD COLUMN credit_for_invoice_id uuid,
  ADD COLUMN doctor_percent       numeric(5,2) CHECK (doctor_percent BETWEEN 0 AND 100),  -- commission frozen at issue
  ADD COLUMN notes                text,
  ADD COLUMN created_by           uuid REFERENCES users(id),
  ADD COLUMN issued_by            uuid REFERENCES users(id),
  ADD COLUMN void_reason          text,
  ADD COLUMN voided_at            timestamptz,
  ADD COLUMN created_at           timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at           timestamptz NOT NULL DEFAULT now();
ALTER TABLE invoices
  ADD CONSTRAINT invoices_id_org_uq UNIQUE (id, organization_id),
  ADD CONSTRAINT invoices_doctor_same_org FOREIGN KEY (doctor_membership_id, organization_id) REFERENCES memberships(id, organization_id),
  ADD CONSTRAINT invoices_department_same_org FOREIGN KEY (department_id, organization_id) REFERENCES departments(id, organization_id),
  ADD CONSTRAINT invoices_appointment_same_org FOREIGN KEY (appointment_id, organization_id) REFERENCES appointments(id, organization_id),
  ADD CONSTRAINT invoices_credit_same_org FOREIGN KEY (credit_for_invoice_id, organization_id) REFERENCES invoices(id, organization_id),
  ADD CONSTRAINT invoices_credit_note_target CHECK ((kind = 'credit_note') = (credit_for_invoice_id IS NOT NULL)),
  ADD CONSTRAINT invoices_number_when_issued CHECK ((status = 'draft') = (invoice_number IS NULL)),
  ADD CONSTRAINT invoices_issued_at_when_issued CHECK ((status = 'draft') = (issued_at IS NULL)),
  ADD CONSTRAINT invoices_void_consistent CHECK ((status = 'void') = (voided_at IS NOT NULL)),
  ADD CONSTRAINT invoices_amounts_positive CHECK (discount >= 0 AND tax >= 0);
ALTER TABLE invoices DROP CONSTRAINT invoices_organization_id_invoice_number_key;
CREATE UNIQUE INDEX invoices_number_uq ON invoices (organization_id, kind, invoice_number) WHERE invoice_number IS NOT NULL;
CREATE INDEX invoices_patient_idx ON invoices (patient_id, created_at DESC);
CREATE INDEX invoices_issued_idx ON invoices (organization_id, issued_at);
CREATE UNIQUE INDEX invoices_one_per_appointment ON invoices (appointment_id) WHERE appointment_id IS NOT NULL AND kind = 'invoice' AND status <> 'void';

-- Numbers are given when an invoice is issued, so drafts never leave gaps. The exchange rate and the
-- doctor's commission percentage are frozen at that moment too.
DROP TRIGGER invoices_numbering ON invoices;
CREATE OR REPLACE FUNCTION invoices_before_insert() RETURNS trigger AS $$
BEGIN
  IF NEW.lbp_per_usd IS NULL THEN
    NEW.lbp_per_usd := app_current_rate(NEW.organization_id);
    IF NEW.lbp_per_usd IS NULL THEN RAISE EXCEPTION 'Set the USD/LBP exchange rate in finance settings first'; END IF;
  END IF;
  IF NEW.status = 'issued' AND (TG_OP = 'INSERT' OR OLD.status = 'draft') THEN
    IF NEW.kind = 'credit_note' THEN
      INSERT INTO invoice_counters (organization_id, last_number, last_credit_note) VALUES (NEW.organization_id, 0, 1)
      ON CONFLICT (organization_id) DO UPDATE SET last_credit_note = invoice_counters.last_credit_note + 1
      RETURNING last_credit_note INTO NEW.invoice_number;
    ELSE
      INSERT INTO invoice_counters (organization_id, last_number) VALUES (NEW.organization_id, 1)
      ON CONFLICT (organization_id) DO UPDATE SET last_number = invoice_counters.last_number + 1
      RETURNING last_number INTO NEW.invoice_number;
    END IF;
    NEW.issued_at := now();
    IF NEW.doctor_percent IS NULL AND NEW.doctor_membership_id IS NOT NULL THEN
      NEW.doctor_percent := (SELECT doctor_percent FROM commission_rules WHERE membership_id = NEW.doctor_membership_id);
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
CREATE TRIGGER invoices_numbering BEFORE INSERT OR UPDATE OF status ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoices_before_insert();

-- An issued invoice is a fiscal document: frozen. It can only be voided (and only while nothing was paid).
CREATE FUNCTION invoices_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'an issued invoice cannot be deleted; void it or issue a credit note' USING ERRCODE = 'check_violation'; END IF;
    RETURN OLD;
  END IF;
  IF NEW.organization_id <> OLD.organization_id OR NEW.kind <> OLD.kind OR NEW.credit_for_invoice_id IS DISTINCT FROM OLD.credit_for_invoice_id THEN
    RAISE EXCEPTION 'invoice workspace and type cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'void' THEN RAISE EXCEPTION 'a void invoice cannot be changed' USING ERRCODE = 'check_violation'; END IF;
  IF OLD.status = 'issued' THEN
    IF NEW.status <> 'void' OR NEW.patient_id <> OLD.patient_id OR NEW.currency <> OLD.currency OR NEW.lbp_per_usd <> OLD.lbp_per_usd
       OR NEW.discount <> OLD.discount OR NEW.tax <> OLD.tax OR NEW.invoice_number <> OLD.invoice_number
       OR NEW.doctor_membership_id IS DISTINCT FROM OLD.doctor_membership_id OR NEW.doctor_percent IS DISTINCT FROM OLD.doctor_percent THEN
      RAISE EXCEPTION 'an issued invoice cannot be changed; issue a credit note instead' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM payments WHERE invoice_id = OLD.id) THEN
      RAISE EXCEPTION 'this invoice has payments; refund them or issue a credit note instead of voiding' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
CREATE TRIGGER invoices_guard BEFORE UPDATE OR DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION invoices_guard();

ALTER TABLE invoice_items
  ADD COLUMN kind     text NOT NULL DEFAULT 'service' CHECK (kind IN ('consultation','service','product','other')),
  ADD COLUMN position int NOT NULL DEFAULT 0,
  ADD CONSTRAINT invoice_items_amounts CHECK (quantity > 0 AND unit_price >= 0);
CREATE FUNCTION invoice_items_guard() RETURNS trigger AS $$
DECLARE iid uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
BEGIN
  IF (SELECT status FROM invoices WHERE id = iid) <> 'draft' THEN
    RAISE EXCEPTION 'lines of an issued invoice cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
CREATE TRIGGER invoice_items_guard BEFORE INSERT OR UPDATE OR DELETE ON invoice_items FOR EACH ROW EXECUTE FUNCTION invoice_items_guard();
-- ---------- Payments, receipts and refunds ----------
ALTER TABLE payments
  ADD COLUMN organization_id uuid REFERENCES organizations(id),
  ADD COLUMN receipt_number  int,
  ADD COLUMN reference       text,          -- card slip, transfer or Whish/OMT reference
  ADD COLUMN note            text,
  ADD COLUMN refund_of       uuid REFERENCES payments(id),
  ADD COLUMN claim_id        uuid;
UPDATE payments p SET organization_id = i.organization_id FROM invoices i WHERE i.id = p.invoice_id;
ALTER TABLE payments
  ALTER COLUMN organization_id SET NOT NULL,
  ADD CONSTRAINT payments_invoice_same_org FOREIGN KEY (invoice_id, organization_id) REFERENCES invoices(id, organization_id),
  ADD CONSTRAINT payments_nonzero CHECK (amount <> 0),
  ADD CONSTRAINT payments_refund_negative CHECK ((refund_of IS NULL AND amount > 0) OR (refund_of IS NOT NULL AND amount < 0));
CREATE UNIQUE INDEX payments_receipt_uq ON payments (organization_id, receipt_number);
CREATE INDEX payments_received_idx ON payments (organization_id, received_at);
REVOKE UPDATE, DELETE ON payments FROM medora_app;   -- money movements are never edited; refunds reverse them

CREATE FUNCTION payments_before_insert() RETURNS trigger AS $$
DECLARE inv invoices;
BEGIN
  SELECT * INTO inv FROM invoices WHERE id = NEW.invoice_id;
  IF NEW.organization_id IS NULL THEN NEW.organization_id := inv.organization_id; END IF;
  IF inv.status <> 'issued' OR inv.kind <> 'invoice' THEN
    RAISE EXCEPTION 'payments can only be recorded on an issued invoice' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.lbp_per_usd IS NULL THEN NEW.lbp_per_usd := coalesce(app_current_rate(NEW.organization_id), inv.lbp_per_usd); END IF;
  IF NEW.refund_of IS NOT NULL AND NOT EXISTS (SELECT 1 FROM payments WHERE id = NEW.refund_of AND invoice_id = NEW.invoice_id AND refund_of IS NULL) THEN
    RAISE EXCEPTION 'a refund must reverse a payment of the same invoice' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO invoice_counters (organization_id, last_number, last_receipt) VALUES (NEW.organization_id, 0, 1)
  ON CONFLICT (organization_id) DO UPDATE SET last_receipt = invoice_counters.last_receipt + 1
  RETURNING last_receipt INTO NEW.receipt_number;
  RETURN NEW;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
CREATE TRIGGER payments_before_insert BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION payments_before_insert();

-- ---------- Balances ----------
-- Amounts in the invoice's own currency. Payments in the other currency convert at the rate frozen on the payment.
DROP VIEW invoice_balances;
CREATE VIEW invoice_balances WITH (security_invoker = true) AS
  WITH lines AS (
    SELECT i.id, coalesce(sum(it.quantity * it.unit_price), 0) AS subtotal,
           coalesce(sum(it.quantity * it.unit_price) FILTER (WHERE it.insurance_covered), 0) AS covered_subtotal
      FROM invoices i LEFT JOIN invoice_items it ON it.invoice_id = i.id GROUP BY i.id)
  SELECT i.id AS invoice_id, i.organization_id, i.currency, i.kind, i.status,
         l.subtotal, l.covered_subtotal, i.discount, i.tax,
         l.subtotal - i.discount + i.tax AS total,
         coalesce((SELECT sum(cl.subtotal - cn.discount + cn.tax) FROM invoices cn JOIN lines cl ON cl.id = cn.id
                    WHERE cn.credit_for_invoice_id = i.id AND cn.status = 'issued'), 0) AS credited,
         coalesce((SELECT sum(CASE WHEN p.currency = i.currency THEN p.amount
                                   WHEN i.currency = 'USD' THEN p.amount / p.lbp_per_usd
                                   ELSE p.amount * p.lbp_per_usd END)
                     FROM payments p WHERE p.invoice_id = i.id), 0) AS paid
    FROM invoices i JOIN lines l ON l.id = i.id;
GRANT SELECT ON invoice_balances TO medora_app;

-- ---------- Expenses ----------
ALTER TABLE expenses
  ADD COLUMN description text,
  ADD COLUMN method_code text REFERENCES payment_methods(code),
  ADD COLUMN created_by  uuid REFERENCES users(id),
  ADD COLUMN created_at  timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN deleted_at  timestamptz,
  ADD CONSTRAINT expenses_positive CHECK (amount > 0),
  ADD CONSTRAINT expenses_member_same_org FOREIGN KEY (membership_id, organization_id) REFERENCES memberships(id, organization_id),
  ADD CONSTRAINT expenses_department_same_org FOREIGN KEY (department_id, organization_id) REFERENCES departments(id, organization_id);
ALTER TABLE expenses ALTER COLUMN lbp_per_usd DROP NOT NULL;
CREATE FUNCTION expenses_fill_rate() RETURNS trigger AS $$
BEGIN
  IF NEW.lbp_per_usd IS NULL THEN
    NEW.lbp_per_usd := app_current_rate(NEW.organization_id);
    IF NEW.lbp_per_usd IS NULL THEN RAISE EXCEPTION 'Set the USD/LBP exchange rate in finance settings first'; END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
CREATE TRIGGER expenses_fill_rate BEFORE INSERT ON expenses FOR EACH ROW EXECUTE FUNCTION expenses_fill_rate();
REVOKE DELETE ON expenses FROM medora_app;   -- removed expenses are kept with deleted_at

-- ---------- Commissions ----------
ALTER TABLE commission_rules ADD COLUMN updated_by uuid REFERENCES users(id), ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- ---------- Insurance ----------
ALTER TABLE insurance_providers
  ADD COLUMN phone     text,
  ADD COLUMN email     text,
  ADD COLUMN notes     text,
  ADD COLUMN is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX insurance_providers_name_uq ON insurance_providers (coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
-- Platform directory: only the public scheme is pre-filled. Private insurers are added by each workspace.
INSERT INTO insurance_providers (name, kind, notes)
VALUES ('NSSF (National Social Security Fund)', 'nssf', 'Public scheme. Claims are prepared here and submitted by the clinic; no electronic connection.')
ON CONFLICT DO NOTHING;
REVOKE UPDATE, DELETE ON insurance_providers FROM medora_app;
GRANT UPDATE (phone, email, notes, is_active, name) ON insurance_providers TO medora_app;

ALTER TABLE insurance_policies
  ADD COLUMN organization_id      uuid REFERENCES organizations(id),
  ADD COLUMN member_name          text,          -- if the insured member is not the patient
  ADD COLUMN relationship         text,
  ADD COLUMN coverage_percent     numeric(5,2) CHECK (coverage_percent BETWEEN 0 AND 100),
  ADD COLUMN annual_ceiling       numeric(14,2),
  ADD COLUMN covered_services     text,
  ADD COLUMN non_covered_services text,
  ADD COLUMN notes                text,
  ADD COLUMN valid_from           date,
  ADD COLUMN is_active            boolean NOT NULL DEFAULT true,
  ADD COLUMN created_by           uuid REFERENCES users(id),
  ADD COLUMN created_at           timestamptz NOT NULL DEFAULT now();
UPDATE insurance_policies ip SET organization_id = p.organization_id FROM patients p WHERE p.id = ip.patient_id;
ALTER TABLE insurance_policies
  ALTER COLUMN organization_id SET NOT NULL,
  ADD CONSTRAINT policies_id_org_uq UNIQUE (id, organization_id),
  ADD CONSTRAINT policies_patient_same_org FOREIGN KEY (patient_id, organization_id) REFERENCES patients(id, organization_id) ON DELETE CASCADE;
CREATE TRIGGER policies_fill_org BEFORE INSERT ON insurance_policies FOR EACH ROW EXECUTE FUNCTION fill_org_from_patient();

ALTER TABLE claims
  ADD COLUMN organization_id uuid REFERENCES organizations(id),
  ADD COLUMN claim_number    text,          -- the insurer's reference, once known
  ADD COLUMN notes           text,
  ADD COLUMN decided_at      timestamptz,
  ADD COLUMN created_by      uuid REFERENCES users(id),
  ADD COLUMN created_at      timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at      timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN reimbursed_payment_id uuid REFERENCES payments(id),
  ADD CONSTRAINT claims_amounts CHECK (amount_claimed > 0 AND (amount_approved IS NULL OR amount_approved >= 0));
UPDATE claims c SET organization_id = i.organization_id FROM invoices i WHERE i.id = c.invoice_id;
ALTER TABLE claims
  ALTER COLUMN organization_id SET NOT NULL,
  ADD CONSTRAINT claims_id_org_uq UNIQUE (id, organization_id),
  ADD CONSTRAINT claims_invoice_same_org FOREIGN KEY (invoice_id, organization_id) REFERENCES invoices(id, organization_id),
  ADD CONSTRAINT claims_policy_same_org FOREIGN KEY (policy_id, organization_id) REFERENCES insurance_policies(id, organization_id);
ALTER TABLE payments ADD CONSTRAINT payments_claim_same_org FOREIGN KEY (claim_id, organization_id) REFERENCES claims(id, organization_id);
REVOKE DELETE ON claims FROM medora_app;

-- Claim status moves forward only.
CREATE FUNCTION claims_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.invoice_id <> OLD.invoice_id OR NEW.policy_id <> OLD.policy_id OR NEW.organization_id <> OLD.organization_id THEN
    RAISE EXCEPTION 'claim invoice, policy and workspace cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status = 'submitted')
    OR (OLD.status = 'submitted' AND NEW.status IN ('approved','partially_approved','rejected'))
    OR (OLD.status IN ('approved','partially_approved') AND NEW.status = 'reimbursed')) THEN
    RAISE EXCEPTION 'a claim cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'draft' AND NEW.amount_claimed <> OLD.amount_claimed THEN
    RAISE EXCEPTION 'the claimed amount is fixed once submitted' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER claims_guard BEFORE UPDATE ON claims FOR EACH ROW EXECUTE FUNCTION claims_guard();

ALTER TABLE claim_documents ADD COLUMN organization_id uuid REFERENCES organizations(id);
UPDATE claim_documents cd SET organization_id = c.organization_id FROM claims c WHERE c.id = cd.claim_id;
ALTER TABLE claim_documents ALTER COLUMN organization_id SET NOT NULL,
  ADD CONSTRAINT claim_documents_claim_same_org FOREIGN KEY (claim_id, organization_id) REFERENCES claims(id, organization_id) ON DELETE CASCADE;
ALTER TABLE medical_documents ADD CONSTRAINT documents_id_org_uq UNIQUE (id, organization_id);
ALTER TABLE claim_documents ADD CONSTRAINT claim_documents_doc_same_org FOREIGN KEY (document_id, organization_id) REFERENCES medical_documents(id, organization_id);

-- ---------- Row-level security ----------
-- Who sees money: org-wide finance staff see the whole workspace; a doctor sees their own invoices.
CREATE FUNCTION app_can_see_finance_of(p_org uuid, p_doctor uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT app_is_member(p_org) AND (app_has_perm('finance.view') OR app_has_perm('payment.register') OR app_has_perm('insurance.manage'))
     AND (app_is_org_wide() OR (p_doctor IS NOT NULL AND app_acts_for(p_doctor)))
$$;

DROP POLICY invoices_read ON invoices;
DROP POLICY invoices_write ON invoices;
CREATE POLICY invoices_read ON invoices FOR SELECT USING (app_can_see_finance_of(organization_id, doctor_membership_id));
CREATE POLICY invoices_insert ON invoices FOR INSERT WITH CHECK (
  app_is_member(organization_id) AND app_has_perm('payment.register') AND app_can_see_patient(patient_id, organization_id)
  AND (app_is_org_wide() OR (doctor_membership_id IS NOT NULL AND app_acts_for(doctor_membership_id))));
CREATE POLICY invoices_update ON invoices FOR UPDATE USING (
  app_can_see_finance_of(organization_id, doctor_membership_id) AND app_has_perm('payment.register'))
  WITH CHECK (app_is_member(organization_id) AND (app_is_org_wide() OR (doctor_membership_id IS NOT NULL AND app_acts_for(doctor_membership_id))));
CREATE POLICY invoices_delete ON invoices FOR DELETE USING (
  status = 'draft' AND app_can_see_finance_of(organization_id, doctor_membership_id) AND app_has_perm('payment.register'));

DROP POLICY payments_read ON payments;
DROP POLICY payments_write ON payments;
CREATE POLICY payments_read ON payments FOR SELECT USING (app_is_member(organization_id) AND EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_id));
-- Collecting money needs payment.register; refunds need finance.view as well; insurance reimbursements need insurance.manage.
CREATE POLICY payments_insert ON payments FOR INSERT WITH CHECK (
  app_is_member(organization_id) AND received_by = app_user_id() AND EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_id)
  AND CASE WHEN refund_of IS NOT NULL THEN app_has_perm('payment.register') AND app_has_perm('finance.view')
           WHEN claim_id IS NOT NULL THEN app_has_perm('insurance.manage')
           ELSE app_has_perm('payment.register') END);

DROP POLICY expenses_rw ON expenses;
CREATE POLICY expenses_read ON expenses FOR SELECT USING (
  app_is_member(organization_id) AND app_has_perm('finance.view')
  AND (app_is_org_wide() OR (membership_id IS NOT NULL AND app_acts_for(membership_id))));
CREATE POLICY expenses_insert ON expenses FOR INSERT WITH CHECK (
  app_is_member(organization_id) AND app_has_perm('finance.view') AND created_by = app_user_id()
  AND (app_is_org_wide() OR (membership_id IS NOT NULL AND app_acts_for(membership_id))));
CREATE POLICY expenses_update ON expenses FOR UPDATE USING (
  app_is_member(organization_id) AND app_has_perm('finance.view')
  AND (app_is_org_wide() OR (membership_id IS NOT NULL AND app_acts_for(membership_id))))
  WITH CHECK (app_is_member(organization_id) AND (app_is_org_wide() OR (membership_id IS NOT NULL AND app_acts_for(membership_id))));

-- Commission rules: org-wide finance staff read all and org managers set them; a doctor reads their own.
DROP POLICY commissions_rw ON commission_rules;
CREATE POLICY commissions_read ON commission_rules FOR SELECT USING (EXISTS (SELECT 1 FROM memberships m WHERE m.id = membership_id
  AND app_is_member(m.organization_id) AND ((app_is_org_wide() AND app_has_perm('finance.view')) OR m.user_id = app_user_id())));
CREATE POLICY commissions_write ON commission_rules FOR ALL USING (EXISTS (SELECT 1 FROM memberships m WHERE m.id = membership_id
  AND m.organization_id = app_org_id() AND app_is_member(m.organization_id)) AND app_is_org_wide() AND app_has_perm('org.manage') AND app_has_perm('finance.view'))
  WITH CHECK (EXISTS (SELECT 1 FROM memberships m WHERE m.id = membership_id AND m.organization_id = app_org_id() AND m.role_code = 'doctor')
  AND app_is_org_wide() AND app_has_perm('org.manage') AND app_has_perm('finance.view'));

DROP POLICY providers_write ON insurance_providers;
CREATE POLICY providers_insert ON insurance_providers FOR INSERT WITH CHECK (
  organization_id IS NOT NULL AND organization_id = app_org_id() AND app_is_member(organization_id) AND app_has_perm('insurance.manage'));
CREATE POLICY providers_update ON insurance_providers FOR UPDATE USING (
  organization_id IS NOT NULL AND app_is_member(organization_id) AND app_has_perm('insurance.manage'))
  WITH CHECK (app_is_member(organization_id));

DROP POLICY policies_rw ON insurance_policies;
CREATE POLICY policies_read ON insurance_policies FOR SELECT USING (
  app_is_member(organization_id) AND app_can_see_patient(patient_id, organization_id));
CREATE POLICY policies_write ON insurance_policies FOR INSERT WITH CHECK (
  app_is_member(organization_id) AND app_can_see_patient(patient_id, organization_id)
  AND (app_has_perm('insurance.manage') OR app_has_perm('patient.register')));
CREATE POLICY policies_update ON insurance_policies FOR UPDATE USING (
  app_is_member(organization_id) AND app_can_see_patient(patient_id, organization_id)
  AND (app_has_perm('insurance.manage') OR app_has_perm('patient.register')))
  WITH CHECK (app_is_member(organization_id));

DROP POLICY claims_rw ON claims;
CREATE POLICY claims_read ON claims FOR SELECT USING (app_is_member(organization_id) AND EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_id));
CREATE POLICY claims_insert ON claims FOR INSERT WITH CHECK (
  app_is_member(organization_id) AND app_has_perm('insurance.manage') AND created_by = app_user_id()
  AND EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_id) AND EXISTS (SELECT 1 FROM insurance_policies p WHERE p.id = policy_id));
CREATE POLICY claims_update ON claims FOR UPDATE USING (
  app_is_member(organization_id) AND app_has_perm('insurance.manage') AND EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_id))
  WITH CHECK (app_is_member(organization_id));

DROP POLICY claim_documents_rw ON claim_documents;
CREATE POLICY claim_documents_read ON claim_documents FOR SELECT USING (app_is_member(organization_id) AND EXISTS (SELECT 1 FROM claims c WHERE c.id = claim_id));
CREATE POLICY claim_documents_write ON claim_documents FOR ALL USING (
  app_is_member(organization_id) AND app_has_perm('insurance.manage') AND EXISTS (SELECT 1 FROM claims c WHERE c.id = claim_id))
  WITH CHECK (app_is_member(organization_id) AND app_has_perm('insurance.manage')
  AND EXISTS (SELECT 1 FROM claims c WHERE c.id = claim_id) AND EXISTS (SELECT 1 FROM medical_documents d WHERE d.id = document_id));

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO medora_app;
