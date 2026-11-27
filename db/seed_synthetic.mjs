// Synthetic demo data, created through the real API (so every row passes the same permission and RLS checks).
// Usage: API_URL=http://localhost:4000 node db/seed_synthetic.mjs      (expects a fresh database)
// All people, phone numbers and records are invented. Password for every demo account: Demo-Medora-2026
const API = (process.env.API_URL ?? 'http://localhost:4000') + '/api';
const PW = 'Demo-Medora-2026';

class C {
  cookie = ''; org = '';
  async r(method, path, body) {
    const h = { 'content-type': 'application/json' };
    if (this.cookie) h.cookie = this.cookie; if (this.org) h['x-org-id'] = this.org;
    const res = await fetch(API + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    const text = await res.text(); const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
    return data;
  }
  post = (p, b = {}) => this.r('POST', p, b); put = (p, b) => this.r('PUT', p, b); get = (p) => this.r('GET', p); patch = (p, b) => this.r('PATCH', p, b);
  async upload(path, bytes, type) {
    const res = await fetch(API + path, { method: 'POST', headers: { 'content-type': type, cookie: this.cookie, 'x-org-id': this.org }, body: bytes });
    const text = await res.text(); if (!res.ok) throw new Error(`POST ${path} -> ${res.status} ${text}`);
    return JSON.parse(text);
  }
}
const tok = (url) => url.split('/invite/')[1];
const at = (dayOffset, h, m = 0) => { const d = new Date(); d.setDate(d.getDate() + dayOffset); d.setHours(h, m, 0, 0); return d.toISOString(); };

const owner = new C(), nour = new C(), karim = new C(), lina = new C(), maya = new C(), sami = new C();

// Medical center with departments and rooms
const center = await owner.post('/auth/register/center', { fullName: 'Rania Khoury', email: 'owner@demo.medora', password: PW, centerName: 'Cedar Synthetic Medical Center', address: '1 Demo Street, Beirut' });
owner.org = center.organizationId;
const org = await owner.get('/org');
const loc = org.locations[0].id;
for (const r of ['Room 1', 'Room 2', 'Room 3']) await owner.post(`/org/locations/${loc}/rooms`, { name: r });
const depPed = await owner.post('/org/departments', { name: 'Pediatrics' });
const depCar = await owner.post('/org/departments', { name: 'Cardiology' });

// Dr Nour: independent pediatric practice + center doctor (one account, two workspaces)
const solo = await nour.post('/auth/register/doctor', { fullName: 'Dr Nour Haddad', email: 'nour@demo.medora', password: PW, specialty: 'pediatrics', licenseNumber: 'LB-DEMO-1001', clinicName: 'Haddad Pediatrics', consultationFee: 50 });
const invN = await owner.post('/staff/invitations', { email: 'nour@demo.medora', role: 'doctor', specialty: 'pediatrics', departmentId: depPed.id, consultationFee: 80 });
const mNour = (await nour.post(`/invitations/${tok(invN.acceptUrl)}/accept`)).membership_id;

const invK = await owner.post('/staff/invitations', { email: 'karim@demo.medora', role: 'doctor', specialty: 'cardiology', departmentId: depCar.id, consultationFee: 90 });
await karim.post('/auth/register/doctor', { fullName: 'Dr Karim Saad', email: 'karim@demo.medora', password: PW, specialty: 'cardiology', licenseNumber: 'LB-DEMO-2002', clinicName: 'Saad Cardiology' });
const mKarim = (await karim.post(`/invitations/${tok(invK.acceptUrl)}/accept`)).membership_id;

// Assistant for Dr Nour at the center, receptionist for the whole center
const invL = await owner.post('/staff/invitations', { email: 'lina@demo.medora', role: 'assistant', assignToDoctorMembershipId: mNour });
await lina.post('/auth/register/center', { fullName: 'Lina Assaf', email: 'lina@demo.medora', password: PW, centerName: 'Lina (personal)' });
await lina.post(`/invitations/${tok(invL.acceptUrl)}/accept`);
const invM = await owner.post('/staff/invitations', { email: 'maya@demo.medora', role: 'receptionist' });
await maya.post('/auth/register/center', { fullName: 'Maya Front Desk', email: 'maya@demo.medora', password: PW, centerName: 'Maya (personal)' });
await maya.post(`/invitations/${tok(invM.acceptUrl)}/accept`);
const invS = await owner.post('/staff/invitations', { email: 'sami@demo.medora', role: 'insurance_admin' });
await sami.post('/auth/register/center', { fullName: 'Sami Insurance Desk', email: 'sami@demo.medora', password: PW, centerName: 'Sami (personal)' });
await sami.post(`/invitations/${tok(invS.acceptUrl)}/accept`);
nour.org = karim.org = lina.org = maya.org = sami.org = center.organizationId;

for (const [c, m] of [[nour, mNour], [karim, mKarim]]) {
  await c.put('/availability/working-hours', { doctorMembershipId: m, hours: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, starts: '08:00', ends: '18:00' })) });
}
await nour.post('/services', { name: 'Well-child visit', defaultMinutes: 30, price: 80, doctorMembershipId: mNour });
await karim.post('/services', { name: 'Cardiology consultation', defaultMinutes: 30, price: 90, doctorMembershipId: mKarim });

// Synthetic patients
const kids = [['Synthetic Child Lea', '2024-02-11', 'female'], ['Synthetic Child Omar', '2022-09-03', 'male'], ['Synthetic Child Yara', '2025-04-20', 'female'], ['Synthetic Child Adam', '2021-12-01', 'male']];
const adults = [['Synthetic Adult Samir', '1961-06-14', 'male'], ['Synthetic Adult Hala', '1975-03-30', 'female'], ['Synthetic Adult Fadi', '1958-11-09', 'male']];
const pk = [];
for (const [i, [n, dob, sex]] of kids.entries()) pk.push(await lina.post('/patients', { fullName: n, dateOfBirth: dob, sex, phone: `+961 70 100 10${i}`, confirmNotDuplicate: true }));
const pa = [];
for (const [i, [n, dob, sex]] of adults.entries()) pa.push(await maya.post('/patients', { fullName: n, dateOfBirth: dob, sex, phone: `+961 71 200 20${i}`, doctorMembershipId: mKarim, confirmNotDuplicate: true }));

// Specialty data
await nour.put(`/patients/${pk[0].id}/specialty`, { data: {
  birth: { gestational_age_weeks: 39, birth_weight_kg: 3.25, birth_length_cm: 50, delivery: 'vaginal' },
  growth: { measurements: [{ date: '2024-03-11', weight_kg: 4.3, height_cm: 54 }, { date: '2024-06-11', weight_kg: 6.4, height_cm: 62 }, { date: '2024-12-11', weight_kg: 8.6, height_cm: 71 }, { date: '2025-06-11', weight_kg: 10.1, height_cm: 79 }] },
  vaccinations: { doses: [{ vaccine: 'Synthetic MMR', dose_number: 1, given_on: '2025-02-11', next_due: new Date(Date.now() + 12 * 86400e3).toISOString().slice(0, 10) }] },
} });
await karim.put(`/patients/${pa[0].id}/specialty`, { data: {
  vitals: { weight_kg: 82, height_cm: 176, systolic: 148, diastolic: 92, heart_rate: 76 },
  cardio_history: { risk_factors: ['hypertension', 'dyslipidemia'] },
  ecg: { items: [{ date: '2026-09-02', rhythm: 'Sinus', rate: 74, findings: 'Synthetic: no acute changes' }] },
} });

// Today's schedule
const svc = await nour.get('/services');
const wcv = svc.find((s) => s.name === 'Well-child visit').id;
const a1 = await lina.post('/appointments', { patientId: pk[0].id, doctorMembershipId: mNour, startsAt: at(0, 9), serviceId: wcv });
const a2 = await lina.post('/appointments', { patientId: pk[1].id, doctorMembershipId: mNour, startsAt: at(0, 10), serviceId: wcv, status: 'confirmed' });
await lina.post('/appointments', { patientId: pk[2].id, doctorMembershipId: mNour, startsAt: at(0, 11), serviceId: wcv });
await lina.post('/appointments', { patientId: pk[3].id, doctorMembershipId: mNour, startsAt: at(1, 9, 30), serviceId: wcv, recurrence: 'FREQ=WEEKLY;COUNT=3' });
await maya.post('/appointments', { patientId: pa[0].id, doctorMembershipId: mKarim, startsAt: at(0, 9, 30), durationMinutes: 30 });
await maya.post('/appointments', { patientId: pa[1].id, doctorMembershipId: mKarim, startsAt: at(0, 14), durationMinutes: 30 });
await maya.post('/appointments', { patientId: pa[2].id, doctorMembershipId: mKarim, startsAt: at(2, 10), durationMinutes: 30 });
for (const a of [a1, a2]) await lina.post(`/appointments/${a.id}/status`, { status: 'arrived' });

// A busy morning in the waiting room: more synthetic patients, one in with each doctor, others waiting to be called in,
// a walk-in, and today's cancellations and a no-show. db/demo_today.js spreads the arrival times so waits look real.
const kids2 = [['Synthetic Child Karam', '2023-05-17', 'male', 'Peanuts'], ['Synthetic Child Tala', '2020-08-25', 'female', null], ['Synthetic Child Ziad', '2024-11-02', 'male', null],
  ['Synthetic Child Nay', '2019-01-30', 'female', 'Penicillin'], ['Synthetic Child Elie', '2022-03-14', 'male', null]];
const adults2 = [['Synthetic Adult Rania', '1969-07-22', 'female', 'Aspirin', 'Hypertension'], ['Synthetic Adult Georges', '1954-02-05', 'male', null, 'Atrial fibrillation'],
  ['Synthetic Adult Mona', '1980-10-12', 'female', null, null], ['Synthetic Adult Walid', '1963-12-28', 'male', null, 'Type 2 diabetes, hypertension'],
  ['Synthetic Adult Joelle', '1990-04-09', 'female', 'Latex', null], ['Synthetic Adult Bassam', '1972-09-18', 'male', null, 'Dyslipidemia']];
const pk2 = [];
for (const [i, [n, dob, sex, allergies]] of kids2.entries()) pk2.push(await lina.post('/patients', { fullName: n, dateOfBirth: dob, sex, phone: `+961 70 300 30${i}`, allergies, bloodType: ['O+', 'A+', 'B+', 'O-', 'A-'][i], confirmNotDuplicate: true }));
const pa2 = [];
for (const [i, [n, dob, sex, allergies, chronicDiseases]] of adults2.entries()) pa2.push(await maya.post('/patients', { fullName: n, dateOfBirth: dob, sex, phone: `+961 71 400 40${i}`, allergies, chronicDiseases, doctorMembershipId: mKarim, confirmNotDuplicate: true }));
const book = (who, p, doc, startsAt, extra = {}) => who.post('/appointments', { patientId: p.id, doctorMembershipId: doc, startsAt, ...extra });
// Dr Nour: Lea (9:00) is in with the doctor; Karam, Omar, Tala and a walk-in wait; Ziad cancelled.
const k1 = await book(lina, pk2[0], mNour, at(0, 9, 30), { serviceId: wcv });
const k2 = await book(lina, pk2[1], mNour, at(0, 10, 30), { serviceId: wcv });
const k3 = await book(lina, pk2[2], mNour, at(0, 12), { serviceId: wcv });
await book(lina, pk2[3], mNour, at(1, 10), { serviceId: wcv });
await lina.post(`/appointments/${k1.id}/status`, { status: 'arrived' });
await lina.post(`/appointments/${k2.id}/status`, { status: 'arrived' });
await lina.post('/appointments/walk-in', { patientId: pk2[4].id, doctorMembershipId: mNour, serviceId: wcv, notes: 'Synthetic: cough since yesterday' });
await lina.post(`/appointments/${k3.id}/status`, { status: 'cancelled', reason: 'Synthetic: parent called, child has a fever' });
await nour.post('/consultations', { appointmentId: a1.id });
// Dr Karim: Rania is in with the doctor; Georges and Mona wait; Walid cancelled; Joelle did not come.
const c0 = await book(maya, pa2[4], mKarim, at(0, 8), { durationMinutes: 30 });
const c1 = await book(maya, pa2[0], mKarim, at(0, 8, 30), { durationMinutes: 30 });
const c2 = await book(maya, pa2[1], mKarim, at(0, 10), { durationMinutes: 30 });
const c3 = await book(maya, pa2[2], mKarim, at(0, 10, 30), { durationMinutes: 30 });
const c4 = await book(maya, pa2[3], mKarim, at(0, 11), { durationMinutes: 30 });
await book(maya, pa2[5], mKarim, at(3, 9), { durationMinutes: 30 });
for (const a of [c1, c2, c3]) await maya.post(`/appointments/${a.id}/status`, { status: 'arrived' });
await maya.post(`/appointments/${c4.id}/status`, { status: 'cancelled', reason: 'Synthetic: travelling, will call back' });
await maya.post(`/appointments/${c0.id}/status`, { status: 'no_show' });
await karim.post('/consultations', { appointmentId: c1.id });

// Prescriptions and a renewal request: Dr Karim's patient asked the front desk to renew a long-term prescription.
const rxS = await karim.post('/prescriptions', { patientId: pa[0].id, notes: null, items: [
  { medicationName: 'Synthetic Amlodipine 5 mg', dosage: '1 tablet', frequency: 'once daily', duration: '3 months', instructions: null, notes: null },
  { medicationName: 'Synthetic Atorvastatin 20 mg', dosage: '1 tablet', frequency: 'at night', duration: '3 months', instructions: null, notes: null }] });
await karim.post(`/prescriptions/${rxS.id}/issue`);
const rxL = await nour.post('/prescriptions', { patientId: pk[0].id, notes: null, items: [
  { medicationName: 'Synthetic Vitamin D drops', dosage: '400 IU', frequency: 'once daily', duration: '2 months', instructions: null, notes: null }] });
await nour.post(`/prescriptions/${rxL.id}/issue`);
await maya.post('/refills', { patientId: pa[0].id, note: 'Synthetic: running out of tablets next week' });

// Finance (Release 3): exchange rates, a commission, an insurer, a policy, invoices, a payment, an expense and a claim
await owner.post('/finance/rates', { lbpPerUsd: 89500, note: 'Synthetic demo rate' });
const nourSolo = new C(); nourSolo.cookie = nour.cookie; nourSolo.org = solo.organizationId;
await nourSolo.post('/finance/rates', { lbpPerUsd: 89500, note: 'Synthetic demo rate' });
await owner.put(`/finance/commissions/${mNour}`, { doctorPercent: 60 });
await owner.put(`/finance/commissions/${mKarim}`, { doctorPercent: 65 });
const insurer = await sami.post('/insurance/providers', { name: 'Demo Mutual Insurance (synthetic)', kind: 'private', phone: '+961 1 000 000', email: null, notes: null });
const policy = await sami.post(`/patients/${pk[0].id}/policies`, { providerId: insurer.id, policyNumber: 'DMI-0001', coveragePercent: 80, memberName: 'Synthetic parent', relationship: 'Child' });
const inv1 = await maya.post('/invoices', { patientId: pa[0].id, doctorMembershipId: mKarim, issue: true, notes: null,
  items: [{ description: 'Cardiology consultation', unitPrice: 90, kind: 'consultation', serviceId: null }, { description: 'ECG', unitPrice: 40, kind: 'service', serviceId: null }] });
await maya.post(`/invoices/${inv1.id}/payments`, { method: 'cash', amount: 100, currency: 'USD', reference: null, note: null });
const inv2 = await maya.post('/invoices', { patientId: pk[0].id, doctorMembershipId: mNour, issue: true, notes: null,
  items: [{ description: 'Well-child visit', unitPrice: 80, kind: 'consultation', serviceId: null, insuranceCovered: true }] });
await sami.post('/claims', { invoiceId: inv2.id, policyId: policy.id, notes: null });
await owner.post('/finance/expenses', { category: 'rent', description: 'Synthetic monthly rent', amount: 1200, currency: 'USD', method: 'bank_transfer' });

// Richer patient files (problem lists, allergies, medications, immunizations, measurement history, packages, body map,
// odontogram, before/after photos, identifiers, notes, custom fields and Law 81/2018 consents). All values are invented.
const ago = (days) => new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10);
const zlib = await import('node:zlib');
/** A small synthetic PNG (a soft two-colour gradient), so photo features have something to show. */
function syntheticPng(w, h, [r1, g1, b1], [r2, g2, b2], spot) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const k = (x + y) / (w + h); const o = y * (w * 3 + 1) + 1 + x * 3;
      const d = spot ? Math.hypot(x - spot.x, y - spot.y) / spot.r : 9; const s = d < 1 ? 1 - d : 0;
      raw[o] = Math.round(r1 + (r2 - r1) * k - 40 * s); raw[o + 1] = Math.round(g1 + (g2 - g1) * k - 70 * s); raw[o + 2] = Math.round(b1 + (b2 - b1) * k - 60 * s);
    }
  }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const photo = (who, pid, title, spot) => who.upload(`/patients/${pid}/documents?kind=photo&title=${encodeURIComponent(title)}&filename=synthetic.png`,
  syntheticPng(320, 240, [236, 205, 184], [214, 178, 156], spot), 'image/png');
const items = async (who, pid, list) => { for (const [kind, label, detail, extra = {}] of list) await who.post(`/patients/${pid}/clinical-items`, { kind, label, detail, ...extra }); };
const series = async (who, pid, code, pts) => { for (const [days, value] of pts) await who.post(`/patients/${pid}/measurements`, { code, value, measuredOn: ago(days) }); };
const consents = async (pid, givenBy, answers) => { for (const [purpose, granted, detail] of answers) await maya.post(`/patients/${pid}/data-consents`, { purpose, granted, givenBy, detail: detail ?? null }); };

// Samir: hypertension and dyslipidemia, penicillin anaphylaxis, the patient-app user.
const samir = pa[0].id;
await maya.patch(`/patients/${samir}`, { nssfNumber: '318-442-771', civilRegistry: 'Jdeideh 412', address: 'Synthetic Street 12, Jdeideh',
  emergencyContact: { name: 'Synthetic Nadine', phone: '+33 6 00 00 00 01', relation: 'Daughter' }, adminNotes: 'Prefers morning appointments. His daughter Nadine (Paris) pays the invoices by bank transfer.',
  customFields: [{ label: 'Usual pharmacy', value: 'Synthetic Pharmacy, Jdeideh' }, { label: 'Referred by', value: 'Synthetic GP, Dr Rizk' }] });
await items(karim, samir, [
  ['problem', 'Essential hypertension', 'Diagnosed 2018', { status: 'chronic', code: 'I10', startedOn: '2018-04-01' }],
  ['problem', 'Dyslipidemia', null, { status: 'chronic', code: 'E78.5', startedOn: '2020-09-01' }],
  ['problem', 'Left knee sprain', 'Physiotherapy done', { status: 'resolved', startedOn: '2024-02-10' }],
  ['allergy', 'Penicillin', 'anaphylaxis (2019, hospitalised)', { severity: 'severe' }],
  ['allergy', 'Iodinated contrast', 'hives', { severity: 'moderate' }],
  ['medication', 'Synthetic Amlodipine 5 mg', '1 tablet once daily'],
  ['medication', 'Synthetic Atorvastatin 20 mg', '1 tablet at night'],
  ['immunization', 'Influenza (season 2025–26)', 'Single dose', { startedOn: ago(55) }],
  ['immunization', 'Tetanus–diphtheria booster', 'Dose 4', { startedOn: '2022-05-14' }],
]);
await series(karim, samir, 'systolic', [[360, 162], [300, 155], [240, 149], [180, 146], [120, 141], [60, 138], [14, 134]]);
await series(karim, samir, 'diastolic', [[360, 98], [300, 95], [240, 92], [180, 90], [120, 88], [60, 86], [14, 84]]);
await series(karim, samir, 'weight', [[360, 86.5], [240, 85], [120, 83.4], [14, 82]]);
await series(karim, samir, 'heart_rate', [[120, 78], [14, 74]]);
await series(karim, samir, 'ldl', [[400, 168], [220, 131], [130, 112]]);
await karim.post(`/patients/${samir}/teeth`, { tooth: 36, condition: 'crown', note: 'Synthetic: from his dentist report' });
await karim.post(`/patients/${samir}/teeth`, { tooth: 46, condition: 'root_canal' });
await karim.post(`/patients/${samir}/teeth`, { tooth: 18, condition: 'missing' });
await karim.post(`/patients/${samir}/teeth`, { tooth: 27, condition: 'filling', surfaces: 'MO' });
const rehab = await maya.post(`/patients/${samir}/packages`, { name: 'Cardiac rehabilitation', totalSessions: 12, price: 600, currency: 'USD', expiresOn: ago(-90), note: 'Twice a week' });
for (let i = 0; i < 5; i++) await maya.post(`/packages/${rehab.id}/sessions`, { note: i === 0 ? 'Synthetic: baseline exercise test' : null });
await consents(samir, 'Synthetic Adult Samir', [['chart_access', true], ['family_proxy', false], ['diaspora_payer', true, 'Daughter Nadine (Paris)'],
  ['insurance_claims', true], ['photos', true], ['research', false]]);
const visit = await karim.post('/consultations', { patientId: samir });
await karim.patch(`/consultations/${visit.id}`, { chiefComplaint: 'Blood pressure follow-up', clinicalNotes: 'Synthetic: home readings around 135/85. No chest pain. Continue treatment.' });
await karim.post(`/consultations/${visit.id}/sign`);

// Walid: type 2 diabetes, HbA1c coming down over 18 months.
const walid = pa2[3].id;
await maya.patch(`/patients/${walid}`, { nssfNumber: '204-118-305', civilRegistry: 'Zahle 88', adminNotes: 'Brings his glucose log on paper.' });
await items(karim, walid, [
  ['problem', 'Type 2 diabetes mellitus', null, { status: 'chronic', code: 'E11', startedOn: '2015-03-01' }],
  ['problem', 'Essential hypertension', null, { status: 'chronic', code: 'I10', startedOn: '2017-06-01' }],
  ['medication', 'Synthetic Metformin 850 mg', '1 tablet twice daily'],
  ['medication', 'Synthetic Perindopril 5 mg', '1 tablet once daily'],
]);
await series(karim, walid, 'hba1c', [[545, 8.4], [455, 8.1], [365, 7.9], [270, 7.6], [180, 7.4], [90, 7.2], [31, 7.1]]);
await series(karim, walid, 'fasting_glucose', [[180, 152], [90, 138], [31, 131]]);
await series(karim, walid, 'weight', [[365, 94], [180, 91.5], [31, 89.8]]);
await series(karim, walid, 'creatinine', [[200, 1.02], [31, 1.05]]);
await consents(walid, 'Synthetic Adult Walid', [['chart_access', true], ['insurance_claims', true], ['research', true]]);

// Georges: atrial fibrillation on an anticoagulant, INR followed.
const georges = pa2[1].id;
await items(karim, georges, [
  ['problem', 'Atrial fibrillation', 'Permanent', { status: 'chronic', code: 'I48', startedOn: '2019-11-01' }],
  ['medication', 'Synthetic Warfarin 5 mg', 'per INR schedule'],
  ['medication', 'Synthetic Bisoprolol 2.5 mg', '1 tablet once daily'],
]);
await series(karim, georges, 'inr', [[84, 1.8], [70, 2.4], [56, 3.4], [42, 2.7], [28, 2.5], [14, 2.2]]);
await series(karim, georges, 'heart_rate', [[84, 96], [42, 82], [14, 76]]);

// Rania: a scar followed with photos on the body map and a before/after pair.
const rania = pa2[0].id;
await items(karim, rania, [
  ['problem', 'Essential hypertension', null, { status: 'chronic', code: 'I10' }],
  ['allergy', 'Aspirin', 'bronchospasm', { severity: 'severe' }],
]);
const scarBefore = await photo(karim, rania, 'Synthetic photo: forearm scar, week 1', { x: 160, y: 120, r: 70 });
const scarAfter = await photo(karim, rania, 'Synthetic photo: forearm scar, week 8', { x: 160, y: 120, r: 30 });
await karim.post(`/patients/${rania}/body-marks`, { side: 'front', x: 82, y: 33, region: 'Forearm (left)', note: 'Synthetic: healing surgical scar, 4 cm. Check at 8 weeks.', photoDocumentId: scarAfter.id });
await karim.post(`/patients/${rania}/body-marks`, { side: 'front', x: 44, y: 24, region: 'Chest', note: 'Synthetic: small benign mole, unchanged.' });
await karim.post(`/patients/${rania}/body-marks`, { side: 'back', x: 50, y: 44, region: 'Lower back', note: 'Synthetic: muscular pain on bending.' });
await karim.post(`/patients/${rania}/photo-pairs`, { title: 'Left forearm scar', beforeDocumentId: scarBefore.id, afterDocumentId: scarAfter.id, note: 'Synthetic: good healing, no sign of infection.' });
await series(karim, rania, 'systolic', [[200, 150], [100, 141], [10, 136]]);

// Children of Dr Nour: immunizations, growth and baby teeth.
await items(nour, pk[0].id, [
  ['immunization', 'Hexavalent (DTaP-IPV-Hib-HepB)', 'Dose 3', { startedOn: '2024-08-11' }],
  ['immunization', 'Pneumococcal conjugate', 'Dose 3', { startedOn: '2024-08-11' }],
  ['immunization', 'MMR', 'Dose 1', { startedOn: '2025-02-11' }],
  ['problem', 'Atopic dermatitis', 'Mild, cheeks', { status: 'active' }],
]);
await series(nour, pk[0].id, 'weight', [[500, 6.4], [320, 8.6], [140, 10.1], [20, 11.2]]);
await series(nour, pk[0].id, 'height', [[500, 62], [320, 71], [140, 79], [20, 84]]);
await maya.patch(`/patients/${pk[0].id}`, { civilRegistry: 'Achrafieh 1203', emergencyContact: { name: 'Synthetic parent', phone: '+961 70 999 001', relation: 'Mother' } });
await consents(pk[0].id, 'Synthetic parent (mother)', [['chart_access', true], ['family_proxy', true, 'Father, Synthetic Antoine'], ['insurance_claims', true], ['photos', false]]);
const tala = pk2[1].id;
await items(nour, tala, [['allergy', 'Amoxicillin', 'rash (2023)', { severity: 'mild' }], ['problem', 'Asthma', 'Intermittent', { status: 'chronic', code: 'J45' }],
  ['medication', 'Synthetic Salbutamol inhaler', '2 puffs when needed']]);
for (const [tooth, condition, surfaces] of [[54, 'caries', 'O'], [64, 'filling', 'O'], [74, 'caries', 'MO'], [85, 'sensitive', null], [51, 'healthy', null]])
  await nour.post(`/patients/${tala}/teeth`, { tooth, condition, surfaces });
const speech = await maya.post(`/patients/${tala}/packages`, { name: 'Speech therapy', totalSessions: 8, price: 320, currency: 'USD' });
for (let i = 0; i < 7; i++) await maya.post(`/packages/${speech.id}/sessions`, {});

// Communication (Release 4): consent for some patients and automatic messages switched on in the center.
// No WhatsApp number is connected in the demo (that needs real Meta credentials), so queued messages show "not sent".
const staff = await owner.get('/staff');
const mayaM = staff.find((m) => m.role_code === 'receptionist');
await owner.put(`/staff/${mayaM.id}/permissions`, { permissions: [...mayaM.permissions, 'whatsapp.send'] });
// Dr Nour's assistant prints the prescriptions Dr Nour issues and takes the visit fee at the desk.
const linaM = staff.find((m) => m.role_code === 'assistant');
if (linaM) await nour.put(`/staff/${linaM.id}/permissions`, { permissions: [...new Set([...linaM.permissions, 'prescription.view', 'payment.register'])] });
for (const p of [pk[0], pk[1], pa[0]]) await maya.put(`/patients/${p.id}/consent`, { optedIn: true });
for (const purpose of ['confirmation', 'reminder_24h', 'reschedule', 'cancellation']) await owner.put(`/whatsapp/automation/${purpose}`, { enabled: true, offsetMinutes: null, followUpDays: null, sendHour: null });

// Patient app (Release 5): one synthetic patient joins through an invitation link and asks for a visit.
const invite = await maya.post(`/patients/${pa[0].id}/portal/invitations`, { email: 'patient@demo.medora' });
const patientUser = new C();
await patientUser.post('/auth/register/patient', { fullName: 'Synthetic Patient', email: 'patient@demo.medora', password: PW, language: 'en', invitation: invite.inviteUrl.split('/').pop() });
await patientUser.post('/portal/requests', { patientId: pa[0].id, doctorMembershipId: mKarim, preferredDate: at(5, 9).slice(0, 10), preferredTime: 'morning', note: 'Follow-up on blood pressure (synthetic)' });

// Commercial platform (Release 6): a MEDORA administrator (no workspace), a support request, a payment for the center,
// and Dr Nour's own practice on the Solo plan. The admin account is made the way production does it: from the server.
// A public demo server (DEMO_MODE) resets itself with SEED_SKIP_ADMIN=1: it has no platform administrator.
if (process.env.SEED_SKIP_ADMIN !== '1') {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  execFileSync(process.execPath, [fileURLToPath(new URL('./platform_admin.js', import.meta.url)), 'create', 'admin@demo.medora', 'MEDORA Admin'], { env: { ...process.env, ADMIN_PASSWORD: PW }, stdio: 'ignore' });
  const admin = new C(); await admin.post('/auth/login', { email: 'admin@demo.medora', password: PW });
  await admin.post(`/admin/workspaces/${center.organizationId}/payments`, { amount: 1490, currency: 'USD', method: 'bank_transfer', reference: 'SYN-DEMO-0001', months: 12 });
}
await nourSolo.post('/subscription/plan', { plan: 'solo', cycle: 'monthly' });
await owner.post('/support', { organizationId: center.organizationId, category: 'billing', subject: 'Invoice for our yearly plan', body: 'Synthetic request: could you send the receipt for our bank transfer?' });

console.log(`Seeded synthetic demo. Sign in with any of these (password ${PW}):
  owner@demo.medora  center owner
  nour@demo.medora   pediatrician (own practice + center)
  karim@demo.medora  cardiologist
  lina@demo.medora   assistant of Dr Nour
  maya@demo.medora   receptionist
  sami@demo.medora   insurance desk
  patient@demo.medora  patient app (opens /portal)
  admin@demo.medora  MEDORA platform admin (opens /admin)`);
