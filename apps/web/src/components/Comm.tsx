'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, Card, Dialog, Empty, ErrorNote, Field, Input, Select, Textarea, fmtDate, fmtTime } from '@/components/ui';
import { post, put } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useWorkspace } from '@/lib/workspace';
import { useLoad } from '@/lib/hooks';
import { invoiceLabel } from '@/components/Invoice';

/** Status of a queued message, with the plain-language reason when it was not sent. */
export function queueBadge(s: any, t: (k: string) => string) {
  const tone = s.status === 'sent' ? 'completed' : s.status === 'pending' || s.status === 'sending' ? 'scheduled' : s.status === 'failed' ? 'no_show' : 'cancelled';
  const reason = s.reason ? (t(`r_${s.reason}`) !== `r_${s.reason}` ? t(`r_${s.reason}`) : s.reason) : null;
  return <span className="inline-flex flex-col items-end">
    <Badge status={tone}>{t(`q_${s.status}`)}{s.status === 'sent' && s.delivery && s.delivery !== 'sent' ? ` · ${t(`msg_${s.delivery}`)}` : ''}</Badge>
    {reason && <span className="mt-0.5 max-w-64 text-end text-[11px] text-muted">{reason}</span>}
  </span>;
}

/** Patient file: WhatsApp consent, messages sent or scheduled for this patient, and sending a message. */
export function PatientMessages({ patientId }: { patientId: string }) {
  const { t, lang } = useI18n(); const { can, orgId } = useWorkspace();
  const consent = useLoad<any>(`/patients/${patientId}/consent`);
  const msgs = useLoad<any[]>(can('whatsapp.send') ? `/patients/${patientId}/messages` : null);
  const convs = useLoad<any[]>(can('whatsapp.send') ? `/whatsapp/conversations?filter=all&patient=${patientId}` : null);
  const [err, setErr] = useState<unknown>(null); const [open, setOpen] = useState(false);
  const c = consent.data; const agreed = c?.whatsapp?.opted_in === true;
  const setConsent = async (optedIn: boolean) => { try { consent.setData(await put(`/patients/${patientId}/consent`, { optedIn })); msgs.reload(); } catch (e) { setErr(e); } };
  return <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
    <Card title={t('consentLabel')}>
      {!c ? <p className="text-muted">{t('loading')}</p> : <div className="space-y-3 text-sm">
        <div className="flex items-center justify-between"><Badge status={agreed ? 'completed' : 'cancelled'}>{agreed ? t('consentYes') : t('consentNo')}</Badge>
          {(can('patient.register') || can('whatsapp.send')) && <Button size="sm" variant={agreed ? 'ghost' : 'secondary'} onClick={() => setConsent(!agreed)}>{agreed ? t('consentWithdraw') : t('consentGive')}</Button>}</div>
        <p className="text-xs text-muted">{t('consentHint')}</p>
        <p className="tabular">{t('whatsappNumberLabel')}: {c.number ? `+${c.number}` : '—'} · {t('language')}: {c.language?.toUpperCase()}</p>
        {c.history?.length > 0 && <div><p className="text-xs font-medium text-muted">{t('history')}</p><ul className="mt-1 space-y-0.5 text-xs">{c.history.map((h: any, i: number) => <li key={i} className="tabular">
          {fmtDate(h.created_at, lang)} · {h.opted_in ? t('consentYes') : t('consentNo')} · {t(`bySource_${h.source}`)}{h.recorded_by_name ? ` (${h.recorded_by_name})` : ''}</li>)}</ul></div>}
        {(convs.data ?? []).map((cv) => <Link key={cv.id} className="block text-brand hover:underline" href={`/w/${orgId}/messages?c=${cv.id}`}>✉ {t('openConversation')}</Link>)}
        <ErrorNote error={err ?? consent.error} />
      </div>}
    </Card>
    {can('whatsapp.send') && <Card title={t('messages')} actions={<Button size="sm" onClick={() => setOpen(true)}>+ {t('sendMessage')}</Button>}>
      {!msgs.data ? <p className="text-muted">{t('loading')}</p> : msgs.data.length === 0 ? <Empty>—</Empty> :
        <ul className="divide-y divide-line">{msgs.data.map((m) => <li key={m.id} className="flex flex-wrap items-start justify-between gap-2 py-2.5 text-sm">
          <div><p className="font-medium">{t(`p_${m.purpose}`)}</p><p className="text-xs text-muted tabular">{fmtDate(m.send_at, lang)} {fmtTime(m.send_at, lang)} · {m.created_by_name ?? t('automated')}</p></div>
          {queueBadge(m, t)}</li>)}</ul>}
    </Card>}
    {open && <SendDialog patientId={patientId} onClose={() => setOpen(false)} onSent={() => { setOpen(false); msgs.reload(); }} />}
  </div>;
}

export function SendDialog({ patientId, invoiceId, onClose, onSent }: { patientId: string; invoiceId?: string; onClose: () => void; onSent: (r: any) => void }) {
  const { t } = useI18n();
  const [purpose, setPurpose] = useState(invoiceId ? 'payment' : 'follow_up'); const [date, setDate] = useState(''); const [message, setMessage] = useState('');
  const [inv, setInv] = useState(invoiceId ?? ''); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false); const [result, setResult] = useState<any>(null);
  const invoices = useLoad<any[]>(purpose === 'payment' && !invoiceId ? `/patients/${patientId}/invoices` : null);
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await post(`/patients/${patientId}/messages`, { purpose, date: date || null, message: message.trim() || null, invoiceId: purpose === 'payment' ? inv || null : null, consultationId: null });
      setResult(r); if (r.status === 'sent') onSent(r);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return <Dialog open onClose={onClose} title={t('sendMessage')}>
    <div className="grid gap-3">
      <Field label={t('messageText')}><Select value={purpose} onChange={(e) => setPurpose(e.target.value)} disabled={!!invoiceId}>
        {['follow_up', 'vaccination', 'treatment', 'payment', 'announcement'].map((p) => <option key={p} value={p}>{t(`p_${p}`)}</option>)}</Select></Field>
      {(purpose === 'follow_up' || purpose === 'vaccination') && <Field label={t('dueDate')}><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>}
      {purpose === 'payment' && !invoiceId && <Field label={t('invoice')}><Select value={inv} onChange={(e) => setInv(e.target.value)}><option value="">—</option>
        {(invoices.data ?? []).filter((i) => i.kind === 'invoice' && i.status === 'issued' && Number(i.balance) > 0).map((i) => <option key={i.id} value={i.id}>{invoiceLabel(i, t)} · {i.balance} {i.currency}</option>)}</Select></Field>}
      {purpose === 'announcement' && <Field label={t('messageText')}><Textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={600} /></Field>}
      {result && result.status !== 'sent' && <div className="text-sm">{queueBadge(result, t)}</div>}
      <ErrorNote error={err} />
    </div>
    <div className="mt-4 flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>{t('cancel')}</Button><Button busy={busy} onClick={go}>{t('send')}</Button></div>
  </Dialog>;
}

/** Invoice page button: WhatsApp payment reminder for the open balance. */
export function PaymentReminderButton({ inv }: { inv: any }) {
  const { t } = useI18n(); const [open, setOpen] = useState(false); const [done, setDone] = useState(false);
  return <>
    <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>✉ {done ? `${t('paymentReminder')} ✓` : t('paymentReminder')}</Button>
    {open && <SendDialog patientId={inv.patient_id} invoiceId={inv.id} onClose={() => setOpen(false)} onSent={() => { setDone(true); setOpen(false); }} />}
  </>;
}

