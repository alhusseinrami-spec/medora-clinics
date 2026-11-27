'use client';
import Link from 'next/link';
import { DemoBanner } from './Demo';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useWorkspace } from '@/lib/workspace';
import { useI18n, type Lang } from '@/lib/i18n';
import { get, post } from '@/lib/api';
import { Logo, cx } from './ui';

export function Shell({ children }: { children: ReactNode }) {
  const { me, org, orgId, can, feature, live: socket, synced, subscribe } = useWorkspace();
  // Live through the WebSocket, or through the 3-second sync on hosts that cannot keep a socket open (the Vercel demo).
  const live = socket || synced;
  const { t, lang, setLang, role } = useI18n();
  const path = usePathname(); const router = useRouter();
  const [unread, setUnread] = useState(0);
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    const load = () => get<any[]>('/notifications?unread=1', null).then((n) => setUnread(n.length)).catch(() => {});
    load(); return subscribe((e) => { if (e.event === 'arrived' || e.type === 'notification') load(); });
  }, [subscribe]);
  useEffect(() => { if (me.user.interface_language && me.user.interface_language !== lang && !localStorage.getItem('medora.lang')) setLang(me.user.interface_language as Lang); }, [me, lang, setLang]);

  const base = `/w/${orgId}`;
  const nav = [
    { href: `${base}/dashboard`, label: t('dashboard'), icon: '◫', show: true },
    { href: `${base}/calendar`, label: t('calendar'), icon: '▦', show: can('appointment.manage') },
    { href: `${base}/waiting-room`, label: t('waitingRoom'), icon: '◷', show: can('appointment.manage') },
    { href: `${base}/patients`, label: t('patients'), icon: '◉', show: can('patient.file.read') },
    { href: `${base}/visits`, label: t('visits'), icon: '◈', show: can('clinical_notes.read') },
    { href: `${base}/prescriptions`, label: t('prescriptions'), icon: '℞', show: can('prescription.view') },
    { href: `${base}/messages`, label: t('messages'), icon: '✉', show: can('whatsapp.send') && feature('whatsapp') },
    { href: `${base}/billing`, label: t('billing'), icon: '▤', show: can('payment.register') || can('finance.view') },
    { href: `${base}/finance`, label: t('finance'), icon: '◔', show: can('finance.view') && feature('finance') },
    { href: `${base}/insurance`, label: t('insurance'), icon: '⛨', show: can('insurance.manage') && feature('insurance') },
    { href: `${base}/reports`, label: t('reports'), icon: '▥', show: can('report.view') },
  ];
  const settings = [
    { href: `${base}/settings/team`, label: t('team'), show: true },
    { href: `${base}/settings/workspace`, label: t('workspace'), show: can('org.manage') },
    { href: `${base}/settings/availability`, label: t('availability'), show: can('appointment.manage') && org.me.actingDoctors.length > 0 },
    { href: `${base}/settings/whatsapp`, label: 'WhatsApp', show: can('whatsapp.send') && feature('whatsapp') },
    { href: `${base}/settings/specialty`, label: t('specialty'), show: can('template.manage') && !!org.me.doctorMembershipId },
    { href: `${base}/settings/subscription`, label: t('subscription'), show: can('org.manage') },
    { href: `${base}/settings/profile`, label: t('profile'), show: true },
    { href: `${base}/support`, label: t('support'), show: true },
  ];
  const myRoles = org.me.memberships.map((m) => role(m.role_code)).join(', ');
  const logout = async () => { await post('/auth/logout'); router.replace('/login'); };

  // Drawer menu for phones: closes on navigation and stops the page behind it from scrolling.
  const [drawer, setDrawer] = useState(false);
  useEffect(() => { setDrawer(false); }, [path]);
  useEffect(() => {
    if (!drawer) return;
    const prev = document.body.style.overflow; document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawer(false); };
    window.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = prev; window.removeEventListener('keydown', onKey); };
  }, [drawer]);

  const sidebar = (
    <>
      <div className="px-2"><Logo /></div>
      <div className="relative mt-6">
        <button onClick={() => setMenu(!menu)} className="w-full rounded-[10px] border border-line px-3 py-2 text-start hover:bg-surface">
          <span className="block truncate text-sm font-semibold">{org.organization.name}</span>
          <span className="block truncate text-xs text-muted">{myRoles}</span>
        </button>
        {menu && <div className="absolute z-20 mt-1 w-full rounded-[10px] border border-line bg-card py-1 shadow-lg">
          {[...new Map(me.workspaces.filter((w) => w.status === 'active').map((w) => [w.organization_id, w])).values()].map((w) => (
            <Link key={w.organization_id} href={`/w/${w.organization_id}/dashboard`} onClick={() => setMenu(false)} className={cx('block px-3 py-2 text-sm hover:bg-surface', w.organization_id === orgId && 'font-semibold text-brand')}>{w.name}</Link>
          ))}
        </div>}
      </div>
      <nav className="mt-5 space-y-0.5">
        {nav.filter((n) => n.show).map((n) => <Link key={n.href} href={n.href} className={cx('flex items-center gap-3 rounded-[10px] px-3 py-2 text-sm font-medium', path.startsWith(n.href) ? 'bg-brand-soft text-brand' : 'text-ink hover:bg-surface')}><span aria-hidden className="w-4 text-center">{n.icon}</span>{n.label}</Link>)}
      </nav>
      <p className="mt-6 px-3 text-xs font-semibold uppercase tracking-wide text-muted">{t('settings')}</p>
      <nav className="mt-1 space-y-0.5">
        {settings.filter((n) => n.show).map((n) => <Link key={n.href} href={n.href} className={cx('block rounded-[10px] px-3 py-1.5 text-sm', path.startsWith(n.href) ? 'bg-brand-soft text-brand' : 'text-muted hover:bg-surface hover:text-ink')}>{n.label}</Link>)}
      </nav>
      <div className="mt-auto space-y-2 px-2 text-xs text-muted">
        {me.user.is_platform_admin && <Link href="/admin" className="block font-medium text-brand hover:underline">{t('adminConsole')}</Link>}
        <p className="truncate">{me.user.full_name}</p>
        <button onClick={logout} className="hover:text-ink">{t('signOut')}</button>
      </div>
    </>
  );

  return (
    <div className="flex min-h-dvh">
      {/* The menu scrolls on its own when it is taller than the screen (dvh follows the phone's visible height). */}
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col overflow-y-auto overscroll-contain border-e border-line bg-card px-3 py-5 md:flex print:!hidden">
        {sidebar}
      </aside>
      {drawer && <div className="fixed inset-0 z-40 md:hidden print:hidden">
        <button aria-label={t('close')} onClick={() => setDrawer(false)} className="absolute inset-0 bg-black/40" />
        <aside role="dialog" aria-modal="true" className="absolute inset-y-0 start-0 flex h-dvh w-72 max-w-[85vw] flex-col overflow-y-auto overscroll-contain bg-card px-3 py-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-xl">
          {sidebar}
        </aside>
      </div>}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between gap-3 border-b border-line bg-card/90 px-4 backdrop-blur md:px-8 print:hidden">
          <div className="flex items-center gap-2 md:hidden">
            <button onClick={() => setDrawer(true)} aria-label={t('menu')} aria-expanded={drawer} className="rounded-md p-2 text-lg leading-none hover:bg-surface"><span aria-hidden>☰</span></button>
            <Logo size={28} word={false} />
          </div>
          <span className={cx('inline-flex items-center gap-1.5 text-xs', live ? 'text-success' : 'text-muted')}><span className={cx('size-2 rounded-full', live ? 'bg-success' : 'bg-muted')} />{live ? t('liveConnected') : t('liveOffline')}</span>
          <div className="flex items-center gap-3">
            <Link href={`${base}/dashboard#notifications`} className="relative rounded-full p-2 hover:bg-surface" aria-label={t('notifications')}>
              <span aria-hidden>🔔</span>{unread > 0 && <span className="absolute -end-0.5 -top-0.5 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] font-bold text-white">{unread}</span>}
            </Link>
            <select value={lang} onChange={(e) => setLang(e.target.value as Lang)} className="rounded-md border border-line bg-card px-2 py-1 text-sm" aria-label={t('language')}>
              <option value="en">EN</option><option value="fr">FR</option><option value="ar">ع</option>
            </select>
          </div>
        </header>
        <DemoBanner />
        <PlanBanner />
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-8">{children}</main>
      </div>
    </div>
  );
}

export function PageTitle({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return <div className="mb-6 flex flex-wrap items-end justify-between gap-3"><div><h1 className="font-[family-name:var(--font-display)] text-2xl font-semibold">{title}</h1>{sub && <p className="mt-1 text-sm text-muted">{sub}</p>}</div>{actions && <div className="flex gap-2">{actions}</div>}</div>;
}
export function Forbidden() { const { t } = useI18n(); return <p className="text-muted">{t('noPermission')}</p>; }

/** Tells everyone when the workspace can no longer change data, and administrators when the trial ends soon. */
function PlanBanner() {
  const { org, orgId, can } = useWorkspace(); const { t } = useI18n();
  const p = org.plan;
  if (!p || p.usable) return null;
  return (
    <div role="status" className="border-b border-warning/30 bg-warning/10 px-4 py-2 text-sm md:px-8">
      {t(`planBanner_${p.effectiveStatus}`) === `planBanner_${p.effectiveStatus}` ? t('planBanner_inactive') : t(`planBanner_${p.effectiveStatus}`)}{' '}
      {can('org.manage') ? <Link href={`/w/${orgId}/settings/subscription`} className="font-medium text-brand hover:underline">{t('subscription')} →</Link> : t('planBannerAskAdmin')}
    </div>
  );
}
