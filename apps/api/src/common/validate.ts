import { BadRequestException } from '@nestjs/common';

// Small, explicit request validation: every endpoint declares exactly what it accepts.
type Rule<T> = { parse: (v: unknown, path: string, errs: string[]) => T | undefined; isOptional?: boolean };
type Out<S> = { [K in keyof S]: S[K] extends Rule<infer T> ? T : never };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function rule<T>(parse: Rule<T>['parse']) {
  const r: Rule<T> & { optional: () => Rule<T | undefined>; nullable: () => Rule<T | null> } = {
    parse,
    optional: () => ({ isOptional: true, parse: (v, p, e) => (v === undefined || v === '' ? undefined : parse(v, p, e)) }),
    nullable: () => ({ isOptional: true, parse: (v, p, e) => (v === null || v === '' ? null : v === undefined ? undefined : parse(v, p, e)) as any }),
  };
  return r;
}
export const v = {
  str: (min = 1, max = 500) => rule<string>((x, p, e) => {
    if (typeof x !== 'string') { e.push(`${p} must be text`); return; }
    const s = x.trim(); if (s.length < min || s.length > max) { e.push(`${p} must be ${min}-${max} characters`); return; }
    return s;
  }),
  email: () => rule<string>((x, p, e) => (typeof x === 'string' && EMAIL.test(x.trim()) && x.length <= 254 ? x.trim().toLowerCase() : (e.push(`${p} must be an email address`), undefined))),
  password: () => rule<string>((x, p, e) => (typeof x === 'string' && x.length >= 10 && x.length <= 200 ? x : (e.push(`${p} must be at least 10 characters`), undefined))),
  uuid: () => rule<string>((x, p, e) => (typeof x === 'string' && UUID.test(x) ? x : (e.push(`${p} must be an id`), undefined))),
  int: (min = -2e9, max = 2e9) => rule<number>((x, p, e) => { const n = typeof x === 'string' ? Number(x) : x; return Number.isInteger(n) && (n as number) >= min && (n as number) <= max ? (n as number) : (e.push(`${p} must be a whole number ${min}-${max}`), undefined); }),
  num: (min = 0, max = 1e9) => rule<number>((x, p, e) => { const n = typeof x === 'string' ? Number(x) : x; return typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max ? n : (e.push(`${p} must be a number ${min}-${max}`), undefined); }),
  bool: () => rule<boolean>((x, p, e) => (typeof x === 'boolean' ? x : (e.push(`${p} must be true or false`), undefined))),
  enum: <T extends string>(...vals: T[]) => rule<T>((x, p, e) => (vals.includes(x as T) ? (x as T) : (e.push(`${p} must be one of ${vals.join(', ')}`), undefined))),
  date: () => rule<string>((x, p, e) => (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) && !Number.isNaN(Date.parse(x)) ? x : (e.push(`${p} must be a date YYYY-MM-DD`), undefined))),
  datetime: () => rule<string>((x, p, e) => (typeof x === 'string' && !Number.isNaN(Date.parse(x)) && /T/.test(x) ? new Date(x).toISOString() : (e.push(`${p} must be an ISO date-time`), undefined))),
  time: () => rule<string>((x, p, e) => (typeof x === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(x) ? x : (e.push(`${p} must be HH:MM`), undefined))),
  any: () => rule<unknown>((x) => x),
  array: <T>(item: Rule<T>, max = 100) => rule<T[]>((x, p, e) => {
    if (!Array.isArray(x) || x.length > max) { e.push(`${p} must be a list of at most ${max}`); return; }
    return x.map((it, i) => item.parse(it, `${p}[${i}]`, e) as T);
  }),
  object: <S extends Record<string, Rule<any>>>(shape: S) => rule<Out<S>>((x, p, e) => parseShape(shape, x, p, e)),
};

function parseShape<S extends Record<string, Rule<any>>>(shape: S, x: unknown, prefix: string, errs: string[]): Out<S> | undefined {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) { errs.push(`${prefix || 'body'} must be an object`); return; }
  const src = x as Record<string, unknown>; const out: Record<string, unknown> = {};
  for (const k of Object.keys(src)) if (!(k in shape)) errs.push(`${prefix ? prefix + '.' : ''}${k} is not accepted`);
  for (const [k, r] of Object.entries(shape)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (src[k] === undefined && !r.isOptional) { errs.push(`${path} is required`); continue; }
    const val = r.parse(src[k], path, errs); if (val !== undefined) out[k] = val;
  }
  return out as Out<S>;
}

export function parse<S extends Record<string, Rule<any>>>(shape: S, body: unknown): Out<S> {
  const errs: string[] = [];
  const out = parseShape(shape, body ?? {}, '', errs);
  if (errs.length) throw new BadRequestException({ message: 'Invalid request', errors: errs });
  return out!;
}
