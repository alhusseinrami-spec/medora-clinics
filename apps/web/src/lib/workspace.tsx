'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, get, setActiveOrg, wsUrl } from './api';
import { LiveAlerts } from '@/components/LiveAlerts';

export interface Me { user: { id: string; email: string; full_name: string; interface_language: string; theme: string; mfa_enabled: boolean; is_platform_admin?: boolean }; workspaces: { organization_id: string; name: string; kind: string; membership_id: string; role_code: string; specialty_code: string | null; status: string }[] }
export interface OrgInfo {
  organization: { id: string; kind: 'independent_practice' | 'medical_center'; name: string; phone: string | null; email: string | null; address: string | null; default_language: string; timezone: string;
    legal_name?: string | null; tax_id?: string | null; share_patients_between_doctors?: boolean; allow_overbooking?: boolean; doctors_manage_absences?: boolean;
    day_sheet_phones?: boolean; message_window_start?: string; message_window_end?: string };
  locations: { id: string; name: string; address: string | null }[]; rooms: { id: string; name: string; location_id: string }[]; departments: { id: string; name: string }[];
  me: { memberships: { id: string; role_code: string; specialty_code: string | null }[]; permissions: string[]; actingDoctors: string[]; orgWide: boolean; doctorMembershipId: string | null };
  plan: { code: string; status: string; effectiveStatus: string; usable: boolean; features: Record<string, boolean> };
}
export interface LiveEvent { type: string; event?: string; appointment_id?: string; doctor_membership_id?: string; kind?: string; conversation_id?: string }
/** Something the doctor did that the front desk should act on (from GET /live). */
export interface LiveAlert { key: string; type: 'called' | 'fee' | 'completed' | 'prescription'; appointment_id: string | null; prescription_id: string | null;
  doctor_membership_id: string; doctor_name: string; patient_name: string; room_name: string | null; at: string; fee_amount: number | null; fee_currency: string | null }

interface WS { me: Me; org: OrgInfo; orgId: string; can: (p: string) => boolean; feature: (f: string) => boolean; reload: () => Promise<void>; live: boolean; subscribe: (fn: (e: LiveEvent) => void) => () => void;
  alerts: LiveAlert[]; dismissAlert: (key: string) => void }
const Ctx = createContext<WS>(null as any);

export function WorkspaceProvider({ orgId, children }: { orgId: string; children: ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<{ me: Me; org: OrgInfo } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const listeners = useRef(new Set<(e: LiveEvent) => void>());

  const reload = useCallback(async () => {
    setActiveOrg(orgId);
    try {
      const [me, org] = await Promise.all([get<Me>('/auth/me', null), get<OrgInfo>('/org')]);
      setState({ me, org });
      document.documentElement.dataset.theme = me.user.theme === 'system' ? '' : me.user.theme;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) router.replace('/login');
      else setError((e as Error).message);
    }
  }, [orgId, router]);
  useEffect(() => { reload(); }, [reload]);

  // Live waiting room channel with backoff reconnect.
  useEffect(() => {
    let ws: WebSocket | null = null; let stop = false; let delay = 1000; let timer: any;
    const connect = () => {
      ws = new WebSocket(wsUrl());
      ws.onopen = () => { delay = 1000; ws!.send(JSON.stringify({ type: 'subscribe', orgId })); };
      ws.onmessage = (m) => { const e = JSON.parse(m.data); if (e.type === 'subscribed') setLive(true); listeners.current.forEach((fn) => fn(e)); };
      ws.onclose = () => { setLive(false); if (!stop) timer = setTimeout(connect, (delay = Math.min(delay * 2, 30000))); };
    };
    connect();
    return () => { stop = true; clearTimeout(timer); ws?.close(); };
  }, [orgId]);

  const subscribe = useCallback((fn: (e: LiveEvent) => void) => { listeners.current.add(fn); return () => { listeners.current.delete(fn); }; }, []);

  // Live sync by polling GET /live: every 3 seconds while the page is open and the WebSocket is not connected (the public
  // demo on Vercel cannot keep one open), every 20 seconds as a safety net when it is, and right after any socket event.
  // A changed `sig` refreshes the open screens; new events become alerts for the front desk.
  const [alerts, setAlerts] = useState<LiveAlert[]>([]);
  const pollNow = useRef<() => void>(() => {});
  const liveRef = useRef(false); liveRef.current = live;
  const me = state?.org.me;
  const wantsAlerts = !!me && (me.permissions.includes('appointment.manage') || me.permissions.includes('payment.register'));
  const myDoctor = me?.doctorMembershipId ?? null;
  useEffect(() => {
    if (!state) return;
    let stop = false; let timer: any; let cursor: string | null = null; let sig: string | null = null; const seen = new Set<string>();
    const poll = async () => {
      clearTimeout(timer);
      try {
        const r = await get<{ cursor: string; sig: string; events: LiveAlert[] }>(`/live${cursor ? `?since=${encodeURIComponent(cursor)}` : ''}`);
        if (stop) return;
        cursor = r.cursor;
        if (sig !== null && r.sig !== sig) listeners.current.forEach((fn) => fn({ type: 'waiting_room', event: 'sync' }));
        sig = r.sig;
        const fresh = r.events.filter((e) => !seen.has(e.key));
        fresh.forEach((e) => seen.add(e.key));
        // The doctor does not get alerts about their own visits; the front desk does.
        const mine = fresh.filter((e) => wantsAlerts && e.doctor_membership_id !== myDoctor);
        if (mine.length) setAlerts((xs) => {
          let next = xs.filter((x) => !mine.some((m) => m.key === x.key));
          for (const e of mine) {
            const same = (x: LiveAlert, type: string) => x.type === type && x.appointment_id === e.appointment_id;
            // A newer fee replaces the older one; a finished visit closes its call-in, and says nothing more while its fee is on screen.
            if (e.type === 'fee') next = next.filter((x) => !same(x, 'fee'));
            if (e.type === 'completed') { next = next.filter((x) => !same(x, 'called')); if (next.some((x) => same(x, 'fee'))) continue; }
            next.push(e);
          }
          return next.slice(-4);
        });
      } catch { /* offline or signed out: try again on the next tick */ }
      if (!stop) timer = setTimeout(poll, document.visibilityState !== 'visible' ? 30000 : liveRef.current ? 20000 : 3000);
    };
    pollNow.current = () => { poll(); };
    const onVisible = () => { if (document.visibilityState === 'visible') poll(); };
    document.addEventListener('visibilitychange', onVisible);
    poll();
    return () => { stop = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); pollNow.current = () => {}; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, !!state, wantsAlerts, myDoctor]);
  useEffect(() => subscribe((e) => { if (e.event !== 'sync') pollNow.current(); }), [subscribe]);
  const dismissAlert = useCallback((key: string) => setAlerts((xs) => xs.filter((x) => x.key !== key)), []);

  if (error) return <div className="p-10 text-danger">{error}</div>;
  if (!state) return <div className="p-10 text-muted">…</div>;
  return <Ctx.Provider value={{ ...state, orgId, can: (p) => state.org.me.permissions.includes(p), feature: (f) => state.org.plan?.features?.[f] === true, reload, live, subscribe, alerts, dismissAlert }}>
    {children}<LiveAlerts />
  </Ctx.Provider>;
}
export const useWorkspace = () => useContext(Ctx);

/** Re-run a loader whenever the waiting room changes, plus on mount. */
export function useLiveReload(load: () => void) {
  const { subscribe, live } = useWorkspace();
  useEffect(() => { load(); return subscribe((e) => { if (e.type === 'waiting_room' || e.type === 'notification') load(); }); }, [load, subscribe]);
  // Safety net: the live poll above refreshes screens within seconds; this catches anything it cannot see.
  useEffect(() => {
    if (live) return;
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 60000);
    return () => clearInterval(timer);
  }, [live, load]);
}
