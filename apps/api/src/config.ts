import { createHash } from 'node:crypto';

const env = process.env;
const isProd = env.NODE_ENV === 'production';

function mfaKey(): Buffer {
  if (env.MFA_ENC_KEY) {
    const k = Buffer.from(env.MFA_ENC_KEY, 'hex');
    if (k.length !== 32) throw new Error('MFA_ENC_KEY must be 64 hex characters');
    return k;
  }
  if (isProd) throw new Error('MFA_ENC_KEY is required in production');
  return createHash('sha256').update('medora-development-only-key').digest();
}

export const config = {
  env: env.NODE_ENV ?? 'development',
  isProd,
  port: Number(env.PORT ?? 4000),
  databaseUrl: env.APP_DATABASE_URL ?? 'postgres://medora_app:medora_app_dev@localhost:5432/medora',
  webOrigin: (env.WEB_ORIGIN ?? 'http://localhost:3000').split(','),
  webBaseUrl: env.WEB_BASE_URL ?? 'http://localhost:3000',
  sessionTtlHours: Number(env.SESSION_TTL_HOURS ?? 12),
  cookieSecure: isProd || env.COOKIE_SECURE === 'true',
  mfaKey: mfaKey(),
  emailProviderConfigured: Boolean(env.EMAIL_PROVIDER_API_KEY),
};
export type Config = typeof config;
