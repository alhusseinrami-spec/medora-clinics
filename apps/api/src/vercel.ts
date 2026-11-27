// Entry for the public demo on Vercel (vercel.json at the repository root): the same API as main.ts, handed to the
// platform as an HTTP server instead of listening on a port. The WebSocket (/ws) is attached to this server too.
import './demo/env.js';
import { createRequire } from 'node:module';
import { createApp } from './app.js';
import { PRESETS, EXAM_PRESETS } from '@medora/shared';
import { DB_FILES } from './demo/files.js';

// Demo server only: bring the demo database's schema up to date before the API connects (a new database has none,
// and the API's own database role is created by the migrations). One instance at a time, under an advisory lock.
if (process.env.DEMO_MODE === 'true' && process.env.DATABASE_URL) {
  const require = createRequire(import.meta.url);
  const { Client } = require('pg');
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query('SELECT pg_advisory_lock(424242)');
    const { migrate } = require(DB_FILES.migrate);
    const { syncPresets } = require(DB_FILES.syncPresets);
    await migrate({ log: () => {} });
    await syncPresets({ log: () => {}, presets: { PRESETS, EXAM_PRESETS } });
  } finally {
    await c.query('SELECT pg_advisory_unlock(424242)').catch(() => undefined);
    await c.end();
  }
}

const { app } = await createApp();
export default app.getHttpServer();
