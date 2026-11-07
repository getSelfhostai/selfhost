# Docker Compose install

Runs selfhost on one Linux server with Docker: Postgres, the OpenTelemetry collector that receives
agent telemetry, and the selfhost API. One file, [`compose.yml`](./compose.yml), with its
settings in `.env`.

| Service           | Image                                              | Published ports                    | Health check                                                 |
| ----------------- | -------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------ |
| `postgres`        | `postgres:16.15`                                   | none                               | `pg_isready`                                                 |
| `selfhost`        | `ghcr.io/getselfhostai/selfhost:$SELFHOST_VERSION` | 4400 (API)                         | `GET /v1/health` (in the image)                              |
| `otel-collector`  | `otel/opentelemetry-collector-contrib:0.164.0`     | 4317 (OTLP gRPC), 4318 (OTLP HTTP) | `health_check` extension on 13133                            |
| `collector-probe` | `busybox:1.37.0-musl`                              | none                               | Runs once: copies the static `wget` the collector check uses |

Third-party images are pinned to exact versions. `pnpm --filter @selfhost/deploy test` fails if
any image in `compose.yml` uses `latest`, has no tag or names only a major version, and the
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

Read the ledger with the API token (`SELFHOST_TOKEN`, admin access, keep it on the server):

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
tokens after a restore. A nightly cron entry:

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

## Files

| File                      | What                                                                      |
| ------------------------- | ------------------------------------------------------------------------- |
| `compose.yml`             | The stack                                                                 |
| `.env.example`            | Every setting `compose.yml` reads, with defaults; copy to `.env`          |
| `otel-collector.yaml`     | Collector config: OTLP receivers, agent token, batching and retries       |
| `Dockerfile`              | The server image: pnpm and tsup build on `node:22-slim`, non-root runtime |
| `backup.sh`, `restore.sh` | `pg_dump` and `pg_restore` wrappers                                       |

The CI job `compose` in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs all of
this on a Linux runner: it builds the image, waits for every health check, writes fixture events
through the API and an OTLP payload through the collector, upgrades to a new image tag and checks
the events are still there, then backs up, restores into a fresh volume and compares the event
counts. The repository root's `docker-compose.yml` is separate: Postgres alone, for local
development.
