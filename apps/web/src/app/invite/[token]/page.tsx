'use client';
import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, ErrorNote } from '@/components/ui';
import { get, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { AuthFrame } from '../../AuthFrame';

export default function Invite({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const { t, role } = useI18n(); const router = useRouter();
  const [inv, setInv] = useState<any>(null); const [me, setMe] = useState<any>(undefined); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  useEffect(() => {
    get(`/invitations/${token}`, null).then(setInv).catch(setErr);
    get('/auth/me', null).then(setMe).catch(() => setMe(null));
  }, [token]);
  const accept = async () => {
    setBusy(true); setErr(null);
    try { const r = await post(`/invitations/${token}/accept`); router.replace(`/w/${r.organization_id}/dashboard`); } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const here = `/invite/${token}`;
  return (
    <AuthFrame title={t('acceptInvitation')}>
      {inv && <div className="rounded-[12px] border border-line bg-card p-5">
        <p className="text-sm text-muted">{t('invitedAs')}</p>
        <p className="mt-1 text-lg font-semibold">{role(inv.role_code)} · {inv.organization_name}</p>
        <p className="mt-1 text-sm text-muted">{inv.email}</p>
        {!inv.valid && <p className="mt-3 text-sm text-danger">This invitation was already used, revoked or has expired.</p>}
      </div>}
      <div className="mt-5 space-y-3">
        <ErrorNote error={err} />
        {inv?.valid && me && <><p className="text-sm">Signed in as <b>{me.user.email}</b>.</p><Button className="w-full" busy={busy} onClick={accept}>{t('acceptInvitation')}</Button></>}
        {inv?.valid && me === null && <>
          <p className="text-sm text-muted">Sign in with {inv.email}, or create an account with that email first. Your existing account is reused, never duplicated.</p>
          <Link href={`/login?next=${encodeURIComponent(here)}`}><Button className="w-full">{t('signIn')}</Button></Link>
          <Link href={inv.role_code === 'doctor' ? '/register/doctor' : '/register/center'} className="block text-center text-sm text-brand hover:underline">{t('createAccount')}</Link>
        </>}
      </div>
    </AuthFrame>
  );
}
