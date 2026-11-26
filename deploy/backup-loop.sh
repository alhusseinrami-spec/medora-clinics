#!/usr/bin/env bash
# Runs ops/backup.sh once a day at BACKUP_HOUR (UTC, default 02). A failed backup is logged and retried the next hour.
set -uo pipefail
HOUR="${BACKUP_HOUR:-02}"
echo "Backups run daily at ${HOUR}:00 UTC into ${BACKUP_DIR:-/backups}, kept ${BACKUP_KEEP_DAYS:-30} days."
while true; do
  if [ "$(date -u +%H)" = "$HOUR" ] && [ ! -f "/tmp/done-$(date -u +%F)" ]; then
    if /ops/backup.sh; then touch "/tmp/done-$(date -u +%F)"; else echo "Backup FAILED at $(date -u)"; fi
  fi
  sleep 300
done
