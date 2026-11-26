'use client';
import { use, useEffect, useState } from 'react';
import { Logo, fmtMoney } from '@/components/ui';
import { invoiceLabel } from '@/components/Invoice';
import { get, setActiveOrg } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

/** Printable invoice or credit note (A4). Insurance share is shown when lines are marked as covered and a claim exists. */
export default function PrintInvoice({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ org?: string }> }) {
  const { id } = use(params); const { org } = use(searchParams); const { t, lang, dir } = useI18n();
  const [inv, setInv] = useState<any>(null); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setActiveOrg(org ?? null); get(`/invoices/${id}`).then(setInv).catch((e) => setErr(e.message)); }, [id, org]);
  useEffect(() => { if (inv && inv.status !== 'draft') setTimeout(() => window.print(), 300); }, [inv]);
  if (err) return <p className="p-8 text-danger">{err}</p>;
  if (!inv) return <p className="p-8 text-muted">{t('loading')}</p>;
  const m = (n: any) => fmtMoney(n, inv.currency, lang);
  const d = (iso: string) => new Date(iso).toLocaleDateString(lang === 'ar' ? 'ar-LB' : lang, { day: 'numeric', month: 'long', year: 'numeric' });
  const insurance = (inv.claims ?? []).filter((c: any) => c.status !== 'rejected').reduce((s: number, c: any) => s + Number(c.amount_approved ?? c.amount_claimed), 0);
  return <div dir={dir} className="mx-auto min-h-screen max-w-[210mm] bg-white p-10 text-[13px] text-black print:p-0">
    <style>{`@page { size: A4; margin: 15mm } @media print { .no-print { display: none } }`}</style>
    <div className="no-print mb-6 flex justify-end"><button onClick={() => window.print()} className="rounded-[10px] bg-[#115D62] px-4 py-2 text-sm font-medium text-white">{t('print')}</button></div>
    <header className="flex items-start justify-between border-b-2 border-[#115D62] pb-4">
      <div><p className="text-lg font-semibold">{inv.organization_name}</p>{inv.organization_address && <p>{inv.organization_address}</p>}
        {inv.organization_phone && <p>{inv.organization_phone}</p>}{inv.organization_email && <p>{inv.organization_email}</p>}</div>
      <div className="text-end"><p className="text-2xl font-semibold text-[#115D62]">{inv.kind === 'credit_note' ? t('creditNote') : t('invoice')}</p>
        <p className="font-mono">{invoiceLabel(inv, t)}</p><p>{inv.issued_at ? d(inv.issued_at) : t('draft')}</p>
        {inv.credit_for_number && <p>{t('invoiceNo')} INV-{String(inv.credit_for_number).padStart(6, '0')}</p>}</div>
    </header>
    <section className="mt-5 flex justify-between gap-6">
      <div><p className="text-neutral-500">{t('billTo')}</p><p className="font-semibold">{inv.patient_name}</p><p>{inv.patient_number}</p>{inv.patient_phone && <p>{inv.patient_phone}</p>}</div>
      {inv.doctor_name && <div className="text-end"><p className="text-neutral-500">{t('doctor')}</p><p className="font-semibold">{inv.doctor_name}</p>{inv.license_number && <p>{t('licence')}: {inv.license_number}</p>}</div>}
    </section>
    <table className="mt-6 w-full"><thead><tr className="border-b border-neutral-400 text-start text-neutral-600"><th className="py-1.5 text-start">{t('description')}</th><th className="text-end">{t('qty')}</th><th className="text-end">{t('unitPrice')}</th><th className="text-end">{t('amount')}</th></tr></thead>
      <tbody>{inv.items.map((i: any) => <tr key={i.id} className="border-b border-neutral-200"><td className="py-1.5">{i.description}{i.insurance_covered ? ' ⛨' : ''}</td><td className="text-end">{i.quantity}</td><td className="text-end">{m(i.unit_price)}</td><td className="text-end">{m(i.amount)}</td></tr>)}</tbody></table>
    <dl className="ms-auto mt-4 w-72 space-y-1">
      {Number(inv.discount) > 0 && <div className="flex justify-between"><dt>{t('discount')}</dt><dd>-{m(inv.discount)}</dd></div>}
      {Number(inv.tax) > 0 && <div className="flex justify-between"><dt>{t('tax')}</dt><dd>{m(inv.tax)}</dd></div>}
      <div className="flex justify-between border-t border-neutral-400 pt-1 text-base font-semibold"><dt>{t('total')}</dt><dd>{m(inv.total)}</dd></div>
      {inv.kind === 'invoice' && <>
        {insurance > 0 && <><div className="flex justify-between"><dt>{t('insuranceInvoice')}</dt><dd>{m(insurance)}</dd></div>
          <div className="flex justify-between"><dt>{t('patientShare')}</dt><dd>{m(Number(inv.total) - Number(inv.credited) - insurance)}</dd></div></>}
        {Number(inv.credited) > 0 && <div className="flex justify-between"><dt>{t('credited')}</dt><dd>-{m(inv.credited)}</dd></div>}
        <div className="flex justify-between"><dt>{t('paid')}</dt><dd>-{m(inv.paid)}</dd></div>
        <div className="flex justify-between font-semibold"><dt>{t('balance')}</dt><dd>{m(inv.balance)}</dd></div></>}
    </dl>
    {inv.currency === 'USD' && inv.issued_at && <p className="mt-3 text-end text-neutral-600">{t('rate')}: {Number(inv.lbp_per_usd).toLocaleString()} LBP/$ · ≈ {fmtMoney(Number(inv.total) * Number(inv.lbp_per_usd), 'LBP', lang)}</p>}
    {inv.notes && <p className="mt-6 whitespace-pre-wrap">{inv.notes}</p>}
    {(inv.status !== 'issued') && <p className="mt-10 rotate-[-6deg] text-center text-5xl font-bold uppercase text-red-600/40">{inv.status === 'void' ? t('void') : t('draft')}</p>}
    <footer className="mt-16 flex items-end justify-between border-t border-neutral-300 pt-3 text-[11px] text-neutral-500"><Logo size={18} /><p>{t('thankYou')}</p></footer>
  </div>;
}
