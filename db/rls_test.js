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

  // ---- Waiting room and notifications ----
  await as(asst, center.org, q => q(`UPDATE appointments SET status='arrived' WHERE id=$1`, [appt]));
  check('doctor sees arrival in waiting room', (await count(drA, center.org, `SELECT 1 FROM waiting_room`)) === 1);
  check('other doctor does not see that waiting room entry', (await count(drB, center.org, `SELECT 1 FROM waiting_room`)) === 0);
  check('doctor got the arrival notification', (await count(drA, null, `SELECT 1 FROM notifications WHERE kind='patient_arrived'`)) === 1);
  check('notifications are private to their user', (await count(asst, center.org, `SELECT 1 FROM notifications`)) === 0);

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
