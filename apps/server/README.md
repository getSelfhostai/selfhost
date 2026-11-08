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

Every route except `/v1/health`, `/v1/join` and `/v1/github/webhooks` needs
`Authorization: Bearer <token>`. The admin
token is `SELFHOST_TOKEN` when set; otherwise the server generates one on first start, saves it
to `<data dir>/token` with mode 0600 and prints it once.

## Teams

Team mode lets laptops share their usage and read one team policy. The admin token stays the
bootstrap admin; everything else is a token the server issues and keeps only as a sha256 hash:

- `POST /v1/orgs` (admin token): creates an org from `{ name }`. Every team is in one org;
  teams created without `org` go in `default`, which is where existing teams went on upgrade.
- `POST /v1/teams` (admin token): creates a team from `{ name, org?, invite_ttl_seconds? }`
  (its id is the name in kebab case) and returns an invite code and when it expires. Anyone
  holding the invite can join until then. The first person to join is the team's owner.
- `POST /v1/teams/{team}/invites` (owner or admin): another invite from
  `{ ttl_seconds?, email? }`. Invites expire after 7 days unless `ttl_seconds` says otherwise
  (60 seconds to 365 days). An invite with an email joins only that person, and their person id
  is the email, so whoever holds it cannot join as someone else.
- `DELETE /v1/invites/{id}` (owner or admin of the invite's team): revokes an invite. `id` is
  the sha256 of the code in hex, returned when the invite is created, so the code itself never
  goes in a URL.
- `POST /v1/join` (no bearer token, the invite is the credential): exchanges
  `{ invite, person, name? }` for a person token. `person` is who the laptop's events belong
  to, such as a git email. The first person in a team becomes its owner, the rest members.
  A team-wide invite only adds people new to the org: a person id already in any team of the
  org (revoked people too, compared ignoring case) is refused, so holding it never gives
  someone else's identity or role. A second machine for the same person needs an invite for
  their email, which adds another token for them. An unknown, expired or revoked invite, one
  for another email, or a team-wide invite for an existing person answers 401 `invalid_invite`.
- `DELETE /v1/teams/{team}/people/{person}/tokens` (owner or admin; an owner's tokens need an
  owner; anyone for themselves): revokes every token the person holds and the open invites for
  their email. Their events stay.
- `GET /v1/teams/{team}/people` (anyone in the team): everyone and their role, owners first.
  `POST` (owner or admin) adds `{ person, role? }`, someone already in another team of the org;
  adding an admin or owner needs an owner. Their tokens work in this team from then on.
- `PUT /v1/teams/{team}/people/{person}/role` (owner): `{ role }`. Every person has exactly
  one role per team, and a change that would leave the team with no owner answers 409
  `last_owner`.
- `PATCH /v1/teams/{team}` (owner or admin): renames the team.
- `DELETE /v1/me/token` (person token): revokes the token making the request. `selfhost team
  leave` calls it.
- `GET /v1/me`: `{ kind: "admin", allowed }`, or the person and team the token belongs to with
  their `role`, the `allowed` actions of that role and their `memberships` in the org.
- `GET /v1/policy` (anyone in the team): the policy in use, the parsed config and the rules
  after team overrides (`[teams.<team id>]` and teams that list the person as a member). It is
  the org floor, then the team's `selfhost.toml`, then with `?repo=` the repo's own rules;
  `layers` says which, and with one layer `text` is that file as it was set. A person token
  reads its own team by default; the admin token passes `?team=`.
- `PUT /v1/policy` (owner or admin): replaces the team's `selfhost.toml`, or with `?repo=` a
  repo's own rules, after validating it like `selfhost doctor` and against the org floor. A
  field that would relax an org rule answers 400 `invalid_policy` with the field, the line and
  the org rule in `org_rule`.
- `GET /v1/orgs/{org}/policy` (anyone in the org) and `PUT` (admin token): the org floor. The
  answer lists `conflicts`: stored team and repo rules that relax it, which get the org's value
  until they change.
- `GET /v1/teams/{team}/repos` (anyone in the team), `POST` (owner or admin) with `{ remote }`
  (a remote URL or `owner/name`) and `DELETE /v1/teams/{team}/repos/{owner}/{name}`: the repos a
  team owns, one team per repo in an org (409 `repo_taken`).
- `GET /v1/teams/{team}/overview?from&to` (anyone in the team): spend (totals, by person, agent
  and model), this month against `[budget] monthly_usd` of the team's file, people, repos and
  open review items. `GET /v1/budget?team&person&period` answers `BudgetResponse` for the day,
  week or month, as the MCP tool `get_budget` does.
- `GET /v1/orgs/{org}/overview?from&to`: the cross-team view, one overview per team the caller
  leads (owner or admin), every team with the admin token, and the org's `[budget]` for
  whoever sees every team. Budgets are shown; nothing is charged back.

Every role check runs here, so the CLI, the console and a direct call get the same answer. A
refused call answers 403 `forbidden` with a message that names what was refused, the roles
that may do it and the caller's own ("Changing roles needs the owner role in team web; you are
an admin there."). The permission table is `ROLE_PERMISSIONS` in
[`@selfhost/schema`](../../packages/schema/README.md#roles).

A person is one id across their org: a person token works in every team of the org its person
is in, under their role there (`?team=` on `/v1/events`, `/v1/review-items` and `/v1/policy`,
and review item actions on any of their teams' items). It gets 403 for teams it is not in and
for the admin token's routes, including `/v1/decisions`. Before its events are written, an
event with no actor gets the person, a person actor must be that person, system actors are
refused, and `team` is set to the person's team; the batch then goes through the ordinary
events route, so validation, atomicity and idempotent ids are the same. The ledger then stores
each event with the team that owns its run: the team owning the event's repo, or the repo an
earlier event of its session named, else the token's team (teams of the token's org only), and
sets the event's `team` to it. So a run in another team's repo is that team's: its people read
it, its review list and routing get its items, and its spend counts there. Spend reads the
same rule when asked, so a run whose repo became known later (a commit found by
`selfhost scan`) moves to the repo's team. The admin token reads everything and can filter with
`?team=`; its events go to a repo's team when exactly one org maps the repo, else no team.

Tables `orgs`, `teams`, `people`, `tokens`, `team_repos` and `run_repos` come from the ledger
package's migrations `0002_teams.sql`, `0003_team_access.sql`, `0006_roles.sql` and
`0007_orgs.sql`, in the same database as the events, and are reached through `ledger.teams` and
`ledger.orgs`.

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

Where each part comes from is a provider in `src/github-pull.ts` (tests replace them):

| Provider | Default                                                                                                                                                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `risk`   | The ee/ risk score (`src/github-risk.ts`, loaded through `src/ee.ts` on first use) from the pull request's files and new dependencies; none when ee/ is left out                                                                                                                     |
| `owner`  | `src/github-review.ts`: the first owner of the pull request's `pr` review item (by PR URL, in `SELFHOST_GITHUB_TEAM`'s items when set); before there is one, `routeItem` on its changed files, the person whose session made its commits, the team's members and `[review] fallback` |
| `brief`  | `src/github-review.ts`: the [review brief](../../packages/brief/README.md) as one comment, its summary leading the check run, ending with the newest proof receipt (see below) when CI posted one                                                                                    |

The server has no clone and no `gh`, so the brief reads the pull request through the App with
`readPullRequest` from [`@selfhost/pr`](../../packages/pr/README.md): the files with their
patches (hunks and line numbers), the manifests at the base and head commits, the title and
description from the webhook, and the commits, whose `commit.created` events in the ledger join
the sessions behind them. Per delivery that is one paginated call for the files, one for the
commits, and one contents call per changed manifest at each side; the risk score, the owner and
the brief share them (`src/github-reads.ts`), so each is made once. A pull request no session
made still gets a brief, with every run section saying no run was found and why. Trace links
point at `<SELFHOST_PUBLIC_URL>/v1/events?session=<id>`, or at the origin the delivery was sent
to when that is unset. The risk score does not read the run yet: the agent run, tests and revert
history are listed as missing inputs in the check.

### Proof receipts

`POST /v1/receipts` takes the proof receipt the receipt action ([`ee/receipt`](../../ee/receipt/README.md),
commercial) makes in a repository's own CI: the tests the pull request adds or changes and their
results, Playwright screenshots of the screens it touches, its preview link, and the logs of
what failed. The server stores it (table `receipts`, migration `0008_receipts.sql`), posts it on
the pull request as one comment (marker `<!-- selfhost:receipt v1 -->`, edited in place by the
next CI run), and syncs the pull request so the review brief ends with a `Proof receipt` section:
the receipt's headline and links to the comment, the preview, the screenshots and the CI run. The
check run's summary gets the headline too. `GET /v1/receipts/{id}` (admin token) returns a stored
receipt.

The POST needs no selfhost token and no secret in the repository. Its bearer is the job's
**GitHub Actions OIDC token** (`permissions: id-token: write`) with this server's URL as audience
(`SELFHOST_PUBLIC_URL`, else the origin the request was sent to). The server checks GitHub's
signature against the issuer's published keys, the issuer, the audience and the expiry, then:

- the receipt's repository must be the token's `repository` claim, and on a `pull_request` run
  (`ref` = `refs/pull/<n>/merge`) its pull request must be `<n>`, else 403;
- the GitHub App must be installed on that repository, else 403 (any repository on GitHub can get
  a token for this audience; only the App's installations are accepted);
- the pull request must exist (404). A receipt for a commit that is no longer the head is stored
  and answered `202` with `brief: "stale"`, and nothing on GitHub changes.

The token proves which repository's workflow sent the receipt, not that the tests in it are
honest: the receipt runs the pull request's own code, as any CI does. It answers 404 without the
GitHub App, or in a build without ee/. A receipt is a few kilobytes (log tails are masked and
capped by the action); bodies over 2 MB are refused. On GitHub Enterprise Server set
`SELFHOST_GITHUB_OIDC_ISSUER` to `https://<host>/_services/token`.

### Registering the App

1. Create a GitHub App (organization settings, Developer settings, GitHub Apps). Webhook URL:
   `https://<server>/v1/github/webhooks`. Webhook secret: a random value, for example
   `openssl rand -hex 32`.
2. Repository permissions: Checks read and write, Pull requests read and write, Issues read and
   write (labels and comments on pull requests), Contents read-only (changed manifests for the
   risk score and the brief), Metadata read-only. Proof receipts need nothing more.
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

On start and then every 15 seconds the server refreshes the review list: new signals become
items, PRs that merged or closed and waits the session moved on from are closed, decisions
recorded on other paths are applied, last week's would-block report is filed, and blocking
approvals past their deadline are denied in the decision log. Items from a team's events use the
team's stored `selfhost.toml`, others `SELFHOST_CONFIG`. `SELFHOST_REVIEW_REFRESH=off` turns
that off, for a second server on the same database.

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

| Variable                           | Default            | Meaning                                                                                                             |
| ---------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `PORT`                             | `4400`             | Port to listen on.                                                                                                  |
| `HOST`                             | `127.0.0.1`        | Address to bind.                                                                                                    |
| `DATABASE_URL`                     | unset              | `postgres://` URL. Unset uses the embedded database.                                                                |
| `SELFHOST_DATA_DIR`                | `~/.selfhost/data` | Embedded database and token file.                                                                                   |
| `SELFHOST_TOKEN`                   | unset              | API token. Unset uses or creates `<data dir>/token`.                                                                |
| `SELFHOST_CONFIG`                  | unset              | `selfhost.toml` with the defaults for events with no team policy: `[ledger]`, `[[redaction]]`, `[review]`.          |
| `SELFHOST_RETENTION_SWEEP`         | `daily`            | `off` keeps every event instead of deleting expired ones daily.                                                     |
| `SELFHOST_REVIEW_REFRESH`          | `15s`              | `off` stops building review items and timing out approvals on this server.                                          |
| `SELFHOST_GITHUB_APP_ID`           | unset              | GitHub App id. With the key and secret, turns on `POST /v1/github/webhooks`.                                        |
| `SELFHOST_GITHUB_PRIVATE_KEY`      | unset              | The App's private key (PEM, or one line with `\n` escapes).                                                         |
| `SELFHOST_GITHUB_PRIVATE_KEY_FILE` | unset              | Path to the App's .pem, instead of `SELFHOST_GITHUB_PRIVATE_KEY`.                                                   |
| `SELFHOST_GITHUB_WEBHOOK_SECRET`   | unset              | The App's webhook secret.                                                                                           |
| `SELFHOST_GITHUB_TEAM`             | unset              | Team whose stored `selfhost.toml` sets `[review]` for GitHub, and whose review items pick the owner.                |
| `SELFHOST_PUBLIC_URL`              | unset              | This server's URL as people reach it, for brief links and the receipts' OIDC audience. Unset: the request's origin. |
| `SELFHOST_GITHUB_OIDC_ISSUER`      | GitHub's           | Issuer of the CI OIDC tokens `POST /v1/receipts` accepts; set it on GitHub Enterprise Server.                       |
