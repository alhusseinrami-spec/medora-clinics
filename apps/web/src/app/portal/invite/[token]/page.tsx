'use client';
import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, ErrorNote, Field, Input } from '@/components/ui';
import { get, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { AuthFrame } from '../../../AuthFrame';

/** A patient opens the link the clinic shared: sign up (or sign in) with the invited email, and the patient file is linked. */
export default function PortalInvite({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const { t, lang } = useI18n(); const router = useRouter();
  const [inv, setInv] = useState<any>(null); const [me, setMe] = useState<any>(undefined); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ fullName: '', password: '' });
  useEffect(() => {
    get(`/portal/invitations/${token}`, null).then(setInv).catch(setErr);
    get('/auth/me', null).then(setMe).catch(() => setMe(null));
  }, [token]);
  const accept = async () => {
    setBusy(true); setErr(null);
    try { await post(`/portal/invitations/${token}/accept`); router.replace('/portal'); } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const register = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await post('/auth/register/patient', { fullName: f.fullName, email: inv.email, password: f.password, language: lang, invitation: token }); router.replace('/portal'); }
    catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const here = `/portal/invite/${token}`;
  return (
    <AuthFrame title={t('pInviteTitle')}>
      {inv && <div className="rounded-[12px] border border-line bg-card p-5">
        <p className="text-sm text-muted">{t('pInvitedBy')}</p>
        <p className="mt-1 text-lg font-semibold">{inv.clinic}</p>
        <p className="mt-1 text-sm text-muted">{inv.email}</p>
        {!inv.valid && <p className="mt-3 text-sm text-danger">{t('pInviteInvalid')}</p>}
      </div>}
      <div className="mt-5 space-y-3">
        <ErrorNote error={err} />
        {inv?.valid && me && <><p className="text-sm">{t('pInviteSignedIn')} <b>{me.user.email}</b>.</p><Button className="w-full" busy={busy} onClick={accept}>{t('pInviteAccept')}</Button></>}
        {inv?.valid && me === null && <>
          <form onSubmit={register} className="space-y-3">
            <p className="text-sm text-muted">{t('pInviteEmailNote')} <b className="text-ink">{inv.email}</b></p>
            <Field label={t('fullName')}><Input required minLength={2} maxLength={120} autoComplete="name" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></Field>
            <Field label={t('password')} hint="10+ characters"><Input type="password" required minLength={10} autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
            <Button className="w-full" busy={busy}>{t('pInviteNew')}</Button>
          </form>
          <Link href={`/login?next=${encodeURIComponent(here)}`} className="block text-center text-sm text-brand hover:underline">{t('pInviteHave')}</Link>
        </>}
      </div>
    </AuthFrame>
  );
}
