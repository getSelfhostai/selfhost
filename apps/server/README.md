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
  `by` is required; a person token acts as its own person. A one-time exception (`kind:
  exception`) goes to the team's owners and admins; approving one needs that role, and the person
  whose agent was blocked (`requested_by`) cannot approve their own unless the team's
  `selfhost.toml` sets `[review] self_approve_exceptions = true`. Both answer 403; denying is
  always allowed. Answering a context proposal needs the owner or admin role too. The same rule
  holds for `decision.recorded` events a laptop syncs through `POST /v1/events` (a person token's
  decision must name its own person in `decision.by`, or the batch is refused) and for the MCP
  `record_decision` tool: the review list does not apply a decision it would refuse here, and logs
  it.
- `GET /v1/decisions`: `decision.recorded` and `policy.evaluated` events, newest first, by
  `path` (a file, the files under a folder, the folders that hold it), `topic` (every word in
  the question or reason), `text`, `rule_id`, `verdict`, `repo`, `target`, `person`,
  `item_id`, `team`, `from` and `to`. `format=text` returns the plain text the CLI and the MCP
  tool print: each decision's id, who, verdict, reason and links.
- `POST /v1/mcp`: the agent MCP server ([`packages/mcp`](../../packages/mcp/README.md)) over
  Streamable HTTP, stateless with JSON responses, for person tokens only (the admin token gets
  403). Every tool acts as the token's person in the teams of their org they are in: a team,
  repo or item outside them answers a `forbidden` tool error with no data. `get_policy` and
  `get_budget` answer exactly as `GET /v1/policy` and `/v1/budget` do for the token. GET and
  DELETE answer 405.

- `GET /v1/usage`: tokens, cost, sessions and pull requests opened and merged, grouped by one or
  two of `team`, `person`, `agent`, `model` and `day` (`group_by=person`, `group_by=day,model`),
  with filters `team`, `person`, `agent`, `model` (`unknown` matches events with none), `from`
  and `to` (default: the 30 days before now) applied to every row and to the total. `GET
  /v1/usage.csv` returns the same rows as CSV. See [Usage](#usage).

The server also serves the web console ([`apps/console`](../console/README.md)) at `/` and every
other path outside `/v1`, with no token: the pages hold no data, and what they show comes from
`/v1` with the reader's own token. See [Console](#console).

Every route except `/v1/health`, `/v1/join` and `/v1/github/webhooks` needs
`Authorization: Bearer <token>`. The admin
token is `SELFHOST_TOKEN` when set; otherwise the server generates one on first start, saves it
to `<data dir>/token` with mode 0600 and prints it once.

On start the server applies pending ledger migrations, in one transaction, before it listens. A
database with a migration it does not know (a newer release applied it) stops it with `The
database schema is newer than this release`, before it changes anything. `node dist/migrate.js`
runs the migrations alone: with no argument it applies pending ones, `--to <version>` moves the
schema to that version (down with each newer migration's rollback, or up), and `--status`
prints where the schema is as JSON. The Docker Compose `upgrade.sh` runs it before it switches
releases ([`deploy/docker`](../../deploy/docker/README.md#upgrade-and-roll-back)).

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
- `GET /v1/teams/{team}/invites` (owner or admin): the invites that still work, newest first,
  by id and email. The codes themselves are never shown again.
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
  owner; anyone for themselves): revokes the person's membership of the team, every token they
  hold for it and the open invites for their email. Their events stay.
- `GET /v1/teams/{team}/people` (anyone in the team): everyone and their role, owners first.
  `POST` (owner or admin) adds `{ person, role? }`, someone in another team of the org (and not
  revoked there); adding an admin or owner needs an owner. Their tokens work in this team from
  then on. Someone revoked from the team comes back this way, or with an invite for their email,
  with the role given then.

- `GET /v1/teams/{team}/laptops[?silent_days=7]` (anyone in the team): laptop coverage from the
  ledger's heartbeats (`config.reported` events a laptop sends on join and sync). For each
  laptop, its newest heartbeat: person, host name, platform, CLI version, the policy hash it runs
  and its managed files' state, flagged `silent` (nothing in `silent_days`), `behind` (another
  hash than the team's policy now) or `not_installed` (managed files pending or turned off),
  flagged ones first. `people_without_heartbeat` lists the team's people no laptop reported for.
- `PUT /v1/teams/{team}/people/{person}/role` (owner): `{ role }`. Every person has exactly
  one role per team, and a change that would leave the team with no owner answers 409
  `last_owner`.
- `PATCH /v1/teams/{team}` (owner or admin): renames the team.
- `DELETE /v1/me/token` (person token): revokes the token making the request. `selfhost team
  leave` calls it. When it was the person's last token for the team, their membership there
  ends too.
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
- `GET /v1/policy/observed` (anyone in the team): what each rule and guardrail would have
  blocked or asked in observe mode, and blocked or asked in enforce mode, from the team's
  `policy.evaluated` events, by default over the last 7 days (`?from=`, `?to=`), with each rule's
  mode now and likely false positives marked like the weekly policy report.
- `GET /v1/context` (anyone in the team) and `PUT` (owner or admin): the org and team context
  layers, the `.selfhost/context` items every member's laptop pulls on sync and merges with the
  repository's own and the person's (org first; the earlier layer's item wins a conflict). `PUT`
  takes `{ files }` (`{ path, text, executable? }` in the `.selfhost/context` layout) and
  validates them like `selfhost context compile`; an invalid layer answers 400 `invalid_context`.
  The answer lists `conflicts` (team items the org layer replaces) and the team's newest
  `proposals`. `GET` and `PUT /v1/orgs/{org}/context` read and set the org layer (`PUT`: admin
  token only).
- `POST /v1/context/proposals` (a person token in the team): `{ item, files, team? }` proposes one
  of the person's own items to the team. It is stored in `context_proposals` and opens a
  `context_promotion` review item with the same id (409 `item_exists` when the org or team
  layer has the item). Only an owner or admin answers that item (`POST
  /v1/review-items/{id}/decision` answers 403 to anyone else, and agents cannot answer it over
  MCP); the next read of the team's context adds an approved item to the team layer. An item
  denied, replaced by a newer proposal, expired, or approved by someone without the role (the
  admin token naming a member in `by`) is marked refused with the reason.
- `GET /v1/orgs/{org}/policy` (anyone in the org) and `PUT` (admin token): the org floor. The
  answer lists `conflicts`: stored team and repo rules that relax it, which get the org's value
  until they change.
- `GET /v1/teams/{team}/repos` (anyone in the team), `POST` (owner or admin) with `{ remote }`
  (a remote URL or `owner/name`) and `DELETE /v1/teams/{team}/repos/{owner}/{name}`: the repos a
  team owns, one team per repo in an org (409 `repo_taken`).
- `GET /v1/teams/{team}/overview?from&to` (anyone in the team): spend (totals, by person, agent
  and model), this month against `[budget] monthly_usd` of the team's file, people, repos and
  open review items. `GET /v1/budget?team&person&period` answers `BudgetResponse` for the day,
  week or month, as the MCP tool `get_budget` does: with `person`, against their
  `[budget.person]` limit. Its `budgets` lists every budget that applies to the caller in every
  period that has one: their own `[budget.person]` (a person token's, or the person asked
  about), the team's `[budget]` and the org's, each `enforcement: "gateway"` (mode hard, held by
  the gateway, counted with the gateway's own spend when it answers) or `"alert"`, with
  `cut_off: true` while the gateway refuses the requests and `raise` naming who can raise it.
  The org's spend shows only to whoever sees every team. A `PUT /v1/policy` (team or repo),
  `PUT /v1/orgs/{org}/policy` or a router change in `PUT /v1/teams/{team}/integrations/{kind}`
  pushes budgets and providers to the gateway at once; the five-minute sync stays as well. The review refresh job also checks each
  team's spend against its `[budget]` once a minute and raises an `alert.raised` at 50%, 80% and
  100% of each period's budget, once per window, which the review list files as budget items;
  requests go on (only a gateway with `[budget] mode = "hard"` stops them).
- `GET /v1/teams/{team}/provenance?from&to&repo` (anyone in the team): for each repo the team
  owns, lines merged to the main branch by agent, model, person and module, and how many were
  reverted or reworked within `[review] revert_window_days`, computed on read by
  [`@selfhost/provenance`](../../packages/provenance/README.md) from the server's clone of the
  repo (`SELFHOST_GIT_CLONES`, never fetched by the server: keep it current with `git fetch` on
  a timer) and the team's `commit.created` and `pr.merged` events. A repo
  with no clone is `ledger_only`: lines from its merged pull requests, no modules, no rates.
  `GET /v1/teams/{team}/provenance/modules` ranks the team's modules across its repos by
  agent-written lines and marks those above `[review] revert_rate_threshold`. The default range
  is the 30 days up to the next full hour; reports are cached in memory by clone, range,
  settings and ledger inputs.
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
event with no actor gets the person, a person actor must be that person, and `team` is set
to the person's team. A system actor is accepted only on what a laptop writes itself and its
sync forwards: rule verdicts of the pre-tool hook and `selfhost policy observe`
(`policy.evaluated` by `selfhost-policy`, source `hook` or `cli`, never a person's verdict) and
the CLI's alerts (`alert.raised` by `selfhost`, source `cli`), each stamped with
`data.sent_by` set to the token's person. Every other system actor is refused, so a person
token speaks neither for another person nor for the server; the batch then goes through the ordinary
events route, so validation, atomicity and idempotent ids are the same. The ledger then stores
each event with the team that owns its run: the team owning the event's repo, or the repo an
earlier event of its session named, else the token's team (teams of the token's org only), and
sets the event's `team` to it. So a run in another team's repo is that team's: its people read
it, its review list and routing get its items, and its spend counts there. Spend reads the
same rule when asked, so a run whose repo became known later (a commit found by
`selfhost scan`) moves to the repo's team. The admin token reads everything and can filter with
`?team=`; its events go to a repo's team when exactly one org maps the repo, else no team.

A person token acts only in the teams where its person's membership is active. Revoking someone
from a team (or `selfhost team leave` with their last token for it) ends that membership: the
tokens they hold for other teams of the org no longer read or write it, their events naming its
repos stay in their own team, routing and notifications stop naming them for its items, they
cannot answer, hand off, be handed or take over its runs, start its background runs (also from
GitHub comments and webhooks, whatever `[background] allowed` lists) or get a gateway key for
it. Upgrading to this release ends the membership of anyone who joined a team and holds no live
token for it any more; people added from another team keep theirs.

Tables `orgs`, `teams`, `people`, `tokens`, `team_repos` and `run_repos` come from the ledger
package's migrations `0002_teams.sql`, `0003_team_access.sql`, `0006_roles.sql`,
`0007_orgs.sql` and `0015_membership_revocation.sql` and context layers and proposals from `0010_context_layers.sql`, in the same database as the events, and are reached through `ledger.teams` and
`ledger.orgs`.

No model traffic passes through this server. It has no route that forwards requests to Anthropic,
OpenAI or any other provider, and serving a request opens no connection other than to its own
database (and, for a signed GitHub App delivery, to the GitHub API; `GET /v1/integrations` also calls
the tools the team picked, to check them, see [Integrations](#integrations)): agents keep calling their vendors directly under each developer's own login, and
selfhost never asks for or stores those logins or provider keys. `test/teams.test.ts` checks that vendor API paths are not served and that
serving team requests opens no connection.

## Usage

`GET /v1/usage` reads the ledger's events with one SQL query per view, on Postgres or the
embedded database alone, whatever source wrote them: OpenTelemetry, local logs, hooks, the
gateway and vendor admin data all land as the same event kinds, so nothing here knows about
sources.

- Spend (`usd`, the four token counts and `tokens`, `requests`) adds up `cost.recorded` events,
  as `selfhost spend`, the team overview, `GET /v1/budget` and ROI count them, so a team's total
  equals its overview's spend. A request that went through the gateway counts once, as the
  gateway's event, in the session of its copy from the session log, OpenTelemetry or a hook
  (joined on person, prompt and output tokens, at most 10 minutes apart). For the rest, a session (agent
  and `session_id`) that more than one source reports counts the events of one, in the order
  `otel`, `local_log`, `hook`, `gateway`, `vendor_api`. See "Where spend comes from" in
  [`packages/spend`](../../packages/spend/README.md).
- `sessions` counts distinct sessions with a `session.started`, `session.ended`,
  `prompt.submitted` or `cost.recorded` event in the range. A session counts once in every row
  its events fall in (a session over midnight is in two days) and once in the total, so rows
  can add up to more than the total. Hook events name no model, so they do not put a session in
  the `unknown` model when its other events name one.
- `prs_opened` and `prs_merged` count distinct pull request URLs of `pr.opened` and `pr.merged`
  events in the range, so a pull request a scan and the webhook both report counts once. Their
  agent and model are the attribution from [`packages/attribution`](../../packages/attribution).
- An event's team is the team that owns its repo (or its run's repo) in the org, else the team
  of the person token that wrote it, read now, as the overview reads it. `org` picks the org
  (default: the person token's, or `default` with the admin token).

Who sees what follows the roles: a person token sees every team of its org it is in (what each
team's overview already shows them), and a `team` filter for another team answers 403. The admin
token sees every team of the org and the events with no team, such as a laptop's. The CSV has
a header line with the grouped dimensions and the metrics, then one line per row of the JSON
view; text a spreadsheet would run as a formula starts with an apostrophe.

`test/usage.test.ts` seeds a ledger and checks every grouping under every filter, the totals
and the CSV against SQL written directly on the events table, on PGlite and on Postgres when
`DATABASE_URL` is set.

## Integrations

selfhost does not rebuild the tools a team already likes. Each team picks one tool per job in
`[integrations]` of its `selfhost.toml`, and the server checks that each one answers and that its
key works ([`packages/integrations`](../../packages/integrations) lists every tool and its
check):

| Job        | Tools                                          |
| ---------- | ---------------------------------------------- |
| `router`   | `bifrost` (bundled), `litellm`                 |
| `tracer`   | `langfuse`, `phoenix`, `datadog`, `otlp`       |
| `runtime`  | `e2b`, `daytona`, `modal`, `coder`             |
| `reviewer` | `pr-agent`, `claude-code-action`, `coderabbit` |

`GET /v1/integrations` (anyone in the team; `team` with the admin token) answers:

```json
{
  "schema": "selfhost.integrations/v1",
  "team": "web",
  "integrations": {
    "router": {
      "tool": "bifrost",
      "status": "connected",
      "detail": "Bifrost at http://bifrost:8080 is up, with admin sign-in off.",
      "settings": {}
    },
    "tracer": {
      "tool": null,
      "status": "not_configured",
      "detail": "No tracer picked. ...",
      "settings": {}
    },
    "runtime": {
      "tool": "e2b",
      "status": "error",
      "detail": "Set the environment variable E2B_API_KEY (api_key_env) where selfhost runs, to an E2B API key. It is not set.",
      "settings": {}
    },
    "reviewer": {
      "tool": "claude-code-action",
      "status": "connected",
      "detail": "The Claude Code GitHub Action runs from .github/workflows/claude.yml in acme/api.",
      "settings": {}
    }
  }
}
```

`status` is `connected`, `not_configured` (no tool picked) or `error`, and `detail` says what to
fix. `settings` is the rest of the table: secrets are only ever named by environment variable,
and the variables are read on this server. Every GET checks again; each call times out after 5
seconds and the four jobs are checked at once.

`PUT /v1/integrations/{kind}` with `{ "tool": "litellm", "settings": { "url": "http://litellm:4000",
"admin_key_env": "LITELLM_MASTER_KEY" } }` picks a tool (owners and admins; a member gets 403).
It replaces the `[integrations.<kind>]` table in the team's own `selfhost.toml` and leaves every
other line as it was, then validates the file like `PUT /v1/policy`, against the org floor too.
`"tool": null` removes the table. It answers with the same body as the GET. A table written
inline (`router = { tool = "bifrost" }`) answers 409; change it with `PUT /v1/policy` instead.

The org's `selfhost.toml` can pick tools for every team. A team's own table for a job replaces
the org's whole, so picking another tool never mixes in the org tool's settings; the org floor
never refuses an `[integrations]` change.

Reviewer checks read the team's repositories through the GitHub App: the workflow files
(Contents read) for PR-Agent and the Claude Code action, and for CodeRabbit the org's GitHub
Apps (only with Administration read) or `coderabbitai[bot]` comments on recent pull requests
(Issues read). Without the App they say so.

The checks only test the connection. Model traffic through the router and trace export to the
tracer are set up by the gateway sync and the trace export.

## Console

The built console is found in `SELFHOST_CONSOLE_DIR`, else `console/` beside the server bundle
(`pnpm build` and the Docker image copy `apps/console/dist` there), else `apps/console/dist` in
a checkout. Without one `/` says the console is not built; `SELFHOST_CONSOLE=off` serves `/v1`
only. Its pages are sent with a content security policy that allows only the console's own
scripts and requests to this server.

How people sign in to it:

- **On a laptop**, `selfhost console` starts this server on the local ledger at
  `http://127.0.0.1:4400/` and opens `/#token=<admin token>`. The console keeps the token in the
  browser's localStorage and takes it out of the address bar; a fragment is never sent to a
  server. Nothing else is needed on localhost.
- **On a team server**, each person runs `selfhost console` on a laptop that joined the team
  with `selfhost join <server> <invite>`: it opens `<server>/#token=<person token>`, the same
  fragment sign-in, and they see what their token reads. The admin token can be pasted on the
  sign-in page. The console's invite box shows the whole `selfhost join <server> <invite>` line.
- **With a sign-in proxy** (`compose.signin.yml`, see
  [`deploy/docker`](../../deploy/docker/README.md)), no token is needed: set
  `SELFHOST_SIGNIN_PROXY_SECRET` (32 characters or more) on the server and have the proxy send
  it in `X-Selfhost-Proxy-Secret` with the signed-in email in `X-Selfhost-Email`. Only then, and
  only for GET requests under `/v1` with no bearer token, does the server read as the person
  whose id is that email (ignoring case) and who still holds a person token; anyone else gets
  403. Person ids are unique within an org only, so an email in teams of several orgs reads as
  its person in `SELFHOST_SIGNIN_ORG` when that is set, else in the org it joined first. The
  proxy must drop both headers from what clients send. Writes always need a token.

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
  `[review] github_logins`, plus the GitHub users and teams its `[[review.routes]]` entry names
  (`@login`, `@org/team`, and `codeowners`, read from CODEOWNERS at the base commit), else to
  the team in `[review] github_team`;
- the review brief as one comment, edited in place on later deliveries;
- under `[review.auto_approve]` (commercial, ee/risk), an approving review from the App (see
  below).

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
- `pull_request_review`, `issue_comment` and `check_run` deliveries that carry a verdict from
  the team's AI reviewer on an agent pull request are its **second opinion** (see below).
- `check_suite` with action `completed` syncs the open agent pull requests the suite ran on
  again, so auto-approve sees checks that finished. While `[review.auto_approve]` is off it
  answers `handled: false` without a GitHub call.
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

| Provider      | Default                                                                                                                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `risk`        | The ee/ risk score (`src/github-risk.ts`, loaded through `src/ee.ts` on first use) from the pull request's files and new dependencies; none when ee/ is left out                                                                                                                     |
| `owner`       | `src/github-review.ts`: the first owner of the pull request's `pr` review item (by PR URL, in `SELFHOST_GITHUB_TEAM`'s items when set); before there is one, `routeItem` on its changed files, the person whose session made its commits, the team's members and `[review] fallback` |
| `route`       | `src/github-review.ts`: the GitHub accounts the pull request's route names; nothing is read without `[[review.routes]]`                                                                                                                                                              |
| `autoApprove` | `src/github-approve.ts`: the `[review.auto_approve]` verdict from ee/risk; nothing is read while it is off                                                                                                                                                                           |
| `brief`       | `src/github-review.ts`: the [review brief](../../packages/brief/README.md) as one comment, its summary leading the check run, ending with the newest proof receipt (see below) when CI posted one                                                                                    |

The server has no clone and no `gh`, so the brief reads the pull request through the App with
`readPullRequest` from [`@selfhost/pr`](../../packages/pr/README.md): the files with their
patches (hunks and line numbers), the manifests at the base and head commits, the title and
description from the webhook, and the commits, whose `commit.created` events in the ledger join
the sessions behind them. Per delivery that is one paginated call for the files, one for the
commits, and one contents call per changed manifest at each side; the risk score, the owner and
the brief share them (`src/github-reads.ts`), so each is made once. A pull request no session
made still gets a brief, with every run section saying no run was found and why. Trace links
point at the console's run view, `<SELFHOST_PUBLIC_URL>/?screen=run&run=<id>` (or the origin the delivery
was sent to when that is unset), and at the run in the team's tracer when `[integrations.tracer]`
has a `run_url`. The risk score does not read the run yet: the agent run, tests and revert
history are listed as missing inputs in the check. It does read the second opinion: the newest
`review.submitted` verdict of each reviewer on the pull request, listed as missing until the
reviewer in `[integrations.reviewer]` has reviewed.

### Second opinions from the team's AI reviewer

selfhost reviews nothing itself. The team runs an existing reviewer (PR-Agent, the Claude Code
GitHub Action or CodeRabbit, wired with `selfhost review setup`, see
[`@selfhost/integrations`](../../packages/integrations/README.md#reviewers-second-opinions)), and
the App reads what it posts back:

| Reviewer           | Delivery                                                  | Verdict                                                                                                                                  |
| ------------------ | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| PR-Agent           | `issue_comment` created or edited, by a bot               | Its `/review` comment: merge recommendation, focus-area findings plus a security concern, risk level as the severity                     |
| Claude Code action | `issue_comment` (or a review) by a bot                    | The `<!-- selfhost:second-opinion ... -->` line the workflow tells it to end its summary with                                            |
| CodeRabbit         | `pull_request_review` submitted by `coderabbitai[bot]`    | The review state; actionable plus outside-diff comments as findings; severity from its labels, reading the review's inline comments once |
| Any of the CI ones | `check_run` completed with a failure, job name from setup | `failed`: the reviewer did not get to a review                                                                                           |

Each verdict on a pull request an agent opened (read through the App when the payload has no
branch) is written once as a `review.submitted` ledger event, `data.second_opinion` holding
the tool, reviewer login, verdict (`approve`, `changes`, `comment`, `failed`), findings,
severity, link and reviewed commit. Its id comes from the repository and GitHub's id for the
review or comment (with its edit time), so redeliveries add nothing and every new PR-Agent review
of its one comment does. The pull request is then synced again, so the risk check counts the
second opinion as an input. The review list attaches the newest verdict from each tool to the
pull request's item on its next refresh, and `GET /v1/runs/{id}` returns them on each pull
request (`second_opinions`). Comments and reviews by people, the placeholder PR-Agent posts
before reviewing, and this App's own check runs are skipped. No migration: the events table
takes the new kind as it is.

### Auto-approve

`[review.auto_approve]` lets the App approve agent pull requests nobody needs to read. It is off
by default, and turning it on starts in dry run:

```toml
[review.auto_approve]
enabled = true                       # default false
dry_run = true                       # default: only record what it would approve
max_risk = 20                        # highest risk score, and the level must be low
allowed_paths = ["docs/**", "**/*.md"] # every changed file must match; high_risk_paths never do
require_green_checks = true          # every other check run and status passed, at least one
require_second_opinion = false       # required anyway once [integrations.reviewer] is set
```

Every check must pass, and a missing input fails its check: not a draft; no open item of the
pull request or its run that an agent waits on, and no open exception; a risk score, low and at
most `max_risk`; only `allowed_paths`, none under `[review] high_risk_paths`; green checks on the
head commit (selfhost's own `selfhost/*` checks left out, a running one waits); an agent run
recorded for its commits with no guardrail or rule hit in it, observed or enforced; and, when
required, a passing second opinion. It makes no model call. The check run's summary says what
it decided and its details list every check.

When eligible and `dry_run = false`, the App posts an approving review on the head commit (body
marked `<!-- selfhost:auto-approve v1 -->`, once per commit; a push needs a new approval) and the
server records a `decision.recorded` event: verdict approve, by `selfhost auto-approve` (a system
actor), surface `auto_approve`, with the reasons, the pull request, the commit and the files,
and answers the pull request's open review item with it. In dry run nothing is approved: an
`alert.raised` event with `data.alert = "auto_approve_dry_run"` records it, once per head commit,
and opens no item. The App needs Pull requests write (as above) and the **Check suite** event.

The second opinion is read from `second_opinion` on the pull request's review item, written by
the reviewer integration's ingest, through `secondOpinionOf` in `src/github-approve.ts`
(`verdict` pass, clean or approve passes; anything else fails).

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
3. Subscribe to the **Pull request** event, to **Check suite** for auto-approve, and for second
   opinions from an AI reviewer to **Pull request review**, **Issue comment** and **Check run**.
4. Generate a private key, and set `SELFHOST_GITHUB_APP_ID`, `SELFHOST_GITHUB_PRIVATE_KEY_FILE`
   (or `SELFHOST_GITHUB_PRIVATE_KEY`) and `SELFHOST_GITHUB_WEBHOOK_SECRET` on the server, plus
   `SELFHOST_GITHUB_TEAM` on a team server.
5. Install the App on the repositories, and add `[review] github_logins` and `github_team` to
   `selfhost.toml`. The team to request must have access to the repository.

## Traces and the run view

selfhost does not keep a trace UI of its own: it sends each agent run to the tracer the team
already uses, named in `[integrations.tracer]` of the team's `selfhost.toml` (else
`SELFHOST_CONFIG`), through [`@selfhost/traces`](../../packages/traces/src/index.ts). Every
minute the server sends the runs that ended (a `session.ended`, or 30 minutes with no event) as
OpenTelemetry spans over OTLP/HTTP protobuf, one trace per run, and marks each run with how far
it was sent, so nothing goes twice and events that arrive later join the same trace. A pass the
tracer refused waits twice as long before the next, up to 30 minutes, and sends those runs again.
Spans carry only what the ledger kept, redacted again under the team's current settings, and
prompt text only with `[ledger] log_prompts` on. `SELFHOST_TRACE_EXPORT=off` turns the job off,
for a second server on the same database.

- `GET /v1/runs/{run_id}?limit&cursor` (anyone in the run's team): `selfhost.run/v1`, the run's
  summary (agent, model, person, team, repo, start and end, cost and tokens, `cache_hit_rate`,
  null when the run reported no cache tokens, and a one-line `cache_tip` when it cost at least
  `[alerts] cache_tip_usd` under `cache_hit_floor`), its ledger events
  oldest first, the pull requests they link to and `trace_url`, the run in the tracer from
  `run_url` (`{run_id}` and `{trace_id}` filled in) once it has been sent. Anyone else gets 403,
  whether or not the run exists. The console's run view, `/?screen=run&run=<id>`, reads it; the
  server redirects the older `/runs/<id>` links there.
- Review items that name a session carry `run_url` (the console's run view) and, once the run is
  in the tracer, `trace_url`.
- `GET /v1/events/tail?after&since&kind&person&agent&repo&session&team&wait&limit` (both kinds of
  token): `selfhost.tail/v1`, the events that reached the ledger after the cursor `after`, oldest
  first, redacted again like the run view, and the next `cursor`. With `wait` (up to 30 seconds)
  the request is held until something lands. A person token reads the teams of its org it is in;
  `team` narrows it, and a team they are not in answers 403. `selfhost tail` in a team follows it.

Every minute the server also looks at the requests of the last hour for sessions past `[alerts]
cache_min_requests` whose prompt cache hit rate over their last 10 requests fell under
`cache_hit_floor`, and records one `alert.raised` (`data.alert: "cache_hit_low"`) per session in
its team, naming the usual causes. `SELFHOST_CACHE_ALERTS=off` turns it off.

## Background runs

A background run hands a task to an agent CLI that already exists (Claude Code headless, Codex
exec, OpenCode, Goose) in a sandbox on the team's runtime; the server orchestrates, records,
guards and gates it through [`@selfhost/background`](../../packages/background/src/index.ts).
Each run: a fresh sandbox, a clone on its own branch, the agent CLI and the selfhost CLI installed
when the image lacks them, the team's hooks written into the agent's own settings (the same
`selfhost hook` and `selfhost.toml` as a laptop), the agent run headless with its output in the
ledger as `run.output`, the hook spool mapped by `selfhost import --hook-events` in the sandbox,
the tests-first gate, a push and one pull request through the GitHub App with the gate as the
`selfhost/tests-first` check, then the sandbox stopped. States: queued, starting, running,
testing, pushing, then succeeded, failed, cancelled, timed_out or stuck. The run record is
`selfhost.background_run/v1` in the `background_runs` table; the ledger gets `run.triggered`,
`run.updated`, `run.output`, `run.health`, `run.gate`, `pr.opened`, and `alert.raised`
(`run_failed`, `run_stuck`) for a run that failed, stuck or timed out, which the review list
turns into a `stuck_run` item for the run's owner; the owner's notification targets get it too.

- `POST /v1/background-runs` (person token, role work): `{ task, repo, agent?, runtime?, base?,
  timeout_minutes?, team?, source? }`, 202 with the run. Refused (and recorded) when the person
  is not in the team (revoked people included) or not on `[background] allowed`, a kill switch is on (409), the team is
  over `rate_limit_per_hour` or `max_concurrent` (429), or no runtime is set up (503).
- `GET /v1/background-runs?team&state&limit` and `GET /v1/background-runs/{id}`: runs with their
  health line and live cost (sandbox time plus the run's `cost.recorded` events).
- `POST /v1/background-runs/{id}/cancel`; `POST /v1/background-runs/kill` `{ scope: team|org,
  target, reason? }` stops every run in scope and refuses new ones; `DELETE
  /v1/background-runs/kill?scope&target` clears it. Who used each switch is kept.
- `POST /v1/background-runs/webhook`: a run from a signed webhook, `X-Selfhost-Signature-256:
  sha256=<HMAC of "<timestamp>.<delivery>.<body>">` under the secret in the variable
  `[background] webhook_secret_env` names, with `X-Selfhost-Timestamp` (Unix seconds, within 5
  minutes of the server's clock) and `X-Selfhost-Delivery` (a new id per request, taken once), so
  a captured request cannot be sent again. The sender must be on `[background] webhook_senders`:
  the secret speaks only for those people. The Slack and Telegram bridges in
  [`examples/run-triggers`](../../examples/run-triggers) post here; they are not part of the
  server.
- GitHub: a `/selfhost run [--agent codex] <task>` comment on an issue or pull request, or the
  `[background] github_label` on an issue, starts a run for the sender, mapped to a person
  through `[review] github_logins`; the App answers on the issue either way.
- Schedules: `[[background.schedules]]` (cron in UTC) start runs with the team's key, once per
  due minute. `SELFHOST_SCHEDULES=off` turns the job off on a second server.

The runtime plugs in from outside (`createBackground({ runtime })`, runtime selection over the
E2B, Daytona, Modal, Coder and OpenSandbox adapters); without it starting a run answers 503.
Credentials come from [`@selfhost/credentials`](../../packages/credentials/src/prepare.ts) by
default (`brokeredCredentials`): a GitHub App token for the run's one repository, a per-run
gateway key in place of any provider key when `[integrations.router]` is set, the team's declared
secrets, and the team's egress list plus github.com, api.github.com and the gateway host, all by
reference in the sandbox spec, masked in the run's output and revoked with how the run ended.
`createBackground({ credentials })` replaces it.

Each team reads only its own run secrets. An `env:` secret names
`SELFHOST_RUN_SECRET_<TEAM>__<NAME>`, where TEAM is the team id in upper snake case and two
underscores end it (team `web-platform` reads `SELFHOST_RUN_SECRET_WEB_PLATFORM__DB_PASSWORD`, and
team `web` cannot), or a shared `SELFHOST_RUN_SECRET_SHARED__<NAME>` when the server lists the
team in `SELFHOST_RUN_SECRET_SHARED_TEAMS`. A `vault:` or `infisical:` path sits under the team's
prefix, `selfhost/<team>/` unless `SELFHOST_SECRET_PATH_PREFIX` says otherwise (it must contain
`{team}`). Both are server settings only. `PUT /v1/policy` (and the org's policy, for every team
of the org) answers 400 `invalid_policy` naming the allowed prefix for anything else, and a run
whose stored policy names one anyway fails before its sandbox starts. A team's
`[integrations.tracer] headers_env` is held to the same `env:` names. On start the server marks runs a previous process left going as
failed and stops their sandboxes (`SELFHOST_BACKGROUND_RECOVER=off` on all but one server sharing
a database); `SELFHOST_BACKGROUND=off` turns background runs off.

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
configured GitHub App calls the GitHub API, and only while handling a signed delivery, and a
configured `[integrations.tracer]` receives the team's runs);
`test/privacy.test.ts` ingests fixture events, OTLP and team writes with every outbound path
stubbed to fail, then reads every table to check that no planted secret was stored.

```sh
pnpm --filter @selfhost/server dev     # watch mode on http://127.0.0.1:4400
pnpm --filter @selfhost/server build   # bundles to dist/main.js
pnpm --filter @selfhost/server start   # runs the build
```

Environment:

| Variable                           | Default            | Meaning                                                                                                                         |
| ---------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                             | `4400`             | Port to listen on.                                                                                                              |
| `HOST`                             | `127.0.0.1`        | Address to bind.                                                                                                                |
| `DATABASE_URL`                     | unset              | `postgres://` URL. Unset uses the embedded database.                                                                            |
| `SELFHOST_DATA_DIR`                | `~/.selfhost/data` | Embedded database and token file.                                                                                               |
| `SELFHOST_TOKEN`                   | unset              | API token. Unset uses or creates `<data dir>/token`.                                                                            |
| `SELFHOST_CONFIG`                  | unset              | `selfhost.toml` with the defaults for events with no team policy: `[ledger]`, `[[redaction]]`, `[review]`.                      |
| `SELFHOST_RETENTION_SWEEP`         | `daily`            | `off` keeps every event instead of deleting expired ones daily.                                                                 |
| `SELFHOST_REVIEW_REFRESH`          | `15s`              | `off` stops building review items and timing out approvals on this server.                                                      |
| `SELFHOST_TRACE_EXPORT`            | `1m`               | `off` stops sending finished runs to each team's `[integrations.tracer]` from this server.                                      |
| `SELFHOST_CACHE_ALERTS`            | `1m`               | `off` stops raising prompt cache alerts for sessions whose hit rate collapsed, from this server.                                |
| `SELFHOST_APPRISE_URL`             | unset              | Apprise API server notifications go through (`compose.notify.yml`: `http://apprise:8000`). Unset sends none.                    |
| `SELFHOST_NOTIFY`                  | `1m`               | `off` stops sending notifications from this server, when another one sends them from the same database.                         |
| `SELFHOST_GITHUB_APP_ID`           | unset              | GitHub App id. With the key and secret, turns on `POST /v1/github/webhooks`.                                                    |
| `SELFHOST_GITHUB_PRIVATE_KEY`      | unset              | The App's private key (PEM, or one line with `\n` escapes).                                                                     |
| `SELFHOST_GITHUB_PRIVATE_KEY_FILE` | unset              | Path to the App's .pem, instead of `SELFHOST_GITHUB_PRIVATE_KEY`.                                                               |
| `SELFHOST_GITHUB_WEBHOOK_SECRET`   | unset              | The App's webhook secret.                                                                                                       |
| `SELFHOST_GITHUB_TEAM`             | unset              | Team whose stored `selfhost.toml` sets `[review]` for GitHub, and whose review items pick the owner.                            |
| `SELFHOST_PUBLIC_URL`              | unset              | This server's URL as people reach it, for brief links and the receipts' OIDC audience. Unset: the request's origin.             |
| `SELFHOST_GITHUB_OIDC_ISSUER`      | GitHub's           | Issuer of the CI OIDC tokens `POST /v1/receipts` accepts; set it on GitHub Enterprise Server.                                   |
| `SELFHOST_CONSOLE`                 | on                 | `off` serves `/v1` only, no web console at `/`.                                                                                 |
| `SELFHOST_CONSOLE_DIR`             | unset              | The built console to serve at `/`. Unset uses the one built into the server.                                                    |
| `SELFHOST_SIGNIN_PROXY_SECRET`     | unset              | Turns on console sign-in through a proxy that sends it with the signed-in email. See [Console](#console).                       |
| `SELFHOST_SIGNIN_ORG`              | unset              | The org console sign-in is for, when an email is in teams of several orgs. Unset: the org it joined first.                      |
| `SELFHOST_RUN_SECRET_<TEAM>__*`    | unset              | Values a team's `env:` secrets may read for background runs (TEAM: the team id in upper snake case); no other server variable.  |
| `SELFHOST_RUN_SECRET_SHARED__*`    | unset              | Values every team in `SELFHOST_RUN_SECRET_SHARED_TEAMS` may read as `env:` secrets.                                             |
| `SELFHOST_RUN_SECRET_SHARED_TEAMS` | unset              | Team ids, separated by commas or spaces, that may read the shared run secrets. Unset: none.                                     |
| `SELFHOST_SECRET_PATH_PREFIX`      | `selfhost/{team}/` | Where each team's `vault:` and `infisical:` paths sit; `{team}` is the team id and must be in it.                               |
| `VAULT_ADDR`, `VAULT_TOKEN`        | unset              | Vault for `vault:` secrets, with `VAULT_NAMESPACE` and `SELFHOST_VAULT_MOUNT` (default `secret`). Never set by a policy.        |
| `INFISICAL_PROJECT_ID`             | unset              | Infisical for `infisical:` secrets, with `INFISICAL_ENVIRONMENT`, `INFISICAL_TOKEN` and `INFISICAL_URL`. Never set by a policy. |
| `SELFHOST_GIT_CLONES`              | unset              | Folder of clones at `<owner>/<name>` (lower case), read for provenance and module revert rates.                                 |
