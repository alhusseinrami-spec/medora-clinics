'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, ErrorNote, Field, Input, Textarea, fmtDate, fmtTime } from '@/components/ui';
import { PageTitle } from '@/components/Shell';
import { SpecialtyForm } from '@/components/SpecialtyForm';
import { PrescriptionEditor, newPrescription } from '@/components/PrescriptionEditor';
import { DocumentsPanel } from '@/components/DocumentsPanel';
import { del, get, patch, post, put } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { label as L, type TemplateSchema } from '@medora/shared';
import { useWorkspace } from '@/lib/workspace';
import { startInvoice } from '@/components/Invoice';

const VITALS: [string, string, string, number][] = [
  ['bp_systolic', 'bp', 'mmHg', 1], ['bp_diastolic', 'bp', 'mmHg', 1], ['pulse', 'pulse', 'bpm', 1], ['temperature_c', 'temperature', '°C', 0.1],
  ['spo2', 'spo2', '%', 1], ['resp_rate', 'respRate', '/min', 1], ['weight_kg', 'weight', 'kg', 0.1], ['height_cm', 'height', 'cm', 0.1],
];
/** With the SOAP note template, sections are labelled Subjective, Objective, Assessment and Plan. */
const SOAP: Record<string, string> = { chiefComplaint: 'subjective', examinationNotes: 'objective', clinicalNotes: 'subjective', treatmentPlan: 'plan', diagnoses: 'assessment', vitalSigns: 'objective' };
const soapLabel = (c: any, key: string, t: (k: string) => string) => (c.note_template === 'soap' && SOAP[key] ? `${t(SOAP[key]).charAt(0).toUpperCase()} · ${t(SOAP[key])} · ${t(key)}` : t(key));
const TEXTS: [string, string, string][] = [
  ['chiefComplaint', 'chief_complaint', 'chiefComplaint'], ['examination', 'examination', 'examinationNotes'], ['clinicalNotes', 'clinical_notes', 'clinicalNotes'],
  ['treatmentPlan', 'treatment_plan', 'treatmentPlan'], ['followUpInstructions', 'follow_up_instructions', 'followUpInstructions'],
];

export default function ConsultationPage({ params }: { params: Promise<{ orgId: string; consultationId: string }> }) {
  const { orgId, consultationId } = use(params);
  const { t, lang } = useI18n(); const { org, can } = useWorkspace(); const router = useRouter();
  const [c, setC] = useState<any>(null); const [err, setErr] = useState<unknown>(null);
  const [rxs, setRxs] = useState<any[]>([]);
  const load = useCallback(async () => {
    try {
      const r = await get(`/consultations/${consultationId}`); setC(r);
      setRxs(await Promise.all(r.prescriptions.map((p: any) => get(`/prescriptions/${p.id}`))));
    } catch (e) { setErr(e); }
  }, [consultationId]);
  useEffect(() => { load(); }, [load]);
  if (err) return <ErrorNote error={err} />;
  if (!c) return <p className="text-muted">{t('loading')}</p>;
  const mine = c.doctor_membership_id === org.me.doctorMembershipId;
  const editable = c.status === 'draft' && mine;
  const age = c.date_of_birth ? Math.floor((Date.now() - Date.parse(c.date_of_birth)) / (365.25 * 86400e3)) : null;

  return <>
    <PageTitle title={<>{t('consultation')} · <Link className="hover:underline" href={`/w/${orgId}/patients/${c.patient_id}`}>{c.patient_name}</Link></>}
      sub={<span className="tabular">{c.patient_number}{age !== null ? ` · ${age} y` : ''} · {fmtDate(c.created_at, lang)} {fmtTime(c.created_at, lang)} · {c.doctor_name}</span>}
      actions={<>{c.status === 'signed' && c.appointment_id && can('payment.register') && <Button size="sm" variant="secondary" onClick={() => startInvoice(org.organization.id, { appointmentId: c.appointment_id }).catch(setErr)}>{t('createInvoice')}</Button>}
        <Badge status={c.status}>{t(c.status)}</Badge></>} />
    {c.allergies && <p className="mb-4 rounded-[10px] bg-danger/10 p-3 text-sm font-medium text-danger">{t('allergyWarning')}: {c.allergies}</p>}
    {c.status === 'signed' && <p className="mb-4 rounded-[10px] bg-success/10 p-3 text-sm text-success">{t('signedBy')} {c.signed_by_name} · {fmtDate(c.signed_at, lang)} {fmtTime(c.signed_at, lang)}</p>}

    <div className="grid gap-6 xl:grid-cols-[1fr_420px]">
      <div className="space-y-6">
        <NotesCard c={c} editable={editable} onSaved={setC} />
        {c.template && editable && <Card title={`${t('examinationForm')} · v${c.template.version}`}>
          <SpecialtyForm schema={c.template.schema} initial={c.specialty_data ?? {}} dateOfBirth={c.date_of_birth}
            onSave={async (data) => { setC(await patch(`/consultations/${c.id}`, { specialtyData: data })); }} />
        </Card>}
        {c.template && !editable && <ExamSummary schema={c.template.schema} data={c.specialty_data ?? {}} version={c.template.version} />}
        <DiagnosesCard c={c} editable={editable} onSaved={setC} />
        {c.status === 'signed' && <AddendaCard c={c} canAdd={mine} onSaved={setC} />}
      </div>
      <div className="space-y-6">
        <Card title={t('prescriptions')} actions={editable && <Button size="sm" variant="secondary" onClick={async () => { try { await newPrescription(c.patient_id, c.id); await load(); } catch (e) { setErr(e); } }}>+ {t('newPrescription')}</Button>}>
          {rxs.length === 0 ? <p className="text-sm text-muted">{t('noPrescriptions')}</p> :
            <div className="space-y-5">{rxs.map((rx, i) => <div key={rx.id + rx.status} className={i ? 'border-t border-line pt-4' : ''}>
              <PrescriptionEditor rx={rx} onChange={(n) => { if (n === null) setRxs((xs) => xs.filter((x) => x.id !== rx.id)); else setRxs((xs) => xs.map((x) => (x.id === rx.id ? n : x))); }} />
            </div>)}</div>}
        </Card>
        <Card title={t('documents')}><DocumentsPanel patientId={c.patient_id} consultationId={c.id} compact readOnly={!editable} /></Card>
        {editable && <SignCard c={c} onSigned={setC} onDiscarded={() => router.push(`/w/${orgId}/waiting-room`)} />}
      </div>
    </div>
  </>;
}

function NotesCard({ c, editable, onSaved }: { c: any; editable: boolean; onSaved: (c: any) => void }) {
  const { t } = useI18n();
  const init = (): Record<string, any> => ({ ...Object.fromEntries(TEXTS.map(([k, col]) => [k, c[col] ?? ''])), followUpDate: c.follow_up_date ?? '', vitals: { ...(c.vital_signs ?? {}) } as Record<string, any> });
  const [f, setF] = useState(init); const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null); const [ok, setOk] = useState(false);
  const save = async () => {
    setBusy(true); setErr(null); setOk(false);
    try {
      const vitals = Object.fromEntries(Object.entries(f.vitals).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, Number(v)]));
      const body: Record<string, unknown> = { ...Object.fromEntries(TEXTS.map(([k]) => [k, (f as any)[k].trim() || null])), followUpDate: f.followUpDate || null, vitalSigns: Object.keys(vitals).length ? vitals : null };
      onSaved(await patch(`/consultations/${c.id}`, body)); setOk(true);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  if (!editable) return <Card title={t('consultation')}>
    {c.vital_signs && <p className="mb-3 text-sm tabular">{VITALS.filter(([k]) => c.vital_signs[k] != null).map(([k, l, u]) => `${t(l)} ${c.vital_signs[k]} ${u}`).join(' · ')}</p>}
    <dl className="space-y-3 text-sm">{TEXTS.map(([, col, l]) => c[col] && <div key={col}><dt className="text-muted">{soapLabel(c, l, t)}</dt><dd className="whitespace-pre-wrap">{c[col]}</dd></div>)}
      {c.follow_up_date && <div><dt className="text-muted">{t('followUpDate')}</dt><dd>{c.follow_up_date}</dd></div>}</dl>
  </Card>;
  return <Card title={t('consultation')}>
    <div className="space-y-4">
      <Field label={soapLabel(c, 'chiefComplaint', t)}><Textarea rows={2} value={f.chiefComplaint} onChange={(e) => setF({ ...f, chiefComplaint: e.target.value })} /></Field>
      <div><p className="mb-1.5 text-sm font-medium">{soapLabel(c, 'vitalSigns', t)}</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{VITALS.map(([k, l, u, step]) => <label key={k} className="text-xs text-muted">{t(l)}{k.startsWith('bp_') ? (k === 'bp_systolic' ? ' (sys)' : ' (dia)') : ''} · {u}
          <Input type="number" step={step} value={f.vitals[k] ?? ''} onChange={(e) => setF({ ...f, vitals: { ...f.vitals, [k]: e.target.value } })} /></label>)}</div></div>
      {TEXTS.slice(1).map(([k, , l]) => <Field key={k} label={soapLabel(c, l, t)}><Textarea rows={k === 'clinicalNotes' ? 5 : 3} value={(f as any)[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>)}
      <Field label={t('followUpDate')} className="max-w-xs"><Input type="date" value={f.followUpDate} onChange={(e) => setF({ ...f, followUpDate: e.target.value })} /></Field>
      <div className="flex items-center justify-end gap-3"><ErrorNote error={err} />{ok && <span className="text-sm text-success">{t('saved')}</span>}<Button busy={busy} onClick={save}>{t('save')}</Button></div>
    </div>
  </Card>;
}

function DiagnosesCard({ c, editable, onSaved }: { c: any; editable: boolean; onSaved: (c: any) => void }) {
  const { t } = useI18n();
  const [rows, setRows] = useState<{ code: string; description: string; isPrimary: boolean }[]>(() => c.diagnoses.map((d: any) => ({ code: d.code ?? '', description: d.description, isPrimary: d.is_primary })));
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null); const [ok, setOk] = useState(false);
  if (!editable) return <Card title={soapLabel(c, 'diagnoses', t)}>{c.diagnoses.length ? <ul className="space-y-1 text-sm">{c.diagnoses.map((d: any) => <li key={d.id}>
    {d.code && <span className="me-2 font-mono text-xs text-muted">{d.code}</span>}{d.description}{d.is_primary && <Badge className="ms-2">{t('primary')}</Badge>}</li>)}</ul> : <p className="text-sm text-muted">—</p>}</Card>;
  const save = async () => {
    setBusy(true); setErr(null); setOk(false);
    try { onSaved(await put(`/consultations/${c.id}/diagnoses`, { diagnoses: rows.filter((r) => r.description.trim()).map((r) => ({ code: r.code.trim() || null, description: r.description.trim(), isPrimary: r.isPrimary })) })); setOk(true); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return <Card title={soapLabel(c, 'diagnoses', t)}>
    <div className="space-y-2">{rows.map((r, i) => <div key={i} className="grid items-center gap-2 sm:grid-cols-[140px_1fr_auto_auto]">
      <Input value={r.code} placeholder={t('icdCode')} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)))} />
      <Input value={r.description} placeholder={t('diagnosis')} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
      <label className="flex items-center gap-1.5 text-sm"><input type="radio" name="primary" checked={r.isPrimary} onChange={() => setRows(rows.map((x, j) => ({ ...x, isPrimary: j === i })))} />{t('primary')}</label>
      <Button size="sm" variant="ghost" aria-label={t('remove')} onClick={() => setRows(rows.filter((_, j) => j !== i))}>✕</Button>
    </div>)}</div>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
      <Button size="sm" variant="secondary" onClick={() => setRows([...rows, { code: '', description: '', isPrimary: rows.length === 0 }])}>+ {t('addDiagnosis')}</Button>
      <div className="flex items-center gap-3"><ErrorNote error={err} />{ok && <span className="text-sm text-success">{t('saved')}</span>}<Button busy={busy} onClick={save}>{t('save')}</Button></div>
    </div>
  </Card>;
}

function AddendaCard({ c, canAdd, onSaved }: { c: any; canAdd: boolean; onSaved: (c: any) => void }) {
  const { t, lang } = useI18n(); const [body, setBody] = useState(''); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  return <Card title={t('addenda')}>
    {c.addenda.length > 0 && <ul className="mb-4 space-y-3">{c.addenda.map((a: any) => <li key={a.id} className="rounded-[10px] border border-line p-3 text-sm">
      <p className="text-xs text-muted tabular">{a.author} · {fmtDate(a.created_at, lang)} {fmtTime(a.created_at, lang)}</p><p className="mt-1 whitespace-pre-wrap">{a.body}</p></li>)}</ul>}
    {canAdd && <><p className="mb-2 text-xs text-muted">{t('addendumHint')}</p>
      <Textarea value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="mt-2 flex items-center justify-end gap-3"><ErrorNote error={err} />
        <Button busy={busy} disabled={!body.trim()} onClick={async () => { setBusy(true); setErr(null); try { onSaved(await post(`/consultations/${c.id}/addenda`, { body: body.trim() })); setBody(''); } catch (e) { setErr(e); } finally { setBusy(false); } }}>{t('addAddendum')}</Button></div></>}
  </Card>;
}

function SignCard({ c, onSigned, onDiscarded }: { c: any; onSigned: (c: any) => void; onDiscarded: () => void }) {
  const { t } = useI18n(); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState<string | null>(null);
  return <Card>
    <p className="mb-3 text-sm text-muted">{t('signConfirm')}</p>
    <ErrorNote error={err} />
    <div className="mt-3 flex flex-wrap justify-end gap-2">
      <Button variant="ghost" busy={busy === 'discard'} onClick={async () => { if (!confirm(t('discardConfirm'))) return; setBusy('discard'); try { await del(`/consultations/${c.id}`); onDiscarded(); } catch (e) { setErr(e); setBusy(null); } }}>{t('discardDraft')}</Button>
      <Button busy={busy === 'sign'} onClick={async () => { if (!confirm(t('signConfirm'))) return; setBusy('sign'); setErr(null); try { onSigned(await post(`/consultations/${c.id}/sign`)); } catch (e) { setErr(e); } finally { setBusy(null); } }}>{t('signConsultation')}</Button>
    </div>
  </Card>;
}

/** Signed or someone else's consultation: only the examination values that were recorded, as text. */
function ExamSummary({ schema, data, version }: { schema: TemplateSchema; data: Record<string, any>; version: number }) {
  const { t, lang } = useI18n();
  const fmt = (v: any): string => Array.isArray(v) ? v.map((x) => (typeof x === 'object' ? Object.values(x).filter((y) => y !== '' && y != null).join(' · ') : String(x))).join('; ')
    : typeof v === 'boolean' ? (v ? t('yes') : t('no')) : String(v);
  const sections = schema.sections.map((s) => ({ s, rows: s.fields.filter((f) => data[s.key]?.[f.key] !== undefined && data[s.key]?.[f.key] !== '' && data[s.key]?.[f.key] !== null) }))
    .filter((x) => x.rows.length);
  return <Card title={`${t('examinationForm')} · v${version}`}>
    {sections.length === 0 ? <p className="text-sm text-muted">—</p> : <div className="space-y-4">{sections.map(({ s, rows }) => <div key={s.key}>
      <p className="mb-1 text-sm font-semibold">{L(s.label, lang)}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">{rows.map((f) => <div key={f.key} className="contents">
        <dt className="text-muted">{L(f.label, lang)}</dt><dd className="whitespace-pre-wrap">{fmt(data[s.key][f.key])}{f.unit ? ` ${f.unit}` : ''}</dd></div>)}</dl>
    </div>)}</div>}
  </Card>;
}
