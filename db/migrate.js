// Applies db/migrations/*.sql in order and records them in schema_migrations.
// Usage: DATABASE_URL=postgres://owner@... node db/migrate.js [--reset]   (--reset drops the public schema: dev only)
const { Client } = require('pg');
const fs = require('fs'); const path = require('path');
const url = process.env.DATABASE_URL || 'postgres://medora:medora_dev@localhost:5432/medora';
async function migrate({ reset = false, log = console.log } = {}) {
  const c = new Client(url); await c.connect();
  try {
    if (reset) {
      if (process.env.NODE_ENV === 'production') throw new Error('refusing --reset in production');
      await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    }
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
    const dir = path.join(__dirname, 'migrations');
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      await c.query('BEGIN');
      try {
        await c.query(fs.readFileSync(path.join(dir, f), 'utf8'));
        await c.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
        await c.query('COMMIT'); log(`applied ${f}`);
      } catch (e) { await c.query('ROLLBACK'); throw new Error(`${f}: ${e.message}`); }
    }
    const appPw = process.env.APP_DB_PASSWORD || (process.env.NODE_ENV !== 'production' ? 'medora_app_dev' : null);
    if (appPw) await c.query(`ALTER ROLE medora_app LOGIN PASSWORD '${appPw.replace(/'/g, "''")}'`);
  } finally { await c.end(); }
}
module.exports = { migrate };
if (require.main === module) migrate({ reset: process.argv.includes('--reset') }).catch(e => { console.error(e.message); process.exit(1); });
