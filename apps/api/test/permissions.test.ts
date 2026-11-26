// Release 7 permission matrix: every staff role of a medical center is probed against an endpoint for each permission,
// and the answer must match the role's default permissions. Then permissions changed by an administrator take effect
// at once, and no role can be given what it may never hold. Synthetic data only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ROLE_DEFAULTS, type Permission } from '@medora/shared';

process.env.COMM_WORKER = 'off';
const { createApp } = await import('../src/app.js');
const require = createRequire(import.meta.url);

let server: Awaited<ReturnType<typeof createApp>>; let base = '';
class Client {
  cookie = ''; org = '';
  async req(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.cookie) headers.cookie = this.cookie; if (this.org) headers['x-org-id'] = this.org;
    const r = await fetch(`${base}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) this.cookie = set.split(';')[0];
    const text = await r.text(); let parsed: any = text; try { parsed = text ? JSON.parse(text) : null; } catch { /* raw */ }
    return { status: r.status, body: parsed };
  }
  get = (p: string) => this.req('GET', p); post = (p: string, b?: unknown) => this.req('POST', p, b ?? {}); put = (p: string, b: unknown) => this.req('PUT', p, b);
}
const PW = 'Synthetic-Pass-2026';
const ROLES = ['center_owner', 'center_admin', 'doctor', 'assistant', 'receptionist', 'accountant', 'insurance_admin'] as const;
const users: Record<string, Client> = {}; const mids: Record<string, string> = {};

// One endpoint per permission: [permission(s) that open it (any of), method, path].
const PROBES: [Permission[], string, string][] = [
  [['org.manage'], 'GET', '/subscription'],
  [['staff.manage'], 'GET', '/org/audit'],
  [['patient.file.read'], 'GET', '/patients'],
  [['appointment.manage'], 'GET', '/waiting-room'],
  [['appointment.manage'], 'GET', '/appointment-requests'],
  [['finance.view'], 'GET', '/finance/commissions'],
  [['finance.view'], 'GET', '/finance/expenses'],
  [['payment.register', 'finance.view'], 'GET', '/finance/rates'],
  [['payment.register', 'finance.view', 'insurance.manage'], 'GET', '/invoices'],
  [['insurance.manage'], 'GET', '/claims'],
  [['whatsapp.send'], 'GET', '/whatsapp/accounts'],
  [['whatsapp.send'], 'GET', '/whatsapp/conversations'],
];

before(async () => {
  const { migrate } = require('../../../../db/migrate.js');
  const { syncPresets } = require('../../../../db/sync_presets.js');
  await migrate({ reset: true, log: () => {} });
  await syncPresets({ log: () => {} });
  server = await createApp({ logger: false });
  await server.app.listen(0);
  base = await server.app.getUrl();
  const owner = users.center_owner = new Client();
  const c = await owner.post('/auth/register/center', { fullName: 'Matrix Owner', email: 'owner7@synthetic.medora', password: PW, centerName: 'Matrix Synthetic Center' });
  owner.org = c.body.organizationId;
  for (const role of ROLES.filter((r) => r !== 'center_owner')) {
    const u = users[role] = new Client(); const email = `${role}7@synthetic.medora`;
    const inv = await owner.post('/staff/invitations', { email, role, ...(role === 'doctor' ? { specialty: 'general_practice' } : {}), ...(role === 'assistant' ? { assignToDoctorMembershipId: mids.doctor } : {}) });
    assert.equal(inv.status, 201, `${role}: ${JSON.stringify(inv.body)}`);
    const reg = role === 'doctor'
      ? await u.post('/auth/register/doctor', { fullName: `Matrix ${role}`, email, password: PW, specialty: 'general_practice', licenseNumber: 'LB-SYN-7100', clinicName: 'Matrix own practice' })
      : await u.post('/auth/register/center', { fullName: `Matrix ${role}`, email, password: PW, centerName: `Matrix temp ${role}` });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const acc = await u.post(`/invitations/${inv.body.acceptUrl.split('/invite/')[1]}/accept`);
    assert.equal(acc.status, 200, JSON.stringify(acc.body));
    mids[role] = acc.body.membership_id; u.org = owner.org;
  }
});
after(async () => { await server?.close(); });

test('every role gets exactly what its default permissions allow', async () => {
  const wrong: string[] = [];
  for (const role of ROLES) {
    const perms = new Set(ROLE_DEFAULTS[role]);
    for (const [need, method, path] of PROBES) {
      const allowed = need.some((p) => perms.has(p));
      const r = await users[role].req(method, path);
      if (allowed ? r.status >= 400 : r.status !== 403) wrong.push(`${role} ${method} ${path}: expected ${allowed ? 'allowed' : '403'}, got ${r.status}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test('the roles know what they may do: /org reports the same permissions the API enforces', async () => {
  for (const role of ROLES) {
    const me = (await users[role].get('/org')).body.me;
    assert.deepEqual([...me.permissions].sort(), [...ROLE_DEFAULTS[role]].sort(), role);
  }
});

test('a permission switched on or off by an administrator applies to the next request', async () => {
  const rec = users.receptionist;
  assert.equal((await rec.get('/whatsapp/accounts')).status, 403);
  const staff = (await users.center_owner.get('/staff')).body; const m = staff.find((x: any) => x.id === mids.receptionist);
  assert.equal((await users.center_owner.put(`/staff/${m.id}/permissions`, { permissions: [...m.permissions, 'whatsapp.send'] })).status, 200);
  assert.equal((await rec.get('/whatsapp/accounts')).status, 200);
  assert.equal((await users.center_owner.put(`/staff/${m.id}/permissions`, { permissions: m.permissions.filter((p: string) => p !== 'patient.file.read') })).status, 200);
  assert.equal((await rec.get('/patients')).status, 403);
});

test('forbidden grants: no prescriptions for non-doctors, no self-promotion, no escalation past your own rights', async () => {
  const owner = users.center_owner;
  const asst = (await owner.get('/staff')).body.find((x: any) => x.id === mids.assistant);
  assert.equal((await owner.put(`/staff/${asst.id}/permissions`, { permissions: [...asst.permissions, 'prescription.create'] })).status, 400);
  const admin = users.center_admin;
  const self = (await admin.get('/staff')).body.find((x: any) => x.id === mids.center_admin);
  assert.equal((await admin.put(`/staff/${self.id}/permissions`, { permissions: [...self.permissions, 'finance.view'] })).status, 403, 'not your own');
  const acc = (await admin.get('/staff')).body.find((x: any) => x.id === mids.accountant);
  const esc = await admin.put(`/staff/${acc.id}/permissions`, { permissions: [...acc.permissions, 'insurance.manage'] });
  assert.ok(esc.status === 403 || esc.status === 400, `center admin cannot hand out insurance.manage they do not hold (got ${esc.status})`);
  assert.equal((await users.assistant.put(`/staff/${acc.id}/permissions`, { permissions: [] })).status, 403);
});
