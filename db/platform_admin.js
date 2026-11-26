// Grants or removes MEDORA platform administrator rights. There is no sign-up for this role on purpose:
// it is given from the server with the owner database connection.
//   node db/platform_admin.js grant  someone@example.com
//   node db/platform_admin.js revoke someone@example.com
//   ADMIN_PASSWORD=... node db/platform_admin.js create someone@example.com "Full Name"   (new account, admin only)
const { Client } = require('pg');
const { randomBytes, scrypt } = require('crypto');
const url = process.env.DATABASE_URL || 'postgres://medora:medora_dev@localhost:5432/medora';
const N = 16384, R = 8, P = 1, LEN = 64;

function hash(pw) {
  return new Promise((resolve, reject) => {
    const salt = randomBytes(16);
    scrypt(pw, salt, LEN, { N, r: R, p: P }, (e, h) => (e ? reject(e) : resolve(['scrypt', N, R, P, salt.toString('base64'), h.toString('base64')].join('$'))));
  });
}

(async () => {
  const [cmd, email, name] = process.argv.slice(2);
  if (!['grant', 'revoke', 'create'].includes(cmd) || !email) { console.error('usage: node db/platform_admin.js grant|revoke|create <email> [full name]'); process.exit(2); }
  const c = new Client(url); await c.connect();
  try {
    if (cmd === 'create') {
      const pw = process.env.ADMIN_PASSWORD;
      if (!pw || pw.length < 10) throw new Error('Set ADMIN_PASSWORD (10+ characters)');
      await c.query('INSERT INTO users (email, password_hash, full_name, is_platform_admin) VALUES (lower($1), $2, $3, true)', [email, await hash(pw), name || 'MEDORA administrator']);
    } else {
      const r = await c.query('UPDATE users SET is_platform_admin = $2 WHERE lower(email) = lower($1) RETURNING id', [email, cmd === 'grant']);
      if (!r.rowCount) throw new Error('No account with that email');
    }
    await c.query("INSERT INTO audit_log (action, entity_type, details) VALUES ($1, 'user', $2)", ['platform_admin.' + cmd, JSON.stringify({ email })]);
    console.log(cmd + ': ' + email);
  } finally { await c.end(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
