# Nightly encrypted backups (ops/backup.sh) using the same PostgreSQL major version as the database.
FROM postgres:16-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY ops/backup.sh ops/restore.sh ops/restore_test.sh /ops/
COPY deploy/backup-loop.sh /ops/backup-loop.sh
RUN chmod +x /ops/*.sh
CMD ["/ops/backup-loop.sh"]
