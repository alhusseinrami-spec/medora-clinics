'use client';
import { useEffect, useState } from 'react';
import { Button, Card, ErrorNote, Field, Input, Select } from '@/components/ui';
import { PageTitle } from '@/components/Shell';
import { PushToggle } from '@/components/Pwa';
import { del, get, patch, post } from '@/lib/api';
import { useI18n, type Lang } from '@/lib/i18n';
import { useWorkspace } from '@/lib/workspace';

export default function Profile() {
  const { t, setLang } = useI18n(); const { me, reload } = useWorkspace();
  const [f, setF] = useState({ fullName: me.user.full_name, interfaceLanguage: me.user.interface_language, theme: me.user.theme });
  const [err, setErr] = useState<unknown>(null); const [ok, setOk] = useState(''); const [setup, setSetup] = useState<any>(null); const [code, setCode] = useState('');
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' }); const [sessions, setSessions] = useState<any[]>([]); const [dis, setDis] = useState({ code: '', password: '' });
  const loadSessions = () => get('/auth/sessions', null).then(setSessions).catch(() => {});
  useEffect(() => { loadSessions(); }, []);
  const run = async (label: string, fn: () => Promise<unknown>) => { setErr(null); setOk(''); try { await fn(); setOk(label); await reload(); } catch (e) { setErr(e); } };
  return (
    <>
      <PageTitle title={t('profile')} sub={me.user.email} />
      <ErrorNote error={err} />{ok && <p className="mb-4 text-sm text-success">{ok} · {t('saved')}</p>}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title={t('personal')}>
          <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); run(t('profile'), async () => { await patch('/auth/me', f); setLang(f.interfaceLanguage as Lang); }); }}>
            <Field label={t('fullName')}><Input value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></Field>
            <Field label={t('language')}><Select value={f.interfaceLanguage} onChange={(e) => setF({ ...f, interfaceLanguage: e.target.value })}><option value="en">English</option><option value="ar">العربية</option><option value="fr">Français</option></Select></Field>
            <Field label={t('theme')}><Select value={f.theme} onChange={(e) => setF({ ...f, theme: e.target.value })}><option value="system">{t('system')}</option><option value="light">{t('light')}</option><option value="dark">{t('dark')}</option></Select></Field>
            <div className="flex justify-end"><Button>{t('save')}</Button></div>
          </form>
        </Card>
        <Card title={`${t('twoFactor')} · ${me.user.mfa_enabled ? t('on') : t('off')}`}>
          {!me.user.mfa_enabled && !setup && <><p className="mb-3 text-sm text-muted">Use an authenticator app (any TOTP app). You will need a code at every sign-in.</p><Button onClick={() => run('MFA', async () => setSetup(await post('/auth/mfa/setup')))}>{t('enable')}</Button></>}
          {!me.user.mfa_enabled && setup && <div className="space-y-3 text-sm">
            <p>Add this key to your authenticator app, then enter the code it shows.</p>
            <code className="block break-all rounded-[10px] bg-surface p-3 tabular">{setup.secret}</code>
            <a className="text-xs text-brand underline" href={setup.otpauthUrl}>otpauth link</a>
            <div className="flex gap-2"><Input inputMode="numeric" maxLength={6} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
              <Button onClick={() => run(t('twoFactor'), async () => { await post('/auth/mfa/enable', { code }); setSetup(null); })}>{t('confirm')}</Button></div>
          </div>}
          {me.user.mfa_enabled && <div className="grid gap-2">
            <Input type="password" placeholder={t('password')} value={dis.password} onChange={(e) => setDis({ ...dis, password: e.target.value })} />
            <Input inputMode="numeric" maxLength={6} placeholder={t('mfaCode')} value={dis.code} onChange={(e) => setDis({ ...dis, code: e.target.value })} />
            <Button variant="danger" onClick={() => run(t('twoFactor'), () => post('/auth/mfa/disable', dis))}>{t('disable')}</Button></div>}
        </Card>
        <Card title={t('password')}>
          <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); run(t('password'), () => post('/auth/password/change', pw).then(() => setPw({ currentPassword: '', newPassword: '' }))); }}>
            <Field label={t('password')}><Input type="password" required value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} /></Field>
            <Field label={t('newPassword')} hint="10+ characters. Other sessions are signed out."><Input type="password" minLength={10} required value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} /></Field>
            <div className="flex justify-end"><Button>{t('save')}</Button></div>
          </form>
        </Card>
        <Card title={t('pPhoneNotifications')}><PushToggle /></Card>
        <Card title="Sessions">
          <ul className="divide-y divide-line text-sm">{sessions.map((s) => <li key={s.id} className="flex items-center justify-between gap-2 py-2">
            <span className="min-w-0"><span className="block truncate">{s.user_agent || 'Unknown device'}</span><span className="text-xs text-muted">{s.ip} · {new Date(s.last_seen_at).toLocaleString()}</span></span>
            {s.current ? <span className="text-xs text-success">this device</span> : <Button size="sm" variant="ghost" onClick={() => del(`/auth/sessions/${s.id}`).then(loadSessions)}>Sign out</Button>}
          </li>)}</ul>
        </Card>
      </div>
    </>
  );
}
