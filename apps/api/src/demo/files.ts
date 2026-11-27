import { fileURLToPath } from 'node:url';

/**
 * Schema and demo scripts the demo server runs, from the repository's db/ folder (compiled location: apps/api/dist/src/demo).
 * Written as literal `new URL(..., import.meta.url)` so a serverless bundler (Vercel) sees and ships these files.
 */
export const DB_FILES = {
  migrate: fileURLToPath(new URL('../../../../../db/migrate.js', import.meta.url)),
  migrations: fileURLToPath(new URL('../../../../../db/migrations/', import.meta.url)),
  syncPresets: fileURLToPath(new URL('../../../../../db/sync_presets.js', import.meta.url)),
  seed: fileURLToPath(new URL('../../../../../db/seed_synthetic.mjs', import.meta.url)),
  demoToday: fileURLToPath(new URL('../../../../../db/demo_today.js', import.meta.url)),
};
