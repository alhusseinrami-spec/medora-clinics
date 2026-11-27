// Richer patient file: clinical summary, measurements, reminders, packages, odontogram, body map, photo pairs,
// identifiers, custom fields and data-handling consents. Real PostgreSQL (reset), real HTTP server. Synthetic data only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createApp } from '../src/app.js';

const require = createRequire(import.meta.url);
let server: Awaited<ReturnType<typeof createApp>>;
let base = '';

class Client {
  cookie = ''; org = '';
  async req(method: string, path: string, body?: unknown, raw?: { bytes: Buffer; type: string }) {
    const headers: Record<string, string> = { 'content-type': raw ? raw.type : 'application/json' };
    if (this.cookie) headers.cookie = this.cookie;
    if (this.org) headers['x-org-id'] = this.org;
    const r = await fetch(`${base}/api${path}`, { method, headers, body: raw ? new Uint8Array(raw.bytes) : body === undefined ? undefined : JSON.stringify(body) });
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
const tok = (url: string) => url.split('/invite/')[1];
const ago = (days: number) => new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10);
// A 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const owner = new Client(), docA = new Client(), docB = new Client(), desk = new Client();
let mA = '', patient = '', other = '';

before(async () => {
  const { migrate } = require('../../../../db/migrate.js');
  const { syncPresets } = require('../../../../db/sync_presets.js');
  await migrate({ reset: true, log: () => {} });
  await syncPresets({ log: () => {} });
  server = await createApp({ logger: false });
  await server.app.listen(0);
  base = `http://127.0.0.1:${(server.app.getHttpServer().address() as any).port}`;

  const center = await owner.post('/auth/register/center', { fullName: 'Synthetic Owner', email: 'owner@profile.medora', password: PW, centerName: 'Synthetic Profile Center', address: '1 Synthetic St, Beirut' });
  assert.equal(center.status, 201, JSON.stringify(center.body));
  owner.org = center.body.organizationId;
  for (const [c, email, specialty] of [[docA, 'a@profile.medora', 'cardiology'], [docB, 'b@profile.medora', 'pediatrics']] as const) {
    const inv = await owner.post('/staff/invitations', { email, role: 'doctor', specialty });
    await c.post('/auth/register/doctor', { fullName: `Dr Synthetic ${specialty}`, email, password: PW, specialty, licenseNumber: `LB-SYN-${specialty}`, clinicName: `Own ${specialty}` });
    const acc = await c.post(`/invitations/${tok(inv.body.acceptUrl)}/accept`);
    c.org = owner.org;
    if (c === docA) mA = acc.body.membership_id;
  }
  const invR = await owner.post('/staff/invitations', { email: 'desk@profile.medora', role: 'receptionist' });
  await desk.post('/auth/register/center', { fullName: 'Synthetic Desk', email: 'desk@profile.medora', password: PW, centerName: 'Desk (personal)' });
  await desk.post(`/invitations/${tok(invR.body.acceptUrl)}/accept`);
  desk.org = owner.org;

  const p = await desk.post('/patients', { fullName: 'Synthetic Profile Patient', dateOfBirth: '1960-01-01', sex: 'male', phone: '+961 70 555 001', doctorMembershipId: mA });
  assert.equal(p.status, 201, JSON.stringify(p.body)); patient = p.body.id;
  const o = await desk.post('/patients', { fullName: 'Synthetic Other Patient', dateOfBirth: '1970-01-01', sex: 'female', phone: '+961 70 555 002', doctorMembershipId: mA });
  other = o.body.id;
});
after(async () => { await server.close(); });

test('doctor builds the clinical summary; invalid combinations are refused', async () => {
  assert.equal((await docA.post(`/patients/${patient}/clinical-items`, { kind: 'problem', label: 'Type 2 diabetes', status: 'chronic', code: 'E11' })).status, 201);
  assert.equal((await docA.post(`/patients/${patient}/clinical-items`, { kind: 'allergy', label: 'Penicillin', detail: 'anaphylaxis', severity: 'severe' })).status, 201);
  const med = await docA.post(`/patients/${patient}/clinical-items`, { kind: 'medication', label: 'Synthetic Metformin 850 mg', detail: 'twice daily' });
  assert.equal(med.status, 201);
  assert.equal((await docA.post(`/patients/${patient}/clinical-items`, { kind: 'allergy', label: 'Latex', status: 'chronic' })).status, 400, 'an allergy is not chronic');
  assert.equal((await docA.post(`/patients/${patient}/clinical-items`, { kind: 'problem', label: 'X', severity: 'mild' })).status, 400, 'severity is for allergies');

  let s = (await docA.get(`/patients/${patient}/summary`)).body;
  assert.equal(s.restricted, false);
  assert.deepEqual(s.counts, { medications: 1, problems: 1, allergies: 1 });
  assert.ok(s.reminders.some((r: any) => r.kind === 'allergy' && r.text.startsWith('Penicillin')));

  assert.equal((await docA.patch(`/clinical-items/${med.body.id}`, { status: 'stopped' })).status, 200);
  s = (await docA.get(`/patients/${patient}/summary`)).body;
  assert.equal(s.counts.medications, 0, 'a stopped medication is not current');
  assert.ok(s.items.find((i: any) => i.id === med.body.id).ended_on, 'stopping records the end date');
});

test('front desk sees no clinical detail and cannot write it; an unlinked doctor cannot see the patient', async () => {
  const s = await desk.get(`/patients/${patient}/summary`);
  assert.equal(s.status, 200);
  assert.equal(s.body.restricted, true);
  assert.equal(s.body.items, undefined);
  assert.equal((await desk.post(`/patients/${patient}/clinical-items`, { kind: 'allergy', label: 'Latex' })).status, 403);
  assert.equal((await desk.get(`/patients/${patient}/measurements`)).status, 403);
  assert.equal((await desk.get(`/patients/${patient}/teeth`)).status, 403);
  assert.equal((await docB.get(`/patients/${patient}/summary`)).status, 404, 'row-level security hides the file');
  assert.equal((await docB.post(`/patients/${patient}/measurements`, { code: 'weight', value: 80 })).status, 404);
});

test('measurements: ranges, no future dates, trend order, target reminders and removal', async () => {
  assert.equal((await docA.post(`/patients/${patient}/measurements`, { code: 'hba1c', value: 45 })).status, 400, 'out of the plausible range');
  assert.equal((await docA.post(`/patients/${patient}/measurements`, { code: 'weight', value: 80, measuredOn: ago(-3) })).status, 400, 'future date');
  for (const [d, v] of [[200, 8.4], [100, 7.8], [20, 7.3]] as const) assert.equal((await docA.post(`/patients/${patient}/measurements`, { code: 'hba1c', value: v, measuredOn: ago(d) })).status, 201);
  const list = (await docA.get(`/patients/${patient}/measurements`)).body.filter((m: any) => m.code === 'hba1c');
  assert.deepEqual(list.map((m: any) => m.value), [8.4, 7.8, 7.3], 'oldest first for the chart');
  const s = (await docA.get(`/patients/${patient}/summary`)).body;
  assert.equal(s.latest.find((m: any) => m.code === 'hba1c').value, 7.3);
  assert.ok(s.reminders.some((r: any) => r.kind === 'above_target' && r.text === 'hba1c'));
  assert.ok(s.reminders.some((r: any) => r.kind === 'last_recorded' && r.text === 'hba1c'));
  assert.equal((await docA.del(`/measurements/${list[2].id}`)).status, 200);
  assert.equal((await docA.get(`/patients/${patient}/summary`)).body.latest.find((m: any) => m.code === 'hba1c').value, 7.8);
});

test('session packages never go over their count; sessions can be undone; closed packages take no more', async () => {
  const pk = await desk.post(`/patients/${patient}/packages`, { name: 'Physiotherapy', totalSessions: 2, price: 100 });
  assert.equal(pk.status, 201);
  assert.equal((await desk.post(`/packages/${pk.body.id}/sessions`, {})).status, 200);
  assert.equal((await desk.post(`/packages/${pk.body.id}/sessions`, {})).status, 200);
  assert.equal((await desk.post(`/packages/${pk.body.id}/sessions`, {})).status, 409, 'all sessions used');
  let list = (await desk.get(`/patients/${patient}/packages`)).body;
  assert.equal(list[0].used, 2);
  assert.equal((await desk.post(`/package-sessions/${list[0].sessions[1].id}/void`)).status, 200);
  list = (await desk.get(`/patients/${patient}/packages`)).body;
  assert.equal(list[0].used, 1);
  assert.ok((await docA.get(`/patients/${patient}/summary`)).body.reminders.some((r: any) => r.kind === 'package_low'));
  assert.equal((await desk.post(`/packages/${pk.body.id}/close`)).status, 200);
  assert.equal((await desk.post(`/packages/${pk.body.id}/sessions`, {})).status, 409, 'closed');
});

test('odontogram keeps every record and only accepts FDI teeth', async () => {
  assert.equal((await docA.post(`/patients/${patient}/teeth`, { tooth: 19, condition: 'caries' })).status, 400);
  assert.equal((await docA.post(`/patients/${patient}/teeth`, { tooth: 56, condition: 'caries' })).status, 400);
  assert.equal((await docA.post(`/patients/${patient}/teeth`, { tooth: 36, condition: 'caries', surfaces: 'mo' })).status, 201);
  const r = await docA.post(`/patients/${patient}/teeth`, { tooth: 36, condition: 'filling', surfaces: 'MO' });
  assert.equal(r.body.surfaces, 'MO');
  const teeth = (await docA.get(`/patients/${patient}/teeth`)).body.filter((x: any) => x.tooth === 36);
  assert.equal(teeth.length, 2);
  assert.equal(teeth[0].condition, 'filling', 'latest first');
});

test('body map and photo pairs only use photos from the same patient file', async () => {
  const mine = await docA.req('POST', `/patients/${patient}/documents?kind=photo&title=Synthetic%20photo`, undefined, { bytes: PNG, type: 'image/png' });
  assert.equal(mine.status, 201, JSON.stringify(mine.body));
  const theirs = await docA.req('POST', `/patients/${other}/documents?kind=photo&title=Synthetic%20photo`, undefined, { bytes: PNG, type: 'image/png' });
  assert.equal((await docA.post(`/patients/${patient}/body-marks`, { side: 'front', x: 50, y: 30, region: 'Chest', photoDocumentId: theirs.body.id })).status, 400);
  assert.equal((await docA.post(`/patients/${patient}/body-marks`, { side: 'front', x: 120, y: 30, region: 'Chest' })).status, 400, 'x is a percentage');
  const mark = await docA.post(`/patients/${patient}/body-marks`, { side: 'back', x: 50, y: 44, region: 'Lower back', note: 'Synthetic', photoDocumentId: mine.body.id });
  assert.equal(mark.status, 201);
  assert.equal((await docA.get(`/patients/${patient}/body-marks`)).body.length, 1);
  assert.equal((await docA.del(`/body-marks/${mark.body.id}`)).status, 200);
  assert.equal((await docA.get(`/patients/${patient}/body-marks`)).body.length, 0);

  assert.equal((await docA.post(`/patients/${patient}/photo-pairs`, { title: 'Scar', beforeDocumentId: mine.body.id, afterDocumentId: mine.body.id })).status, 400);
  const pair = await docA.post(`/patients/${patient}/photo-pairs`, { title: 'Scar', beforeDocumentId: mine.body.id });
  assert.equal(pair.status, 201);
  assert.equal((await docA.patch(`/photo-pairs/${pair.body.id}`, { afterDocumentId: theirs.body.id })).status, 400);
  assert.equal((await desk.get(`/patients/${patient}/photo-pairs`)).status, 403, 'photos are clinical');
});

test('identifiers, notes and custom fields are part of the profile', async () => {
  const r = await desk.patch(`/patients/${patient}`, { nssfNumber: '111-222-333', civilRegistry: 'Synthetic 12', adminNotes: 'Prefers mornings',
    customFields: [{ label: 'Usual pharmacy', value: 'Synthetic Pharmacy' }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.nssf_number, '111-222-333');
  assert.deepEqual(r.body.custom_fields, [{ label: 'Usual pharmacy', value: 'Synthetic Pharmacy' }]);
  const many = Array.from({ length: 31 }, (_, i) => ({ label: `F${i}`, value: 'x' }));
  assert.equal((await desk.patch(`/patients/${patient}`, { customFields: many })).status, 400);
});

test('data-handling consents: one answer per purpose, history kept, named person required', async () => {
  assert.equal((await desk.post(`/patients/${patient}/data-consents`, { purpose: 'family_proxy', granted: true, givenBy: 'Synthetic Profile Patient' })).status, 400);
  assert.equal((await desk.post(`/patients/${patient}/data-consents`, { purpose: 'chart_access', granted: true, givenBy: 'Synthetic Profile Patient' })).status, 201);
  assert.equal((await desk.post(`/patients/${patient}/data-consents`, { purpose: 'chart_access', granted: false, givenBy: 'Synthetic Profile Patient' })).status, 201);
  const c = (await desk.get(`/patients/${patient}/data-consents`)).body;
  assert.equal(c.current.find((x: any) => x.purpose === 'chart_access').granted, false, 'the latest answer counts');
  assert.equal(c.current.find((x: any) => x.purpose === 'research').granted, null);
  assert.equal(c.history.filter((h: any) => h.purpose === 'chart_access').length, 2);
  assert.equal((await docB.get(`/patients/${patient}/data-consents`)).status, 404);
});
