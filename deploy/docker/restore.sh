#!/bin/sh
# Restores a backup.sh file into this install with pg_restore. The backup goes into a scratch
# database first, so a bad file never touches the live one. Then the selfhost server and collector
# stop for a moment while the restored database replaces the live one, and start again.
# When the live database already holds events it refuses, unless --force is given.
#
# Usage: ./restore.sh [--force] <file>
set -eu

here=$(cd "$(dirname "$0")" && pwd)
# Run from this folder so .env applies, with the files its COMPOSE_FILE lists (compose.yml alone
# when unset), as for docker compose run by hand here.
compose() { (cd "$here" && docker compose "$@"); }
pg() { compose exec -T postgres sh -c "$1"; }
# Rows in each table, as "table=count" words, for comparing a backup with its restore.
ROWS_SQL="SELECT string_agg(table_name || '=' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', table_name), false, true, '')))[1]::text, ' ' ORDER BY table_name) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"

force=false
if [ "${1:-}" = "--force" ]; then
  force=true
  shift
fi
file=${1:-}
if [ -z "$file" ] || [ ! -f "$file" ]; then
  echo "Usage: $0 [--force] <backup file>" >&2
  exit 2
fi

compose up -d --wait postgres

query='psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc'
existing=0
if [ "$(pg "$query \"SELECT to_regclass('events') IS NOT NULL\"")" = t ]; then
  existing=$(pg "$query \"SELECT count(*) FROM events\"")
fi
if [ "$existing" -gt 0 ] && [ "$force" != true ]; then
  echo "The database already holds $existing events. Rerun with --force to replace them." >&2
  exit 1
fi

pg 'dropdb -U "$POSTGRES_USER" --if-exists "${POSTGRES_DB}_restore" &&
  createdb -U "$POSTGRES_USER" -O "$POSTGRES_USER" "${POSTGRES_DB}_restore"'
if ! pg 'pg_restore -U "$POSTGRES_USER" -d "${POSTGRES_DB}_restore" --no-owner --no-privileges \
  --single-transaction --exit-on-error' <"$file"; then
  pg 'dropdb -U "$POSTGRES_USER" --if-exists "${POSTGRES_DB}_restore"'
  echo "pg_restore failed. The live database was not changed." >&2
  exit 1
fi
rows=$(printf '%s\n' "$ROWS_SQL" | pg 'psql -U "$POSTGRES_USER" -d "${POSTGRES_DB}_restore" -tAq')

compose stop selfhost otel-collector
pg 'dropdb -U "$POSTGRES_USER" --force --if-exists "$POSTGRES_DB" &&
  psql -U "$POSTGRES_USER" -d postgres -qc "ALTER DATABASE \"${POSTGRES_DB}_restore\" RENAME TO \"$POSTGRES_DB\""'
compose up -d
echo "Restored $file"
echo "rows: $rows"
