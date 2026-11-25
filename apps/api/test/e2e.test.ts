// End-to-end tests: real PostgreSQL (reset), real HTTP server, real sessions. Synthetic data only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';
import { totp } from '../src/common/crypto.js';

const require = createRequire(import.meta.url);
let server: Awaited<ReturnType<typeof createApp>>;
let base = '';

class Client {
  cookie = '';
  org = '';
  constructor(public name: string) {}
  async req(method: string, path: string, body?: unknown, opts: { org?: string | null } = {}) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.cookie) headers.cookie = this.cookie;
    const org = opts.org === undefined ? this.org : opts.org;
    if (org) headers['x-org-id'] = org;
    const r = await fetch(`${base}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  }
  get = (p: string, o?: { org?: string | null }) => this.req('GET', p, undefined, o);
  post = (p: string, b?: unknown, o?: { org?: string | null }) => this.req('POST', p, b ?? {}, o);
  patch = (p: string, b: unknown) => this.req('PATCH', p, b);
  put = (p: string, b: unknown) => this.req('PUT', p, b);
}
const PW = 'Synthetic-Pass-2026';
const tomorrowAt = (h: number, m = 0) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 1); d.setUTCHours(h, m, 0, 0); return d.toISOString(); };

const dr = new Client('Dr Nour (pediatrics, own practice + center)');
const owner = new Client('Center owner');
const drB = new Client('Dr Karim (cardiology, center)');
const asst = new Client('Assistant of Dr Nour at the center');
const stranger = new Client('Doctor at another practice');
const ids: Record<string, string> = {};

before(async () => {
  const { migrate } = require('../../../../db/migrate.js');
  const { syncPresets } = require('../../../../db/sync_presets.js');
  await migrate({ reset: true, log: () => {} });
  await syncPresets({ log: () => {} });
  server = await createApp({ logger: false });
  await server.app.listen(0);
  base = `http://127.0.0.1:${(server.app.getHttpServer().address() as any).port}`;
});
after(async () => { await server.close(); });

test('independent doctor registration creates account, practice, location, service and hours', async () => {
  const r = await dr.post('/auth/register/doctor', { fullName: 'Dr Nour Haddad', email: 'nour@synthetic.medora', password: PW, specialty: 'pediatrics',
    licenseNumber: 'LB-SYN-1001', clinicName: 'Haddad Pediatrics', address: 'Synthetic St, Beirut', consultationFee: 50 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  dr.org = ids.drPractice = r.body.organizationId; ids.drSoloMid = r.body.membershipId;
  const org = await dr.get('/org');
  assert.equal(org.body.organization.kind, 'independent_practice');
  assert.equal(org.body.locations.length, 1);
  assert.ok(org.body.me.permissions.includes('prescription.create'));
  assert.ok(org.body.me.permissions.includes('staff.manage'));
  const services = await dr.get('/services');
  assert.equal(services.body[0].price, 50);
});

test('weak passwords, duplicate emails and unknown fields are rejected', async () => {
  const c = new Client('x');
  assert.equal((await c.post('/auth/register/doctor', { fullName: 'X', email: 'bad', password: 'short' })).status, 400);
  const dup = await c.post('/auth/register/center', { fullName: 'Someone', email: 'NOUR@synthetic.medora', password: PW, centerName: 'Dup' });
  assert.equal(dup.status, 400); assert.equal(dup.body.code, 'email_taken');
  assert.equal((await c.post('/auth/login', { email: 'nour@synthetic.medora', password: PW, isAdmin: true })).status, 400);
});

test('login, wrong password, session-protected routes', async () => {
  const c = new Client('login');
  assert.equal((await c.get('/auth/me')).status, 401);
  assert.equal((await c.post('/auth/login', { email: 'nour@synthetic.medora', password: 'wrong-password' })).status, 401);
  const ok = await c.post('/auth/login', { email: 'nour@synthetic.medora', password: PW });
  assert.equal(ok.status, 200); assert.equal(ok.body.mfaRequired, false);
  const me = await c.get('/auth/me');
  assert.equal(me.body.user.email, 'nour@synthetic.medora');
  assert.equal((await c.post('/auth/logout')).status, 200);
  assert.equal((await c.get('/auth/me')).status, 401);
});

test('medical center registration and inviting an existing doctor keeps ONE account', async () => {
  const r = await owner.post('/auth/register/center', { fullName: 'Rania Center Owner', email: 'owner@synthetic.medora', password: PW, centerName: 'Cedar Synthetic Medical Center' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  owner.org = ids.center = r.body.organizationId;
  const dep = await owner.post('/org/departments', { name: 'Pediatrics' });
  ids.dep = dep.body.id;
  const inv = await owner.post('/staff/invitations', { email: 'nour@synthetic.medora', role: 'doctor', specialty: 'pediatrics', departmentId: ids.dep, consultationFee: 80 });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  assert.equal(inv.body.emailDelivery, 'awaiting_credentials');
  const token = inv.body.acceptUrl.split('/invite/')[1];
  const preview = await new Client('anon').get(`/invitations/${token}`);
  assert.equal(preview.body.organization_name, 'Cedar Synthetic Medical Center');
  const acc = await dr.post(`/invitations/${token}/accept`);
  assert.equal(acc.status, 200, JSON.stringify(acc.body));
  ids.drCenterMid = acc.body.membership_id;
  const me = await dr.get('/auth/me');
  assert.equal(me.body.workspaces.length, 2, 'one account, two workspaces');
  const fees = (await owner.get('/staff')).body.filter((m: any) => m.role_code === 'doctor').map((m: any) => m.consultation_fee);
  assert.deepEqual(fees, [80]);
  assert.equal((await dr.post(`/invitations/${token}/accept`)).status, 400, 'invitation is single-use');
});

test('second doctor, assistant assigned to Dr Nour, and a stranger practice', async () => {
  const invB = await owner.post('/staff/invitations', { email: 'karim@synthetic.medora', role: 'doctor', specialty: 'cardiology' });
  // Karim has no account yet: sign up as a doctor with own practice, then accept.
  const reg = await drB.post('/auth/register/doctor', { fullName: 'Dr Karim Saad', email: 'karim@synthetic.medora', password: PW, specialty: 'cardiology', licenseNumber: 'LB-SYN-2002', clinicName: 'Saad Cardio' });
  assert.equal(reg.status, 201);
  const accB = await drB.post(`/invitations/${invB.body.acceptUrl.split('/invite/')[1]}/accept`);
  ids.drBMid = accB.body.membership_id; drB.org = ids.center;

  const invA = await owner.post('/staff/invitations', { email: 'lina@synthetic.medora', role: 'assistant', assignToDoctorMembershipId: ids.drCenterMid });
  const anon = await asst.post('/auth/register/center', { fullName: 'Lina Assistant', email: 'lina@synthetic.medora', password: PW, centerName: 'Lina temp' });
  assert.equal(anon.status, 201);
  const accA = await asst.post(`/invitations/${invA.body.acceptUrl.split('/invite/')[1]}/accept`);
  ids.asstMid = accA.body.membership_id; asst.org = ids.center;

  const s = await stranger.post('/auth/register/doctor', { fullName: 'Dr Other', email: 'other@synthetic.medora', password: PW, specialty: 'dermatology', licenseNumber: 'LB-SYN-3003', clinicName: 'Other Derm' });
  stranger.org = s.body.organizationId;
});

test('wrong email cannot accept an invitation', async () => {
  const inv = await owner.post('/staff/invitations', { email: 'someone-else@synthetic.medora', role: 'receptionist' });
  const r = await stranger.post(`/invitations/${inv.body.acceptUrl.split('/invite/')[1]}/accept`);
  assert.equal(r.status, 400);
  assert.match(r.body.message, /different email/);
});

test('specialty engine adapts the workspace per doctor', async () => {
  const ped = await dr.get('/specialty/workspace');
  assert.equal(ped.body.specialty.code, 'pediatrics');
  assert.ok(ped.body.profile.schema.sections.some((s: any) => s.key === 'vaccinations'));
  assert.ok(ped.body.widgets.includes('vaccinations_due'));
  const cardio = await drB.get('/specialty/workspace');
  assert.ok(cardio.body.profile.schema.sections.some((s: any) => s.key === 'ecg'));
  const derm = await stranger.get('/specialty/workspace');
  assert.ok(derm.body.profile.schema.sections.some((s: any) => s.key === 'lesions'));
});

let pChild = '';
test('assistant registers a patient for the assigned doctor; duplicates are caught', async () => {
  const r = await asst.post('/patients', { fullName: 'Synthetic Child Alpha', dateOfBirth: '2024-03-10', sex: 'female', phone: '+961 70 000 001' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  pChild = r.body.id;
  assert.match(r.body.patient_number, /^P-\d{6}$/);
  assert.equal(r.body.doctors[0].membership_id, ids.drCenterMid);
  assert.equal(r.body.allergies, undefined, 'assistant has no medical history permission');
  const dup = await asst.post('/patients', { fullName: 'Synthetic Child Alpha', phone: '+96170000001' });
  assert.equal(dup.status, 409); assert.equal(dup.body.code, 'possible_duplicate');
  const hidden = await drB.post('/patients/duplicates', { fullName: 'Synthetic Child Alfa', phone: '+961 70 000 001' });
  assert.equal(hidden.body.length, 1); assert.equal(hidden.body[0].visible, false);
  assert.ok(!hidden.body[0].masked_name.includes('Child'));
  assert.equal((await drB.get(`/patients/${pChild}`)).status, 404, 'Dr Karim cannot open Dr Nour\'s patient');
  assert.equal((await stranger.get(`/patients/${pChild}`)).status, 404, 'other tenant cannot open it');
  const found = await dr.req('GET', '/patients?q=alpha', undefined, { org: ids.center });
  assert.equal(found.body.length, 1);
  const byPhone = await asst.get('/patients?q=70000001');
  assert.equal(byPhone.body.length, 1);
});

test('forged workspace header is refused', async () => {
  const r = await stranger.req('GET', '/patients', undefined, { org: ids.center });
  assert.equal(r.status, 403);
});

test('specialty profile: validation, save, custom field with versioning keeps old records', async () => {
  dr.org = ids.center;
  const bad = await dr.put(`/patients/${pChild}/specialty`, { data: { birth: { birth_weight_kg: 40 } } });
  assert.equal(bad.status, 400);
  const ok = await dr.put(`/patients/${pChild}/specialty`, { data: { birth: { birth_weight_kg: 3.1, delivery: 'vaginal' }, vaccinations: { doses: [{ vaccine: 'Synthetic-BCG', given_on: '2024-03-11' }] } } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const v1 = ok.body.versionId;
  assert.equal((await asst.get(`/patients/${pChild}/specialty`)).status, 403, 'assistant needs the history permission');
  const cz = await dr.post('/specialty/customize', { customization: { addFields: [{ section: 'nutrition', field: { key: 'iron_supplement', type: 'boolean', label: 'Iron supplement' } }], hideFields: [{ section: 'birth', key: 'neonatal_notes' }] } });
  assert.equal(cz.status, 201, JSON.stringify(cz.body));
  assert.equal(cz.body.version, 1);
  const view = await dr.get(`/patients/${pChild}/specialty`);
  assert.equal(view.body.saved.versionId, v1, 'saved record still points to the version it was saved with');
  assert.ok(view.body.current.isCustom);
  const refuse = await dr.post('/specialty/customize', { customization: { hideFields: [{ section: 'growth', key: 'nope' }] } });
  assert.equal(refuse.status, 400);
  const again = await dr.put(`/patients/${pChild}/specialty`, { data: { nutrition: { iron_supplement: true } } });
  assert.equal(again.status, 200); assert.notEqual(again.body.versionId, v1);
});

test('appointments: booking, double-booking prevention, assistant scope, recurrence, slots', async () => {
  const a = await asst.post('/appointments', { patientId: pChild, doctorMembershipId: ids.drCenterMid, startsAt: tomorrowAt(8), durationMinutes: 30 });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  ids.appt = a.body.id;
  const clash = await asst.post('/appointments', { patientId: pChild, doctorMembershipId: ids.drCenterMid, startsAt: tomorrowAt(8, 15), durationMinutes: 20 });
  assert.equal(clash.status, 409); assert.equal(clash.body.code, 'double_booking');
  const other = await asst.post('/appointments', { patientId: pChild, doctorMembershipId: ids.drBMid, startsAt: tomorrowAt(10) });
  assert.equal(other.status, 403, 'assistant cannot book for a doctor they are not assigned to');
  const rec = await dr.post('/appointments', { patientId: pChild, doctorMembershipId: ids.drCenterMid, startsAt: tomorrowAt(12), durationMinutes: 20, recurrence: 'FREQ=WEEKLY;COUNT=3' });
  assert.equal(rec.status, 201); assert.equal(rec.body.appointments.length, 3);
  const day = tomorrowAt(0).slice(0, 10);
  const hours = await dr.put('/availability/working-hours', { doctorMembershipId: ids.drCenterMid, hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, starts: '09:00', ends: '12:00' })) });
  assert.equal(hours.status, 200);
  const slots = await asst.get(`/availability/slots?doctor=${ids.drCenterMid}&date=${day}&minutes=30`);
  assert.equal(slots.status, 200);
  assert.ok(slots.body.length > 0 && slots.body.length <= 6);
  const list = await drB.get(`/appointments?from=${tomorrowAt(0)}&to=${tomorrowAt(23)}`);
  assert.equal(list.body.length, 0, "Dr Karim does not see Dr Nour's calendar");
  const ownerList = await owner.get(`/appointments?from=${tomorrowAt(0)}&to=${tomorrowAt(23)}`);
  assert.equal(ownerList.status, 403, 'center owner has no appointment.manage by default');
  const re = await asst.patch(`/appointments/${ids.appt}`, { startsAt: tomorrowAt(9), durationMinutes: 20 });
  assert.equal(re.status, 200); assert.equal(new Date(re.body.starts_at).toISOString(), tomorrowAt(9));
});

test('live waiting room: arrival notifies the doctor over WebSocket; status machine enforced', async () => {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { cookie: dr.cookie } });
  const events: any[] = [];
  await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
  ws.on('message', (m) => events.push(JSON.parse(String(m))));
  ws.send(JSON.stringify({ type: 'subscribe', orgId: ids.center }));
  await new Promise((r) => setTimeout(r, 150));
  const arrive = await asst.post(`/appointments/${ids.appt}/status`, { status: 'arrived' });
  assert.equal(arrive.status, 200, JSON.stringify(arrive.body));
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(events.some((e) => e.type === 'waiting_room' && e.event === 'arrived' && e.appointment_id === ids.appt), JSON.stringify(events));
  const queue = await dr.get('/waiting-room');
  assert.equal(queue.body.length, 1);
  assert.equal(queue.body[0].patient_name, 'Synthetic Child Alpha');
  assert.ok(queue.body[0].waiting_seconds >= 0);
  const notes = await dr.get('/notifications?unread=1', { org: null });
  assert.ok(notes.body.some((n: any) => n.kind === 'patient_arrived'));
  assert.equal((await drB.get('/waiting-room')).body.length, 0);
  assert.equal((await asst.post(`/appointments/${ids.appt}/status`, { status: 'completed' })).status, 409, 'cannot skip the consultation');
  assert.equal((await dr.post(`/appointments/${ids.appt}/status`, { status: 'in_consultation' })).status, 200);
  assert.equal((await dr.post(`/appointments/${ids.appt}/status`, { status: 'completed' })).status, 200);
  assert.equal((await asst.patch(`/appointments/${ids.appt}`, { startsAt: tomorrowAt(15) })).status, 400, 'completed visits cannot be rescheduled');
  ws.close();
});

test('dashboard summary counts the doctor\'s day and shows vaccinations due', async () => {
  const s = await dr.get('/dashboard/summary');
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(typeof s.body.patients_today, 'number');
  assert.ok(Array.isArray(s.body.vaccinations_due));
  assert.equal((await stranger.req('GET', '/dashboard/summary', undefined, { org: ids.center })).status, 403);
});

test('walk-in goes straight to the waiting room even when the slot is taken', async () => {
  const w = await asst.post('/appointments/walk-in', { patientId: pChild, doctorMembershipId: ids.drCenterMid });
  assert.equal(w.status, 201, JSON.stringify(w.body));
  assert.equal(w.body.status, 'arrived'); assert.equal(w.body.is_walk_in, true);
  ids.walkIn = w.body.id;
});

// ---------------- Release 2: consultations, prescriptions, documents ----------------
const drC = () => { const c = new Client('Dr Nour at the center'); c.cookie = dr.cookie; c.org = ids.center; return c; };
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
async function upload(c: Client, pid: string, bytes: Buffer, type: string, q: string) {
  const r = await fetch(`${base}/api/patients/${pid}/documents?${q}`, { method: 'POST', headers: { cookie: c.cookie, 'x-org-id': c.org, 'content-type': type }, body: new Uint8Array(bytes) });
  return { status: r.status, body: await r.json() };
}

test('consultation: start from the waiting room, specialty exam form, validation, diagnoses', async () => {
  const d = drC();
  assert.equal((await asst.post('/consultations', { appointmentId: ids.walkIn })).status, 403, 'assistants do not write consultations');
  assert.equal((await drB.post('/consultations', { appointmentId: ids.walkIn })).status, 404, 'another doctor cannot even see the appointment');
  const s = await d.post('/consultations', { appointmentId: ids.walkIn });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  ids.cons = s.body.id;
  assert.equal(s.body.status, 'draft');
  assert.equal(s.body.specialty_code, 'pediatrics');
  assert.ok(s.body.template.schema.sections.some((x: any) => x.key === 'growth'), 'pediatric examination form');
  const again = await d.post('/consultations', { appointmentId: ids.walkIn });
  assert.equal(again.body.id, ids.cons, 'one consultation per appointment');
  assert.ok(!(await d.get('/waiting-room')).body.some((a: any) => a.appointment_id === ids.walkIn), 'patient left the queue');
  const bad = await d.patch(`/consultations/${ids.cons}`, { specialtyData: { growth: { weight_kg: 900 } } });
  assert.equal(bad.status, 400); assert.ok(bad.body.fieldErrors.length);
  const ok = await d.patch(`/consultations/${ids.cons}`, { chiefComplaint: 'Fever and ear pain for 2 days', clinicalNotes: 'Synthetic note',
    vitalSigns: { temperature_c: 38.6, pulse: 120 }, specialtyData: { growth: { weight_kg: 12.4, temperature_c: 38.6 } }, followUpDate: '2026-12-10' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.specialty_data.growth.weight_kg, 12.4);
  const dx = await d.put(`/consultations/${ids.cons}/diagnoses`, { diagnoses: [{ code: 'H66.9', description: 'Otitis media', isPrimary: true }, { code: null, description: 'Fever' }] });
  assert.equal(dx.status, 200, JSON.stringify(dx.body)); assert.equal(dx.body.diagnoses.length, 2);
  assert.equal((await drB.get(`/consultations/${ids.cons}`)).status, 404, 'other doctor cannot read it');
  assert.equal((await stranger.req('GET', `/consultations/${ids.cons}`, undefined, { org: ids.center })).status, 403);
  assert.equal((await asst.get(`/consultations/${ids.cons}`)).status, 403, 'assistant has no clinical notes permission');
});

test('prescriptions: catalog search, draft, issue, frozen, cancel, templates, doctor only', async () => {
  const d = drC();
  const meds = await d.get('/medications?q=amoxi');
  assert.equal(meds.status, 200); assert.ok(meds.body.length >= 3);
  assert.ok(meds.body.every((m: any) => /amoxi/i.test(m.name)));
  const amox = meds.body.find((m: any) => m.strength === '250 mg/5 ml');
  const items = [{ medicationId: amox.id, medicationName: 'Amoxicillin 250 mg/5 ml suspension', dosage: '5 ml', frequency: '3 times a day', duration: '7 days', instructions: 'After meals', notes: null }];
  assert.equal((await asst.post('/prescriptions', { patientId: pChild, items, notes: null })).status, 403, 'assistants cannot prescribe');
  const r = await d.post('/prescriptions', { patientId: pChild, consultationId: ids.cons, items, notes: 'Synthetic' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  ids.rx = r.body.id;
  assert.equal(r.body.status, 'draft'); assert.equal(r.body.items.length, 1);
  assert.equal((await d.post(`/consultations/${ids.cons}/sign`)).status, 409, 'cannot sign with a draft prescription pending');
  const edit = await d.patch(`/prescriptions/${ids.rx}`, { notes: null, items: [...items, { medicationId: null, medicationName: 'Paracetamol 120 mg/5 ml', dosage: '6 ml', frequency: 'every 6 hours if fever', duration: '3 days', instructions: null, notes: null }] });
  assert.equal(edit.status, 200); assert.equal(edit.body.items.length, 2);
  const iss = await d.post(`/prescriptions/${ids.rx}/issue`);
  assert.equal(iss.status, 201, JSON.stringify(iss.body)); assert.equal(iss.body.status, 'issued'); assert.ok(iss.body.issued_at);
  assert.equal(iss.body.organization_name, 'Cedar Synthetic Medical Center');
  const locked = await d.patch(`/prescriptions/${ids.rx}`, { notes: 'changed' });
  assert.equal(locked.status, 409); assert.equal(locked.body.code, 'record_locked');
  assert.equal((await d.req('DELETE', `/prescriptions/${ids.rx}`)).status, 409);
  const sh = await d.post(`/prescriptions/${ids.rx}/share`, { shared: true });
  assert.equal(sh.body.shared_with_patient, true); assert.equal(sh.body.delivery.email, 'awaiting_credentials');
  assert.equal((await drB.get(`/prescriptions/${ids.rx}`)).status, 404);
  assert.equal((await owner.get(`/prescriptions/${ids.rx}`)).status, 403, 'center owner has no prescription permission');
  // A second, standalone prescription is cancelled after issue.
  const r2 = await d.post('/prescriptions', { patientId: pChild, items, notes: null });
  await d.post(`/prescriptions/${r2.body.id}/issue`);
  assert.equal((await d.post(`/prescriptions/${r2.body.id}/cancel`, { reason: 'x' })).status, 400, 'a reason is required');
  const can = await d.post(`/prescriptions/${r2.body.id}/cancel`, { reason: 'Wrong dose' });
  assert.equal(can.body.status, 'cancelled');
  assert.equal((await d.post(`/prescriptions/${r2.body.id}/cancel`, { reason: 'Again' })).status, 409);
  const list = await d.get(`/patients/${pChild}/prescriptions`);
  assert.equal(list.body.length, 2);
  // Templates
  const t = await d.post('/prescription-templates', { name: 'Child otitis', notes: null, items });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  const fromTpl = await d.post('/prescriptions', { patientId: pChild, items: [], notes: null, templateId: t.body.id });
  assert.equal(fromTpl.body.items.length, 1);
  assert.equal((await d.req('DELETE', `/prescriptions/${fromTpl.body.id}`)).status, 200, 'drafts can be deleted');
  assert.equal((await drB.get('/prescription-templates')).body.length, 0, 'templates are private to their doctor');
  const custom = await d.post('/medications', { name: 'Synthetic compounded cream', strength: null, form: 'cream', route: 'topical' });
  assert.equal(custom.status, 201);
  assert.equal((await stranger.get('/medications?q=compounded')).body.length, 0, 'custom medications stay in their workspace');
});

test('documents: encrypted upload, type sniffing, download audited, history permission, soft delete', async () => {
  const d = drC();
  const fake = await upload(asst, pChild, Buffer.from('not a pdf'), 'application/pdf', 'kind=lab_result&title=CBC');
  assert.equal(fake.status, 400, 'content must match the declared type');
  assert.equal((await upload(asst, pChild, PDF, 'text/html', 'kind=lab_result&title=CBC')).status, 400, 'html is not accepted');
  const up = await upload(asst, pChild, PDF, 'application/pdf', 'kind=lab_result&title=CBC%20synthetic&filename=cbc.pdf');
  assert.equal(up.status, 201, JSON.stringify(up.body));
  ids.doc = up.body.id;
  const d2 = await upload(d, pChild, PDF, 'application/pdf', `kind=imaging&title=Ear%20photo&consultationId=${ids.cons}`);
  assert.equal(d2.status, 201, JSON.stringify(d2.body));
  // Stored bytes are encrypted on disk.
  const { config } = await import('../src/config.js');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = path.join(config.storageDir, ids.center);
  const onDisk = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f)));
  assert.ok(onDisk.length >= 2 && onDisk.every((b) => !b.includes(Buffer.from('%PDF'))), 'no plaintext on disk');
  assert.equal((await asst.get(`/patients/${pChild}/documents`)).body.length, 1, 'assistant without history permission sees only their own upload');
  assert.equal((await d.get(`/patients/${pChild}/documents`)).body.length, 2);
  const dl = await fetch(`${base}/api/documents/${ids.doc}/content?download=1`, { headers: { cookie: d.cookie, 'x-org-id': d.org } });
  assert.equal(dl.status, 200);
  assert.ok(Buffer.from(await dl.arrayBuffer()).equals(PDF), 'decrypted bytes match');
  assert.match(dl.headers.get('content-disposition') ?? '', /attachment; filename="cbc.pdf"/);
  assert.equal(dl.headers.get('cache-control'), 'private, no-store');
  assert.equal((await fetch(`${base}/api/documents/${ids.doc}/content`, { headers: { cookie: drB.cookie, 'x-org-id': ids.center } })).status, 404);
  const log = await owner.get('/org/audit');
  assert.ok(log.body.some((e: any) => e.action === 'document.download' && e.entity_id === ids.doc));
  const share = await d.patch(`/documents/${ids.doc}`, { sharedWithPatient: true });
  assert.equal(share.body.shared_with_patient, true);
  assert.equal((await d.req('DELETE', `/documents/${ids.doc}`)).status, 200);
  assert.equal((await d.get(`/patients/${pChild}/documents`)).body.length, 1, 'deleted documents leave the file');
});

test('signing locks the consultation; addenda; appointment completed; timeline shows clinical events', async () => {
  const d = drC();
  const s = await d.post(`/consultations/${ids.cons}/sign`);
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.equal(s.body.status, 'signed'); assert.ok(s.body.signed_at);
  const ch = await d.patch(`/consultations/${ids.cons}`, { clinicalNotes: 'rewrite history' });
  assert.equal(ch.status, 409); assert.equal(ch.body.code, 'record_locked');
  assert.equal((await d.put(`/consultations/${ids.cons}/diagnoses`, { diagnoses: [] })).status, 409);
  assert.equal((await d.req('DELETE', `/consultations/${ids.cons}`)).status, 409);
  assert.equal((await d.post('/prescriptions', { patientId: pChild, consultationId: ids.cons, items: [], notes: null })).status, 409);
  const add = await d.post(`/consultations/${ids.cons}/addenda`, { body: 'Parents called: fever settled.' });
  assert.equal(add.status, 201); assert.equal(add.body.addenda.length, 1);
  const appts = await d.get(`/appointments?from=${new Date(Date.now() - 86400e3).toISOString()}&to=${new Date(Date.now() + 86400e3).toISOString()}`);
  assert.equal(appts.body.find((a: any) => a.id === ids.walkIn)?.status, 'completed');
  const list = await d.get(`/patients/${pChild}/consultations`);
  assert.equal(list.body[0].status, 'signed'); assert.deepEqual(list.body[0].diagnoses, ['Otitis media', 'Fever']);
  const tl = await d.get(`/patients/${pChild}/timeline`);
  const kinds = new Set(tl.body.map((e: any) => e.kind));
  for (const k of ['consultation', 'prescription', 'document', 'appointment', 'registered']) assert.ok(kinds.has(k), `timeline has ${k}`);
  const tlA = await asst.get(`/patients/${pChild}/timeline`);
  assert.ok(!tlA.body.some((e: any) => e.kind === 'consultation'), 'assistant timeline hides confidential consultations');
  // A draft can be discarded and the patient returns to the queue.
  const w = await asst.post('/appointments/walk-in', { patientId: pChild, doctorMembershipId: ids.drCenterMid });
  const c2 = await d.post('/consultations', { appointmentId: w.body.id });
  assert.equal((await d.req('DELETE', `/consultations/${c2.body.id}`)).status, 200);
  assert.ok((await d.get('/waiting-room')).body.some((a: any) => a.appointment_id === w.body.id));
});

test('permissions: individually configurable, no escalation, prescriptions only for doctors', async () => {
  const noRx = await owner.put(`/staff/${ids.asstMid}/permissions`, { permissions: ['patient.register', 'prescription.create'] });
  assert.equal(noRx.status, 400);
  const notHeld = await owner.put(`/staff/${ids.asstMid}/permissions`, { permissions: ['patient.register', 'patient.file.read', 'appointment.manage', 'clinical_notes.read'] });
  assert.equal(notHeld.status, 403, 'owner cannot grant what they do not hold');
  const byDoctor = await dr.put(`/staff/${ids.asstMid}/permissions`, { permissions: ['patient.register', 'patient.file.read', 'appointment.manage', 'document.upload', 'patient.history.read'] });
  assert.equal(byDoctor.status, 200, JSON.stringify(byDoctor.body));
  assert.equal((await asst.get(`/patients/${pChild}/specialty`)).status, 200, 'grant takes effect immediately');
  const notMine = await drB.put(`/staff/${ids.asstMid}/permissions`, { permissions: [] });
  assert.equal(notMine.status, 403, 'a doctor can only manage their own assistants');
  const self = await asst.put(`/staff/${ids.asstMid}/permissions`, { permissions: [] });
  assert.equal(self.status, 403);
  const revoke = await dr.put(`/staff/${ids.asstMid}/permissions`, { permissions: ['patient.register', 'patient.file.read', 'document.upload'] });
  assert.equal(revoke.status, 200);
  assert.equal((await asst.get(`/appointments?from=${tomorrowAt(0)}&to=${tomorrowAt(23)}`)).status, 403, 'revoked permission blocks immediately');
  const log = await owner.get('/org/audit');
  assert.ok(log.body.some((e: any) => e.action === 'permission.change'));
});

test('suspended membership loses access to that workspace only', async () => {
  const s = await owner.patch(`/staff/${ids.drBMid}`, { status: 'suspended' });
  assert.equal(s.status, 200);
  assert.equal((await drB.get('/patients')).status, 403);
  const own = await drB.req('GET', '/specialty/workspace', undefined, { org: (await drB.get('/auth/me', { org: null })).body.workspaces.find((w: any) => w.kind === 'independent_practice').organization_id });
  assert.equal(own.status, 200, 'own practice still works');
});

test('MFA: setup, enable, login requires code', async () => {
  const c = new Client('mfa');
  await c.post('/auth/login', { email: 'other@synthetic.medora', password: PW });
  const setup = await c.post('/auth/mfa/setup');
  assert.equal(setup.status, 201);
  assert.equal((await c.post('/auth/mfa/enable', { code: '000000' })).status, 400);
  assert.equal((await c.post('/auth/mfa/enable', { code: totp(setup.body.secret) })).status, 200);
  const c2 = new Client('mfa2');
  const login = await c2.post('/auth/login', { email: 'other@synthetic.medora', password: PW });
  assert.equal(login.body.mfaRequired, true);
  assert.equal((await c2.get('/auth/me')).status, 401);
  assert.equal((await c2.post('/auth/mfa/verify', { code: '123456' })).status, 401);
  assert.equal((await c2.post('/auth/mfa/verify', { code: totp(setup.body.secret) })).status, 200);
  assert.equal((await c2.get('/auth/me')).status, 200);
});

test('account recovery: reset link works once and signs out other sessions', async () => {
  const c = new Client('reset');
  const f = await c.post('/auth/password/forgot', { email: 'karim@synthetic.medora' });
  assert.equal(f.status, 202); assert.equal(f.body.emailDelivery, 'awaiting_credentials');
  const unknown = await c.post('/auth/password/forgot', { email: 'nobody@synthetic.medora' });
  assert.equal(unknown.body.message, f.body.message);
  const token = new URL(f.body.devResetUrl).searchParams.get('token');
  assert.equal((await c.post('/auth/password/reset', { token, password: 'New-Synthetic-Pass-1' })).status, 200);
  assert.equal((await c.post('/auth/password/reset', { token, password: 'Another-Pass-123' })).status, 400);
  assert.equal((await drB.get('/auth/me', { org: null })).status, 401, 'old session revoked');
  assert.equal((await c.post('/auth/login', { email: 'karim@synthetic.medora', password: 'New-Synthetic-Pass-1' })).status, 200);
});

test('shared role defaults match the database', async () => {
  const { ROLE_DEFAULTS } = await import('@medora/shared');
  const pg = require('pg');
  const c = new pg.Client(process.env.DATABASE_URL || 'postgres://medora:medora_dev@localhost:5432/medora');
  await c.connect();
  const rows = (await c.query('SELECT role_code, array_agg(permission_code ORDER BY permission_code) p FROM role_default_permissions GROUP BY role_code')).rows;
  await c.end();
  for (const r of rows) assert.deepEqual(r.p, [...ROLE_DEFAULTS[r.role_code]].sort(), r.role_code);
});
