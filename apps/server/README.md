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
- `GET /v1/decisions`: `decision.recorded` and `policy.evaluated` events, newest first, by
  `path` (a file, the files under a folder, the folders that hold it), `topic` (every word in
  the question or reason), `text`, `rule_id`, `verdict`, `repo`, `target`, `person`,
  `item_id`, `from` and `to`. `format=text` returns the plain text the CLI and the MCP tool
  print: each decision's id, who, verdict, reason and links.

Every route except `/v1/health`, `/v1/join` and `/v1/github/webhooks` needs
`Authorization: Bearer <token>`. The admin
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

A person token can call `POST` and `GET /v1/events` (its own team only), `GET /v1/me`,
`DELETE /v1/me/token` and `/v1/policy`, and gets 403 everywhere else, including decisions. Before its events are written, an event with no
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
database (and, for a signed GitHub App delivery, to the GitHub API): agents keep calling their vendors directly under each developer's own login, and
selfhost never asks for or stores those logins or provider keys. `test/teams.test.ts` checks that vendor API paths are not served and that
serving team requests opens no connection.

## GitHub App

`POST /v1/github/webhooks` receives the selfhost GitHub App's webhooks and keeps every open agent
pull request showing its review-list state, through
[`@selfhost/github`](../../packages/github/README.md):

- a risk label (`selfhost:risk-low`, `-medium`, `-high`) and an agent label
  (`selfhost:agent-claude-code`); when the risk changes the old label is removed and the new
  one added;
- a `selfhost/review` check run on the head commit whose summary is the review brief's summary,
  the risk and who was asked to review, with the brief and the risk inputs in its details;
- a review request to the owner the review list picked, under their login in
  `[review] github_logins`, else to the team in `[review] github_team`;
- the review brief as one comment, edited in place on later deliveries.

It answers 404 until `SELFHOST_GITHUB_APP_ID`, `SELFHOST_GITHUB_PRIVATE_KEY` (or
`SELFHOST_GITHUB_PRIVATE_KEY_FILE`) and `SELFHOST_GITHUB_WEBHOOK_SECRET` are all set; a partial
setup is reported at start by variable name. It needs no bearer token: the request must carry
`X-Hub-Signature-256` for its exact body under the webhook secret (checked by
`@octokit/webhooks`), else 401. Bodies up to 25 MB are read, as GitHub sends no more.

- `pull_request` with action `opened`, `reopened`, `synchronize`, `ready_for_review`, or
  `labeled` by a person (the App's own label changes come back as `labeled` by a bot and are
  skipped) on an open pull request that [`@selfhost/attribution`](../../packages/attribution/README.md)
  ties to an agent (attribution lines and session links in the body, an agent account as author,
  an agent branch prefix) is synced. Draft pull requests get labels and the check, and the review
  request once they are ready.
- Each `X-GitHub-Delivery` id is handled once. The id is stored before the sync (table
  `github_deliveries`, migration `0005_github_deliveries.sql`, kept 7 days); the same delivery
  again answers `{ delivery, handled: false, duplicate: true }` without a single GitHub call. A
  sync that fails forgets the id and answers 500, so GitHub's redelivery runs it again.
- Every other signed delivery (other events, actions, closed pull requests, pull requests by
  people, `ping`) answers 200 with `handled: false` and `skipped`, the reason, which shows in
  the App's delivery log on GitHub.
- Syncs for one pull request run one at a time, so two deliveries never race to create a second
  check run. The sync itself only writes what differs, so a new delivery for an unchanged pull
  request writes nothing.
- The log gets one line per delivery: its id, event, repository, pull request number and how
  many changes were made. Payloads, tokens, the private key and the secret are never logged.

The `[review]` settings come from the stored `selfhost.toml` of the team in
`SELFHOST_GITHUB_TEAM` when that is set and the team has one, else from `SELFHOST_CONFIG`:

```toml
[review]
github_team = "platform-reviewers"   # slug, as in github.com/orgs/<org>/teams/<slug>
block_merge_on_high = false          # true: the check fails on high risk

[review.github_logins]               # person id (as in [review.owners]) = GitHub login
"bob@example.com" = "bob"
```

The owner gets the request when they have a login and did not open the pull request themselves;
otherwise the team does, and with no team nobody is asked and the check says why. The check
names GitHub accounts only, never person ids.

**Blocking merges is opt in.** The check's conclusion is `neutral` (which passes a required
check) unless the risk is high and `block_merge_on_high = true`, which makes it `failure`. Even
then it blocks a merge only when the team adds `selfhost/review` as a required status check in
branch protection or a ruleset (Settings, Branches or Rules, "Require status checks to pass",
search for `selfhost/review` once it has run on a pull request).

Where each part comes from is a provider in `src/github-pull.ts`, so other parts of the review
list plug in without touching the route:

| Provider | Default                                                                                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `risk`   | The ee/ risk score (`src/github-risk.ts`, loaded through `src/ee.ts` on first use) from the pull request's files and new dependencies; none when ee/ is left out |
| `owner`  | None, so the request goes to `[review] github_team`; the review list's routing replaces it                                                                       |
| `brief`  | None, so no comment and the check names the agent; the review brief renderer replaces it                                                                         |

On the server the risk score reads the files, the manifests and the agent from GitHub; the agent
run, tests and revert history are listed as missing inputs in the check.

### Registering the App

1. Create a GitHub App (organization settings, Developer settings, GitHub Apps). Webhook URL:
   `https://<server>/v1/github/webhooks`. Webhook secret: a random value, for example
   `openssl rand -hex 32`.
2. Repository permissions: Checks read and write, Pull requests read and write, Issues read and
   write (labels and comments on pull requests), Contents read-only (changed manifests for the
   risk score), Metadata read-only.
3. Subscribe to the **Pull request** event.
4. Generate a private key, and set `SELFHOST_GITHUB_APP_ID`, `SELFHOST_GITHUB_PRIVATE_KEY_FILE`
   (or `SELFHOST_GITHUB_PRIVATE_KEY`) and `SELFHOST_GITHUB_WEBHOOK_SECRET` on the server, plus
   `SELFHOST_GITHUB_TEAM` on a team server.
5. Install the App on the repositories, and add `[review] github_logins` and `github_team` to
   `selfhost.toml`. The team to request must have access to the repository.

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

With default settings the server opens no outbound connection and sends no telemetry (a
configured GitHub App calls the GitHub API, and only while handling a signed delivery);
`test/privacy.test.ts` ingests fixture events, OTLP and team writes with every outbound path
stubbed to fail, then reads every table to check that no planted secret was stored.

```sh
pnpm --filter @selfhost/server dev     # watch mode on http://127.0.0.1:4400
pnpm --filter @selfhost/server build   # bundles to dist/main.js
pnpm --filter @selfhost/server start   # runs the build
```

Environment:

| Variable                           | Default            | Meaning                                                                                           |
| ---------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------- |
| `PORT`                             | `4400`             | Port to listen on.                                                                                |
| `HOST`                             | `127.0.0.1`        | Address to bind.                                                                                  |
| `DATABASE_URL`                     | unset              | `postgres://` URL. Unset uses the embedded database.                                              |
| `SELFHOST_DATA_DIR`                | `~/.selfhost/data` | Embedded database and token file.                                                                 |
| `SELFHOST_TOKEN`                   | unset              | API token. Unset uses or creates `<data dir>/token`.                                              |
| `SELFHOST_CONFIG`                  | unset              | `selfhost.toml` with the defaults for events with no team policy: `[ledger]` and `[[redaction]]`. |
| `SELFHOST_RETENTION_SWEEP`         | `daily`            | `off` keeps every event instead of deleting expired ones daily.                                   |
| `SELFHOST_GITHUB_APP_ID`           | unset              | GitHub App id. With the key and secret, turns on `POST /v1/github/webhooks`.                      |
| `SELFHOST_GITHUB_PRIVATE_KEY`      | unset              | The App's private key (PEM, or one line with `\n` escapes).                                       |
| `SELFHOST_GITHUB_PRIVATE_KEY_FILE` | unset              | Path to the App's .pem, instead of `SELFHOST_GITHUB_PRIVATE_KEY`.                                 |
| `SELFHOST_GITHUB_WEBHOOK_SECRET`   | unset              | The App's webhook secret.                                                                         |
| `SELFHOST_GITHUB_TEAM`             | unset              | Team whose stored `selfhost.toml` sets `[review]` for GitHub. Unset uses `SELFHOST_CONFIG`.       |
