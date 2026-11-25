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
    ...(can('appointment.manage') ? [{ key: 'appointments', label: t('appointments') }] : []), { key: 'timeline', label: t('timeline') }];
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
        {tab === 'appointments' && <PatientAppointments patientId={patientId} />}
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
  const { t, lang, status } = useI18n();
  const from = new Date(Date.now() - 60 * 86400e3).toISOString(); const to = new Date(Date.now() + 60 * 86400e3).toISOString();
  const { data, reload } = useLoad<any[]>(`/appointments?from=${from}&to=${to}&patient=${patientId}`);
  if (!data) return <p className="text-muted">{t('loading')}</p>;
  if (!data.length) return <Empty>{t('noAppointments')}</Empty>;
  return <Card><ul className="divide-y divide-line">{data.map((a) => <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
    <div><p className="font-medium tabular">{fmtDate(a.starts_at, lang)} · {fmtTime(a.starts_at, lang)}</p><p className="text-xs text-muted">{a.doctor_name} {a.service_name ? `· ${a.service_name}` : ''}</p></div>
    <div className="flex items-center gap-2"><Badge status={a.status}>{status(a.status)}</Badge><ApptActions appt={a} onDone={reload} compact /></div></li>)}</ul></Card>;
}

function Timeline({ patientId }: { patientId: string }) {
  const { t, lang, status } = useI18n();
  const { data } = useLoad<any[]>(`/patients/${patientId}/timeline`);
  if (!data) return <p className="text-muted">{t('loading')}</p>;
  return <Card><ol className="relative space-y-4 border-s border-line ps-5">{data.map((e, i) => <li key={i} className="relative">
    <span className="absolute -start-[25px] top-1.5 size-2.5 rounded-full bg-brand" />
    <p className="text-xs text-muted tabular">{fmtDate(e.at, lang)} {fmtTime(e.at, lang)}</p>
    <p className="text-sm">{e.kind === 'registered' ? 'Patient registered' : e.kind === 'appointment' ? <>Appointment with {e.doctor} · <Badge status={e.status}>{status(e.status)}</Badge></> : `Specialty profile updated (${e.status}) by ${e.doctor ?? '—'}`}</p>
  </li>)}</ol><p className="mt-4 text-xs text-muted">Consultations, prescriptions, documents and invoices join this timeline in Releases 2 and 3.</p></Card>;
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
