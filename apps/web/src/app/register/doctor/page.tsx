'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, ErrorNote, Field, Input, Select } from '@/components/ui';
import { get, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { AuthFrame } from '../../AuthFrame';

export default function RegisterDoctor() {
  const { t, lang } = useI18n(); const router = useRouter();
  const [specialties, setSpecialties] = useState<any[]>([]);
  const [f, setF] = useState({ fullName: '', email: '', password: '', phone: '', specialty: 'general_practice', licenseNumber: '', clinicName: '', address: '', consultationFee: '' });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  useEffect(() => { fetch('/api/specialties').then(async (r) => r.ok ? setSpecialties(await r.json()) : null).catch(() => {}); }, []);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const body: any = { ...f, language: lang, consultationFee: f.consultationFee ? Number(f.consultationFee) : undefined };
      for (const k of ['phone', 'address']) if (!body[k]) delete body[k];
      const r = await post('/auth/register/doctor', body);
      router.replace(`/w/${r.organizationId}/dashboard`);
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <AuthFrame title={t('registerDoctor')} wide>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Field label={t('fullName')} className="sm:col-span-2"><Input required value={f.fullName} onChange={set('fullName')} /></Field>
        <Field label={t('email')}><Input type="email" required value={f.email} onChange={set('email')} /></Field>
        <Field label={t('password')} hint="10+ characters"><Input type="password" minLength={10} required value={f.password} onChange={set('password')} /></Field>
        <Field label={t('specialtyLabel')}><Select value={f.specialty} onChange={set('specialty')}>
          {(specialties.length ? specialties : [{ code: 'general_practice', name: 'General Practice', names: {} }]).map((s) => <option key={s.code} value={s.code}>{s.names?.[lang] ?? s.name}</option>)}
        </Select></Field>
        <Field label={t('license')}><Input required value={f.licenseNumber} onChange={set('licenseNumber')} /></Field>
        <Field label={t('clinicName')}><Input required value={f.clinicName} onChange={set('clinicName')} /></Field>
        <Field label={t('phone')}><Input value={f.phone} onChange={set('phone')} /></Field>
        <Field label={t('address')}><Input value={f.address} onChange={set('address')} /></Field>
        <Field label={t('consultationFee')}><Input type="number" min={0} value={f.consultationFee} onChange={set('consultationFee')} /></Field>
        <div className="sm:col-span-2"><ErrorNote error={err} /></div>
        <Button className="sm:col-span-2" busy={busy}>{t('createAccount')}</Button>
      </form>
    </AuthFrame>
  );
}
