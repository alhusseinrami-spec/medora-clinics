'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Logo, cx } from '@/components/ui';
import { ApiError, get, post } from '@/lib/api';

/** MEDORA super-admin console frame. The API checks platform-admin rights on every call; this only routes. */
export function AdminFrame({ children }: { children: ReactNode }) {
  const router = useRouter(); const path = usePathname();
  const [me, setMe] = useState<any>(null); const [denied, setDenied] = useState<string | null>(null);
  useEffect(() => {
    get('/auth/me', null).then(async (m) => {
      setMe(m);
      if (!m.user.is_platform_admin) { setDenied('This console is for MEDORA platform administrators.'); return; }
      try { await get('/admin/overview', null); } catch (e) { setDenied(e instanceof ApiError ? e.message : String(e)); }
    }).catch(() => router.replace(`/login?next=${encodeURIComponent(path)}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!me) return <div className="p-8 text-sm text-muted">Loading…</div>;
  const nav = [['/admin', 'Overview'], ['/admin/workspaces', 'Workspaces'], ['/admin/users', 'Users'], ['/admin/plans', 'Plans'], ['/admin/support', 'Support'], ['/admin/settings', 'Settings']];
  const active = (h: string) => (h === '/admin' ? path === h : path.startsWith(h));
  const ws = me.workspaces?.find((w: any) => w.status === 'active');
  return (
    <div className="min-h-screen bg-surface" dir="ltr">
      <header className="sticky top-0 z-20 border-b border-line bg-card">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-4 py-3">
          <Link href="/admin" className="flex items-center gap-2"><Logo size={28} /><span className="rounded-full bg-ink px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-white">Admin</span></Link>
          {!denied && <nav className="flex flex-1 flex-wrap gap-1">{nav.map(([h, l]) => <Link key={h} href={h} className={cx('rounded-[10px] px-3 py-1.5 text-sm font-medium', active(h) ? 'bg-brand-soft text-brand' : 'text-ink hover:bg-surface')}>{l}</Link>)}</nav>}
          <div className="ms-auto flex items-center gap-3 text-sm text-muted">
            {ws && <Link href={`/w/${ws.organization_id}/dashboard`} className="hover:text-ink">My workspace</Link>}
            <span>{me.user.email}</span>
            <button className="hover:text-ink" onClick={async () => { await post('/auth/logout'); router.replace('/login'); }}>Sign out</button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">{denied ? <p className="rounded-[12px] border border-line bg-card p-6 text-sm">{denied}</p> : children}</main>
    </div>
  );
}

export const STATUS_LABEL: Record<string, string> = { trial: 'Trial', active: 'Active', past_due: 'Payment due', trial_expired: 'Trial ended', expired: 'Expired', cancelled: 'Cancelled', suspended: 'Suspended' };
export const usd = (n: number | null | undefined) => (n == null ? '—' : `$${Number(n).toLocaleString('en', { maximumFractionDigits: 2 })}`);
