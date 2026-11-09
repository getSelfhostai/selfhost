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
[docs.docker.com/engine/install](https://docs.docker.com/engine/install/), plus `git` and
`openssl`.

```sh
git clone https://github.com/getselfhostai/selfhost.git
cd selfhost/deploy/docker
cp .env.example .env
for key in POSTGRES_PASSWORD SELFHOST_TOKEN SELFHOST_OTLP_TOKEN; do
  sed -i "s/^$key=$/$key=$(openssl rand -hex 32)/" .env
done
chmod 600 .env
docker compose up -d
```

Until release images are published, build the server from the checkout with
`docker compose up -d --build`.

`docker compose ps` lists `postgres`, `selfhost` and `otel-collector` as `healthy` within a
minute (`collector-probe` exits after it copies its file). Then:

```sh
curl http://localhost:4400/v1/health
```

The server applies database migrations on start, under a lock, before it listens. The stack
speaks plain HTTP: on anything but a private network, set `SELFHOST_BIND=127.0.0.1` and
`OTLP_BIND=127.0.0.1` in `.env` and put a TLS reverse proxy in front.

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

## Upgrade

Take a backup, set `SELFHOST_VERSION` in `.env` to the new release, then run one command:

```sh
docker compose pull && docker compose up -d
```

Compose replaces only the containers whose image or settings changed. The new server runs any
pending migrations when it starts. Events live in the `selfhost_postgres-data` volume, which an
upgrade never touches. When a release also moves a pinned image or the collector config, pull the
new release's files first (`git pull`). If you build from source, the command is
`git pull && docker compose up -d --build`.

To roll back, set the previous `SELFHOST_VERSION` and run the same command. If the newer release
added migrations, restore the backup you took before upgrading instead.

## Back up

```sh
./backup.sh                          # writes backups/selfhost-<UTC time>.dump
./backup.sh /mnt/backup/selfhost.dump
```

`backup.sh` runs `pg_dump --format=custom` inside the `postgres` container while the stack keeps
running. The dump is one consistent snapshot, and the script prints how many events it holds.
Copy the file off the server, and keep a copy of `.env` too, so agents keep working with the same
tokens after a restore. `install.sh` (and so `selfhost up`) schedules it daily with a systemd timer
and deletes backups older than `SELFHOST_BACKUP_KEEP_DAYS` (14). By hand, a nightly cron entry:

```cron
0 3 * * * /opt/selfhost/deploy/docker/backup.sh >> /var/log/selfhost-backup.log 2>&1
```

The same by hand:

```sh
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > selfhost.dump
```

## Restore into a fresh install

1. Install as above on the new server. Copy the old `.env` over first to keep the same tokens.
2. `docker compose up -d`, and wait for `docker compose ps` to show every service healthy.
3. Restore, and compare the event count it prints with the one `backup.sh` printed:

```sh
./restore.sh /path/to/selfhost-20261107T030000Z.dump
```

`restore.sh` runs `pg_restore` in a single transaction into a scratch database while the stack
keeps running, so a bad file leaves the live database as it was. Then it stops `selfhost` and
`otel-collector`, swaps the restored database in, and starts them again. If the live database
already holds events it stops and changes nothing; `./restore.sh --force <file>` replaces them.

The same by hand:

```sh
docker compose stop selfhost otel-collector
docker compose exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" --force "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges --single-transaction' < selfhost.dump
docker compose up -d
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT count(*) FROM events"'
```

## HTTPS and sign-in

`compose.tls.yml` adds Caddy, which gets a Let's Encrypt certificate for `SELFHOST_DOMAIN`, renews
it, and is the only service published to the internet (80 and 443). Set in `.env`:

```sh
COMPOSE_FILE=compose.yml:compose.tls.yml
SELFHOST_DOMAIN=selfhost.example.com   # its DNS must point at this server
SELFHOST_PUBLIC_URL=https://selfhost.example.com
SELFHOST_BIND=127.0.0.1                # the API and the collector answer on this server only
OTLP_BIND=127.0.0.1
```

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
each one. Backups stay on the server's disk only: copy them elsewhere as well.

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
| `compose.tls.yml`, `Caddyfile` | Caddy with HTTPS in front of the API, the collector and the console  |
| `compose.signin.yml`           | oauth2-proxy: GitHub or Google sign-in for the console               |
| `compose.gateway.yml`          | Bifrost, the AI gateway, with its database on the same Postgres      |
| `gateway-config.sh`            | Writes `bifrost.json` from `.env`, with references, never secrets    |
| `install.sh`                   | Installs Docker, starts the stack, schedules the daily backup        |

The CI job `compose` in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs all of
this on a Linux runner: it builds the image, waits for every health check, writes fixture events
through the API and an OTLP payload through the collector, upgrades to a new image tag and checks
the events are still there, then backs up, restores into a fresh volume and compares the event
counts. The repository root's `docker-compose.yml` is separate: Postgres alone, for local
development.
