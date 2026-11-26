'use client';
import { useEffect, useState } from 'react';
import { Button, ErrorNote, Select } from '@/components/ui';
import { get, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

type DemoInfo = { enabled: boolean; roles?: string[]; canReset?: boolean };
let cached: Promise<DemoInfo> | null = null;
/** Whether this server is the public demo. Asked once per page load. */
export function useDemo() {
  const [info, setInfo] = useState<DemoInfo | null>(null);
  useEffect(() => { (cached ??= get<DemoInfo>('/demo', null).catch(() => ({ enabled: false }))).then(setInfo); }, []);
  return info?.enabled ? info : null;
}

/** Signs in as the demo account for a role and opens where that person works. A full page load resets every screen's state. */
async function viewAs(as: string) {
  const r = await post<{ organizationId: string | null; portal: boolean }>('/demo/login', { as });
  window.location.assign(r.portal ? '/portal' : r.organizationId ? `/w/${r.organizationId}/dashboard` : '/');
}
async function resetDemo() {
  await post('/demo/reset');
  window.location.assign('/login');
}

/** On the sign-in page of the demo server: one button per role, and reset. */
export function DemoPicker() {
  const demo = useDemo(); const { t } = useI18n(); const [busy, setBusy] = useState(''); const [err, setErr] = useState<unknown>(null);
  if (!demo) return null;
  const run = (k: string, fn: () => Promise<void>) => async () => { setBusy(k); setErr(null); try { await fn(); } catch (e) { setErr(e); setBusy(''); } };
  return <div className="mb-6 rounded-[14px] border border-brand/30 bg-brand-soft/40 p-4">
    <p className="text-sm font-semibold text-brand">{t('demoTitle')}</p>
    <p className="mt-1 text-xs text-muted">{t('demoHint')}</p>
    <div className="mt-3 grid grid-cols-2 gap-2">{demo.roles!.map((r) => <Button key={r} size="sm" variant="secondary" busy={busy === r} disabled={!!busy} onClick={run(r, () => viewAs(r))}>{t(`demoAs_${r}`)}</Button>)}</div>
    {demo.canReset && <button disabled={!!busy} onClick={run('reset', resetDemo)} className="mt-3 text-xs text-muted underline hover:text-ink">{busy === 'reset' ? t('demoResetting') : t('demoReset')}</button>}
    <div className="mt-2"><ErrorNote error={err} /></div>
  </div>;
}

/** Inside the app on the demo server: a strip to switch role or reset the demo. */
export function DemoBanner() {
  const demo = useDemo(); const { t } = useI18n(); const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  if (!demo) return null;
  const run = (fn: () => Promise<void>) => async () => { setBusy(true); setErr(null); try { await fn(); } catch (e) { setErr(e); setBusy(false); } };
  return <div className="flex flex-wrap items-center gap-2 border-b border-brand/20 bg-brand-soft/50 px-4 py-1.5 text-xs md:px-8 print:hidden">
    <span className="font-semibold text-brand">{t('demoTitle')}</span>
    <span className="text-muted">{t('demoViewAs')}</span>
    <Select aria-label={t('demoViewAs')} disabled={busy} defaultValue="" onChange={(e) => e.target.value && run(() => viewAs(e.target.value))()} className="!h-7 !w-44 !py-0 text-xs">
      <option value="">—</option>{demo.roles!.map((r) => <option key={r} value={r}>{t(`demoAs_${r}`)}</option>)}</Select>
    {demo.canReset && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { if (confirm(t('demoResetConfirm'))) run(resetDemo)(); }}>{busy ? t('demoResetting') : t('demoReset')}</Button>}
    <ErrorNote error={err} />
  </div>;
}
