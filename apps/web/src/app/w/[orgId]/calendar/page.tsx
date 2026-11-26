'use client';
import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';
import { Badge, Button, Card, Dialog, ErrorNote, Field, Input, Select, cx, fmtTime } from '@/components/ui';
import { Forbidden, PageTitle } from '@/components/Shell';
import { AppointmentDialog } from '@/components/AppointmentDialog';
import { ApptActions } from '@/components/ApptActions';
import { get, patch } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useLiveReload, useWorkspace } from '@/lib/workspace';
import { useDoctors, toLocalInput, dayKey } from '@/lib/hooks';

const HOURS = Array.from({ length: 13 }, (_, i) => i + 7); // 07:00 - 19:00
const PX = 56; // px per hour

export default function Calendar() {
  const { t, lang, status } = useI18n(); const { can, orgId, org } = useWorkspace(); const doctors = useDoctors();
  const [view, setView] = useState<'day' | 'week' | 'month'>('day'); const [anchor, setAnchor] = useState(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; });
  const [doctor, setDoctor] = useState(''); const [appts, setAppts] = useState<any[]>([]); const [create, setCreate] = useState<Date | null>(null); const [sel, setSel] = useState<any>(null);
  const days = useMemo(() => {
    if (view === 'day') return [anchor];
    if (view === 'month') {
      // Whole weeks (Monday first) that cover the anchor's month.
      const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1); const s = new Date(first); s.setDate(1 - ((first.getDay() + 6) % 7));
      const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0); const n = Math.ceil((((last.getTime() - s.getTime()) / 86400e3) + 1) / 7) * 7;
      return Array.from({ length: n }, (_, i) => { const d = new Date(s); d.setDate(s.getDate() + i); return d; });
    }
    const s = new Date(anchor); s.setDate(s.getDate() - ((s.getDay() + 6) % 7));
    return Array.from({ length: 7 }, (_, i) => new Date(s.getTime() + i * 86400e3));
  }, [anchor, view]);
  const load = useCallback(() => {
    const from = days[0]; const to = new Date(days[days.length - 1]); to.setDate(to.getDate() + 1);
    get(`/appointments?from=${from.toISOString()}&to=${to.toISOString()}${doctor ? `&doctor=${doctor}` : ''}`).then(setAppts).catch(() => setAppts([]));
  }, [days, doctor]);
  useLiveReload(load);
  if (!can('appointment.manage')) return <Forbidden />;
  const shift = (n: number) => { const d = new Date(anchor); if (view === 'month') { d.setDate(1); d.setMonth(d.getMonth() + n); } else d.setDate(d.getDate() + n * (view === 'day' ? 1 : 7)); setAnchor(d); };
  const title = view === 'month' ? anchor.toLocaleDateString(lang === 'ar' ? 'ar-LB' : lang, { month: 'long', year: 'numeric' }) : view === 'day' ? anchor.toLocaleDateString(lang === 'ar' ? 'ar-LB' : lang, { weekday: 'long', day: 'numeric', month: 'long' })
    : `${days[0].toLocaleDateString(lang, { day: 'numeric', month: 'short' })} – ${days[6].toLocaleDateString(lang, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  return (
    <>
      <PageTitle title={t('calendar')} sub={title} actions={<div className="flex gap-2">
        <a href={`/print/day-sheet?org=${orgId}&date=${dayKey(anchor)}${doctor ? `&doctor=${doctor}` : ''}`} target="_blank" rel="noopener"
          className="inline-flex h-10 items-center rounded-[10px] border border-line px-4 text-sm font-medium hover:bg-surface">{t('printDaySheet')}</a>
        <Button onClick={() => setCreate(new Date(Date.now() + 3600e3))}>{t('newAppointment')}</Button></div>} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => shift(-1)}>{lang === 'ar' ? '→' : '←'} {t('prev')}</Button>
        <Button variant="secondary" size="sm" onClick={() => { const d = new Date(); d.setHours(0, 0, 0, 0); setAnchor(d); }}>{t('today')}</Button>
        <Button variant="secondary" size="sm" onClick={() => shift(1)}>{t('next')} {lang === 'ar' ? '←' : '→'}</Button>
        <div className="ms-auto flex gap-2">
          {doctors.length > 1 && <Select value={doctor} onChange={(e) => setDoctor(e.target.value)} className="!h-8 w-48"><option value="">{t('allDoctors')}</option>{doctors.map((d) => <option key={d.id} value={d.id}>{d.full_name}</option>)}</Select>}
          <div className="flex rounded-[10px] border border-line p-0.5">{(['day', 'week', 'month'] as const).map((v) => <button key={v} onClick={() => setView(v)} className={cx('rounded-lg px-3 py-1 text-sm', view === v ? 'bg-brand text-white' : 'text-muted')}>{t(v)}</button>)}</div>
        </div>
      </div>
      {view === 'month' ? <MonthGrid days={days} month={anchor.getMonth()} appts={appts} onDay={(d) => { setAnchor(d); setView('day'); }} /> :
      <Card className="overflow-x-auto"><div className="flex min-w-[640px]">
        <div className="w-12 shrink-0 pt-8">{HOURS.map((h) => <div key={h} style={{ height: PX }} className="tabular -mt-2 text-end text-[11px] text-muted pe-2">{String(h).padStart(2, '0')}:00</div>)}</div>
        {days.map((d) => {
          const dayAppts = appts.filter((a) => new Date(a.starts_at).toDateString() === d.toDateString());
          const isToday = d.toDateString() === new Date().toDateString();
          return <div key={d.toISOString()} className="min-w-0 flex-1 border-s border-line">
            <div className={cx('h-8 text-center text-xs font-medium', isToday ? 'text-brand' : 'text-muted')}>{d.toLocaleDateString(lang === 'ar' ? 'ar-LB' : lang, { weekday: 'short', day: 'numeric' })}</div>
            <div className="relative" style={{ height: HOURS.length * PX }}>
              {HOURS.map((h) => <button key={h} aria-label={`New appointment ${h}:00`} onClick={() => { const s = new Date(d); s.setHours(h, 0, 0, 0); setCreate(s); }} className="block w-full border-t border-line/70 hover:bg-brand-soft/50" style={{ height: PX }} />)}
              {lanes(dayAppts).map(({ a, lane, of }) => {
                const s = new Date(a.starts_at); const e = new Date(a.ends_at);
                const top = (s.getHours() + s.getMinutes() / 60 - HOURS[0]) * PX; const h = Math.max(((e.getTime() - s.getTime()) / 3600e3) * PX, 22);
                // Appointments that overlap (different doctors at the same time) share the column side by side.
                return <button key={a.id} onClick={() => setSel(a)} style={{ top, height: h, insetInlineStart: `calc(${(lane / of) * 100}% + 2px)`, width: `calc(${100 / of}% - 4px)` }} className={cx('absolute overflow-hidden rounded-md border-s-4 bg-card px-1.5 py-0.5 text-start text-xs shadow-sm ring-1 ring-line',
                  a.status === 'cancelled' || a.status === 'no_show' ? 'border-danger opacity-50' : a.status === 'completed' ? 'border-success' : a.status === 'arrived' || a.status === 'waiting' ? 'border-accent' : a.status === 'in_consultation' ? 'border-brand' : 'border-info')}>
                  <span className="font-semibold">{a.overbook_reason && <span title={`${t('overbooked')}: ${a.overbook_reason}`} className="me-1 text-warning">⚠</span>}{fmtTime(a.starts_at, lang)} {a.patient_name}</span>{h > 30 && <span className="block truncate text-muted">{org.me.orgWide || doctors.length > 1 ? a.doctor_name : a.service_name ?? ''}</span>}
                </button>;
              })}
            </div></div>;
        })}
      </div></Card>}
      <AppointmentDialog open={!!create} start={create ?? undefined} onClose={() => setCreate(null)} onSaved={load} />
      <Dialog open={!!sel} onClose={() => setSel(null)} title={sel?.patient_name ?? ''}>
        {sel && <ApptDetail a={sel} orgId={orgId} onChanged={() => { load(); setSel(null); }} />}
      </Dialog>
    </>
  );
}

function ApptDetail({ a, orgId, onChanged }: { a: any; orgId: string; onChanged: () => void }) {
  const { t, lang, status } = useI18n();
  const [when, setWhen] = useState(toLocalInput(new Date(a.starts_at))); const [mins, setMins] = useState(Math.round((Date.parse(a.ends_at) - Date.parse(a.starts_at)) / 60000));
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const canMove = a.status === 'scheduled' || a.status === 'confirmed';
  const reschedule = async () => { setBusy(true); setErr(null); try { await patch(`/appointments/${a.id}`, { startsAt: new Date(when).toISOString(), durationMinutes: mins }); onChanged(); } catch (e) { setErr(e); } finally { setBusy(false); } };
  return <div className="space-y-4 text-sm">
    <div className="flex items-center justify-between"><span className="tabular">{new Date(a.starts_at).toLocaleDateString(lang)} · {fmtTime(a.starts_at, lang)}–{fmtTime(a.ends_at, lang)}</span><Badge status={a.status}>{status(a.status)}</Badge></div>
    <p className="text-muted">{a.doctor_name}{a.service_name ? ` · ${a.service_name}` : ''}{a.room_name ? ` · ${a.room_name}` : ''}{a.is_walk_in ? ` · ${t('walkIn')}` : ''}</p>
    {a.overbook_reason && <p className="text-sm text-warning">⚠ {t('overbooked')}: {a.overbook_reason}</p>}
    {a.notes && <p>{a.notes}</p>}
    <Link href={`/w/${orgId}/patients/${a.patient_id}`} className="text-brand hover:underline">→ {t('patient')}</Link>
    <ApptActions appt={a} onDone={onChanged} />
    {canMove && <div className="grid grid-cols-[1fr_6rem_auto] items-end gap-2 border-t border-line pt-4">
      <Field label={t('start')}><Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
      <Field label={t('duration')}><Input type="number" min={5} value={mins} onChange={(e) => setMins(Number(e.target.value))} /></Field>
      <Button variant="secondary" busy={busy} onClick={reschedule}>{t('save')}</Button></div>}
    <ErrorNote error={err} />
  </div>;
}

/** Places overlapping appointments in side-by-side lanes. Each group of overlapping appointments gets as many lanes as it needs. */
function lanes(list: any[]) {
  const sorted = [...list].sort((x, y) => +new Date(x.starts_at) - +new Date(y.starts_at));
  const out: { a: any; lane: number; of: number }[] = [];
  let group: { a: any; lane: number; of: number }[] = []; let groupEnd = 0; let laneEnds: number[] = [];
  const flush = () => { const n = Math.max(1, laneEnds.length); for (const g of group) g.of = n; out.push(...group); group = []; laneEnds = []; };
  for (const a of sorted) {
    const s = +new Date(a.starts_at); const e = Math.max(+new Date(a.ends_at), s + 15 * 60e3);
    if (group.length && s >= groupEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= s); if (lane < 0) { lane = laneEnds.length; laneEnds.push(e); } else laneEnds[lane] = e;
    group.push({ a, lane, of: 1 }); groupEnd = Math.max(groupEnd, e);
  }
  flush();
  return out;
}

/** Month view: one cell per day with the number of appointments and the first few names. A click opens that day. */
function MonthGrid({ days, month, appts, onDay }: { days: Date[]; month: number; appts: any[]; onDay: (d: Date) => void }) {
  const { t, lang } = useI18n(); const loc = lang === 'ar' ? 'ar-LB' : lang;
  const byDay = new Map<string, any[]>();
  for (const a of appts) { if (a.status === 'cancelled') continue; const k = new Date(a.starts_at).toDateString(); (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(a); }
  const today = new Date().toDateString();
  return <Card className="overflow-x-auto !p-0"><div className="grid min-w-[640px] grid-cols-7">
    {days.slice(0, 7).map((d) => <div key={d.getDay()} className="border-b border-line py-2 text-center text-xs font-medium text-muted">{d.toLocaleDateString(loc, { weekday: 'short' })}</div>)}
    {days.map((d) => {
      const list = (byDay.get(d.toDateString()) ?? []).sort((x, y) => +new Date(x.starts_at) - +new Date(y.starts_at));
      return <button key={d.toISOString()} onClick={() => onDay(d)} className={cx('min-h-24 border-b border-s border-line p-1.5 text-start align-top hover:bg-brand-soft/40', d.getMonth() !== month && 'bg-surface/60 text-muted')}>
        <div className="flex items-center justify-between text-xs"><span className={cx('tabular', d.toDateString() === today && 'rounded-full bg-brand px-1.5 font-semibold text-white')}>{d.getDate()}</span>
          {list.length > 0 && <span className="rounded-full bg-brand-soft px-1.5 text-[11px] font-medium text-brand" title={t('appointments')}>{list.length}</span>}</div>
        <ul className="mt-1 space-y-0.5 text-[11px]">{list.slice(0, 3).map((a) => <li key={a.id} className="truncate"><span className="tabular text-muted">{fmtTime(a.starts_at, lang)}</span> {a.patient_name}</li>)}
          {list.length > 3 && <li className="text-muted">+{list.length - 3}</li>}</ul>
      </button>;
    })}
  </div></Card>;
}
