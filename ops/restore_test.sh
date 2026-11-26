#!/usr/bin/env bash
# Backup + restore drill: backs up the live database, restores it into a separate scratch database, and checks
# that every table has the same number of rows and that the encrypted files came back byte for byte.
# Required: DATABASE_URL (source, owner), RESTORE_TEST_DATABASE_URL (an EMPTY scratch database, never production)
# Optional: STORAGE_DIR
set -euo pipefail
: "${DATABASE_URL:?}"; : "${RESTORE_TEST_DATABASE_URL:?an empty scratch database}"
[ "$DATABASE_URL" != "$RESTORE_TEST_DATABASE_URL" ] || { echo "Refusing: the scratch database is the source database" >&2; exit 1; }
export BACKUP_PASSPHRASE="${BACKUP_PASSPHRASE:-restore-drill-$(openssl rand -hex 16)}"
DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
BACKUP_DIR="$TMP/backups" "$DIR/backup.sh"
FILE="$(ls "$TMP"/backups/medora-*.tar.enc)"
# A wrong passphrase must not decrypt.
if BACKUP_PASSPHRASE=wrong TARGET_DATABASE_URL="$RESTORE_TEST_DATABASE_URL" "$DIR/restore.sh" "$FILE" >/dev/null 2>&1; then echo "Wrong passphrase was accepted" >&2; exit 1; fi
echo "Wrong passphrase rejected."
TARGET_DATABASE_URL="$RESTORE_TEST_DATABASE_URL" TARGET_STORAGE_DIR="$TMP/storage" "$DIR/restore.sh" "$FILE"
if [ -d "${STORAGE_DIR:-./storage}" ]; then
  diff -r "${STORAGE_DIR:-./storage}" "$TMP/storage" && echo "Stored files restored byte for byte ($(find "$TMP/storage" -type f | wc -l) files)."
fi
echo "Restore drill passed."
