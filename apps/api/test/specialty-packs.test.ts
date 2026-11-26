// Specialty packs (cardiology, endocrinology, gynecology and obstetrics): presets, computed scores and dashboard follow-ups.
// Real PostgreSQL (reset), real HTTP server. Synthetic data only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createApp } from '../src/app.js';

const require = createRequire(import.meta.url);
let server: Awaited<ReturnType<typeof createApp>>;
let base = '';

class Client {
  cookie = ''; org = '';
  async req(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.cookie) headers.cookie = this.cookie;
    if (this.org) headers['x-org-id'] = this.org;
    const r = await fetch(`${base}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) this.cookie = set.split(';')[0];
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b?: unknown) => this.req('POST', p, b ?? {});
  put = (p: string, b: unknown) => this.req('PUT', p, b);
}
const PW = 'Synthetic-Pass-2026';
const DAY = 86400000;
const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

const cardio = new Client(), endo = new Client(), obgyn = new Client();

async function register(c: Client, specialty: string, email: string) {
  const r = await c.post('/auth/register/doctor', { fullName: `Dr Synthetic ${specialty}`, email, password: PW, specialty,
    licenseNumber: `LB-SYN-${specialty}`, clinicName: `Synthetic ${specialty} clinic`, address: 'Synthetic St, Beirut', consultationFee: 40 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.org = r.body.organizationId;
}
async function patient(c: Client, fullName: string, dateOfBirth: string, sex: string, phone: string) {
  const r = await c.post('/patients', { fullName, dateOfBirth, sex, phone });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.id as string;
}

before(async () => {
  const { migrate } = require('../../../../db/migrate.js');
  const { syncPresets } = require('../../../../db/sync_presets.js');
  await migrate({ reset: true, log: () => {} });
  await syncPresets({ log: () => {} });
  server = await createApp({ logger: false });
  await server.app.listen(0);
  base = `http://127.0.0.1:${(server.app.getHttpServer().address() as any).port}`;
  await register(cardio, 'cardiology', 'cardio@synthetic.medora');
  await register(endo, 'endocrinology', 'endo@synthetic.medora');
  await register(obgyn, 'obgyn', 'obgyn@synthetic.medora');
});
after(async () => { await server.close(); });

test('endocrinology now has its own full preset and dashboard widgets', async () => {
  const list = await endo.get('/specialties');
  assert.equal(list.body.find((s: any) => s.code === 'endocrinology').has_full_preset, true);
  const ws = await endo.get('/specialty/workspace');
  assert.equal(ws.body.specialty.code, 'endocrinology');
  assert.deepEqual(ws.body.profile.schema.sections.map((s: any) => s.key), ['vitals', 'diabetes', 'labs', 'insulin', 'screening', 'thyroid']);
  assert.ok(ws.body.widgets.includes('diabetes_recalls'));
  const c = await cardio.get('/specialty/workspace');
  for (const k of ['bp_log', 'af_risk', 'anticoagulation', 'devices']) assert.ok(c.body.profile.schema.sections.some((s: any) => s.key === k), k);
  for (const w of ['bp_followups', 'inr_due', 'device_checks']) assert.ok(c.body.widgets.includes(w), w);
  const o = await obgyn.get('/specialty/workspace');
  for (const w of ['prenatal_followups', 'pap_recalls']) assert.ok(o.body.widgets.includes(w), w);
});

test('cardiology: BP log, risk section, INR log and devices feed the dashboard', async () => {
  const p = await patient(cardio, 'Synthetic Cardio Patient', '1950-04-02', 'female', '+961 70 100 001');
  const bad = await cardio.put(`/patients/${p}/specialty`, { data: { anticoagulation: { inr_log: [{ date: day(-3), inr: 25 }] } } });
  assert.equal(bad.status, 400);
  const ok = await cardio.put(`/patients/${p}/specialty`, { data: {
    bp_log: { readings: [{ date: day(-60), systolic: 128, diastolic: 80 }, { date: day(-2), systolic: 152, diastolic: 94, heart_rate: 88 }] },
    af_risk: { atrial_fibrillation: true, hypertension: true, labile_inr: true },
    anticoagulation: { anticoagulant: 'acenocoumarol', inr_target_low: 2, inr_target_high: 3, inr_log: [{ date: day(-28), inr: 2.4, next_test: day(-10) }, { date: day(-7), inr: 3.6, next_test: day(3) }] },
    devices: { items: [{ type: 'pacemaker', date: '2020-01-01', next_check: day(20) }, { type: 'stent', date: '2019-01-01' }] },
  } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const view = await cardio.get(`/patients/${p}/specialty`);
  assert.equal(view.body.sex, 'female', 'sex is sent so scores can use it');
  const s = await cardio.get('/dashboard/summary');
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.deepEqual(s.body.bp_followups.map((x: any) => [x.patient_id, x.systolic, x.diastolic]), [[p, 152, 94]]);
  assert.deepEqual(s.body.inr_due.map((x: any) => [x.inr, x.due, x.overdue]), [[3.6, day(3), false]], 'uses the latest INR check');
  assert.deepEqual(s.body.device_checks.map((x: any) => [x.type, x.due]), [['pacemaker', day(20)]]);
});

test('endocrinology: labs, recalls and the dashboard list', async () => {
  const p = await patient(endo, 'Synthetic Diabetes Patient', '1970-02-10', 'male', '+961 70 100 002');
  const ok = await endo.put(`/patients/${p}/specialty`, { data: {
    vitals: { weight_kg: 90 },
    diabetes: { type: 'type_2', treatment: ['metformin', 'insulin'] },
    labs: { results: [{ date: day(-100), hba1c: 8.4, creatinine: 1.1, ldl: 130 }] },
    insulin: { regimen: [{ insulin: 'Synthetic glargine', kind: 'basal', bedtime: 20 }, { insulin: 'Synthetic aspart', kind: 'bolus', morning: 6, evening: 8 }] },
    screening: { last_eye_exam: day(-30) },
  } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const none = await patient(endo, 'Synthetic Thyroid Patient', '1985-02-10', 'female', '+961 70 100 003');
  assert.equal((await endo.put(`/patients/${none}/specialty`, { data: { diabetes: { type: 'none' }, thyroid: { thyroid_condition: 'hypothyroidism' } } })).status, 200);
  const s = await endo.get('/dashboard/summary');
  assert.equal(s.body.diabetes_recalls.length, 1, 'only patients with diabetes get recalls');
  const r = s.body.diabetes_recalls[0];
  assert.equal(r.patient_id, p); assert.equal(r.overdue, true);
  assert.deepEqual(r.items, ['HbA1c', 'Diabetic foot exam'], 'HbA1c overdue after 3 months above target; foot exam never done');
});

test('obstetrics: prenatal schedule, risk fields and Pap recall reach the dashboard', async () => {
  const p = await patient(obgyn, 'Synthetic Pregnant Patient', '1989-05-05', 'female', '+961 70 100 004');
  const ok = await obgyn.put(`/patients/${p}/specialty`, { data: {
    pregnancy: { pregnant: true, lmp: day(-25 * 7), rh_negative: true, prenatal_visits: [{ date: day(-30), systolic: 118, diastolic: 76 }],
      tests_done: [{ test: 'booking_labs', date: day(-17 * 7) }, { test: 'first_trimester_scan', date: day(-13 * 7) }, { test: 'anatomy_scan', date: day(-5 * 7) }] },
    gynecology: { last_pap_smear: day(-3 * 365) },
  } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const badTest = await obgyn.put(`/patients/${p}/specialty`, { data: { pregnancy: { tests_done: [{ test: 'made_up_test' }] } } });
  assert.equal(badTest.status, 400, 'tests come from the prenatal schedule');
  const s = await obgyn.get('/dashboard/summary');
  const f = s.body.prenatal_followups.find((x: any) => x.patient_id === p);
  assert.ok(f, JSON.stringify(s.body.prenatal_followups));
  assert.equal(f.week, 25);
  assert.deepEqual(f.items, ['Glucose tolerance test']);
  assert.equal(f.next_visit, day(-30 + 28), 'visits every 4 weeks before week 28');
  assert.equal(s.body.pap_recalls.length, 1);
});
