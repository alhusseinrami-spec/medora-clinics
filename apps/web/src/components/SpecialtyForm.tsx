'use client';
import { useState } from 'react';
import { COMPUTED, label as L, type Field as F, type Section, type TemplateSchema } from '@medora/shared';
import { Button, ErrorNote, Field, Input, Select, Textarea, cx } from './ui';
import { useI18n } from '@/lib/i18n';
import { DiabetesRecalls, PregnancyTracker, TrendCharts } from './SpecialtyWidgets';

type Data = Record<string, Record<string, any>>;

/** Generic renderer for any specialty template version. Specialty widgets enhance sections; unknown widgets fall back to plain fields. */
export function SpecialtyForm({ schema, initial, dateOfBirth, sex, readOnly, onSave, fieldErrors }: {
  schema: TemplateSchema; initial: Data; dateOfBirth?: string | null; sex?: string | null; readOnly?: boolean; onSave?: (d: Data) => Promise<void>; fieldErrors?: { path: string; message: string }[];
}) {
  const { t, lang } = useI18n();
  const [data, setData] = useState<Data>(initial ?? {}); const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null); const [ok, setOk] = useState(false);
  const setVal = (sec: string, key: string, v: any) => { setOk(false); setData((d) => ({ ...d, [sec]: { ...(d[sec] ?? {}), [key]: v } })); };
  const errFor = (path: string) => fieldErrors?.find((e) => e.path === path)?.message;
  const save = async () => { if (!onSave) return; setBusy(true); setErr(null); try { await onSave(clean(data)); setOk(true); } catch (e) { setErr(e); } finally { setBusy(false); } };

  return (
    <div className="space-y-6">
      {schema.sections.map((s) => (
        <section key={s.key} className="rounded-[12px] border border-line p-4">
          <h3 className="mb-3 font-[family-name:var(--font-display)] font-semibold">{L(s.label, lang)}</h3>
          {s.widget === 'growth_chart' && <GrowthChart rows={data[s.key]?.measurements ?? []} />}
          {s.widget === 'dental_chart' && <DentalChart rows={data[s.key]?.teeth ?? []} />}
          {s.widget === 'pregnancy_tracker' && <PregnancyTracker data={data[s.key] ?? {}} />}
          {s.widget === 'diabetes_recalls' && <DiabetesRecalls data={data} />}
          {s.chart && <TrendCharts section={s} data={data[s.key] ?? {}} />}
          <div className="grid gap-3 sm:grid-cols-2">
            {s.fields.filter((f) => !f.hidden).map((f) => (
              <FieldInput key={f.key} f={f} sec={s} value={data[s.key]?.[f.key]} onChange={(v) => setVal(s.key, f.key, v)} readOnly={readOnly}
                computed={f.type === 'computed' ? COMPUTED[f.compute!]?.({ dateOfBirth, sex, data }) : undefined} error={errFor(`${s.key}.${f.key}`)} />
            ))}
          </div>
        </section>
      ))}
      {!readOnly && onSave && <div className="flex items-center justify-end gap-3"><ErrorNote error={err} />{ok && <span className="text-sm text-success">{t('saved')}</span>}<Button busy={busy} onClick={save}>{t('save')}</Button></div>}
    </div>
  );
}

function clean(d: Data): Data {
  const out: Data = {};
  for (const [s, fields] of Object.entries(d)) {
    const o: Record<string, any> = {};
    for (const [k, v] of Object.entries(fields ?? {})) if (v !== '' && v !== undefined && v !== null && !(Array.isArray(v) && !v.length)) o[k] = v;
    if (Object.keys(o).length) out[s] = o;
  }
  return out;
}

function FieldInput({ f, sec, value, onChange, readOnly, computed, error }: { f: F; sec: Section; value: any; onChange: (v: any) => void; readOnly?: boolean; computed?: any; error?: string }) {
  const { lang, t } = useI18n();
  const lbl = <>{L(f.label, lang)}{f.unit ? <span className="text-muted"> ({f.unit})</span> : null}{f.required && <span className="text-danger"> *</span>}{f.custom && <span className="ms-1 rounded bg-brand-soft px-1 text-[10px] text-brand">custom</span>}</>;
  const wide = f.type === 'textarea' || f.type === 'repeat' || f.type === 'multiselect';
  const cls = wide ? 'sm:col-span-2' : '';
  switch (f.type) {
    case 'computed': return <Field label={lbl} className={cls}><div className="flex h-10 items-center rounded-[10px] bg-surface px-3 text-sm">{computed ?? '—'}</div></Field>;
    case 'textarea': return <Field label={lbl} error={error} className={cls}><Textarea disabled={readOnly} value={value ?? ''} onChange={(e) => onChange(e.target.value)} /></Field>;
    case 'number': return <Field label={lbl} error={error} className={cls}><Input disabled={readOnly} type="number" step={f.step ?? 'any'} min={f.min} max={f.max} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} /></Field>;
    case 'date': return <Field label={lbl} error={error} className={cls}><Input disabled={readOnly} type="date" value={value ?? ''} onChange={(e) => onChange(e.target.value)} /></Field>;
    case 'boolean': return <Field label={lbl} error={error} className={cls}><Select disabled={readOnly} value={value === true ? 'y' : value === false ? 'n' : ''} onChange={(e) => onChange(e.target.value === '' ? '' : e.target.value === 'y')}><option value="">—</option><option value="y">{t('yes')}</option><option value="n">{t('no')}</option></Select></Field>;
    case 'select': return <Field label={lbl} error={error} className={cls}><Select disabled={readOnly} value={value ?? ''} onChange={(e) => onChange(e.target.value)}><option value="">—</option>{f.options!.map((o) => <option key={o.value} value={o.value}>{L(o.label, lang)}</option>)}</Select></Field>;
    case 'multiselect': {
      const cur: string[] = value ?? [];
      return <Field label={lbl} error={error} className={cls}><div className="flex flex-wrap gap-1.5">{f.options!.map((o) => {
        const on = cur.includes(o.value);
        return <button type="button" disabled={readOnly} key={o.value} onClick={() => onChange(on ? cur.filter((x) => x !== o.value) : [...cur, o.value])}
          className={cx('rounded-full border px-2.5 py-1 text-xs', on ? 'border-brand bg-brand text-white' : 'border-line hover:border-brand')}>{L(o.label, lang)}</button>;
      })}</div></Field>;
    }
    case 'repeat': {
      const rows: any[] = value ?? [];
      const sub = (f.fields ?? []).filter((x) => !x.hidden);
      return <div className={cls}><p className="mb-1 text-sm font-medium">{lbl}</p>
        <div className="overflow-x-auto rounded-[10px] border border-line"><table className="w-full text-sm"><thead className="bg-surface text-xs text-muted"><tr>{sub.map((s) => <th key={s.key} className="px-2 py-1.5 text-start font-medium">{L(s.label, lang)}{s.unit ? ` (${s.unit})` : ''}</th>)}<th /></tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i} className="border-t border-line">{sub.map((s) => <td key={s.key} className="p-1">
            <CellInput f={s} value={r[s.key]} readOnly={readOnly} onChange={(v) => onChange(rows.map((x, j) => (j === i ? { ...x, [s.key]: v } : x)))} /></td>)}
            <td className="px-1">{!readOnly && <button type="button" className="text-muted hover:text-danger" aria-label="Remove row" onClick={() => onChange(rows.filter((_, j) => j !== i))}>✕</button>}</td></tr>)}</tbody></table></div>
        {!readOnly && <Button type="button" size="sm" variant="ghost" className="mt-1" onClick={() => onChange([...rows, {}])}>+ {t('add')}</Button>}
        {error && <p className="text-xs text-danger">{error}</p>}</div>;
    }
    default: return <Field label={lbl} error={error} className={cls}><Input disabled={readOnly} value={value ?? ''} onChange={(e) => onChange(e.target.value)} maxLength={f.maxLength ?? 500} /></Field>;
  }
}

function CellInput({ f, value, onChange, readOnly }: { f: F; value: any; onChange: (v: any) => void; readOnly?: boolean }) {
  const { lang } = useI18n();
  const c = 'h-8 w-full min-w-24 rounded-md border border-line bg-card px-2 text-sm';
  if (f.type === 'select') return <select disabled={readOnly} className={c} value={value ?? ''} onChange={(e) => onChange(e.target.value)}><option value="">—</option>{f.options!.map((o) => <option key={o.value} value={o.value}>{L(o.label, lang)}</option>)}</select>;
  if (f.type === 'number') return <input disabled={readOnly} className={c} type="number" step="any" min={f.min} max={f.max} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />;
  if (f.type === 'date') return <input disabled={readOnly} className={c} type="date" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
  return <input disabled={readOnly} className={c} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
}

/** Weight over time from the growth measurements (WHO percentile curves: planned with clinical reference data). */
function GrowthChart({ rows }: { rows: { date?: string; weight_kg?: number; height_cm?: number }[] }) {
  const pts = rows.filter((r) => r.date && typeof r.weight_kg === 'number').map((r) => ({ x: Date.parse(r.date!), y: r.weight_kg! })).sort((a, b) => a.x - b.x);
  if (pts.length < 2) return <p className="mb-3 text-xs text-muted">Add two or more measurements with a date and weight to see the growth chart.</p>;
  const W = 520, H = 160, P = 28;
  const [x0, x1] = [pts[0].x, pts[pts.length - 1].x]; const ys = pts.map((p) => p.y); const [y0, y1] = [Math.min(...ys) * 0.9, Math.max(...ys) * 1.05];
  const sx = (x: number) => P + ((x - x0) / Math.max(x1 - x0, 1)) * (W - 2 * P); const sy = (y: number) => H - P - ((y - y0) / Math.max(y1 - y0, 0.1)) * (H - 2 * P);
  return <svg viewBox={`0 0 ${W} ${H}`} className="mb-3 w-full max-w-xl" role="img" aria-label="Weight chart">
    <line x1={P} y1={H - P} x2={W - P} y2={H - P} stroke="var(--line)" /><line x1={P} y1={P} x2={P} y2={H - P} stroke="var(--line)" />
    <polyline fill="none" stroke="var(--brand)" strokeWidth="2.5" points={pts.map((p) => `${sx(p.x)},${sy(p.y)}`).join(' ')} />
    {pts.map((p, i) => <g key={i}><circle cx={sx(p.x)} cy={sy(p.y)} r="3.5" fill="var(--accent)" /><text x={sx(p.x)} y={sy(p.y) - 8} fontSize="10" textAnchor="middle" fill="var(--muted)">{p.y} kg</text></g>)}
    <text x={P} y={H - 8} fontSize="10" fill="var(--muted)">{new Date(x0).toLocaleDateString()}</text><text x={W - P} y={H - 8} fontSize="10" textAnchor="end" fill="var(--muted)">{new Date(x1).toLocaleDateString()}</text>
  </svg>;
}

const TOOTH_COLOR: Record<string, string> = { healthy: 'var(--success)', caries: 'var(--danger)', filled: 'var(--info)', crown: 'var(--warning)', missing: 'var(--muted)', implant: 'var(--brand)', root_canal: 'var(--accent)', bridge: 'var(--warning)', fractured: 'var(--danger)' };
/** FDI permanent dentition, quadrants 1-4, coloured by the latest recorded condition. */
function DentalChart({ rows }: { rows: { tooth?: number; condition?: string }[] }) {
  const byTooth = new Map(rows.filter((r) => r.tooth).map((r) => [r.tooth!, r.condition]));
  const q = (n: number, rev: boolean) => { const a = Array.from({ length: 8 }, (_, i) => n * 10 + i + 1); return rev ? a.reverse() : a; };
  const row = (teeth: number[]) => <div className="flex gap-1">{teeth.map((t) => <div key={t} title={`${t} ${byTooth.get(t) ?? ''}`} className="flex size-8 items-center justify-center rounded-md border text-[10px] font-semibold"
    style={{ borderColor: byTooth.has(t) ? TOOTH_COLOR[byTooth.get(t) ?? ''] : 'var(--line)', background: byTooth.has(t) ? `color-mix(in srgb, ${TOOTH_COLOR[byTooth.get(t) ?? ''] ?? 'var(--line)'} 18%, transparent)` : undefined }}>{t}</div>)}</div>;
  return <div className="mb-3 inline-flex flex-col gap-1 rounded-[10px] border border-line p-3" dir="ltr">
    <div className="flex gap-3">{row(q(1, true))}{row(q(2, false))}</div>
    <div className="flex gap-3">{row(q(4, true))}{row(q(3, false))}</div>
  </div>;
}
