#!/usr/bin/env bash
#
# Nightly logical backup of the CronApp database using pg_dump's custom format
# (-Fc), which is compressed and restorable selectively with pg_restore. Old
# dumps are pruned past the retention window. Pair this with WAL archiving (see
# README.md) for point-in-time recovery between nightly dumps.
#
# Usage:
#   DATABASE_URL=postgresql://user:pass@host:5432/db ./pg_backup.sh [BACKUP_DIR]
#
# Env:
#   DATABASE_URL   (required) libpq connection string
#   BACKUP_DIR     target dir (arg 1 overrides; default /var/backups/cronapp)
#   RETENTION_DAYS how many days of dumps to keep (default 14)
#
# Exit codes: 0 ok, 1 bad args/env, 2 dump failed, 3 verify failed.
set -euo pipefail

DATABASE_URL="${DATABASE_URL:-}"
BACKUP_DIR="${1:-${BACKUP_DIR:-/var/backups/cronapp}}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

if [[ -z "$DATABASE_URL" ]]; then
  echo "ERROR: DATABASE_URL is required" >&2
  exit 1
fi

command -v pg_dump >/dev/null || { echo "ERROR: pg_dump not on PATH" >&2; exit 1; }

# Prisma appends "?schema=public" to its URLs; libpq (pg_dump/psql) doesn't know
# that parameter, so strip it and tidy up any dangling separators.
sanitize_url() {
  printf '%s' "$1" | sed -E 's/([?&])schema=[^&]*//; s/[?&]$//; s/\?&/?/'
}
DATABASE_URL="$(sanitize_url "$DATABASE_URL")"

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$BACKUP_DIR/cronapp_${stamp}.dump"

echo "[$(date -u +%FT%TZ)] Dumping to $out"
# The app role (cronapp) is subject to FORCE row-level security and cannot bypass
# RLS, so a plain pg_dump errors on every tenant-scoped table. We dump WITH row
# security enabled and flip the app's own bypass flag (app.bypass_rls=on) so the
# tenant_isolation policy lets every row through — giving a complete snapshot
# without granting the app role BYPASSRLS. (Alternatively, run this as a
# superuser / BYPASSRLS role and the flag is unnecessary.)
# -Fc custom format, --no-owner/--no-acl so a restore doesn't depend on the exact
# role set, -Z6 moderate compression.
export PGOPTIONS="${PGOPTIONS:-} -c app.bypass_rls=on"
if ! pg_dump --dbname="$DATABASE_URL" --format=custom --no-owner --no-acl \
     --enable-row-security -Z6 --file="$out"; then
  echo "ERROR: pg_dump failed" >&2
  rm -f "$out"
  exit 2
fi

# Verify the archive is readable and lists a table of contents.
if ! pg_restore --list "$out" >/dev/null 2>&1; then
  echo "ERROR: dump is not a valid archive" >&2
  exit 3
fi

size="$(du -h "$out" | cut -f1)"
echo "[$(date -u +%FT%TZ)] OK — $out ($size)"

# Prune dumps older than the retention window.
if [[ "$RETENTION_DAYS" -gt 0 ]]; then
  find "$BACKUP_DIR" -name 'cronapp_*.dump' -type f -mtime +"$RETENTION_DAYS" -print -delete
fi

echo "[$(date -u +%FT%TZ)] Done. Kept $(find "$BACKUP_DIR" -name 'cronapp_*.dump' | wc -l) dump(s)."
