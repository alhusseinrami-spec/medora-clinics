'use client';
import { useState } from 'react';
import { Button, ErrorNote, Field, Input } from '@/components/ui';
import { post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { AuthFrame } from '../AuthFrame';

export default function Forgot() {
  const { t } = useI18n();
  const [email, setEmail] = useState(''); const [res, setRes] = useState<any>(null); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => { e.preventDefault(); setBusy(true); setErr(null); try { setRes(await post('/auth/password/forgot', { email })); } catch (x) { setErr(x); } finally { setBusy(false); } };
  return (
    <AuthFrame title={t('resetPassword')}>
      {!res ? <form onSubmit={submit} className="space-y-4">
        <Field label={t('email')}><Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <ErrorNote error={err} /><Button className="w-full" busy={busy}>{t('continue')}</Button>
      </form> : <div className="space-y-3 text-sm">
        <p>{res.message}</p>
        {res.emailDelivery === 'awaiting_credentials' && <p className="rounded-[10px] bg-warning/10 p-3 text-warning">Email delivery is not connected yet (awaiting provider credentials), so no email was sent.</p>}
        {res.devResetUrl && <p className="rounded-[10px] border border-line p-3">Development only: <a className="break-all text-brand underline" href={res.devResetUrl}>open the reset link</a></p>}
      </div>}
    </AuthFrame>
  );
}
