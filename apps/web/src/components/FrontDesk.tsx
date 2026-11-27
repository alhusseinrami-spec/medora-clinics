'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Select, fmtMoney, fmtTime } from './ui';
import { startInvoice } from './Invoice';
import { get, put } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useLiveReload, useWorkspace } from '@/lib/workspace';

interface CheckoutRow {
  appointment_id: string; patient_id: string; patient_name: string; patient_number: string; doctor_name: string; doctor_membership_id: string;
  status: string; service_name: string | null; called_at: string | null; completed_at: string | null;
  fee_amount: number | null; fee_currency: string | null; fee_note: string | null;
  invoice: { id: string; status: string; number: string | null; currency: string; total: number; due: number } | null;
  prescriptions: { id: string; issued_at: string }[];
}

/**
 * The front desk's checkout list: who is with the doctor, who finished, what to collect (the fee the doctor set),
 * whether it is paid, and prescriptions to print. Refreshes itself whenever the doctor changes something.
 */
export function Checkout({ compact = false }: { compact?: boolean }) {
  const { t, lang, status } = useI18n(); const { can, org, orgId } = useWorkspace();
  const [rows, setRows] = useState<CheckoutRow[]>([]); const [err, setErr] = useState<unknown>(null);
  const load = useCallback(() => get<CheckoutRow[]>('/front-desk/checkout').then(setRows).catch(() => {}), []);
  useLiveReload(load);
  const pay = can('payment.register');
  const list = compact ? rows.slice(0, 6) : rows;
  return <Card title={t('checkout')} actions={compact && <Link href={`/w/${orgId}/waiting-room`} className="text-sm text-brand">→</Link>}>
    {!compact && <p className="-mt-1 mb-3 text-xs text-muted">{t('checkoutHint')}</p>}
    <ErrorNote error={err} />
    {list.length === 0 ? <Empty>{t('checkoutEmpty')}</Empty> : <ul className="divide-y divide-line">{list.map((r) => {
      const paid = r.invoice && r.invoice.status === 'issued' && r.invoice.due <= 0.004;
      return <li key={r.appointment_id} className="flex flex-wrap items-center justify-between gap-3 py-3">
        <div className="min-w-0">
          <p className="font-semibold">{r.patient_name}</p>
          <p className="text-xs text-muted tabular">{r.doctor_name}{r.completed_at ? ` · ${t('visitDone')} ${fmtTime(r.completed_at, lang)}` : r.called_at ? ` · ${t('withDoctorNow')} ${fmtTime(r.called_at, lang)}` : ''}</p>
          {r.prescriptions.length > 0 && <p className="mt-1 flex flex-wrap items-center gap-2 text-xs"><span className="text-muted">℞ {t('prescriptionsToPrint')}:</span>
            {r.prescriptions.map((x, i) => <a key={x.id} className="font-medium text-brand hover:underline" href={`/print/prescriptions/${x.id}?org=${orgId}&lang=${lang}`} target="_blank" rel="noopener">{t('livePrint')}{r.prescriptions.length > 1 ? ` ${i + 1}` : ''}</a>)}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {r.status === 'in_consultation' && <Badge status={r.status}>{status(r.status)}</Badge>}
          {r.fee_amount != null
            ? <span className="rounded-[10px] bg-brand-soft px-2.5 py-1 text-sm font-semibold text-brand tabular" title={r.fee_note ?? undefined}>{t('toCollect')}: {fmtMoney(r.fee_amount, r.fee_currency ?? 'USD', lang)}</span>
            : r.status === 'completed' && <span className="text-xs text-muted">{t('feeNotSet')}</span>}
          {r.invoice && (paid ? <Badge status="paid">{t('feePaid')}</Badge> : r.invoice.status === 'issued' ? <Badge status="partially_paid">{t('stillDue')} {fmtMoney(r.invoice.due, r.invoice.currency, lang)}</Badge> : null)}
          {pay && !paid && (r.fee_amount != null || r.status === 'completed') && <Button size="sm" onClick={() => startInvoice(org.organization.id, { appointmentId: r.appointment_id }).catch(setErr)}>{r.invoice ? t('openInvoice') : t('liveTakePayment')}</Button>}
          {pay && paid && r.invoice && <Link className="text-sm text-brand hover:underline" href={`/w/${orgId}/billing/${r.invoice.id}`}>{t('openInvoice')}</Link>}
        </div>
      </li>;
    })}</ul>}
  </Card>;
}

/** On the doctor's consultation page: the fee for this visit, sent to the front desk to collect. */
export function VisitFeeCard({ appointmentId }: { appointmentId: string }) {
  const { t, lang } = useI18n();
  const [a, setA] = useState<any>(null); const [amount, setAmount] = useState(''); const [currency, setCurrency] = useState('USD'); const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<any>(null); const [sent, setSent] = useState(false);
  const fillFrom = (x: any) => {
    setA(x);
    setAmount(x.fee_amount != null ? String(Number(x.fee_amount)) : x.fee_suggested != null ? String(Number(x.fee_suggested)) : '');
    setCurrency(x.fee_currency ?? x.fee_suggested_currency ?? 'USD'); setNote(x.fee_note ?? '');
  };
  useEffect(() => { get(`/appointments/${appointmentId}`).then(fillFrom).catch(setErr); }, [appointmentId]);
  const save = async (clear = false) => {
    setBusy(true); setErr(null); setSent(false);
    try {
      fillFrom(await put(`/appointments/${appointmentId}/fee`, clear ? { amount: null, note: null } : { amount: amount === '' ? null : Number(amount), currency, note: note.trim() || null }));
      setSent(!clear);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  if (!a) return err ? <Card title={t('visitFee')}><ErrorNote error={err} /></Card> : null;
  const invoiced = err?.body?.code === 'already_invoiced';
  return <Card title={t('visitFee')}>
    <p className="-mt-1 mb-3 text-xs text-muted">{t('visitFeeHint')}</p>
    <div className="flex flex-wrap items-end gap-2">
      <Field label={t('amount')} className="w-32"><Input type="number" min={0} step={currency === 'LBP' ? 1000 : 1} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
      <Field label={t('currency')} className="w-24"><Select value={currency} onChange={(e) => setCurrency(e.target.value)}><option>USD</option><option>LBP</option></Select></Field>
      {a.fee_suggested != null && <Button size="sm" variant="ghost" className="mb-1" onClick={() => { setAmount(String(Number(a.fee_suggested))); setCurrency(a.fee_suggested_currency ?? 'USD'); }}>{t('feeUsual')}: {fmtMoney(a.fee_suggested, a.fee_suggested_currency ?? 'USD', lang)}</Button>}
    </div>
    <Field label={t('feeNote')} className="mt-2"><Input maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder={a.service_name ?? ''} /></Field>
    <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
      {invoiced ? <p className="text-sm text-warning">{t('feeInvoiced')}</p> : <ErrorNote error={err} />}
      {sent && <span className="text-sm text-success">✓ {t('feeSent')}</span>}
      {a.fee_amount != null && !sent && <span className="text-sm text-muted tabular">{fmtMoney(a.fee_amount, a.fee_currency, lang)} ✓</span>}
      {a.fee_amount != null && <Button size="sm" variant="ghost" busy={busy} onClick={() => save(true)}>{t('clearFee')}</Button>}
      <Button busy={busy} disabled={amount === ''} onClick={() => save(false)}>{t('sendToDesk')}</Button>
    </div>
  </Card>;
}
