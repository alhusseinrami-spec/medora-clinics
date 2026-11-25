// Tenant isolation tests. Runs every check as medora_app (the API's role), never as the owner.
// Usage: node db/rls_test.js   (resets the dev database first)
const { Client } = require('pg');
const { randomUUID: uuid } = require('crypto');
const OWNER = process.env.DATABASE_URL || 'postgres://medora:medora_dev@localhost:5432/medora';
const APP = process.env.APP_DATABASE_URL || 'postgres://medora_app:medora_app_dev@localhost:5432/medora';

(async () => {
  await require('./migrate').migrate({ reset: true, log: () => {} });
  const c = new Client(APP); await c.connect();
  const results = [];
  const check = (name, ok) => results.push([ok ? 'ok' : 'FAIL', name]);

  // Run fn inside a transaction with the given user/org context, like the API does.
  async function as(user, org, fn) {
    await c.query('BEGIN');
    try {
      await c.query(`SELECT set_config('app.user_id', $1, true), set_config('app.org_id', $2, true)`, [user || '', org || '']);
      const r = await fn((q, p) => c.query(q, p));
      await c.query('COMMIT'); return r;
    } catch (e) { await c.query('ROLLBACK'); throw e; }
  }
  const fails = async (user, org, fn) => { try { await as(user, org, fn); return false; } catch { return true; } };
  const count = async (user, org, sql, p) => as(user, org, async q => (await q(sql, p)).rowCount);

  // ---- Bootstrap through the same functions registration uses ----
  async function signup(email, name) {
    const id = uuid();
    await as(id, null, q => q(`INSERT INTO users(id,email,full_name,password_hash) VALUES($1,$2,$3,'x')`, [id, email, name]));
    return id;
  }
  async function newOrg(user, kind, name, role, specialty) {
    const org = uuid();
    const mid = await as(user, null, async q => (await q(`SELECT app_create_organization($1,$2,$3,$4,$5,null,null) m`, [org, kind, name, role, specialty])).rows[0].m);
    return { org, mid };
  }
  const drA = await signup('dra@test.medora', 'Dr Alia');
  const drB = await signup('drb@test.medora', 'Dr Bassam');
  const drC = await signup('drc@test.medora', 'Dr Carla');
  const owner = await signup('owner@test.medora', 'Center Owner');
  const admin = await signup('admin@test.medora', 'Center Admin');
  const asst = await signup('asst@test.medora', 'Assistant of A');

  const center = await newOrg(owner, 'medical_center', 'Cedars Medical Center', 'center_owner', null);
  const solo = await newOrg(drC, 'independent_practice', 'Dr Carla Clinic', 'doctor', 'dermatology');

  // Invitations: owner invites Dr A, Dr B, admin and the assistant (assigned to Dr A after A joins).
  async function invite(email, role, extra = {}) {
    const tok = uuid();
    await as(owner, center.org, q => q(`INSERT INTO invitations(organization_id,email,role_code,specialty_code,assign_to_doctor_membership_id,token_hash,invited_by)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [center.org, email, role, extra.specialty || null, extra.assignTo || null, tok, owner]));
    return tok;
  }
  const accept = async (user, tok) => as(user, null, async q => (await q(`SELECT * FROM app_accept_invitation($1)`, [tok])).rows[0].membership_id);
  const mA = await accept(drA, await invite('dra@test.medora', 'doctor', { specialty: 'pediatrics' }));
  const mB = await accept(drB, await invite('drb@test.medora', 'doctor', { specialty: 'cardiology' }));
  await accept(admin, await invite('admin@test.medora', 'center_admin'));
  const mAs = await accept(asst, await invite('asst@test.medora', 'assistant', { assignTo: mA }));
  check('invitation for another email is refused', await fails(drC, null, async q => q(`SELECT * FROM app_accept_invitation($1)`, [await invite('someone@test.medora', 'doctor')])));

  // Patients: one for Dr A, one for Dr B (center), one for Dr C (other tenant).
  async function addPatient(user, org, doctorMid, name, phone) {
    const id = uuid();
    await as(user, org, async q => {
      await q(`INSERT INTO patients(id,organization_id,full_name,phone,date_of_birth,created_by) VALUES($1,$2,$3,$4,'2020-05-01',$5)`, [id, org, name, phone, user]);
      await q(`INSERT INTO patient_memberships(patient_id,membership_id,linked_by) VALUES($1,$2,$3)`, [id, doctorMid, user]);
    });
    return id;
  }
  const pA = await addPatient(asst, center.org, mA, 'Synthetic Child One', '+961 3 111111');
  const pB = await addPatient(drB, center.org, mB, 'Synthetic Adult Two', '+961 3 222222');
  const pC = await addPatient(drC, solo.org, solo.mid, 'Synthetic Patient Three', '+961 3 333333');

  // ---- Role setup ----
  const roleInfo = (await c.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`)).rows[0];
  check('app role is not superuser and cannot bypass RLS', !roleInfo.rolsuper && !roleInfo.rolbypassrls);

  // ---- Cross-tenant isolation ----
  check('no context sees no patients', (await count(null, null, `SELECT 1 FROM patients`)) === 0);
  check('Dr C sees only own tenant patients', (await count(drC, solo.org, `SELECT 1 FROM patients`)) === 1);
  check('forged org id without membership sees nothing', (await count(drC, center.org, `SELECT 1 FROM patients`)) === 0);
  check('forged org id cannot insert a patient', await fails(drC, center.org, q => q(`INSERT INTO patients(organization_id,full_name) VALUES($1,'X')`, [center.org])));
  check('cannot update another tenant patient', (await as(drC, solo.org, async q => (await q(`UPDATE patients SET full_name='hacked' WHERE id=$1`, [pA])).rowCount)) === 0);
  check('cross-tenant appointment reference rejected', await fails(drC, solo.org, q => q(
    `INSERT INTO appointments(organization_id,doctor_membership_id,patient_id,starts_at,ends_at) VALUES($1,$2,$3,now(),now()+interval '20 min')`, [solo.org, solo.mid, pA])));
  check('cannot book another tenant doctor', await fails(drC, solo.org, q => q(
    `INSERT INTO appointments(organization_id,doctor_membership_id,patient_id,starts_at,ends_at) VALUES($1,$2,$3,now(),now()+interval '20 min')`, [solo.org, mA, pC])));
  check('orgs list shows only own workspaces', (await count(drA, center.org, `SELECT 1 FROM organizations`)) === 1);
  check('users list hides other tenants', (await count(drC, solo.org, `SELECT 1 FROM users`)) === 1);

  // ---- Inside the center: doctor scoping ----
  const appt = uuid();
  await as(asst, center.org, q => q(`INSERT INTO appointments(id,organization_id,doctor_membership_id,patient_id,starts_at,ends_at)
    VALUES($1,$2,$3,$4,now()+interval '1 hour',now()+interval '80 min')`, [appt, center.org, mA, pA]));
  await as(drB, center.org, q => q(`INSERT INTO appointments(organization_id,doctor_membership_id,patient_id,starts_at,ends_at)
    VALUES($1,$2,$3,now()+interval '1 hour',now()+interval '80 min')`, [center.org, mB, pB]));
  check("assistant sees only assigned doctor's patients", (await count(asst, center.org, `SELECT 1 FROM patients`)) === 1);
  check("assistant sees only assigned doctor's appointments", (await count(asst, center.org, `SELECT 1 FROM appointments`)) === 1);
  check("assistant cannot book for another doctor", await fails(asst, center.org, q => q(
    `INSERT INTO appointments(organization_id,doctor_membership_id,patient_id,starts_at,ends_at) VALUES($1,$2,$3,now()+interval '3 hour',now()+interval '200 min')`, [center.org, mB, pB])));
  check("Dr B cannot link Dr A's patient to himself to gain access", await fails(drB, center.org, q => q(
    `INSERT INTO patient_memberships(patient_id,membership_id) VALUES($1,$2)`, [pA, mB])));
  check("Dr B cannot see Dr A's patient", (await count(drB, center.org, `SELECT 1 FROM patients WHERE id=$1`, [pA])) === 0);
  check('center admin sees all center patients', (await count(admin, center.org, `SELECT 1 FROM patients`)) === 2);

  // Duplicate detection finds Dr A's patient for Dr B, masked.
  const dup = await as(drB, center.org, async q => (await q(`SELECT * FROM app_find_duplicate_patients('Synthetic Child One', null, null)`)).rows);
  check('duplicate detection finds hidden patient with masked name only', dup.length === 1 && dup[0].visible === false && !dup[0].masked_name.includes('Child'));

  // ---- Clinical confidentiality ----
  await as(drA, center.org, q => q(`INSERT INTO consultations(patient_id,doctor_membership_id,specialty_code,clinical_notes) VALUES($1,$2,'pediatrics','confidential note')`, [pA, mA]));
  check('treating doctor reads own consultation', (await count(drA, center.org, `SELECT 1 FROM consultations`)) === 1);
  check('center admin cannot read clinical notes by default', (await count(admin, center.org, `SELECT 1 FROM consultations`)) === 0);
  check('assistant cannot read clinical notes by default', (await count(asst, center.org, `SELECT 1 FROM consultations`)) === 0);
  check('assistant cannot write a consultation', await fails(asst, center.org, q => q(
    `INSERT INTO consultations(patient_id,doctor_membership_id,specialty_code) VALUES($1,$2,'pediatrics')`, [pA, mA])));
  check('assistant cannot issue a prescription', await fails(asst, center.org, q => q(
    `INSERT INTO prescriptions(patient_id,prescribed_by) VALUES($1,$2)`, [pA, mAs])));
  check('assistant cannot grant own permissions', await fails(asst, center.org, q => q(
    `INSERT INTO membership_permissions(membership_id,permission_code) VALUES($1,'clinical_notes.read')`, [mAs])));
  check('prescription.create cannot be granted to an assistant', await fails(owner, center.org, q => q(
    `INSERT INTO membership_permissions(membership_id,permission_code) VALUES($1,'prescription.create')`, [mAs])));

  // Explicit grant opens clinical notes to the center admin (section 2.B).
  const mAdmin = (await c.query(`SELECT 1`), await as(admin, center.org, async q => (await q(`SELECT id FROM memberships WHERE user_id=$1 AND organization_id=$2`, [admin, center.org])).rows[0].id));
  await as(owner, center.org, q => q(`INSERT INTO membership_permissions(membership_id,permission_code,granted_by) VALUES($1,'clinical_notes.read',$2)`, [mAdmin, owner]));
  check('explicit clinical_notes.read grant lets the admin read notes', (await count(admin, center.org, `SELECT 1 FROM consultations`)) === 1);

  // ---- Release 2: signed records, prescriptions, documents ----
  const cons = await as(drA, center.org, async q => (await q(`SELECT id FROM consultations WHERE patient_id=$1`, [pA])).rows[0].id);
  check("Dr C cannot write a consultation for a center patient from her own workspace", await fails(drC, solo.org, q => q(
    `INSERT INTO consultations(organization_id,patient_id,doctor_membership_id,specialty_code) VALUES($1,$2,$3,'dermatology')`, [solo.org, pA, solo.mid])));
  check("Dr B cannot write a consultation for Dr A's patient", await fails(drB, center.org, q => q(
    `INSERT INTO consultations(patient_id,doctor_membership_id,specialty_code) VALUES($1,$2,'cardiology')`, [pA, mB])));
  check('addendum on a draft consultation is refused', await fails(drA, center.org, q => q(
    `INSERT INTO consultation_addenda(organization_id,consultation_id,author_membership_id,body) VALUES($1,$2,$3,'x')`, [center.org, cons, mA])));
  await as(drA, center.org, q => q(`INSERT INTO diagnoses(consultation_id,description) VALUES($1,'Acute otitis media')`, [cons]));
  await as(drA, center.org, q => q(`UPDATE consultations SET status='signed', signed_at=now(), signed_by=$2 WHERE id=$1`, [cons, drA]));
  check('signed consultation cannot be edited', await fails(drA, center.org, q => q(`UPDATE consultations SET clinical_notes='changed' WHERE id=$1`, [cons])));
  await fails(drA, center.org, q => q(`DELETE FROM consultations WHERE id=$1`, [cons]));
  check('signed consultation cannot be deleted', (await count(drA, center.org, `SELECT 1 FROM consultations WHERE id=$1`, [cons])) === 1);
  check('diagnoses of a signed consultation are frozen', await fails(drA, center.org, q => q(`INSERT INTO diagnoses(consultation_id,description) VALUES($1,'late')`, [cons])));
  await as(drA, center.org, q => q(`INSERT INTO consultation_addenda(organization_id,consultation_id,author_membership_id,body) VALUES($1,$2,$3,'Correction')`, [center.org, cons, mA]));
  check('addenda are append-only', await fails(drA, center.org, q => q(`UPDATE consultation_addenda SET body='x'`)));
  check('Dr B cannot read the addendum', (await count(drB, center.org, `SELECT 1 FROM consultation_addenda`)) === 0);

  const rx = await as(drA, center.org, async q => (await q(`INSERT INTO prescriptions(patient_id,prescribed_by,consultation_id) VALUES($1,$2,$3) RETURNING id`, [pA, mA, cons])).rows[0].id);
  await as(drA, center.org, q => q(`INSERT INTO prescription_items(prescription_id,medication_name,dosage) VALUES($1,'Amoxicillin 250 mg/5 ml','5 ml')`, [rx]));
  await as(drA, center.org, q => q(`UPDATE prescriptions SET status='issued', issued_at=now() WHERE id=$1`, [rx]));
  check('issued prescription items are frozen', await fails(drA, center.org, q => q(`UPDATE prescription_items SET dosage='10 ml' WHERE prescription_id=$1`, [rx])));
  check('issued prescription cannot go back to draft', await fails(drA, center.org, q => q(`UPDATE prescriptions SET status='draft', issued_at=null WHERE id=$1`, [rx])));
  check('center admin cannot read prescriptions without the permission', (await count(admin, center.org, `SELECT 1 FROM prescriptions`)) === 0);
  check('Dr C sees no center prescriptions', (await count(drC, solo.org, `SELECT 1 FROM prescriptions`)) === 0);
  check('shared medication catalog cannot be edited by the app', await fails(drA, center.org, q => q(`UPDATE medications SET name='x'`)));
  check('assistant cannot add medications to the catalog', await fails(asst, center.org, q => q(
    `INSERT INTO medications(organization_id,name,created_by) VALUES($1,'Custom',$2)`, [center.org, asst])));
  await as(drC, solo.org, q => q(`INSERT INTO medications(organization_id,name,created_by) VALUES($1,'Clinic compound cream',$2)`, [solo.org, drC]));
  check("a workspace's own medication is invisible elsewhere", (await count(drA, center.org, `SELECT 1 FROM medications WHERE name='Clinic compound cream'`)) === 0);

  await as(asst, center.org, q => q(`INSERT INTO medical_documents(patient_id,uploaded_by,kind,storage_key,title) VALUES($1,$2,'lab_result','k1','CBC')`, [pA, asst]));
  await as(drA, center.org, q => q(`INSERT INTO medical_documents(patient_id,uploaded_by,kind,storage_key,title) VALUES($1,$2,'imaging','k2','X-ray')`, [pA, drA]));
  check('assistant sees only the document they uploaded', (await count(asst, center.org, `SELECT 1 FROM medical_documents`)) === 1);
  check('treating doctor sees both documents', (await count(drA, center.org, `SELECT 1 FROM medical_documents`)) === 2);
  check("Dr B cannot see Dr A's patient documents", (await count(drB, center.org, `SELECT 1 FROM medical_documents`)) === 0);
  check('documents cannot be hard-deleted', await fails(drA, center.org, q => q(`DELETE FROM medical_documents`)));
  check('stored file of a document cannot be swapped', await fails(drA, center.org, q => q(`UPDATE medical_documents SET storage_key='other' WHERE title='X-ray'`)));

  // ---- Release 3: finance and insurance ----
  const acct = await signup('acct@test.medora', 'Center Accountant');
  await accept(acct, await invite('acct@test.medora', 'accountant'));
  check('a doctor cannot set the exchange rate of the center', await fails(drA, center.org, q => q(`INSERT INTO exchange_rates(organization_id,lbp_per_usd) VALUES($1,1)`, [center.org])));
  await as(owner, center.org, q => q(`INSERT INTO exchange_rates(organization_id,lbp_per_usd,created_by) VALUES($1,89500,$2)`, [center.org, owner]));
  check('exchange rate history cannot be rewritten', await fails(owner, center.org, q => q(`UPDATE exchange_rates SET lbp_per_usd=1`)));
  await as(owner, center.org, q => q(`INSERT INTO commission_rules(membership_id,doctor_percent,updated_by) VALUES($1,60,$2)`, [mA, owner]));
  await fails(drA, center.org, q => q(`UPDATE commission_rules SET doctor_percent=100 WHERE membership_id=$1`, [mA]));
  check('a doctor cannot change their own commission', (await count(owner, center.org, `SELECT 1 FROM commission_rules WHERE doctor_percent=60`)) === 1);
  const inv = await as(drA, center.org, async q => {
    const i = (await q(`INSERT INTO invoices(organization_id,patient_id,doctor_membership_id,currency,status,created_by) VALUES($1,$2,$3,'USD','draft',$4) RETURNING id`, [center.org, pA, mA, drA])).rows[0].id;
    await q(`INSERT INTO invoice_items(invoice_id,description,unit_price,kind,insurance_covered) VALUES($1,'Consultation',50,'consultation',true)`, [i]);
    return (await q(`UPDATE invoices SET status='issued' WHERE id=$1 RETURNING id, invoice_number, doctor_percent`, [i])).rows[0];
  });
  check('issuing numbers the invoice and freezes the commission', inv.invoice_number === 1 && +inv.doctor_percent === 60);
  check('issued invoice lines are frozen', await fails(drA, center.org, q => q(`INSERT INTO invoice_items(invoice_id,description,unit_price) VALUES($1,'Extra',10)`, [inv.id])));
  check('issued invoice amounts are frozen', await fails(drA, center.org, q => q(`UPDATE invoices SET discount=10 WHERE id=$1`, [inv.id])));
  check("Dr B cannot see Dr A's invoice", (await count(drB, center.org, `SELECT 1 FROM invoices`)) === 0);
  check('the accountant sees every center invoice', (await count(acct, center.org, `SELECT 1 FROM invoices`)) === 1);
  check('Dr C sees no center invoice', (await count(drC, solo.org, `SELECT 1 FROM invoices WHERE organization_id=$1`, [center.org])) === 0);
  check("Dr B cannot bill Dr A's patient", await fails(drB, center.org, q => q(
    `INSERT INTO invoices(organization_id,patient_id,doctor_membership_id,currency,status) VALUES($1,$2,$3,'USD','draft')`, [center.org, pA, mB])));
  check('an assistant without the payment permission cannot take payments', await fails(asst, center.org, q => q(
    `INSERT INTO payments(invoice_id,method_code,amount,currency,received_by) VALUES($1,'cash',10,'USD',$2)`, [inv.id, asst])));
  const pay = await as(drA, center.org, async q => (await q(`INSERT INTO payments(invoice_id,method_code,amount,currency,received_by) VALUES($1,'cash',20,'USD',$2) RETURNING id, receipt_number`, [inv.id, drA])).rows[0]);
  check('payments get a receipt number', pay.receipt_number === 1);
  check('payments cannot be edited', await fails(drA, center.org, q => q(`UPDATE payments SET amount=1`)));
  check('payments cannot be deleted', await fails(drA, center.org, q => q(`DELETE FROM payments`)));
  check('an invoice with payments cannot be voided', await fails(drA, center.org, q => q(`UPDATE invoices SET status='void', voided_at=now(), void_reason='x' WHERE id=$1`, [inv.id])));
  check('a payment cannot be recorded for another workspace', await fails(drC, solo.org, q => q(
    `INSERT INTO payments(organization_id,invoice_id,method_code,amount,currency,received_by) VALUES($1,$2,'cash',5,'USD',$3)`, [solo.org, inv.id, drC])));
  await as(acct, center.org, q => q(`INSERT INTO payments(invoice_id,method_code,amount,currency,received_by,refund_of) VALUES($1,'cash',-5,'USD',$2,$3)`, [inv.id, acct, pay.id]));
  const bal = await as(drA, center.org, async q => (await q(`SELECT total, paid FROM invoice_balances WHERE invoice_id=$1`, [inv.id])).rows[0]);
  check('refund reduces the amount paid', +bal.total === 50 && +bal.paid === 15);

  await as(drA, center.org, q => q(`INSERT INTO expenses(organization_id,membership_id,category,amount,currency,created_by) VALUES($1,$2,'supplies',30,'USD',$3)`, [center.org, mA, drA]));
  await as(acct, center.org, q => q(`INSERT INTO expenses(organization_id,category,amount,currency,created_by) VALUES($1,'rent',1000,'USD',$2)`, [center.org, acct]));
  check("a doctor sees only their own expenses", (await count(drA, center.org, `SELECT 1 FROM expenses`)) === 1);
  check("Dr B sees none of Dr A's expenses", (await count(drB, center.org, `SELECT 1 FROM expenses`)) === 0);
  check('the accountant sees all center expenses', (await count(acct, center.org, `SELECT 1 FROM expenses`)) === 2);
  check('a doctor cannot record a shared center expense', await fails(drA, center.org, q => q(
    `INSERT INTO expenses(organization_id,category,amount,currency,created_by) VALUES($1,'rent',5,'USD',$2)`, [center.org, drA])));
  check('expenses are never hard-deleted', await fails(acct, center.org, q => q(`DELETE FROM expenses`)));

  const prov = await as(drA, center.org, async q => (await q(`INSERT INTO insurance_providers(organization_id,name,kind) VALUES($1,'Synthetic Assurance','private') RETURNING id`, [center.org])).rows[0].id);
  await fails(drA, center.org, q => q(`UPDATE insurance_providers SET name='x' WHERE organization_id IS NULL`));
  check('the platform directory cannot be edited by a workspace', (await count(drA, center.org, `SELECT 1 FROM insurance_providers WHERE organization_id IS NULL AND name LIKE 'NSSF%'`)) === 1);
  check("another workspace's insurer is invisible", (await count(drC, solo.org, `SELECT 1 FROM insurance_providers WHERE id=$1`, [prov])) === 0);
  const pol = await as(drA, center.org, async q => (await q(`INSERT INTO insurance_policies(patient_id,provider_id,policy_number,coverage_percent,created_by) VALUES($1,$2,'SYN-1',80,$3) RETURNING id`, [pA, prov, drA])).rows[0].id);
  check("Dr B cannot see Dr A's patient's policy", (await count(drB, center.org, `SELECT 1 FROM insurance_policies`)) === 0);
  check('an assistant cannot prepare an insurance claim', await fails(asst, center.org, q => q(
    `INSERT INTO claims(organization_id,invoice_id,policy_id,amount_claimed,created_by) VALUES($1,$2,$3,40,$4)`, [center.org, inv.id, pol, asst])));
  const claim = await as(drA, center.org, async q => (await q(`INSERT INTO claims(organization_id,invoice_id,policy_id,amount_claimed,created_by) VALUES($1,$2,$3,40,$4) RETURNING id`, [center.org, inv.id, pol, drA])).rows[0].id);
  check('a claim cannot jump from draft to reimbursed', await fails(drA, center.org, q => q(`UPDATE claims SET status='reimbursed' WHERE id=$1`, [claim])));
  await as(drA, center.org, q => q(`UPDATE claims SET status='submitted', submitted_at=now() WHERE id=$1`, [claim]));
  check('the claimed amount is fixed once submitted', await fails(drA, center.org, q => q(`UPDATE claims SET amount_claimed=45 WHERE id=$1`, [claim])));
  check('Dr C cannot see center claims', (await count(drC, solo.org, `SELECT 1 FROM claims`)) === 0);

  // ---- Waiting room and notifications ----
  await as(asst, center.org, q => q(`UPDATE appointments SET status='arrived' WHERE id=$1`, [appt]));
  check('doctor sees arrival in waiting room', (await count(drA, center.org, `SELECT 1 FROM waiting_room`)) === 1);
  check('other doctor does not see that waiting room entry', (await count(drB, center.org, `SELECT 1 FROM waiting_room`)) === 0);
  check('doctor got the arrival notification', (await count(drA, null, `SELECT 1 FROM notifications WHERE kind='patient_arrived'`)) === 1);
  check('notifications are private to their user', (await count(asst, center.org, `SELECT 1 FROM notifications`)) === 0);

  // ---- Release 4: communication ----
  const own = new Client(OWNER); await own.connect();
  await own.query(`INSERT INTO whatsapp_accounts(organization_id,membership_id,phone_number_id,display_number,access_token_enc,status)
    VALUES($1,$2,'900000000000001','+961 1 000 000','v1.synthetic','connected')`, [center.org, mA]);
  check('the app role cannot read WhatsApp access tokens', await fails(drA, center.org, q => q(`SELECT access_token_enc FROM whatsapp_accounts`)));
  check('Dr A sees their own WhatsApp number', (await count(drA, center.org, `SELECT id FROM whatsapp_accounts`)) === 1);
  check("Dr B does not see Dr A's number", (await count(drB, center.org, `SELECT id FROM whatsapp_accounts`)) === 0);
  await own.query(`SELECT comm_inbound('900000000000001','96170000099','Synthetic hello','wamid.rls.1', now())`);
  check('Dr A sees the conversation on their number', (await count(drA, center.org, `SELECT 1 FROM whatsapp_conversations`)) === 1);
  check("Dr B cannot see Dr A's conversations", (await count(drB, center.org, `SELECT 1 FROM whatsapp_messages`)) === 0);
  check('another workspace cannot see them', (await count(drC, solo.org, `SELECT 1 FROM whatsapp_messages`)) === 0);
  check('an assistant without the WhatsApp permission sees no conversation', (await count(asst, center.org, `SELECT 1 FROM whatsapp_conversations`)) === 0);
  check('message history cannot be edited', await fails(drA, center.org, q => q(`UPDATE whatsapp_messages SET body='x'`)));
  check('message history cannot be deleted', await fails(drA, center.org, q => q(`DELETE FROM whatsapp_messages`)));
  check('an inbound message cannot be forged', await fails(drA, center.org, q => q(
    `INSERT INTO whatsapp_messages(organization_id,conversation_id,direction,body,status) SELECT organization_id,id,'inbound','forged','received' FROM whatsapp_conversations`)));
  check('consent history cannot be written directly', await fails(drA, center.org, q => q(
    `INSERT INTO consent_events(organization_id,patient_id,channel,opted_in,source) VALUES($1,$2,'whatsapp',true,'staff')`, [center.org, pA])));
  await as(drA, center.org, q => q(`INSERT INTO patient_consents(patient_id,channel,opted_in,recorded_by) VALUES($1,'whatsapp',true,$2)`, [pA, drA]));
  check('a consent change is logged automatically', (await count(drA, center.org, `SELECT 1 FROM consent_events WHERE patient_id=$1`, [pA])) === 1);
  check("Dr B cannot read the consent of Dr A's patient", (await count(drB, center.org, `SELECT 1 FROM patient_consents WHERE patient_id=$1`, [pA])) === 0);
  check('a queued message cannot be attributed to someone else', await fails(drA, center.org, q => q(
    `INSERT INTO scheduled_messages(organization_id,purpose,patient_id,send_at,created_by) VALUES($1,'announcement',$2,now(),$3)`, [center.org, pA, drB])));
  check("Dr B cannot queue a message to Dr A's patient", await fails(drB, center.org, q => q(
    `INSERT INTO scheduled_messages(organization_id,purpose,patient_id,send_at,created_by) VALUES($1,'announcement',$2,now(),$3)`, [center.org, pA, drB])));
  await as(drA, center.org, q => q(`UPDATE message_templates SET body='changed' WHERE organization_id IS NULL`));
  check('platform default templates cannot be changed by a workspace', (await own.query(`SELECT 1 FROM message_templates WHERE body='changed'`)).rowCount === 0);
  check('a center doctor cannot switch on automations', await fails(drA, center.org, q => q(
    `INSERT INTO automation_settings(organization_id,purpose,enabled) VALUES($1,'reminder_24h',true)`, [center.org])));
  await own.end();

  // ---- Release 5: patient portal and push ----
  const own5 = new Client(OWNER); await own5.connect();
  await as(drA, center.org, q => q(`INSERT INTO patient_portal_invitations(organization_id,patient_id,email,token_hash,created_by) VALUES($1,$2,'p@test.medora','h-rls-1',$3)`, [center.org, pA, drA]));
  check('portal invitation token hashes are not readable', await fails(drA, center.org, q => q(`SELECT token_hash FROM patient_portal_invitations`)));
  check("Dr B cannot see invitations for Dr A's patient", (await count(drB, center.org, `SELECT id FROM patient_portal_invitations`)) === 0);
  check("Dr B cannot invite Dr A's patient", await fails(drB, center.org, q => q(
    `INSERT INTO patient_portal_invitations(organization_id,patient_id,email,token_hash,created_by) VALUES($1,$2,'x@test.medora','h-rls-2',$3)`, [center.org, pA, drB])));
  const patU = await signup('patient@test.medora', 'Synthetic Patient User');
  await own5.query(`INSERT INTO patient_accounts(user_id,patient_id,organization_id) VALUES($1,$2,$3)`, [patU, pA, center.org]);
  check('a patient account reads no staff table', (await count(patU, null, `SELECT 1 FROM patients`)) === 0 && (await count(patU, null, `SELECT 1 FROM appointments`)) === 0);
  check('a patient account cannot act inside the clinic workspace', (await count(patU, center.org, `SELECT 1 FROM patients`)) === 0);
  check('a patient sees only their own record through the portal', (await count(patU, null, `SELECT * FROM portal_records()`)) === 1 && (await count(drC, null, `SELECT * FROM portal_records()`)) === 0);
  await as(drA, null, q => q(`INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth) VALUES($1,'https://push.test/a','k','a')`, [drA]));
  check("push subscriptions are private to their user", (await count(drB, null, `SELECT 1 FROM push_subscriptions`)) === 0);
  check('a push subscription cannot be added for someone else', await fails(drB, null, q => q(`INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth) VALUES($1,'https://push.test/b','k','a')`, [drA])));
  await as(patU, null, q => q(`SELECT portal_request_appointment($1,NULL,current_date+1,'any',NULL)`, [pA]));
  check("Dr B does not see requests for Dr A's patient", (await count(drB, center.org, `SELECT 1 FROM appointment_requests`)) === 0);
  check('appointment requests cannot be created directly', await fails(drA, center.org, q => q(
    `INSERT INTO appointment_requests(organization_id,patient_id,preferred_date,preferred_time,requested_by) VALUES($1,$2,current_date,'any',$3)`, [center.org, pA, drA])));
  await own5.end();

  // ---- Release 6: subscriptions, admin functions, support ----
  const own6 = new Client(OWNER); await own6.connect();
  check('every workspace has a trial subscription', (await own6.query(`SELECT count(*)::int n FROM organizations o WHERE NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.organization_id=o.id)`)).rows[0].n === 0);
  check('a workspace cannot change its own subscription row', await fails(drA, center.org, q => q(`UPDATE subscriptions SET status='active', current_period_end=now()+interval '10 years' WHERE organization_id=$1`, [center.org])));
  check('a workspace cannot record its own payment', await fails(drA, center.org, q => q(
    `INSERT INTO subscription_payments(organization_id,amount,currency,method,period_start,period_end,plan_code,recorded_by) VALUES($1,1,'USD','cash',current_date,current_date+30,'solo',$2)`, [center.org, drA])));
  check('plans cannot be edited by the app role', await fails(drA, null, q => q(`UPDATE plans SET monthly_price=0`)));
  check('Dr C cannot read the center subscription', (await count(drC, solo.org, `SELECT 1 FROM subscriptions WHERE organization_id=$1`, [center.org])) === 0);
  for (const fn of [`admin_overview()`, `admin_workspaces()`, `admin_users(NULL)`, `admin_set_org_status('${center.org}','suspended','x')`, `admin_record_payment('${center.org}',1,'USD','cash',NULL,1)`, `admin_set_setting('trial_days','365')`]) {
    check(`non-admin cannot call ${fn.split('(')[0]}`, await fails(drA, center.org, q => q(`SELECT ${fn}`)));
  }
  check('platform settings cannot be written directly', await fails(drA, null, q => q(`UPDATE platform_settings SET value='0' WHERE key='trial_days'`)));
  const sr = (await as(drA, null, q => q(`INSERT INTO support_requests(user_id,category,subject) VALUES($1,'other','Synthetic question') RETURNING id`, [drA]))).rows[0].id;
  check('support requests are private to their author', (await count(drB, null, `SELECT 1 FROM support_requests WHERE id=$1`, [sr])) === 0);
  check('a user cannot answer as MEDORA staff', await fails(drA, null, q => q(`INSERT INTO support_messages(request_id,author_id,from_staff,body) VALUES($1,$2,true,'fake')`, [sr, drA])));
  check("a user cannot open a request for someone else's workspace", await fails(drC, solo.org, q => q(`INSERT INTO support_requests(organization_id,user_id,category,subject) VALUES($1,$2,'other','x y z')`, [center.org, drC])));
  await own6.end();

  // ---- Secrets and audit ----
  check('app role cannot read password hashes', await fails(drA, null, q => q(`SELECT password_hash FROM users`)));
  check('app role cannot read session token hashes', await fails(drA, null, q => q(`SELECT token_hash FROM sessions`)));
  await as(drA, center.org, q => q(`INSERT INTO audit_log(actor_user_id,organization_id,action,entity_type) VALUES($1,$2,'test','x')`, [drA, center.org]));
  check('audit log cannot be altered by the app', await fails(drA, center.org, q => q(`UPDATE audit_log SET action='x'`)));
  check('audit entry cannot be forged for another user', await fails(drA, center.org, q => q(
    `INSERT INTO audit_log(actor_user_id,organization_id,action,entity_type) VALUES($1,$2,'test','x')`, [drB, center.org])));
  check('Dr C cannot read center audit log', (await count(drC, solo.org, `SELECT 1 FROM audit_log WHERE organization_id=$1`, [center.org])) === 0);

  results.forEach(([s, n]) => console.log(s.padEnd(5), n));
  console.log(`${results.filter(r => r[0] === 'ok').length}/${results.length} passed`);
  await c.end(); process.exit(results.some(([s]) => s === 'FAIL') ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
