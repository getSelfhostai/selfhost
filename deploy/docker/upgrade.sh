#!/bin/sh
# Moves this install to another release, newer or older, and changes nothing when a migration
# fails:
#   1. backup.sh takes a backup.
#   2. Going back to a release that knows fewer migrations than the database has, the running
#      release rolls them back with their down migrations, which only it has.
#   3. The target release applies its pending migrations in a one-off container while the running
#      release keeps serving. They run in one transaction: if one fails, the database stays at the
#      version it had, .env keeps naming the running release, and the script stops.
#   4. .env names the target release, and its server replaces the running one.
#
# Usage: ./upgrade.sh <version>     the SELFHOST_VERSION to run, like 0.2.0
set -eu

here=$(cd "$(dirname "$0")" && pwd)
# Run from this folder so .env applies, with the files its COMPOSE_FILE lists (compose.yml alone
# when unset), as for docker compose run by hand here.
compose() { (cd "$here" && docker compose "$@"); }
say() { echo "selfhost: $*"; }
die() {
  echo "selfhost: $*" >&2
  exit 1
}
value() { sed -n "s/^$1=//p" "$here/.env" | tail -n 1; }

target=${1:-}
case "$target" in
  '' | -*)
    echo "Usage: $0 <version>" >&2
    exit 2
    ;;
esac
[ -f "$here/.env" ] || die "no .env in $here"
current=$(value SELFHOST_VERSION)

# The server image's migrate entry, of the running release or of the target, in a one-off
# container against the live database. It publishes no port and starts no other service.
running() { compose run --rm --no-deps -T selfhost node dist/migrate.js "$@"; }
next() { SELFHOST_VERSION=$target compose run --rm --no-deps -T selfhost node dist/migrate.js "$@"; }

image="$(value SELFHOST_IMAGE)"
image="${image:-ghcr.io/getselfhostai/selfhost}:$target"
if ! docker image inspect "$image" >/dev/null 2>&1; then
  say "pulling $image"
  docker pull -q "$image" || die "could not pull $image"
fi

"$here/backup.sh"

status=$(next --status) || die "could not read the database schema with $target; nothing changed"
latest=$(echo "$status" | sed -n 's/.*"latest":"\([^"]*\)".*/\1/p')
case "$status" in
  *'"unknown":[]'*) ;;
  *)
    say "rolling the database back to $latest, the newest migration $target knows, with $current"
    running --to "$latest" || die "the rollback failed and changed nothing; $current keeps running"
    ;;
esac
say "applying the migrations of $target while $current keeps running"
next || die "a migration of $target failed and was rolled back: the database is as it was, and $current keeps running"

umask 077
grep -v '^SELFHOST_VERSION=' "$here/.env" >"$here/.env.tmp" || true
printf 'SELFHOST_VERSION=%s\n' "$target" >>"$here/.env.tmp"
mv "$here/.env.tmp" "$here/.env"

say "starting $target"
compose up -d
tries=0
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q selfhost)" 2>/dev/null)" = healthy ]; do
  tries=$((tries + 1))
  if [ "$tries" -gt 90 ]; then
    compose logs --no-color --tail 40 selfhost
    die "the $target server did not become healthy within 3 minutes. Go back with: $0 $current"
  fi
  sleep 2
done
say "now on $target (was $current), database schema at $latest"
