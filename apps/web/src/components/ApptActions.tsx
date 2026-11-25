'use client';
import { useState } from 'react';
import { nextStatuses, type AppointmentStatus } from '@medora/shared';
import { Button } from './ui';
import { post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

const LABEL: Record<string, string> = { confirmed: 'confirm', arrived: 'registerArrival', in_consultation: 'callIn', completed: 'complete', no_show: 'noShow', cancelled: 'cancelAppt' };

/** Only the transitions the status machine allows are shown, so every button does something real. */
export function ApptActions({ appt, onDone, compact }: { appt: { id: string; status: AppointmentStatus }; onDone: () => void; compact?: boolean }) {
  const { t } = useI18n(); const [busy, setBusy] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  const go = async (s: string) => {
    if (s === 'cancelled' && !confirm(t('cancelAppt') + '?')) return;
    setBusy(s); setErr(null);
    try { await post(`/appointments/${appt.id}/status`, { status: s }); onDone(); } catch (e: any) { setErr(e.message); } finally { setBusy(null); }
  };
  const opts = nextStatuses(appt.status).filter((s) => LABEL[s] && !(s === 'scheduled'));
  return <div className="flex flex-wrap items-center gap-1.5">
    {opts.map((s) => <Button key={s} size="sm" variant={s === 'cancelled' || s === 'no_show' ? 'ghost' : s === 'arrived' || s === 'in_consultation' ? 'primary' : 'secondary'} busy={busy === s} onClick={() => go(s)}>{t(LABEL[s])}</Button>)}
    {err && !compact && <span className="text-xs text-danger">{err}</span>}
  </div>;
}
