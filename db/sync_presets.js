// Syncs platform specialty presets (packages/shared/src/presets.ts) into clinical_templates.
// Runs as the schema owner. Idempotent: a changed preset becomes a new published version; old versions stay.
const { Client } = require('pg');
const path = require('path');
const { pathToFileURL } = require('url');
const url = process.env.DATABASE_URL || 'postgres://medora:medora_dev@localhost:5432/medora';
async function syncPresets({ log = console.log } = {}) {
  const { PRESETS: P1, EXAM_PRESETS } = await import(pathToFileURL(path.join(__dirname, '../packages/shared/dist/index.js')).href);
  const c = new Client(url); await c.connect();
  try {
    for (const p of [...P1, ...EXAM_PRESETS]) {
      let t = (await c.query(`SELECT id FROM clinical_templates WHERE owner_membership_id IS NULL AND specialty_code=$1 AND kind=$2`, [p.specialty, p.kind])).rows[0];
      if (!t) t = (await c.query(`INSERT INTO clinical_templates(kind,specialty_code,name) VALUES($1,$2,$3) RETURNING id`, [p.kind, p.specialty, p.name])).rows[0];
      const latest = (await c.query(`SELECT version, schema = $2::jsonb AS same FROM template_versions WHERE template_id=$1 ORDER BY version DESC LIMIT 1`, [t.id, JSON.stringify(p.schema)])).rows[0];
      if (!latest || !latest.same) {
        await c.query(`INSERT INTO template_versions(template_id,version,schema,published_at) VALUES($1,$2,$3,now())`, [t.id, (latest?.version || 0) + 1, JSON.stringify(p.schema)]);
        log(`preset ${p.specialty}/${p.kind} -> v${(latest?.version || 0) + 1}`);
      }
    }
  } finally { await c.end(); }
}
module.exports = { syncPresets };
if (require.main === module) syncPresets().catch(e => { console.error(e); process.exit(1); });
