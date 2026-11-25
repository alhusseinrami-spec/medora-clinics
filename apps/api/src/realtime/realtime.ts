import type { Server } from 'node:http';
import pg from 'pg';
import { WebSocketServer, WebSocket } from 'ws';
import { Db } from '../db/db.service.js';
import { config } from '../config.js';
import { sha256 } from '../common/crypto.js';
import { SESSION_COOKIE } from '../common/guards.js';

interface Sub { ws: WebSocket; userId: string; orgId?: string; orgWide?: boolean; doctors?: Set<string> }

/**
 * Real-time waiting room. PostgreSQL triggers NOTIFY on every appointment status change; this listener forwards
 * the event (ids only, no patient data) to sockets whose user may see that doctor's queue. Clients then refetch over REST.
 * Protocol: connect to /ws with the session cookie (or ?token=), then send {"type":"subscribe","orgId":"..."}.
 */
export async function attachRealtime(server: Server, db: Db) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const subs = new Set<Sub>();
  const listener = new pg.Client({ connectionString: config.databaseUrl });
  await listener.connect();
  await listener.query('LISTEN waiting_room');
  listener.on('notification', (n) => {
    let ev: any; try { ev = JSON.parse(n.payload ?? '{}'); } catch { return; }
    for (const s of subs) {
      if (s.orgId !== ev.organization_id) continue;
      if (!s.orgWide && !s.doctors?.has(ev.doctor_membership_id)) continue;
      if (s.ws.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify({ type: 'waiting_room', ...ev }));
    }
  });

  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const cookie = Object.fromEntries((req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=').map(decodeURIComponent)).filter((p) => p.length === 2));
    const token = url.searchParams.get('token') ?? cookie[SESSION_COOKIE];
    if (config.isProd && !config.webOrigin.includes(String(req.headers.origin))) { ws.close(4003, 'origin'); return; }
    // Register the message handler before any await, so an early "subscribe" is never lost.
    const ready: Promise<Sub | null> = (async () => {
      const s = token ? await db.tx({}, (t) => t.one(`SELECT * FROM auth_find_session($1)`, [sha256(token)])).catch(() => undefined) : undefined;
      if (!s || s.mfa_pending || s.user_status !== 'active') { ws.close(4001, 'unauthorized'); return null; }
      const sub: Sub = { ws, userId: s.user_id };
      subs.add(sub);
      ws.on('close', () => subs.delete(sub));
      return sub;
    })();
    ws.on('message', async (raw) => {
      const sub = await ready; if (!sub) return;
      let msg: any; try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg?.type !== 'subscribe' || typeof msg.orgId !== 'string') return;
      try {
        const scope = await db.tx({ userId: sub.userId, orgId: msg.orgId }, async (t) => {
          const member = (await t.one(`SELECT app_is_member($1) AS m`, [msg.orgId])).m;
          if (!member) return null;
          return { wide: (await t.one(`SELECT app_is_org_wide() AS w`)).w, doctors: (await t.q(`SELECT app_acting_doctors() AS id`)).map((r) => r.id) };
        });
        if (!scope) { ws.send(JSON.stringify({ type: 'error', message: 'not a member' })); return; }
        Object.assign(sub, { orgId: msg.orgId, orgWide: scope.wide, doctors: new Set(scope.doctors) });
        ws.send(JSON.stringify({ type: 'subscribed', orgId: msg.orgId }));
      } catch { ws.send(JSON.stringify({ type: 'error', message: 'subscribe failed' })); }
    });
  });
  return { close: async () => { for (const s of subs) s.ws.terminate(); wss.close(); await listener.end(); } };
}
