import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import type { Db } from '../db/db.service.js';

/** Response headers for every API answer. API responses hold personal data: never cached, never framed. */
export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (!res.getHeader('Content-Security-Policy')) res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-store');
  if (config.isProd) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.removeHeader('X-Powered-By');
  next();
}

/** Per-IP limits on endpoints that can be abused without an account. Counted in Postgres, so they hold across API instances. */
const RULES: { test: RegExp; method?: string; limit: number; windowSeconds: number; name: string }[] = [
  { name: 'login', test: /^\/api\/auth\/(login|mfa\/verify)$/, method: 'POST', limit: 20, windowSeconds: 300 },
  { name: 'register', test: /^\/api\/auth\/register\//, method: 'POST', limit: 10, windowSeconds: 3600 },
  { name: 'password', test: /^\/api\/auth\/password\//, method: 'POST', limit: 10, windowSeconds: 3600 },
  { name: 'demo', test: /^\/api\/demo\/(login|reset)$/, method: 'POST', limit: 30, windowSeconds: 300 },
  { name: 'invite-preview', test: /^\/api\/(invitations|portal\/invitations)\/[^/]+$/, method: 'GET', limit: 60, windowSeconds: 600 },
];

export function rateLimit(db: Db) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (config.rateLimitOff) return next();
    const rule = RULES.find((r) => (!r.method || r.method === req.method) && r.test.test(req.path));
    if (!rule) return next();
    try {
      const ok = await db.tx({}, async (t) => (await t.one(`SELECT rate_hit($1,$2,$3) AS ok`, [`${rule.name}:${req.ip}`, rule.limit, rule.windowSeconds])).ok);
      if (!ok) { res.setHeader('Retry-After', String(rule.windowSeconds)); return res.status(429).json({ message: 'Too many attempts. Please wait a few minutes and try again.', code: 'rate_limited' }); }
    } catch { /* never block sign-in because the limiter failed */ }
    next();
  };
}
