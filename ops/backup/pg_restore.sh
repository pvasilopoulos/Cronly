#!/usr/bin/env bash
#
# Restore a CronApp database from a pg_dump custom-format archive produced by
# pg_backup.sh. By default it restores into a NEW database so you can verify a
# dump without touching production; pass --into-existing to overwrite a target.
#
# Usage:
#   DATABASE_URL=postgresql://user:pass@host:5432/postgres \
#     ./pg_restore.sh BACKUP_FILE [TARGET_DB]
#
#   # verify-only restore into a throwaway db (default TARGET_DB = cronapp_verify)
#   ./pg_restore.sh /var/backups/cronapp/cronapp_20260101T000000Z.dump
#
#   # overwrite an existing database (DANGEROUS — drops and recreates it)
#   ./pg_restore.sh backup.dump cronapp --into-existing
#
# DATABASE_URL must point at a maintenance DB (e.g. .../postgres) with rights to
# CREATE/DROP DATABASE. Exit: 0 ok, 1 bad args, 2 restore failed.
set -euo pipefail

DATABASE_URL="${DATABASE_URL:-}"
BACKUP_FILE="${1:-}"
TARGET_DB="${2:-cronapp_verify}"
INTO_EXISTING=false
for arg in "$@"; do [[ "$arg" == "--into-existing" ]] && INTO_EXISTING=true; done

if [[ -z "$DATABASE_URL" || -z "$BACKUP_FILE" ]]; then
  echo "Usage: DATABASE_URL=... ./pg_restore.sh BACKUP_FILE [TARGET_DB] [--into-existing]" >&2
  exit 1
fi
[[ -f "$BACKUP_FILE" ]] || { echo "ERROR: no such file: $BACKUP_FILE" >&2; exit 1; }
command -v pg_restore >/dev/null || { echo "ERROR: pg_restore not on PATH" >&2; exit 1; }
command -v psql >/dev/null || { echo "ERROR: psql not on PATH" >&2; exit 1; }

# Strip Prisma's "?schema=public" param that libpq doesn't understand.
sanitize_url() {
  printf '%s' "$1" | sed -E 's/([?&])schema=[^&]*//; s/[?&]$//; s/\?&/?/'
}
DATABASE_URL="$(sanitize_url "$DATABASE_URL")"

echo "[$(date -u +%FT%TZ)] Restoring $BACKUP_FILE -> database \"$TARGET_DB\""

if $INTO_EXISTING; then
  echo "WARNING: dropping and recreating \"$TARGET_DB\" in 5s (Ctrl-C to abort)…"
  sleep 5
fi

# Recreate the target database from the maintenance connection.
psql --dbname="$DATABASE_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$TARGET_DB\";"
psql --dbname="$DATABASE_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$TARGET_DB\";"

# Restore into it. --no-owner/--no-acl keeps it role-agnostic; the app's RLS and
# the cronapp role are re-applied separately by `npm run db:rls` after restore.
target_url="$(echo "$DATABASE_URL" | sed -E "s#/[^/?]+(\?|$)#/$TARGET_DB\1#")"
if ! pg_restore --dbname="$target_url" --no-owner --no-acl --exit-on-error "$BACKUP_FILE"; then
  echo "ERROR: pg_restore failed" >&2
  exit 2
fi

count="$(psql --dbname="$target_url" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';")"
echo "[$(date -u +%FT%TZ)] OK — restored $count tables into \"$TARGET_DB\"."
echo "Next: run 'npm run db:rls' against \"$TARGET_DB\" to reinstate row-level security."
