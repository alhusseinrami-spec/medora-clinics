// Specialty clinical logic shared by the API (dashboard follow-up lists) and the web app (widgets, computed fields):
// default target ranges for trended values, risk calculators, the prenatal schedule and diabetes recalls.
// Pure functions only; dates are ISO 'YYYY-MM-DD' strings and "today" can be injected for tests.

const DAY = 86400000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const parse = (d?: string | null) => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? Date.parse(d.slice(0, 10)) : NaN);
const todayUtc = (today = new Date()) => Date.parse(today.toISOString().slice(0, 10));
export const addDays = (d: string, n: number) => iso(parse(d) + n * DAY);
export function addMonths(d: string, n: number): string {
  const x = new Date(parse(d)); const day = x.getUTCDate();
  x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() + n);
  const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
  x.setUTCDate(Math.min(day, last)); return iso(x.getTime());
}

/** Age in whole years, or null without a date of birth. */
export function ageYears(dateOfBirth?: string | null, today = new Date()): number | null {
  if (!dateOfBirth) return null;
  const b = new Date(parse(String(dateOfBirth))); if (Number.isNaN(b.getTime())) return null;
  let a = today.getUTCFullYear() - b.getUTCFullYear();
  if (today.getUTCMonth() < b.getUTCMonth() || (today.getUTCMonth() === b.getUTCMonth() && today.getUTCDate() < b.getUTCDate())) a -= 1;
  return a >= 0 ? a : null;
}

// ---------- Trends ----------
/** Default target ranges for trended values (keyed by field key). Shown as a band on trend charts; values outside are flagged. */
export const TARGET_RANGES: Record<string, { low?: number; high?: number; note?: string }> = {
  systolic: { low: 90, high: 140 },
  diastolic: { low: 60, high: 90 },
  heart_rate: { low: 50, high: 100 },
  inr: { low: 2, high: 3, note: 'Default 2–3; uses the patient target when set' },
  hba1c: { high: 7, note: 'ADA general target < 7%' },
  fasting_glucose: { low: 80, high: 130 },
  ldl: { high: 100 },
  triglycerides: { high: 150 },
  tsh: { low: 0.4, high: 4 },
  free_t4: { low: 0.8, high: 1.8 },
  uacr: { high: 30 },
};

export interface TrendPoint { date: string; value: number }
/** Points of one value over time from repeat rows (rows without a date or a number are skipped), oldest first. */
export function trendPoints(rows: unknown, key: string): TrendPoint[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r: any) => r && !Number.isNaN(parse(r.date)) && typeof r[key] === 'number' && Number.isFinite(r[key]))
    .map((r: any) => ({ date: String(r.date).slice(0, 10), value: r[key] as number }))
    .sort((a, b) => parse(a.date) - parse(b.date));
}
/** The most recent row (by date) that has a number for `key`. */
export function latestRow<T extends Record<string, any>>(rows: unknown, key: string): T | null {
  if (!Array.isArray(rows)) return null;
  let best: T | null = null;
  for (const r of rows as T[]) {
    if (!r || Number.isNaN(parse(r.date)) || typeof r[key] !== 'number') continue;
    if (!best || parse(r.date) >= parse(best.date)) best = r;
  }
  return best;
}
export function outOfRange(key: string, value: number, range = TARGET_RANGES[key]): 'low' | 'high' | null {
  if (!range) return null;
  if (range.low !== undefined && value < range.low) return 'low';
  if (range.high !== undefined && value > range.high) return 'high';
  return null;
}

// ---------- Cardiology risk scores ----------
type Flags = Record<string, unknown>;
const yes = (o: Flags | undefined, k: string) => o?.[k] === true;

/** CHA2DS2-VASc stroke risk in atrial fibrillation (0–9). */
export function cha2ds2vasc(risk: Flags | undefined, age: number | null, sex?: string | null): number {
  let s = 0;
  if (yes(risk, 'chf')) s += 1;
  if (yes(risk, 'hypertension')) s += 1;
  if (age !== null && age >= 75) s += 2; else if (age !== null && age >= 65) s += 1;
  if (yes(risk, 'diabetes')) s += 1;
  if (yes(risk, 'stroke_tia')) s += 2;
  if (yes(risk, 'vascular_disease')) s += 1;
  if (sex === 'female') s += 1;
  return s;
}
export function cha2ds2vascAdvice(score: number, sex?: string | null): string {
  const nonSex = sex === 'female' ? score - 1 : score;
  if (nonSex >= 2) return 'oral anticoagulation recommended';
  if (nonSex === 1) return 'oral anticoagulation should be considered';
  return 'low risk, no anticoagulation for stroke prevention';
}

/** HAS-BLED bleeding risk on anticoagulation (0–9). */
export function hasBled(risk: Flags | undefined, age: number | null): number {
  const k = ['uncontrolled_htn', 'abnormal_renal', 'abnormal_liver', 'stroke_tia', 'bleeding_history', 'labile_inr', 'antiplatelet_nsaid', 'alcohol'];
  return k.reduce((s, x) => s + (yes(risk, x) ? 1 : 0), 0) + (age !== null && age > 65 ? 1 : 0);
}

// ---------- Kidney function ----------
/** eGFR by CKD-EPI 2021 (race-free), creatinine in mg/dL, result mL/min/1.73m². */
export function egfrCkdEpi2021(creatinineMgDl: number, age: number, sex: 'female' | 'male'): number {
  const f = sex === 'female'; const k = f ? 0.7 : 0.9; const a = f ? -0.241 : -0.302; const r = creatinineMgDl / k;
  return Math.round(142 * Math.min(r, 1) ** a * Math.max(r, 1) ** -1.2 * 0.9938 ** age * (f ? 1.012 : 1));
}
export function ckdStage(egfr: number): string {
  return egfr >= 90 ? 'G1' : egfr >= 60 ? 'G2' : egfr >= 45 ? 'G3a' : egfr >= 30 ? 'G3b' : egfr >= 15 ? 'G4' : 'G5';
}

// ---------- Pregnancy ----------
export interface PrenatalItem { key: string; label: string; fromWeek: number; toWeek: number; when?: 'rh_negative' }
/** Routine prenatal tests and vaccines by gestational week. A doctor marks each as done in the profile. */
export const PRENATAL_SCHEDULE: PrenatalItem[] = [
  { key: 'booking_labs', label: 'Booking labs (CBC, blood group, rubella, HBV, HIV, syphilis, urine)', fromWeek: 6, toWeek: 12 },
  { key: 'first_trimester_scan', label: 'Dating / nuchal scan and first-trimester screening', fromWeek: 11, toWeek: 14 },
  { key: 'anatomy_scan', label: 'Anatomy scan', fromWeek: 18, toWeek: 22 },
  { key: 'glucose_test', label: 'Glucose tolerance test', fromWeek: 24, toWeek: 28 },
  { key: 'anti_d', label: 'Anti-D immunoglobulin (Rh negative)', fromWeek: 28, toWeek: 29, when: 'rh_negative' },
  { key: 'tdap', label: 'Tdap vaccine', fromWeek: 27, toWeek: 36 },
  { key: 'growth_scan', label: 'Third-trimester growth scan', fromWeek: 30, toWeek: 34 },
  { key: 'gbs_swab', label: 'Group B streptococcus swab', fromWeek: 36, toWeek: 37 },
];
export type ItemStatus = 'done' | 'overdue' | 'due' | 'upcoming';
export interface PregnancyTimeline {
  week: number; day: number; trimester: 1 | 2 | 3; edd: string;
  items: (PrenatalItem & { status: ItemStatus; dueFrom: string; dueTo: string; doneOn?: string })[];
  lastVisit: string | null; nextVisit: string;
}
/** Visit interval by gestational week: 4 weeks until 28, 2 weeks until 36, then weekly. */
export const visitIntervalWeeks = (week: number) => (week < 28 ? 4 : week < 36 ? 2 : 1);

export function pregnancyTimeline(pregnancy: Record<string, any> | undefined, today = new Date()): PregnancyTimeline | null {
  const lmp = parse(pregnancy?.lmp); if (!pregnancy?.pregnant || Number.isNaN(lmp)) return null;
  const days = Math.floor((todayUtc(today) - lmp) / DAY); if (days < 0 || days > 44 * 7) return null;
  const week = Math.floor(days / 7);
  const done = new Map<string, string>();
  for (const r of Array.isArray(pregnancy.tests_done) ? pregnancy.tests_done : []) if (r?.test) done.set(r.test, r.date ?? '');
  const now = todayUtc(today);
  const items = PRENATAL_SCHEDULE.filter((i) => !i.when || pregnancy[i.when] === true).map((i) => {
    const dueFrom = iso(lmp + i.fromWeek * 7 * DAY); const dueTo = iso(lmp + (i.toWeek * 7 + 6) * DAY);
    const status: ItemStatus = done.has(i.key) ? 'done' : now > parse(dueTo) ? 'overdue' : now >= parse(dueFrom) ? 'due' : 'upcoming';
    return { ...i, status, dueFrom, dueTo, ...(done.has(i.key) ? { doneOn: done.get(i.key) } : {}) };
  });
  const visits = (Array.isArray(pregnancy.prenatal_visits) ? pregnancy.prenatal_visits : []).map((v: any) => parse(v?.date)).filter((t: number) => !Number.isNaN(t));
  const last = visits.length ? Math.max(...visits) : null;
  const lastWeek = last !== null ? Math.floor((last - lmp) / DAY / 7) : week;
  const nextVisit = last !== null ? iso(last + visitIntervalWeeks(lastWeek) * 7 * DAY) : iso(now);
  return { week, day: days % 7, trimester: week < 14 ? 1 : week < 28 ? 2 : 3, edd: iso(lmp + 280 * DAY), items, lastVisit: last !== null ? iso(last) : null, nextVisit };
}

/** Risk flags shown on every obstetric visit. */
export function pregnancyRiskFlags(data: Record<string, any>, age: number | null): string[] {
  const p = data?.pregnancy ?? {}; const flags: string[] = [];
  if (age !== null && age >= 35) flags.push('Maternal age 35 or more');
  if (age !== null && age < 18) flags.push('Maternal age under 18');
  const v = latestRow<any>(p.prenatal_visits, 'systolic') ?? latestRow<any>(p.prenatal_visits, 'diastolic');
  if (v && ((v.systolic ?? 0) >= 140 || (v.diastolic ?? 0) >= 90)) flags.push('High blood pressure at last visit');
  if (p.gestational_diabetes === true) flags.push('Gestational diabetes');
  if (p.multiple === true) flags.push('Multiple pregnancy');
  if (p.rh_negative === true) flags.push('Rh negative');
  if (Array.isArray(data?.obstetric?.pregnancies) && data.obstetric.pregnancies.some((x: any) => x?.delivery === 'c_section')) flags.push('Previous caesarean section');
  if (p.risk === 'high') flags.push('Marked high risk');
  return flags;
}

// ---------- Diabetes ----------
export interface Recall { key: string; label: string; last: string | null; due: string; status: 'overdue' | 'due' | 'ok' }
/** Diabetes follow-up recalls: HbA1c (3 months, 6 when at target), lipids, kidney, eye and foot checks (yearly). */
export function diabetesRecalls(data: Record<string, any>, today = new Date()): Recall[] {
  const type = data?.diabetes?.type; if (!type || type === 'none') return [];
  const rows = data?.labs?.results;
  const lastOf = (k: string) => latestRow<any>(rows, k);
  const a1c = lastOf('hba1c');
  const kidney = [lastOf('uacr'), lastOf('creatinine')].filter(Boolean).sort((x, y) => parse(y.date) - parse(x.date))[0] ?? null;
  const s = data?.screening ?? {};
  const now = todayUtc(today);
  const mk = (key: string, label: string, last: string | null, months: number): Recall => {
    const due = last ? addMonths(last, months) : iso(now);
    const t = parse(due);
    return { key, label, last, due, status: !last || t < now ? 'overdue' : t <= now + 30 * DAY ? 'due' : 'ok' };
  };
  return [
    mk('hba1c', 'HbA1c', a1c?.date ?? null, a1c && a1c.hba1c <= 7 ? 6 : 3),
    mk('lipids', 'Lipid profile', lastOf('ldl')?.date ?? null, 12),
    mk('kidney', 'Kidney function (creatinine, urine albumin)', kidney?.date ?? null, 12),
    mk('eye', 'Retinal eye exam', s.last_eye_exam ?? null, 12),
    mk('foot', 'Diabetic foot exam', s.last_foot_exam ?? null, 12),
  ];
}
/** Total daily insulin from the regimen rows (units). */
export function totalDailyInsulin(rows: unknown): number | null {
  if (!Array.isArray(rows) || !rows.length) return null;
  const sum = rows.reduce((s: number, r: any) => s + ['morning', 'noon', 'evening', 'bedtime'].reduce((x, k) => x + (typeof r?.[k] === 'number' ? r[k] : 0), 0), 0);
  return sum || null;
}

// ---------- Gynecology ----------
/** Next cervical screening date (3-year interval after the last Pap smear). */
export const nextPapSmear = (last?: string | null) => (last && !Number.isNaN(parse(last)) ? addMonths(last, 36) : null);
