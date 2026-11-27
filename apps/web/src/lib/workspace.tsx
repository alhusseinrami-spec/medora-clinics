'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, get, setActiveOrg, wsUrl } from './api';

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

interface WS { me: Me; org: OrgInfo; orgId: string; can: (p: string) => boolean; feature: (f: string) => boolean; reload: () => Promise<void>; live: boolean; subscribe: (fn: (e: LiveEvent) => void) => () => void }
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

  if (error) return <div className="p-10 text-danger">{error}</div>;
  if (!state) return <div className="p-10 text-muted">…</div>;
  return <Ctx.Provider value={{ ...state, orgId, can: (p) => state.org.me.permissions.includes(p), feature: (f) => state.org.plan?.features?.[f] === true, reload, live, subscribe }}>{children}</Ctx.Provider>;
}
export const useWorkspace = () => useContext(Ctx);

/** Re-run a loader whenever the waiting room changes, plus on mount. */
export function useLiveReload(load: () => void) {
  const { subscribe, live } = useWorkspace();
  useEffect(() => { load(); return subscribe((e) => { if (e.type === 'waiting_room' || e.type === 'notification') load(); }); }, [load, subscribe]);
  // Without the live channel (a host that cannot keep the WebSocket open), refresh every 20 seconds instead.
  useEffect(() => {
    if (live) return;
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 20000);
    return () => clearInterval(timer);
  }, [live, load]);
}
