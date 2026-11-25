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

/** Sends a file as the raw request body (the API checks its type by content and encrypts it). */
export async function uploadFile<T = any>(path: string, file: File): Promise<T> {
  const headers: Record<string, string> = { 'content-type': file.type || 'application/octet-stream' };
  if (activeOrg) headers['x-org-id'] = activeOrg;
  const res = await fetch(`/api${path}`, { method: 'POST', headers, credentials: 'include', body: file });
  const text = await res.text(); const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

/** Fetches a protected file (the workspace header cannot ride on a plain link) and opens or saves it. */
export async function openFile(path: string, filename?: string) {
  const headers: Record<string, string> = {};
  if (activeOrg) headers['x-org-id'] = activeOrg;
  const res = await fetch(`/api${path}`, { headers, credentials: 'include' });
  if (!res.ok) { const text = await res.text(); throw new ApiError(res.status, text ? JSON.parse(text) : null); }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a'); a.href = url; a.rel = 'noopener';
  if (filename) a.download = filename; else a.target = '_blank';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function wsUrl() {
  const explicit = process.env.NEXT_PUBLIC_WS_URL;
  if (explicit) return explicit;
  const { protocol, hostname } = window.location;
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${hostname}:4000/ws`;
}
