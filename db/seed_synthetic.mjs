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
  post = (p, b = {}) => this.r('POST', p, b); put = (p, b) => this.r('PUT', p, b); get = (p) => this.r('GET', p);
}
const tok = (url) => url.split('/invite/')[1];
const at = (dayOffset, h, m = 0) => { const d = new Date(); d.setDate(d.getDate() + dayOffset); d.setHours(h, m, 0, 0); return d.toISOString(); };

const owner = new C(), nour = new C(), karim = new C(), lina = new C(), maya = new C();

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
nour.org = karim.org = lina.org = maya.org = center.organizationId;

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

console.log(`Seeded synthetic demo. Sign in with any of these (password ${PW}):
  owner@demo.medora  center owner
  nour@demo.medora   pediatrician (own practice + center)
  karim@demo.medora  cardiologist
  lina@demo.medora   assistant of Dr Nour
  maya@demo.medora   receptionist`);
