// Release 5 end-to-end tests: patient portal (accounts from invitations, appointments, requests, shared prescriptions and
// documents, profile and consent), isolation between patients and from staff data, and Web Push delivery to a local
// stand-in push service (payload decrypted with the subscriber's keys). Synthetic data only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { type Server } from 'node:http';
import { createServer as createHttpsServer, Agent } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createECDH, randomBytes } from 'node:crypto';

process.env.COMM_WORKER = 'off';
const { createApp } = await import('../src/app.js');
const require = createRequire(import.meta.url);
const ece = require('http_ece');

let server: Awaited<ReturnType<typeof createApp>>; let base = '';
let pushSvc: Server; const pushed: { headers: any; body: Buffer }[] = []; let pushStatus = 201;

class Client {
  cookie = ''; org = '';
  async req(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.cookie) headers.cookie = this.cookie; if (this.org) headers['x-org-id'] = this.org;
    const r = await fetch(`${base}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) this.cookie = set.split(';')[0];
    const text = await r.text(); let parsed: any = text; try { parsed = text ? JSON.parse(text) : null; } catch { /* raw */ }
    return { status: r.status, body: parsed, headers: r.headers };
  }
  get = (p: string) => this.req('GET', p); post = (p: string, b?: unknown) => this.req('POST', p, b ?? {});
  patch = (p: string, b: unknown) => this.req('PATCH', p, b); del = (p: string) => this.req('DELETE', p);
}
const PW = 'Synthetic-Pass-2026';
const dr = new Client(), pat = new Client(), pat2 = new Client(), other = new Client();
const ids: Record<string, string> = {};
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const days = (n: number, h = 10) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); d.setUTCHours(h, 0, 0, 0); return d; };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  // Push services are HTTPS: the stand-in uses a throwaway self-signed certificate that only the test's agent trusts.
  const dir = mkdtempSync(join(tmpdir(), 'medora-push-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'),
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const tls = { key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) };
  pushSvc = createHttpsServer(tls, (req, res) => { const chunks: Buffer[] = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => { pushed.push({ headers: req.headers, body: Buffer.concat(chunks) }); res.statusCode = pushStatus; res.end(); }); });
  await new Promise<void>((r) => pushSvc.listen(0, '127.0.0.1', () => r()));
  const { migrate } = require('../../../../db/migrate.js');
  const { syncPresets } = require('../../../../db/sync_presets.js');
  await migrate({ reset: true, log: () => {} });
  await syncPresets({ log: () => {} });
  server = await createApp({ logger: process.env.TEST_LOG === '1' });
  const { PushService } = await import('../src/portal/push.js');
  server.app.get(PushService).agent = new Agent({ ca: tls.cert });
  await server.app.listen(0);
  base = `http://127.0.0.1:${(server.app.getHttpServer().address() as any).port}`;
  const r = await dr.post('/auth/register/doctor', { fullName: 'Dr Lea Synthetic', email: 'lea@synthetic.medora', password: PW, specialty: 'general_practice',
    licenseNumber: 'LB-SYN-5001', clinicName: 'Synthetic Portal Clinic', consultationFee: 40 });
  dr.org = r.body.organizationId; ids.drMid = r.body.membershipId;
  const o = await other.post('/auth/register/doctor', { fullName: 'Dr Other Synthetic', email: 'other5@synthetic.medora', password: PW, specialty: 'dermatology',
    licenseNumber: 'LB-SYN-5002', clinicName: 'Another Synthetic Clinic', consultationFee: 40 });
  other.org = o.body.organizationId;
  ids.p1 = (await dr.post('/patients', { fullName: 'Synthetic Portal Patient', phone: '+961 70 111 222', confirmNotDuplicate: true })).body.id;
  ids.p2 = (await dr.post('/patients', { fullName: 'Synthetic Second Patient', phone: '+961 70 333 444', confirmNotDuplicate: true })).body.id;
  // Clinical data: one shared and one private prescription, one shared and one private document.
  const items = [{ medicationId: null, medicationName: 'Paracetamol 500 mg', dosage: '1 tablet', frequency: 'every 6 hours if needed', duration: '3 days', instructions: null, notes: null }];
  for (const share of [true, false]) {
    const rx = await dr.post('/prescriptions', { patientId: ids.p1, items, notes: null });
    await dr.post(`/prescriptions/${rx.body.id}/issue`);
    if (share) { await dr.post(`/prescriptions/${rx.body.id}/share`, { shared: true }); ids.rxShared = rx.body.id; } else ids.rxPrivate = rx.body.id;
  }
  for (const share of [true, false]) {
    const up = await fetch(`${base}/api/patients/${ids.p1}/documents?kind=lab_result&title=${share ? 'Shared%20CBC' : 'Private%20note'}&filename=x.pdf`,
      { method: 'POST', headers: { cookie: dr.cookie, 'x-org-id': dr.org, 'content-type': 'application/pdf' }, body: new Uint8Array(PDF) });
    const d = await up.json();
    if (share) { await dr.patch(`/documents/${d.id}`, { sharedWithPatient: true }); ids.docShared = d.id; } else ids.docPrivate = d.id;
  }
});
after(async () => { await server.close(); pushSvc.close(); });

test('invitation: wrong email is refused, the invited email creates a patient account', async () => {
  const inv = await dr.post(`/patients/${ids.p1}/portal/invitations`, { email: 'maha.patient@synthetic.medora' });
  assert.equal(inv.status, 201, JSON.stringify(inv.body)); assert.equal(inv.body.emailDelivery, 'awaiting_credentials');
  ids.token = inv.body.inviteUrl.split('/portal/invite/')[1];
  const prev = await pat.get(`/portal/invitations/${ids.token}`);
  assert.equal(prev.body.clinic, 'Synthetic Portal Clinic'); assert.equal(prev.body.valid, true);
  const wrong = await pat.post('/auth/register/patient', { fullName: 'Someone Else', email: 'someone@synthetic.medora', password: PW, invitation: ids.token });
  assert.equal(wrong.status, 400); assert.match(wrong.body.message, /another email/);
  const ok = await pat.post('/auth/register/patient', { fullName: 'Maha Synthetic', email: 'maha.patient@synthetic.medora', password: PW, invitation: ids.token });
  assert.equal(ok.status, 201, JSON.stringify(ok.body)); assert.equal(ok.body.patientId, ids.p1);
  const me = await pat.get('/auth/me');
  assert.equal(me.body.patientRecords, 1); assert.equal(me.body.workspaces.length, 0);
  assert.equal((await pat2.post('/auth/register/patient', { fullName: 'Again', email: 'maha2@synthetic.medora', password: PW, invitation: ids.token })).status, 400, 'used invitations cannot be reused');
  const st = await dr.get(`/patients/${ids.p1}/portal`);
  assert.equal(st.body.account.email, 'maha.patient@synthetic.medora');
});

test('a patient account has no staff access', async () => {
  pat.org = dr.org;
  assert.equal((await pat.get('/patients')).status, 403);
  assert.equal((await pat.get(`/patients/${ids.p1}`)).status, 403);
  assert.equal((await pat.get('/appointments?from=2020-01-01T00:00:00Z&to=2030-01-01T00:00:00Z')).status, 403);
  pat.org = '';
});

test('the patient sees their record, only shared prescriptions and documents, and can open a shared file', async () => {
  const me = await pat.get('/portal/me');
  assert.equal(me.body.records.length, 1); assert.equal(me.body.records[0].clinic, 'Synthetic Portal Clinic');
  const rx = await pat.get('/portal/prescriptions');
  assert.deepEqual(rx.body.map((r: any) => r.id), [ids.rxShared]);
  assert.equal(rx.body[0].items[0].medication, 'Paracetamol 500 mg');
  const docs = await pat.get('/portal/documents');
  assert.deepEqual(docs.body.map((d: any) => d.id), [ids.docShared]);
  const f = await fetch(`${base}/api/portal/documents/${ids.docShared}/content?download=1`, { headers: { cookie: pat.cookie } });
  assert.equal(f.status, 200); assert.equal(f.headers.get('content-type'), 'application/pdf'); assert.deepEqual(Buffer.from(await f.arrayBuffer()), PDF);
  assert.equal((await fetch(`${base}/api/portal/documents/${ids.docPrivate}/content`, { headers: { cookie: pat.cookie } })).status, 404);
});

test('push: a subscribed device receives an encrypted, generic notification', async () => {
  const key = await pat.get('/push/key');
  assert.equal(key.body.enabled, true); assert.ok(key.body.publicKey.length > 80);
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys(); const authSecret = randomBytes(16);
  const endpoint = `https://127.0.0.1:${(pushSvc.address() as any).port}/push/device-1`;
  const s = await pat.post('/push/subscriptions', { endpoint, keys: { p256dh: ecdh.getPublicKey('base64url'), auth: authSecret.toString('base64url') }, userAgent: 'synthetic-test' });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  ids.endpoint = endpoint; (globalThis as any).__ecdh = ecdh; (globalThis as any).__auth = authSecret;
});

test('appointment requests: patient asks, the doctor is notified, staff accept, the patient is told (and pushed)', async () => {
  const docs = await pat.get(`/portal/doctors?patient=${ids.p1}`);
  assert.equal(docs.body.length, 1);
  assert.equal((await pat.post('/portal/requests', { patientId: ids.p2, doctorMembershipId: null, preferredDate: days(3).toISOString().slice(0, 10), preferredTime: 'morning', note: null })).status, 400,
    'cannot request for someone else');
  const r = await pat.post('/portal/requests', { patientId: ids.p1, doctorMembershipId: ids.drMid, preferredDate: days(3).toISOString().slice(0, 10), preferredTime: 'morning', note: 'Synthetic check-up' });
  assert.equal(r.status, 201, JSON.stringify(r.body)); ids.req = r.body.id;
  const notes = await dr.get('/notifications?unread=1');
  assert.ok(notes.body.some((n: any) => n.kind === 'appointment_request'), JSON.stringify(notes.body));
  const list = await dr.get('/appointment-requests');
  assert.equal(list.body.length, 1); assert.equal(list.body[0].note, 'Synthetic check-up');
  assert.equal((await other.get('/appointment-requests')).body.length, 0, 'another clinic sees nothing');
  pushed.length = 0;
  const acc = await dr.post(`/appointment-requests/${ids.req}/accept`, { startsAt: days(3, 8).toISOString(), durationMinutes: 20, doctorMembershipId: ids.drMid, note: 'See you then' });
  assert.equal(acc.status, 200, JSON.stringify(acc.body)); ids.appt = acc.body.appointmentId;
  assert.equal((await dr.post(`/appointment-requests/${ids.req}/accept`, { startsAt: days(4, 8).toISOString(), doctorMembershipId: ids.drMid, note: null })).status, 409);
  const mine = await pat.get('/portal/requests');
  assert.equal(mine.body[0].status, 'accepted'); assert.equal(mine.body[0].appointment_starts_at, days(3, 8).toISOString());
  const appts = await pat.get('/portal/appointments');
  assert.equal(appts.body[0].id, ids.appt); assert.equal(appts.body[0].status, 'confirmed'); assert.equal(appts.body[0].can_cancel, true);
  // Push: the stand-in push service received one encrypted message for this device.
  for (let i = 0; i < 30 && !pushed.length; i++) await wait(100);
  assert.equal(pushed.length, 1, 'one push');
  const p = pushed[0];
  assert.match(String(p.headers.authorization), /^vapid t=.+, k=.+/); assert.equal(p.headers['content-encoding'], 'aes128gcm');
  const plain = ece.decrypt(p.body, { version: 'aes128gcm', privateKey: (globalThis as any).__ecdh, authSecret: (globalThis as any).__auth });
  const msg = JSON.parse(plain.toString('utf8'));
  assert.equal(msg.title, 'Appointment booked'); assert.equal(msg.url, '/portal');
  assert.ok(!plain.toString('utf8').includes('Synthetic'), 'no names or clinical details in the push');
});

test('a dead push subscription is removed', async () => {
  pushStatus = 410; pushed.length = 0;
  const r = await pat.post('/portal/requests', { patientId: ids.p1, doctorMembershipId: null, preferredDate: days(5).toISOString().slice(0, 10), preferredTime: 'any', note: null });
  await dr.post(`/appointment-requests/${r.body.id}/decline`, { note: 'Fully booked that week' });
  for (let i = 0; i < 30 && !pushed.length; i++) await wait(100);
  await wait(200);
  const pg = require('pg'); const c = new pg.Client(process.env.DATABASE_URL || 'postgres://medora:medora_dev@localhost:5432/medora'); await c.connect();
  const n = (await c.query(`SELECT count(*)::int AS n FROM push_subscriptions WHERE endpoint=$1`, [ids.endpoint])).rows[0].n; await c.end();
  assert.equal(n, 0);
  const mine = await pat.get('/portal/requests');
  assert.equal(mine.body[0].status, 'declined'); assert.equal(mine.body[0].answer_note, 'Fully booked that week');
});

test('cancelling online: allowed until 2 hours before, staff are told', async () => {
  const c = await pat.post(`/portal/appointments/${ids.appt}/cancel`, { reason: 'Travelling' });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const notes = await dr.get('/notifications?unread=1');
  assert.ok(notes.body.some((n: any) => n.kind === 'appointment_cancelled_by_patient'));
  const soon = await dr.post('/appointments', { patientId: ids.p1, doctorMembershipId: ids.drMid, startsAt: new Date(Date.now() + 3600e3).toISOString(), durationMinutes: 20 });
  assert.equal(soon.status, 201, JSON.stringify(soon.body));
  const late = await pat.post(`/portal/appointments/${soon.body.id}/cancel`, { reason: null });
  assert.equal(late.status, 400); assert.match(late.body.message, /call the clinic/);
});

test('profile and WhatsApp consent from the app are recorded as the patient\'s own', async () => {
  const r = await pat.post('/portal/profile', { patientId: ids.p1, phone: '+961 70 111 222', whatsappNumber: '+961 70 999 000', email: 'maha.patient@synthetic.medora', address: null, preferredLanguage: 'ar', whatsappConsent: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.records[0].preferred_language, 'ar'); assert.equal(r.body.records[0].whatsapp_consent, true);
  const consent = await dr.get(`/patients/${ids.p1}/consent`);
  assert.equal(consent.body.history[0].source, 'patient_portal');
  assert.equal(consent.body.number, '96170999000');
  assert.equal((await pat.post('/portal/profile', { patientId: ids.p2, phone: null, whatsappNumber: null, email: null, address: null })).status, 404, 'not their record');
});

test('another patient sees nothing of the first; revoking access ends it', async () => {
  const inv = await dr.post(`/patients/${ids.p2}/portal/invitations`, { email: 'second@synthetic.medora' });
  await pat2.post('/auth/register/patient', { fullName: 'Second Synthetic', email: 'second@synthetic.medora', password: PW, invitation: inv.body.inviteUrl.split('/portal/invite/')[1] });
  assert.equal((await pat2.get('/portal/prescriptions')).body.length, 0);
  assert.equal((await pat2.get('/portal/documents')).body.length, 0);
  assert.equal((await pat2.get('/portal/appointments')).body.length, 0);
  assert.equal((await fetch(`${base}/api/portal/documents/${ids.docShared}/content`, { headers: { cookie: pat2.cookie } })).status, 404);
  assert.equal((await pat2.post(`/portal/appointments/${ids.appt}/cancel`, { reason: null })).status, 404);
  assert.equal((await dr.del(`/patients/${ids.p1}/portal`)).status, 200);
  assert.equal((await pat.get('/portal/me')).body.records.length, 0);
  assert.equal((await pat.get('/portal/prescriptions')).body.length, 0);
});
