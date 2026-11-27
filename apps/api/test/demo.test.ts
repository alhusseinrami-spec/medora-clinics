// Demo mode: view the synthetic clinic as any role without a password, reset it, and never touch a database with real accounts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createApp } from '../src/app.js';

const require = createRequire(import.meta.url);
let server: Awaited<ReturnType<typeof createApp>>; let base = '';
async function call(method: string, path: string, body?: unknown, cookie = '') {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0] };
}

before(async () => {
  const { migrate } = require('../../../../db/migrate.js');
  const { syncPresets } = require('../../../../db/sync_presets.js');
  await migrate({ reset: true, log: () => {} });
  await syncPresets({ log: () => {} });
  server = await createApp({ logger: false });
  await server.app.listen(0);
  base = `http://127.0.0.1:${(server.app.getHttpServer().address() as any).port}`;
});
after(async () => { delete process.env.DEMO_MODE; await server.close(); });

test('demo mode is off unless the server turns it on', async () => {
  delete process.env.DEMO_MODE;
  assert.deepEqual((await call('GET', '/demo')).body, { enabled: false });
  assert.equal((await call('POST', '/demo/login', { as: 'owner' })).status, 404);
  assert.equal((await call('POST', '/demo/reset')).status, 404);
});

test('demo: reset seeds the clinic, then anyone can view it as each role', { timeout: 180_000 }, async () => {
  process.env.DEMO_MODE = 'true';
  const info = await call('GET', '/demo');
  assert.equal(info.body.enabled, true); assert.ok(info.body.roles.includes('receptionist'));
  const first = await call('POST', '/demo/login', { as: 'owner' });
  assert.equal(first.status, 200, `the first sign-in on an empty database loads the clinic: ${JSON.stringify(first.body)}`);
  assert.equal((await call('POST', '/demo/reset')).status, 409, 'not twice in a row');

  const doc = await call('POST', '/demo/login', { as: 'doctor' });
  assert.equal(doc.status, 200, JSON.stringify(doc.body)); assert.ok(doc.body.organizationId);
  const me = await call('GET', '/auth/me', undefined, doc.cookie);
  assert.equal(me.body.user.email, 'nour@demo.medora');
  assert.ok(me.body.workspaces.some((w: any) => w.organization_id === doc.body.organizationId && w.kind === 'medical_center'), 'lands in the center');
  const desk = await call('POST', '/demo/login', { as: 'receptionist' });
  assert.equal((await call('GET', '/auth/me', undefined, desk.cookie)).body.user.email, 'maya@demo.medora');
  assert.equal((await call('POST', '/demo/login', { as: 'patient' })).body.portal, true);
  assert.equal((await call('POST', '/demo/login', { as: 'admin' })).status, 400, 'no platform administrator in the demo');
  const admins = await call('POST', '/auth/login', { email: 'admin@demo.medora', password: 'Demo-Medora-2026' });
  assert.equal(admins.status, 401, 'the demo seed skips the administrator account');
});

test('demo reset refuses a database that holds real accounts', async () => {
  process.env.DEMO_MODE = 'true';
  const reg = await call('POST', '/auth/register/center', { fullName: 'Real Person', email: 'someone@clinic.example', password: 'Synthetic-Pass-2026', centerName: 'Real Clinic' });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const r = await call('POST', '/demo/reset');
  assert.equal(r.status, 409); assert.match(r.body.message, /outside the demo/);
  assert.equal((await call('POST', '/auth/login', { email: 'someone@clinic.example', password: 'Synthetic-Pass-2026' })).status, 200, 'still there');
});
