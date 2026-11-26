import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, validateSchema, validateData, customize, COMPUTED, canTransition, expandRecurrence, isGrantable } from './index.js';

test('every preset schema is valid', () => {
  for (const p of PRESETS) assert.deepEqual(validateSchema(p.schema), [], `${p.specialty}/${p.kind}`);
  for (const p of PRESETS) for (const s of p.schema.sections) for (const f of s.fields) if (f.type === 'computed') assert.ok(f.compute! in COMPUTED, `${p.specialty}.${s.key}.${f.key}`);
  const specialties = new Set(PRESETS.map((p) => p.specialty));
  for (const s of ['pediatrics', 'obgyn', 'orthopedics', 'dentistry', 'dermatology', 'cardiology', 'endocrinology', 'general_practice']) assert.ok(specialties.has(s), s);
});

test('validator accepts good data, rejects bad and unknown fields', () => {
  const ped = PRESETS.find((p) => p.specialty === 'pediatrics' && p.kind === 'patient_profile')!.schema;
  const ok = validateData(ped, { birth: { birth_weight_kg: 3.2, delivery: 'vaginal' }, growth: { measurements: [{ date: '2024-01-10', weight_kg: 6 }] } });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  const bad = validateData(ped, { birth: { birth_weight_kg: 30, delivery: 'teleport', hack: 1 }, growth: { measurements: [{ weight_kg: 5 }] } });
  assert.equal(bad.ok, false);
  const paths = bad.errors.map((e) => e.path).sort();
  assert.deepEqual(paths, ['birth.birth_weight_kg', 'birth.delivery', 'birth.hack', 'growth.measurements[0].date']);
});

test('customize adds custom fields, hides optional, refuses removing required preset fields', () => {
  const base = { format: 1 as const, sections: [{ key: 's', label: 'S', fields: [{ key: 'req', type: 'text' as const, label: 'R', required: true }, { key: 'opt', type: 'text' as const, label: 'O', optional: true }] }] };
  const r = customize(base, { addFields: [{ section: 's', field: { key: 'extra', type: 'number', label: 'Extra' } }], hideFields: [{ section: 's', key: 'opt' }, { section: 's', key: 'req' }] });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /required preset/);
  assert.equal(r.schema.sections[0].fields.find((f) => f.key === 'opt')!.hidden, true);
  assert.equal(r.schema.sections[0].fields.find((f) => f.key === 'extra')!.custom, true);
  assert.equal(base.sections[0].fields.length, 2, 'base schema not mutated');
});

test('computed values', () => {
  assert.equal(COMPUTED.edd({ data: { pregnancy: { lmp: '2026-01-01' } } }), '2026-10-08');
  assert.equal(COMPUTED.age({ dateOfBirth: '2025-05-25', data: {}, today: new Date('2026-11-25') }), '18 months');
  assert.equal(COMPUTED.bmi({ data: { vitals: { weight_kg: 80, height_cm: 200 } } }), 20);
});

test('appointment status machine and recurrence', () => {
  assert.ok(canTransition('scheduled', 'arrived'));
  assert.ok(!canTransition('completed', 'arrived'));
  assert.ok(!canTransition('cancelled', 'scheduled'));
  assert.deepEqual(expandRecurrence('FREQ=WEEKLY;INTERVAL=2;COUNT=3'), [0, 14, 28]);
  assert.throws(() => expandRecurrence('FREQ=HOURLY;COUNT=3'));
});

test('only doctors can hold prescription.create', () => {
  assert.ok(isGrantable('doctor', 'prescription.create'));
  assert.ok(!isGrantable('assistant', 'prescription.create'));
});

test('every examination preset is valid and covers the 8 specialties', async () => {
  const { EXAM_PRESETS } = await import('./index.js');
  for (const p of EXAM_PRESETS) assert.deepEqual(validateSchema(p.schema), [], p.specialty);
  assert.equal(new Set(EXAM_PRESETS.map((p) => p.specialty)).size, 8);
});
