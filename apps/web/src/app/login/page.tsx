'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, ErrorNote, Field, Input } from '@/components/ui';
import { get, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { AuthFrame } from '../AuthFrame';

export default function Login() {
  const { t } = useI18n(); const router = useRouter();
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [code, setCode] = useState('');
  const [mfa, setMfa] = useState(false); const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  const next = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('next') : null;
  const done = async () => {
    if (next?.startsWith('/')) return router.replace(next);
    const me = await get('/auth/me', null);
    const w = me.workspaces.find((x: any) => x.status === 'active');
    router.replace(w ? `/w/${w.organization_id}/dashboard` : me.user.is_platform_admin ? '/admin' : me.patientRecords > 0 ? '/portal' : '/register');
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      if (mfa) { await post('/auth/mfa/verify', { code }); return await done(); }
      const r = await post('/auth/login', { email, password });
      if (r.mfaRequired) setMfa(true); else await done();
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <AuthFrame title={t('signIn')}>
      <form onSubmit={submit} className="space-y-4">
        {!mfa ? <>
          <Field label={t('email')}><Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label={t('password')}><Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        </> : <Field label={t('mfaCode')} hint={t('mfaPrompt')}><Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></Field>}
        <ErrorNote error={err} />
        <Button className="w-full" busy={busy}>{t('continue')}</Button>
      </form>
      <div className="mt-6 flex justify-between text-sm"><Link href="/register" className="text-brand hover:underline">{t('createAccount')}</Link><Link href="/forgot" className="text-muted hover:underline">{t('forgot')}</Link></div>
    </AuthFrame>
  );
}
