# @selfhost/server

The selfhost HTTP API, specified in
[`packages/schema/openapi.yaml`](../../packages/schema/openapi.yaml). It serves:

- `GET /v1/health`: liveness, no token needed.
- `POST /v1/events`: append a batch of up to 1000 ledger events. Atomic: if any event is invalid
  the response is 400 with every error by index and field, and nothing is written. Retrying a
  batch is safe; already stored ids count as `duplicates`.
- `GET /v1/events`: search by `person`, `agent`, `model`, `session`, `kind`, `from` and `to`,
  newest first, with `limit` (default 100, max 1000) and `cursor` from `next_cursor`.

Every route except `/v1/health` needs `Authorization: Bearer <token>`. The token is
`SELFHOST_TOKEN` when set; otherwise the server generates one on first start, saves it to
`<data dir>/token` with mode 0600 and prints it once.

```sh
pnpm --filter @selfhost/server dev     # watch mode on http://127.0.0.1:4400
pnpm --filter @selfhost/server build   # bundles to dist/main.js
pnpm --filter @selfhost/server start   # runs the build
```

Environment:

| Variable            | Default            | Meaning                                              |
| ------------------- | ------------------ | ---------------------------------------------------- |
| `PORT`              | `4400`             | Port to listen on.                                   |
| `HOST`              | `127.0.0.1`        | Address to bind.                                     |
| `DATABASE_URL`      | unset              | `postgres://` URL. Unset uses the embedded database. |
| `SELFHOST_DATA_DIR` | `~/.selfhost/data` | Embedded database and token file.                    |
| `SELFHOST_TOKEN`    | unset              | API token. Unset uses or creates `<data dir>/token`. |
