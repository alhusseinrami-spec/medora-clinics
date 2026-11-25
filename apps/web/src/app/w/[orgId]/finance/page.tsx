'use client';
import { useState } from 'react';
import { Button, Card, Dialog, Empty, ErrorNote, Field, Input, Select, Stat, Tabs, fmtDate, fmtMoney } from '@/components/ui';
import { Forbidden, PageTitle } from '@/components/Shell';
import { del, post, api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useWorkspace } from '@/lib/workspace';
import { useLoad, useDoctors } from '@/lib/hooks';

const CATEGORIES = ['rent', 'salaries', 'supplies', 'equipment', 'utilities', 'maintenance', 'marketing', 'insurance', 'taxes', 'fees', 'other'];
const iso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
function range(p: string): [string, string] {
  const now = new Date(); const s = new Date(now);
  if (p === 'week') s.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  if (p === 'month') s.setDate(1);
  if (p === 'year') { s.setMonth(0); s.setDate(1); }
  return [iso(s), iso(now)];
}

/** Financial overview: income, collections by method, outstanding, expenses, net, and the doctor/center split. */
export default function Finance() {
  const { t, lang } = useI18n(); const { can, org } = useWorkspace();
  const [period, setPeriod] = useState('month'); const [from, to] = range(period);
  const { data: s, error, reload } = useLoad<any>(`/finance/summary?from=${from}&to=${to}`);
  const expenses = useLoad<any[]>(`/finance/expenses?from=${from}&to=${to}`);
  const [expOpen, setExpOpen] = useState(false);
  if (!can('finance.view')) return <Forbidden />;
  const $ = (n: any) => fmtMoney(n, 'USD', lang);
  const center = org.organization.kind === 'medical_center';
  return <>
    <PageTitle title={t('finance')} actions={<Button variant="secondary" onClick={() => setExpOpen(true)}>+ {t('addExpense')}</Button>} />
    <Tabs tabs={[{ key: 'day', label: t('today') }, { key: 'week', label: t('thisWeek') }, { key: 'month', label: t('thisMonth') }, { key: 'year', label: t('thisYear') }]} value={period} onChange={setPeriod} />
    <ErrorNote error={error} />
    {!s ? <p className="mt-4 text-muted">{t('loading')}</p> : <div className="mt-5 space-y-6">
      <p className="text-xs text-muted">{t('inUsd')} {s.scope === 'own' ? t('ownFigures') : ''}</p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t('received')} value={$(s.received.total)} sub={`${t('fromPatients')} ${$(s.received.patients)} · ${t('fromInsurance')} ${$(s.received.insurance)}`} />
        <Stat label={t('invoiced')} value={$(s.invoiced - s.credited)} tone="info" sub={`${s.invoiceCount} ${t('invoices').toLowerCase()}${s.credited ? ` · ${t('credited')} ${$(s.credited)}` : ''}`} />
        <Stat label={t('outstanding')} value={$(s.outstanding.amount)} tone="warning" sub={`${s.outstanding.invoices} ${t('unpaid').toLowerCase()}`} />
        <Stat label={t('net')} value={$(s.net)} tone="accent" sub={`${t('expenses')} ${$(s.expenses.total)}${s.received.refunds ? ` · ${t('refunds')} ${$(s.received.refunds)}` : ''}`} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title={t('cashDrawer')}>
          <p className="mb-3 text-sm tabular">{fmtMoney(s.received.cashUsd, 'USD', lang)} · {fmtMoney(s.received.cashLbp, 'LBP', lang)}</p>
          {s.received.byMethod.length === 0 ? <p className="text-sm text-muted">—</p> : <ul className="divide-y divide-line text-sm">{s.received.byMethod.map((m: any) =>
            <li key={m.method_code + m.currency} className="flex justify-between py-1.5"><span>{t(m.method_code)}</span><span className="tabular">{fmtMoney(m.amount, m.currency, lang)}</span></li>)}</ul>}
        </Card>
        <Card title={t('invoiced')}>
          <ul className="divide-y divide-line text-sm">{Object.entries(s.revenueByKind).map(([k, v]) =>
            <li key={k} className="flex justify-between py-1.5"><span>{t(`revenue${k[0].toUpperCase()}${k.slice(1)}`)}</span><span className="tabular">{$(v)}</span></li>)}
            {Object.keys(s.revenueByKind).length === 0 && <li className="py-1.5 text-muted">—</li>}</ul>
        </Card>
      </div>
      {(center || s.byDoctor.length > 1) && <Card title={t('byDoctor')}>
        {s.byDoctor.length === 0 ? <p className="text-sm text-muted">—</p> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-xs text-muted">
          <th className="py-1.5 text-start">{t('doctor')}</th><th className="text-end">{t('invoiced')}</th><th className="text-end">{t('collected')}</th><th className="text-end">{t('doctorShare')}</th>
          <th className="text-end">{t('centerShare')}</th><th className="text-end">{t('expenses')}</th></tr></thead>
          <tbody>{s.byDoctor.map((d: any) => <tr key={d.membership_id} className="border-t border-line tabular"><td className="py-1.5">{d.doctor_name}</td><td className="text-end">{$(d.invoiced)}</td>
            <td className="text-end">{$(d.collected)}</td><td className="text-end">{$(d.doctor_share)}</td><td className="text-end">{$(d.center_share)}</td><td className="text-end">{$(d.expenses)}</td></tr>)}</tbody></table></div>}
        {s.center && <p className="mt-3 text-sm tabular">{t('centerShare')} {$(s.center.share)} − {t('sharedExpense')} {$(s.center.sharedExpenses)} = <b>{$(s.center.net)}</b></p>}
      </Card>}
      {s.byDepartment.length > 0 && <Card title={t('byDepartment')}><ul className="divide-y divide-line text-sm">{s.byDepartment.map((d: any) =>
        <li key={d.department} className="flex justify-between py-1.5"><span>{d.department}</span><span className="tabular">{$(d.invoiced)}</span></li>)}</ul></Card>}
      <Card title={t('expenses')}>
        {!expenses.data ? <p className="text-muted">{t('loading')}</p> : expenses.data.length === 0 ? <Empty>{t('noExpenses')}</Empty> :
          <ul className="divide-y divide-line text-sm">{expenses.data.map((e) => <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div><p className="font-medium">{t(e.category)}{e.description ? ` · ${e.description}` : ''}</p>
              <p className="text-xs text-muted tabular">{fmtDate(e.spent_at, lang)} · {e.doctor_name ?? t('sharedExpense')}{e.method_code ? ` · ${t(e.method_code)}` : ''} · {e.created_by_name}</p></div>
            <div className="flex items-center gap-2"><span className="tabular">{fmtMoney(e.amount, e.currency, lang)}</span>
              <Button size="sm" variant="ghost" aria-label={t('remove')} onClick={async () => { if (confirm(`${t('remove')}?`)) { await del(`/finance/expenses/${e.id}`); expenses.reload(); reload(); } }}>✕</Button></div>
          </li>)}</ul>}
      </Card>
      <div className="grid gap-6 lg:grid-cols-2">
        <RateCard />
        {center && <CommissionsCard />}
      </div>
    </div>}
    <ExpenseDialog open={expOpen} onClose={() => setExpOpen(false)} onSaved={() => { expenses.reload(); reload(); }} />
  </>;
}

function RateCard() {
  const { t, lang } = useI18n(); const { can } = useWorkspace(); const { data, reload } = useLoad<any>('/finance/rates');
  const [v, setV] = useState(''); const [err, setErr] = useState<unknown>(null);
  return <Card title={t('rate')}>
    <p className="text-2xl font-semibold tabular">{data?.current ? `${Number(data.current).toLocaleString()} LBP/$` : '—'}</p>
    <p className="mt-1 text-xs text-muted">{t('rateHint')}</p>
    {can('org.manage') && <div className="mt-3 flex items-end gap-2"><Field label={t('rateLabel')} className="flex-1"><Input type="number" min={1} value={v} onChange={(e) => setV(e.target.value)} /></Field>
      <Button disabled={!(Number(v) > 0)} onClick={async () => { try { await post('/finance/rates', { lbpPerUsd: Number(v), note: null }); setV(''); reload(); } catch (e) { setErr(e); } }}>{t('setRate')}</Button></div>}
    <ErrorNote error={err} />
    {data?.history?.length > 1 && <ul className="mt-3 space-y-0.5 text-xs text-muted tabular">{data.history.slice(1, 6).map((h: any) => <li key={h.id}>{fmtDate(h.effective_from, lang)} · {Number(h.lbp_per_usd).toLocaleString()} · {h.created_by_name ?? '—'}</li>)}</ul>}
  </Card>;
}

function CommissionsCard() {
  const { t } = useI18n(); const { can, org } = useWorkspace(); const { data, reload } = useLoad<any[]>('/finance/commissions');
  const editable = can('org.manage') && org.me.orgWide;
  const [err, setErr] = useState<unknown>(null);
  return <Card title={t('commissions')}>
    <p className="mb-3 text-xs text-muted">{t('commissionHint')}</p>
    <ul className="divide-y divide-line text-sm">{(data ?? []).map((d) => <li key={d.membership_id} className="flex items-center justify-between gap-2 py-1.5">
      <span>{d.full_name}</span>
      {editable ? <Input className="w-24" type="number" min={0} max={100} defaultValue={d.doctor_percent ?? ''} placeholder="100"
        onBlur={async (e) => { if (e.target.value === '' || Number(e.target.value) === Number(d.doctor_percent)) return; try { await api(`/finance/commissions/${d.membership_id}`, { method: 'PUT', body: { doctorPercent: Number(e.target.value) } }); reload(); } catch (x) { setErr(x); } }} />
        : <span className="tabular">{d.doctor_percent ?? 100}%</span>}
    </li>)}</ul>
    <ErrorNote error={err} />
  </Card>;
}

function ExpenseDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n(); const { org } = useWorkspace(); const doctors = useDoctors();
  const [f, setF] = useState({ category: 'supplies', description: '', amount: '', currency: 'USD', spentAt: iso(new Date()), method: 'cash', doctor: '' });
  const [err, setErr] = useState<unknown>(null);
  const center = org.organization.kind === 'medical_center';
  return <Dialog open={open} onClose={onClose} title={t('addExpense')}>
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={t('category')}><Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{CATEGORIES.map((c) => <option key={c} value={c}>{t(c)}</option>)}</Select></Field>
      <Field label={t('date')}><Input type="date" value={f.spentAt} onChange={(e) => setF({ ...f, spentAt: e.target.value })} /></Field>
      <Field label={t('amount')}><Input type="number" min={0} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
      <Field label={t('currency')}><Select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}><option>USD</option><option>LBP</option></Select></Field>
      <Field label={t('method')}><Select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{['cash', 'card', 'bank_transfer', 'whish', 'omt'].map((m) => <option key={m} value={m}>{t(m)}</option>)}</Select></Field>
      {center && org.me.orgWide && <Field label={t('doctor')}><Select value={f.doctor} onChange={(e) => setF({ ...f, doctor: e.target.value })}><option value="">{t('sharedExpense')}</option>
        {(doctors ?? []).map((d: any) => <option key={d.id} value={d.id}>{d.full_name}</option>)}</Select></Field>}
      <Field label={t('description')} className="sm:col-span-2"><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
    </div>
    <div className="mt-3"><ErrorNote error={err} /></div>
    <div className="mt-4 flex justify-end"><Button disabled={!(Number(f.amount) > 0)} onClick={async () => {
      try {
        await post('/finance/expenses', { category: f.category, description: f.description.trim() || null, amount: Number(f.amount), currency: f.currency, spentAt: f.spentAt, method: f.method, doctorMembershipId: f.doctor || null, departmentId: null });
        onSaved(); onClose(); setF({ ...f, amount: '', description: '' });
      } catch (e) { setErr(e); }
    }}>{t('save')}</Button></div>
  </Dialog>;
}
