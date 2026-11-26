// Release 4 end-to-end tests: WhatsApp numbers, templates, automation, consent, the sending worker, Meta's webhook,
// the inbox and real-time events. Meta is replaced by a local stand-in server that answers like the Cloud API, so these
// tests prove our side of the contract only. Synthetic data only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { WebSocket } from 'ws';

process.env.COMM_WORKER = 'off';
process.env.WHATSAPP_APP_SECRET = 'synthetic-app-secret';
process.env.WHATSAPP_VERIFY_TOKEN = 'synthetic-verify-token';

const { createApp } = await import('../src/app.js');
const { CommWorker } = await import('../src/comm/worker.js');
const { toWaNumber } = await import('../src/comm/whatsapp.js');
const require = createRequire(import.meta.url);

let server: Awaited<ReturnType<typeof createApp>>; let base = '';
let meta: Server; const sent: any[] = []; let seq = 0;
const GOOD = 'synthetic-good-token-0000000000';

class Client {
  cookie = ''; org = '';
  async req(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.cookie) headers.cookie = this.cookie; if (this.org) headers['x-org-id'] = this.org;
    const r = await fetch(`${base}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) this.cookie = set.split(';')[0];
    const text = await r.text(); let parsed: any = text; try { parsed = text ? JSON.parse(text) : null; } catch { /* text */ }
    return { status: r.status, body: parsed };
  }
  get = (p: string) => this.req('GET', p); post = (p: string, b?: unknown) => this.req('POST', p, b ?? {});
  put = (p: string, b: unknown) => this.req('PUT', p, b); patch = (p: string, b: unknown) => this.req('PATCH', p, b); del = (p: string) => this.req('DELETE', p);
}
const PW = 'Synthetic-Pass-2026';
const dr = new Client(), other = new Client(), owner = new Client(), recep = new Client();
const ids: Record<string, string> = {};
const tick = () => server.app.get(CommWorker).tick();
const hook = async (payload: unknown, secret = 'synthetic-app-secret') => {
  const raw = JSON.stringify(payload);
  const sig = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
  const r = await fetch(`${base}/api/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body: raw });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const inbound = (pnid: string, from: string, text: string, id = `wamid.in.${++seq}`) => ({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'messages',
  value: { messaging_product: 'whatsapp', metadata: { phone_number_id: pnid, display_phone_number: '96101000000' },
    messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });
const status = (pnid: string, id: string, s: string) => ({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'messages',
  value: { metadata: { phone_number_id: pnid }, statuses: [{ id, status: s, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '9613123456' }] } }] }] });
const inHours = (h: number) => { const d = new Date(Date.now() + h * 3600e3); d.setSeconds(0, 0); return d.toISOString(); };

before(async () => {
  // Stand-in for graph.facebook.com: validates the bearer token and records what we send.
  meta = createServer((req, res) => {
    let data = ''; req.on('data', (c) => (data += c)); req.on('end', () => {
      const ok = req.headers.authorization === `Bearer ${GOOD}`;
      res.setHeader('content-type', 'application/json');
      if (!ok) { res.statusCode = 401; res.end(JSON.stringify({ error: { message: 'Invalid OAuth access token.', code: 190 } })); return; }
      if (req.method === 'GET') { res.end(JSON.stringify({ display_phone_number: '+961 1 000 000', verified_name: 'Synthetic Clinic', id: req.url?.split('?')[0].slice(1) })); return; }
      const body = JSON.parse(data || '{}'); const id = `wamid.out.${++seq}`;
      sent.push({ path: req.url, body, id });
      res.end(JSON.stringify({ messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id }] }));
    });
  });
  await new Promise<void>((r) => meta.listen(0, '127.0.0.1', () => r()));
  process.env.WHATSAPP_GRAPH_URL = `http://127.0.0.1:${(meta.address() as any).port}/v21.0`;
  const { migrate } = require('../../../../db/migrate.js');
  const { syncPresets } = require('../../../../db/sync_presets.js');
  await migrate({ reset: true, log: () => {} });
  await syncPresets({ log: () => {} });
  server = await createApp({ logger: process.env.TEST_LOG === "1" });
  await server.app.listen(0);
  base = `http://127.0.0.1:${(server.app.getHttpServer().address() as any).port}`;

  const r = await dr.post('/auth/register/doctor', { fullName: 'Dr Rana Synthetic', email: 'rana@synthetic.medora', password: PW, specialty: 'general_practice',
    licenseNumber: 'LB-SYN-4001', clinicName: 'Synthetic Family Clinic', consultationFee: 40 });
  assert.equal(r.status, 201, JSON.stringify(r.body)); dr.org = r.body.organizationId; ids.drMid = r.body.membershipId;
  const o = await other.post('/auth/register/doctor', { fullName: 'Dr Other Synthetic', email: 'other@synthetic.medora', password: PW, specialty: 'dermatology',
    licenseNumber: 'LB-SYN-4002', clinicName: 'Other Synthetic Clinic', consultationFee: 40 });
  other.org = o.body.organizationId;
  const p = await dr.post('/patients', { fullName: 'Synthetic Patient Maha', phone: '03 123 456', preferredLanguage: 'en', confirmNotDuplicate: true });
  assert.equal(p.status, 201, JSON.stringify(p.body)); ids.patient = p.body.id;
  // Tests run at any hour: open the message window all day (the window itself is tested below).
  assert.equal((await dr.patch('/org', { messageWindowStart: '00:00', messageWindowEnd: '23:59' })).status, 200);
});
after(async () => { await server.close(); meta.close(); });

test('phone numbers are normalised to international form (Lebanon by default)', () => {
  assert.equal(toWaNumber('03 123 456'), '9613123456');
  assert.equal(toWaNumber('+961 70 123 456'), '96170123456');
  assert.equal(toWaNumber('0033 6 12 34 56 78'), '33612345678');
  assert.equal(toWaNumber('12'), null);
});

test('webhook verification and signatures', async () => {
  const v = await fetch(`${base}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=synthetic-verify-token&hub.challenge=12345`);
  assert.equal(v.status, 200); assert.equal(await v.text(), '12345');
  assert.equal((await fetch(`${base}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`)).status, 403);
  assert.equal((await hook(inbound('1', '1', 'x'), 'not-the-secret')).status, 401, 'wrong signature refused');
  const unsigned = await fetch(`${base}/api/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(unsigned.status, 401);
});

test('connecting a number: a bad token stays awaiting credentials, a good one connects; the token is never returned', async () => {
  const bad = await dr.post('/whatsapp/accounts', { phoneNumberId: '100000000000001', displayNumber: '+961 1 000 000', wabaId: null, accessToken: 'synthetic-bad-token-000000000', membershipId: null });
  assert.equal(bad.status, 201, JSON.stringify(bad.body));
  assert.equal(bad.body.status, 'awaiting_credentials'); assert.match(bad.body.last_error, /Invalid OAuth/);
  assert.equal(bad.body.membership_id, ids.drMid, 'in a practice the number belongs to the doctor');
  ids.account = bad.body.id;
  const good = await dr.patch(`/whatsapp/accounts/${ids.account}`, { accessToken: GOOD });
  assert.equal(good.body.status, 'connected', JSON.stringify(good.body));
  const list = await dr.get('/whatsapp/accounts');
  assert.equal(list.body.length, 1);
  assert.ok(!JSON.stringify(list.body).includes(GOOD) && !('access_token_enc' in list.body[0]), 'token never leaves the server');
  assert.equal((await dr.post('/whatsapp/accounts', { phoneNumberId: '100000000000002', displayNumber: '+961 1 000 001', wabaId: null, accessToken: GOOD, membershipId: null })).status, 409, 'one active number per doctor');
  assert.equal((await other.post('/whatsapp/accounts', { phoneNumberId: '100000000000001', displayNumber: '+961 1 000 000', wabaId: null, accessToken: GOOD, membershipId: null })).status, 409, 'a Meta number belongs to one workspace');
  assert.deepEqual((await other.get('/whatsapp/accounts')).body, [], 'other practice sees nothing');
  assert.equal((await other.post(`/whatsapp/accounts/${ids.account}/test`)).status, 404);
});

test('templates and automation settings', async () => {
  const t = await dr.get('/whatsapp/templates');
  assert.equal(t.body.length, 30, 'ten purposes in three languages');
  assert.ok(t.body.every((x: any) => !/diagnos|medication|result/i.test(x.default_body)), 'defaults carry no medical details');
  assert.equal((await dr.put('/whatsapp/templates/confirmation/en', { body: 'Hi {patient}, booked with {doctor} at {clinic} on {date}, {time}.', metaTemplateName: 'Bad Name' })).status, 400);
  assert.equal((await dr.put('/whatsapp/templates/confirmation/en', { body: 'Hi {patient}, booked with {doctor} at {clinic} on {date}, {time}.', metaTemplateName: 'appt_confirmation' })).status, 200);
  const a = await dr.get('/whatsapp/automation');
  assert.equal(a.body.length, 6); assert.ok(a.body.every((x: any) => x.enabled === false), 'everything starts switched off');
  for (const p of ['confirmation', 'reschedule', 'cancellation', 'reminder_24h']) {
    const r = await dr.put(`/whatsapp/automation/${p}`, { enabled: true, offsetMinutes: null, followUpDays: null, sendHour: null });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  assert.equal((await dr.get('/whatsapp/automation')).body.find((x: any) => x.purpose === 'reminder_24h').offset_minutes, -1440);
});

test('no consent: confirmation is skipped and nothing reaches Meta', async () => {
  const a = await dr.post('/appointments', { patientId: ids.patient, doctorMembershipId: ids.drMid, startsAt: inHours(72), durationMinutes: 20 });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const before = sent.length;
  const r = await tick();
  assert.equal(r.skipped, 1);
  assert.equal(sent.length, before);
  const q = await dr.get(`/patients/${ids.patient}/messages`);
  assert.equal(q.body[0].purpose, 'confirmation'); assert.equal(q.body[0].status, 'skipped'); assert.equal(q.body[0].reason, 'no_consent');
});

test('with consent: confirmation goes out as the approved template; reschedule without a template waits for the 24-hour window', async () => {
  const c = await dr.put(`/patients/${ids.patient}/consent`, { optedIn: true });
  assert.equal(c.body.whatsapp.opted_in, true); assert.equal(c.body.number, '9613123456'); assert.equal(c.body.history.length, 1);
  const a = await dr.post('/appointments', { patientId: ids.patient, doctorMembershipId: ids.drMid, startsAt: inHours(96), durationMinutes: 20 });
  ids.appt = a.body.id;
  await tick();
  const m = sent.at(-1);
  assert.equal(m.path, '/v21.0/100000000000001/messages');
  assert.equal(m.body.to, '9613123456'); assert.equal(m.body.type, 'template');
  assert.equal(m.body.template.name, 'appt_confirmation'); assert.equal(m.body.template.language.code, 'en');
  const params = m.body.template.components[0].parameters.map((p: any) => p.text);
  assert.equal(params.length, 5); assert.equal(params[0], 'Synthetic'); assert.equal(params[1], 'Dr Rana Synthetic'); assert.equal(params[2], 'Synthetic Family Clinic');
  const r = await dr.patch(`/appointments/${ids.appt}`, { startsAt: inHours(100) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await tick();
  const q = await dr.get(`/patients/${ids.patient}/messages`);
  assert.equal(q.body[0].purpose, 'reschedule'); assert.equal(q.body[0].reason, 'template_not_approved');
});

test('webhook: inbound message opens a conversation linked to the patient, notifies in real time, and opens the window', async () => {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { cookie: dr.cookie } });
  const events: any[] = [];
  await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
  ws.on('message', (m) => events.push(JSON.parse(String(m))));
  ws.send(JSON.stringify({ type: 'subscribe', orgId: dr.org }));
  await new Promise((r) => setTimeout(r, 150));
  const h = await hook(inbound('100000000000001', '9613123456', 'Hello, can I come earlier?', 'wamid.in.fixed'));
  assert.equal(h.status, 200); assert.equal(h.body.messages, 1);
  assert.equal((await hook(inbound('100000000000001', '9613123456', 'Hello, can I come earlier?', 'wamid.in.fixed'))).status, 200, 'Meta retries are accepted');
  await new Promise((r) => setTimeout(r, 300));
  ws.close();
  assert.ok(events.some((e) => e.type === 'whatsapp'), JSON.stringify(events));
  assert.ok(events.some((e) => e.type === 'notification' && e.kind === 'whatsapp_message'), JSON.stringify(events));
  const list = await dr.get('/whatsapp/conversations?filter=unanswered');
  assert.equal(list.body.length, 1, JSON.stringify(list.body));
  assert.equal(list.body[0].patient_id, ids.patient); assert.equal(list.body[0].window_open, true);
  ids.conv = list.body[0].id;
  const conv = await dr.get(`/whatsapp/conversations/${ids.conv}`);
  assert.equal(conv.body.messages.filter((m: any) => m.direction === 'inbound').length, 1, 'retry did not duplicate');
  assert.equal(conv.body.messages[0].direction, 'outbound', 'the earlier confirmation is in the same conversation');
  assert.equal((await other.get(`/whatsapp/conversations/${ids.conv}`)).status, 404, 'other practice cannot read it');
  // Within the window a reschedule notice can go out as plain text.
  await dr.patch(`/appointments/${ids.appt}`, { startsAt: inHours(101) });
  await tick();
  assert.equal(sent.at(-1).body.type, 'text'); assert.match(sent.at(-1).body.text.body, /has moved to/);
});

test('reply, delivery statuses (never backwards), assignment and closing', async () => {
  const r = await dr.post(`/whatsapp/conversations/${ids.conv}/reply`, { body: 'Yes, 10:00 works. See you then.' });
  assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.status, 'sent');
  const metaId = sent.at(-1).id;
  await hook(status('100000000000001', metaId, 'read'));
  await hook(status('100000000000001', metaId, 'delivered'));
  const conv = await dr.get(`/whatsapp/conversations/${ids.conv}`);
  assert.equal(conv.body.messages.at(-1).status, 'read', 'a late "delivered" does not undo "read"');
  assert.equal((await dr.get('/whatsapp/conversations?filter=unanswered')).body.length, 0, 'answered');
  assert.equal((await dr.patch(`/whatsapp/conversations/${ids.conv}`, { assignedTo: ids.drMid, status: 'closed' })).status, 200);
  assert.equal((await dr.get('/whatsapp/conversations?filter=mine')).body.length, 1);
  assert.equal((await dr.get('/whatsapp/conversations?filter=open')).body.length, 0);
});

test('reminders are planned 24 hours ahead, and STOP opts the patient out', async () => {
  const a = await dr.post('/appointments', { patientId: ids.patient, doctorMembershipId: ids.drMid, startsAt: new Date(Date.now() + 24 * 3600e3 - 60e3).toISOString(), durationMinutes: 20 });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const res = await tick();
  assert.ok(res.planned >= 1, JSON.stringify(res));
  const msgs = (await dr.get(`/patients/${ids.patient}/messages`)).body;
  const rem = msgs.find((m: any) => m.purpose === 'reminder_24h');
  assert.equal(rem?.status, 'sent', JSON.stringify(msgs.slice(0, 3)));
  assert.equal((await tick()).planned, 0, 'never planned twice');
  await hook(inbound('100000000000001', '9613123456', 'STOP'));
  const c = await dr.get(`/patients/${ids.patient}/consent`);
  assert.equal(c.body.whatsapp.opted_in, false); assert.equal(c.body.whatsapp.source, 'patient_reply');
  await dr.post('/appointments', { patientId: ids.patient, doctorMembershipId: ids.drMid, startsAt: inHours(120), durationMinutes: 20 });
  await tick();
  assert.equal((await dr.get(`/patients/${ids.patient}/messages`)).body[0].reason, 'no_consent');
});

test('manual messages, payment reminders, announcements and cancelling a queued message', async () => {
  await dr.put(`/patients/${ids.patient}/consent`, { optedIn: true });
  assert.equal((await dr.post(`/patients/${ids.patient}/messages`, { purpose: 'vaccination', message: null, invoiceId: null, consultationId: null, date: null })).status, 400);
  const v = await dr.post(`/patients/${ids.patient}/messages`, { purpose: 'vaccination', message: null, invoiceId: null, consultationId: null, date: '2026-12-20' });
  assert.equal(v.status, 201, JSON.stringify(v.body)); assert.equal(v.body.status, 'sent', 'window is open after STOP message');
  assert.match(sent.at(-1).body.text.body, /vaccination visit/);
  await dr.post('/finance/rates', { lbpPerUsd: 89500, note: null });
  const inv = await dr.post('/invoices', { patientId: ids.patient, issue: true, notes: null, items: [{ description: 'Consultation', unitPrice: 40, serviceId: null }] });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  const pay = await dr.post(`/patients/${ids.patient}/messages`, { purpose: 'payment', message: null, invoiceId: inv.body.id, consultationId: null, date: null });
  assert.equal(pay.body.status, 'sent', JSON.stringify(pay.body)); assert.match(sent.at(-1).body.text.body, /40\.00 \$/);
  await dr.post(`/invoices/${inv.body.id}/payments`, { method: 'cash', amount: 40, currency: 'USD', reference: null, note: null });
  const paid = await dr.post(`/patients/${ids.patient}/messages`, { purpose: 'payment', message: null, invoiceId: inv.body.id, consultationId: null, date: null });
  assert.equal(paid.body.reason, 'already_paid');
  const ann = await dr.post('/whatsapp/announcements', { message: 'The clinic is closed on Friday (synthetic).' });
  assert.equal(ann.body.queued, 1, 'only consenting patients');
  await tick();
  // Cancelling: switch the worker's due time out of reach by queueing then cancelling before a tick.
  await dr.put('/whatsapp/automation/confirmation', { enabled: true, offsetMinutes: null, followUpDays: null, sendHour: null });
  await dr.post('/appointments', { patientId: ids.patient, doctorMembershipId: ids.drMid, startsAt: inHours(150), durationMinutes: 20 });
  const pending = (await dr.get('/whatsapp/queue?status=pending')).body;
  const conf = pending.find((p: any) => p.purpose === 'confirmation');
  assert.ok(conf, JSON.stringify(pending));
  assert.equal((await dr.del(`/whatsapp/queue/${conf.id}`)).status, 200);
  assert.equal((await dr.del(`/whatsapp/queue/${conf.id}`)).status, 409);
  assert.equal((await other.get('/whatsapp/queue')).body.length, 0, 'isolated per workspace');
});

test('free-text replies are refused once the 24-hour window has closed', async () => {
  const pg = require('pg');
  const c = new pg.Client(process.env.DATABASE_URL || 'postgres://medora:medora_dev@localhost:5432/medora');
  await c.connect();
  await c.query(`UPDATE whatsapp_conversations SET last_inbound_at = now() - interval '25 hours' WHERE id=$1`, [ids.conv]);
  await c.end();
  const r = await dr.post(`/whatsapp/conversations/${ids.conv}/reply`, { body: 'Hello again' });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'window_closed');
});

test('message hours: nothing goes out outside the clinic message window; it waits and leaves once the window opens', async () => {
  const pg = require('pg');
  const c = new pg.Client(process.env.DATABASE_URL || 'postgres://medora:medora_dev@localhost:5432/medora');
  await c.connect();
  // A window that starts two hours from now (clinic time) is closed right now.
  const { s, e } = (await c.query(`SELECT to_char((now() AT TIME ZONE 'Asia/Beirut') + interval '2 hours', 'HH24:MI') s,
    to_char((now() AT TIME ZONE 'Asia/Beirut') + interval '3 hours', 'HH24:MI') e`)).rows[0];
  await c.end();
  if (e > s) {   // skip the few minutes around midnight where the window would wrap
    assert.equal((await dr.patch('/org', { messageWindowStart: s, messageWindowEnd: e })).status, 200);
    const before = sent.length;
    const m = await dr.post(`/patients/${ids.patient}/messages`, { purpose: 'announcement', message: 'Synthetic: closed tomorrow.', invoiceId: null, consultationId: null, date: null });
    assert.equal(m.body.status, 'pending', 'held until the window opens');
    assert.equal(sent.length, before);
    await dr.patch('/org', { messageWindowStart: '00:00', messageWindowEnd: '23:59' });
    await tick();
    const q = (await dr.get(`/patients/${ids.patient}/messages`)).body.find((x: any) => x.id === m.body.id);
    assert.notEqual(q.status, 'pending');
  }
});
