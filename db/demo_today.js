// Demo only: keeps the synthetic demo looking like "today" on whatever day it is opened.
//   node db/demo_today.js <state-file>
// The state file holds the day the data was last aligned to. When today is a later (or earlier) day, every
// appointment moves by the same number of days, so the calendar, the day sheet and the waiting room stay live.
// On the first run and after each move, the patients in the waiting room get staggered arrival times (a few
// minutes to about forty minutes ago) and the patient with the doctor was called in a quarter of an hour ago.
// Needs the database owner (DATABASE_URL); never run it against a real clinic's database.
//
// Also used by the API on a public demo server (DEMO_MODE=true), which keeps the day in the database instead of a file.
const fs = require('fs');
const { Client } = require('pg');

/** Aligns the demo data to today. `last` is the day it was aligned to before (YYYY-MM-DD), or null. Returns today. */
async function alignToday(c, last) {
  try {
    const { rows: [{ today }] } = await c.query(`SELECT to_char(current_date, 'YYYY-MM-DD') AS today`);
    if (last === today) return { today, moved: false };
    await c.query('BEGIN');
    // Plain data moves: no notifications, no audit rows, no reminder queueing. A superuser switches triggers off for
    // the transaction; a hosted database owner (no superuser) switches the table's own triggers off instead.
    const { rows: [{ su }] } = await c.query(`SELECT rolsuper AS su FROM pg_roles WHERE rolname = current_user`);
    if (su) await c.query(`SET LOCAL session_replication_role = replica`);
    else await c.query(`ALTER TABLE appointments DISABLE TRIGGER USER`);
    if (last) {
      // Two steps through the far future, because the no-double-booking rule is checked row by row: moving straight
      // by a day could briefly put one appointment on top of another that has not moved yet.
      const cols = ['starts_at', 'ends_at', 'arrived_at', 'called_at', 'started_at', 'completed_at'];
      const move = (by) => c.query(`UPDATE appointments SET ${cols.map((k) => `${k} = ${k} + ${by}`).join(', ')}`, [last]);
      await move(`((current_date - $1::date) + 36500) * interval '1 day'`);
      await c.query(`UPDATE appointments SET ${cols.map((k) => `${k} = ${k} - interval '36500 days'`).join(', ')}`);
    }
    await c.query(`WITH q AS (SELECT id, row_number() OVER (PARTITION BY doctor_membership_id ORDER BY arrived_at, starts_at) AS rn,
        count(*) OVER (PARTITION BY doctor_membership_id) AS n FROM appointments WHERE status IN ('arrived','waiting'))
      UPDATE appointments a SET arrived_at = now() - ((q.n - q.rn) * 11 + 4) * interval '1 minute' FROM q WHERE a.id = q.id`);
    await c.query(`UPDATE appointments SET starts_at = arrived_at, ends_at = arrived_at + (ends_at - starts_at)
      WHERE is_walk_in AND status IN ('arrived','waiting')`);
    await c.query(`UPDATE appointments SET called_at = now() - interval '14 minutes', started_at = now() - interval '14 minutes',
      arrived_at = now() - interval '31 minutes'
      WHERE status = 'in_consultation'`);
    if (!su) await c.query(`ALTER TABLE appointments ENABLE TRIGGER USER`);
    await c.query('COMMIT');
    return { today, moved: Boolean(last) };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

/** Same, with the last day kept in the demo database (table demo_state). */
async function alignTodayInDb(connectionString) {
  const c = new Client({ connectionString });
  await c.connect();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS demo_state (key text PRIMARY KEY, value text NOT NULL)`);
    const last = (await c.query(`SELECT value FROM demo_state WHERE key = 'aligned_day'`)).rows[0]?.value ?? null;
    const r = await alignToday(c, last);
    if (r.today !== last) await c.query(`INSERT INTO demo_state(key, value) VALUES ('aligned_day', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [r.today]);
    return r;
  } finally { await c.end(); }
}

module.exports = { alignToday, alignTodayInDb };

if (require.main === module) (async () => {
  const state = process.argv[2];
  if (!state || !process.env.DATABASE_URL) { console.error('usage: DATABASE_URL=... node db/demo_today.js <state-file>'); process.exit(2); }
  const last = fs.existsSync(state) ? fs.readFileSync(state, 'utf8').trim() : null;
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    const { today, moved } = await alignToday(c, last);
    if (today === last) return;
    fs.writeFileSync(state, today);
    console.log(moved ? `Demo appointments moved from ${last} to ${today}.` : `Demo waiting room set for ${today}.`);
  } catch (e) {
    console.error(e.message); process.exitCode = 1;
  } finally { await c.end(); }
})();
