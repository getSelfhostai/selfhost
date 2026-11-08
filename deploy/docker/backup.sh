#!/bin/sh
# Backs up the selfhost database with pg_dump (custom format) while the stack keeps running.
# pg_dump reads one consistent snapshot, so events written during the backup are either all in
# it or not at all.
#
# Usage: ./backup.sh [file]
#   file defaults to backups/selfhost-<UTC time>.dump next to this script.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
# Run from this folder so .env applies, with the files its COMPOSE_FILE lists (compose.yml alone
# when unset), as for docker compose run by hand here.
compose() { (cd "$here" && docker compose "$@"); }

file=${1:-"$here/backups/selfhost-$(date -u +%Y%m%dT%H%M%SZ).dump"}
mkdir -p "$(dirname "$file")"

# Written to a temporary name first, so a failed dump never looks like a good backup.
compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
  >"$file.partial"
mv "$file.partial" "$file"

events=$(compose exec -T postgres sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT count(*) FROM events"' || echo "?")
echo "Backed up $events events to $file"
