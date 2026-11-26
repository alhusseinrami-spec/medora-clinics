// Browser and phone smoke test. Signs in as each kind of user through the real login form and opens their main pages
// on a desktop screen, an Android phone and an iPhone-sized screen (Chromium emulation), in English and in Arabic (RTL).
// Each page must load without an error status, without script errors in the console, and without sideways scrolling on phones.
//
// Needs the API and web app running with the synthetic seed (npm run db:seed). Usage:
//   node e2e/smoke.mjs                      (WEB_URL defaults to http://localhost:3000)
//   SCREENSHOTS=1 node e2e/smoke.mjs        (also saves a screenshot per page to e2e/out/)
//   WEB_URL=https://localhost:8443 INSECURE_TLS=1 SKIP_ROLES="platform admin" node e2e/smoke.mjs   (the Docker stack, see deploy/README.md)
import { createRequire } from 'node:module';
// Playwright is not an app dependency; it is loaded from the machine (npm i -g playwright, or a CI image that has it).
const { chromium, devices } = createRequire(import.meta.url)('playwright');
import { mkdirSync } from 'node:fs';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const PW = 'Demo-Medora-2026';
const SHOTS = process.env.SCREENSHOTS === '1';
// INSECURE_TLS=1 accepts a locally issued certificate (testing the Docker stack on localhost). Never for a real address.
const TLS = process.env.INSECURE_TLS === '1' ? { ignoreHTTPSErrors: true } : {};
if (SHOTS) mkdirSync(new URL('./out/', import.meta.url), { recursive: true });

const SCREENS = [
  { name: 'desktop', opts: { viewport: { width: 1366, height: 820 } }, phone: false },
  { name: 'android', opts: { ...devices['Pixel 7'] }, phone: true },
  { name: 'iphone', opts: { ...devices['iPhone 13'], defaultBrowserType: undefined }, phone: true },
];
const LANGS = ['en', 'ar'];

// Pages per account. `w:` paths are inside the user's workspace.
const ACCOUNTS = [
  { email: 'maya@demo.medora', role: 'receptionist', landing: /\/w\/[^/]+\/dashboard/, pages: ['w:dashboard', 'w:patients', 'w:calendar', 'w:waiting-room', 'w:billing'] },
  { email: 'nour@demo.medora', role: 'doctor', landing: /\/w\/[^/]+\/dashboard/, pages: ['w:dashboard', 'w:patients', 'first-patient', 'w:settings/specialty'] },
  { email: 'owner@demo.medora', role: 'center owner', landing: /\/w\/[^/]+\/dashboard/, pages: ['w:finance', 'w:settings/team', 'w:settings/subscription', 'w:support'] },
  { email: 'patient@demo.medora', role: 'patient', landing: /\/portal/, pages: ['/portal', '/portal/appointments', '/portal/prescriptions', '/portal/documents', '/portal/profile'] },
  { email: 'admin@demo.medora', role: 'platform admin', landing: /\/admin/, pages: ['/admin', '/admin/workspaces', '/admin/plans', '/admin/support'] },
];

// SKIP_ROLES="platform admin" leaves out accounts that cannot sign in with a password alone (production requires two-factor sign-in for admins).
const SKIP = (process.env.SKIP_ROLES ?? '').split(',').map((x) => x.trim()).filter(Boolean);
for (const r of SKIP) if (!ACCOUNTS.some((a) => a.role === r)) throw new Error(`SKIP_ROLES: unknown role "${r}"`);

const failures = [];
const sessions = new Map();
let checks = 0;
const fail = (where, msg) => { failures.push(`${where}: ${msg}`); console.log(`  FAIL ${where}: ${msg}`); };

async function checkPage(page, where, lang, phone, errors) {
  checks++;
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(300);
  const info = await page.evaluate(() => ({
    dir: document.documentElement.dir,
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    text: document.body.innerText.trim().length,
    crashed: /Application error|Unhandled Runtime Error|This page could not be found/i.test(document.body.innerText),
  }));
  if (info.crashed) fail(where, 'error page shown');
  if (info.text < 20) fail(where, 'page is empty');
  if (lang === 'ar' && info.dir !== 'rtl') fail(where, `expected right-to-left layout, got dir="${info.dir}"`);
  if (phone && info.overflow > 2) fail(where, `scrolls sideways by ${info.overflow}px`);
  for (const e of errors.splice(0)) fail(where, `console error: ${e.slice(0, 200)}`);
  if (SHOTS) await page.screenshot({ path: new URL(`./out/${where.replace(/[^a-z0-9]+/gi, '_')}.png`, import.meta.url).pathname, fullPage: false });
}

const browser = await chromium.launch();
try {
  // Public pages and the installable app files.
  {
    const ctx = await browser.newContext(TLS); const page = await ctx.newPage();
    for (const p of ['/login', '/register', '/forgot']) {
      const r = await page.goto(WEB + p); checks++;
      if (!r || r.status() >= 400) fail(p, `status ${r?.status()}`);
    }
    const head = await page.request.get(WEB + '/login'); checks++;
    for (const h of ['content-security-policy', 'x-content-type-options', 'referrer-policy']) if (!head.headers()[h]) fail('/login', `missing ${h} header`);
    for (const p of ['/manifest.webmanifest', '/sw.js', '/icon-192.png', '/offline.html']) {
      const r = await page.request.get(WEB + p); checks++;
      if (r.status() !== 200) fail(p, `status ${r.status()}`);
    }
    await ctx.close();
  }

  for (const screen of SCREENS) {
    for (const lang of LANGS) {
      for (const acct of ACCOUNTS.filter((a) => !SKIP.includes(a.role))) {
        const label = `${screen.name}/${lang}/${acct.role}`;
        console.log(label);
        const ctx = await browser.newContext({ ...TLS, ...screen.opts, locale: lang === 'ar' ? 'ar-LB' : 'en-US' });
        await ctx.addInitScript((l) => { try { localStorage.setItem('medora.lang', l); } catch {} }, lang);
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('console', (m) => {
          if (m.type() !== 'error' || /Failed to load resource: the server responded with a status of 40[134]/.test(m.text())) return;
          // A locally issued certificate stops the service worker from installing; that is the test certificate, not the app.
          if (TLS.ignoreHTTPSErrors && /SSL certificate error occurred when fetching the script/.test(m.text())) return;
          errors.push(m.text());
        });

        // Sign in through the form, as a person would: once per account. Later screens reuse that session, which keeps
        // the run under the production sign-in rate limit (20 per 5 minutes per address).
        if (sessions.has(acct.email)) {
          await ctx.addCookies(sessions.get(acct.email));
          await page.goto(`${WEB}/`);
        } else {
          await page.goto(`${WEB}/login`);
          await page.locator('input[type=email]').fill(acct.email);
          await page.locator('input[type=password]').fill(PW);
          await page.locator('form button').last().click();
        }
        try { await page.waitForURL(acct.landing, { timeout: 20000 }); } catch { fail(label, `sign-in did not reach ${acct.landing} (at ${page.url()})`); await ctx.close(); continue; }
        if (!sessions.has(acct.email)) sessions.set(acct.email, await ctx.cookies());
        await checkPage(page, `${label} landing`, lang, screen.phone, errors);
        const ws = page.url().match(/\/w\/([^/]+)/)?.[1];

        for (const p of acct.pages) {
          let url;
          if (p === 'first-patient') {
            await page.goto(`${WEB}/w/${ws}/patients`); await page.waitForLoadState('networkidle').catch(() => {});
            const href = await page.locator('a[href*="/patients/"]').first().getAttribute('href').catch(() => null);
            if (!href) { fail(`${label} patient file`, 'no patient link on the list'); continue; }
            url = WEB + href;
          } else url = p.startsWith('w:') ? `${WEB}/w/${ws}/${p.slice(2)}` : WEB + p;
          const r = await page.goto(url);
          if (!r || r.status() >= 400) { fail(`${label} ${p}`, `status ${r?.status()}`); continue; }
          await checkPage(page, `${label} ${p}`, lang, screen.phone, errors);
        }
        await ctx.close();
      }
    }
  }
} finally { await browser.close(); }

console.log(`\n${checks} checks, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(' - ' + f); process.exit(1); }
console.log('Smoke test passed. Note: iPhone is emulated in Chromium (screen size, touch, user agent); Safari itself was not run.');
