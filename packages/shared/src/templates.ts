// Specialty engine template format (version 1) and the validator shared by API and clients.
import { ageYears, cha2ds2vasc, cha2ds2vascAdvice, ckdStage, egfrCkdEpi2021, hasBled, latestRow, nextPapSmear, pregnancyRiskFlags, totalDailyInsulin } from './clinical.js';

export type Lang = 'en' | 'ar' | 'fr';
export type Label = string | Partial<Record<Lang, string>> & { en: string };

export type FieldType = 'text' | 'textarea' | 'number' | 'date' | 'boolean' | 'select' | 'multiselect' | 'computed' | 'repeat';

export interface Field {
  key: string;
  type: FieldType;
  label: Label;
  required?: boolean;
  /** Preset fields marked optional can be hidden by a doctor; required preset fields cannot be removed. */
  optional?: boolean;
  hidden?: boolean;
  custom?: boolean;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  maxLength?: number;
  options?: { value: string; label: Label }[];
  /** computed: name of a pure function in COMPUTED (age, edd, bmi, gestational_age) */
  compute?: string;
  fields?: Field[]; // repeat rows
}
/** Trend chart over a repeat field of the section: one small chart per series key, rows dated by `date`. */
export interface SectionChart { rows: string; series: string[] }
export interface Section { key: string; label: Label; widget?: string; chart?: SectionChart; fields: Field[] }
export interface TemplateSchema { format: 1; sections: Section[]; widgets?: string[] }

export function label(l: Label, lang: Lang = 'en'): string {
  return typeof l === 'string' ? l : l[lang] ?? l.en;
}

export interface ValidationError { path: string; message: string }
export interface ValidationResult { ok: boolean; errors: ValidationError[]; value: Record<string, unknown> }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEY_RE = /^[a-z][a-z0-9_]{0,49}$/;

function validateField(f: Field, v: unknown, path: string, errors: ValidationError[]): unknown {
  const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
  if (f.type === 'computed') return undefined; // never stored from input
  if (empty) { if (f.required && !f.hidden) errors.push({ path, message: 'required' }); return undefined; }
  switch (f.type) {
    case 'text': case 'textarea': {
      if (typeof v !== 'string') { errors.push({ path, message: 'must be text' }); return undefined; }
      const max = f.maxLength ?? (f.type === 'text' ? 500 : 10000);
      if (v.length > max) errors.push({ path, message: `at most ${max} characters` });
      return v.trim();
    }
    case 'number': {
      const n = typeof v === 'string' ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isFinite(n)) { errors.push({ path, message: 'must be a number' }); return undefined; }
      if (f.min !== undefined && n < f.min) errors.push({ path, message: `must be at least ${f.min}` });
      if (f.max !== undefined && n > f.max) errors.push({ path, message: `must be at most ${f.max}` });
      return n;
    }
    case 'date': {
      if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(v))) { errors.push({ path, message: 'must be a date (YYYY-MM-DD)' }); return undefined; }
      return v;
    }
    case 'boolean': {
      if (typeof v !== 'boolean') { errors.push({ path, message: 'must be yes or no' }); return undefined; }
      return v;
    }
    case 'select': {
      if (!f.options?.some((o) => o.value === v)) { errors.push({ path, message: 'not an allowed option' }); return undefined; }
      return v;
    }
    case 'multiselect': {
      if (!Array.isArray(v) || v.some((x) => !f.options?.some((o) => o.value === x))) { errors.push({ path, message: 'contains a value that is not allowed' }); return undefined; }
      return [...new Set(v)];
    }
    case 'repeat': {
      if (!Array.isArray(v)) { errors.push({ path, message: 'must be a list' }); return undefined; }
      if (v.length > 200) { errors.push({ path, message: 'too many rows' }); return undefined; }
      return v.map((row, i) => validateObject(f.fields ?? [], row, `${path}[${i}]`, errors));
    }
  }
}

function validateObject(fields: Field[], obj: unknown, prefix: string, errors: ValidationError[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) { errors.push({ path: prefix || '$', message: 'must be an object' }); return out; }
  const src = obj as Record<string, unknown>;
  const known = new Set(fields.map((f) => f.key));
  for (const k of Object.keys(src)) if (!known.has(k)) errors.push({ path: prefix ? `${prefix}.${k}` : k, message: 'unknown field' });
  for (const f of fields) {
    const val = validateField(f, src[f.key], prefix ? `${prefix}.${f.key}` : f.key, errors);
    if (val !== undefined) out[f.key] = val;
  }
  return out;
}

/** Data shape: { [sectionKey]: { [fieldKey]: value } } */
export function validateData(schema: TemplateSchema, data: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  const value: Record<string, unknown> = {};
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return { ok: false, errors: [{ path: '$', message: 'must be an object' }], value };
  const src = data as Record<string, unknown>;
  const keys = new Set(schema.sections.map((s) => s.key));
  for (const k of Object.keys(src)) if (!keys.has(k)) errors.push({ path: k, message: 'unknown section' });
  for (const s of schema.sections) {
    const v = validateObject(s.fields, src[s.key] ?? {}, s.key, errors);
    if (Object.keys(v).length) value[s.key] = v;
  }
  return { ok: errors.length === 0, errors, value };
}

/** Checks a schema itself (used when doctors customize templates). */
export function validateSchema(schema: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  const s = schema as TemplateSchema;
  if (!s || s.format !== 1 || !Array.isArray(s.sections)) return [{ path: '$', message: 'format must be 1 with a sections list' }];
  const sk = new Set<string>();
  const checkFields = (fields: Field[], p: string) => {
    const fk = new Set<string>();
    if (!Array.isArray(fields)) { errors.push({ path: p, message: 'fields must be a list' }); return; }
    for (const f of fields) {
      const fp = `${p}.${f?.key}`;
      if (!f || !KEY_RE.test(f.key)) { errors.push({ path: fp, message: 'key must be lower_snake_case' }); continue; }
      if (fk.has(f.key)) errors.push({ path: fp, message: 'duplicate key' }); fk.add(f.key);
      if (!['text', 'textarea', 'number', 'date', 'boolean', 'select', 'multiselect', 'computed', 'repeat'].includes(f.type)) errors.push({ path: fp, message: 'unknown type' });
      if (!f.label || !label(f.label)) errors.push({ path: fp, message: 'label required' });
      if ((f.type === 'select' || f.type === 'multiselect') && !(f.options?.length)) errors.push({ path: fp, message: 'options required' });
      if (f.type === 'repeat') checkFields(f.fields ?? [], fp);
      if (f.type === 'computed' && !(f.compute && f.compute in COMPUTED)) errors.push({ path: fp, message: 'unknown computation' });
    }
  };
  for (const sec of s.sections) {
    if (!sec || !KEY_RE.test(sec.key)) { errors.push({ path: String(sec?.key), message: 'section key must be lower_snake_case' }); continue; }
    if (sk.has(sec.key)) errors.push({ path: sec.key, message: 'duplicate section' }); sk.add(sec.key);
    checkFields(sec.fields, sec.key);
    if (sec.chart) {
      const rows = Array.isArray(sec.fields) ? sec.fields.find((f) => f.key === sec.chart!.rows && f.type === 'repeat') : undefined;
      if (!rows) errors.push({ path: `${sec.key}.chart`, message: 'chart rows must be a repeat field of the section' });
      else for (const k of sec.chart.series ?? []) if (!rows.fields?.some((f) => f.key === k && f.type === 'number')) errors.push({ path: `${sec.key}.chart.${k}`, message: 'chart series must be a number field of the rows' });
    }
  }
  return errors;
}

export interface Customization {
  addFields?: { section: string; field: Field }[];
  hideFields?: { section: string; key: string }[];
  showFields?: { section: string; key: string }[];
  relabel?: { section: string; key: string; label: Label }[];
}

/** Applies a doctor's customization to a base schema. Required preset fields can't be hidden. */
export function customize(base: TemplateSchema, c: Customization): { schema: TemplateSchema; errors: ValidationError[] } {
  const schema: TemplateSchema = structuredClone(base);
  const errors: ValidationError[] = [];
  const find = (sec: string, key?: string) => {
    const s = schema.sections.find((x) => x.key === sec);
    return { s, f: key ? s?.fields.find((x) => x.key === key) : undefined };
  };
  for (const a of c.addFields ?? []) {
    const { s } = find(a.section);
    if (!s) { errors.push({ path: a.section, message: 'unknown section' }); continue; }
    if (s.fields.some((f) => f.key === a.field.key)) { errors.push({ path: `${a.section}.${a.field.key}`, message: 'field already exists' }); continue; }
    s.fields.push({ ...a.field, custom: true, optional: true });
  }
  for (const h of c.hideFields ?? []) {
    const { f } = find(h.section, h.key);
    if (!f) { errors.push({ path: `${h.section}.${h.key}`, message: 'unknown field' }); continue; }
    if (f.required && !f.custom) { errors.push({ path: `${h.section}.${h.key}`, message: 'required preset fields cannot be removed' }); continue; }
    f.hidden = true;
  }
  for (const h of c.showFields ?? []) { const { f } = find(h.section, h.key); if (f) delete f.hidden; }
  for (const r of c.relabel ?? []) {
    const { f } = find(r.section, r.key);
    if (!f) { errors.push({ path: `${r.section}.${r.key}`, message: 'unknown field' }); continue; }
    f.label = r.label;
  }
  errors.push(...validateSchema(schema));
  return { schema, errors };
}

// ---------- Computed values ----------
const DAY = 86400000;
export interface ComputeCtx { dateOfBirth?: string | null; sex?: string | null; data: Record<string, any>; today?: Date }
export const COMPUTED: Record<string, (ctx: ComputeCtx) => string | number | null> = {
  age: ({ dateOfBirth, today = new Date() }) => {
    if (!dateOfBirth) return null;
    const d = new Date(dateOfBirth); let months = (today.getFullYear() - d.getFullYear()) * 12 + today.getMonth() - d.getMonth();
    if (today.getDate() < d.getDate()) months -= 1;
    if (months < 0) return null;
    return months < 24 ? `${months} months` : `${Math.floor(months / 12)} years`;
  },
  edd: ({ data }) => { // Naegele's rule: LMP + 280 days
    const lmp = data?.pregnancy?.lmp; if (!lmp) return null;
    return new Date(Date.parse(lmp) + 280 * DAY).toISOString().slice(0, 10);
  },
  gestational_age: ({ data, today = new Date() }) => {
    const lmp = data?.pregnancy?.lmp; if (!lmp) return null;
    const days = Math.floor((today.getTime() - Date.parse(lmp)) / DAY); if (days < 0 || days > 320) return null;
    return `${Math.floor(days / 7)}w ${days % 7}d`;
  },
  bmi: ({ data }) => {
    const w = data?.vitals?.weight_kg, h = data?.vitals?.height_cm; if (!w || !h) return null;
    return Math.round((w / ((h / 100) ** 2)) * 10) / 10;
  },
  // Cardiology: scores from the stroke and bleeding risk section (sex and age from the patient record).
  cha2ds2_vasc: ({ data, dateOfBirth, sex, today }) => {
    const r = data?.af_risk; if (!r) return null;
    const score = cha2ds2vasc(r, ageYears(dateOfBirth, today), sex);
    return `${score} · ${cha2ds2vascAdvice(score, sex)}`;
  },
  has_bled: ({ data, dateOfBirth, today }) => {
    const r = data?.af_risk; if (!r) return null;
    const score = hasBled(r, ageYears(dateOfBirth, today));
    return `${score} · ${score >= 3 ? 'high bleeding risk, review modifiable factors' : 'low to moderate bleeding risk'}`;
  },
  // Endocrinology
  egfr: ({ data, dateOfBirth, sex, today }) => {
    const row = latestRow<any>(data?.labs?.results, 'creatinine'); const age = ageYears(dateOfBirth, today);
    if (!row || age === null || (sex !== 'female' && sex !== 'male')) return null;
    const e = egfrCkdEpi2021(row.creatinine, age, sex);
    return `${e} mL/min/1.73m² · ${ckdStage(e)} (${row.date})`;
  },
  total_daily_insulin: ({ data }) => {
    const t = totalDailyInsulin(data?.insulin?.regimen); if (t === null) return null;
    const w = data?.vitals?.weight_kg;
    return typeof w === 'number' && w > 0 ? `${t} units · ${Math.round((t / w) * 100) / 100} units/kg` : `${t} units`;
  },
  // Gynecology and obstetrics
  pregnancy_risk: ({ data, dateOfBirth, today }) => {
    if (!data?.pregnancy?.pregnant) return null;
    const f = pregnancyRiskFlags(data, ageYears(dateOfBirth, today));
    return f.length ? f.join(' · ') : 'No risk flags';
  },
  next_pap: ({ data }) => nextPapSmear(data?.gynecology?.last_pap_smear),
};
