// Smoke test (runs as the schema owner): applies all migrations to a fresh DB and checks key blueprint rules.
const { Client } = require('pg');
const fs = require('fs'); const path = require('path');
const url = process.env.DATABASE_URL || 'postgres://medora:medora_dev@localhost:5432/medora';
(async () => {
  await require('./migrate').migrate({ reset: true, log: () => {} });
  const c = new Client(url); await c.connect();
  const one = async (q, p) => (await c.query(q, p)).rows[0];
  const doc = await one(`INSERT INTO users(email,full_name) VALUES('dr@x.test','Dr A') RETURNING id`);
  const asst = await one(`INSERT INTO users(email,full_name) VALUES('as@x.test','Asst B') RETURNING id`);
  const solo = await one(`INSERT INTO organizations(kind,name) VALUES('independent_practice','Dr A Clinic') RETURNING id`);
  const center = await one(`INSERT INTO organizations(kind,name) VALUES('medical_center','City Center') RETURNING id`);
  // Same doctor in two workplaces, different fees, one user row
  const m1 = await one(`INSERT INTO memberships(user_id,organization_id,role_code,specialty_code,consultation_fee) VALUES($1,$2,'doctor','pediatrics',50) RETURNING id`, [doc.id, solo.id]);
  await c.query(`INSERT INTO memberships(user_id,organization_id,role_code,specialty_code,consultation_fee) VALUES($1,$2,'doctor','pediatrics',80)`, [doc.id, center.id]);
  const ma = await one(`INSERT INTO memberships(user_id,organization_id,role_code) VALUES($1,$2,'assistant') RETURNING id`, [asst.id, solo.id]);
  await c.query(`INSERT INTO assistant_assignments VALUES($1,$2)`, [ma.id, m1.id]);
  await c.query(`INSERT INTO membership_permissions(membership_id,permission_code,granted_by) VALUES($1,'patient.register',$2)`, [ma.id, doc.id]);
  const p = await one(`INSERT INTO patients(organization_id,full_name,date_of_birth) VALUES($1,'Child C','2023-03-01') RETURNING id`, [solo.id]);
  await c.query(`INSERT INTO appointments(organization_id,doctor_membership_id,patient_id,starts_at,ends_at) VALUES($1,$2,$3,now(),now()+interval '20 min')`, [solo.id, m1.id, p.id]);
  await c.query(`INSERT INTO prescriptions(patient_id,prescribed_by,items) VALUES($1,$2,'[{"drug":"Paracetamol"}]')`, [p.id, m1.id]);
  const checks = [];
  const expectFail = async (name, q, prm) => { try { await c.query(q, prm); checks.push(['FAIL', name]); } catch { checks.push(['ok', name]); } };
  checks.push([(await one(`SELECT count(*)::int n FROM users WHERE email='dr@x.test'`)).n === 1 ? 'ok' : 'FAIL', 'doctor in 2 orgs has one account']);
  await expectFail('assistant cannot create prescription', `INSERT INTO prescriptions(patient_id,prescribed_by,items) VALUES($1,$2,'[]')`, [p.id, ma.id]);
  await c.query(`INSERT INTO audit_log(actor_user_id,action,entity_type) VALUES($1,'patient.create','patient')`, [asst.id]);
  await expectFail('audit log is append-only', `DELETE FROM audit_log`);
  await expectFail('appointment end before start rejected', `INSERT INTO appointments(organization_id,doctor_membership_id,patient_id,starts_at,ends_at) VALUES($1,$2,$3,now(),now()-interval '1 min')`, [solo.id, m1.id, p.id]);

  // --- 002 checks ---
  const appt = await one(`SELECT id FROM appointments LIMIT 1`);
  await expectFail('double booking same doctor rejected', `INSERT INTO appointments(organization_id,doctor_membership_id,patient_id,starts_at,ends_at) SELECT organization_id,doctor_membership_id,patient_id,starts_at+interval '5 min',ends_at+interval '5 min' FROM appointments WHERE id=$1`, [appt.id]);
  await c.query(`UPDATE appointments SET status='arrived' WHERE id=$1`, [appt.id]);
  const wr = await one(`SELECT count(*)::int n FROM waiting_room WHERE doctor_membership_id=$1`, [m1.id]);
  const nt = await one(`SELECT count(*)::int n FROM notifications WHERE user_id=$1 AND kind='patient_arrived'`, [doc.id]);
  checks.push([wr.n === 1 && nt.n === 1 ? 'ok' : 'FAIL', 'arrival puts patient in waiting room and notifies doctor']);
  await c.query(`INSERT INTO exchange_rates(organization_id,lbp_per_usd,effective_from) VALUES($1,89500,now()-interval '1 day')`, [solo.id]);
  const inv1 = await one(`INSERT INTO invoices(organization_id,patient_id,currency,lbp_per_usd) VALUES($1,$2,'USD',NULL) RETURNING invoice_number,lbp_per_usd`, [solo.id, p.id]);
  await c.query(`INSERT INTO exchange_rates(organization_id,lbp_per_usd) VALUES($1,90000)`, [solo.id]);
  const inv2 = await one(`INSERT INTO invoices(organization_id,patient_id,currency,lbp_per_usd) VALUES($1,$2,'USD',NULL) RETURNING id,invoice_number,lbp_per_usd`, [solo.id, p.id]);
  const old = await one(`SELECT lbp_per_usd FROM invoices WHERE invoice_number=1 AND organization_id=$1`, [solo.id]);
  checks.push([inv1.invoice_number === 1 && inv2.invoice_number === 2 && +old.lbp_per_usd === 89500 && +inv2.lbp_per_usd === 90000 ? 'ok' : 'FAIL', 'invoice numbering and frozen exchange rate']);
  await c.query(`INSERT INTO invoice_items(invoice_id,description,unit_price) VALUES($1,'Consultation',50)`, [inv2.id]);
  await c.query(`INSERT INTO payments(invoice_id,method_code,amount,currency,lbp_per_usd) VALUES($1,'cash',20,'USD',90000),($1,'whish',900000,'LBP',90000)`, [inv2.id]);
  const bal = await one(`SELECT total, paid FROM invoice_balances WHERE invoice_id=$1`, [inv2.id]);
  checks.push([+bal.total === 50 && +bal.paid === 30 ? 'ok' : 'FAIL', 'partial USD + LBP payments give correct balance']);
  const tpl = await one(`INSERT INTO clinical_templates(kind,specialty_code,name) VALUES('examination','pediatrics','Well-child') RETURNING id`);
  await c.query(`INSERT INTO template_versions(template_id,version,schema,published_at) VALUES($1,1,'{"fields":[]}',now())`, [tpl.id]);
  await expectFail('published template version cannot be edited', `UPDATE template_versions SET schema='{}' WHERE template_id=$1`, [tpl.id]);
  const t = await one(`SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public'`);
  checks.forEach(([s, n]) => console.log(s.padEnd(5), n)); console.log(`tables: ${t.n}`);
  await c.end(); process.exit(checks.some(([s]) => s === 'FAIL') ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
