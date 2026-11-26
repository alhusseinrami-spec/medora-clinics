'use client';
import { PaymentReminderButton } from '@/components/Comm';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, Dialog, ErrorNote, Field, Input, Select, Textarea, cx, fmtDate, fmtMoney } from './ui';
import { del, get, patch, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useWorkspace } from '@/lib/workspace';

interface Line { description: string; quantity: number; unitPrice: number; kind: string; insuranceCovered: boolean; serviceId: string | null }
const toLine = (i: any): Line => ({ description: i.description, quantity: Number(i.quantity), unitPrice: Number(i.unit_price), kind: i.kind, insuranceCovered: !!i.insurance_covered, serviceId: i.service_id ?? null });
const METHODS = ['cash', 'card', 'bank_transfer', 'whish', 'omt'];

export const invoiceLabel = (inv: any, t: (k: string) => string) =>
  inv.invoice_number ? `${inv.kind === 'credit_note' ? 'CN' : 'INV'}-${String(inv.invoice_number).padStart(6, '0')}` : t('draft');

export function balanceBadge(inv: any, t: (k: string) => string) {
  if (inv.status === 'draft') return <Badge status="draft">{t('draft')}</Badge>;
  if (inv.status === 'void') return <Badge status="void">{t('void')}</Badge>;
  if (inv.kind === 'credit_note') return <Badge status="issued">{t('creditNote')}</Badge>;
  return Number(inv.balance) > 0.004 ? <Badge status="unpaid">{t('unpaid')}</Badge> : <Badge status="paid">{t('paid')}</Badge>;
}

/** The whole invoice: draft editor, or the issued document with payments, refunds, credit notes, void and claims. */
export function InvoiceView({ inv, onChange }: { inv: any; onChange: (i: any) => void }) {
  const { t, lang } = useI18n(); const { can, orgId } = useWorkspace();
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | 'pay' | 'credit' | 'void' | { refund: any }>(null);
  const run = async (k: string, fn: () => Promise<any>) => { setBusy(k); setErr(null); try { const r = await fn(); if (r) onChange(r); setDialog(null); } catch (e) { setErr(e); } finally { setBusy(null); } };
  const m = (n: any) => fmtMoney(n, inv.currency, lang);
  const draft = inv.status === 'draft';
  return <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
    <div className="space-y-6">
      {draft ? <DraftEditor inv={inv} onChange={onChange} /> : <Card title={<span className="flex items-center gap-2">{invoiceLabel(inv, t)} {balanceBadge(inv, t)}</span>}
        actions={<a href={`/print/invoices/${inv.id}?org=${orgId}`} target="_blank" rel="noopener" className="text-sm font-medium text-brand hover:underline">{t('print')}</a>}>
        <table className="w-full text-sm"><thead><tr className="text-start text-xs text-muted"><th className="py-1 text-start">{t('description')}</th><th className="text-end">{t('qty')}</th><th className="text-end">{t('unitPrice')}</th><th className="text-end">{t('amount')}</th></tr></thead>
          <tbody>{inv.items.map((i: any) => <tr key={i.id} className="border-t border-line"><td className="py-1.5">{i.description}{i.insurance_covered && <span className="ms-2 text-xs text-info">⛨</span>}</td>
            <td className="text-end tabular">{i.quantity}</td><td className="text-end tabular">{m(i.unit_price)}</td><td className="text-end tabular">{m(i.amount)}</td></tr>)}</tbody></table>
        <Totals inv={inv} />
        {inv.status === 'void' && <p className="mt-3 text-sm text-danger">{t('void')}: {inv.void_reason}</p>}
        {inv.notes && <p className="mt-3 whitespace-pre-wrap text-sm text-muted">{inv.notes}</p>}
      </Card>}
      {!draft && inv.kind === 'invoice' && <Card title={t('payments')} actions={inv.status === 'issued' && can('payment.register') && inv.balance > 0.004 && <Button size="sm" onClick={() => setDialog('pay')}>{t('takePayment')}</Button>}>
        {inv.payments.length === 0 ? <p className="text-sm text-muted">—</p> : <ul className="divide-y divide-line">{inv.payments.map((p: any) => <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
          <div><p className={cx('font-medium tabular', p.amount < 0 && 'text-danger')}>{fmtMoney(p.amount, p.currency, lang)} · {p.refund_of ? t('refunded') : t(p.method_code)}{p.reference ? ` · ${p.reference}` : ''}</p>
            <p className="text-xs text-muted tabular">{t('receiptNo')} {p.receipt_number} · {fmtDate(p.received_at, lang)} · {p.received_by_name}{p.currency !== inv.currency ? ` · ${t('rate')} ${Number(p.lbp_per_usd).toLocaleString()}` : ''}{p.note ? ` · ${p.note}` : ''}</p></div>
          <div className="flex gap-1.5"><a href={`/print/receipts/${p.id}?org=${orgId}`} target="_blank" rel="noopener" className="inline-flex h-8 items-center rounded-[10px] px-2 text-sm text-brand hover:bg-surface">{t('printReceipt')}</a>
            {!p.refund_of && !p.claim_id && can('finance.view') && can('payment.register') && <Button size="sm" variant="ghost" onClick={() => setDialog({ refund: p })}>{t('refund')}</Button>}</div>
        </li>)}</ul>}
      </Card>}
      <ErrorNote error={err} />
    </div>
    <div className="space-y-6">
      <Card title={t('billTo')}>
        <p className="font-medium"><Link className="hover:underline" href={`/w/${orgId}/patients/${inv.patient_id}`}>{inv.patient_name}</Link></p>
        <p className="text-sm text-muted tabular">{inv.patient_number}{inv.doctor_name ? ` · ${inv.doctor_name}` : ''}{inv.department_name ? ` · ${inv.department_name}` : ''}</p>
        {inv.issued_at && <p className="mt-2 text-xs text-muted tabular">{fmtDate(inv.issued_at, lang)} · {t('rate')} {Number(inv.lbp_per_usd).toLocaleString()} LBP/$ {inv.doctor_percent != null ? ` · ${t('doctorPercent')} ${inv.doctor_percent}` : ''}</p>}
        {inv.credit_for_invoice_id && <p className="mt-2 text-sm"><Link className="text-brand hover:underline" href={`/w/${orgId}/billing/${inv.credit_for_invoice_id}`}>{t('invoiceNo')} {inv.credit_for_number}</Link></p>}
      </Card>
      {inv.creditNotes?.length > 0 && <Card title={t('creditNote')}><ul className="space-y-1 text-sm">{inv.creditNotes.map((c: any) => <li key={c.id}>
        <Link className="text-brand hover:underline" href={`/w/${orgId}/billing/${c.id}`}>CN-{String(c.invoice_number).padStart(6, '0')}</Link> · {m(c.total)} · {c.notes}</li>)}</ul></Card>}
      {inv.claims?.length > 0 && <Card title={t('claims')}><ul className="space-y-1 text-sm">{inv.claims.map((c: any) => <li key={c.id} className="flex items-center justify-between gap-2">
        <span>{c.provider_name} · {m(c.amount_approved ?? c.amount_claimed)}</span><Badge status={c.status}>{t(c.status)}</Badge></li>)}</ul></Card>}
      {inv.status === 'issued' && inv.kind === 'invoice' && (can('insurance.manage') || can('whatsapp.send') || (can('finance.view') && can('payment.register'))) && <Card>
        <div className="flex flex-wrap gap-2">
          {can('insurance.manage') && <ClaimButton inv={inv} onDone={onChange} />}
          {can('whatsapp.send') && Number(inv.balance) > 0 && <PaymentReminderButton inv={inv} />}
          {can('finance.view') && can('payment.register') && <Button size="sm" variant="secondary" onClick={() => setDialog('credit')}>{t('issueCreditNote')}</Button>}
          {can('finance.view') && can('payment.register') && inv.payments.length === 0 && <Button size="sm" variant="ghost" onClick={() => setDialog('void')}>{t('voidInvoice')}</Button>}
        </div>
      </Card>}
    </div>
    <PayDialog open={dialog === 'pay'} inv={inv} busy={busy === 'pay'} onClose={() => setDialog(null)} onPay={(b) => run('pay', () => post(`/invoices/${inv.id}/payments`, b))} />
    <ReasonDialog open={dialog === 'void'} title={t('voidInvoice')} hint={t('voidHint')} onClose={() => setDialog(null)} onConfirm={(reason) => run('void', () => post(`/invoices/${inv.id}/void`, { reason }))} />
    <ReasonDialog open={dialog === 'credit'} title={t('issueCreditNote')} hint={t('creditNoteHint')} withAmount currency={inv.currency} onClose={() => setDialog(null)}
      onConfirm={(reason, amount) => run('credit', () => post(`/invoices/${inv.id}/credit-notes`, { reason, amount }))} />
    <ReasonDialog open={typeof dialog === 'object' && dialog !== null} title={t('refund')} hint={dialog && typeof dialog === 'object' ? `${fmtMoney(dialog.refund.amount, dialog.refund.currency, lang)} · ${t(dialog.refund.method_code)}` : ''}
      withAmount currency={dialog && typeof dialog === 'object' ? dialog.refund.currency : inv.currency} onClose={() => setDialog(null)}
      onConfirm={(reason, amount) => run('refund', () => post(`/payments/${(dialog as any).refund.id}/refund`, { reason, amount }))} />
  </div>;
}

function Totals({ inv }: { inv: any }) {
  const { t, lang } = useI18n(); const m = (n: any) => fmtMoney(n, inv.currency, lang);
  const rows: [string, any, string?][] = [[t('subtotal'), Number(inv.total) + Number(inv.discount) - Number(inv.tax)]];
  if (Number(inv.discount)) rows.push([t('discount'), -inv.discount]);
  if (Number(inv.tax)) rows.push([t('tax'), inv.tax]);
  rows.push([t('total'), inv.total, 'font-semibold']);
  if (inv.kind === 'invoice' && inv.status === 'issued') {
    if (Number(inv.credited)) rows.push([t('credited'), -inv.credited]);
    rows.push([t('paid'), Number(inv.paid) ? -inv.paid : 0]);
    rows.push([t('balance'), inv.balance, 'font-semibold text-brand']);
  }
  return <dl className="ms-auto mt-3 w-full max-w-xs space-y-1 text-sm">{rows.map(([k, v, cls]) => <div key={k} className={cx('flex justify-between tabular', cls)}><dt>{k}</dt><dd>{m(v)}</dd></div>)}</dl>;
}

function DraftEditor({ inv, onChange }: { inv: any; onChange: (i: any) => void }) {
  const { t, lang } = useI18n(); const { orgId } = useWorkspace();
  const [lines, setLines] = useState<Line[]>(inv.items.length ? inv.items.map(toLine) : [{ description: '', quantity: 1, unitPrice: 0, kind: 'consultation', insuranceCovered: false, serviceId: null }]);
  const [currency, setCurrency] = useState(inv.currency); const [discount, setDiscount] = useState(String(inv.discount || '')); const [tax, setTax] = useState(String(inv.tax || ''));
  const [notes, setNotes] = useState(inv.notes ?? ''); const [services, setServices] = useState<any[]>([]);
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { get<any[]>('/services').then(setServices).catch(() => {}); }, []);
  const set = (i: number, p: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const body = () => ({ currency, discount: Number(discount) || 0, tax: Number(tax) || 0, notes: notes.trim() || null,
    items: lines.filter((l) => l.description.trim()).map((l) => ({ ...l, description: l.description.trim(), quantity: Number(l.quantity) || 1, unitPrice: Number(l.unitPrice) || 0 })) });
  const sub = lines.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0), 0);
  const save = async (issue = false) => {
    if (issue && !confirm(t('issueInvoiceConfirm'))) return;
    setBusy(issue ? 'issue' : 'save'); setErr(null);
    try { let r = await patch(`/invoices/${inv.id}`, body()); if (issue) r = await post(`/invoices/${inv.id}/issue`); onChange(r); } catch (e) { setErr(e); } finally { setBusy(null); }
  };
  return <Card title={<span className="flex items-center gap-2">{t('invoice')} <Badge status="draft">{t('draft')}</Badge></span>}>
    <div className="space-y-2">{lines.map((l, i) => <div key={i} className="grid items-end gap-2 sm:grid-cols-[2fr_70px_120px_110px_auto_auto]">
      <Field label={i === 0 ? t('description') : ''}><Input list="services-list" value={l.description} onChange={(e) => {
        const s = services.find((x) => x.name === e.target.value);
        set(i, s ? { description: s.name, unitPrice: Number(s.price), serviceId: s.id, kind: 'service' } : { description: e.target.value, serviceId: null });
      }} /></Field>
      <Field label={i === 0 ? t('qty') : ''}><Input type="number" min={1} step="1" value={l.quantity} onChange={(e) => set(i, { quantity: Number(e.target.value) })} /></Field>
      <Field label={i === 0 ? `${t('unitPrice')} (${currency})` : ''}><Input type="number" min={0} step={currency === 'LBP' ? 1000 : 0.01} value={l.unitPrice} onChange={(e) => set(i, { unitPrice: Number(e.target.value) })} /></Field>
      <Field label={i === 0 ? t('kind') : ''}><Select value={l.kind} onChange={(e) => set(i, { kind: e.target.value })}>{['consultation', 'service', 'product', 'other'].map((k) => <option key={k} value={k}>{t(`revenue${k[0].toUpperCase()}${k.slice(1)}`)}</option>)}</Select></Field>
      <label className="flex h-10 items-center gap-1.5 text-sm" title={t('covered')}><input type="checkbox" checked={l.insuranceCovered} onChange={(e) => set(i, { insuranceCovered: e.target.checked })} />⛨</label>
      <Button size="sm" variant="ghost" aria-label={t('remove')} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>✕</Button>
    </div>)}</div>
    <datalist id="services-list">{services.map((s) => <option key={s.id} value={s.name}>{fmtMoney(s.price, s.currency, lang)}</option>)}</datalist>
    <Button className="mt-2" size="sm" variant="secondary" onClick={() => setLines([...lines, { description: '', quantity: 1, unitPrice: 0, kind: 'service', insuranceCovered: false, serviceId: null }])}>+ {t('addLine')}</Button>
    <div className="mt-4 grid gap-3 sm:grid-cols-3">
      <Field label={t('currency')}><Select value={currency} onChange={(e) => setCurrency(e.target.value)}><option>USD</option><option>LBP</option></Select></Field>
      <Field label={t('discount')}><Input type="number" min={0} value={discount} onChange={(e) => setDiscount(e.target.value)} /></Field>
      <Field label={t('tax')}><Input type="number" min={0} value={tax} onChange={(e) => setTax(e.target.value)} /></Field>
    </div>
    <Field className="mt-3" label={t('notes')}><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
    <p className="mt-3 text-end text-lg font-semibold tabular">{t('total')}: {fmtMoney(sub - (Number(discount) || 0) + (Number(tax) || 0), currency, lang)}</p>
    <ErrorNote error={err} />
    <div className="mt-3 flex flex-wrap justify-end gap-2">
      <Button variant="ghost" onClick={async () => { try { await del(`/invoices/${inv.id}`); location.href = `/w/${orgId}/billing`; } catch (e) { setErr(e); } }}>{t('deleteDraft')}</Button>
      <Button variant="secondary" busy={busy === 'save'} onClick={() => save(false)}>{t('save')}</Button>
      <Button busy={busy === 'issue'} onClick={() => save(true)}>{t('issueInvoice')}</Button>
    </div>
  </Card>;
}

function PayDialog({ open, inv, busy, onClose, onPay }: { open: boolean; inv: any; busy: boolean; onClose: () => void; onPay: (b: any) => void }) {
  const { t, lang } = useI18n(); const [method, setMethod] = useState('cash'); const [currency, setCurrency] = useState(inv.currency);
  const [amount, setAmount] = useState(''); const [reference, setReference] = useState(''); const [rate, setRate] = useState<number | null>(null);
  useEffect(() => { if (open) { setCurrency(inv.currency); setAmount(String(inv.balance)); get('/finance/rates').then((r) => setRate(Number(r.current))).catch(() => {}); } }, [open, inv]);
  const equiv = rate && currency !== inv.currency && Number(amount) ? (currency === 'USD' ? Number(amount) * rate : Number(amount) / rate) : null;
  return <Dialog open={open} onClose={onClose} title={`${t('takePayment')} · ${t('balance')} ${fmtMoney(inv.balance, inv.currency, lang)}`}>
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={t('method')}><Select value={method} onChange={(e) => setMethod(e.target.value)}>{METHODS.map((x) => <option key={x} value={x}>{t(x)}</option>)}</Select></Field>
      <Field label={t('currency')}><Select value={currency} onChange={(e) => {
        const c = e.target.value; setCurrency(c);
        if (rate) setAmount(String(c === inv.currency ? inv.balance : c === 'LBP' ? Math.round(inv.balance * rate) : Math.round((inv.balance / rate) * 100) / 100));
      }}><option>USD</option><option>LBP</option></Select></Field>
      <Field label={t('amount')}><Input type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
      <Field label={t('reference')}><Input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
    </div>
    {equiv !== null && <p className="mt-2 text-xs text-muted">≈ {fmtMoney(equiv, inv.currency, lang)} · {t('rate')} {rate?.toLocaleString()}</p>}
    <div className="mt-4 flex justify-end"><Button busy={busy} disabled={!(Number(amount) > 0)} onClick={() => onPay({ method, currency, amount: Number(amount), reference: reference.trim() || null, note: null })}>{t('takePayment')}</Button></div>
  </Dialog>;
}

function ReasonDialog({ open, title, hint, withAmount, currency, onClose, onConfirm }: { open: boolean; title: string; hint: string; withAmount?: boolean; currency?: string; onClose: () => void; onConfirm: (reason: string, amount?: number) => void }) {
  const { t } = useI18n(); const [reason, setReason] = useState(''); const [amount, setAmount] = useState('');
  useEffect(() => { if (open) { setReason(''); setAmount(''); } }, [open]);
  return <Dialog open={open} onClose={onClose} title={title}>
    <p className="mb-3 text-sm text-muted">{hint}</p>
    {withAmount && <Field label={`${t('amount')} (${currency})`}><Input type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>}
    <Field className="mt-3" label={t('reason')}><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    <div className="mt-4 flex justify-end"><Button disabled={reason.trim().length < 3 || (withAmount && !(Number(amount) > 0))} onClick={() => onConfirm(reason.trim(), withAmount ? Number(amount) : undefined)}>{title}</Button></div>
  </Dialog>;
}

function ClaimButton({ inv, onDone }: { inv: any; onDone: (i: any) => void }) {
  const { t } = useI18n(); const [open, setOpen] = useState(false); const [policies, setPolicies] = useState<any[]>([]);
  const [policyId, setPolicyId] = useState(''); const [amount, setAmount] = useState(''); const [err, setErr] = useState<unknown>(null);
  useEffect(() => { if (open) get<any[]>(`/patients/${inv.patient_id}/policies`).then((p) => { const a = p.filter((x) => x.is_active); setPolicies(a); setPolicyId(a[0]?.id ?? ''); }).catch(setErr); }, [open, inv.patient_id]);
  return <>
    <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>⛨ {t('newClaim')}</Button>
    <Dialog open={open} onClose={() => setOpen(false)} title={t('newClaim')}>
      {policies.length === 0 ? <p className="text-sm text-muted">{t('policies')}: —</p> : <>
        <Field label={t('policies')}><Select value={policyId} onChange={(e) => setPolicyId(e.target.value)}>{policies.map((p) => <option key={p.id} value={p.id}>{p.provider_name} · {p.policy_number}{p.coverage_percent != null ? ` · ${p.coverage_percent}%` : ''}</option>)}</Select></Field>
        <Field className="mt-3" label={`${t('claimAmount')} (${inv.currency})`} hint={t('claimHint')}><Input type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
      </>}
      <div className="mt-3"><ErrorNote error={err} /></div>
      <div className="mt-4 flex justify-end"><Button disabled={!policyId} onClick={async () => {
        try { await post('/claims', { invoiceId: inv.id, policyId, notes: null, ...(Number(amount) > 0 ? { amountClaimed: Number(amount) } : {}) }); onDone(await get(`/invoices/${inv.id}`)); setOpen(false); } catch (e) { setErr(e); }
      }}>{t('newClaim')}</Button></div>
    </Dialog>
  </>;
}

/** Creates a draft invoice (from a visit when given) and opens it. */
export async function startInvoice(orgId: string, b: { patientId?: string; appointmentId?: string }) {
  try {
    const r = await post('/invoices', { ...b, notes: null });
    location.href = `/w/${orgId}/billing/${r.id}`;
  } catch (e: any) {
    if (e?.body?.code === 'already_invoiced') location.href = `/w/${orgId}/billing/${e.body.invoiceId}`;
    else throw e;
  }
}
