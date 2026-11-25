// Measures API latency against the large synthetic data set (perf/load_data.js). Prints p50 / p95 / max per endpoint.
// Usage: node perf/run.mjs [requests per endpoint, default 200] [concurrency, default 10]
const API = process.env.API_URL ?? 'http://localhost:4000/api';
const N = Number(process.argv[2] ?? 200), C = Number(process.argv[3] ?? 10);
const PW = 'Demo-Medora-2026';
async function login(email) {
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  if (!r.ok) throw new Error(`login ${email}: ${r.status}`);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const me = await (await fetch(`${API}/auth/me`, { headers: { cookie } })).json();
  return { cookie, org: me.workspaces.find((w) => w.kind === 'medical_center')?.organization_id };
}
async function bench(name, who, path) {
  const times = []; let errors = 0; let i = 0;
  const worker = async () => {
    while (i < N) {
      const k = i++; const p = typeof path === 'function' ? path(k) : path; const t = performance.now();
      const r = await fetch(`${API}${p}`, { headers: { cookie: who.cookie, ...(who.org ? { 'x-org-id': who.org } : {}) } });
      await r.arrayBuffer(); times.push(performance.now() - t); if (!r.ok) errors++;
    }
  };
  await Promise.all(Array.from({ length: C }, worker));
  times.sort((a, b) => a - b);
  const q = (x) => times[Math.min(times.length - 1, Math.floor(x * times.length))].toFixed(0);
  return { name, p50: q(0.5), p95: q(0.95), max: times.at(-1).toFixed(0), errors };
}
const maya = await login('maya@demo.medora'); const nour = await login('nour@demo.medora'); const owner = await login('owner@demo.medora'); const admin = await login('admin@demo.medora');
const week = () => { const s = new Date(); s.setHours(0, 0, 0, 0); const e = new Date(s.getTime() + 7 * 86400e3); return `from=${s.toISOString()}&to=${e.toISOString()}`; };
// Use patients the doctor can see (the list is scoped to their own patients).
const patients = await (await fetch(`${API}/patients`, { headers: { cookie: nour.cookie, "x-org-id": nour.org } })).json();
const ids = patients.map((p) => p.id);
const names = ['Lea', 'Omar Saad', 'Khoury 12', 'Nadine', '+961 70 0012', 'P-0001'];
const year = new Date().getFullYear();
const results = [
  await bench('Patient search (receptionist)', maya, (k) => `/patients?q=${encodeURIComponent(names[k % names.length])}`),
  await bench('Patient list (doctor)', nour, '/patients'),
  await bench('Patient file', nour, (k) => `/patients/${ids[k % ids.length]}`),
  await bench('Calendar week, all doctors', maya, `/appointments?${week()}`),
  await bench('Waiting room', maya, '/waiting-room'),
  await bench('Dashboard summary (doctor)', nour, '/dashboard/summary'),
  await bench('Patient timeline', nour, (k) => `/patients/${ids[k % ids.length]}/timeline`),
  await bench('Financial overview, year', owner, `/finance/summary?from=${year}-01-01&to=${year}-12-31`),
  await bench('Admin workspaces list', admin, '/admin/workspaces'),
  await bench('Admin overview', admin, '/admin/overview'),
];
console.log(`\n${N} requests per endpoint, ${C} at a time (milliseconds)\n`);
console.log('Endpoint'.padEnd(36) + 'p50'.padStart(6) + 'p95'.padStart(6) + 'max'.padStart(6) + '  errors');
for (const r of results) console.log(r.name.padEnd(36) + r.p50.padStart(6) + r.p95.padStart(6) + r.max.padStart(6) + `  ${r.errors}`);
