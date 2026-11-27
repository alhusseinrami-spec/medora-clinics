'use client';
// The richer patient file: summary tiles, clinical summary, reminders, measurement trends, demographics, custom fields,
// notes, session packages, body map, odontogram, before/after photos and data-handling consents.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { CONSENT_NEEDS_DETAIL, CONSENT_PURPOSES, MEASUREMENTS, PERMANENT_TEETH, PRIMARY_TEETH, TARGET_RANGES, TOOTH_CONDITIONS, outOfRange } from '@medora/shared';
import { Badge, Button, Card, Dialog, Empty, ErrorNote, Field, Input, Select, Textarea, cx, fmtDate, fmtMoney, fmtTime } from './ui';
import { del, fileBlobUrl, get, patch, post, uploadFile } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useWorkspace } from '@/lib/workspace';
import { useLoad } from '@/lib/hooks';

type Lang = 'en' | 'fr' | 'ar';
const mLabel = (code: string, lang: string) => MEASUREMENTS[code]?.label[lang as Lang] ?? code;
const targetText = (r: { low?: number; high?: number }) => r.low !== undefined && r.high !== undefined ? `${r.low}–${r.high}` : r.high !== undefined ? `≤ ${r.high}` : `≥ ${r.low}`;
const mValue = (code: string, v: number) => `${Number(v).toFixed(MEASUREMENTS[code]?.decimals ?? 1)}${MEASUREMENTS[code]?.unit ? ` ${MEASUREMENTS[code].unit}` : ''}`;
const Section = ({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) =>
  <section className="border-t border-line pt-3 first:border-0 first:pt-0">
    <div className="mb-1.5 flex items-center justify-between gap-2"><h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>{action}</div>
    {children}
  </section>;

// ---------------------------------------------------------------- Summary

export function useSummary(patientId: string) {
  return useLoad<any>(`/patients/${patientId}/summary`);
}

export function SummaryTiles({ s }: { s: any }) {
  const { t, lang } = useI18n();
  const tile = (n: ReactNode, label: string, tone: string) => <div className={cx('rounded-[12px] border p-3', tone)}>
    <p className="text-2xl font-semibold tabular">{n}</p><p className="text-xs font-medium uppercase tracking-wide">{label}</p></div>;
  return <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
    {!s.restricted && <>
      {tile(s.counts.medications, t('currentMedications'), 'border-brand/30 bg-brand-soft text-brand')}
      {tile(s.counts.problems, t('problemList'), 'border-warning/30 bg-warning/10 text-warning')}
      {tile(s.counts.allergies, t('flaggedAllergies'), 'border-danger/30 bg-danger/10 text-danger')}
    </>}
    {tile(s.nextAppointment ? <span className="text-base">{fmtDate(s.nextAppointment.starts_at, lang)} · {fmtTime(s.nextAppointment.starts_at, lang)}</span> : '—',
      s.nextAppointment ? `${t('nextAppointment')} · ${s.nextAppointment.doctor_name}` : t('nextAppointment'), 'border-line bg-card text-ink')}
  </div>;
}

/** Problems, allergies, current medications, immunizations, latest vitals and recent encounters. */
export function ClinicalSummary({ patientId, s, reload }: { patientId: string; s: any; reload: () => void }) {
  const { t, lang, status } = useI18n(); const { orgId } = useWorkspace();
  const [edit, setEdit] = useState<{ kind: string; item?: any } | null>(null);
  if (s.restricted) return <Card title={t('clinicalSummary')}><p className="rounded-[10px] border border-line bg-surface p-3 text-sm text-muted">{t('clinicalRestricted')}</p></Card>;
  const of = (k: string) => s.items.filter((i: any) => i.kind === k);
  const current = (k: string) => of(k).filter((i: any) => !['resolved', 'stopped'].includes(i.status));
  const past = (k: string) => of(k).filter((i: any) => ['resolved', 'stopped'].includes(i.status));
  const add = (kind: string) => <Button size="sm" variant="ghost" onClick={() => setEdit({ kind })}>+ {t('add')}</Button>;
  const row = (i: any, main: ReactNode) => <li key={i.id}><button className="flex w-full items-baseline gap-2 rounded-md px-1 py-0.5 text-start hover:bg-surface" onClick={() => setEdit({ kind: i.kind, item: i })}>{main}</button></li>;
  const ended = (k: string) => past(k).length > 0 && <details className="mt-1 text-xs text-muted"><summary className="cursor-pointer">{t('pastItems')} ({past(k).length})</summary>
    <ul className="mt-1 space-y-0.5">{past(k).map((i: any) => row(i, <span className="line-through">{i.label}</span>))}</ul></details>;
  return <Card title={t('clinicalSummary')}>
    <div className="space-y-4 text-sm">
      <Section title={t('problemList')} action={add('problem')}>
        {current('problem').length ? <ul className="space-y-0.5">{current('problem').map((i: any) => row(i, <>
          <span className="font-medium">{i.label}</span>{i.code && <span className="text-xs text-muted tabular">{i.code}</span>}
          {i.status === 'chronic' && <span className="text-[11px] font-semibold uppercase tracking-wide text-warning">{t('chronic')}</span>}
          {i.started_on && <span className="text-xs text-muted">{t('since')} {fmtDate(i.started_on, lang)}</span>}</>))}</ul> : <p className="text-muted">{t('noneRecorded')}</p>}
        {ended('problem')}
      </Section>
      <Section title={t('flaggedAllergies')} action={add('allergy')}>
        {current('allergy').length ? <ul className="space-y-0.5">{current('allergy').map((i: any) => row(i, <>
          <span className="font-medium text-danger">{i.label}{i.detail ? ` — ${i.detail}` : ''}</span>
          {i.severity && <Badge status={i.severity === 'severe' ? 'cancelled' : i.severity === 'moderate' ? 'waiting' : 'scheduled'}>{t(`sev_${i.severity}`)}</Badge>}</>))}</ul>
          : <p className="text-muted">{t('noKnownAllergies')}</p>}
        {ended('allergy')}
      </Section>
      <Section title={t('currentMedications')} action={add('medication')}>
        {current('medication').length ? <ul className="space-y-0.5">{current('medication').map((i: any) => row(i, <>
          <span className="font-medium">{i.label}</span>{i.detail && <span className="text-muted">· {i.detail}</span>}</>))}</ul> : <p className="text-muted">{t('noneRecorded')}</p>}
        {ended('medication')}
      </Section>
      <Section title={t('immunizations')} action={add('immunization')}>
        {of('immunization').length ? <ul className="space-y-0.5">{of('immunization').map((i: any) => row(i, <>
          <span className="font-medium">{i.label}</span>{i.detail && <span className="text-muted">· {i.detail}</span>}
          {i.started_on && <span className="text-xs text-muted tabular">{fmtDate(i.started_on, lang)}</span>}</>))}</ul> : <p className="text-muted">{t('noneRecorded')}</p>}
      </Section>
      <Section title={t('latestVitals')}>
        {s.latest.length ? <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">{s.latest.map((m: any) => {
          const flag = outOfRange(m.code, m.value, TARGET_RANGES[m.code]);
          return <div key={m.code} className="flex items-baseline justify-between gap-2"><dt className="text-muted">{mLabel(m.code, lang)}</dt>
            <dd className={cx('tabular', flag && 'font-semibold text-danger')}>{mValue(m.code, m.value)} <span className="text-[11px] font-normal text-muted">{fmtDate(m.measured_on, lang)}</span></dd></div>;
        })}</dl> : <p className="text-muted">{t('noneRecorded')}</p>}
      </Section>
      {s.encounters.length > 0 && <Section title={t('recentEncounters')}>
        <ul className="space-y-0.5">{s.encounters.map((e: any) => <li key={e.id}><Link className="hover:underline" href={`/w/${orgId}/consultations/${e.id}`}>
          <span className="tabular">{fmtDate(e.at, lang)}</span> · {e.chief_complaint || t('consultation')} <span className="text-muted">· {e.doctor_name}</span></Link>
          {e.status === 'draft' && <Badge status="draft" className="ms-2">{status('in_consultation')}</Badge>}</li>)}</ul>
      </Section>}
    </div>
    <ItemDialog patientId={patientId} edit={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); reload(); }} />
  </Card>;
}

function ItemDialog({ patientId, edit, onClose, onDone }: { patientId: string; edit: { kind: string; item?: any } | null; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const blank = { label: '', detail: '', status: 'active', severity: '', code: '', startedOn: '' };
  const [f, setF] = useState(blank); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  useEffect(() => {
    const i = edit?.item;
    setF(i ? { label: i.label, detail: i.detail ?? '', status: i.status, severity: i.severity ?? '', code: i.code ?? '', startedOn: i.started_on?.slice(0, 10) ?? '' }
      : { ...blank, status: edit?.kind === 'problem' ? 'chronic' : 'active' });
    setErr(null);
  }, [edit]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!edit) return null;
  const k = edit.kind; const set = (key: keyof typeof blank) => (e: any) => setF({ ...f, [key]: e.target.value });
  const statuses = { problem: ['chronic', 'active', 'resolved'], allergy: ['active', 'resolved'], medication: ['active', 'stopped'], immunization: ['active'] }[k] ?? ['active'];
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      if (edit.item) await patch(`/clinical-items/${edit.item.id}`, { label: f.label, detail: f.detail || null, status: f.status, ...(k === 'allergy' ? { severity: f.severity || null } : {}) });
      else await post(`/patients/${patientId}/clinical-items`, { kind: k, label: f.label, detail: f.detail || null, status: f.status,
        ...(k === 'allergy' ? { severity: f.severity || null } : {}), code: f.code || null, startedOn: f.startedOn || null });
      onDone();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return <Dialog open onClose={onClose} title={`${t(`item_${k}`)}${edit.item ? '' : ` · ${t('add')}`}`}>
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={t(`itemLabel_${k}`)} className="sm:col-span-2"><Input value={f.label} onChange={set('label')} required /></Field>
      <Field label={t(`itemDetail_${k}`)} className="sm:col-span-2"><Input value={f.detail} onChange={set('detail')} /></Field>
      {statuses.length > 1 && <Field label={t('status')}><Select value={f.status} onChange={set('status')}>{statuses.map((s) => <option key={s} value={s}>{t(`st_${s}`)}</option>)}</Select></Field>}
      {k === 'allergy' && <Field label={t('severity')}><Select value={f.severity} onChange={set('severity')}><option value="">—</option>{['mild', 'moderate', 'severe'].map((s) => <option key={s} value={s}>{t(`sev_${s}`)}</option>)}</Select></Field>}
      {!edit.item && k === 'problem' && <Field label={t('icdCode')}><Input value={f.code} onChange={set('code')} placeholder="E11" /></Field>}
      {!edit.item && k !== 'allergy' && <Field label={k === 'immunization' ? t('givenOn') : t('sinceDate')}><Input type="date" value={f.startedOn} onChange={set('startedOn')} /></Field>}
    </div>
    <div className="mt-3"><ErrorNote error={err} /></div>
    <div className="mt-4 flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>{t('cancel')}</Button><Button busy={busy} disabled={!f.label.trim()} onClick={save}>{t('save')}</Button></div>
  </Dialog>;
}

// ---------------------------------------------------------------- Reminders

export function Reminders({ s }: { s: any }) {
  const { t, lang } = useI18n();
  const list: any[] = s.reminders ?? [];
  const text = (r: any) => {
    switch (r.kind) {
      case 'allergy': return `${t('allergyOnFile')}: ${r.text}`;
      case 'above_target': case 'below_target': return `${mLabel(r.text, lang)} ${mValue(r.text, r.params.value)} (${fmtDate(r.params.on, lang)}) ${t(r.kind === 'above_target' ? 'aboveTarget' : 'belowTarget').toLowerCase()}`;
      case 'last_recorded': return `${mLabel(r.text, lang)} ${t('lastRecorded')} ${r.params.months < 1 ? t('withinMonth') : `${r.params.months} ${t('monthsAgo')}`} (${mValue(r.text, r.params.value)})`;
      case 'package_low': return `${r.text}: ${r.params.left} ${t('sessionsLeft')}`;
      default: return r.text;
    }
  };
  const tone: Record<string, string> = { danger: 'border-danger/30 bg-danger/10 text-danger', warning: 'border-warning/30 bg-warning/10 text-warning', info: 'border-line bg-surface text-ink' };
  return <Card title={t('reminders')} actions={<span className="text-xs text-muted">{t('remindersNote')}</span>}>
    {list.length === 0 ? <p className="text-sm text-muted">{t('noReminders')}</p> :
      <ul className="space-y-2">{list.map((r, i) => <li key={i} className={cx('rounded-[10px] border px-3 py-2 text-sm', tone[r.tone])}>
        <span aria-hidden className="me-2">{r.tone === 'danger' ? '⚠' : r.tone === 'warning' ? '▲' : '◷'}</span>{text(r)}</li>)}</ul>}
  </Card>;
}

// ---------------------------------------------------------------- Measurement trends

export function MeasurementTrends({ patientId, onChange }: { patientId: string; onChange: () => void }) {
  const { t, lang } = useI18n();
  const { data, reload } = useLoad<any[]>(`/patients/${patientId}/measurements`);
  const codes = useMemo(() => [...new Set((data ?? []).map((m) => m.code))], [data]);
  const [code, setCode] = useState(''); const [adding, setAdding] = useState(false);
  useEffect(() => { if (!code || !codes.includes(code)) setCode(['hba1c', 'inr', 'systolic', 'ldl', 'weight'].find((c) => codes.includes(c)) ?? codes[0] ?? ''); }, [codes]); // eslint-disable-line react-hooks/exhaustive-deps
  const points = (data ?? []).filter((m) => m.code === code);
  return <Card title={t('measurementTrends')} actions={<Button size="sm" variant="ghost" onClick={() => setAdding(true)}>+ {t('addMeasurement')}</Button>}>
    {!data ? <p className="text-sm text-muted">{t('loading')}</p> : codes.length === 0 ? <p className="text-sm text-muted">{t('noMeasurements')}</p> : <>
      <Select value={code} onChange={(e) => setCode(e.target.value)} className="mb-3 max-w-xs" aria-label={t('measurement')}>
        {codes.map((c) => { const n = (data ?? []).filter((m) => m.code === c).length; return <option key={c} value={c}>{mLabel(c, lang)}{MEASUREMENTS[c]?.unit ? ` (${MEASUREMENTS[c].unit})` : ''} · {n}</option>; })}
      </Select>
      <Trend code={code} points={points} lang={lang} />
      {points.length > 0 && <p className="mt-2 text-xs text-muted">{t('latest')}: <span className="tabular">{mValue(code, points[points.length - 1].value)}</span> · {fmtDate(points[points.length - 1].measured_on, lang)}
        {TARGET_RANGES[code] && <> · {t('target')} {targetText(TARGET_RANGES[code])}</>}</p>}
      <details className="mt-2 text-xs"><summary className="cursor-pointer text-muted">{t('allValues')}</summary>
        <ul className="mt-1 divide-y divide-line">{[...points].reverse().map((p) => <li key={p.id} className="flex items-center justify-between gap-2 py-1">
          <span className="tabular">{fmtDate(p.measured_on, lang)} · {mValue(code, p.value)} <span className="text-muted">· {p.recorded_by}</span></span>
          <button className="text-danger hover:underline" onClick={async () => { await del(`/measurements/${p.id}`); reload(); onChange(); }}>{t('remove')}</button></li>)}</ul></details>
    </>}
    <MeasurementDialog open={adding} patientId={patientId} defaultCode={code || 'weight'} onClose={() => setAdding(false)} onDone={(c) => { setAdding(false); setCode(c); reload(); onChange(); }} />
  </Card>;
}

function Trend({ code, points, lang }: { code: string; points: { value: number; measured_on: string }[]; lang: string }) {
  if (points.length < 2) return <p className="text-xs text-muted">{points.length ? '' : '—'}</p>;
  const W = 560, H = 200, L = 44, R = 12, T = 12, B = 28;
  const range = TARGET_RANGES[code];
  const vals = points.map((p) => p.value).concat(range?.low ?? [], range?.high ?? []);
  let y0 = Math.min(...vals), y1 = Math.max(...vals); const pad = (y1 - y0 || 1) * 0.12; y0 -= pad; y1 += pad;
  const xs = points.map((p) => Date.parse(p.measured_on)); const x0 = xs[0], x1 = xs[xs.length - 1];
  const sx = (x: number) => L + ((x - x0) / Math.max(x1 - x0, 1)) * (W - L - R);
  const sy = (y: number) => T + (1 - (y - y0) / (y1 - y0)) * (H - T - B);
  const ticks = [0, 1, 2, 3].map((i) => y0 + ((y1 - y0) * i) / 3);
  const dec = MEASUREMENTS[code]?.decimals ?? 1;
  const xt = [0, Math.floor((points.length - 1) / 2), points.length - 1].filter((v, i, a) => a.indexOf(v) === i);
  return <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`${mLabel(code, lang)} trend`}>
    {range && <rect x={L} width={W - L - R} y={sy(Math.min(range.high ?? y1, y1))} height={Math.max(sy(Math.max(range.low ?? y0, y0)) - sy(Math.min(range.high ?? y1, y1)), 0)} fill="var(--success)" opacity="0.08" />}
    {ticks.map((v, i) => <g key={i}><line x1={L} x2={W - R} y1={sy(v)} y2={sy(v)} stroke="var(--line)" strokeDasharray="4 4" />
      <text x={L - 6} y={sy(v) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">{v.toFixed(dec)}</text></g>)}
    {xt.map((i) => <text key={i} x={sx(xs[i])} y={H - 8} textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'} fontSize="11" fill="var(--muted)">{fmtDate(points[i].measured_on, lang)}</text>)}
    <polyline fill="none" stroke="var(--brand)" strokeWidth="2.5" strokeLinejoin="round" points={points.map((p, i) => `${sx(xs[i])},${sy(p.value)}`).join(' ')} />
    {points.map((p, i) => { const o = outOfRange(code, p.value, range); return <circle key={i} cx={sx(xs[i])} cy={sy(p.value)} r="4" fill="var(--card)" stroke={o ? 'var(--danger)' : 'var(--brand)'} strokeWidth="2"><title>{`${p.measured_on}: ${mValue(code, p.value)}`}</title></circle>; })}
  </svg>;
}

function MeasurementDialog({ open, patientId, defaultCode, onClose, onDone }: { open: boolean; patientId: string; defaultCode: string; onClose: () => void; onDone: (code: string) => void }) {
  const { t, lang } = useI18n();
  const [f, setF] = useState({ code: defaultCode, value: '', measuredOn: new Date().toISOString().slice(0, 10) }); const [err, setErr] = useState<unknown>(null);
  useEffect(() => { if (open) { setF((x) => ({ ...x, code: defaultCode, value: '' })); setErr(null); } }, [open, defaultCode]);
  const save = async () => { try { await post(`/patients/${patientId}/measurements`, { code: f.code, value: Number(f.value), measuredOn: f.measuredOn }); onDone(f.code); } catch (e) { setErr(e); } };
  return <Dialog open={open} onClose={onClose} title={t('addMeasurement')}>
    <div className="grid gap-3 sm:grid-cols-3">
      <Field label={t('measurement')}><Select value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })}>{Object.keys(MEASUREMENTS).map((c) => <option key={c} value={c}>{mLabel(c, lang)}</option>)}</Select></Field>
      <Field label={`${t('value')}${MEASUREMENTS[f.code]?.unit ? ` (${MEASUREMENTS[f.code].unit})` : ''}`}><Input type="number" step="any" inputMode="decimal" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} /></Field>
      <Field label={t('date')}><Input type="date" max={new Date().toISOString().slice(0, 10)} value={f.measuredOn} onChange={(e) => setF({ ...f, measuredOn: e.target.value })} /></Field>
    </div>
    <div className="mt-3"><ErrorNote error={err} /></div>
    <div className="mt-4 flex justify-end"><Button disabled={f.value === ''} onClick={save}>{t('save')}</Button></div>
  </Dialog>;
}

// ---------------------------------------------------------------- Demographics, custom fields, notes

export function Demographics({ p }: { p: any }) {
  const { t, lang } = useI18n();
  const rows: [string, string, ReactNode][] = [
    ['◷', 'dateOfBirth', p.date_of_birth && fmtDate(p.date_of_birth, lang)], ['☎', 'phone', p.phone], ['✆', 'whatsapp', p.whatsapp_number], ['✉', 'email', p.email],
    ['⌂', 'address', p.address], ['▤', 'civilRegistry', p.civil_registry], ['⛨', 'nssfNumber', p.nssf_number], ['#', 'nationalId', p.national_id],
    ['☏', 'emergencyContact', p.emergency_contact && `${p.emergency_contact.name}${p.emergency_contact.relation ? ` (${p.emergency_contact.relation})` : ''} · ${p.emergency_contact.phone}`],
    ['A', 'language', p.preferred_language?.toUpperCase()], ...(p.blood_type ? [['♥', 'bloodType', p.blood_type] as [string, string, ReactNode]] : []),
  ];
  return <Card title={t('demographics')}>
    <dl className="grid gap-3 sm:grid-cols-2">{rows.map(([icon, k, v]) => <div key={k} className="flex items-start gap-3">
      <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-brand-soft text-brand">{icon}</span>
      <div className="min-w-0"><dt className="text-[11px] font-semibold uppercase tracking-wide text-muted">{t(k)}</dt><dd className="break-words text-sm">{v || '—'}</dd></div></div>)}</dl>
  </Card>;
}

export function CustomFields({ p, onSaved }: { p: any; onSaved: (np: any) => void }) {
  const { t } = useI18n(); const { can } = useWorkspace();
  const [rows, setRows] = useState<{ label: string; value: string }[]>(p.custom_fields ?? []); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  useEffect(() => setRows(p.custom_fields ?? []), [p.custom_fields]);
  const editable = can('patient.register');
  const dirty = JSON.stringify(rows) !== JSON.stringify(p.custom_fields ?? []);
  const save = async () => { setBusy(true); setErr(null); try { onSaved(await patch(`/patients/${p.id}`, { customFields: rows.filter((r) => r.label.trim() && r.value.trim()) })); } catch (e) { setErr(e); } finally { setBusy(false); } };
  return <Card title={t('customFields')} actions={editable && rows.length < 30 && <Button size="sm" variant="ghost" onClick={() => setRows([...rows, { label: '', value: '' }])}>+ {t('addField')}</Button>}>
    {rows.length === 0 ? <p className="text-sm text-muted">{t('customFieldsHint')}</p> :
      <div className="space-y-2">{rows.map((r, i) => <div key={i} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-2">
        <Input aria-label={t('fieldName')} placeholder={t('fieldName')} value={r.label} disabled={!editable} onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} />
        <Input aria-label={t('value')} placeholder={t('value')} value={r.value} disabled={!editable} onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} />
        {editable ? <Button size="sm" variant="ghost" aria-label={t('remove')} onClick={() => setRows(rows.filter((_, j) => j !== i))}>✕</Button> : <span />}</div>)}</div>}
    <div className="mt-2"><ErrorNote error={err} /></div>
    {editable && dirty && <div className="mt-3 flex justify-end"><Button busy={busy} onClick={save}>{t('save')}</Button></div>}
  </Card>;
}

export function FrontDeskNotes({ p, onSaved }: { p: any; onSaved: (np: any) => void }) {
  const { t } = useI18n(); const { can } = useWorkspace();
  const [v, setV] = useState(p.admin_notes ?? ''); const [editing, setEditing] = useState(false); const [err, setErr] = useState<unknown>(null);
  useEffect(() => setV(p.admin_notes ?? ''), [p.admin_notes]);
  const save = async () => { try { onSaved(await patch(`/patients/${p.id}`, { adminNotes: v.trim() || null })); setEditing(false); } catch (e) { setErr(e); } };
  return <Card title={t('frontDeskNotes')} actions={can('patient.register') && !editing && <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>{t('edit')}</Button>}>
    {editing ? <><Textarea rows={4} value={v} onChange={(e) => setV(e.target.value)} /><p className="mt-1 text-xs text-muted">{t('adminNotesHint')}</p>
      <ErrorNote error={err} /><div className="mt-2 flex justify-end gap-2"><Button variant="ghost" onClick={() => { setV(p.admin_notes ?? ''); setEditing(false); }}>{t('cancel')}</Button><Button onClick={save}>{t('save')}</Button></div></>
      : <p className="whitespace-pre-wrap text-sm">{p.admin_notes || <span className="text-muted">{t('noneRecorded')}</span>}</p>}
  </Card>;
}

// ---------------------------------------------------------------- Session packages

export function Packages({ patientId }: { patientId: string }) {
  const { t, lang } = useI18n(); const { can } = useWorkspace();
  const { data, reload } = useLoad<any[]>(`/patients/${patientId}/packages`);
  const [open, setOpen] = useState(false); const [err, setErr] = useState<unknown>(null);
  const act = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); reload(); } catch (e) { setErr(e); } };
  const manage = can('appointment.manage');
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm text-muted">{t('packagesHint')}</p>
      {(manage || can('payment.register')) && <Button onClick={() => setOpen(true)}>+ {t('newPackage')}</Button>}</div>
    <ErrorNote error={err} />
    {!data ? <p className="text-muted">{t('loading')}</p> : data.length === 0 ? <Empty>{t('noPackages')}</Empty> :
      <div className="grid gap-4 lg:grid-cols-2">{data.map((p) => {
        const left = p.total_sessions - p.used; const pct = Math.round((p.used / p.total_sessions) * 100);
        const live = p.sessions.filter((s: any) => !s.voided_at);
        return <Card key={p.id} title={p.name} actions={p.closed_at ? <Badge status="closed">{t('closed')}</Badge> : left === 0 ? <Badge status="completed">{t('allUsed')}</Badge> : <Badge status="active">{left} {t('sessionsLeft')}</Badge>}>
          <div className="mb-2 h-2.5 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={p.used} aria-valuemin={0} aria-valuemax={p.total_sessions}>
            <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} /></div>
          <p className="text-sm tabular">{p.used} / {p.total_sessions} {t('sessionsUsed')}{p.price !== null ? ` · ${fmtMoney(p.price, p.currency, lang)}` : ''}{p.expires_on ? ` · ${t('expires')} ${fmtDate(p.expires_on, lang)}` : ''}</p>
          {p.note && <p className="mt-1 text-xs text-muted">{p.note}</p>}
          {live.length > 0 && <ol className="mt-3 space-y-1 text-xs">{live.map((s: any, i: number) => <li key={s.id} className="flex items-center justify-between gap-2">
            <span className="tabular">#{i + 1} · {fmtDate(s.used_at, lang)} {fmtTime(s.used_at, lang)} · {s.recorded_by}{s.note ? ` · ${s.note}` : ''}</span>
            {manage && !p.closed_at && i === live.length - 1 && <button className="text-danger hover:underline" onClick={() => act(() => post(`/package-sessions/${s.id}/void`))}>{t('undo')}</button>}</li>)}</ol>}
          {manage && !p.closed_at && <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => act(() => post(`/packages/${p.id}/close`))}>{t('closePackage')}</Button>
            <Button size="sm" disabled={left === 0} onClick={() => act(() => post(`/packages/${p.id}/sessions`, {}))}>{t('useSession')}</Button></div>}
        </Card>;
      })}</div>}
    <PackageDialog open={open} patientId={patientId} onClose={() => setOpen(false)} onDone={() => { setOpen(false); reload(); }} />
  </div>;
}

function PackageDialog({ open, patientId, onClose, onDone }: { open: boolean; patientId: string; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const [f, setF] = useState({ name: '', totalSessions: '10', price: '', currency: 'USD', expiresOn: '', note: '' }); const [err, setErr] = useState<unknown>(null);
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  const save = async () => { try { await post(`/patients/${patientId}/packages`, { name: f.name, totalSessions: Number(f.totalSessions), price: f.price === '' ? null : Number(f.price), currency: f.currency, expiresOn: f.expiresOn || null, note: f.note || null }); setF({ ...f, name: '', price: '', note: '' }); onDone(); } catch (e) { setErr(e); } };
  return <Dialog open={open} onClose={onClose} title={t('newPackage')}>
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={t('packageName')} className="sm:col-span-2"><Input value={f.name} onChange={set('name')} placeholder={t('packageNameExample')} /></Field>
      <Field label={t('numberOfSessions')}><Input type="number" min={1} max={200} value={f.totalSessions} onChange={set('totalSessions')} /></Field>
      <Field label={t('expires')}><Input type="date" value={f.expiresOn} onChange={set('expiresOn')} /></Field>
      <Field label={t('price')}><Input type="number" min={0} step="any" value={f.price} onChange={set('price')} /></Field>
      <Field label={t('currency')}><Select value={f.currency} onChange={set('currency')}><option>USD</option><option>LBP</option></Select></Field>
      <Field label={t('note')} className="sm:col-span-2"><Input value={f.note} onChange={set('note')} /></Field>
    </div>
    <p className="mt-2 text-xs text-muted">{t('packageBillingNote')}</p>
    <div className="mt-3"><ErrorNote error={err} /></div>
    <div className="mt-4 flex justify-end"><Button disabled={!f.name.trim() || !Number(f.totalSessions)} onClick={save}>{t('save')}</Button></div>
  </Dialog>;
}

// ---------------------------------------------------------------- Protected images

function useImage(docId: string | null | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!docId) { setUrl(null); return; }
    let u: string | null = null; let live = true;
    fileBlobUrl(`/documents/${docId}/content`).then((x) => { if (live) { u = x; setUrl(x); } else URL.revokeObjectURL(x); }).catch(() => setUrl(null));
    return () => { live = false; if (u) URL.revokeObjectURL(u); };
  }, [docId]);
  return url;
}
function Photo({ docId, alt, className }: { docId: string | null | undefined; alt: string; className?: string }) {
  const url = useImage(docId);
  return url ? <img src={url} alt={alt} className={cx('rounded-[10px] object-cover', className)} /> : <div className={cx('flex items-center justify-center rounded-[10px] bg-surface text-xs text-muted', className)}>{docId ? '…' : '—'}</div>;
}
async function uploadPhoto(patientId: string, file: File, title: string) {
  const q = new URLSearchParams({ kind: 'photo', title, filename: file.name });
  return uploadFile<{ id: string }>(`/patients/${patientId}/documents?${q}`, file);
}
function PhotoPicker({ label, file, onFile }: { label: string; file: File | null; onFile: (f: File | null) => void }) {
  return <label className="flex cursor-pointer items-center gap-2 rounded-[10px] border border-dashed border-line px-3 py-2 text-sm hover:bg-surface">
    <span aria-hidden>📷</span><span className="truncate">{file ? file.name : label}</span>
    <input type="file" accept="image/jpeg,image/png,image/webp,image/heic" className="sr-only" onChange={(e) => onFile(e.target.files?.[0] ?? null)} /></label>;
}

// ---------------------------------------------------------------- Body map

/** Which part of the drawing a point falls in. x and y are percentages of the drawing; the patient faces the viewer on the front view. */
function regionAt(side: 'front' | 'back', x: number, y: number, t: (k: string) => string) {
  const patientLeft = side === 'front' ? x > 50 : x < 50;
  const lr = (k: string) => `${t(k)} (${t(patientLeft ? 'left' : 'right')})`;
  if (y < 13) return t(side === 'front' ? 'rFace' : 'rScalp');
  if (y < 17) return t('rNeck');
  if ((x < 30 || x > 70) && y < 52) return lr(y < 30 ? 'rUpperArm' : y < 40 ? 'rForearm' : 'rHand');
  if (y < 34) return t(side === 'front' ? 'rChest' : 'rUpperBack');
  if (y < 48) return t(side === 'front' ? 'rAbdomen' : 'rLowerBack');
  if (y < 55) return t(side === 'front' ? 'rPelvis' : 'rButtocks');
  if (y < 74) return lr('rThigh');
  if (y < 78) return lr('rKnee');
  if (y < 94) return lr('rLeg');
  return lr('rFoot');
}

function BodyFigure({ side, marks, draft, onPick, onSelect, selected }: { side: 'front' | 'back'; marks: any[]; draft: { x: number; y: number } | null; onPick?: (x: number, y: number) => void; onSelect: (id: string) => void; selected: string | null }) {
  const W = 200, H = 440;
  const click = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!onPick) return;
    const r = e.currentTarget.getBoundingClientRect();
    onPick(Math.round(((e.clientX - r.left) / r.width) * 1000) / 10, Math.round(((e.clientY - r.top) / r.height) * 1000) / 10);
  };
  const shape = { fill: 'var(--surface)', stroke: 'var(--muted)', strokeWidth: 1.5, opacity: 0.9 };
  return <svg viewBox={`0 0 ${W} ${H}`} className={cx('mx-auto block w-full max-w-[260px] select-none', onPick && 'cursor-crosshair')} onClick={click} role="img" aria-label={side}>
    <circle cx="100" cy="30" r="24" {...shape} />
    <rect x="88" y="52" width="24" height="18" rx="6" {...shape} />
    <path d="M58 72 Q100 64 142 72 L146 150 Q140 210 136 236 L64 236 Q60 210 54 150 Z" {...shape} />
    <rect x="30" y="74" width="24" height="96" rx="12" {...shape} /><rect x="146" y="74" width="24" height="96" rx="12" {...shape} />
    <rect x="26" y="172" width="24" height="54" rx="12" {...shape} /><rect x="150" y="172" width="24" height="54" rx="12" {...shape} />
    <rect x="66" y="238" width="30" height="110" rx="14" {...shape} /><rect x="104" y="238" width="30" height="110" rx="14" {...shape} />
    <rect x="68" y="350" width="26" height="72" rx="12" {...shape} /><rect x="106" y="350" width="26" height="72" rx="12" {...shape} />
    <ellipse cx="78" cy="428" rx="16" ry="8" {...shape} /><ellipse cx="122" cy="428" rx="16" ry="8" {...shape} />
    {side === 'back' && <line x1="100" y1="76" x2="100" y2="232" stroke="var(--muted)" strokeDasharray="3 4" opacity="0.6" />}
    {marks.filter((m) => m.side === side).map((m, i) => <g key={m.id} onClick={(e) => { e.stopPropagation(); onSelect(m.id); }} className="cursor-pointer">
      <circle cx={(m.x / 100) * W} cy={(m.y / 100) * H} r={selected === m.id ? 9 : 7} fill="var(--brand)" stroke="var(--card)" strokeWidth="2" />
      <text x={(m.x / 100) * W} y={(m.y / 100) * H + 3.5} textAnchor="middle" fontSize="9" fill="#fff" fontWeight="700">{i + 1}</text></g>)}
    {draft && <circle cx={(draft.x / 100) * W} cy={(draft.y / 100) * H} r="7" fill="var(--accent)" stroke="var(--card)" strokeWidth="2" />}
  </svg>;
}

export function BodyMap({ patientId }: { patientId: string }) {
  const { t, lang } = useI18n(); const { can } = useWorkspace();
  const { data, reload } = useLoad<any[]>(`/patients/${patientId}/body-marks`);
  const [side, setSide] = useState<'front' | 'back'>('front'); const [draft, setDraft] = useState<{ x: number; y: number } | null>(null);
  const [f, setF] = useState({ region: '', note: '' }); const [file, setFile] = useState<File | null>(null); const [sel, setSel] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const canPhoto = can('document.upload');
  const marks = data ?? [];
  const pick = (x: number, y: number) => { setDraft({ x, y }); setSel(null); setF({ region: regionAt(side, x, y, t), note: '' }); setFile(null); setErr(null); };
  const save = async () => {
    if (!draft) return; setBusy(true); setErr(null);
    try {
      const photo = file ? await uploadPhoto(patientId, file, `${t('bodyDiagram')}: ${f.region}`) : null;
      await post(`/patients/${patientId}/body-marks`, { side, x: draft.x, y: draft.y, region: f.region, note: f.note || null, photoDocumentId: photo?.id ?? null });
      setDraft(null); reload();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const shown = marks.filter((m) => m.side === side); const current = marks.find((m) => m.id === sel);
  return <Card title={t('bodyDiagram')} actions={<div className="inline-flex rounded-full border border-line p-0.5 text-sm">{(['front', 'back'] as const).map((s) =>
    <button key={s} onClick={() => { setSide(s); setDraft(null); setSel(null); }} className={cx('rounded-full px-3 py-1', side === s ? 'bg-brand text-white' : 'text-muted')}>{t(s === 'front' ? 'sideFront' : 'sideBack')}</button>)}</div>}>
    <p className="mb-2 text-xs text-muted">{t('bodyDiagramHint')}</p>
    <div className="grid gap-4 md:grid-cols-[minmax(0,260px)_1fr]">
      <BodyFigure side={side} marks={marks} draft={draft} onPick={pick} onSelect={(id) => { setSel(id); setDraft(null); }} selected={sel} />
      <div className="min-w-0 space-y-3">
        {draft ? <div className="space-y-2 rounded-[10px] border border-line p-3">
          <div className="flex items-center justify-between"><p className="text-xs font-semibold uppercase tracking-wide text-muted">{t('newMarker')}</p><button aria-label={t('cancel')} onClick={() => setDraft(null)}>✕</button></div>
          <Field label={t('region')}><Input value={f.region} onChange={(e) => setF({ ...f, region: e.target.value })} /></Field>
          <Field label={t('note')}><Textarea value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder={t('markerNotePlaceholder')} /></Field>
          {canPhoto && <PhotoPicker label={t('addPhoto')} file={file} onFile={setFile} />}
          <ErrorNote error={err} />
          <div className="flex justify-end"><Button busy={busy} disabled={!f.region.trim()} onClick={save}>{t('save')}</Button></div>
        </div> : current ? <div className="space-y-2 rounded-[10px] border border-line p-3">
          <div className="flex items-center justify-between gap-2"><p className="font-medium">{current.region}</p><button aria-label={t('close')} onClick={() => setSel(null)}>✕</button></div>
          {current.note && <p className="whitespace-pre-wrap text-sm">{current.note}</p>}
          {current.photo_document_id && <Photo docId={current.photo_document_id} alt={current.region} className="h-48 w-full" />}
          <p className="text-xs text-muted">{fmtDate(current.recorded_at, lang)} · {current.recorded_by}</p>
          <div className="flex justify-end"><Button size="sm" variant="ghost" onClick={async () => { await del(`/body-marks/${current.id}`); setSel(null); reload(); }}>{t('remove')}</Button></div>
        </div> : null}
        {shown.length === 0 && !draft ? <p className="text-sm text-muted">{t('noMarkers')}</p> :
          <ol className="space-y-1 text-sm">{shown.map((m, i) => <li key={m.id}><button className={cx('w-full rounded-md px-2 py-1 text-start hover:bg-surface', sel === m.id && 'bg-brand-soft')} onClick={() => { setSel(m.id); setDraft(null); }}>
            <span className="me-2 inline-flex size-5 items-center justify-center rounded-full bg-brand text-[10px] font-bold text-white">{i + 1}</span>{m.region}
            {m.photo_document_id && <span aria-label={t('photo')} className="ms-1">📷</span>}<span className="ms-2 text-xs text-muted">{fmtDate(m.recorded_at, lang)}</span></button></li>)}</ol>}
      </div>
    </div>
  </Card>;
}

// ---------------------------------------------------------------- Odontogram

const TOOTH_TONE: Record<string, string> = {
  healthy: 'border-success/50 bg-success/10', caries: 'border-danger bg-danger/15 text-danger', filling: 'border-info bg-info/15 text-info', crown: 'border-warning bg-warning/15',
  root_canal: 'border-accent bg-accent/20', missing: 'border-dashed border-muted bg-transparent text-muted line-through', implant: 'border-brand bg-brand/15 text-brand',
  bridge: 'border-brand bg-brand-soft', extraction_planned: 'border-danger border-dashed text-danger', fracture: 'border-danger bg-danger/10', sensitive: 'border-warning', other: 'border-ink/40',
};

export function Odontogram({ patientId }: { patientId: string }) {
  const { t, lang } = useI18n();
  const { data, reload } = useLoad<any[]>(`/patients/${patientId}/teeth`);
  const [set, setSet] = useState<'permanent' | 'primary'>('permanent'); const [tooth, setTooth] = useState<number | null>(null);
  const latest = useMemo(() => { const m = new Map<number, any>(); for (const r of data ?? []) if (!m.has(r.tooth)) m.set(r.tooth, r); return m; }, [data]);
  const layout = set === 'permanent' ? PERMANENT_TEETH : PRIMARY_TEETH;
  const used = [...new Set([...latest.values()].map((r) => r.condition))];
  const row = (teeth: number[]) => <div className="flex min-w-max gap-1">{teeth.map((n, i) => {
    const r = latest.get(n);
    return <button key={n} onClick={() => setTooth(n)} title={r ? `${n}: ${t(`tooth_${r.condition}`)}${r.surfaces ? ` (${r.surfaces})` : ''}` : String(n)}
      className={cx('flex h-11 w-9 flex-col items-center justify-center rounded-[8px] border text-xs tabular hover:ring-2 hover:ring-brand/40', r ? TOOTH_TONE[r.condition] : 'border-line bg-card', i === teeth.length / 2 && 'ms-2')}>
      <span className="font-semibold">{n}</span>{r?.surfaces && <span className="text-[9px] leading-none">{r.surfaces}</span>}</button>;
  })}</div>;
  return <Card title={t('odontogram')} actions={<div className="w-40"><Select value={set} onChange={(e) => setSet(e.target.value as any)}><option value="permanent">{t('permanentTeeth')}</option><option value="primary">{t('primaryTeeth')}</option></Select></div>}>
    <p className="mb-3 text-xs text-muted">{t('odontogramHint')}</p>
    <div className="overflow-x-auto pb-1"><div className="space-y-1.5">{row(layout.upper)}<div className="border-t border-dashed border-line" />{row(layout.lower)}</div></div>
    {used.length > 0 && <div className="mt-3 flex flex-wrap gap-2 text-xs">{used.map((c) => <span key={c} className={cx('rounded-full border px-2 py-0.5', TOOTH_TONE[c])}>{t(`tooth_${c}`)}</span>)}</div>}
    {tooth !== null && <ToothDialog patientId={patientId} tooth={tooth} history={(data ?? []).filter((r) => r.tooth === tooth)} lang={lang} onClose={() => setTooth(null)} onDone={() => { reload(); }} />}
  </Card>;
}

function ToothDialog({ patientId, tooth, history, lang, onClose, onDone }: { patientId: string; tooth: number; history: any[]; lang: string; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const [f, setF] = useState({ condition: 'caries', surfaces: '', note: '' }); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); setErr(null); try { await post(`/patients/${patientId}/teeth`, { tooth, condition: f.condition, surfaces: f.surfaces || null, note: f.note || null }); setF({ ...f, surfaces: '', note: '' }); onDone(); } catch (e) { setErr(e); } finally { setBusy(false); } };
  return <Dialog open onClose={onClose} title={`${t('tooth')} ${tooth}`}>
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={t('condition')}><Select value={f.condition} onChange={(e) => setF({ ...f, condition: e.target.value })}>{TOOTH_CONDITIONS.map((c) => <option key={c} value={c}>{t(`tooth_${c}`)}</option>)}</Select></Field>
      <Field label={t('surfaces')} hint="M O D B L I P"><Input value={f.surfaces} maxLength={5} onChange={(e) => setF({ ...f, surfaces: e.target.value.toUpperCase().replace(/[^MODBLIP]/g, '') })} /></Field>
      <Field label={t('note')} className="sm:col-span-2"><Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
    </div>
    <div className="mt-3"><ErrorNote error={err} /></div>
    <div className="mt-3 flex justify-end"><Button busy={busy} onClick={save}>{t('addRecord')}</Button></div>
    <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted">{t('toothHistory')}</h3>
    {history.length === 0 ? <p className="text-sm text-muted">{t('noneRecorded')}</p> :
      <ul className="mt-1 divide-y divide-line text-sm">{history.map((r) => <li key={r.id} className="py-1.5"><span className="font-medium">{t(`tooth_${r.condition}`)}</span>{r.surfaces ? ` · ${r.surfaces}` : ''}{r.note ? ` · ${r.note}` : ''}
        <span className="block text-xs text-muted">{fmtDate(r.recorded_at, lang)} · {r.recorded_by}</span></li>)}</ul>}
  </Dialog>;
}

// ---------------------------------------------------------------- Before / after photos

export function PhotoPairs({ patientId }: { patientId: string }) {
  const { t, lang } = useI18n(); const { can } = useWorkspace();
  const { data, reload } = useLoad<any[]>(`/patients/${patientId}/photo-pairs`);
  const [open, setOpen] = useState(false); const [err, setErr] = useState<unknown>(null);
  const addAfter = async (pp: any, file: File | null) => {
    if (!file) return; setErr(null);
    try { const d = await uploadPhoto(patientId, file, `${pp.title}: ${t('after')}`); await patch(`/photo-pairs/${pp.id}`, { afterDocumentId: d.id }); reload(); } catch (e) { setErr(e); }
  };
  return <Card title={t('beforeAfter')} actions={can('document.upload') && <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>+ {t('newComparison')}</Button>}>
    <p className="mb-3 text-xs text-muted">{t('beforeAfterHint')}</p>
    <ErrorNote error={err} />
    {!data ? <p className="text-sm text-muted">{t('loading')}</p> : data.length === 0 ? <p className="text-sm text-muted">{t('noComparisons')}</p> :
      <div className="space-y-4">{data.map((pp) => <div key={pp.id} className="rounded-[10px] border border-line p-3">
        <div className="mb-2 flex items-center justify-between gap-2"><p className="font-medium">{pp.title}</p>
          <button className="text-xs text-danger hover:underline" onClick={async () => { await del(`/photo-pairs/${pp.id}`); reload(); }}>{t('remove')}</button></div>
        <div className="grid grid-cols-2 gap-2">
          <figure><Photo docId={pp.before_document_id} alt={`${pp.title} ${t('before')}`} className="aspect-[4/3] w-full" /><figcaption className="mt-1 text-xs text-muted">{t('before')} · {fmtDate(pp.before_at, lang)}</figcaption></figure>
          <figure>{pp.after_document_id ? <><Photo docId={pp.after_document_id} alt={`${pp.title} ${t('after')}`} className="aspect-[4/3] w-full" /><figcaption className="mt-1 text-xs text-muted">{t('after')} · {fmtDate(pp.after_at, lang)}</figcaption></>
            : can('document.upload') ? <PhotoPicker label={t('addAfterPhoto')} file={null} onFile={(f) => addAfter(pp, f)} /> : <div className="flex aspect-[4/3] items-center justify-center rounded-[10px] bg-surface text-xs text-muted">{t('after')}: —</div>}</figure>
        </div>
        {pp.note && <p className="mt-2 text-sm">{pp.note}</p>}
      </div>)}</div>}
    <PairDialog open={open} patientId={patientId} onClose={() => setOpen(false)} onDone={() => { setOpen(false); reload(); }} />
  </Card>;
}

function PairDialog({ open, patientId, onClose, onDone }: { open: boolean; patientId: string; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const [title, setTitle] = useState(''); const [note, setNote] = useState(''); const [before, setBefore] = useState<File | null>(null); const [after, setAfter] = useState<File | null>(null);
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!before) return; setBusy(true); setErr(null);
    try {
      const b = await uploadPhoto(patientId, before, `${title}: ${t('before')}`);
      const a = after ? await uploadPhoto(patientId, after, `${title}: ${t('after')}`) : null;
      await post(`/patients/${patientId}/photo-pairs`, { title, beforeDocumentId: b.id, afterDocumentId: a?.id ?? null, note: note || null });
      setTitle(''); setNote(''); setBefore(null); setAfter(null); onDone();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return <Dialog open={open} onClose={onClose} title={t('newComparison')}>
    <div className="space-y-3">
      <Field label={t('title')}><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('comparisonExample')} /></Field>
      <div className="grid gap-2 sm:grid-cols-2"><PhotoPicker label={t('beforePhoto')} file={before} onFile={setBefore} /><PhotoPicker label={`${t('afterPhoto')} (${t('optional')})`} file={after} onFile={setAfter} /></div>
      <Field label={t('note')}><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <p className="text-xs text-muted">{t('photosStoredNote')}</p>
      <ErrorNote error={err} />
      <div className="flex justify-end"><Button busy={busy} disabled={!title.trim() || !before} onClick={save}>{t('save')}</Button></div>
    </div>
  </Dialog>;
}

// ---------------------------------------------------------------- Data-handling consents

export function DataConsents({ patientId, patientName }: { patientId: string; patientName: string }) {
  const { t, lang } = useI18n(); const { can, orgId } = useWorkspace();
  const { data, reload } = useLoad<any>(`/patients/${patientId}/data-consents`);
  const [ask, setAsk] = useState<{ purpose: string; granted: boolean } | null>(null);
  const editable = can('patient.register');
  return <div className="space-y-4">
    <Card title={t('dataConsents')} actions={<Link href={`/print/consent-form?org=${orgId}&patient=${patientId}`} target="_blank" rel="noopener" className="text-sm text-brand hover:underline">⎙ {t('printConsentForm')}</Link>}>
      <p className="mb-4 text-sm text-muted">{t('dataConsentsIntro')}</p>
      {!data ? <p className="text-muted">{t('loading')}</p> : <ul className="space-y-3">{data.current.map((c: any) => <li key={c.purpose} className="flex flex-wrap items-start justify-between gap-3 rounded-[10px] border border-line p-3">
        <div className="min-w-0 flex-1"><p className="font-medium">{t(`consent_${c.purpose}`)}</p><p className="text-sm text-muted">{t(`consentDesc_${c.purpose}`)}</p>
          {c.granted !== null && <p className="mt-1 text-xs text-muted">{t(c.granted ? 'grantedOn' : 'refusedOn')} {fmtDate(c.recorded_at, lang)} · {t('by')} {c.given_by}{c.detail ? ` · ${c.detail}` : ''} · {t('recordedBy')} {c.recorded_by}</p>}</div>
        <div className="flex items-center gap-2">
          <Badge status={c.granted === null ? 'scheduled' : c.granted ? 'approved' : 'rejected'}>{c.granted === null ? t('notAsked') : c.granted ? `✓ ${t('granted')}` : `✕ ${t('notGranted')}`}</Badge>
          {editable && <Button size="sm" variant="ghost" onClick={() => setAsk({ purpose: c.purpose, granted: c.granted !== true })}>{c.granted === null ? t('recordConsent') : t('withdraw')}</Button>}</div>
      </li>)}</ul>}
    </Card>
    {data?.history?.length > 0 && <Card title={t('consentHistory')}><ul className="divide-y divide-line text-sm">{data.history.map((h: any) => <li key={h.id} className="py-1.5">
      <span className="tabular text-muted">{fmtDate(h.recorded_at, lang)} {fmtTime(h.recorded_at, lang)}</span> · {t(`consent_${h.purpose}`)} · <b>{t(h.granted ? 'granted' : 'notGranted')}</b> · {h.given_by}{h.detail ? ` (${h.detail})` : ''} <span className="text-muted">· {h.recorded_by}</span></li>)}</ul></Card>}
    <ConsentDialog ask={ask} patientId={patientId} patientName={patientName} onClose={() => setAsk(null)} onDone={() => { setAsk(null); reload(); }} />
  </div>;
}

function ConsentDialog({ ask, patientId, patientName, onClose, onDone }: { ask: { purpose: string; granted: boolean } | null; patientId: string; patientName: string; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const [granted, setGranted] = useState(true); const [givenBy, setGivenBy] = useState(patientName); const [detail, setDetail] = useState(''); const [err, setErr] = useState<unknown>(null);
  useEffect(() => { if (ask) { setGranted(ask.granted); setGivenBy(patientName); setDetail(''); setErr(null); } }, [ask, patientName]);
  if (!ask) return null;
  const needsDetail = granted && CONSENT_NEEDS_DETAIL.includes(ask.purpose);
  const save = async () => { try { await post(`/patients/${patientId}/data-consents`, { purpose: ask.purpose, granted, givenBy, detail: detail || null }); onDone(); } catch (e) { setErr(e); } };
  return <Dialog open onClose={onClose} title={t(`consent_${ask.purpose}`)}>
    <p className="mb-3 text-sm text-muted">{t(`consentDesc_${ask.purpose}`)}</p>
    <div className="grid gap-3">
      <Field label={t('answer')}><Select value={granted ? 'yes' : 'no'} onChange={(e) => setGranted(e.target.value === 'yes')}><option value="yes">{t('granted')}</option><option value="no">{t('notGranted')}</option></Select></Field>
      <Field label={t('givenBy')} hint={t('givenByHint')}><Input value={givenBy} onChange={(e) => setGivenBy(e.target.value)} /></Field>
      {(needsDetail || detail) && <Field label={t(ask.purpose === 'diaspora_payer' ? 'payerName' : 'proxyName')}><Input value={detail} onChange={(e) => setDetail(e.target.value)} /></Field>}
    </div>
    <p className="mt-3 text-xs text-muted">{t('consentRecordNote')}</p>
    <div className="mt-3"><ErrorNote error={err} /></div>
    <div className="mt-4 flex justify-end"><Button disabled={givenBy.trim().length < 2 || (needsDetail && !detail.trim())} onClick={save}>{t('save')}</Button></div>
  </Dialog>;
}

export { CONSENT_PURPOSES };
