# Database backup & recovery

Two layers protect the CronApp database:

1. **Nightly logical dumps** (`pg_backup.sh`) — a compressed, self-contained
   snapshot. Fast to take, easy to move off-box, restorable selectively.
2. **WAL archiving + PITR** — continuous write-ahead-log archiving so you can
   recover to *any* point in time between dumps (e.g. just before a bad deploy).

Logical dumps alone give you nightly granularity; add WAL archiving for
point-in-time recovery. Run both in production.

## Nightly dumps

```bash
DATABASE_URL=postgresql://cronapp:***@127.0.0.1:5432/cronapp \
BACKUP_DIR=/var/backups/cronapp \
RETENTION_DAYS=14 \
  ops/backup/pg_backup.sh
```

Schedule it from cron (02:30 daily), keeping the output in a log:

```cron
30 2 * * *  DATABASE_URL=postgresql://cronapp:***@127.0.0.1:5432/cronapp /opt/cronapp/ops/backup/pg_backup.sh >> /var/log/cronapp-backup.log 2>&1
```

Copy dumps off the host (S3, Backblaze, another box) — a backup on the same
disk as the database is not a backup.

## Verifying a dump (do this regularly)

A backup you have never restored is a hope, not a backup. Restore the latest
dump into a throwaway database and check it:

```bash
DATABASE_URL=postgresql://cronapp:***@127.0.0.1:5432/postgres \
  ops/backup/pg_restore.sh /var/backups/cronapp/cronapp_LATEST.dump
# -> restores into database "cronapp_verify", prints the table count
```

Then reinstate row-level security on the restored copy:

```bash
DATABASE_URL=postgresql://cronapp:***@127.0.0.1:5432/cronapp_verify npm run db:rls
```

## Restoring to production

```bash
# Stop the API, worker and scheduler first.
DATABASE_URL=postgresql://cronapp:***@127.0.0.1:5432/postgres \
  ops/backup/pg_restore.sh backup.dump cronapp --into-existing
DATABASE_URL=postgresql://cronapp:***@127.0.0.1:5432/cronapp npm run db:rls
# Restart the services.
```

## Point-in-time recovery (PITR)

Logical dumps restore to the moment the dump was taken. For finer recovery,
enable WAL archiving in `postgresql.conf`:

```conf
wal_level = replica
archive_mode = on
archive_command = 'test ! -f /var/backups/wal/%f && cp %p /var/backups/wal/%f'
```

Take a periodic base backup with `pg_basebackup`:

```bash
pg_basebackup -D /var/backups/base/$(date -u +%Y%m%d) -Ft -z -X stream \
  -d 'postgresql://cronapp:***@127.0.0.1:5432/cronapp'
```

To recover to a specific time, restore the newest base backup, drop the archived
WAL into `pg_wal/`, and set a recovery target in `postgresql.auto.conf`:

```conf
restore_command = 'cp /var/backups/wal/%f %p'
recovery_target_time = '2026-01-01 03:14:00+00'
```

then create `recovery.signal` and start Postgres; it replays WAL up to the
target and stops. Prune WAL and base backups on the same retention window as the
dumps.

## Windows note

The scripts are POSIX shell for the production Linux VPS (Plan A). On the Windows
dev box run them under Git Bash with the bundled client tools on `PATH`
(`export PATH="/c/pg/pgsql/bin:$PATH"`).
