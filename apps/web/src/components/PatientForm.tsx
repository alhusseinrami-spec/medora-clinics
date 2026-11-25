'use client';
import { useState } from 'react';
import { Button, ErrorNote, Field, Input, Select, Textarea } from './ui';
import { ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useWorkspace } from '@/lib/workspace';
import { useDoctors } from '@/lib/hooks';

const EMPTY = { fullName: '', dateOfBirth: '', sex: '', phone: '', whatsappNumber: '', email: '', address: '', nationalId: '', bloodType: '', allergies: '', chronicDiseases: '', currentMedications: '', medicalHistory: '', preferredLanguage: 'en', ecName: '', ecPhone: '', ecRelation: '' };
type F = typeof EMPTY;

export function fromPatient(p: any): F {
  return { fullName: p.full_name ?? '', dateOfBirth: p.date_of_birth ?? '', sex: p.sex ?? '', phone: p.phone ?? '', whatsappNumber: p.whatsapp_number ?? '', email: p.email ?? '',
    address: p.address ?? '', nationalId: p.national_id ?? '', bloodType: p.blood_type ?? '', allergies: p.allergies ?? '', chronicDiseases: p.chronic_diseases ?? '',
    currentMedications: p.current_medications ?? '', medicalHistory: p.medical_history ?? '', preferredLanguage: p.preferred_language ?? 'en',
    ecName: p.emergency_contact?.name ?? '', ecPhone: p.emergency_contact?.phone ?? '', ecRelation: p.emergency_contact?.relation ?? '' };
}

/** Same form for create and edit. Medical history fields only appear with the history permission. */
export function PatientForm({ initial, onSubmit, submitLabel, askDoctor }: { initial?: F; onSubmit: (body: any) => Promise<void>; submitLabel: string; askDoctor?: boolean }) {
  const { t } = useI18n(); const { can, org } = useWorkspace(); const doctors = useDoctors();
  const [f, setF] = useState<F>(initial ?? EMPTY); const [doctor, setDoctor] = useState('');
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false); const [dups, setDups] = useState<any[] | null>(null);
  const set = (k: keyof F) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const history = can('patient.history.read');
  const build = (confirm: boolean) => {
    const b: any = { fullName: f.fullName, preferredLanguage: f.preferredLanguage };
    const opt: [keyof F, string][] = [['dateOfBirth', 'dateOfBirth'], ['sex', 'sex'], ['phone', 'phone'], ['whatsappNumber', 'whatsappNumber'], ['email', 'email'], ['address', 'address'], ['nationalId', 'nationalId']];
    if (history) opt.push(['bloodType', 'bloodType'], ['allergies', 'allergies'], ['chronicDiseases', 'chronicDiseases'], ['currentMedications', 'currentMedications'], ['medicalHistory', 'medicalHistory']);
    for (const [k, key] of opt) b[key] = f[k] === '' ? (initial ? null : undefined) : f[k];
    if (f.ecName && f.ecPhone) b.emergencyContact = { name: f.ecName, phone: f.ecPhone, ...(f.ecRelation ? { relation: f.ecRelation } : {}) };
    else if (initial) b.emergencyContact = null;
    if (askDoctor && doctor) b.doctorMembershipId = doctor;
    if (askDoctor && confirm) b.confirmNotDuplicate = true;
    return b;
  };
  const submit = async (confirm = false) => {
    setBusy(true); setErr(null);
    try { await onSubmit(build(confirm)); setDups(null); }
    catch (e) { if (e instanceof ApiError && e.body?.code === 'possible_duplicate') setDups(e.body.duplicates); else setErr(e); }
    finally { setBusy(false); }
  };
  const needDoctor = askDoctor && !org.me.doctorMembershipId && org.me.actingDoctors.length !== 1;
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(false); }} className="grid gap-4 sm:grid-cols-2">
      <Field label={t('fullName')} className="sm:col-span-2"><Input required value={f.fullName} onChange={set('fullName')} /></Field>
      {needDoctor && <Field label={t('doctor')} className="sm:col-span-2"><Select value={doctor} onChange={(e) => setDoctor(e.target.value)} required={!org.me.orgWide}>
        <option value="">{org.me.orgWide ? '— (front desk only)' : '—'}</option>{doctors.map((d) => <option key={d.id} value={d.id}>{d.full_name}</option>)}</Select></Field>}
      <Field label={t('dateOfBirth')}><Input type="date" value={f.dateOfBirth} onChange={set('dateOfBirth')} /></Field>
      <Field label={t('sex')}><Select value={f.sex} onChange={set('sex')}><option value="">—</option><option value="female">{t('female')}</option><option value="male">{t('male')}</option><option value="other">{t('other')}</option></Select></Field>
      <Field label={t('phone')}><Input type="tel" value={f.phone} onChange={set('phone')} /></Field>
      <Field label={t('whatsapp')}><Input type="tel" value={f.whatsappNumber} onChange={set('whatsappNumber')} /></Field>
      <Field label={t('email')}><Input type="email" value={f.email} onChange={set('email')} /></Field>
      <Field label={t('nationalId')}><Input value={f.nationalId} onChange={set('nationalId')} /></Field>
      <Field label={t('address')} className="sm:col-span-2"><Input value={f.address} onChange={set('address')} /></Field>
      <Field label={`${t('emergencyContact')} · ${t('fullName')}`}><Input value={f.ecName} onChange={set('ecName')} /></Field>
      <Field label={`${t('emergencyContact')} · ${t('phone')}`}><Input value={f.ecPhone} onChange={set('ecPhone')} /></Field>
      <Field label={t('language')}><Select value={f.preferredLanguage} onChange={set('preferredLanguage')}><option value="en">English</option><option value="ar">العربية</option><option value="fr">Français</option></Select></Field>
      {history && <>
        <Field label={t('bloodType')}><Select value={f.bloodType} onChange={set('bloodType')}><option value="">—</option>{['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map((b) => <option key={b}>{b}</option>)}</Select></Field>
        <Field label={t('allergies')} className="sm:col-span-2"><Textarea value={f.allergies} onChange={set('allergies')} /></Field>
        <Field label={t('chronicDiseases')}><Textarea value={f.chronicDiseases} onChange={set('chronicDiseases')} /></Field>
        <Field label={t('currentMedications')}><Textarea value={f.currentMedications} onChange={set('currentMedications')} /></Field>
        <Field label={t('medicalHistory')} className="sm:col-span-2"><Textarea value={f.medicalHistory} onChange={set('medicalHistory')} /></Field>
      </>}
      {dups && <div className="rounded-[10px] border border-warning/40 bg-warning/10 p-3 text-sm sm:col-span-2">
        <p className="font-semibold text-warning">{t('possibleDuplicate')}</p><p className="mt-1">{t('duplicateHelp')}</p>
        <ul className="mt-2 list-disc ps-5">{dups.map((d) => <li key={d.patient_id}>{d.masked_name} · {d.match.replace(/_/g, ' ')}{!d.visible && ' · registered with another doctor (ask the center admin to link)'}</li>)}</ul>
        <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={() => submit(true)}>{t('createAnyway')}</Button>
      </div>}
      <div className="sm:col-span-2"><ErrorNote error={err} /></div>
      <div className="flex justify-end sm:col-span-2"><Button busy={busy}>{submitLabel}</Button></div>
    </form>
  );
}
