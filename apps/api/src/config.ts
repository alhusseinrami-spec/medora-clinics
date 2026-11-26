import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

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

function fileKey(): Buffer {
  if (env.FILE_ENC_KEY) {
    const k = Buffer.from(env.FILE_ENC_KEY, 'hex');
    if (k.length !== 32) throw new Error('FILE_ENC_KEY must be 64 hex characters');
    return k;
  }
  if (isProd) throw new Error('FILE_ENC_KEY is required in production');
  return createHash('sha256').update('medora-development-only-file-key').digest();
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
  /** Platform administrators must use two-factor sign-in (always in production). */
  requireAdminMfa: isProd || env.ADMIN_REQUIRE_MFA === 'true',
  /** Tests that sign up many accounts from one address switch the per-IP limits off. Never in production. */
  rateLimitOff: !isProd && env.RATE_LIMIT === 'off',
  /** Public demo server: anyone may view the synthetic clinic as any role and reset it. Never on a server with real data. */
  get demoMode() { return env.DEMO_MODE === 'true'; },
  fileKey: fileKey(),
  /** Encrypted local file storage. S3-compatible storage is used only when its credentials are set (not connected yet). */
  storageDir: env.STORAGE_DIR ?? fileURLToPath(new URL('../../storage/', import.meta.url)),
  s3Configured: Boolean(env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY),
  maxUploadBytes: 15 * 1024 * 1024,
};
export type Config = typeof config;
