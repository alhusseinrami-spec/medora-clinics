'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, Card, Dialog, Empty, ErrorNote, Field, Input, Select, Tabs, Textarea, fmtDate, fmtMoney } from '@/components/ui';
import { Forbidden, PageTitle } from '@/components/Shell';
import { invoiceLabel } from '@/components/Invoice';
import { get, patch, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useWorkspace } from '@/lib/workspace';
import { useLoad } from '@/lib/hooks';

const STATUSES = ['all', 'draft', 'submitted', 'approved', 'partially_approved', 'rejected', 'reimbursed'];

export default function Insurance() {
  const { t } = useI18n(); const { can } = useWorkspace();
  const [tab, setTab] = useState('claims');
  if (!can('insurance.manage')) return <Forbidden />;
  return <>
    <PageTitle title={t('insurance')} />
    <p className="mb-4 rounded-[10px] bg-info/10 p-3 text-sm text-info">{t('noIntegration')}</p>
    <Tabs tabs={[{ key: 'claims', label: t('claims') }, { key: 'providers', label: t('providers') }]} value={tab} onChange={setTab} />
    <div className="mt-5">{tab === 'claims' ? <Claims /> : <Providers />}</div>
  </>;
}

function Claims() {
  const { t, lang } = useI18n(); const { orgId } = useWorkspace();
  const [status, setStatus] = useState('all'); const [open, setOpen] = useState<any>(null);
  const { data, error, reload } = useLoad<any[]>(`/claims${status === 'all' ? '' : `?status=${status}`}`);
  return <>
    <div className="mb-3 flex flex-wrap gap-2">{STATUSES.map((s) => <button key={s} onClick={() => setStatus(s)}
      className={`rounded-full px-3 py-1 text-xs ${status === s ? 'bg-brand text-white' : 'bg-surface text-muted hover:text-ink'}`}>{s === 'all' ? t('all') : t(s)}</button>)}</div>
    <ErrorNote error={error} />
    {!data ? <p className="text-muted">{t('loading')}</p> : data.length === 0 ? <Empty>{t('noClaims')}</Empty> :
      <Card><table className="w-full text-sm"><thead><tr className="text-xs text-muted"><th className="py-2 text-start">{t('patients')}</th><th className="text-start">{t('providers')}</th>
        <th className="hidden text-start md:table-cell">{t('invoiceNo')}</th><th className="text-end">{t('claimAmount')}</th><th className="text-end">{t('approvedAmount')}</th><th className="text-end"></th></tr></thead>
        <tbody>{data.map((c) => <tr key={c.id} className="cursor-pointer border-t border-line hover:bg-surface" onClick={() => setOpen(c.id)}>
          <td className="py-2">{c.patient_name}<span className="block text-xs text-muted tabular">{c.patient_number} · {fmtDate(c.created_at, lang)}</span></td>
          <td>{c.provider_name}<span className="block text-xs text-muted tabular">{c.policy_number}{c.claim_number ? ` · ${c.claim_number}` : ''}</span></td>
          <td className="hidden tabular md:table-cell">{invoiceLabel({ kind: 'invoice', invoice_number: c.invoice_number, status: 'issued' }, t)}</td>
          <td className="text-end tabular">{fmtMoney(c.amount_claimed, c.currency, lang)}</td>
          <td className="text-end tabular">{c.amount_approved != null ? fmtMoney(c.amount_approved, c.currency, lang) : '—'}</td>
          <td className="text-end"><Badge status={c.status}>{t(c.status)}</Badge></td></tr>)}</tbody></table></Card>}
    {open && <ClaimDialog id={open} orgId={orgId} onClose={() => setOpen(null)} onChange={reload} />}
  </>;
}

function ClaimDialog({ id, orgId, onClose, onChange }: { id: string; orgId: string; onClose: () => void; onChange: () => void }) {
  const { t, lang } = useI18n();
  const { data: c, error, setData } = useLoad<any>(`/claims/${id}`);
  const [ref, setRef] = useState(''); const [decision, setDecision] = useState('approved'); const [approved, setApproved] = useState(''); const [reason, setReason] = useState('');
  const [amount, setAmount] = useState(''); const [currency, setCurrency] = useState('USD'); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const run = async (path: string, body: object) => {
    setBusy(true); setErr(null);
    try { setData(await post(`/claims/${id}/${path}`, body)); onChange(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return <Dialog open onClose={onClose} title={t('claims')} wide>
    <ErrorNote error={error} />
    {!c ? <p className="text-muted">{t('loading')}</p> : <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div><p className="font-medium">{c.patient_name} <span className="text-muted tabular">{c.patient_number}</span></p>
          <p className="text-muted">{c.provider_name} · {c.policy_number}{c.claim_number ? ` · ${t('claimNumber')} ${c.claim_number}` : ''}</p>
          <Link className="text-brand hover:underline tabular" href={`/w/${orgId}/billing/${c.invoice_id}`}>{invoiceLabel({ kind: 'invoice', invoice_number: c.invoice_number, status: 'issued' }, t)}</Link></div>
        <Badge status={c.status}>{t(c.status)}</Badge>
      </div>
      <dl className="grid grid-cols-2 gap-2 tabular">
        <dt className="text-muted">{t('claimAmount')}</dt><dd>{fmtMoney(c.amount_claimed, c.currency, lang)}</dd>
        {c.amount_approved != null && <><dt className="text-muted">{t('approvedAmount')}</dt><dd>{fmtMoney(c.amount_approved, c.currency, lang)}</dd></>}
        {c.submitted_at && <><dt className="text-muted">{t('submitted')}</dt><dd>{fmtDate(c.submitted_at, lang)}</dd></>}
        {c.decided_at && <><dt className="text-muted">{t('decision')}</dt><dd>{fmtDate(c.decided_at, lang)}</dd></>}
        {c.reimbursed_at && <><dt className="text-muted">{t('reimbursed')}</dt><dd>{fmtDate(c.reimbursed_at, lang)}</dd></>}
      </dl>
      {c.rejection_reason && <p className="text-muted">{t('reason')}: {c.rejection_reason}</p>}
      {c.documents?.length > 0 && <div><p className="text-xs text-muted">{t('documents')}</p><ul>{c.documents.map((d: any) => <li key={d.id}>{d.title}</li>)}</ul></div>}
      <ClaimDocs claim={c} onAdded={setData} />

      {c.status === 'draft' && <div className="flex items-end gap-2 border-t border-line pt-4">
        <Field className="flex-1" label={t('claimNumber')}><Input value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
        <Button busy={busy} onClick={() => run('submit', { claimNumber: ref.trim() || null })}>{t('submit')}</Button></div>}

      {c.status === 'submitted' && <div className="grid gap-3 border-t border-line pt-4 sm:grid-cols-2">
        <Field label={t('decision')}><Select value={decision} onChange={(e) => setDecision(e.target.value)}>
          {['approved', 'partially_approved', 'rejected'].map((s) => <option key={s} value={s}>{t(s)}</option>)}</Select></Field>
        {decision !== 'rejected' && <Field label={`${t('approvedAmount')} (${c.currency})`}><Input type="number" min={0} placeholder={String(c.amount_claimed)} value={approved} onChange={(e) => setApproved(e.target.value)} /></Field>}
        <Field className="sm:col-span-2" label={t('reason')}><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <div className="sm:col-span-2 flex justify-end"><Button busy={busy} onClick={() => run('decision', { status: decision, reason: reason.trim() || null, claimNumber: null,
          ...(decision !== 'rejected' && Number(approved) > 0 ? { amountApproved: Number(approved) } : {}) })}>{t('decision')}</Button></div></div>}

      {['approved', 'partially_approved'].includes(c.status) && <div className="grid gap-3 border-t border-line pt-4 sm:grid-cols-3">
        <Field label={t('amount')}><Input type="number" min={0} placeholder={String(c.amount_approved)} value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label={t('currency')}><Select value={currency} onChange={(e) => setCurrency(e.target.value)}><option>USD</option><option>LBP</option></Select></Field>
        <Field label={t('reference')}><Input value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
        <div className="sm:col-span-3 flex justify-end"><Button busy={busy} onClick={() => run('reimburse', { amount: Number(amount) || Number(c.amount_approved), currency, reference: ref.trim() || null })}>{t('reimburse')}</Button></div></div>}
      <ErrorNote error={err} />
    </div>}
  </Dialog>;
}

function ClaimDocs({ claim, onAdded }: { claim: any; onAdded: (c: any) => void }) {
  const { t } = useI18n(); const [docs, setDocs] = useState<any[] | null>(null); const [sel, setSel] = useState(''); const [err, setErr] = useState<unknown>(null);
  if (claim.status === 'reimbursed') return null;
  if (!docs) return <Button size="sm" variant="ghost" onClick={() => get<any[]>(`/patients/${claim.patient_id}/documents`).then(setDocs).catch(setErr)}>+ {t('documents')}</Button>;
  const attached = new Set((claim.documents ?? []).map((d: any) => d.id));
  const free = docs.filter((d) => !attached.has(d.id));
  return <div className="flex items-end gap-2">
    <Field className="flex-1" label={t('documents')}><Select value={sel} onChange={(e) => setSel(e.target.value)}><option value="">—</option>{free.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}</Select></Field>
    <Button size="sm" disabled={!sel} onClick={async () => { try { onAdded(await post(`/claims/${claim.id}/documents`, { documentId: sel })); setSel(''); } catch (e) { setErr(e); } }}>+</Button>
    <ErrorNote error={err} />
  </div>;
}

function Providers() {
  const { t } = useI18n();
  const { data, error, reload } = useLoad<any[]>('/insurance/providers');
  const [open, setOpen] = useState(false);
  return <>
    <div className="mb-3 flex justify-end"><Button onClick={() => setOpen(true)}>+ {t('addProvider')}</Button></div>
    <ErrorNote error={error} />
    {!data ? <p className="text-muted">{t('loading')}</p> : data.length === 0 ? <Empty>—</Empty> :
      <Card><ul className="divide-y divide-line">{data.map((p) => <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
        <div><p className="font-medium">{p.name} {!p.is_active && <Badge status="cancelled">{t('void')}</Badge>}</p>
          <p className="text-xs text-muted">{t(p.kind === 'other' ? 'revenueOther' : p.kind)}{p.phone ? ` · ${p.phone}` : ''}{p.email ? ` · ${p.email}` : ''}</p></div>
        {p.platform ? <Badge>{t('platformDirectory')}</Badge> :
          <Button size="sm" variant="ghost" onClick={async () => { await patch(`/insurance/providers/${p.id}`, { isActive: !p.is_active, phone: p.phone, email: p.email, notes: p.notes }); reload(); }}>{p.is_active ? t('void') : t('active')}</Button>}
      </li>)}</ul></Card>}
    <ProviderDialog open={open} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); reload(); }} />
  </>;
}

function ProviderDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [f, setF] = useState({ name: '', kind: 'private', phone: '', email: '', notes: '' }); const [err, setErr] = useState<unknown>(null);
  const s = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return <Dialog open={open} onClose={onClose} title={t('addProvider')}>
    <div className="grid gap-3">
      <Field label={t('insurerName')}><Input value={f.name} onChange={s('name')} /></Field>
      <Field label={t('insurerKind')}><Select value={f.kind} onChange={s('kind')}><option value="private">{t('private')}</option><option value="nssf">{t('nssf')}</option><option value="other">{t('revenueOther')}</option></Select></Field>
      <Field label={t('phone')}><Input value={f.phone} onChange={s('phone')} /></Field>
      <Field label={t('email')}><Input type="email" value={f.email} onChange={s('email')} /></Field>
      <Field label={t('notes')}><Textarea value={f.notes} onChange={s('notes')} /></Field>
    </div>
    <div className="mt-3"><ErrorNote error={err} /></div>
    <div className="mt-4 flex justify-end"><Button disabled={f.name.trim().length < 2} onClick={async () => {
      try { await post('/insurance/providers', { name: f.name.trim(), kind: f.kind, phone: f.phone.trim() || null, email: f.email.trim() || null, notes: f.notes.trim() || null }); setF({ name: '', kind: 'private', phone: '', email: '', notes: '' }); onSaved(); } catch (e) { setErr(e); }
    }}>{t('save')}</Button></div>
  </Dialog>;
}
