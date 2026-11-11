# Docker Compose install

Runs selfhost on one Linux server with Docker: Postgres, the OpenTelemetry collector that receives
agent telemetry, and the selfhost API. One file, [`compose.yml`](./compose.yml), with its
settings in `.env`. Two optional files add HTTPS with Caddy ([`compose.tls.yml`](./compose.tls.yml))
and GitHub or Google sign-in for the console ([`compose.signin.yml`](./compose.signin.yml)).
[`selfhost up`](#selfhost-up) puts all of it on a new cloud server or any server over SSH in
one command.

| Service           | Image                                                              | Published ports                    | Health check                                                 |
| ----------------- | ------------------------------------------------------------------ | ---------------------------------- | ------------------------------------------------------------ |
| `postgres`        | `postgres:16.15`                                                   | none                               | `pg_isready`                                                 |
| `selfhost`        | `ghcr.io/getselfhostai/selfhost:$SELFHOST_VERSION`                 | 4400 (API)                         | `GET /v1/health` (in the image)                              |
| `otel-collector`  | `otel/opentelemetry-collector-contrib:0.164.0`                     | 4317 (OTLP gRPC), 4318 (OTLP HTTP) | `health_check` extension on 13133                            |
| `collector-probe` | `busybox:1.37.0-musl`                                              | none                               | Runs once: copies the static `wget` the collector check uses |
| `caddy`           | `caddy:2.11.9-alpine` (`compose.tls.yml`)                          | 80, 443 (HTTPS)                    | Caddy's admin endpoint on 2019, inside the container         |
| `oauth2-proxy`    | `quay.io/oauth2-proxy/oauth2-proxy:v7.15.6` (`compose.signin.yml`) | none                               | none (distroless image)                                      |

Third-party images are pinned to exact versions. `pnpm --filter @selfhost/deploy test` fails if
any image in `compose.yml`, `compose.tls.yml` or `compose.signin.yml` uses `latest`, has no tag
or names only a major version, and the
`compose` CI job does the same check on the images Compose resolves.

How data flows: agents send OTLP to the collector with the agent token. The collector batches,
retries and forwards logs and metrics to `POST /v1/otlp/v1/logs` and `/v1/otlp/v1/metrics` on
the API as OTLP/HTTP JSON. Log records become ledger events, mapped by `mapOtelLogs` in
[`packages/ledger`](../../packages/ledger/README.md#sources). Metrics are accepted and not
stored, since the log records already carry each request's tokens and cost. Traces are accepted
and dropped. Hooks and importers write to `POST /v1/events` directly.

## Install on a clean Linux server

You need Docker Engine 23 or later with the Compose v2 plugin (`docker compose`), see
[docs.docker.com/engine/install](https://docs.docker.com/engine/install/), plus `openssl`. Each
GitHub Release carries this folder as `selfhost-docker-<version>.tar.gz`, with `SELFHOST_VERSION`
set to that release, so no clone is needed:

```sh
version=0.1.0
curl -fsSLO "https://github.com/getSelfhostai/selfhost/releases/download/v$version/selfhost-docker-$version.tar.gz"
tar -xzf "selfhost-docker-$version.tar.gz" && cd "selfhost-docker-$version"
cp .env.example .env
for key in POSTGRES_PASSWORD SELFHOST_TOKEN SELFHOST_OTLP_TOKEN; do
  sed -i "s/^$key=$/$key=$(openssl rand -hex 32)/" .env
done
chmod 600 .env
docker compose up -d
```

[`install.sh`](#installsh) does the same as root, and installs Docker first when it is missing.
To build the server from source instead, clone the repository, run the same steps in
`deploy/docker`, and start it with `docker compose up -d --build`.

`docker compose ps` lists `postgres`, `selfhost` and `otel-collector` as `healthy` within a
minute (`collector-probe` exits after it copies its file). Then:

```sh
curl http://localhost:4400/v1/health
```

The server applies database migrations on start, under a lock, before it listens. The stack
speaks plain HTTP, so the API and the collector are published on 127.0.0.1 only by default:
reach them from this server, or add `compose.tls.yml` (below) to serve them over HTTPS. On a
private network where laptops connect directly, set `SELFHOST_BIND=0.0.0.0` and
`OTLP_BIND=0.0.0.0` in `.env`.

## Connect agents

Point each laptop's agents at the collector with the agent token (`SELFHOST_OTLP_TOKEN` in
`.env`, which can only write telemetry):

```sh
selfhost agents configure --otel-endpoint http://<server>:4318 \
  --otel-header "Authorization=Bearer <SELFHOST_OTLP_TOKEN>"
```

Read the ledger with the API token (`SELFHOST_TOKEN`, admin access: keep it on the server and on
the laptop of whoever runs the team, never on the laptops agents run on):

```sh
curl -H "Authorization: Bearer <SELFHOST_TOKEN>" "http://<server>:4400/v1/events?limit=20"
```

## Upgrade and roll back

```sh
./upgrade.sh 0.2.0     # the SELFHOST_VERSION to run, newer or older
```

[`upgrade.sh`](./upgrade.sh) is the one command for both directions:

1. It takes a backup with `backup.sh`.
2. Going back to a release that knows fewer migrations than the database has, the running
   release rolls them back with their down migrations (only it has them).
3. The target release applies its pending migrations in a one-off container
   (`node dist/migrate.js`) while the running release keeps serving. They run in one transaction:
   if one fails, the database stays at the version it had, `.env` keeps naming the running
   release, and the script stops with `... keeps running`.
4. It sets `SELFHOST_VERSION` in `.env`, and the new server replaces the running one.

Events live in the `selfhost_postgres-data` volume, which an upgrade never touches. When a
release also moves a pinned image or the collector config, take the new release's files first
(`git pull`, or its `selfhost-docker-<version>.tar.gz` unpacked over this folder, `.env` kept). If you build from source, build the target image first (`SELFHOST_VERSION=<version>
docker compose build selfhost`); upgrade.sh only pulls an image it does not have.

Every migration ships with a rollback, but rolling back drops what the newer release added (a
new table's rows, a new column's values), so after a rollback the backup from step 1 is the
complete copy. A server never starts on a schema newer than it knows: it stops with `The database
schema is newer than this release` instead, which is what you see if you set an older
`SELFHOST_VERSION` by hand without `upgrade.sh`. By hand, the same steps are:

```sh
./backup.sh
docker compose run --rm --no-deps selfhost node dist/migrate.js --status    # where the schema is
docker compose run --rm --no-deps selfhost node dist/migrate.js --to 0008   # down (or up) to 0008
SELFHOST_VERSION=0.2.0 docker compose run --rm --no-deps selfhost node dist/migrate.js
# then set SELFHOST_VERSION=0.2.0 in .env and: docker compose up -d
```

## Back up

```sh
./backup.sh                          # writes backups/selfhost-<UTC time>.dump
./backup.sh /mnt/backup/selfhost.dump
```

`backup.sh` runs `pg_dump --format=custom` inside the `postgres` container while the stack keeps
running. The dump is one consistent snapshot. It prints the rows of every table
(`rows: events=1204 people=6 ...`), counted right after the dump. Copy the file off the server,
and keep a copy of `.env` too, so agents keep working with the same tokens after a restore.
`install.sh` (and so `selfhost up`) schedules it daily with a systemd timer and deletes backups
older than `SELFHOST_BACKUP_KEEP_DAYS` (14). By hand, a nightly cron entry:

```cron
0 3 * * * /opt/selfhost/deploy/docker/backup.sh >> /var/log/selfhost-backup.log 2>&1
```

From a laptop with the selfhost CLI, one command runs it over SSH and copies the dump back, which
is how to get the daily backups of a `selfhost up` server off it:

```sh
selfhost ledger backup --host root@203.0.113.10                      # ./selfhost-<UTC time>.dump
selfhost ledger backup --host ubuntu@203.0.113.10 -i ~/.ssh/key off-site/selfhost.dump
```

The same by hand:

```sh
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > selfhost.dump
```

## Restore into a fresh install

1. Install as above on the new server (or `selfhost up`). Copy the old `.env` over first to keep
   the same tokens.
2. `docker compose up -d`, and wait for `docker compose ps` to show every service healthy.
3. Restore, and compare the `rows:` line it prints with the one `backup.sh` printed:

```sh
./restore.sh /path/to/selfhost-20261107T030000Z.dump
# or from a laptop, copying the dump to the server over SSH first:
selfhost ledger restore selfhost-20261107T030000Z.dump --host root@203.0.113.10
```

`restore.sh` runs `pg_restore` in a single transaction into a scratch database while the stack
keeps running, so a bad file leaves the live database as it was. Then it stops `selfhost` and
`otel-collector`, swaps the restored database in, and starts them again. If the live database
already holds events it stops and changes nothing; `./restore.sh --force <file>` (or
`selfhost ledger restore --force`) replaces them. Restore into the release that made the backup
or a newer one: the server applies any newer migrations on start, and refuses a backup from a
newer release.

The same by hand:

```sh
docker compose stop selfhost otel-collector
docker compose exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" --force "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges --single-transaction' < selfhost.dump
docker compose up -d
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT count(*) FROM events"'
```

The embedded ledger of a laptop (`selfhost import`, solo mode) backs up the same way without
`--host`: `selfhost ledger backup` writes a gzipped tar of `~/.selfhost/data`, and
`selfhost ledger restore <file>` puts it back. See [`apps/cli`](../../apps/cli/README.md).

## HTTPS and sign-in

`compose.tls.yml` adds Caddy, which gets a Let's Encrypt certificate for `SELFHOST_DOMAIN`, renews
it, and is the only service published to the internet (80 and 443). Set in `.env`:

```sh
COMPOSE_FILE=compose.yml:compose.tls.yml
SELFHOST_DOMAIN=selfhost.example.com   # its DNS must point at this server
SELFHOST_PUBLIC_URL=https://selfhost.example.com
```

`SELFHOST_BIND` and `OTLP_BIND` stay at their default, 127.0.0.1, so the API and the collector
answer on this server only and Caddy reaches them over the compose network.

Caddy routes by path ([`Caddyfile`](./Caddyfile)): `/v1/*` to the API, behind its bearer
tokens, so the CLI, hooks and the GitHub webhook work as before; `/otlp/*` to the collector's
OTLP HTTP port, behind the agent token (point agents at `https://<domain>/otlp`); everything
else is the web console, which the selfhost server itself serves (it is built into the image).
Without sign-in each person opens the console with `selfhost console` on a laptop that joined
with `selfhost join <server> <invite>`, which signs them in with their person token; the sign-in
page also takes the admin token. Its pages hold no data;
what it shows comes from `/v1` with that token, and the server's roles decide what that is (a
member sees their teams, the admin token every team).

`compose.signin.yml` adds oauth2-proxy in front of the console: add it to `COMPOSE_FILE` and set
`SELFHOST_SIGNIN_PROVIDER` (`github` or `google`), the OAuth app's client id and secret, and who
may sign in (`SELFHOST_SIGNIN_EMAIL_DOMAINS`, the emails in `signin-emails.txt`, and for GitHub
`SELFHOST_SIGNIN_GITHUB_ORG`). The OAuth app's callback URL is
`https://<domain>/oauth2/callback`. `/v1` never needs sign-in.

With sign-in, people need no token in the console: a signed-in browser's own reads of `/v1`
(GET, no bearer token, the oauth2-proxy cookie) go through oauth2-proxy, and Caddy passes the
signed-in email to the server in `X-Selfhost-Email` with `SELFHOST_SIGNIN_PROXY_SECRET` in
`X-Selfhost-Proxy-Secret`. The server believes the email only with that secret (install.sh
generates it), and Caddy drops both headers from every request before it sets them, so neither
a client nor a request that reaches port 4400 some other way can claim an email. The email must
be a person id on the server whose tokens are not all revoked: invite people by email
(`selfhost team invite --email`) and the ids match. Sign-in only reads; anything that writes
still needs a token.

## AI gateway

`compose.gateway.yml` runs [Bifrost](https://github.com/maximhq/bifrost) (Apache 2.0, pinned to
`maximhq/bifrost:v2.4.0`) next to the server. It holds the provider keys; agents reach it at
`https://<domain>/llm/` with a virtual key the selfhost server issued, and a request without one
is refused. Add it after `compose.tls.yml`, put the provider keys you have in `.env`, and run
`install.sh` (or `selfhost up --gateway`):

```sh
COMPOSE_FILE=compose.yml:compose.tls.yml:compose.gateway.yml
ANTHROPIC_API_KEY=...          # and any of OPENAI_API_KEY, FIREWORKS_API_KEY,
AWS_ACCESS_KEY_ID=...          # AWS_ACCESS_KEY_ID with AWS_SECRET_ACCESS_KEY and AWS_REGION (Bedrock),
AWS_SECRET_ACCESS_KEY=...      # AZURE_API_KEY with AZURE_ENDPOINT, VERTEX_PROJECT_ID with
AWS_REGION=eu-central-1        # VERTEX_REGION and VERTEX_CREDENTIALS
```

- `install.sh` writes `bifrost.json` with [`gateway-config.sh`](./gateway-config.sh): Postgres
  (a `bifrost` database on the same server, created by the one-shot `gateway-db` service) for
  Bifrost's keys, budgets and request logs, admin auth with `SELFHOST_GATEWAY_ADMIN_KEY`, virtual
  keys required on every model request, no direct provider keys, no prompt or response bodies in
  its logs, and one provider for each set of keys in `.env`, with its region pinned. Every
  secret in it is an `env.<NAME>` reference, so the file holds none, and provider keys reach the
  Bifrost container only, never the selfhost server. `SELFHOST_GATEWAY_ADMIN_KEY` and
  `SELFHOST_GATEWAY_ENCRYPTION_KEY` are generated like the other secrets.
- Caddy serves only Bifrost's model routes (`/llm/anthropic/`, `/llm/openai/`, `/llm/v1/`) and
  `/llm/health`. Its management API and web UI stay inside Docker; the UI is published on
  `127.0.0.1:8080` for an SSH tunnel (`ssh -L 8080:127.0.0.1:8080 <server>`), signed in as
  `selfhost` with `SELFHOST_GATEWAY_ADMIN_KEY`.
- The selfhost server writes a Bifrost team per selfhost team, and keys per person, team and run,
  with the budgets of each team's `selfhost.toml` (`[budget]` with `mode = "hard"`) and the
  providers of `[integrations.router] providers`, every five minutes and only what differs. It
  reads Bifrost's request logs into the ledger as `cost.recorded` events with `source =
  "gateway"`. `selfhost gateway connect <agent>` gives a person their key and the agent's
  settings; see [`apps/cli`](../../apps/cli/README.md#ai-gateway-selfhost-gateway).
- A team that already runs LiteLLM leaves this overlay out and sets `SELFHOST_GATEWAY_TOOL=litellm`,
  `SELFHOST_GATEWAY_URL` and `SELFHOST_GATEWAY_ADMIN_KEY` (its master key) in `.env`, or
  `[integrations.router]` in the server's `selfhost.toml` (`SELFHOST_CONFIG`), which wins. The
  same keys, budgets and usage work there, with one budget window per key and team (the
  shortest is enforced, the others alert) and fallbacks left to LiteLLM's own router settings.

## Notifications

`compose.notify.yml` runs the [Apprise API](https://github.com/caronc/apprise-api) (BSD-2,
pinned to `caronc/apprise:2.0.2`) next to the server. selfhost decides what to send and when;
Apprise delivers it to Telegram, Slack, email, Teams, Discord, ntfy and 100+ other services, so
selfhost has no sender of its own for any of them. Add it to `COMPOSE_FILE` and run `install.sh`
(or `docker compose up -d`):

```sh
COMPOSE_FILE=compose.yml:compose.tls.yml:compose.notify.yml
```

- Each person adds their own targets as Apprise URLs with `selfhost notify add
  tgram://<bot token>/<chat id>` (or `-` to read the URL from stdin), or in the console's Team
  screen. The URLs hold secrets, so they are kept in the server's database only: the API, the
  CLI, the console and the logs show a target's name and service, never its URL. Members add
  hosted services (Telegram, Slack, Discord, Teams and the like, or `ntfys://<topic>` on
  ntfy.sh); a URL with a host of its own (email through any SMTP host, a self-hosted ntfy,
  `json://` or a webhook) needs a team owner or admin, since the server would connect to it.
- Only the server reaches Apprise, on the compose network: no port is published, and Apprise
  runs stateless (`APPRISE_STATEFUL_MODE=disabled`), so it stores no URL either.
- An agent waiting on a person is pushed to them at once; everything else goes into their
  digest (`selfhost notify digest daily|weekly|off`, default `[notify] digest`). Budget alerts
  at 50%, 80% and 100% go to `[notify] budget_owners` (default: the team's owners), who also get
  a daily spend digest. Messages carry a summary and a link to the console, where the item is
  answered; no code, diff, prompt or secret.
- Every send is recorded with the target's name, what it was and whether it went
  (`GET /v1/notify/sends`). `SELFHOST_PUBLIC_URL` gives the links; without it messages point to
  `selfhost inbox`. With several servers on one database, set `SELFHOST_NOTIFY=off` on all but one.
- A team that already runs Apprise leaves this overlay out and sets `SELFHOST_APPRISE_URL` in
  `.env` to its address.
- `selfhost up` does not put this file on the server (user-data has no room for it): copy it to
  `/opt/selfhost/deploy/docker`, add it to `COMPOSE_FILE` in `.env` and run `install.sh` again.

## install.sh

`sudo ./install.sh` installs or updates the stack on the server it runs on: Docker when it is
missing (from Docker's apt repository on Debian and Ubuntu, with the script from get.docker.com
on other systems; it says which), the containers of the files in `COMPOSE_FILE`,
and the daily backup timer. It generates any secret left empty in `.env` (the database password,
both tokens, the sign-in cookie secret and proxy secret, the gateway's admin and encryption keys), so `cp .env.example .env && sudo ./install.sh` is a
complete install. Run again, it keeps the secrets already in `.env`.

## selfhost up

`selfhost up` sets the whole thing up on a new server, or on any Linux server over SSH:

```sh
selfhost up --provider hetzner        # HCLOUD_TOKEN
selfhost up --provider digitalocean   # DIGITALOCEAN_TOKEN
selfhost up --provider aws            # the aws CLI, signed in; AWS_REGION or --region
selfhost up --provider ssh --host root@203.0.113.10
selfhost up --provider hetzner --dry-run   # the plan and the cloud-init user-data; creates nothing
```

On a cloud it adds your SSH key (`~/.ssh/id_ed25519.pub` unless `--ssh-key`), a firewall that
lets in 22, 80 and 443 only, and an Ubuntu 24.04 server sized by `--people` and
`--events-per-day`, with cloud-init user-data that writes these files to
`/opt/selfhost/deploy/docker` and runs `install.sh`. Over SSH it runs the same script as root
(`sudo -n` for other users). The user-data carries no secret: `install.sh` generates the tokens
and passwords on the server.

Once `https://<domain>/v1/health` answers, it connects over SSH (a new cloud server's host key
goes in `~/.selfhost/known_hosts` under the server's name), turns on sign-in when asked by
writing the OAuth client secret to `.env` (mode 0600) and running `install.sh` again, and reads
back the admin and agent tokens. It saves the server and the admin token in
`~/.selfhost/config.json` (mode 0600; the `selfhost team` commands use it from there), creates a
first team, prints the `selfhost join` line, and prints how to delete what it created.

Without `--domain` the name is `<ip>.sslip.io`, which sslip.io resolves to the IP, so HTTPS works
with no DNS to set up; that depends on sslip.io, so use your own domain for a team that relies on
the server. `--signin github|google` with `SELFHOST_SIGNIN_CLIENT_ID`,
`SELFHOST_SIGNIN_CLIENT_SECRET` and one of `--allow-email`, `--allow-domain` or `--github-org`
turns on sign-in. Until release images are published, pass `--image` with one the server can
pull.

If a step fails, it stops and lists every resource it created, with the command that deletes
each one. Backups stay on the server's disk only: copy them elsewhere as well, with
`selfhost ledger backup --host <user@host>` (see [Back up](#back-up)). Upgrades and restores on
the server are the same `upgrade.sh` and `restore.sh` as above, in `/opt/selfhost/deploy/docker`.

`--gateway` adds the AI gateway: its two files go over SSH with the sign-in step, which keeps
the user-data under Hetzner's 32 KB. Provider keys never travel through `selfhost up`: add them
to `.env` on the server and run `install.sh` again.

The CI job `install` runs `install.sh` with the HTTPS, sign-in and gateway overlays on a GitHub
runner, with `SELFHOST_DOMAIN=localhost` so Caddy serves HTTPS from its own local CA, and checks
that Bifrost answers behind Caddy, refuses requests without a virtual key, and takes the keys
and budgets the server writes. No provider is called.

## Files

| File                           | What                                                                 |
| ------------------------------ | -------------------------------------------------------------------- |
| `compose.yml`                  | The stack                                                            |
| `.env.example`                 | Every setting `compose.yml` reads, with defaults; copy to `.env`     |
| `otel-collector.yaml`          | Collector config: OTLP receivers, agent token, batching and retries  |
| `Dockerfile`                   | Server image with the web console, built on `node:22-slim`, non-root |
| `backup.sh`, `restore.sh`      | `pg_dump` and `pg_restore` wrappers                                  |
| `upgrade.sh`                   | Moves to another release: backup, migrations checked first, switch   |
| `compose.tls.yml`, `Caddyfile` | Caddy with HTTPS in front of the API, the collector and the console  |
| `compose.signin.yml`           | oauth2-proxy: GitHub or Google sign-in for the console               |
| `compose.gateway.yml`          | Bifrost, the AI gateway, with its database on the same Postgres      |
| `gateway-config.sh`            | Writes `bifrost.json` from `.env`, with references, never secrets    |
| `compose.notify.yml`           | Apprise, which delivers alerts and digests to phone, chat and email  |
| `install.sh`                   | Installs Docker, starts the stack, schedules the daily backup        |

The CI job `compose` in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs all of
this on a Linux runner: it builds the image, waits for every health check, writes fixture events
through the API and an OTLP payload through the collector, upgrades to a new image tag with
`upgrade.sh` and checks the events are still there, rolls back the same way, checks that a release
whose migrations fail leaves the running one serving, then backs up, restores into a fresh volume
and compares the event and row counts. Last it adds `compose.notify.yml` with a local SMTP
catcher (Mailpit), and checks that a test, an instant push and a digest arrive by email, that no
message carries the agent's tool input, and that no target URL is returned or logged. The CI job `upgrade` writes data through the previous
release's server (this checkout without its newest migration, as no release is tagged yet) on
the same Postgres version, upgrades, rolls back and upgrades again with the server's
`dist/migrate.js`, and checks the rows of every table at each step. The repository root's `docker-compose.yml` is separate: Postgres alone, for local
development.
