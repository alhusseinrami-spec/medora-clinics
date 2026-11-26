# Running MEDORA on a server

One Linux server with Docker runs the whole platform: PostgreSQL, the API, the web app, Caddy (automatic HTTPS) and nightly encrypted backups. Nothing here has been deployed yet. The stack was built and tested end to end in a development container (see "What was tested").

## What you need

- A Linux server with Docker Engine and the Compose plugin. 2 vCPU and 4 GB RAM is enough to start; 40 GB disk.
- A domain name (for example `app.medora.clinic`) with an A record pointing at the server.
- Ports 80 and 443 open to the internet. Nothing else needs to be open (SSH aside).
- A second place for backup copies (another server, object storage, or an external disk). Backups that only live on the same server do not survive losing that server.

## First start

```bash
git clone https://github.com/alhusseinrami-spec/medora-clinics.git && cd medora-clinics
cp deploy/.env.example deploy/.env
# Fill in deploy/.env. Generate keys with: openssl rand -hex 32   and passwords with: openssl rand -base64 24
chmod 600 deploy/.env
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
docker compose -f deploy/docker-compose.yml --env-file deploy/.env ps     # every service "healthy" or "Up"; migrate "Exited (0)"
```

On the first start the `migrate` service creates the database schema and the specialty presets, then exits. It runs again on every start and only applies new migrations.

Create the MEDORA platform administrator (no public sign-up exists for this role):

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env run --rm -e ADMIN_PASSWORD='a long password' migrate \
  node db/platform_admin.js create you@yourdomain.com "Your Name"
```

Then sign in at `https://DOMAIN/login`, open Profile and turn on two-factor sign-in. Production requires it before the admin console opens.

## Keys and secrets

| Value | What it protects | If lost |
|---|---|---|
| `DB_OWNER_PASSWORD`, `DB_APP_PASSWORD` | Database access | Can be reset from the server |
| `MFA_ENC_KEY` | Two-factor secrets | Everyone must set up two-factor sign-in again |
| `FILE_ENC_KEY` | Every uploaded medical document | **Documents cannot be read again.** Keep an offline copy |
| `BACKUP_PASSPHRASE` | The backup archives | **Backups cannot be restored.** Keep it apart from the backups |

Store all of them in a password manager. `deploy/.env` is ignored by git; never commit it.

## Backups

- The `backup` service writes `medora-<time>.tar.enc` to `BACKUP_HOST_DIR` every day at `BACKUP_HOUR` (UTC) and deletes archives older than `BACKUP_KEEP_DAYS`.
- Each archive holds the database dump, the (already encrypted) document files, checksums and a row count for every table. It is encrypted with AES-256 using `BACKUP_PASSPHRASE`.
- Copy `BACKUP_HOST_DIR` off the server every day (for example `rclone` or `rsync` from cron).
- Run a backup now: `docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec backup /ops/backup.sh`

**Restore drill** (do this monthly; it never touches the live database):

```bash
set -a; . deploy/.env; set +a        # loads DB_OWNER_PASSWORD into this shell
docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec db createdb -U medora medora_restore_test
docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec \
  -e RESTORE_TEST_DATABASE_URL=postgres://medora:$DB_OWNER_PASSWORD@db:5432/medora_restore_test backup /ops/restore_test.sh
docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec db dropdb -U medora medora_restore_test
```

It backs up, checks that a wrong passphrase is refused, restores into the scratch database, and compares every table's row count and every stored file.

**Real restore** (after losing the server): set up a new server as in "First start" with the same `deploy/.env`, copy the archive to `/srv/restore/`, then:

```bash
set -a; . deploy/.env; set +a
C="docker compose -f deploy/docker-compose.yml --env-file deploy/.env"
$C stop api web
$C run --rm -v medora_files:/restore-files -v /srv/restore:/restore:ro \
  -e TARGET_DATABASE_URL=postgres://medora:$DB_OWNER_PASSWORD@db:5432/medora -e TARGET_STORAGE_DIR=/restore-files \
  backup /ops/restore.sh /restore/medora-<time>.tar.enc
$C start api web
```

The restore replaces the database contents, puts the document files back, and stops with an error if any table's row count differs from the backup.

## Updating

```bash
git pull
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

Take a backup first. New migrations apply automatically before the API starts; if one fails, the API does not start and the previous data is unchanged (each migration runs in a transaction).

## Public demo server

To show MEDORA to clinics, run a **separate** server with `DEMO_MODE=true` on the API, and give the API the owner connection `DATABASE_URL` as well. Visitors then see a "Demo clinic" box on the sign-in page. They can open the synthetic clinic as the owner, a doctor, the front desk, the assistant, the insurance desk or the patient app, with no password. Inside the app, a strip lets them switch roles or reset the demo.

- **Reset demo** wipes the database and loads the synthetic clinic again (`db/seed_synthetic.mjs`, without the platform administrator). It takes a few seconds and signs everyone out. It refuses to run if any account outside `@demo.medora` exists, so it cannot wipe a real clinic's data. It also refuses if the demo was reset less than 2 minutes ago.
- On a new demo server, press "Reset demo" on the sign-in page once to load the data.
- Never set `DEMO_MODE` on the production server.

## Security notes

- Only Caddy publishes ports. The database, API and web app are reachable only inside the Docker network.
- Caddy replaces any `X-Forwarded-For` header from the internet, so the per-address sign-in limits cannot be dodged by faking it.
- The API answers with strict security headers and HSTS; the web app sends a Content Security Policy.
- Containers run as the unprivileged `node` user (API, web).
- Turn on the server's firewall (`ufw allow 22,80,443/tcp`) and automatic security updates.

## Networks that inspect HTTPS

If the server sits behind a proxy that re-signs HTTPS, the image builds need its CA certificate:
`docker build --secret id=ca,src=/path/to/ca.crt -f deploy/api.Dockerfile -t medora-api .` (and the same for `web.Dockerfile`), then `up -d` without `--build`. Normal servers do not need this.

## What was tested

In a development container (not a real server): all three images built; the stack started with a locally issued HTTPS certificate on ports 8080/8443; migrations and presets applied; the synthetic demo data was created through the containerised API; the browser smoke test passed 140 checks over desktop, Android and iPhone sizes in English and Arabic; a document upload was stored encrypted and downloaded byte for byte; the restore drill passed inside the backup container; production refused the admin console until two-factor sign-in was on.

Not tested: a real domain and Let's Encrypt certificate, a real server's performance, off-server backup copies, email (provider not connected).
