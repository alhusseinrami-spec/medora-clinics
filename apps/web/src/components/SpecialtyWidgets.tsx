'use client';
// Specialty pack widgets: trend charts with target bands, the pregnancy timeline and diabetes recalls.
import { TARGET_RANGES, diabetesRecalls, label as L, outOfRange, pregnancyTimeline, trendPoints, type Field, type Section } from '@medora/shared';
import { fmtDate } from './ui';
import { useI18n } from '@/lib/i18n';

type SecData = Record<string, any>;
const STATUS_TONE: Record<string, string> = { done: 'var(--success)', ok: 'var(--success)', overdue: 'var(--danger)', due: 'var(--warning)', upcoming: 'var(--muted)' };

function Chip({ status }: { status: string }) {
  const { t } = useI18n();
  const c = STATUS_TONE[status] ?? 'var(--muted)';
  return <span className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ color: c, background: `color-mix(in srgb, ${c} 14%, transparent)` }}>{t(`st_${status}`)}</span>;
}

/** One small chart per series of the section's repeat rows. INR uses the patient's own target when it is set. */
export function TrendCharts({ section, data }: { section: Section; data: SecData }) {
  const { t, lang } = useI18n();
  const chart = section.chart!; const rowsField = section.fields.find((f) => f.key === chart.rows);
  const rows = data?.[chart.rows];
  const series = chart.series.map((k) => ({ key: k, field: rowsField?.fields?.find((f) => f.key === k), points: trendPoints(rows, k) })).filter((s) => s.field && s.points.length);
  if (!series.length) return <p className="mb-3 text-xs text-muted">{t('trendHint')}</p>;
  return <div className="mb-4 grid gap-3 sm:grid-cols-2">
    {series.map((s) => {
      const range = s.key === 'inr' && typeof data?.inr_target_low === 'number' && typeof data?.inr_target_high === 'number'
        ? { low: data.inr_target_low, high: data.inr_target_high } : TARGET_RANGES[s.key];
      return <TrendCard key={s.key} field={s.field!} points={s.points} range={range} lang={lang} t={t} />;
    })}
  </div>;
}

const targetText = (r: { low?: number; high?: number }) => r.low !== undefined && r.high !== undefined ? `${r.low}–${r.high}` : r.high !== undefined ? `≤ ${r.high}` : `≥ ${r.low}`;

function TrendCard({ field, points, range, lang, t }: { field: Field; points: { date: string; value: number }[]; range?: { low?: number; high?: number }; lang: string; t: (k: string) => string }) {
  const last = points[points.length - 1]; const flag = outOfRange('', last.value, range);
  const W = 300, H = 96, PX = 8, PY = 10;
  const vals = points.map((p) => p.value).concat(range?.low ?? [], range?.high ?? []);
  let y0 = Math.min(...vals), y1 = Math.max(...vals); const pad = (y1 - y0 || Math.abs(y1) || 1) * 0.12; y0 -= pad; y1 += pad;
  const xs = points.map((p) => Date.parse(p.date)); const [x0, x1] = [xs[0], xs[xs.length - 1]];
  const sx = (x: number) => (points.length === 1 ? W / 2 : PX + ((x - x0) / Math.max(x1 - x0, 1)) * (W - 2 * PX));
  const sy = (y: number) => H - PY - ((y - y0) / (y1 - y0)) * (H - 2 * PY);
  const bandTop = sy(range?.high ?? y1), bandBottom = sy(range?.low ?? y0);
  const tone = flag ? 'var(--danger)' : 'var(--success)';
  const unit = field.unit ? ` ${field.unit}` : '';
  return <div className="rounded-[10px] border border-line p-3">
    <div className="flex items-baseline justify-between gap-2">
      <p className="text-sm font-medium">{L(field.label, lang as any)}</p>
      <p className="tabular text-sm"><span className="text-lg font-semibold" style={{ color: tone }}>{last.value}</span><span className="text-muted">{unit}</span></p>
    </div>
    <p className="mb-1 text-[11px] text-muted">
      {[fmtDate(last.date, lang), range && (flag === 'high' ? t('aboveTarget') : flag === 'low' ? t('belowTarget') : t('inTarget')), range && `${t('target')} ${targetText(range)}${unit}`].filter(Boolean).join(' · ')}
    </p>
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`${L(field.label, lang as any)} trend`}>
      {range && <rect x={0} y={bandTop} width={W} height={Math.max(bandBottom - bandTop, 0)} fill="var(--success)" opacity="0.1" />}
      {points.length > 1 && <polyline fill="none" stroke="var(--brand)" strokeWidth="2" points={points.map((p) => `${sx(Date.parse(p.date))},${sy(p.value)}`).join(' ')} />}
      {points.map((p, i) => { const o = outOfRange('', p.value, range); return <circle key={i} cx={sx(Date.parse(p.date))} cy={sy(p.value)} r="3.5" fill={o ? 'var(--danger)' : 'var(--brand)'}><title>{`${p.date}: ${p.value}${unit}`}</title></circle>; })}
    </svg>
    {points.length > 1 && <div className="flex justify-between text-[10px] text-muted"><span>{fmtDate(points[0].date, lang)}</span><span>{points.length} ×</span><span>{fmtDate(last.date, lang)}</span></div>}
  </div>;
}

/** Week, trimester and due date on a 40-week bar, then the routine tests and vaccines with their status. */
export function PregnancyTracker({ data }: { data: SecData }) {
  const { t, lang } = useI18n();
  const tl = pregnancyTimeline(data);
  if (!tl) return null;
  const pct = Math.min(100, (tl.week * 7 + tl.day) / 280 * 100);
  return <div className="mb-4 rounded-[10px] border border-line p-3">
    <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
      <p><span className="text-lg font-semibold">{t('week')} {tl.week}+{tl.day}</span> <span className="text-muted">· {t('trimester')} {tl.trimester}</span></p>
      <p className="text-muted">{t('dueDate')} <span className="font-medium text-ink">{fmtDate(tl.edd, lang)}</span></p>
    </div>
    <div className="relative my-3 h-2.5 rounded-full bg-surface" dir="ltr">
      <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
      {[14, 28].map((w) => <span key={w} className="absolute top-[-3px] h-4 w-px bg-muted" style={{ left: `${w / 40 * 100}%` }} />)}
    </div>
    <div className="mb-3 flex justify-between text-[10px] text-muted" dir="ltr"><span>0</span><span>14</span><span>28</span><span>40 {t('weeksRange')}</span></div>
    <p className="mb-2 text-xs text-muted">{t('lastVisit')}: {tl.lastVisit ? fmtDate(tl.lastVisit, lang) : '—'} · {t('nextVisit')}: <span className="font-medium text-ink">{fmtDate(tl.nextVisit, lang)}</span></p>
    <ul className="divide-y divide-line text-sm">
      {tl.items.map((i) => <li key={i.key} className="flex items-center justify-between gap-3 py-1.5">
        <span><span className="tabular me-2 text-xs text-muted">{i.fromWeek}–{i.toWeek}</span>{t(`pn_${i.key}`)}</span>
        <span className="flex items-center gap-2">{i.doneOn && <span className="text-xs text-muted">{fmtDate(i.doneOn, lang)}</span>}<Chip status={i.status} /></span>
      </li>)}
    </ul>
  </div>;
}

/** Diabetes follow-up recalls computed from the whole profile (labs, screening dates). */
export function DiabetesRecalls({ data }: { data: Record<string, SecData> }) {
  const { t, lang } = useI18n();
  const items = diabetesRecalls(data);
  if (!items.length) return null;
  return <ul className="mb-4 divide-y divide-line rounded-[10px] border border-line px-3 text-sm">
    {items.map((r) => <li key={r.key} className="flex items-center justify-between gap-3 py-2">
      <span>{t(`rc_${r.key}`)}<span className="block text-xs text-muted">{t('lastDone')}: {r.last ? fmtDate(r.last, lang) : t('notYet')} · {t('nextDue')}: {fmtDate(r.due, lang)}</span></span>
      <Chip status={r.status} />
    </li>)}
  </ul>;
}
