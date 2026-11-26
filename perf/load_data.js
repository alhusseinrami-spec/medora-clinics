// Adds a large synthetic data set to the demo center (run after `npm run db:seed`): 20,000 patients and about
// 19,000 appointments over the past year and the next month for Dr Nour and Dr Karim. Owner connection, dev only.
const { Client } = require('pg');
const url = process.env.DATABASE_URL || 'postgres://medora:medora_dev@localhost:5432/medora';
(async () => {
  if (process.env.NODE_ENV === 'production') throw new Error('refusing to load test data in production');
  const c = new Client(url); await c.connect();
  const t0 = Date.now();
  const org = (await c.query(`SELECT id FROM organizations WHERE name = 'Cedar Synthetic Medical Center'`)).rows[0]?.id;
  if (!org) throw new Error('Run npm run db:seed first');
  const docs = (await c.query(`SELECT m.id FROM memberships m WHERE m.organization_id = $1 AND m.role_code = 'doctor' ORDER BY m.created_at`, [org])).rows.map((r) => r.id);
  await c.query(`UPDATE plans SET max_patients = NULL`);
  await c.query(`INSERT INTO patients (organization_id, full_name, sex, date_of_birth, phone, preferred_language)
    SELECT $1, 'Synthetic ' || (ARRAY['Adam','Lea','Omar','Maya','Karim','Rita','Ziad','Nadine','Hadi','Yara'])[1 + g % 10] || ' ' ||
           (ARRAY['Haddad','Khoury','Saad','Nassar','Aoun','Fares','Karam','Salem'])[1 + (g / 10) % 8] || ' ' || g,
           CASE WHEN g % 2 = 0 THEN 'female' ELSE 'male' END, date '1950-01-01' + (g % 25000), '+961 70 ' || lpad((g % 1000000)::text, 6, '0'), 'en'
      FROM generate_series(1, 20000) g`, [org]);
  await c.query(`INSERT INTO patient_memberships (patient_id, membership_id)
    SELECT p.id, ($2::uuid[])[1 + (row_number() OVER (ORDER BY p.created_at, p.id))::int % array_length($2::uuid[], 1)] FROM patients p
     WHERE p.organization_id = $1 AND p.full_name LIKE 'Synthetic % % %' ON CONFLICT DO NOTHING`, [org, docs]);
  // Non-overlapping 20-minute slots from 09:00 to 17:00, every day from 365 days ago to 30 days ahead, per doctor.
  await c.query(`INSERT INTO appointments (organization_id, doctor_membership_id, patient_id, starts_at, ends_at, status)
    SELECT $1, d.id, pm.patient_id, s, s + interval '20 minutes',
           CASE WHEN s > now() THEN 'scheduled' WHEN random() < 0.08 THEN 'no_show' WHEN random() < 0.1 THEN 'cancelled' ELSE 'completed' END
      FROM unnest($2::uuid[]) d(id)
      CROSS JOIN generate_series(date_trunc('day', now()) - interval '365 days', date_trunc('day', now()) + interval '30 days', interval '1 day') day
      CROSS JOIN generate_series(0, 23) k
      CROSS JOIN LATERAL (SELECT day + interval '9 hours' + k * interval '20 minutes' AS s) x
      CROSS JOIN LATERAL (SELECT patient_id FROM patient_memberships WHERE membership_id = d.id OFFSET (abs(hashtext(d.id::text || s::text)) % 9000) LIMIT 1) pm
     WHERE extract(isodow FROM day) < 7
       AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.doctor_membership_id = d.id AND a.starts_at < s + interval '20 minutes' AND a.ends_at > s)`, [org, docs]);
  await c.query('ANALYZE');
  const n = (await c.query(`SELECT (SELECT count(*) FROM patients WHERE organization_id=$1) p, (SELECT count(*) FROM appointments WHERE organization_id=$1) a`, [org])).rows[0];
  console.log(`loaded: ${n.p} patients, ${n.a} appointments in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
