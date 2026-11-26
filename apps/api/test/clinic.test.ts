// Clinic settings and money follow-up: outstanding balances and forgiving them, overbooking, absences,
// emergency access, sharing patients between doctors, day sheet, prescription list. Synthetic data only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createApp } from '../src/app.js';

const require = createRequire(import.meta.url);
const { Client: Pg } = require('pg');
let server: Awaited<ReturnType<typeof createApp>>; let base = '';

class Client {
  cookie = ''; org = '';
  async req(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.cookie) headers.cookie = this.cookie; if (this.org) headers['x-org-id'] = this.org;
    const r = await fetch(`${base}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) this.cookie = set.split(';')[0];
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b?: unknown) => this.req('POST', p, b ?? {});
  patch = (p: string, b: unknown) => this.req('PATCH', p, b);
  del = (p: string) => this.req('DELETE', p);
}
const PW = 'Synthetic-Pass-2026';
const owner = new Client(), drA = new Client(), drB = new Client(), asst = new Client(), desk = new Client();
const ids: Record<string, string> = {};
const at = (days: number, h: number, m = 0) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + days); d.setUTCHours(h, m, 0, 0); return d.toISOString(); };
async function sql(q: string, params: unknown[] = []) {
  const c = new Pg(process.env.DATABASE_URL || 'postgres://medora:medora_dev@localhost:5432/medora'); await c.connect();
  try { return (await c.query(q, params)).rows; } finally { await c.end(); }
}
async function join(c: Client, email: string, name: string, invite: Record<string, unknown>) {
  const inv = await owner.post('/staff/invitations', { email, ...invite });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  const reg = await c.post('/auth/register/center', { fullName: name, email, password: PW, centerName: `${name} temp` });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const acc = await c.post(`/invitations/${inv.body.acceptUrl.split('/invite/')[1]}/accept`);
  assert.equal(acc.status, 200, JSON.stringify(acc.body));
  c.org = ids.center;
  return acc.body.membership_id as string;
}

before(async () => {
  const { migrate } = require('../../../../db/migrate.js');
  const { syncPresets } = require('../../../../db/sync_presets.js');
  await migrate({ reset: true, log: () => {} });
  await syncPresets({ log: () => {} });
  server = await createApp({ logger: false });
  await server.app.listen(0);
  base = `http://127.0.0.1:${(server.app.getHttpServer().address() as any).port}`;

  const r = await owner.post('/auth/register/center', { fullName: 'Amal Synthetic Owner', email: 'amal@synthetic.medora', password: PW, centerName: 'Synthetic Shifa Center' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  owner.org = ids.center = r.body.organizationId;
  ids.drA = await join(drA, 'karim@synthetic.medora', 'Dr Karim Synthetic', { role: 'doctor', specialty: 'general_practice', consultationFee: 40 });
  ids.drB = await join(drB, 'layal@synthetic.medora', 'Dr Layal Synthetic', { role: 'doctor', specialty: 'dentistry' });
  ids.asst = await join(asst, 'lina@synthetic.medora', 'Lina Synthetic Assistant', { role: 'assistant', assignToDoctorMembershipId: ids.drA });
  ids.desk = await join(desk, 'rania@synthetic.medora', 'Rania Synthetic Desk', { role: 'receptionist' });
  const p = await desk.post('/patients', { fullName: 'Synthetic Patient Fairouz', phone: '+961 3 102 938', confirmNotDuplicate: true, doctorMembershipId: ids.drA });
  assert.equal(p.status, 201, JSON.stringify(p.body)); ids.patient = p.body.id; ids.patientNumber = p.body.patient_number;
  // Make sure Dr Karim is linked (booking links the doctor).
  const a = await desk.post('/appointments', { patientId: ids.patient, doctorMembershipId: ids.drA, startsAt: at(1, 7), durationMinutes: 20 });
  assert.equal(a.status, 201, JSON.stringify(a.body)); ids.appt = a.body.id;
});
after(async () => { await server.close(); });

test('clinic settings: owners change them, others cannot; message window must be a real window', async () => {
  const g = await owner.get('/org');
  assert.equal(g.body.organization.share_patients_between_doctors, false);
  assert.equal(g.body.organization.allow_overbooking, false);
  assert.equal(g.body.organization.doctors_manage_absences, true);
  assert.equal(g.body.organization.day_sheet_phones, false);
  assert.equal(g.body.organization.message_window_start, '08:00');
  assert.equal(g.body.organization.message_window_end, '20:00');
  const u = await owner.patch('/org', { legalName: 'Synthetic Shifa SARL', taxId: 'LB-000-SYN', messageWindowStart: '09:00', messageWindowEnd: '19:30' });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.equal(u.body.legal_name, 'Synthetic Shifa SARL'); assert.equal(u.body.message_window_end, '19:30');
  assert.equal((await owner.patch('/org', { messageWindowStart: '20:00', messageWindowEnd: '08:00' })).status, 400);
  assert.equal((await owner.patch('/org', { timezone: 'Mars/Olympus' })).status, 400);
  assert.equal((await drA.patch('/org', { allowOverbooking: true })).status, 403, 'a doctor in a center does not change clinic settings');
  assert.equal((await desk.patch('/org', { allowOverbooking: true })).status, 403);
});

test('doctor details: Order and NSSF numbers and note template are kept on the membership', async () => {
  const r = await owner.patch(`/staff/${ids.drA}`, { licenseNumber: '1438', nssfProviderNumber: 'NSSF-SYN-77', noteTemplate: 'soap' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.nssf_provider_number, 'NSSF-SYN-77'); assert.equal(r.body.note_template, 'soap');
  const list = (await owner.get('/staff')).body.find((m: any) => m.id === ids.drA);
  assert.equal(list.license_number, '1438'); assert.equal(list.nssf_provider_number, 'NSSF-SYN-77');
  assert.equal((await owner.patch(`/staff/${ids.drA}`, { noteTemplate: 'poem' })).status, 400);
});

test('outstanding balances: forgiving a debt closes it without counting income', async () => {
  await owner.post('/finance/rates', { lbpPerUsd: 89500, note: null });
  const inv = await desk.post('/invoices', { patientId: ids.patient, doctorMembershipId: ids.drA, issue: true, notes: null,
    items: [{ description: 'Consultation', unitPrice: 100, serviceId: null }] });
  assert.equal(inv.status, 201, JSON.stringify(inv.body)); ids.inv = inv.body.id;
  assert.equal((await desk.post(`/invoices/${ids.inv}/payments`, { method: 'cash', amount: 30, currency: 'USD', reference: null, note: null })).status, 201);

  let rec = await owner.get('/finance/receivables');
  assert.equal(rec.status, 200, JSON.stringify(rec.body));
  assert.equal(rec.body.stillOwed, 70); assert.equal(rec.body.collectedThisMonth, 30); assert.equal(rec.body.forgivenThisMonth, 0);
  assert.equal(rec.body.patients.length, 1); assert.equal(rec.body.patients[0].owed, 70); assert.equal(rec.body.patients[0].months, 0);

  assert.equal((await desk.post(`/invoices/${ids.inv}/write-offs`, { reason: 'Hardship' })).status, 403, 'the front desk cannot forgive debts');
  assert.equal((await asst.post(`/invoices/${ids.inv}/write-offs`, { reason: 'Hardship' })).status, 403);
  assert.equal((await owner.post(`/invoices/${ids.inv}/write-offs`, { reason: 'Too much', amount: 80 })).status, 400);
  const part = await owner.post(`/invoices/${ids.inv}/write-offs`, { reason: 'Family hardship', amount: 20 });
  assert.equal(part.status, 201, JSON.stringify(part.body));
  assert.equal(part.body.balance, 50); assert.equal(part.body.forgiven, 20); assert.equal(part.body.writeOffs.length, 1);
  const rest = await owner.post(`/invoices/${ids.inv}/write-offs`, { reason: 'Family hardship' });
  assert.equal(rest.body.balance, 0);
  assert.equal((await owner.post(`/invoices/${ids.inv}/write-offs`, { reason: 'Again' })).status, 409, 'nothing left to forgive');
  assert.equal((await drA.post(`/invoices/${ids.inv}/credit-notes`, { reason: 'Too late', amount: 40 })).status, 400, 'a forgiven amount cannot also be credited (only the 30 paid can)');

  rec = await owner.get('/finance/receivables');
  assert.equal(rec.body.stillOwed, 0); assert.equal(rec.body.forgivenThisMonth, 70); assert.equal(rec.body.patients.length, 0);
  const today = new Date().toISOString().slice(0, 10);
  const sum = await owner.get(`/finance/summary?from=${today}&to=${today}`);
  assert.equal(sum.body.received.total, 30, 'forgiving is never income');
  assert.equal(sum.body.forgiven, 70); assert.equal(sum.body.outstanding.amount, 0);
  assert.equal((await owner.get('/invoices?unpaid=1')).body.length, 0);
  // Write-offs cannot be edited or removed by the app.
  await assert.rejects(sql(`SET ROLE medora_app; DELETE FROM balance_writeoffs`));
});

test('overbooking: blocked unless the owner allows it, then needs a reason and is marked and audited', async () => {
  const clash = { patientId: ids.patient, doctorMembershipId: ids.drA, startsAt: at(1, 7, 10), durationMinutes: 20 };
  const r1 = await desk.post('/appointments', clash);
  assert.equal(r1.status, 409); assert.equal(r1.body.code, 'double_booking');
  assert.equal((await desk.post('/appointments', { ...clash, overbookReason: 'Urgent fever' })).status, 400, 'switched off: refused');
  assert.equal((await owner.patch('/org', { allowOverbooking: true })).status, 200);
  assert.equal((await desk.post('/appointments', { ...clash, overbookReason: 'x' })).status, 400, 'the reason is required');
  const ok = await desk.post('/appointments', { ...clash, overbookReason: 'Urgent fever' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body)); assert.equal(ok.body.overbook_reason, 'Urgent fever');
  const audit = await sql(`SELECT details FROM audit_log WHERE action='appointment.overbook' AND entity_id=$1`, [ok.body.id]);
  assert.equal(audit.length, 1);
  // Moving it to a free time clears the mark.
  const moved = await desk.patch(`/appointments/${ok.body.id}`, { startsAt: at(1, 9) });
  assert.equal(moved.status, 200, JSON.stringify(moved.body)); assert.equal(moved.body.overbook_reason, null);
  await owner.patch('/org', { allowOverbooking: false });
});

test('absences: doctors manage their own unless the owner turns that off', async () => {
  const body = { doctorMembershipId: ids.drA, kind: 'leave', startsAt: at(5, 6), endsAt: at(5, 14) };
  const a = await drA.post('/availability/exceptions', body);
  assert.equal(a.status, 201, JSON.stringify(a.body));
  await owner.patch('/org', { doctorsManageAbsences: false });
  assert.equal((await drA.post('/availability/exceptions', body)).status, 403);
  assert.equal((await drA.del(`/availability/exceptions/${a.body.id}`)).status, 403);
  assert.equal((await owner.post('/availability/exceptions', { ...body, startsAt: at(6, 6), endsAt: at(6, 8) })).status, 201, 'owners always can');
  assert.equal((await owner.del(`/availability/exceptions/${a.body.id}`)).status, 200);
  await owner.patch('/org', { doctorsManageAbsences: true });
});

test('patient privacy between doctors: private by default, emergency access is recorded, sharing opens all files', async () => {
  assert.equal((await drB.get(`/patients/${ids.patient}`)).status, 404, 'another doctor cannot open the file');
  assert.equal((await drB.post('/patients/emergency-access', { query: 'P-NOPE-1', reason: 'Covering for Dr Karim' })).status, 404);
  assert.equal((await drB.post('/patients/emergency-access', { query: ids.patientNumber, reason: 'x' })).status, 400, 'a reason is needed');
  assert.equal((await asst.post('/patients/emergency-access', { query: ids.patientNumber, reason: 'Covering for Dr Karim' })).status, 403, 'assistants cannot');
  const e = await drB.post('/patients/emergency-access', { query: ids.patientNumber, reason: 'Covering for Dr Karim tonight' });
  assert.equal(e.status, 201, JSON.stringify(e.body)); assert.equal(e.body.id, ids.patient);
  assert.equal((await drB.get(`/patients/${ids.patient}`)).status, 200, 'now open');
  const log = await owner.get('/org/emergency-access');
  assert.equal(log.status, 200); assert.equal(log.body.length, 1); assert.equal(log.body[0].reason, 'Covering for Dr Karim tonight');
  assert.equal((await drA.get('/org/emergency-access')).status, 403);
  // Access ends when it expires.
  await sql(`UPDATE emergency_access SET expires_at = now() - interval '1 minute'`);
  assert.equal((await drB.get(`/patients/${ids.patient}`)).status, 404, 'expired');

  await owner.patch('/org', { sharePatientsBetweenDoctors: true });
  assert.equal((await drB.get(`/patients/${ids.patient}`)).status, 200, 'any doctor here');
  assert.equal((await drB.get('/patients')).body.length, 1);
  await owner.patch('/org', { sharePatientsBetweenDoctors: false });
  assert.equal((await drB.get(`/patients/${ids.patient}`)).status, 404);
});

test('day sheet: phone numbers only when the owner allows them', async () => {
  const day = (await sql(`SELECT ((now() + interval '1 day') AT TIME ZONE 'Asia/Beirut')::date::text AS d`))[0].d;
  const s = await desk.get(`/day-sheet?date=${day}`);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.ok(s.body.appointments.length >= 1);
  assert.ok(s.body.appointments.every((a: any) => a.patient_phone === undefined)); assert.equal(s.body.phones, false);
  await owner.patch('/org', { daySheetPhones: true });
  const s2 = await desk.get(`/day-sheet?date=${day}`);
  assert.ok(s2.body.appointments.some((a: any) => a.patient_phone)); assert.equal(s2.body.phones, true);
});

test('clinic-wide prescription list: own doctor sees it, other doctor does not, search by medication', async () => {
  const r = await drA.post('/prescriptions', { patientId: ids.patient, notes: null,
    items: [{ medicationName: 'Metformin 850 mg', dosage: '1 tablet', frequency: 'morning and evening', duration: '3 months', instructions: null, notes: null }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const all = await drA.get('/prescriptions');
  assert.equal(all.status, 200); assert.equal(all.body.length, 1); assert.equal(all.body[0].items[0].name, 'Metformin 850 mg');
  assert.equal((await drA.get('/prescriptions?q=metfor')).body.length, 1);
  assert.equal((await drA.get('/prescriptions?q=insulin')).body.length, 0);
  assert.equal((await drA.get('/prescriptions?status=issued')).body.length, 0);
  assert.equal((await drB.get('/prescriptions')).body.length, 0, 'private to the treating doctor');
});

test('visits list and activity report: per doctor, searchable, owners see counts but not diagnoses', async () => {
  const w = await desk.post('/appointments/walk-in', { patientId: ids.patient, doctorMembershipId: ids.drA });
  assert.equal(w.status, 201, JSON.stringify(w.body));
  const s = await drA.post('/consultations', { appointmentId: w.body.id });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  const dx = await drA.req('PUT', `/consultations/${s.body.id}/diagnoses`, { diagnoses: [{ code: 'H66.9', description: 'Otitis media', isPrimary: true }] });
  assert.equal(dx.status, 200, JSON.stringify(dx.body));

  const list = await drA.get('/consultations');
  assert.equal(list.status, 200, JSON.stringify(list.body)); assert.equal(list.body.length, 1);
  assert.equal(list.body[0].patient_name, 'Synthetic Patient Fairouz'); assert.deepEqual(list.body[0].diagnoses, ['Otitis media']);
  assert.equal((await drA.get('/consultations?q=otitis')).body.length, 1);
  assert.equal((await drA.get('/consultations?q=H66.9')).body.length, 1);
  assert.equal((await drA.get('/consultations?status=signed')).body.length, 0);
  assert.equal((await drB.get('/consultations')).body.length, 0, 'another doctor does not see these visits');
  assert.equal((await desk.get('/consultations')).status, 403, 'reception does not read visits');

  const [{ from, to }] = await sql(`SELECT ((now() AT TIME ZONE 'Asia/Beirut')::date - 1)::text AS from, ((now() AT TIME ZONE 'Asia/Beirut')::date + 3)::text AS to`);
  const r = await owner.get(`/reports/activity?from=${from}&to=${to}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.totals.booked >= 2); assert.equal(r.body.totals.walk_in, 1); assert.equal(r.body.totals.new_patients, 1);
  assert.ok(r.body.byDoctor.some((d: any) => d.doctor_name === 'Dr Karim Synthetic'));
  assert.equal(r.body.diagnoses.length, 0, 'the owner sees no diagnoses without clinical access');
  const mine = await drA.get(`/reports/activity?from=${from}&to=${to}`);
  assert.equal(mine.status, 200); assert.equal(mine.body.diagnoses[0].description, 'Otitis media'); assert.equal(mine.body.totals.visits, 1);
  assert.equal((await drB.get(`/reports/activity?from=${from}&to=${to}`)).body.totals.booked, 0, 'a doctor in a center counts only their own');
  assert.equal((await desk.get(`/reports/activity?from=${from}&to=${to}`)).status, 403);
  assert.equal((await owner.get(`/reports/activity?from=${to}&to=${from}`)).status, 400);
  assert.equal((await owner.get(`/reports/activity?from=2024-01-01&to=2026-01-01`)).status, 400, 'at most a year');
});
