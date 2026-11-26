# MEDORA CLINICS

Multi-tenant healthcare practice platform. Architecture: [`docs/architecture/MEDORA-architecture.md`](docs/architecture/MEDORA-architecture.md). Progress: [`DEVLOG.md`](DEVLOG.md). Screenshots: [`docs/screenshots/`](docs/screenshots/).

![CI](https://github.com/alhusseinrami-spec/medora-clinics/actions/workflows/ci.yml/badge.svg)

All data in this repository is synthetic. Passwords in this README and in the code are local development defaults only.

## Layout
```
db/                 migrations (001-013), migrate.js, sync_presets.js, smoke_test.js, rls_test.js, seed_synthetic.mjs
packages/shared/    permissions, role defaults, appointment status machine, specialty template engine + presets
apps/api/           NestJS API (port 4000, prefix /api, WebSocket /ws) + end-to-end tests
apps/web/           Next.js + Tailwind web app / PWA (port 3000, proxies /api to the API)
deploy/             Docker images, Compose stack (PostgreSQL, Caddy HTTPS, backups) and the server guide
ops/                encrypted backup, restore and restore drill scripts
e2e/                browser and phone smoke test (Playwright)
perf/               large synthetic data set and latency benchmark
docs/launch/        performance results and the user acceptance checklist
```

## Run locally (Node 22, PostgreSQL 16)
```bash
pg_ctlcluster 16 main start
su postgres -c "psql -c \"CREATE ROLE medora LOGIN PASSWORD 'medora_dev' CREATEROLE;\" -c \"CREATE DATABASE medora OWNER medora;\""
npm ci
npm run build -w @medora/shared
npm run db:reset && npm run db:presets      # dev only: drops and recreates the schema
npm run build -w @medora/api && npm start -w @medora/api &
npm run db:seed                              # synthetic demo accounts, password Demo-Medora-2026
npm run build -w @medora/web && npm start -w @medora/web
```
Open http://localhost:3000 and sign in as owner@, nour@, karim@, lina@, maya@, sami@demo.medora, patient@demo.medora for the patient app (`/portal`, try it on a phone-sized window), or admin@demo.medora for the MEDORA admin console (`/admin`). Platform admins are made from the server: `node db/platform_admin.js grant <email>`.

`npm test` runs every suite. It resets the dev database, so stop the API first and re-seed afterwards.

Launch checks (with the API and web app running and seeded): `node e2e/smoke.mjs` (browser and phone smoke test), `node perf/load_data.js && node perf/run.mjs` (20,000 synthetic patients and a latency benchmark; dev only), and the backup drill `DATABASE_URL=... RESTORE_TEST_DATABASE_URL=<empty scratch db> STORAGE_DIR=apps/api/storage ops/restore_test.sh`. Server setup: [`deploy/README.md`](deploy/README.md).

## Configuration (environment)
| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Owner connection, migrations only |
| `APP_DATABASE_URL` | API connection as `medora_app` (row-level security applies) |
| `APP_DB_PASSWORD` | Password set for `medora_app` by migrate.js (required in production) |
| `MFA_ENC_KEY` | 64 hex chars, encrypts TOTP secrets (required in production) |
| `WEB_ORIGIN`, `WEB_BASE_URL` | CORS origin and links in invitations |
| `EMAIL_PROVIDER_API_KEY` | Not wired yet: email stays "awaiting credentials" |
| `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` | Meta app secret (webhook signatures) and the webhook verify token. Without them the webhook answers 503 |
| `WHATSAPP_GRAPH_URL` | Defaults to `https://graph.facebook.com/v21.0` (tests point it at a local stand-in) |
| `WHATSAPP_DEFAULT_COUNTRY_CODE` | For local phone numbers, default `961` |
| `COMM_WORKER`, `COMM_WORKER_INTERVAL_MS` | Background message sender: `off` to disable; interval, default 30000 |
| `WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY`, `WEB_PUSH_SUBJECT` | VAPID keys and contact (`mailto:`) for push notifications. Required in production; development uses fixed derived keys |
| `ADMIN_REQUIRE_MFA` | `true` requires two-factor sign-in for MEDORA platform admins in development (always required in production) |
| `RATE_LIMIT` | `off` switches the per-address sign-in and registration limits off in development (ignored in production) |
| `BACKUP_PASSPHRASE`, `BACKUP_DIR`, `BACKUP_KEEP_DAYS` | Backup scripts in `ops/` (see `deploy/README.md`) |
| `API_URL` (web) / `NEXT_PUBLIC_WS_URL` | Where the web app reaches the API / WebSocket |
