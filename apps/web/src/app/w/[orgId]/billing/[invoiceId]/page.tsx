'use client';
import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { ErrorNote } from '@/components/ui';
import { PageTitle } from '@/components/Shell';
import { InvoiceView, invoiceLabel } from '@/components/Invoice';
import { get } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

export default function InvoicePage({ params }: { params: Promise<{ orgId: string; invoiceId: string }> }) {
  const { orgId, invoiceId } = use(params); const { t } = useI18n();
  const [inv, setInv] = useState<any>(null); const [err, setErr] = useState<unknown>(null);
  useEffect(() => { get(`/invoices/${invoiceId}`).then(setInv).catch(setErr); }, [invoiceId]);
  if (err) return <ErrorNote error={err} />;
  if (!inv) return <p className="text-muted">{t('loading')}</p>;
  return <>
    <PageTitle title={`${inv.kind === 'credit_note' ? t('creditNote') : t('invoice')} ${inv.invoice_number ? invoiceLabel(inv, t) : ''}`}
      sub={<Link className="hover:underline" href={`/w/${orgId}/billing`}>← {t('billing')}</Link>} />
    <InvoiceView key={inv.status + inv.paid + inv.credited} inv={inv} onChange={setInv} />
  </>;
}
