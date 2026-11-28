'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button, cx, fmtDate, fmtMoney, fmtTime } from './ui';
import { startInvoice } from './Invoice';
import { useI18n } from '@/lib/i18n';
import { useWorkspace, type LiveAlert } from '@/lib/workspace';

export const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');

/** A short chime. Browsers only play sound after the person touched the page once, so the audio is unlocked then. */
let audio: AudioContext | null = null;
function unlockAudio() {
  try { audio ??= new (window.AudioContext || (window as any).webkitAudioContext)(); if (audio.state === 'suspended') audio.resume(); } catch { /* no audio */ }
}
function chime(times: number) {
  try {
    if (!audio) return;
    for (let i = 0; i < times; i++) {
      const o = audio.createOscillator(); const g = audio.createGain(); const t0 = audio.currentTime + i * 0.45;
      o.type = 'sine'; o.frequency.setValueAtTime(880, t0); o.frequency.setValueAtTime(660, t0 + 0.16);
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.35, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.38);
      o.connect(g).connect(audio.destination); o.start(t0); o.stop(t0 + 0.4);
    }
  } catch { /* no audio */ }
}

export const ICON: Record<LiveAlert['type'], string> = { called: '🔔', fee: '💵', completed: '✓', prescription: '℞', arrived: '🧍', request: '📅', booked: '🗓', cancelled: '✕', payment: '💳' };
const AUTO_HIDE: Partial<Record<LiveAlert['type'], number>> = { completed: 12000 };

/**
 * Live alerts on every page of the workspace. For the front desk: the doctor called a patient in (stays until
 * dismissed, with a chime and a vibration), set a fee to collect, finished a visit, issued a prescription to print, or
 * a patient asked for a visit from the patient app. For the doctor: their patient has arrived.
 */
export function LiveAlerts() {
  const { alerts, dismissAlert, can, org, orgId } = useWorkspace();
  const { t, lang } = useI18n();
  const heard = useRef(new Set<string>());
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const once = () => unlockAudio();
    window.addEventListener('pointerdown', once); window.addEventListener('keydown', once);
    return () => { window.removeEventListener('pointerdown', once); window.removeEventListener('keydown', once); };
  }, []);
  useEffect(() => {
    const fresh = alerts.filter((a) => !heard.current.has(a.key));
    if (!fresh.length) return;
    fresh.forEach((a) => heard.current.add(a.key));
    const called = fresh.some((a) => a.type === 'called');
    chime(called ? 3 : fresh.some((a) => a.type === 'arrived') ? 2 : 1);
    try { navigator.vibrate?.(called ? [250, 120, 250, 120, 250] : 150); } catch { /* not supported */ }
    for (const a of fresh) { const ms = AUTO_HIDE[a.type]; if (ms) setTimeout(() => dismissAlert(a.key), ms); }
  }, [alerts, dismissAlert]);
  // The tab title flashes while a call-in waits, so it is seen from another tab too.
  useEffect(() => {
    const waiting = alerts.some((a) => a.type === 'called');
    if (!waiting) return;
    const base = document.title; let on = false;
    const i = setInterval(() => { on = !on; document.title = on ? `🔔 ${t('liveSendIn')}` : base; }, 1000);
    return () => { clearInterval(i); document.title = base; };
  }, [alerts, t]);

  if (!alerts.length) return null;
  return <div aria-live="assertive" className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex max-h-[85vh] flex-col items-center gap-2 overflow-y-auto px-4">
    {err && <p className="pointer-events-auto rounded-[10px] bg-danger px-3 py-2 text-sm text-white" onClick={() => setErr(null)}>{err}</p>}
    {[...alerts].reverse().map((a) => {
      const v = { doctor: a.doctor_name, patient: a.patient_name };
      const title = a.type === 'called' ? t('liveSendIn') : a.type === 'fee' ? fill(t('liveCollect'), { amount: fmtMoney(a.fee_amount, a.fee_currency ?? 'USD', lang) })
        : a.type === 'completed' ? fill(t('liveDone'), v) : a.type === 'arrived' ? fill(t('liveArrived'), v) : a.type === 'request' ? t('liveRequest') : fill(t('liveRxReady'), v);
      const body = a.type === 'called' ? `${fill(t('liveCalledBody'), v)}${a.room_name ? ` · ${t('liveRoom')} ${a.room_name}` : ''}`
        : a.type === 'fee' ? fill(t('liveFeeBody'), v) : a.type === 'completed' && a.fee_amount != null ? fill(t('liveCollect'), { amount: fmtMoney(a.fee_amount, a.fee_currency ?? 'USD', lang) }) : a.type === 'prescription' ? a.doctor_name
        : a.type === 'arrived' && a.starts_at ? fill(t('liveArrivedBody'), { time: fmtTime(a.starts_at, lang) })
        : a.type === 'request' ? `${fill(t('liveRequestBody'), { patient: a.patient_name, date: a.starts_at ? fmtDate(a.starts_at, lang) : '' })}${a.doctor_name ? ` · ${a.doctor_name}` : ''}` : '';
      return <div key={a.key} role="alert" className={cx('pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-[14px] border p-4 shadow-lg',
        a.type === 'called' ? 'border-brand bg-brand text-white ring-4 ring-brand/30' : 'border-line bg-card text-ink')}>
        <span aria-hidden className={cx('flex size-10 shrink-0 items-center justify-center rounded-full text-xl', a.type === 'called' ? 'animate-pulse bg-white/20' : 'bg-brand-soft text-brand')}>{ICON[a.type]}</span>
        <div className="min-w-0 flex-1">
          <p className="text-base font-semibold">{title}</p>
          {body && <p className={cx('text-sm', a.type === 'called' ? 'text-white/90' : 'text-muted')}>{body}</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            {a.type === 'fee' && a.appointment_id && can('payment.register') && <Button size="sm" onClick={() => startInvoice(org.organization.id, { appointmentId: a.appointment_id! }).catch((e) => setErr(e.message))}>{t('liveTakePayment')}</Button>}
            {a.type === 'prescription' && a.prescription_id && <a href={`/print/prescriptions/${a.prescription_id}?org=${orgId}&lang=${lang}`} target="_blank" rel="noopener" className="inline-flex h-8 items-center rounded-[10px] bg-brand px-3 text-sm font-medium text-white">{t('livePrint')}</a>}
            {a.type === 'arrived' && <Link href={`/w/${orgId}/waiting-room`} onClick={() => dismissAlert(a.key)} className="inline-flex h-8 items-center rounded-[10px] bg-brand px-3 text-sm font-medium text-white">{t('liveOpenQueue')}</Link>}
            {a.type === 'request' && <Link href={`/w/${orgId}/dashboard`} onClick={() => dismissAlert(a.key)} className="inline-flex h-8 items-center rounded-[10px] bg-brand px-3 text-sm font-medium text-white">{t('liveReview')}</Link>}
            <Button size="sm" variant="ghost" className={a.type === 'called' ? 'bg-white px-5 font-semibold text-brand hover:bg-white/90' : ''} onClick={() => dismissAlert(a.key)}>{t('liveGotIt')}</Button>
          </div>
        </div>
      </div>;
    })}
  </div>;
}
