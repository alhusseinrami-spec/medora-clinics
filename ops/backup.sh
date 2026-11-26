#!/usr/bin/env bash
# Encrypted MEDORA backup: database (pg_dump custom format) + encrypted file storage + a manifest of row counts.
# The archive is encrypted with AES-256 (openssl, PBKDF2) using BACKUP_PASSPHRASE. Keep the passphrase somewhere other than the backups.
#
# Required: DATABASE_URL (owner connection), BACKUP_PASSPHRASE
# Optional: STORAGE_DIR (default ./storage), BACKUP_DIR (default ./backups), BACKUP_KEEP_DAYS (default 30)
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required (owner connection)}"
: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE is required}"
STORAGE_DIR="${STORAGE_DIR:-./storage}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP="${BACKUP_KEEP_DAYS:-30}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$BACKUP_DIR"

# Row counts first, so the restore check compares against the same moment as the dump (inside one snapshot).
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "
  SELECT string_agg(format('%s %s', t.relname, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', t.relname), false, true, '')))[1]::text), E'\n' ORDER BY t.relname)
  FROM pg_class t JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND t.relkind = 'r' AND t.relpersistence = 'p'" > "$WORK/rowcounts.txt"

pg_dump "$DATABASE_URL" --format=custom --compress=6 --no-owner --file="$WORK/db.dump"
if [ -d "$STORAGE_DIR" ]; then tar -C "$STORAGE_DIR" -cf "$WORK/storage.tar" .; else tar -cf "$WORK/storage.tar" -T /dev/null; fi
{ echo "created_utc=$STAMP"; echo "pg_dump=$(pg_dump --version)"; echo "db_sha256=$(sha256sum "$WORK/db.dump" | cut -d' ' -f1)"; echo "storage_sha256=$(sha256sum "$WORK/storage.tar" | cut -d' ' -f1)"; } > "$WORK/manifest.txt"

OUT="$BACKUP_DIR/medora-$STAMP.tar.enc"
tar -C "$WORK" -cf - manifest.txt rowcounts.txt db.dump storage.tar \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE -out "$OUT.part"
mv "$OUT.part" "$OUT"
chmod 600 "$OUT"
echo "Backup written: $OUT ($(du -h "$OUT" | cut -f1))"

# Retention: delete encrypted backups older than KEEP days.
find "$BACKUP_DIR" -maxdepth 1 -name 'medora-*.tar.enc' -mtime "+$KEEP" -print -delete | sed 's/^/Removed old backup: /'
