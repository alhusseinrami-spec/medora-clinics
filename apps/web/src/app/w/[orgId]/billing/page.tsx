'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Button, Card, Dialog, Empty, ErrorNote, Field, Input, Stat, Tabs, fmtDate, fmtMoney } from '@/components/ui';
import { Forbidden, PageTitle } from '@/components/Shell';
import { PatientPicker } from '@/components/AppointmentDialog';
import { balanceBadge, invoiceLabel, startInvoice } from '@/components/Invoice';
import { useI18n } from '@/lib/i18n';
import { useWorkspace } from '@/lib/workspace';
import { useLoad } from '@/lib/hooks';

export default function Billing() {
  const { t, lang } = useI18n(); const { can, orgId } = useWorkspace();
  const [tab, setTab] = useState('unpaid'); const [q, setQ] = useState(''); const [open, setOpen] = useState(false);
  const params = new URLSearchParams({ ...(tab === 'unpaid' ? { unpaid: '1' } : tab === 'draft' ? { status: 'draft' } : {}), ...(q.trim().length > 1 ? { q: q.trim() } : {}) });
  const { data, error } = useLoad<any[]>(tab === 'owed' ? null : `/invoices?${params}`);
  const rates = useLoad<any>('/finance/rates');
  if (!can('payment.register') && !can('finance.view')) return <Forbidden />;
  return <>
    <PageTitle title={t('billing')} actions={can('payment.register') && <Button onClick={() => setOpen(true)}>+ {t('newInvoice')}</Button>} />
    {rates.data && !rates.data.current && <p className="mb-4 rounded-[10px] bg-warning/10 p-3 text-sm text-warning">{t('noRate')} {can('finance.view') && <Link className="font-medium underline" href={`/w/${orgId}/finance`}>{t('setRate')}</Link>}</p>}
    <div className="flex flex-wrap items-end justify-between gap-3">
      <Tabs tabs={[{ key: 'unpaid', label: t('unpaid') }, { key: 'owed', label: t('outstandingBalances') }, { key: 'draft', label: t('drafts') }, { key: 'all', label: t('all') }]} value={tab} onChange={setTab} />
      {tab !== 'owed' && <Input className="w-64" placeholder={t('search')} value={q} onChange={(e) => setQ(e.target.value)} />}
    </div>
    <div className="mt-4"><ErrorNote error={error} /></div>
    {tab === 'owed' ? <Receivables /> : !data ? <p className="text-muted">{t('loading')}</p> : data.length === 0 ? <Empty>{t('noInvoices')}</Empty> :
      <Card><table className="w-full text-sm"><thead><tr className="text-xs text-muted"><th className="py-2 text-start">{t('invoiceNo')}</th><th className="text-start">{t('patients')}</th>
        <th className="hidden text-start md:table-cell">{t('doctor')}</th><th className="text-end">{t('total')}</th><th className="text-end">{t('balance')}</th><th className="text-end"></th></tr></thead>
        <tbody>{data.map((i) => <tr key={i.id} className="border-t border-line hover:bg-surface">
          <td className="py-2"><Link className="font-medium text-brand hover:underline tabular" href={`/w/${orgId}/billing/${i.id}`}>{invoiceLabel(i, t)}</Link>
            <span className="block text-xs text-muted tabular">{fmtDate(i.issued_at ?? i.created_at, lang)}</span></td>
          <td>{i.patient_name}<span className="block text-xs text-muted tabular">{i.patient_number}</span></td>
          <td className="hidden md:table-cell">{i.doctor_name ?? '—'}</td>
          <td className="text-end tabular">{fmtMoney(i.total, i.currency, lang)}</td>
          <td className="text-end tabular">{i.kind === 'invoice' && i.status === 'issued' ? fmtMoney(i.balance, i.currency, lang) : '—'}</td>
          <td className="text-end">{balanceBadge(i, t)}</td></tr>)}</tbody></table></Card>}
    <NewInvoice open={open} onClose={() => setOpen(false)} orgId={orgId} />
  </>;
}

function NewInvoice({ open, onClose, orgId }: { open: boolean; onClose: () => void; orgId: string }) {
  const { t } = useI18n(); const [patient, setPatient] = useState<any>(null); const [err, setErr] = useState<unknown>(null);
  return <Dialog open={open} onClose={onClose} title={t('newInvoice')}>
    <Field label={t('patients')}><PatientPicker value={patient} onChange={setPatient} /></Field>
    <div className="mt-3"><ErrorNote error={err} /></div>
    <div className="mt-4 flex justify-end"><Button disabled={!patient} onClick={() => startInvoice(orgId, { patientId: patient.id }).catch(setErr)}>{t('createInvoice')}</Button></div>
  </Dialog>;
}

/** What patients still owe: never counted as income. Collected and forgiven are for the current month. */
function Receivables() {
  const { t, lang } = useI18n(); const { orgId } = useWorkspace();
  const { data, error } = useLoad<any>('/finance/receivables');
  if (error) return <ErrorNote error={error} />;
  if (!data) return <p className="text-muted">{t('loading')}</p>;
  const since = (m: number) => (m === 0 ? t('owedThisMonth') : m === 1 ? t('owedForMonth') : t('owedForMonths').replace('{n}', String(m)));
  return <>
    <p className="mb-4 text-sm text-muted">{t('outstandingHint')}</p>
    <div className="grid gap-4 sm:grid-cols-3">
      <Stat label={t('collectedThisMonth')} value={fmtMoney(data.collectedThisMonth, 'USD', lang)} tone="brand" />
      <Stat label={t('stillOwed')} value={fmtMoney(data.stillOwed, 'USD', lang)} tone="warning" />
      <Stat label={t('forgivenThisMonth')} value={fmtMoney(data.forgivenThisMonth, 'USD', lang)} tone="info" />
    </div>
    <Card className="mt-4" title={t('patientsWhoOwe')} actions={<span className="text-sm tabular">{t('totalOwed')}: <b>{fmtMoney(data.stillOwed, 'USD', lang)}</b></span>}>
      {data.patients.length === 0 ? <Empty>{t('nobodyOwes')}</Empty> : <ul className="divide-y divide-line">{data.patients.map((p: any) =>
        <li key={p.patient_id} className="flex items-center justify-between gap-3 py-2.5">
          <div><Link className="font-medium hover:underline" href={`/w/${orgId}/patients/${p.patient_id}`}>{p.patient_name}</Link>
            <p className="text-xs text-muted">{since(p.months)} · {p.invoices} {t('invoices').toLowerCase()} <span className="tabular">{p.patient_number}</span></p></div>
          <span className="rounded-full bg-warning/10 px-3 py-1 text-sm font-medium text-warning tabular">{fmtMoney(p.owed, 'USD', lang)}</span>
        </li>)}</ul>}
      {data.patients.length > 0 && <p className="mt-3 text-xs text-muted">{t('inUsd')}</p>}
    </Card>
  </>;
}
