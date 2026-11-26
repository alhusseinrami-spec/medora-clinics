'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Logo, cx } from '@/components/ui';
import { get, post } from '@/lib/api';
import { useI18n, type Lang } from '@/lib/i18n';

export interface PortalRecord { patient_id: string; organization_id: string; clinic: string; clinic_phone: string | null; clinic_address: string | null; full_name: string;
  patient_number: string; phone: string | null; whatsapp_number: string | null; email: string | null; address: string | null; preferred_language: string | null; whatsapp_consent: boolean | null }
interface PortalCtx { me: any; records: PortalRecord[]; reload: () => Promise<void>; setRecords: (r: PortalRecord[]) => void }
const Ctx = createContext<PortalCtx>(null as any);
export const usePortal = () => useContext(Ctx);

export function PortalFrame({ children }: { children: ReactNode }) {
  const { t, lang, setLang } = useI18n(); const router = useRouter(); const path = usePathname();
  const [me, setMe] = useState<any>(null); const [records, setRecords] = useState<PortalRecord[] | null>(null);
  const reload = useCallback(async () => { const r = await get('/portal/me', null); setRecords(r.records); }, []);
  useEffect(() => {
    get('/auth/me', null).then((m) => { setMe(m); if (m.user.interface_language && !localStorage.getItem('medora.lang')) setLang(m.user.interface_language as Lang); return reload(); })
      .catch(() => router.replace(`/login?next=${encodeURIComponent(path)}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!me || !records) return <div className="p-8 text-sm text-muted">{t('loading')}</div>;
  const staffWs = me.workspaces.find((w: any) => w.status === 'active');
  const nav = [
    { href: '/portal', label: t('pHome'), icon: '⌂' },
    { href: '/portal/appointments', label: t('pAppointments'), icon: '▦' },
    { href: '/portal/prescriptions', label: t('pPrescriptions'), icon: '℞' },
    { href: '/portal/documents', label: t('pDocuments'), icon: '▤' },
    { href: '/portal/profile', label: t('pProfile'), icon: '◉' },
  ];
  const active = (h: string) => (h === '/portal' ? path === h : path.startsWith(h));
  const logout = async () => { await post('/auth/logout'); router.replace('/login'); };
  return (
    <Ctx.Provider value={{ me, records, reload, setRecords }}>
      <div className="min-h-screen bg-surface pb-20 md:pb-8">
        <header className="sticky top-0 z-30 border-b border-line bg-card/95 backdrop-blur">
          <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
            <Link href="/portal"><Logo size={34} /></Link>
            <nav className="hidden gap-1 md:flex">{nav.map((n) => <Link key={n.href} href={n.href} className={cx('rounded-[10px] px-3 py-1.5 text-sm font-medium', active(n.href) ? 'bg-brand-soft text-brand' : 'text-ink hover:bg-surface')}>{n.label}</Link>)}</nav>
            <div className="flex items-center gap-2 text-sm">
              {staffWs && <Link href={`/w/${staffWs.organization_id}/dashboard`} className="hidden text-muted hover:text-ink sm:inline">{t('workspace')}</Link>}
              <select value={lang} onChange={(e) => setLang(e.target.value as Lang)} className="rounded-md border border-line bg-card px-2 py-1" aria-label={t('language')}><option value="en">EN</option><option value="fr">FR</option><option value="ar">ع</option></select>
              <button onClick={logout} className="text-muted hover:text-ink">{t('signOut')}</button>
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-3xl px-4 py-5">
          {records.length === 0 ? <p className="rounded-[12px] border border-line bg-card p-6 text-sm">{t('pNoRecords')}</p> : children}
        </main>
        <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-line bg-card pb-[env(safe-area-inset-bottom)] md:hidden">
          {nav.map((n) => <Link key={n.href} href={n.href} className={cx('flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium', active(n.href) ? 'text-brand' : 'text-muted')}>
            <span aria-hidden className="text-lg leading-none">{n.icon}</span>{n.label}</Link>)}
        </nav>
      </div>
    </Ctx.Provider>
  );
}
