'use client';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { AuthFrame } from '../AuthFrame';

export default function Register() {
  const { t } = useI18n();
  const opt = (href: string, title: string, body: string) => (
    <Link href={href} className="block rounded-[12px] border border-line bg-card p-5 transition hover:border-brand hover:shadow-sm">
      <p className="font-semibold">{title}</p><p className="mt-1 text-sm text-muted">{body}</p>
    </Link>);
  return (
    <AuthFrame title={t('createAccount')}>
      <div className="space-y-3">
        {opt('/register/doctor', t('registerDoctor'), 'Your private practice, your patients, your assistants. Join medical centers later with the same account.')}
        {opt('/register/center', t('registerCenter'), 'Invite doctors and staff, organize departments, locations and rooms.')}
      </div>
      <p className="mt-6 text-sm text-muted">Already invited to a center? Open the invitation link you received. <Link href="/login" className="text-brand hover:underline">{t('signIn')}</Link></p>
    </AuthFrame>
  );
}
