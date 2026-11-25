'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, ErrorNote, Field, Input } from '@/components/ui';
import { post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { AuthFrame } from '../../AuthFrame';

export default function RegisterCenter() {
  const { t, lang } = useI18n(); const router = useRouter();
  const [f, setF] = useState({ fullName: '', email: '', password: '', phone: '', centerName: '', locationName: '', address: '' });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const body: any = { ...f, language: lang }; for (const k of ['phone', 'address', 'locationName']) if (!body[k]) delete body[k];
      const r = await post('/auth/register/center', body);
      router.replace(`/w/${r.organizationId}/settings/team`);
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <AuthFrame title={t('registerCenter')} wide>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Field label={t('centerName')} className="sm:col-span-2"><Input required value={f.centerName} onChange={set('centerName')} /></Field>
        <Field label={t('fullName')}><Input required value={f.fullName} onChange={set('fullName')} /></Field>
        <Field label={t('phone')}><Input value={f.phone} onChange={set('phone')} /></Field>
        <Field label={t('email')}><Input type="email" required value={f.email} onChange={set('email')} /></Field>
        <Field label={t('password')} hint="10+ characters"><Input type="password" minLength={10} required value={f.password} onChange={set('password')} /></Field>
        <Field label={t('locations')}><Input placeholder="Main branch" value={f.locationName} onChange={set('locationName')} /></Field>
        <Field label={t('address')}><Input value={f.address} onChange={set('address')} /></Field>
        <div className="sm:col-span-2"><ErrorNote error={err} /></div>
        <Button className="sm:col-span-2" busy={busy}>{t('createAccount')}</Button>
      </form>
    </AuthFrame>
  );
}
