#!/bin/sh
# Installs or updates selfhost on this Linux server, as root: Docker when it is missing (from
# Docker's apt repository on Debian and Ubuntu, with get.docker.com elsewhere), the containers of
# compose.yml plus the files COMPOSE_FILE in .env adds, and a daily backup with backup.sh.
# `selfhost up` runs it on each server it sets up; by hand, fill in .env first.
#
# Usage: sudo ./install.sh
#
# Secrets left empty in .env (database password, API and agent tokens, sign-in secrets)
# are generated here: selfhost up never sends one in user-data. When .env.next is present
# (selfhost up writes it), it replaces .env, keeping the secrets .env already holds (a database
# volume keeps the password it was created with) and any setting .env.next leaves out.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
cd "$here"

say() { echo "selfhost: $*"; }
die() {
  echo "selfhost: $*" >&2
  exit 1
}

[ "$(id -u)" = 0 ] || die "run this as root: sudo $0"

SECRETS="POSTGRES_PASSWORD SELFHOST_TOKEN SELFHOST_OTLP_TOKEN SELFHOST_SIGNIN_COOKIE_SECRET SELFHOST_SIGNIN_PROXY_SECRET"

# value KEY FILE: the last KEY=value line of FILE, empty when there is none.
value() { sed -n "s/^$1=//p" "$2" | tail -n 1; }
# put KEY VALUE FILE: sets KEY in FILE, whatever characters VALUE holds.
put() {
  grep -v "^$1=" "$3" >"$3.tmp" || true
  printf '%s=%s\n' "$1" "$2" >>"$3.tmp"
  mv "$3.tmp" "$3"
}
random_hex() { od -An -N "$1" -tx1 /dev/urandom | tr -d ' \n'; }

umask 077
if [ -f .env.next ]; then
  if [ -f .env ]; then
    # Settings added to .env by hand that .env.next does not set, like the GitHub App, stay.
    grep -E '^[A-Za-z_][A-Za-z0-9_]*=' .env | while IFS= read -r line; do
      grep -q "^${line%%=*}=" .env.next || printf '%s\n' "$line" >>.env.next
    done
    kept=""
    for key in $SECRETS; do
      old=$(value "$key" .env)
      if [ -n "$old" ] && [ "$old" != "$(value "$key" .env.next)" ]; then
        put "$key" "$old" .env.next
        kept=yes
      fi
    done
    # selfhost up reads this line to know the server ran selfhost before.
    if [ -n "$kept" ]; then say "kept the secrets already in .env"; fi
  fi
  mv .env.next .env
fi
[ -f .env ] || die "no .env in $here: copy .env.example to .env and fill it in"
for key in $SECRETS; do
  if [ -z "$(value "$key" .env)" ]; then
    # oauth2-proxy takes a 32 character cookie secret; the rest get 32 random bytes.
    if [ "$key" = SELFHOST_SIGNIN_COOKIE_SECRET ]; then bytes=16; else bytes=32; fi
    put "$key" "$(random_hex "$bytes")" .env
  fi
done
chmod 600 .env
umask 022
mkdir -p backups
# compose.signin.yml mounts this file; an empty one lets nobody in by email.
[ -f signin-emails.txt ] || : >signin-emails.txt

# Docker Engine and the Compose plugin: from Docker's apt repository on Debian and Ubuntu, as
# docs.docker.com/engine/install describes, else with the script from get.docker.com.
install_docker() {
  os=$( (. /etc/os-release && echo "${ID:-}") 2>/dev/null || true)
  case "$os" in
    debian | ubuntu)
      codename=$(. /etc/os-release && echo "${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}")
      [ -n "$codename" ] || die "/etc/os-release names no release codename"
      say "installing Docker from Docker's apt repository for $os $codename"
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -q
      apt-get install -yq ca-certificates curl
      install -m 0755 -d /etc/apt/keyrings
      curl -fsSL "https://download.docker.com/linux/$os/gpg" -o /etc/apt/keyrings/docker.asc
      chmod a+r /etc/apt/keyrings/docker.asc
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$os $codename stable" \
        >/etc/apt/sources.list.d/docker.list
      apt-get update -q
      apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      ;;
    *)
      say "installing Docker with the script from get.docker.com (${os:-this system} is not Debian or Ubuntu)"
      command -v curl >/dev/null 2>&1 || die "curl is needed to install Docker"
      curl -fsSL https://get.docker.com | sh
      ;;
  esac
}
if ! docker compose version >/dev/null 2>&1; then install_docker; fi
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  systemctl enable --now docker >/dev/null 2>&1 || true
fi

image="$(value SELFHOST_IMAGE .env)"
image="${image:-ghcr.io/getselfhostai/selfhost}:$(value SELFHOST_VERSION .env)"
if ! docker image inspect "$image" >/dev/null 2>&1; then
  say "pulling $image"
  docker pull -q "$image" || die "could not pull $image. Set SELFHOST_IMAGE and SELFHOST_VERSION in .env to an image this server can pull (selfhost up --image)."
fi
say "starting the containers"
docker compose pull -q --ignore-buildable
docker compose up -d --remove-orphans

say "waiting for the server's health check"
tries=0
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q selfhost)" 2>/dev/null)" = healthy ]; do
  tries=$((tries + 1))
  if [ "$tries" -gt 90 ]; then
    docker compose ps -a
    docker compose logs --no-color --tail 40
    die "the selfhost server did not become healthy within 3 minutes"
  fi
  sleep 2
done

at=$(value SELFHOST_BACKUP_TIME .env)
at=${at:-03:00}
keep=$(value SELFHOST_BACKUP_KEEP_DAYS .env)
keep=${keep:-14}
case "$at" in [0-2][0-9]:[0-5][0-9]) ;; *) die "SELFHOST_BACKUP_TIME must look like 03:00, got $at" ;; esac
case "$keep" in '' | *[!0-9]* | 0) die "SELFHOST_BACKUP_KEEP_DAYS must be a whole number of days, got $keep" ;; esac
prune="find $here/backups -name 'selfhost-*.dump' -mtime +$((keep - 1)) -delete"
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  cat >/etc/systemd/system/selfhost-backup.service <<EOF
[Unit]
Description=Back up the selfhost database
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
ExecStart=$here/backup.sh
ExecStartPost=/bin/sh -c "$prune"
EOF
  cat >/etc/systemd/system/selfhost-backup.timer <<EOF
[Unit]
Description=Daily selfhost database backup

[Timer]
OnCalendar=*-*-* $at:00 UTC
RandomizedDelaySec=10m
Persistent=true

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now selfhost-backup.timer >/dev/null 2>&1
  when="$at UTC, systemd timer selfhost-backup.timer"
else
  echo "${at#*:} ${at%%:*} * * * root $here/backup.sh && $prune" >/etc/cron.d/selfhost-backup
  when="$at server time, /etc/cron.d/selfhost-backup"
fi
say "daily backup at $when, into $here/backups, kept $keep days"
say "ready"
