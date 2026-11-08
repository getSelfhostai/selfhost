# @selfhost/console

The selfhost web console: the control center where leads and admins see and steer what coding
agents do. Developers never need it; they see selfhost in their agent, terminal and GitHub. It
reads the same HTTP API as every other client (see [`apps/server`](../server/README.md)), so
every number is a ledger query and every button is an API call the server checks against the
caller's role.

React, Vite and Tailwind with [shadcn/ui](https://ui.shadcn.com) components (`src/components/ui`,
added with the shadcn CLI from `components.json`) and Recharts for the chart. It builds to static
files in `dist/` that the selfhost server serves at `/`: on a laptop through `selfhost console`,
on a team server from the Docker image, behind Caddy.

```sh
pnpm --filter @selfhost/console build   # dist/, copied into the server and CLI builds
pnpm --filter @selfhost/console dev     # Vite on :5173, /v1 sent to a server on 127.0.0.1:4400
pnpm --filter @selfhost/console test
```

## What it shows

One navigation, about one team at a time (the team picker at the top; the admin token can also
look across every team on the overview, review list and spend):

- **Overview**: this week's agent sessions, cost, PRs opened and merged, risky PRs, blocks and
  asks from rules and items waiting on a person, each linking to its screen, and the top of the
  review list. (`/v1/usage`, `/v1/review-items`, `/v1/policy/observed`)
- **Review list**: items waiting on a person, ranked like `selfhost inbox` (agents blocked
  first, then by risk), with approve, deny, answer and snooze. Decisions go through
  `POST /v1/review-items/{id}/decision` and land in the decision log. Exception requests show
  the rule, the blocked call and what the agent should do instead.
- **Rules**: every rule and guardrail with its mode (Recording only, Blocking, Asks a person,
  Off), what it blocked or would have blocked in the last 7 days, and for Claude Code, Codex,
  Cursor and Copilot whether it can enforce it. Owners and admins start blocking a rule in one
  click: the console edits the team's selfhost.toml with the same line edit as
  `selfhost policy promote` (`@selfhost/policy/promote`) and stores it with `PUT /v1/policy`.
  A policy on an org floor is promoted in the team's file instead. (`/v1/policy`,
  `/v1/policy/coverage`, `/v1/policy/observed`)
- **Spend**: the budget this month with its forecast (`/v1/budget`), cost per merged PR
  (`/v1/teams/{team}/roi`, when the server has it), and the usage view below.
- **Code**: the share of merged code agents wrote and how much of it was reverted or reworked,
  per repo and module, flagged modules first (`/v1/teams/{team}/provenance` and `/modules`).
- **Run**: one agent session: who, agent, model, repo, cost, its events in order, its PRs and
  a link to the team's tracer (`/v1/runs/{id}`, else the session's `/v1/events`).
- **Integrations**: the router, tracer, runtime and reviewer the team picked, with their
  status; owners and admins change them (`/v1/integrations`, when the server has it).
- **Team**: people and roles (owners change roles), open invites (create, revoke) and the repos
  that count for the team (`/v1/teams/{team}/people`, `/invites`, `/repos`).

Members see their teams and can answer review items; buttons for what their role cannot do are
not shown, and the server refuses them anyway (the actions come from `GET /v1/me`).

The usage view: totals for the range and filters (cost and requests, tokens and how many came
from the cache, sessions, PRs opened and merged, with cost per merged PR); cost, tokens or
sessions per day, stacked by the chosen breakdown (the top five, then Other); a table by team,
developer, agent or model with a total row, where clicking a row filters to it; filters for
team, developer, agent and model and a range of the last 7, 30 or 90 days, this month, or any
days (UTC); and CSV export of exactly the rows on screen.

The view lives in the address bar (`?screen=spend&view=model&agent=codex&range=90d`), so it can
be bookmarked and shared; the token never goes in it.

## Signing in

- `selfhost console` opens it with `#token=<token>`: the console keeps the token in this
  browser's localStorage and takes it out of the address bar. A fragment never reaches a
  server.
- Otherwise it asks for a token: a person token from `selfhost team join` (in
  `~/.selfhost/config.json`) or the server's admin token. Sign out forgets it.
- Behind a sign-in proxy ([`deploy/docker`](../../deploy/docker/README.md)) it needs no token:
  the server reads as the signed-in person.
