#!/bin/sh
# Backs up the selfhost database with pg_dump (custom format) while the stack keeps running.
# pg_dump reads one consistent snapshot, so events written during the backup are either all in
# it or not at all. It prints the rows of each table, which restore.sh prints again.
#
# Usage: ./backup.sh [file]
#   file defaults to backups/selfhost-<UTC time>.dump next to this script.
set -eu
# A dump holds every event, notification target and policy: readable by its owner only.
umask 077

here=$(cd "$(dirname "$0")" && pwd)
# Run from this folder so .env applies, with the files its COMPOSE_FILE lists (compose.yml alone
# when unset), as for docker compose run by hand here.
compose() { (cd "$here" && docker compose "$@"); }
# Rows in each table, as "table=count" words, for comparing a backup with its restore.
ROWS_SQL="SELECT string_agg(table_name || '=' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', table_name), false, true, '')))[1]::text, ' ' ORDER BY table_name) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"

file=${1:-"$here/backups/selfhost-$(date -u +%Y%m%dT%H%M%SZ).dump"}
mkdir -p "$(dirname "$file")"

# Written to a temporary name first, so a failed dump never looks like a good backup.
compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
  >"$file.partial"
chmod 600 "$file.partial"
mv "$file.partial" "$file"

rows=$(printf '%s\n' "$ROWS_SQL" |
  compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAq' || echo "?")
echo "Backed up to $file"
echo "rows: $rows"
