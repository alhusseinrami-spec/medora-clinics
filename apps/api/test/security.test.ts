// Release 7 security tests: every route is scanned for access without a session, without a workspace, from another
// workspace and as a non-admin; security headers; rate limits; no internals in error answers. Synthetic data only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

process.env.COMM_WORKER = 'off';
const { createApp } = await import('../src/app.js');
const require = createRequire(import.meta.url);

let server: Awaited<ReturnType<typeof createApp>>; let base = '';
class Client {
  cookie = ''; org = ''; ip = '';
  async req(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.cookie) headers.cookie = this.cookie; if (this.org) headers['x-org-id'] = this.org; if (this.ip) headers['x-forwarded-for'] = this.ip;
    const r = await fetch(`${base}${path.startsWith('/health') ? '' : '/api'}${path}`, { method, headers, body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) this.cookie = set.split(';')[0];
    const text = await r.text(); let parsed: any = text; try { parsed = text ? JSON.parse(text) : null; } catch { /* raw */ }
    return { status: r.status, body: parsed, headers: r.headers };
  }
  get = (p: string) => this.req('GET', p); post = (p: string, b?: unknown) => this.req('POST', p, b ?? {});
}
const PW = 'Synthetic-Pass-2026';
const a = new Client(), b = new Client();
let routes: { method: string; path: string }[] = [];
const ZERO = '00000000-0000-4000-8000-000000000000';

// Routes anyone may call without signing in. Everything else must answer 401 without a session.
const PUBLIC = new Set([
  'GET /api/specialties', 'POST /api/auth/register/doctor', 'POST /api/auth/register/center', 'POST /api/auth/register/patient', 'POST /api/auth/login',
  'POST /api/auth/password/forgot', 'POST /api/auth/password/reset', 'GET /api/invitations/:token', 'GET /api/portal/invitations/:token', 'GET /api/push/key',
  'GET /api/webhooks/whatsapp', 'POST /api/webhooks/whatsapp',
]);
// Routes that work for any signed-in user without a workspace (own account, own patient-app records, own support requests).
const ACCOUNT = /^\/api\/(auth\/|portal\/|push\/|support|workspaces$|invitations\/:token\/accept|notifications)/;

before(async () => {
  const { migrate } = require('../../../../db/migrate.js');
  const { syncPresets } = require('../../../../db/sync_presets.js');
  await migrate({ reset: true, log: () => {} });
  await syncPresets({ log: () => {} });
  server = await createApp({ logger: false });
  await server.app.listen(0);
  base = await server.app.getUrl();
  const instance = server.app.getHttpAdapter().getInstance();
  const stack = (instance.router ?? instance._router).stack as any[];
  routes = stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route.methods).filter((m) => ['get', 'post', 'put', 'patch', 'delete'].includes(m)).map((m) => ({ method: m.toUpperCase(), path: l.route.path as string }))).filter((r) => r.path.startsWith('/api/')); // /health is the public liveness check
  const ra = await a.post('/auth/register/doctor', { fullName: 'Dr Sec A', email: 'seca@synthetic.medora', password: PW, specialty: 'general_practice', licenseNumber: 'LB-SYN-7001', clinicName: 'Sec A Clinic' });
  a.org = ra.body.organizationId;
  const rb = await b.post('/auth/register/doctor', { fullName: 'Dr Sec B', email: 'secb@synthetic.medora', password: PW, specialty: 'dermatology', licenseNumber: 'LB-SYN-7002', clinicName: 'Sec B Clinic' });
  b.org = rb.body.organizationId;
});
after(async () => { await server?.close(); });

const concrete = (p: string) => p.replace(/:[A-Za-z]+/g, (m) => (m === ':token' ? 'x'.repeat(43) : m === ':code' || m === ':key' || m === ':kind' || m === ':purpose' ? 'solo' : ZERO));

test('the route scan found the whole API', () => {
  assert.ok(routes.length > 150, `found ${routes.length} routes`);
  for (const p of PUBLIC) assert.ok(routes.some((r) => `${r.method} ${r.path}` === p), `public route ${p} exists`);
});

test('every non-public route refuses a request without a session', async () => {
  const anon = new Client(); const open: string[] = [];
  for (const r of routes) {
    if (PUBLIC.has(`${r.method} ${r.path}`)) continue;
    const res = await anon.req(r.method, concrete(r.path).replace(/^\/api/, ''), {});
    if (res.status !== 401) open.push(`${r.method} ${r.path} -> ${res.status}`);
  }
  assert.deepEqual(open, [], 'all non-public routes need a session');
});

test('workspace routes refuse a signed-in user without a workspace or with someone else\'s', async () => {
  const noOrg = new Client(); noOrg.cookie = a.cookie;
  const other = new Client(); other.cookie = a.cookie; other.org = b.org;
  const leaks: string[] = [];
  for (const r of routes) {
    const path = concrete(r.path);
    if (PUBLIC.has(`${r.method} ${r.path}`) || ACCOUNT.test(r.path) || r.path.startsWith('/api/admin')) continue;
    const x = await noOrg.req(r.method, path.replace(/^\/api/, ''), {});
    if (x.status < 400) leaks.push(`no workspace: ${r.method} ${r.path} -> ${x.status}`);
    const y = await other.req(r.method, path.replace(/^\/api/, ''), {});
    if (y.status !== 403) leaks.push(`other workspace: ${r.method} ${r.path} -> ${y.status}`);
  }
  assert.deepEqual(leaks, []);
});

test('admin routes refuse a normal user', async () => {
  const bad: string[] = [];
  for (const r of routes.filter((x) => x.path.startsWith('/api/admin'))) {
    const res = await a.req(r.method, concrete(r.path).replace(/^\/api/, ''), {});
    if (res.status !== 403) bad.push(`${r.method} ${r.path} -> ${res.status}`);
  }
  assert.ok(routes.filter((x) => x.path.startsWith('/api/admin')).length >= 14);
  assert.deepEqual(bad, []);
});

test('security headers on API answers', async () => {
  const r = await a.get('/auth/me');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.match(r.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  assert.equal(r.headers.get('x-powered-by'), null);
  const cookie = (await new Client().post('/auth/login', { email: 'seca@synthetic.medora', password: PW })).headers.get('set-cookie') ?? '';
  assert.match(cookie, /HttpOnly/i); assert.match(cookie, /SameSite=(Lax|Strict)/i);
});

test('errors never leak internals', async () => {
  const r = await a.req('POST', '/patients', { fullName: 'x'.repeat(5000) });
  assert.equal(r.status, 400);
  const s = JSON.stringify(r.body);
  assert.ok(!/at .*\.js|SELECT|INSERT|postgres|stack/i.test(s), s);
  const bad = await a.get(`/patients/not-a-uuid`);
  assert.ok(bad.status === 400 || bad.status === 404); assert.ok(!/postgres|syntax/i.test(JSON.stringify(bad.body)));
});

test('per-IP rate limits on sign-in and sign-up', async () => {
  const c = new Client(); c.ip = '203.0.113.7';
  const codes: number[] = [];
  for (let i = 0; i < 22; i++) codes.push((await c.post('/auth/login', { email: `nobody${i}@synthetic.medora`, password: 'wrong-password-1' })).status);
  assert.equal(codes.filter((s) => s === 401).length, 20);
  assert.equal(codes[21], 429);
  const other = new Client(); other.ip = '203.0.113.8';
  assert.equal((await other.post('/auth/login', { email: 'seca@synthetic.medora', password: PW })).status, 200, 'other addresses are not affected');
  const reg = new Client(); reg.ip = '203.0.113.9'; const rc: number[] = [];
  for (let i = 0; i < 11; i++) rc.push((await reg.post('/auth/register/center', { fullName: 'Spam', email: `spam${i}@synthetic.medora`, password: PW, centerName: `Spam ${i}` })).status);
  assert.equal(rc[10], 429); assert.equal(rc.filter((s) => s === 201).length, 10);
});

test('account lockout after repeated wrong passwords', async () => {
  const c = new Client(); c.ip = '203.0.113.20';
  for (let i = 0; i < 10; i++) await c.post('/auth/login', { email: 'secb@synthetic.medora', password: 'wrong-password-1' });
  const r = await c.post('/auth/login', { email: 'secb@synthetic.medora', password: PW });
  assert.equal(r.status, 401); assert.match(r.body.message, /Too many attempts/);
});
