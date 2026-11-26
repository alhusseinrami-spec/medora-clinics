// Release 6 end-to-end tests: trials, plan features and limits, inactive subscriptions, plan changes and cancellation,
// the super-admin console (workspaces, users, plans, payments, settings) and support requests. Synthetic data only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

process.env.COMM_WORKER = 'off';
const { createApp } = await import('../src/app.js');
const require = createRequire(import.meta.url);
const { Client: Pg } = require('pg');

let server: Awaited<ReturnType<typeof createApp>>; let base = '';
const ownerDb = () => new Pg(process.env.DATABASE_URL || 'postgres://medora:medora_dev@localhost:5432/medora');

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
  get = (p: string) => this.req('GET', p); post = (p: string, b?: unknown) => this.req('POST', p, b ?? {});
  put = (p: string, b: unknown) => this.req('PUT', p, b); patch = (p: string, b: unknown) => this.req('PATCH', p, b);
}
const PW = 'Synthetic-Pass-2026';
const dr = new Client(), admin = new Client(), a1 = new Client(), a2 = new Client(), center = new Client(), stranger = new Client();
const ids: Record<string, string> = {};

async function sql(q: string, params: unknown[] = []) { const c = ownerDb(); await c.connect(); try { return (await c.query(q, params)).rows; } finally { await c.end(); } }
async function inviteAssistant(staff: Client, email: string) {
  const inv = await dr.post('/staff/invitations', { email, role: 'assistant', assignToDoctorMembershipId: ids.drMid });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  await staff.post('/auth/register/center', { fullName: 'Synthetic Assistant', email, password: PW, centerName: `Temp ${email}` });
  return staff.post(`/invitations/${inv.body.acceptUrl.split('/invite/')[1]}/accept`);
}

before(async () => {
  const { migrate } = require('../../../../db/migrate.js');
  const { syncPresets } = require('../../../../db/sync_presets.js');
  await migrate({ reset: true, log: () => {} });
  await syncPresets({ log: () => {} });
  server = await createApp({ logger: false });
  await server.app.listen(0);
  base = await server.app.getUrl();
  const r = await dr.post('/auth/register/doctor', { fullName: 'Dr Rana Synthetic', email: 'rana@synthetic.medora', password: PW, specialty: 'general_practice',
    licenseNumber: 'LB-SYN-6001', clinicName: 'Rana Synthetic Clinic', consultationFee: 40 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  ids.org = r.body.organizationId; dr.org = ids.org;
  ids.drMid = (await dr.get('/org')).body.me.doctorMembershipId;
  const c = await center.post('/auth/register/center', { fullName: 'Center Owner Synthetic', email: 'centerowner@synthetic.medora', password: PW, centerName: 'Synthetic Six Center' });
  ids.center = c.body.organizationId; center.org = ids.center;
  // Platform administrators are made from the server (owner connection), never through the API.
  await admin.post('/auth/register/center', { fullName: 'MEDORA Admin', email: 'admin@synthetic.medora', password: PW, centerName: 'Admin temp' });
  await sql(`UPDATE users SET is_platform_admin = true WHERE email = 'admin@synthetic.medora'`);
  await stranger.post('/auth/register/doctor', { fullName: 'Dr Stranger', email: 'stranger6@synthetic.medora', password: PW, specialty: 'dermatology', licenseNumber: 'LB-SYN-6009', clinicName: 'Stranger Skin' });
});
after(async () => { await server?.close(); });

test('a new workspace starts a free trial on the default plan for its kind', async () => {
  const s = await dr.get('/subscription');
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.subscription.plan_code, 'professional');
  assert.equal(s.body.subscription.status, 'trial');
  assert.equal(s.body.subscription.usable, true);
  const days = (Date.parse(s.body.subscription.trial_ends_at) - Date.now()) / 86400e3;
  assert.ok(days > 13 && days <= 14, `trial is 14 days, got ${days}`);
  assert.deepEqual(s.body.plans.map((p: any) => p.code), ['solo', 'professional', 'enterprise'], 'only plans for practices are offered');
  assert.equal(s.body.usage.doctors, 1);
  assert.equal(s.body.onlinePayment, 'awaiting_credentials');
  assert.equal((await center.get('/subscription')).body.subscription.plan_code, 'medical_center');
  const org = await dr.get('/org');
  assert.equal(org.body.plan.features.whatsapp, true);
  assert.equal((await dr.post('/subscription/plan', { plan: 'enterprise', cycle: 'monthly' })).status, 400, 'enterprise is arranged with MEDORA');
  assert.equal((await dr.post('/subscription/plan', { plan: 'medical_center', cycle: 'monthly' })).status, 400, 'center plan is not for a practice');
});

test('plan features: the Solo plan turns off finance, insurance and WhatsApp but keeps invoicing', async () => {
  const d = await dr.post('/subscription/plan', { plan: 'solo', cycle: 'yearly' });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal(d.body.subscription.plan_code, 'solo');
  assert.equal(d.body.events[0].kind, 'downgraded');
  for (const path of ['/finance/summary', '/finance/expenses', '/insurance/providers', '/whatsapp/accounts']) {
    const r = await dr.get(path);
    assert.equal(r.status, 403, path); assert.equal(r.body.code, 'plan_feature', path);
  }
  assert.equal((await dr.get('/finance/rates')).status, 200, 'exchange rates stay available for invoices');
  assert.equal((await dr.get('/invoices')).status, 200);
  assert.equal((await dr.post('/finance/rates', { lbpPerUsd: 89500, note: null })).status, 201);
  const p = await dr.post('/patients', { fullName: 'Synthetic Solo Patient', sex: 'female', phone: '+961 70 600 001' });
  assert.equal(p.status, 201, JSON.stringify(p.body)); ids.patient = p.body.id;
  const inv = await dr.post('/invoices', { patientId: ids.patient, doctorMembershipId: ids.drMid, issue: true, notes: null, items: [{ description: 'Visit', unitPrice: 40, kind: 'consultation', serviceId: null }] });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
});

test('plan limits are enforced by the database and block downgrades that do not fit', async () => {
  const first = await inviteAssistant(a1, 'asst1@synthetic.medora');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const second = await inviteAssistant(a2, 'asst2@synthetic.medora');
  assert.equal(second.status, 400);
  assert.match(second.body.message, /Solo plan allows 1 staff/);
  const loc = await dr.post('/org/locations', { name: 'Second branch' });
  assert.equal(loc.status, 400); assert.match(loc.body.message, /allows 1 locations/);
  // Upgrade, add the second assistant, then a downgrade no longer fits.
  assert.equal((await dr.post('/subscription/plan', { plan: 'professional', cycle: 'monthly' })).body.events[0].kind, 'upgraded');
  const inv = await dr.post('/staff/invitations', { email: 'asst2@synthetic.medora', role: 'assistant', assignToDoctorMembershipId: ids.drMid });
  assert.equal((await a2.post(`/invitations/${inv.body.acceptUrl.split('/invite/')[1]}/accept`)).status, 200);
  const down = await dr.post('/subscription/plan', { plan: 'solo', cycle: 'monthly' });
  assert.equal(down.status, 400); assert.match(down.body.message, /above the limits/);
});

test('super-admin console is for platform administrators only and shows no patient data', async () => {
  for (const c of [dr, center, stranger]) {
    for (const path of ['/admin/overview', '/admin/workspaces', '/admin/users', '/admin/plans', '/admin/settings', '/admin/support']) assert.equal((await c.get(path)).status, 403, path);
    assert.equal((await c.post(`/admin/workspaces/${ids.org}/payments`, { amount: 1, currency: 'USD', method: 'cash', reference: null, months: 1 })).status, 403);
  }
  const o = await admin.get('/admin/overview');
  assert.equal(o.status, 200, JSON.stringify(o.body));
  assert.ok(o.body.workspaces >= 6); assert.ok(o.body.by_plan.professional >= 1); assert.ok(o.body.doctors >= 2);
  const w = await admin.get('/admin/workspaces');
  const rana = w.body.find((x: any) => x.id === ids.org);
  assert.equal(rana.owner_email, 'rana@synthetic.medora'); assert.equal(rana.patients, 1); assert.equal(rana.plan_code, 'professional');
  const detail = await admin.get(`/admin/workspaces/${ids.org}`);
  assert.equal(detail.status, 200);
  assert.ok(!JSON.stringify(w.body).includes('Synthetic Solo Patient') && !JSON.stringify(detail.body).includes('Synthetic Solo Patient'), 'no patient names');
  assert.equal((await admin.get(`/patients/${ids.patient}`)).status, 400, 'admins have no workspace access to patient files');
  const users = await admin.get('/admin/users?q=rana');
  assert.equal(users.status, 200, JSON.stringify(users.body));
  assert.equal(users.body.length, 1); assert.equal(users.body[0].workspaces[0].role, 'doctor');
});

test('an expired trial keeps records readable but stops changes until a payment renews it', async () => {
  await admin.patch(`/admin/workspaces/${ids.org}/subscription`, { trialEndsAt: new Date(Date.now() - 3600e3).toISOString(), note: 'Synthetic: trial ended' });
  const s = await dr.get('/subscription');
  assert.equal(s.body.subscription.effective_status, 'trial_expired'); assert.equal(s.body.subscription.usable, false);
  assert.equal((await dr.get('/patients')).status, 200, 'still readable');
  const w = await dr.post('/patients', { fullName: 'Blocked Patient', sex: 'male' });
  assert.equal(w.status, 402); assert.equal(w.body.code, 'subscription_inactive');
  assert.equal((await dr.post('/support', { organizationId: ids.org, category: 'billing', subject: 'Renew my plan', body: 'Synthetic: how do I pay?' })).status, 201, 'support stays open');
  const pay = await admin.post(`/admin/workspaces/${ids.org}/payments`, { amount: 490, currency: 'USD', method: 'bank_transfer', reference: 'SYN-TRX-1', months: 12 });
  assert.equal(pay.status, 201, JSON.stringify(pay.body));
  assert.equal(pay.body.subscription.status, 'active'); assert.equal(pay.body.subscription.usable, true);
  const months = (Date.parse(pay.body.subscription.current_period_end) - Date.now()) / (30.4 * 86400e3);
  assert.ok(months > 11 && months < 12.5, `paid for a year, got ${months}`);
  assert.equal(pay.body.events[0].kind, 'activated');
  assert.equal((await dr.post('/patients', { fullName: 'Maher Renewed', sex: 'male' })).status, 201);
  const mine = await dr.get('/subscription');
  assert.equal(mine.body.payments.length, 1); assert.equal(mine.body.payments[0].amount, 490);
  // A past period end beyond the grace days stops changes again; within the grace days the workspace is past due but usable.
  await admin.patch(`/admin/workspaces/${ids.org}/subscription`, { periodEnd: new Date(Date.now() - 2 * 86400e3).toISOString(), note: null });
  const due = (await dr.get('/subscription')).body.subscription;
  assert.equal(due.effective_status, 'past_due'); assert.equal(due.usable, true);
  await admin.patch(`/admin/workspaces/${ids.org}/subscription`, { periodEnd: new Date(Date.now() - 8 * 86400e3).toISOString(), note: null });
  assert.equal((await dr.get('/subscription')).body.subscription.effective_status, 'expired');
  const renew = await admin.post(`/admin/workspaces/${ids.org}/payments`, { amount: 49, currency: 'USD', method: 'cash', reference: null, months: 1 });
  assert.equal(renew.body.subscription.usable, true); assert.equal(renew.body.events[0].kind, 'renewed');
  assert.equal((await admin.post(`/admin/payments/${renew.body.payments[0].id}/refund`)).status, 200);
  assert.equal((await admin.post(`/admin/payments/${renew.body.payments[0].id}/refund`)).status, 400, 'refund once');
});

test('cancelling: at period end for a paid plan, immediately for a trial', async () => {
  const c = await dr.post('/subscription/cancel', { cancel: true });
  assert.equal(c.body.subscription.cancel_at_period_end, true); assert.equal(c.body.subscription.usable, true);
  assert.equal((await dr.post('/subscription/cancel', { cancel: false })).body.subscription.cancel_at_period_end, false);
  const t = await stranger.post('/subscription/cancel', { cancel: true });
  stranger.org = (await stranger.get('/auth/me')).body.workspaces[0].organization_id;
  const t2 = await stranger.post('/subscription/cancel', { cancel: true });
  assert.equal(t.status, 400, 'workspace header required');
  assert.equal(t2.body.subscription.status, 'cancelled'); assert.equal(t2.body.subscription.usable, false);
  assert.equal((await stranger.post('/patients', { fullName: 'No', sex: 'male' })).status, 402);
  assert.equal((await a1.post('/subscription/cancel', { cancel: true })).status, 400, 'assistant has no workspace header here');
  a1.org = ids.org;
  assert.equal((await a1.post('/subscription/cancel', { cancel: true })).status, 403, 'assistants cannot cancel');
});

test('suspending a workspace or a user takes effect immediately', async () => {
  assert.equal((await admin.post(`/admin/workspaces/${ids.center}/status`, { status: 'suspended', reason: null })).status, 400, 'a reason is required');
  assert.equal((await admin.post(`/admin/workspaces/${ids.center}/status`, { status: 'suspended', reason: 'Synthetic: unpaid' })).status, 200);
  assert.equal((await center.get('/org')).status, 403);
  const re = await admin.post(`/admin/workspaces/${ids.center}/status`, { status: 'active', reason: null });
  assert.equal(re.status, 200, JSON.stringify(re.body));
  assert.equal((await center.get('/org')).status, 200);
  const u = (await admin.get('/admin/users?q=asst2')).body[0];
  assert.equal((await admin.post(`/admin/users/${u.id}/status`, { status: 'suspended', reason: 'Synthetic test' })).status, 200);
  assert.equal((await a2.get('/auth/me')).status, 401, 'sessions ended');
  assert.ok([401, 403].includes((await a2.post('/auth/login', { email: 'asst2@synthetic.medora', password: PW })).status), 'suspended account cannot sign in');
  assert.equal((await admin.post(`/admin/users/${u.id}/status`, { status: 'active', reason: null })).status, 200);
  assert.equal((await a2.post('/auth/login', { email: 'asst2@synthetic.medora', password: PW })).status, 200);
  const me = (await admin.get('/admin/users?q=admin@synthetic')).body[0];
  assert.equal((await admin.post(`/admin/users/${me.id}/status`, { status: 'suspended', reason: 'oops' })).status, 400, 'not yourself');
  const audit = await sql(`SELECT action FROM audit_log WHERE action LIKE 'admin.%' ORDER BY id`);
  assert.ok(audit.some((r: any) => r.action === 'admin.workspace_suspended') && audit.some((r: any) => r.action === 'admin.user_suspended'));
});

test('plans and global settings are edited from the console and apply right away', async () => {
  const plans = (await admin.get('/admin/plans')).body;
  const solo = plans.plans.find((p: any) => p.code === 'solo');
  const body = { name: 'Solo', description: solo.description, monthlyPrice: 25, yearlyPrice: 250, currency: 'USD', maxDoctors: 1, maxAssistants: 3, maxLocations: 1,
    maxPatients: null, features: { ...solo.features, whatsapp: true }, appliesTo: ['independent_practice'], isPublic: true, isActive: true, sortOrder: 1 };
  const saved = await admin.put('/admin/plans/solo', body);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.plans.find((p: any) => p.code === 'solo').monthly_price, 25);
  assert.equal((await admin.put('/admin/plans/solo', { ...body, features: { ...body.features, teleport: true } })).status, 400, 'unknown feature');
  assert.equal((await admin.put('/admin/plans/professional', { ...body, name: 'Professional', isActive: false })).status, 400, 'plan in use cannot be retired');
  const neu = await admin.put('/admin/plans/clinic_plus', { ...body, name: 'Clinic Plus', sortOrder: 5 });
  assert.ok(neu.body.plans.some((p: any) => p.code === 'clinic_plus'));
  assert.ok((await dr.get('/subscription')).body.plans.some((p: any) => p.code === 'clinic_plus'), 'new plan offered to practices');
  // Settings: trial length and closing sign-ups.
  assert.equal((await admin.put('/admin/settings/trial_days', { value: 30 })).status, 200);
  assert.equal((await admin.put('/admin/settings/nonsense', { value: 1 })).status, 404);
  assert.equal((await admin.put('/admin/settings/default_plan_medical_center', { value: 'solo' })).status, 400);
  const n = new Client();
  await n.post('/auth/register/doctor', { fullName: 'Dr New', email: 'new6@synthetic.medora', password: PW, specialty: 'pediatrics', licenseNumber: 'LB-SYN-6010', clinicName: 'New Clinic' });
  n.org = (await n.get('/auth/me')).body.workspaces[0].organization_id;
  const days = (Date.parse((await n.get('/subscription')).body.subscription.trial_ends_at) - Date.now()) / 86400e3;
  assert.ok(days > 29 && days <= 30);
  await admin.put('/admin/settings/signups_open', { value: false });
  const closed = await new Client().post('/auth/register/doctor', { fullName: 'Dr Late', email: 'late6@synthetic.medora', password: PW, specialty: 'pediatrics', licenseNumber: 'LB-SYN-6011', clinicName: 'Late Clinic' });
  assert.equal(closed.status, 400); assert.match(closed.body.message, /cannot be opened/);
  assert.equal((await sql(`SELECT count(*)::int AS n FROM users WHERE email = 'late6@synthetic.medora'`))[0].n, 0, 'nothing half-created');
  await admin.put('/admin/settings/signups_open', { value: true });
});

test('support requests: private to the requester, answered by MEDORA', async () => {
  const r = await center.post('/support', { organizationId: ids.center, category: 'technical', subject: 'Calendar question', body: 'Synthetic: how do rooms work?' });
  assert.equal(r.status, 201);
  assert.equal((await dr.get(`/support/${r.body.id}`)).status, 404, 'other users cannot read it');
  assert.equal((await dr.post('/support', { organizationId: ids.center, category: 'other', subject: 'Not my workspace', body: 'x' })).status, 403, 'only for own workspaces');
  const list = await admin.get('/admin/support?status=open');
  assert.ok(list.body.some((x: any) => x.id === r.body.id));
  const ans = await admin.post(`/support/${r.body.id}/messages`, { body: 'Synthetic answer: open Settings, Workspace.' });
  assert.equal(ans.status, 201); assert.equal(ans.body.status, 'answered');
  const mine = await center.get(`/support/${r.body.id}`);
  assert.equal(mine.body.messages.length, 2); assert.equal(mine.body.messages[1].author, 'MEDORA support'); assert.equal(mine.body.messages[1].from_staff, true);
  assert.equal((await center.post(`/support/${r.body.id}/status`, { status: 'closed' })).body.status, 'closed');
});
