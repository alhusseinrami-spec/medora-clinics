'use client';
import { use, useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Dialog, Empty, ErrorNote, Field, Select, Tabs, fmtDate, fmtTime } from '@/components/ui';
import { PageTitle } from '@/components/Shell';
import { PatientForm, fromPatient } from '@/components/PatientForm';
import { SpecialtyForm } from '@/components/SpecialtyForm';
import { AppointmentDialog } from '@/components/AppointmentDialog';
import { ApptActions } from '@/components/ApptActions';
import { ApiError, get, patch, post, put } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useWorkspace } from '@/lib/workspace';
import { useLoad, type Member } from '@/lib/hooks';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PrescriptionEditor, newPrescription } from '@/components/PrescriptionEditor';
import { DocumentsPanel } from '@/components/DocumentsPanel';
import { PatientBilling, PatientPolicies, startInvoice } from '@/components/PatientFinance';

export default function PatientFile({ params }: { params: Promise<{ patientId: string }> }) {
  const { patientId } = use(params);
  const { t, lang, status } = useI18n(); const { can, org } = useWorkspace();
  const [p, setP] = useState<any>(null); const [err, setErr] = useState<unknown>(null); const [tab, setTab] = useState('overview');
  const [edit, setEdit] = useState(false); const [book, setBook] = useState(false); const [linkOpen, setLinkOpen] = useState(false);
  const load = useCallback(() => get(`/patients/${patientId}`).then(setP).catch(setErr), [patientId]);
  useEffect(() => { load(); }, [load]);
  if (err) return <ErrorNote error={err} />;
  if (!p) return <p className="text-muted">{t('loading')}</p>;
  const tabs = [{ key: 'overview', label: t('overview') }, ...(can('patient.history.read') && org.me.actingDoctors.length ? [{ key: 'specialty', label: t('specialtyLabel') }] : []),
    ...(can('clinical_notes.read') ? [{ key: 'consultations', label: t('consultations') }] : []),
    ...(can('prescription.view') ? [{ key: 'prescriptions', label: t('prescriptions') }] : []),
    { key: 'documents', label: t('documents') },
    ...(can('appointment.manage') ? [{ key: 'appointments', label: t('appointments') }] : []),
    ...(can('payment.register') || can('finance.view') ? [{ key: 'billing', label: t('billing') }] : []),
    ...(can('patient.file.read') ? [{ key: 'insurance', label: t('insurance') }] : []), { key: 'timeline', label: t('timeline') }];
  const age = p.date_of_birth ? Math.floor((Date.now() - Date.parse(p.date_of_birth)) / (365.25 * 86400e3)) : null;
  return (
    <>
      <PageTitle title={p.full_name} sub={<span className="tabular">{p.patient_number}{age !== null ? ` · ${age} y` : ''}{p.sex ? ` · ${t(p.sex)}` : ''} · {p.doctors.map((d: any) => d.full_name).join(', ') || '—'}</span>}
        actions={<>{can('patient.register') && <Button variant="secondary" onClick={() => setEdit(true)}>{t('edit')}</Button>}{can('appointment.manage') && <Button onClick={() => setBook(true)}>{t('newAppointment')}</Button>}</>} />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      <div className="mt-5">
        {tab === 'overview' && <div className="grid gap-6 lg:grid-cols-2">
          <Card title={t('personal')}>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              {([['dateOfBirth', p.date_of_birth && fmtDate(p.date_of_birth, lang)], ['phone', p.phone], ['whatsapp', p.whatsapp_number], ['email', p.email], ['address', p.address], ['nationalId', p.national_id],
                ['emergencyContact', p.emergency_contact && `${p.emergency_contact.name} · ${p.emergency_contact.phone}`], ['language', p.preferred_language?.toUpperCase()]] as [string, any][]).map(([k, v]) =>
                <div key={k} className="contents"><dt className="text-muted">{t(k)}</dt><dd>{v || '—'}</dd></div>)}
            </dl>
          </Card>
          {'allergies' in p ? <Card title={t('medicalHistory')}>
            <dl className="space-y-2 text-sm">{([['bloodType', p.blood_type], ['allergies', p.allergies], ['chronicDiseases', p.chronic_diseases], ['currentMedications', p.current_medications], ['medicalHistory', p.medical_history]] as [string, any][]).map(([k, v]) =>
              <div key={k}><dt className="text-muted">{t(k)}</dt><dd className={k === 'allergies' && v ? 'font-medium text-danger' : ''}>{v || '—'}</dd></div>)}</dl>
          </Card> : <Card title={t('medicalHistory')}><p className="text-sm text-muted">{t('noPermission')}</p></Card>}
          <Card title={t('doctor')} actions={can('patient.register') && org.organization.kind === 'medical_center' && <Button size="sm" variant="ghost" onClick={() => setLinkOpen(true)}>+ {t('add')}</Button>}>
            <ul className="space-y-1 text-sm">{p.doctors.map((d: any) => <li key={d.membership_id}>{d.full_name} <span className="text-muted">· {d.specialty_code}</span></li>)}</ul>
          </Card>
        </div>}
        {tab === 'specialty' && <SpecialtyTab patientId={patientId} />}
        {tab === 'consultations' && <Consultations patientId={patientId} />}
        {tab === 'prescriptions' && <Prescriptions patientId={patientId} />}
        {tab === 'documents' && <DocumentsPanel patientId={patientId} />}
        {tab === 'appointments' && <PatientAppointments patientId={patientId} />}
        {tab === 'billing' && <PatientBilling patientId={patientId} />}
        {tab === 'insurance' && <PatientPolicies patientId={patientId} />}
        {tab === 'timeline' && <Timeline patientId={patientId} />}
      </div>
      <Dialog open={edit} onClose={() => setEdit(false)} title={t('edit')} wide>
        <PatientForm initial={fromPatient(p)} submitLabel={t('save')} onSubmit={async (b) => { setP(await patch(`/patients/${patientId}`, b)); setEdit(false); }} />
      </Dialog>
      <AppointmentDialog open={book} onClose={() => setBook(false)} onSaved={load} patient={{ id: p.id, full_name: p.full_name }} />
      <LinkDoctor open={linkOpen} onClose={() => setLinkOpen(false)} patient={p} onDone={(np) => { setP(np); setLinkOpen(false); }} />
    </>
  );
}

function SpecialtyTab({ patientId }: { patientId: string }) {
  const { t } = useI18n();
  const [s, setS] = useState<any>(null); const [err, setErr] = useState<unknown>(null); const [fe, setFe] = useState<any[]>([]); const [k, setK] = useState(0);
  useEffect(() => { get(`/patients/${patientId}/specialty`).then(setS).catch(setErr); }, [patientId, k]);
  if (err) return <ErrorNote error={err} />;
  if (!s) return <p className="text-muted">{t('loading')}</p>;
  const olderVersion = s.saved && s.saved.versionId !== s.current.versionId;
  return <div className="space-y-4">
    <p className="text-xs text-muted">{t('version')} {s.current.version}{s.current.isCustom ? ' (custom)' : ' (preset)'}{s.saved ? ` · last saved ${new Date(s.saved.updatedAt).toLocaleString()} by ${s.saved.updatedBy ?? '—'}` : ''}</p>
    {olderVersion && <p className="rounded-[10px] bg-info/10 p-3 text-sm text-info">This record was saved with template version {s.saved.version}. Saving now records it under your current version {s.current.version}; the earlier version stays unchanged.</p>}
    <SpecialtyForm key={k} schema={s.current.schema} initial={s.saved?.data ?? {}} dateOfBirth={s.dateOfBirth} fieldErrors={fe}
      onSave={async (data) => { try { await put(`/patients/${patientId}/specialty`, { data }); setFe([]); setK(k + 1); } catch (e) { if (e instanceof ApiError) setFe(e.body?.fieldErrors ?? []); throw e; } }} />
  </div>;
}

function PatientAppointments({ patientId }: { patientId: string }) {
  const { t, lang, status } = useI18n(); const { can, orgId } = useWorkspace(); const [err, setErr] = useState<unknown>(null);
  const from = new Date(Date.now() - 60 * 86400e3).toISOString(); const to = new Date(Date.now() + 60 * 86400e3).toISOString();
  const { data, reload } = useLoad<any[]>(`/appointments?from=${from}&to=${to}&patient=${patientId}`);
  if (!data) return <p className="text-muted">{t('loading')}</p>;
  if (!data.length) return <Empty>{t('noAppointments')}</Empty>;
  return <Card><ul className="divide-y divide-line">{data.map((a) => <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
    <div><p className="font-medium tabular">{fmtDate(a.starts_at, lang)} · {fmtTime(a.starts_at, lang)}</p><p className="text-xs text-muted">{a.doctor_name} {a.service_name ? `· ${a.service_name}` : ''}</p></div>
    <div className="flex items-center gap-2"><Badge status={a.status}>{status(a.status)}</Badge><ApptActions appt={a} onDone={reload} compact />
      {a.status === 'completed' && can('payment.register') && <Button size="sm" variant="secondary" onClick={() => startInvoice(orgId, { appointmentId: a.id }).catch(setErr)}>{t('createInvoice')}</Button>}</div></li>)}</ul>
    <ErrorNote error={err} /></Card>;
}

function Timeline({ patientId }: { patientId: string }) {
  const { t, lang, status } = useI18n(); const { orgId } = useWorkspace();
  const { data } = useLoad<any[]>(`/patients/${patientId}/timeline`);
  if (!data) return <p className="text-muted">{t('loading')}</p>;
  const line = (e: any) => {
    switch (e.kind) {
      case 'registered': return t('patientRegistered');
      case 'appointment': return <>{t('appointments')} · {e.doctor} · <Badge status={e.status}>{status(e.status)}</Badge></>;
      case 'consultation': return <Link className="hover:underline" href={`/w/${orgId}/consultations/${e.ref}`}>{t('consultation')} · {e.doctor} · <Badge status={e.status}>{t(e.status)}</Badge></Link>;
      case 'prescription': return <>{t('prescription')} · {e.doctor} · <Badge status={e.status === 'issued' ? 'issued' : e.status === 'draft' ? 'draft' : 'cancelled'}>{e.status === 'cancelled' ? t('cancelledRx') : t(e.status)}</Badge></>;
      case 'document': return <>{t('documents')} · {t(e.status)} · {e.doctor ?? '—'}</>;
      default: return `${t('specialtyUpdated')} (${e.status}) · ${e.doctor ?? '—'}`;
    }
  };
  return <Card><ol className="relative space-y-4 border-s border-line ps-5">{data.map((e, i) => <li key={i} className="relative">
    <span className="absolute -start-[25px] top-1.5 size-2.5 rounded-full bg-brand" />
    <p className="text-xs text-muted tabular">{fmtDate(e.at, lang)} {fmtTime(e.at, lang)}</p>
    <p className="text-sm">{line(e)}</p>
  </li>)}</ol></Card>;
}

function Consultations({ patientId }: { patientId: string }) {
  const { t, lang } = useI18n(); const { orgId, org } = useWorkspace(); const router = useRouter();
  const { data } = useLoad<any[]>(`/patients/${patientId}/consultations`); const [err, setErr] = useState<unknown>(null);
  const isDoctor = !!org.me.doctorMembershipId;
  const start = async () => { try { const c = await post('/consultations', { patientId }); router.push(`/w/${orgId}/consultations/${c.id}`); } catch (e) { setErr(e); } };
  return <div className="space-y-4">
    {isDoctor ? <div className="flex justify-end"><Button onClick={start}>+ {t('newConsultation')}</Button></div> : <p className="text-sm text-muted">{t('onlyDoctors')}</p>}
    <ErrorNote error={err} />
    {!data ? <p className="text-muted">{t('loading')}</p> : data.length === 0 ? <Empty>{t('noConsultations')}</Empty> :
      <Card><ul className="divide-y divide-line">{data.map((c) => <li key={c.id}><Link href={`/w/${orgId}/consultations/${c.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2.5 hover:bg-surface">
        <div><p className="font-medium">{c.chief_complaint || t('consultation')}</p>
          <p className="text-xs text-muted tabular">{fmtDate(c.created_at, lang)} · {c.doctor_name}{c.diagnoses.length ? ` · ${c.diagnoses.join(', ')}` : ''}{c.addenda ? ` · ${c.addenda} ${t('addenda').toLowerCase()}` : ''}</p></div>
        <Badge status={c.status}>{t(c.status)}</Badge></Link></li>)}</ul></Card>}
  </div>;
}

function Prescriptions({ patientId }: { patientId: string }) {
  const { t } = useI18n(); const { can, org } = useWorkspace();
  const { data, reload } = useLoad<any[]>(`/patients/${patientId}/prescriptions`);
  const [open, setOpen] = useState<any>(null); const [err, setErr] = useState<unknown>(null);
  const canWrite = can('prescription.create') && !!org.me.doctorMembershipId;
  const show = async (id: string) => { try { setOpen(await get(`/prescriptions/${id}`)); } catch (e) { setErr(e); } };
  return <div className="space-y-4">
    {canWrite && <div className="flex justify-end"><Button onClick={async () => { try { setOpen(await newPrescription(patientId)); reload(); } catch (e) { setErr(e); } }}>+ {t('newPrescription')}</Button></div>}
    <ErrorNote error={err} />
    {!data ? <p className="text-muted">{t('loading')}</p> : data.length === 0 ? <Empty>{t('noPrescriptions')}</Empty> :
      <Card><ul className="divide-y divide-line">{data.map((r) => <li key={r.id}><button onClick={() => show(r.id)} className="flex w-full flex-wrap items-center justify-between gap-2 py-2.5 text-start hover:bg-surface">
        <div><p className="font-medium">{r.medications.join(', ') || '—'}</p><p className="text-xs text-muted tabular">{fmtDate(r.issued_at ?? r.created_at)} · {r.doctor_name}</p></div>
        <Badge status={r.status === 'cancelled' ? 'cancelled' : r.status}>{r.status === 'cancelled' ? t('cancelledRx') : t(r.status)}</Badge></button></li>)}</ul></Card>}
    <Dialog open={!!open} onClose={() => { setOpen(null); reload(); }} title={t('prescription')} wide>
      {open && <PrescriptionEditor key={open.id + open.status} rx={open} onChange={(n) => { if (n === null) { setOpen(null); reload(); } else setOpen(n); }} />}
    </Dialog>
  </div>;
}

function LinkDoctor({ open, onClose, patient, onDone }: { open: boolean; onClose: () => void; patient: any; onDone: (p: any) => void }) {
  const { t } = useI18n(); const { data } = useLoad<Member[]>('/staff');
  const [d, setD] = useState(''); const [err, setErr] = useState<unknown>(null);
  const options = (data ?? []).filter((m) => m.role_code === 'doctor' && !patient.doctors.some((x: any) => x.membership_id === m.id));
  return <Dialog open={open} onClose={onClose} title={`${t('doctor')} · ${t('add')}`}>
    <p className="mb-3 text-sm text-muted">Linking gives another doctor of this center access to this patient file. The change is recorded in the audit log.</p>
    <Field label={t('doctor')}><Select value={d} onChange={(e) => setD(e.target.value)}><option value="">—</option>{options.map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}</Select></Field>
    <div className="mt-3"><ErrorNote error={err} /></div>
    <div className="mt-4 flex justify-end"><Button disabled={!d} onClick={async () => { try { onDone(await post(`/patients/${patient.id}/links`, { doctorMembershipId: d })); } catch (e) { setErr(e); } }}>{t('save')}</Button></div>
  </Dialog>;
}
