#!/usr/bin/env bash
# Restore an encrypted MEDORA backup made by backup.sh.
#   ops/restore.sh <backup file>
# Required: TARGET_DATABASE_URL (an owner connection to the database to restore INTO; its current contents are replaced),
#           BACKUP_PASSPHRASE
# Optional: TARGET_STORAGE_DIR (where to put the encrypted files; skipped when unset)
# The database roles (medora, medora_app) must already exist on the target server. db/migrate.js creates them.
set -euo pipefail
FILE="${1:?usage: restore.sh <backup file>}"
: "${TARGET_DATABASE_URL:?TARGET_DATABASE_URL is required}"
: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE is required}"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$FILE" | tar -C "$WORK" -xf -
# Integrity: the checksums in the manifest must match.
grep -q "db_sha256=$(sha256sum "$WORK/db.dump" | cut -d' ' -f1)" "$WORK/manifest.txt" || { echo "Database dump checksum mismatch" >&2; exit 1; }
grep -q "storage_sha256=$(sha256sum "$WORK/storage.tar" | cut -d' ' -f1)" "$WORK/manifest.txt" || { echo "Storage checksum mismatch" >&2; exit 1; }
cat "$WORK/manifest.txt"

pg_restore --dbname="$TARGET_DATABASE_URL" --clean --if-exists --no-owner --exit-on-error --single-transaction "$WORK/db.dump"
if [ -n "${TARGET_STORAGE_DIR:-}" ]; then mkdir -p "$TARGET_STORAGE_DIR"; tar -C "$TARGET_STORAGE_DIR" -xf "$WORK/storage.tar"; fi

# Verify: every table's row count must equal the count recorded at backup time.
psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "
  SELECT string_agg(format('%s %s', t.relname, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', t.relname), false, true, '')))[1]::text), E'\n' ORDER BY t.relname)
  FROM pg_class t JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND t.relkind = 'r' AND t.relpersistence = 'p'" > "$WORK/restored.txt"
if diff -u "$WORK/rowcounts.txt" "$WORK/restored.txt"; then
  echo "Restore verified: $(wc -l < "$WORK/rowcounts.txt") tables, $(awk '{s+=$2} END {print s}' "$WORK/rowcounts.txt") rows match the backup."
else
  echo "Row counts differ from the backup (see above)" >&2; exit 1
fi
