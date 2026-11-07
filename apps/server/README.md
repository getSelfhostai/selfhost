# @selfhost/server

The selfhost HTTP API, specified in
[`packages/schema/openapi.yaml`](../../packages/schema/openapi.yaml). It serves:

- `GET /v1/health`: liveness, no token needed.
- `POST /v1/events`: append a batch of up to 1000 ledger events. Atomic: if any event is invalid
  the response is 400 with every error by index and field, and nothing is written. Retrying a
  batch is safe; already stored ids count as `duplicates`.
- `GET /v1/events`: search by `person`, `agent`, `model`, `session`, `kind`, `from` and `to`,
  newest first, with `limit` (default 100, max 1000) and `cursor` from `next_cursor`.
- `POST /v1/decisions`: record one human decision (`CreateDecisionRequest`: `verdict`, `by`,
  `reason`, `question`, what it answers as `item_id`, `run_id`, `rule_id` or `pr_url`, plus
  `paths`, links, `surface`, and `key` with `ts` for retries). Returns 201 with the stored
  event, or 200 with `duplicate: true` when the same `key` and `ts` were already recorded. Every
  surface records decisions through this call or the `recordDecision` function behind it.
- `GET /v1/review-items`: the review list ([`packages/review`](../../packages/review/README.md)),
  ranked: blocking first, then by risk, then oldest first, then by id, snoozed items last. Filters
  `state` (default `open`), `owner` and `team`, with `limit` and `cursor`. `GET
  /v1/review-items/{id}` opens one item. `POST /v1/review-items/{id}/decision` answers it
  (`{ verdict, reason?, by? }`): one `decision.recorded` event, then the item is answered. `POST
  /v1/review-items/{id}/snooze` (`{ until, by? }`) ranks it last until then. An item that is no
  longer open answers 409 with `{ error, item }` and nothing is written. With the admin token
  `by` is required; a person token acts as its own person.
- `GET /v1/decisions`: `decision.recorded` and `policy.evaluated` events, newest first, by
  `path` (a file, the files under a folder, the folders that hold it), `topic` (every word in
  the question or reason), `text`, `rule_id`, `verdict`, `repo`, `target`, `person`,
  `item_id`, `from` and `to`. `format=text` returns the plain text the CLI and the MCP tool
  print: each decision's id, who, verdict, reason and links.

Every route except `/v1/health` and `/v1/join` needs `Authorization: Bearer <token>`. The admin
token is `SELFHOST_TOKEN` when set; otherwise the server generates one on first start, saves it
to `<data dir>/token` with mode 0600 and prints it once.

## Teams

Team mode lets laptops share their usage and read one team policy. The admin token stays the
bootstrap admin; everything else is a token the server issues and keeps only as a sha256 hash:

- `POST /v1/teams` (admin token): creates a team from `{ name, invite_ttl_seconds? }` (its id
  is the name in kebab case) and returns an invite code and when it expires. Anyone holding the
  invite can join until then.
- `POST /v1/teams/{team}/invites` (admin token): another invite from
  `{ ttl_seconds?, email? }`. Invites expire after 7 days unless `ttl_seconds` says otherwise
  (60 seconds to 365 days). An invite with an email joins only that person, and their person id
  is the email, so whoever holds it cannot join as someone else.
- `DELETE /v1/invites/{id}` (admin token): revokes an invite. `id` is the sha256 of the code in
  hex, returned when the invite is created, so the code itself never goes in a URL.
- `POST /v1/join` (no bearer token, the invite is the credential): exchanges
  `{ invite, person, name? }` for a person token. `person` is who the laptop's events belong
  to, such as a git email. The first person in a team becomes its owner, the rest members.
  A team-wide invite only adds new people: a person id already in the team (the owner,
  anyone who joined, revoked people too, compared ignoring case) is refused, so holding it
  never gives someone else's identity or role. A second machine for the same person needs an
  invite for their email, which adds another token for them. An unknown, expired or revoked
  invite, one for another email, or a team-wide invite for an existing person answers 401
  `invalid_invite`.
- `DELETE /v1/teams/{team}/people/{person}/tokens` (admin token): revokes every token the
  person holds and the open invites for their email. Their events stay.
- `DELETE /v1/me/token` (person token): revokes the token making the request. `selfhost team
  leave` calls it.
- `GET /v1/me`: `{ kind: "admin" }` or the person and team the token belongs to.
- `GET /v1/policy`: the team's `selfhost.toml` text, the parsed config and the rules after
  team overrides (`[teams.<team id>]` and teams that list the person as a member). A person
  token reads its own team; the admin token passes `?team=`.
- `PUT /v1/policy`: replaces the team's `selfhost.toml` from `{ text }` after validating it
  like `selfhost doctor`. Admin token with `?team=`, or a person token whose role is owner or
  admin.

A person token can call `POST` and `GET /v1/events` (its own team only), the review item routes
(its own team's items only: another team's item is 404 and `?team=` of another team 403),
`GET /v1/me`, `DELETE /v1/me/token` and `/v1/policy`, and gets 403 everywhere else, including
`/v1/decisions`. Before its events are written, an event with no
actor gets the person, a person actor must be that person, system actors are refused, and
`team` is set to the person's team; the batch then goes through the ordinary events route, so
validation, atomicity and idempotent ids are the same. Each new event is also stored with the
token's team in the indexed `events.team` column. Reads with a person token are limited to that
column: the token sees the events its team's person tokens wrote and nothing else, and asking
for `?team=` of another team answers 403. The admin token reads everything and can filter with
`?team=`. Events written before the column existed, or with the admin token, have no team.

Tables `teams`, `people` and `tokens` come from the ledger package's migrations
`0002_teams.sql` and `0003_team_access.sql`, in the same database as the events, and are
reached through `ledger.teams`.

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

On start and then every 15 seconds the server refreshes the review list: new signals become
items, PRs that merged or closed and waits the session moved on from are closed, decisions
recorded on other paths are applied, last week's would-block report is filed, and blocking
approvals past their deadline are denied in the decision log. Items from a team's events use the
team's stored `selfhost.toml`, others `SELFHOST_CONFIG`. `SELFHOST_REVIEW_REFRESH=off` turns
that off, for a second server on the same database.

With default settings the server opens no outbound connection and sends no telemetry;
`test/privacy.test.ts` ingests fixture events, OTLP and team writes with every outbound path
stubbed to fail, then reads every table to check that no planted secret was stored.

```sh
pnpm --filter @selfhost/server dev     # watch mode on http://127.0.0.1:4400
pnpm --filter @selfhost/server build   # bundles to dist/main.js
pnpm --filter @selfhost/server start   # runs the build
```

Environment:

| Variable                   | Default            | Meaning                                                                                                    |
| -------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `PORT`                     | `4400`             | Port to listen on.                                                                                         |
| `HOST`                     | `127.0.0.1`        | Address to bind.                                                                                           |
| `DATABASE_URL`             | unset              | `postgres://` URL. Unset uses the embedded database.                                                       |
| `SELFHOST_DATA_DIR`        | `~/.selfhost/data` | Embedded database and token file.                                                                          |
| `SELFHOST_TOKEN`           | unset              | API token. Unset uses or creates `<data dir>/token`.                                                       |
| `SELFHOST_CONFIG`          | unset              | `selfhost.toml` with the defaults for events with no team policy: `[ledger]`, `[[redaction]]`, `[review]`. |
| `SELFHOST_RETENTION_SWEEP` | `daily`            | `off` keeps every event instead of deleting expired ones daily.                                            |
| `SELFHOST_REVIEW_REFRESH`  | `15s`              | `off` stops building review items and timing out approvals on this server.                                 |
