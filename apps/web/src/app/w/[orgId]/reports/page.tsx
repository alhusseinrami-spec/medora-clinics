'use client';
import { useState } from 'react';
import { Button, Card, Empty, ErrorNote, Field, Input, Select, Stat, Tabs, fmtMoney } from '@/components/ui';
import { Forbidden, PageTitle } from '@/components/Shell';
import { useI18n } from '@/lib/i18n';
import { useWorkspace } from '@/lib/workspace';
import { useLoad, useDoctors } from '@/lib/hooks';

const iso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
function preset(p: string): [string, string] {
  const now = new Date(); const s = new Date(now); let e = new Date(now);
  if (p === 'week') s.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  if (p === 'month') s.setDate(1);
  if (p === 'lastMonth') { s.setMonth(now.getMonth() - 1, 1); e = new Date(now.getFullYear(), now.getMonth(), 0); }
  if (p === 'year') s.setMonth(0, 1);
  return [iso(s), iso(e)];
}

/** Activity report (appointments, no-shows, new patients, visits, services, diagnoses) with money figures for those who may see them. Exports to Excel and prints to PDF. */
export default function Reports() {
  const { t, lang, status } = useI18n(); const { can, org, feature } = useWorkspace(); const doctors = useDoctors();
  const [p, setP] = useState('month'); const [[from, to], setRange] = useState(() => preset('month')); const [doctor, setDoctor] = useState('');
  const { data: r, error } = useLoad<any>(`/reports/activity?from=${from}&to=${to}${doctor ? `&doctor=${doctor}` : ''}`, [from, to, doctor]);
  const money = can('finance.view') && feature('finance');
  const fin = useLoad<any>(money && !doctor ? `/finance/summary?from=${from}&to=${to}` : null, [from, to, money, doctor]);
  if (!can('report.view')) return <Forbidden />;
  const $ = (n: any) => fmtMoney(n, 'USD', lang);
  const svc = (s: string) => s === 'walk_in' ? t('walkIn') : s;
  const f = money && !doctor ? fin.data : null;

  const exportExcel = () => {
    if (!r) return;
    const rows: (string | number)[][] = [[org.organization.name], [t('reports'), `${from} – ${to}`], []];
    const tt = r.totals;
    rows.push([t('summary')], [t('booked'), tt.booked], [t('completedVisits'), tt.completed], [status('no_show'), tt.no_show], [status('cancelled'), tt.cancelled],
      [t('walkIn'), tt.walk_in], [t('newInPeriod'), tt.new_patients], [t('patientsSeen'), tt.patients_seen], [t('noShowRate'), `${tt.no_show_rate}%`], []);
    if (f) rows.push([t('finance'), 'USD'], [t('invoiced'), f.invoiced - f.credited], [t('received'), f.received.total], [t('outstanding'), f.outstanding.amount], [t('expenses'), f.expenses.total], [t('net'), f.net], []);
    rows.push([t('byDoctor')], [t('doctor'), t('booked'), t('completedVisits'), status('no_show'), status('cancelled'), t('walkIn')],
      ...r.byDoctor.map((d: any) => [d.doctor_name, d.booked, d.completed, d.no_show, d.cancelled, d.walk_in]), []);
    if (f?.byDoctor?.length) rows.push([t('revenueByDoctor'), 'USD'], [t('doctor'), t('invoiced'), t('collected'), t('doctorShare'), t('centerShare')],
      ...f.byDoctor.map((d: any) => [d.doctor_name, d.invoiced, d.collected, d.doctor_share, d.center_share]), []);
    rows.push([t('topServices')], [t('service'), t('booked'), t('completedVisits')], ...r.byService.map((s: any) => [svc(s.service), s.booked, s.completed]), []);
    if (r.diagnoses.length) rows.push([t('topDiagnoses')], [t('code'), t('diagnosis'), t('count')], ...r.diagnoses.map((d: any) => [d.code ?? '', d.description, d.n]), []);
    rows.push([t('byDay')], [t('date'), t('booked'), t('completedVisits'), status('no_show'), status('cancelled')], ...r.byDay.map((d: any) => [d.day, d.booked, d.completed, d.no_show, d.cancelled]));
    const esc = (v: string | number) => { const s = String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    // UTF-8 byte order mark so Excel shows Arabic and French accents correctly.
    const blob = new Blob(['﻿' + rows.map((row) => row.map(esc).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `medora-report-${from}-${to}.csv`; a.click(); URL.revokeObjectURL(a.href);
  };

  return <>
    <PageTitle title={t('reports')} sub={`${from} – ${to}`} actions={<div className="flex gap-2 print:hidden">
      <Button variant="secondary" disabled={!r} onClick={exportExcel}>{t('exportExcel')}</Button>
      <Button variant="secondary" disabled={!r} onClick={() => window.print()}>{t('exportPdf')}</Button></div>} />
    <div className="flex flex-wrap items-end gap-3 print:hidden">
      <Tabs tabs={[{ key: 'week', label: t('thisWeek') }, { key: 'month', label: t('thisMonth') }, { key: 'lastMonth', label: t('lastMonth') }, { key: 'year', label: t('thisYear') }]}
        value={p} onChange={(k) => { setP(k); setRange(preset(k)); }} />
      <Field label={t('windowFrom')}><Input type="date" value={from} max={to} onChange={(e) => { setP(''); setRange([e.target.value, to]); }} /></Field>
      <Field label={t('to')}><Input type="date" value={to} min={from} onChange={(e) => { setP(''); setRange([from, e.target.value]); }} /></Field>
      {doctors.length > 1 && <Field label={t('doctor')}><Select value={doctor} onChange={(e) => setDoctor(e.target.value)} className="!w-52"><option value="">{t('allDoctors')}</option>{doctors.map((d) => <option key={d.id} value={d.id}>{d.full_name}</option>)}</Select></Field>}
    </div>
    <div className="mt-4"><ErrorNote error={error ?? fin.error} /></div>
    {!r ? <p className="mt-4 text-muted">{t('loading')}</p> : <div className="mt-4 space-y-6">
      {r.scope === 'own' && <p className="text-xs text-muted">{t('ownFigures')}</p>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t('booked')} value={r.totals.booked} sub={`${t('walkIn')} ${r.totals.walk_in}`} />
        <Stat label={t('completedVisits')} value={r.totals.completed} tone="accent" sub={`${r.totals.completion_rate}%`} />
        <Stat label={t('noShowRate')} value={`${r.totals.no_show_rate}%`} tone="warning" sub={`${status('no_show')} ${r.totals.no_show} · ${status('cancelled')} ${r.totals.cancelled}`} />
        <Stat label={t('newInPeriod')} value={r.totals.new_patients} tone="info" sub={`${t('patientsSeen')} ${r.totals.patients_seen}`} />
      </div>
      {f && <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t('invoiced')} value={$(f.invoiced - f.credited)} tone="info" />
        <Stat label={t('received')} value={$(f.received.total)} />
        <Stat label={t('outstanding')} value={$(f.outstanding.amount)} tone="warning" />
        <Stat label={t('net')} value={$(f.net)} tone="accent" sub={`${t('expenses')} ${$(f.expenses.total)}`} />
      </div>}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title={t('byDoctor')}>{r.byDoctor.length === 0 ? <Empty>—</Empty> : <Table head={[t('doctor'), t('booked'), t('completedVisits'), status('no_show'), status('cancelled')]}
          rows={r.byDoctor.map((d: any) => [d.doctor_name, d.booked, d.completed, d.no_show, d.cancelled])} />}</Card>
        {f?.byDoctor?.length > 0 && <Card title={t('revenueByDoctor')}><Table head={[t('doctor'), t('invoiced'), t('collected'), t('doctorShare')]}
          rows={f.byDoctor.map((d: any) => [d.doctor_name, $(d.invoiced), $(d.collected), $(d.doctor_share)])} /></Card>}
        <Card title={t('topServices')}>{r.byService.length === 0 ? <Empty>—</Empty> : <Table head={[t('service'), t('booked'), t('completedVisits')]}
          rows={r.byService.map((s: any) => [svc(s.service), s.booked, s.completed])} />}</Card>
        {r.diagnoses.length > 0 && <Card title={t('topDiagnoses')}><Table head={[t('diagnosis'), t('code'), t('count')]}
          rows={r.diagnoses.map((d: any) => [d.description, d.code ?? '', d.n])} /></Card>}
      </div>
      <Card title={t('byDay')}>{r.byDay.length === 0 ? <Empty>—</Empty> : <DayBars days={r.byDay} />}</Card>
    </div>}
  </>;
}

function Table({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return <table className="w-full text-sm"><thead><tr className="border-b border-line text-start text-xs text-muted">{head.map((h, i) => <th key={i} className={i ? 'py-1.5 text-end' : 'py-1.5 text-start'}>{h}</th>)}</tr></thead>
    <tbody>{rows.map((r, n) => <tr key={n} className="border-b border-line/60 last:border-0">{r.map((c, i) => <td key={i} className={i ? 'tabular py-1.5 text-end' : 'py-1.5'}>{c}</td>)}</tr>)}</tbody></table>;
}

/** Appointments per day as simple bars: completed in brand colour, the rest of the booked ones lighter. */
function DayBars({ days }: { days: any[] }) {
  const { lang } = useI18n(); const max = Math.max(1, ...days.map((d) => d.booked));
  return <div className="space-y-1">{days.map((d) => <div key={d.day} className="grid grid-cols-[6rem_1fr_2.5rem] items-center gap-2 text-xs">
    <span className="tabular text-muted">{new Date(`${d.day}T12:00:00Z`).toLocaleDateString(lang === 'ar' ? 'ar-LB' : lang, { weekday: 'short', day: 'numeric', month: 'short' })}</span>
    <div className="flex h-3 overflow-hidden rounded-full bg-surface"><div className="bg-brand" style={{ width: `${(d.completed / max) * 100}%` }} /><div className="bg-brand/30" style={{ width: `${((d.booked - d.completed - d.cancelled) / max) * 100}%` }} /></div>
    <span className="tabular text-end">{d.booked}</span></div>)}</div>;
}
