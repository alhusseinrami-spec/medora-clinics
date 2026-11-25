'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Button, ErrorNote, Field, Input } from '@/components/ui';
import { post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { AuthFrame } from '../AuthFrame';

export default function Reset() {
  const { t } = useI18n();
  const [pw, setPw] = useState(''); const [ok, setOk] = useState(false); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await post('/auth/password/reset', { token: new URLSearchParams(window.location.search).get('token'), password: pw }); setOk(true); } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <AuthFrame title={t('resetPassword')}>
      {ok ? <p className="text-sm">Password changed. All other sessions were signed out. <Link href="/login" className="text-brand underline">{t('signIn')}</Link></p> :
        <form onSubmit={submit} className="space-y-4">
          <Field label={t('newPassword')} hint="10+ characters"><Input type="password" minLength={10} required value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
          <ErrorNote error={err} /><Button className="w-full" busy={busy}>{t('save')}</Button>
        </form>}
    </AuthFrame>
  );
}
