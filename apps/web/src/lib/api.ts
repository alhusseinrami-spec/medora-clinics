// Typed fetch wrapper. Session is an httpOnly cookie; the active workspace travels in X-Org-Id.
export class ApiError extends Error {
  constructor(public status: number, public body: any) { super(body?.message ?? `Request failed (${status})`); }
  get details(): string[] { return this.body?.errors ?? []; }
}

let activeOrg: string | null = null;
export const setActiveOrg = (id: string | null) => { activeOrg = id; };

export async function api<T = any>(path: string, init: { method?: string; body?: unknown; org?: string | null } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const org = init.org === undefined ? activeOrg : init.org;
  if (org) headers['x-org-id'] = org;
  const res = await fetch(`/api${path}`, { method: init.method ?? 'GET', headers, credentials: 'include', body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}
export const get = <T = any>(p: string, org?: string | null) => api<T>(p, { org });
export const post = <T = any>(p: string, body: unknown = {}) => api<T>(p, { method: 'POST', body });
export const patch = <T = any>(p: string, body: unknown) => api<T>(p, { method: 'PATCH', body });
export const put = <T = any>(p: string, body: unknown) => api<T>(p, { method: 'PUT', body });
export const del = <T = any>(p: string) => api<T>(p, { method: 'DELETE' });

export function wsUrl() {
  const explicit = process.env.NEXT_PUBLIC_WS_URL;
  if (explicit) return explicit;
  const { protocol, hostname } = window.location;
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${hostname}:4000/ws`;
}
