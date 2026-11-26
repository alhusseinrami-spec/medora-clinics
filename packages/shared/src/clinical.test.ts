import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPUTED, addMonths, cha2ds2vasc, diabetesRecalls, egfrCkdEpi2021, hasBled, outOfRange, pregnancyRiskFlags, pregnancyTimeline, trendPoints, validateSchema } from './index.js';

const today = new Date('2026-11-26T10:00:00Z');

test('CHA2DS2-VASc and HAS-BLED', () => {
  assert.equal(cha2ds2vasc({}, 50, 'male'), 0);
  assert.equal(cha2ds2vasc({ chf: true, hypertension: true, diabetes: true, stroke_tia: true, vascular_disease: true }, 80, 'female'), 9);
  assert.equal(cha2ds2vasc({ hypertension: true }, 70, 'male'), 2);
  assert.equal(hasBled({ uncontrolled_htn: true, labile_inr: true }, 70), 3);
  const v = COMPUTED.cha2ds2_vasc({ data: { af_risk: { hypertension: true } }, dateOfBirth: '1950-01-01', sex: 'female', today });
  assert.equal(v, '4 · oral anticoagulation recommended');
  assert.equal(COMPUTED.cha2ds2_vasc({ data: { af_risk: {} }, dateOfBirth: '1980-01-01', sex: 'female', today }), '1 · low risk, no anticoagulation for stroke prevention');
});

test('eGFR CKD-EPI 2021 matches published reference values', () => {
  assert.equal(egfrCkdEpi2021(1.0, 50, 'male'), 92);
  assert.equal(egfrCkdEpi2021(1.0, 50, 'female'), 69);
  assert.equal(COMPUTED.egfr({ data: { labs: { results: [{ date: '2026-01-01', creatinine: 2 }, { date: '2026-06-01', creatinine: 1 }] } }, dateOfBirth: '1976-06-01', sex: 'male', today }), '92 mL/min/1.73m² · G1 (2026-06-01)');
  assert.equal(COMPUTED.egfr({ data: { labs: { results: [{ date: '2026-06-01', creatinine: 1 }] } }, dateOfBirth: '1976-06-01', sex: null, today }), null);
});

test('pregnancy timeline: week, trimester, test statuses and next visit', () => {
  const tl = pregnancyTimeline({ pregnant: true, lmp: '2026-06-04', rh_negative: false,
    tests_done: [{ test: 'booking_labs', date: '2026-07-20' }], prenatal_visits: [{ date: '2026-11-10' }] }, today)!;
  assert.equal(tl.week, 25); assert.equal(tl.trimester, 2); assert.equal(tl.edd, '2027-03-11');
  const st = Object.fromEntries(tl.items.map((i) => [i.key, i.status]));
  assert.deepEqual(st, { booking_labs: 'done', first_trimester_scan: 'overdue', anatomy_scan: 'overdue', glucose_test: 'due', tdap: 'upcoming', growth_scan: 'upcoming', gbs_swab: 'upcoming' });
  assert.equal(tl.nextVisit, '2026-12-08');
  assert.ok(pregnancyTimeline({ pregnant: true, lmp: '2026-06-04', rh_negative: true }, today)!.items.some((i) => i.key === 'anti_d'));
  assert.equal(pregnancyTimeline({ pregnant: false, lmp: '2026-06-04' }, today), null);
});

test('pregnancy risk flags', () => {
  const f = pregnancyRiskFlags({ pregnancy: { pregnant: true, rh_negative: true, prenatal_visits: [{ date: '2026-10-01', systolic: 120 }, { date: '2026-11-01', systolic: 145, diastolic: 85 }] },
    obstetric: { pregnancies: [{ delivery: 'c_section' }] } }, 36);
  assert.deepEqual(f, ['Maternal age 35 or more', 'High blood pressure at last visit', 'Rh negative', 'Previous caesarean section']);
});

test('diabetes recalls', () => {
  assert.deepEqual(diabetesRecalls({ diabetes: { type: 'none' } }, today), []);
  const r = Object.fromEntries(diabetesRecalls({ diabetes: { type: 'type_2' }, labs: { results: [{ date: '2026-09-15', hba1c: 8.2 }, { date: '2026-01-10', ldl: 120 }] },
    screening: { last_eye_exam: '2026-02-01' } }, today).map((x) => [x.key, `${x.status} ${x.due}`]));
  assert.deepEqual(r, { hba1c: 'due 2026-12-15', lipids: 'ok 2027-01-10', kidney: 'overdue 2026-11-26', eye: 'ok 2027-02-01', foot: 'overdue 2026-11-26' });
  // At target: HbA1c every 6 months
  assert.equal(diabetesRecalls({ diabetes: { type: 'type_2' }, labs: { results: [{ date: '2026-09-15', hba1c: 6.5 }] } }, today)[0].due, '2027-03-15');
});

test('trends and ranges', () => {
  assert.deepEqual(trendPoints([{ date: '2026-02-01', inr: 2.5 }, { date: '2026-01-01', inr: 3.4 }, { inr: 2 }], 'inr'), [{ date: '2026-01-01', value: 3.4 }, { date: '2026-02-01', value: 2.5 }]);
  assert.equal(outOfRange('inr', 3.4), 'high'); assert.equal(outOfRange('systolic', 120), null); assert.equal(outOfRange('unknown', 5), null);
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.ok(validateSchema({ format: 1, sections: [{ key: 's', label: 'S', chart: { rows: 'nope', series: [] }, fields: [] }] }).some((e) => e.path === 's.chart'));
});
