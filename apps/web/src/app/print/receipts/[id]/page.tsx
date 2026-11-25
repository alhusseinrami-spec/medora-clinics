'use client';
import { use, useEffect, useState } from 'react';
import { Logo, fmtMoney } from '@/components/ui';
import { invoiceLabel } from '@/components/Invoice';
import { get, setActiveOrg } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

/** Payment receipt (A5). Refunds print as a refund receipt with a negative amount. */
export default function PrintReceipt({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ org?: string }> }) {
  const { id } = use(params); const { org } = use(searchParams); const { t, lang, dir } = useI18n();
  const [p, setP] = useState<any>(null); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setActiveOrg(org ?? null); get(`/payments/${id}`).then(setP).catch((e) => setErr(e.message)); }, [id, org]);
  useEffect(() => { if (p) setTimeout(() => window.print(), 300); }, [p]);
  if (err) return <p className="p-8 text-danger">{err}</p>;
  if (!p) return <p className="p-8 text-muted">{t('loading')}</p>;
  const inv = p.invoice;
  return <div dir={dir} className="mx-auto min-h-screen max-w-[148mm] bg-white p-8 text-[13px] text-black print:p-0">
    <style>{`@page { size: A5; margin: 12mm } @media print { .no-print { display: none } }`}</style>
    <div className="no-print mb-6 flex justify-end"><button onClick={() => window.print()} className="rounded-[10px] bg-[#12636B] px-4 py-2 text-sm font-medium text-white">{t('print')}</button></div>
    <header className="flex items-start justify-between border-b-2 border-[#12636B] pb-3">
      <div><p className="font-semibold">{inv.organization_name}</p>{inv.organization_address && <p>{inv.organization_address}</p>}{inv.organization_phone && <p>{inv.organization_phone}</p>}</div>
      <div className="text-end"><p className="text-lg font-semibold text-[#12636B]">{p.refund_of ? t('refunded') : t('receipt')}</p><p className="font-mono">{t('receiptNo')} {p.receipt_number}</p>
        <p>{new Date(p.received_at).toLocaleString(lang === 'ar' ? 'ar-LB' : lang)}</p></div>
    </header>
    <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5">
      <dt className="text-neutral-500">{t('receivedFrom')}</dt><dd className="font-semibold">{inv.patient_name} · {inv.patient_number}</dd>
      <dt className="text-neutral-500">{t('for')}</dt><dd>{invoiceLabel(inv, t)} · {t('total')} {fmtMoney(inv.total, inv.currency, lang)}</dd>
      <dt className="text-neutral-500">{t('method')}</dt><dd>{p.method_name}{p.reference ? ` · ${p.reference}` : ''}</dd>
      <dt className="text-neutral-500">{t('amount')}</dt><dd className="text-xl font-semibold">{fmtMoney(p.amount, p.currency, lang)}</dd>
      {p.currency !== inv.currency && <><dt className="text-neutral-500">{t('rate')}</dt><dd>{Number(p.lbp_per_usd).toLocaleString()} LBP/$</dd></>}
      <dt className="text-neutral-500">{t('balance')}</dt><dd>{fmtMoney(inv.balance, inv.currency, lang)}</dd>
      {p.note && <><dt className="text-neutral-500">{t('reason')}</dt><dd>{p.note}</dd></>}
    </dl>
    <footer className="mt-14 flex items-end justify-between border-t border-neutral-300 pt-3 text-[11px] text-neutral-500"><Logo size={18} /><p>{p.received_by_name}</p></footer>
  </div>;
}
