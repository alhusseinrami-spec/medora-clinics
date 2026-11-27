// Live sync between the doctor and the front desk: call-in alerts, the visit fee, prescriptions to print, checkout.
// Synthetic data only.
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
  put = (p: string, b: unknown) => this.req('PUT', p, b);
  del = (p: string) => this.req('DELETE', p);
}
const PW = 'Synthetic-Pass-2026';
const owner = new Client(), drA = new Client(), drB = new Client(), asst = new Client(), desk = new Client();
const ids: Record<string, string> = {};
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

  const r = await owner.post('/auth/register/center', { fullName: 'Amal Synthetic Owner', email: 'amal@synthetic.medora', password: PW, centerName: 'Synthetic Live Center' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  owner.org = ids.center = r.body.organizationId;
  ids.drA = await join(drA, 'karim@synthetic.medora', 'Dr Karim Synthetic', { role: 'doctor', specialty: 'general_practice', consultationFee: 40 });
  ids.drB = await join(drB, 'layal@synthetic.medora', 'Dr Layal Synthetic', { role: 'doctor', specialty: 'dentistry' });
  ids.asst = await join(asst, 'lina@synthetic.medora', 'Lina Synthetic Assistant', { role: 'assistant', assignToDoctorMembershipId: ids.drA });
  ids.desk = await join(desk, 'rania@synthetic.medora', 'Rania Synthetic Desk', { role: 'receptionist' });
  const p = await desk.post('/patients', { fullName: 'Synthetic Patient Fairouz', phone: '+961 3 102 938', confirmNotDuplicate: true, doctorMembershipId: ids.drA });
  assert.equal(p.status, 201, JSON.stringify(p.body)); ids.patient = p.body.id;
  const a = await desk.post('/appointments', { patientId: ids.patient, doctorMembershipId: ids.drA, startsAt: new Date(Date.now() + 5 * 60000).toISOString(), durationMinutes: 20 });
  assert.equal(a.status, 201, JSON.stringify(a.body)); ids.appt = a.body.id;
});
after(async () => { await server.close(); });

test('doctor and front desk stay in step: call-in, visit fee, prescription and checkout', async () => {
  const first = await asst.get('/live');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body.events, []); assert.ok(first.body.sig && first.body.cursor);
  const otherFirst = await drB.get('/live');

  assert.equal((await desk.post(`/appointments/${ids.appt}/status`, { status: 'arrived' })).status, 200);
  const con = await drA.post('/consultations', { appointmentId: ids.appt });
  assert.equal(con.status, 201, JSON.stringify(con.body)); ids.con = con.body.id;

  // The assistant's next poll shows that the doctor called the patient in, and the screens must refresh.
  const second = await asst.get(`/live?since=${encodeURIComponent(first.body.cursor)}`);
  assert.notEqual(second.body.sig, first.body.sig);
  const called = second.body.events.find((e: any) => e.type === 'called');
  assert.ok(called, JSON.stringify(second.body.events));
  assert.equal(called.patient_name, 'Synthetic Patient Fairouz'); assert.equal(called.doctor_name, 'Dr Karim Synthetic'); assert.equal(called.appointment_id, ids.appt);
  assert.ok((await desk.get(`/live?since=${encodeURIComponent(first.body.cursor)}`)).body.events.some((e: any) => e.type === 'called'), 'the center front desk sees it too');
  const other = await drB.get(`/live?since=${encodeURIComponent(first.body.cursor)}`);
  assert.equal(other.body.events.length, 0, 'another doctor does not see this visit');
  assert.equal(other.body.sig, otherFirst.body.sig, 'nor does their screen change');

  // The fee: set by the treating doctor; not by another doctor or by an assistant who does not take payments.
  assert.equal((await drB.put(`/appointments/${ids.appt}/fee`, { amount: 10, currency: 'USD', note: null })).status, 404);
  assert.equal((await asst.put(`/appointments/${ids.appt}/fee`, { amount: 10, currency: 'USD', note: null })).status, 403);
  const fee = await drA.put(`/appointments/${ids.appt}/fee`, { amount: 55, currency: 'USD', note: 'Consultation + ECG' });
  assert.equal(fee.status, 200, JSON.stringify(fee.body));
  assert.equal(Number(fee.body.fee_amount), 55); assert.equal(fee.body.fee_currency, 'USD'); assert.equal(Number(fee.body.fee_suggested), 40);
  const third = await asst.get(`/live?since=${encodeURIComponent(second.body.cursor)}`);
  const feeEv = third.body.events.find((e: any) => e.type === 'fee');
  assert.ok(feeEv, JSON.stringify(third.body.events)); assert.equal(feeEv.fee_amount, 55); assert.equal(feeEv.fee_currency, 'USD');

  // A prescription and signing the visit.
  const rx = await drA.post('/prescriptions', { patientId: ids.patient, consultationId: ids.con, notes: null,
    items: [{ medicationId: null, medicationName: 'Amoxicillin 500 mg', dosage: '1 capsule', frequency: '3 times a day', duration: '7 days', instructions: null, notes: null }] });
  assert.equal(rx.status, 201, JSON.stringify(rx.body));
  assert.equal((await drA.post(`/prescriptions/${rx.body.id}/issue`)).status, 201);
  assert.equal((await drA.patch(`/consultations/${ids.con}`, { chiefComplaint: 'Synthetic sore throat' })).status, 200);
  assert.equal((await drA.post(`/consultations/${ids.con}/sign`)).status, 201);

  // The assistant only sees prescriptions with prescription.view; then she sees the visit finished and the prescription.
  let out = await asst.get('/front-desk/checkout');
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.length, 1); assert.equal(out.body[0].status, 'completed'); assert.equal(out.body[0].fee_amount, 55);
  assert.deepEqual(out.body[0].prescriptions, []); assert.equal(out.body[0].invoice, null);
  const staff = (await owner.get('/staff')).body; const lina = staff.find((m: any) => m.id === ids.asst);
  assert.equal((await drA.put(`/staff/${ids.asst}/permissions`, { permissions: [...lina.permissions, 'prescription.view', 'payment.register'] })).status, 200);
  const fourth = await asst.get(`/live?since=${encodeURIComponent(third.body.cursor)}`);
  assert.ok(fourth.body.events.some((e: any) => e.type === 'completed'), JSON.stringify(fourth.body.events));
  assert.ok(fourth.body.events.some((e: any) => e.type === 'prescription' && e.prescription_id === rx.body.id));
  out = await asst.get('/front-desk/checkout');
  assert.deepEqual(out.body[0].prescriptions.map((x: any) => x.id), [rx.body.id]);
  const deskOut = await desk.get('/front-desk/checkout');
  assert.equal(deskOut.body.length, 1); assert.deepEqual(deskOut.body[0].prescriptions, [], 'the center front desk does not read prescriptions');

  // Invoicing the visit uses the doctor's fee; after that the fee is changed on the invoice, not the visit.
  await owner.post('/finance/rates', { lbpPerUsd: 89500, note: null });
  const inv = await asst.post('/invoices', { appointmentId: ids.appt, notes: null });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  assert.equal(inv.body.items.length, 1); assert.equal(Number(inv.body.items[0].unit_price), 55); assert.equal(inv.body.items[0].description, 'Consultation + ECG');
  const late = await drA.put(`/appointments/${ids.appt}/fee`, { amount: 60, currency: 'USD', note: null });
  assert.equal(late.status, 409); assert.equal(late.body.code, 'already_invoiced');
  out = await asst.get('/front-desk/checkout');
  assert.equal(out.body[0].invoice.id, inv.body.id); assert.equal(out.body[0].invoice.due, 55);
});
