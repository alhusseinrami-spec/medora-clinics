'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui';
import { get, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

/** Registers the service worker once per page load (offline notice + push). */
export function ServiceWorker() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const url = process.env.NODE_ENV === 'production' ? '/sw.js' : '/sw.js?dev=1';
    navigator.serviceWorker.register(url, { scope: '/' }).catch(() => {});
  }, []);
  return null;
}

const b64ToBytes = (s: string) => {
  const raw = atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

type State = 'loading' | 'unsupported' | 'denied' | 'off' | 'on';

/** Turns phone/browser notifications on or off for this device. Real Web Push: the subscription is stored server-side. */
export function PushToggle() {
  const { t } = useI18n();
  const [state, setState] = useState<State>('loading'); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) { setState('unsupported'); return; }
    if (Notification.permission === 'denied') { setState('denied'); return; }
    navigator.serviceWorker.ready.then((r) => r.pushManager.getSubscription()).then((s) => setState(s ? 'on' : 'off')).catch(() => setState('off'));
  }, []);
  const enable = async () => {
    setBusy(true); setErr('');
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { setState(perm === 'denied' ? 'denied' : 'off'); return; }
      const { publicKey } = await get('/push/key', null);
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
      const j = sub.toJSON();
      await post('/push/subscriptions', { endpoint: j.endpoint, keys: j.keys, userAgent: navigator.userAgent.slice(0, 300) });
      setState('on');
    } catch (x: any) { setErr(x?.message ?? String(x)); } finally { setBusy(false); }
  };
  const disable = async () => {
    setBusy(true); setErr('');
    try {
      const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription();
      if (sub) { await post('/push/subscriptions/remove', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
      setState('off');
    } catch (x: any) { setErr(x?.message ?? String(x)); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-2 text-sm">
      <p className="text-muted">{t('pushHint')}</p>
      {state === 'unsupported' && <p>{t('pushUnsupported')}</p>}
      {state === 'denied' && <p className="text-danger">{t('pushDenied')}</p>}
      {state === 'off' && <Button busy={busy} onClick={enable}>{t('pushEnable')}</Button>}
      {state === 'on' && <div className="flex items-center gap-3"><span className="font-medium text-brand">{t('pushOn')}</span><Button variant="secondary" busy={busy} onClick={disable}>{t('pushDisable')}</Button></div>}
      {err && <p className="text-danger">{err}</p>}
    </div>
  );
}
