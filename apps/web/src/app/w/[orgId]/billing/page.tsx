'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Button, Card, Dialog, Empty, ErrorNote, Field, Input, Tabs, fmtDate, fmtMoney } from '@/components/ui';
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
  const { data, error } = useLoad<any[]>(`/invoices?${params}`);
  const rates = useLoad<any>('/finance/rates');
  if (!can('payment.register') && !can('finance.view')) return <Forbidden />;
  return <>
    <PageTitle title={t('billing')} actions={can('payment.register') && <Button onClick={() => setOpen(true)}>+ {t('newInvoice')}</Button>} />
    {rates.data && !rates.data.current && <p className="mb-4 rounded-[10px] bg-warning/10 p-3 text-sm text-warning">{t('noRate')} {can('finance.view') && <Link className="font-medium underline" href={`/w/${orgId}/finance`}>{t('setRate')}</Link>}</p>}
    <div className="flex flex-wrap items-end justify-between gap-3">
      <Tabs tabs={[{ key: 'unpaid', label: t('unpaid') }, { key: 'draft', label: t('drafts') }, { key: 'all', label: t('all') }]} value={tab} onChange={setTab} />
      <Input className="w-64" placeholder={t('search')} value={q} onChange={(e) => setQ(e.target.value)} />
    </div>
    <div className="mt-4"><ErrorNote error={error} /></div>
    {!data ? <p className="text-muted">{t('loading')}</p> : data.length === 0 ? <Empty>{t('noInvoices')}</Empty> :
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
