# @selfhost/server

The selfhost HTTP API, specified in
[`packages/schema/openapi.yaml`](../../packages/schema/openapi.yaml). It serves:

- `GET /v1/health`: liveness, no token needed.
- `POST /v1/events`: append a batch of up to 1000 ledger events. Atomic: if any event is invalid
  the response is 400 with every error by index and field, and nothing is written. Retrying a
  batch is safe; already stored ids count as `duplicates`.
- `GET /v1/events`: search by `person`, `agent`, `model`, `session`, `kind`, `from` and `to`,
  newest first, with `limit` (default 100, max 1000) and `cursor` from `next_cursor`.

Every route except `/v1/health` and `/v1/join` needs `Authorization: Bearer <token>`. The admin
token is `SELFHOST_TOKEN` when set; otherwise the server generates one on first start, saves it
to `<data dir>/token` with mode 0600 and prints it once.

## Teams

Team mode lets laptops share their usage and read one team policy. The admin token stays the
bootstrap admin; everything else is a token the server issues and keeps only as a sha256 hash:

- `POST /v1/teams` (admin token): creates a team from `{ name }` (its id is the name in kebab
  case) and returns an invite code. Anyone holding the invite can join.
- `POST /v1/join` (no bearer token, the invite is the credential): exchanges
  `{ invite, person, name? }` for a person token. `person` is who the laptop's events belong
  to, such as a git email. The first person in a team becomes its owner, the rest members.
  Joining again with the same id returns another token for the same person.
- `GET /v1/me`: `{ kind: "admin" }` or the person and team the token belongs to.
- `GET /v1/policy`: the team's `selfhost.toml` text, the parsed config and the rules after
  team overrides (`[teams.<team id>]` and teams that list the person as a member). A person
  token reads its own team; the admin token passes `?team=`.
- `PUT /v1/policy`: replaces the team's `selfhost.toml` from `{ text }` after validating it
  like `selfhost doctor`. Admin token with `?team=`, or a person token whose role is owner or
  admin.

A person token can call `POST /v1/events`, `GET /v1/me` and `/v1/policy`, and gets 403
everywhere else, including reading events. Before its events are written, an event with no
actor gets the person, a person actor must be that person, system actors are refused, and
`team` is set to the person's team; the batch then goes through the ordinary events route, so
validation, atomicity and idempotent ids are the same.

Tables `teams`, `people` and `tokens` come from the ledger package's migration
`0002_teams.sql`, in the same database as the events, and are reached through `ledger.teams`.

No model traffic passes through this server. It has no route that forwards requests to Anthropic,
OpenAI or any other provider, and serving a request opens no connection other than to its own
database: agents keep calling their vendors directly under each developer's own login, and
selfhost never asks for or stores those logins or provider keys. `test/teams.test.ts` checks that vendor API paths are not served and that
serving team requests opens no connection.

## Privacy and retention

Every event is redacted in the ledger's write path before it is stored, whichever route it came
in on (see [`packages/ledger`](../../packages/ledger/README.md#redaction)): prompt and response
text is dropped unless prompt logging is on, and secrets, emails and `[[redaction]]` patterns
are masked. A team's stored `selfhost.toml` sets this for events with that team, which includes
every event a person token writes. Other events, such as OTLP from the collector, use the
server's defaults: the `selfhost.toml` at `SELFHOST_CONFIG`, else prompts off and the built-in
patterns. The server never logs request or event bodies.

On start and then once a day the server deletes events older than their retention: the team's
`ledger.retention_days`, else the one in `SELFHOST_CONFIG`, else 90 days.
`SELFHOST_RETENTION_SWEEP=off` turns that off.

With default settings the server opens no outbound connection and sends no telemetry;
`test/privacy.test.ts` ingests fixture events, OTLP and team writes with every outbound path
stubbed to fail, then reads every table to check that no planted secret was stored.

```sh
pnpm --filter @selfhost/server dev     # watch mode on http://127.0.0.1:4400
pnpm --filter @selfhost/server build   # bundles to dist/main.js
pnpm --filter @selfhost/server start   # runs the build
```

Environment:

| Variable                   | Default            | Meaning                                                                                           |
| -------------------------- | ------------------ | ------------------------------------------------------------------------------------------------- |
| `PORT`                     | `4400`             | Port to listen on.                                                                                |
| `HOST`                     | `127.0.0.1`        | Address to bind.                                                                                  |
| `DATABASE_URL`             | unset              | `postgres://` URL. Unset uses the embedded database.                                              |
| `SELFHOST_DATA_DIR`        | `~/.selfhost/data` | Embedded database and token file.                                                                 |
| `SELFHOST_TOKEN`           | unset              | API token. Unset uses or creates `<data dir>/token`.                                              |
| `SELFHOST_CONFIG`          | unset              | `selfhost.toml` with the defaults for events with no team policy: `[ledger]` and `[[redaction]]`. |
| `SELFHOST_RETENTION_SWEEP` | `daily`            | `off` keeps every event instead of deleting expired ones daily.                                   |
