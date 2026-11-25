import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Meta WhatsApp Cloud API client. Nothing here is "connected" until a workspace saves a real phone number id and
 * access token and the connection test succeeds against Meta. Settings are read on each call so tests can point
 * the client at a local stand-in server.
 */
export const wa = {
  graphUrl: () => (process.env.WHATSAPP_GRAPH_URL ?? 'https://graph.facebook.com/v21.0').replace(/\/$/, ''),
  appSecret: () => process.env.WHATSAPP_APP_SECRET ?? '',
  verifyToken: () => process.env.WHATSAPP_VERIFY_TOKEN ?? '',
  defaultCountry: () => process.env.WHATSAPP_DEFAULT_COUNTRY_CODE ?? '961',
};

export const PURPOSES = ['confirmation', 'reminder_24h', 'reminder_2h', 'follow_up', 'vaccination', 'treatment', 'reschedule', 'cancellation', 'payment', 'announcement'] as const;
export type Purpose = (typeof PURPOSES)[number];
export const AUTOMATED = ['confirmation', 'reminder_24h', 'reminder_2h', 'follow_up', 'reschedule', 'cancellation'] as const;
export const APPOINTMENT_PURPOSES: string[] = ['confirmation', 'reminder_24h', 'reminder_2h', 'reschedule', 'cancellation'];

/**
 * Order of the {{1}}, {{2}}... body variables when a purpose is sent as an approved Meta template.
 * The clinic creates its template at Meta with variables in this order.
 */
export const TEMPLATE_PARAMS: Record<Purpose, string[]> = {
  confirmation: ['patient', 'doctor', 'clinic', 'date', 'time'],
  reminder_24h: ['patient', 'doctor', 'clinic', 'date', 'time'],
  reminder_2h: ['patient', 'doctor', 'clinic', 'time'],
  reschedule: ['patient', 'doctor', 'clinic', 'date', 'time'],
  cancellation: ['patient', 'doctor', 'clinic', 'date', 'time'],
  follow_up: ['patient', 'doctor', 'clinic', 'date'],
  vaccination: ['patient', 'clinic', 'date'],
  treatment: ['patient', 'clinic', 'doctor'],
  payment: ['patient', 'amount', 'clinic'],
  announcement: ['clinic', 'message'],
};

export function render(body: string, vars: Record<string, string>) {
  return body.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

/** Digits in international form without '+'. Local numbers get the default country code (Lebanon: 03 123 456 -> 9613123456). */
export function toWaNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.trim().replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (!d.startsWith(wa.defaultCountry()) || d.length <= 8) d = wa.defaultCountry() + d.replace(/^0/, '');
  d = d.replace(/\D/g, '');
  return d.length >= 8 && d.length <= 15 ? d : null;
}

/** X-Hub-Signature-256 check over the raw request body with the Meta app secret. */
export function validSignature(raw: Buffer, header: string | undefined, secret = wa.appSecret()): boolean {
  if (!secret || !header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'));
  const got = Buffer.from(header.slice(7));
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export class WaError extends Error { constructor(message: string, public status: number) { super(message); } }

async function call(path: string, token: string, init: { method?: string; body?: unknown } = {}) {
  let r: Response;
  try {
    r = await fetch(`${wa.graphUrl()}${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e: any) { throw new WaError(`Could not reach Meta: ${e?.message ?? e}`, 0); }
  const text = await r.text(); let data: any = null; try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!r.ok) throw new WaError(data?.error?.message ?? `Meta answered ${r.status}`, r.status);
  return data;
}

/** Connection test: Meta returns the number's display name when the id and token are valid. */
export const checkNumber = (phoneNumberId: string, token: string) =>
  call(`/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating`, token);

export async function sendText(phoneNumberId: string, token: string, to: string, body: string): Promise<string> {
  const d = await call(`/${encodeURIComponent(phoneNumberId)}/messages`, token, { method: 'POST',
    body: { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body } } });
  return d?.messages?.[0]?.id;
}

export async function sendTemplate(phoneNumberId: string, token: string, to: string, name: string, language: string, params: string[]): Promise<string> {
  const d = await call(`/${encodeURIComponent(phoneNumberId)}/messages`, token, { method: 'POST',
    body: { messaging_product: 'whatsapp', to, type: 'template',
      template: { name, language: { code: language }, components: params.length ? [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] : [] } } });
  return d?.messages?.[0]?.id;
}

const LOCALE: Record<string, string> = { en: 'en-GB', fr: 'fr-FR', ar: 'ar-LB' };
export function fmtDate(iso: string | Date, lang: string, tz: string) {
  return new Date(iso).toLocaleDateString(LOCALE[lang] ?? 'en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' });
}
export function fmtTime(iso: string | Date, lang: string, tz: string) {
  return new Date(iso).toLocaleTimeString(LOCALE[lang] ?? 'en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
}
export function fmtAmount(n: number, cur: string, lang: string) {
  return `${Number(n).toLocaleString(LOCALE[lang] ?? 'en-GB', { maximumFractionDigits: cur === 'LBP' ? 0 : 2, minimumFractionDigits: cur === 'LBP' ? 0 : 2 })} ${cur === 'USD' ? '$' : 'LBP'}`;
}
