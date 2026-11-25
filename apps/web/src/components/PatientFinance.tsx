'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, Card, Dialog, Empty, ErrorNote, Field, Input, Select, Textarea, fmtDate, fmtMoney } from '@/components/ui';
import { balanceBadge, invoiceLabel, startInvoice } from '@/components/Invoice';
import { patch, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useWorkspace } from '@/lib/workspace';
import { useLoad } from '@/lib/hooks';

export { startInvoice };

/** The patient's invoices and credit notes in this workspace (doctors see only their own, enforced by the database). */
export function PatientBilling({ patientId }: { patientId: string }) {
  const { t, lang } = useI18n(); const { can, orgId } = useWorkspace(); const [err, setErr] = useState<unknown>(null);
  const { data, error } = useLoad<any[]>(`/patients/${patientId}/invoices`);
  return <Card title={t('invoices')} actions={can('payment.register') && <Button size="sm" onClick={() => startInvoice(orgId, { patientId }).catch(setErr)}>+ {t('newInvoice')}</Button>}>
    <ErrorNote error={error ?? err} />
    {!data ? <p className="text-muted">{t('loading')}</p> : data.length === 0 ? <Empty>{t('noInvoices')}</Empty> : <>
      <ul className="divide-y divide-line">{data.map((i) => <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
        <div><Link className="font-medium text-brand hover:underline tabular" href={`/w/${orgId}/billing/${i.id}`}>{invoiceLabel(i, t)}</Link>
          <p className="text-xs text-muted tabular">{fmtDate(i.issued_at ?? i.created_at, lang)}{i.doctor_name ? ` · ${i.doctor_name}` : ''}</p></div>
        <div className="flex items-center gap-3"><span className="tabular">{fmtMoney(i.total, i.currency, lang)}</span>{balanceBadge(i, t)}</div></li>)}</ul></>}
  </Card>;
}

type Policy = Record<string, any>;
const EMPTY = { providerId: '', policyNumber: '', memberName: '', relationship: '', coveragePercent: '', annualCeiling: '', coveredServices: '', nonCoveredServices: '', notes: '', validFrom: '', validUntil: '' };

/** Insurance policies on the patient's file. */
export function PatientPolicies({ patientId }: { patientId: string }) {
  const { t, lang } = useI18n(); const { can } = useWorkspace();
  const { data, error, reload } = useLoad<Policy[]>(`/patients/${patientId}/policies`);
  const [edit, setEdit] = useState<Policy | 'new' | null>(null);
  const canEdit = can('insurance.manage') || can('patient.register');
  return <Card title={t('policies')} actions={canEdit && <Button size="sm" onClick={() => setEdit('new')}>+ {t('addPolicy')}</Button>}>
    <ErrorNote error={error} />
    {!data ? <p className="text-muted">{t('loading')}</p> : data.length === 0 ? <Empty>—</Empty> :
      <ul className="divide-y divide-line">{data.map((p) => <li key={p.id} className="flex flex-wrap items-start justify-between gap-2 py-3 text-sm">
        <div><p className="font-medium">{p.provider_name} · <span className="tabular">{p.policy_number}</span> {!p.is_active && <Badge status="cancelled">{t('void')}</Badge>}</p>
          <p className="text-xs text-muted tabular">{p.coverage_percent != null ? `${t('coverage')} ${p.coverage_percent}%` : ''}{p.annual_ceiling != null ? ` · ${t('ceiling')} ${fmtMoney(p.annual_ceiling, 'USD', lang)}` : ''}
            {p.valid_until ? ` · ${t('validUntil')} ${fmtDate(p.valid_until, lang)}` : ''}{p.member_name ? ` · ${p.member_name}${p.relationship ? ` (${p.relationship})` : ''}` : ''}</p>
          {p.covered_services && <p className="text-xs">{t('coveredServices')}: {p.covered_services}</p>}
          {p.non_covered_services && <p className="text-xs">{t('nonCoveredServices')}: {p.non_covered_services}</p>}</div>
        {canEdit && <Button size="sm" variant="ghost" onClick={() => setEdit(p)}>{t('edit')}</Button>}</li>)}</ul>}
    {edit && <PolicyDialog patientId={patientId} policy={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
  </Card>;
}

function PolicyDialog({ patientId, policy, onClose, onSaved }: { patientId: string; policy: Policy | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const providers = useLoad<any[]>('/insurance/providers');
  const d = (x: any) => (x ? String(x).slice(0, 10) : '');
  const [f, setF] = useState(policy ? { providerId: policy.provider_id, policyNumber: policy.policy_number, memberName: policy.member_name ?? '', relationship: policy.relationship ?? '',
    coveragePercent: policy.coverage_percent ?? '', annualCeiling: policy.annual_ceiling ?? '', coveredServices: policy.covered_services ?? '', nonCoveredServices: policy.non_covered_services ?? '',
    notes: policy.notes ?? '', validFrom: d(policy.valid_from), validUntil: d(policy.valid_until) } : EMPTY);
  const [active, setActive] = useState(policy ? policy.is_active : true); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const s = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const txt = (x: any) => (String(x ?? '').trim() || null); const num = (x: any) => (String(x ?? '').trim() === '' ? null : Number(x));
  const save = async () => {
    setBusy(true); setErr(null);
    const body = { providerId: f.providerId, policyNumber: String(f.policyNumber).trim(), memberName: txt(f.memberName), relationship: txt(f.relationship), coveragePercent: num(f.coveragePercent),
      annualCeiling: num(f.annualCeiling), coveredServices: txt(f.coveredServices), nonCoveredServices: txt(f.nonCoveredServices), notes: txt(f.notes),
      validFrom: txt(f.validFrom), validUntil: txt(f.validUntil), cardDocumentId: policy?.card_document_id ?? null, isActive: active };
    try { await (policy ? patch(`/policies/${policy.id}`, body) : post(`/patients/${patientId}/policies`, body)); onSaved(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return <Dialog open onClose={onClose} title={policy ? t('policies') : t('addPolicy')} wide>
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={t('providers')}><Select value={f.providerId} onChange={s('providerId')}><option value="">—</option>
        {(providers.data ?? []).filter((p) => p.is_active || p.id === f.providerId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
      <Field label={t('policyNumber')}><Input value={f.policyNumber} onChange={s('policyNumber')} /></Field>
      <Field label={t('memberName')}><Input value={f.memberName} onChange={s('memberName')} /></Field>
      <Field label={t('relationship')}><Input value={f.relationship} onChange={s('relationship')} /></Field>
      <Field label={t('coverage')}><Input type="number" min={0} max={100} value={f.coveragePercent} onChange={s('coveragePercent')} /></Field>
      <Field label={t('ceiling')}><Input type="number" min={0} value={f.annualCeiling} onChange={s('annualCeiling')} /></Field>
      <Field label={t('validFrom')}><Input type="date" value={f.validFrom} onChange={s('validFrom')} /></Field>
      <Field label={t('validUntil')}><Input type="date" value={f.validUntil} onChange={s('validUntil')} /></Field>
      <Field className="sm:col-span-2" label={t('coveredServices')}><Textarea value={f.coveredServices} onChange={s('coveredServices')} /></Field>
      <Field className="sm:col-span-2" label={t('nonCoveredServices')}><Textarea value={f.nonCoveredServices} onChange={s('nonCoveredServices')} /></Field>
      <Field className="sm:col-span-2" label={t('notes')}><Textarea value={f.notes} onChange={s('notes')} /></Field>
      {policy && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> {t('active')}</label>}
    </div>
    <div className="mt-3"><ErrorNote error={err} /></div>
    <div className="mt-4 flex justify-end"><Button busy={busy} disabled={!f.providerId || !String(f.policyNumber).trim()} onClick={save}>{t('save')}</Button></div>
  </Dialog>;
}
