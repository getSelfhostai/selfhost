# @selfhost/console

The selfhost web console: tokens, cost, sessions and pull requests opened and merged, by team,
developer, agent and model, with filters for each and a date range applied to every view, and
CSV export of exactly the rows on screen. It reads the same HTTP API as every other client
(`GET /v1/me`, `GET /v1/usage`, `GET /v1/usage.csv`; see
[`apps/server`](../server/README.md#usage)), so every number in it is a ledger query on Postgres
or the embedded database, and what a person sees follows their role on the server.

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

- Totals for the range and filters: cost and requests, tokens and how many came from the cache,
  sessions, PRs opened and PRs merged, with cost per merged PR.
- Cost, tokens or sessions per day, stacked by the chosen breakdown (the top five, then Other).
- A table by team, developer, agent or model with every metric and a total row. Clicking a row
  filters to it.
- Filters for team, developer, agent and model, offered from the values in the range, and a
  range of the last 7, 30 or 90 days, this month, or any days (UTC). Every view, the chart and
  the CSV use the same filters.

The view lives in the address bar (`?view=model&agent=codex&range=90d`), so it can be
bookmarked and shared; the token never goes in it. A person in one team gets no team filter or
breakdown; the admin token and people in several teams get both.

## Signing in

- `selfhost console` opens it with `#token=<token>`: the console keeps the token in this
  browser's localStorage and takes it out of the address bar. A fragment never reaches a
  server.
- Otherwise it asks for a token: a person token from `selfhost team join` (in
  `~/.selfhost/config.json`) or the server's admin token. Sign out forgets it.
- Behind a sign-in proxy ([`deploy/docker`](../../deploy/docker/README.md)) it needs no token:
  the server reads as the signed-in person.
