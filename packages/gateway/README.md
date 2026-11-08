# @selfhost/gateway

selfhost does not build an AI gateway. It deploys [Bifrost](https://github.com/maximhq/bifrost)
(Apache 2.0) next to the server, or points at a LiteLLM proxy the team already runs, and this
package is the glue: it writes the gateway's settings from `selfhost.toml` and reads its request
logs into the ledger.

```ts
import { bifrostClient, issueKey, readUsage, syncGateway } from "@selfhost/gateway";

const gateway = bifrostClient({ url: "http://bifrost:8080", username: "selfhost", password });
await syncGateway(gateway, [{ team: "platform", config, people: ["ada@example.com"] }]);
const { issued } = await issueKey(gateway, { kind: "person", team: "platform", person }, config);
await readUsage(gateway, since, (events) => ledger.append(events));
```

- Teams: one gateway team per selfhost team, named `selfhost:<team>`, with the team's
  `[budget]` limits when `mode = "hard"`.
- Keys: virtual keys per person, team and run, named `selfhost:<kind>:<team>[:<who>]`, with
  metadata (`selfhost_kind`, `selfhost_team`, `selfhost_person`, `selfhost_run`) that the gateway
  copies onto each request log. Person keys get `[budget.person]`, run keys `run_usd` and a 24
  hour life. `[integrations.router] providers` sets the providers in fallback order: the first
  gets all the traffic, the rest are tried in turn.
- `syncGateway` changes only what differs and never creates a key, so it is safe to run any
  time. It turns off keys of people who left and returns an `alert.raised` event
  (`budget_exceeded`, which the review list shows) per budget spent in its window, with an id
  stable per window.
- `issueKey` returns a key's value once; nothing here stores or logs it, and errors mask
  anything shaped like a key.
- `readUsage` pages through the gateway's request logs and maps each finished request to a
  ledger event with `source = "gateway"` (see `mapBifrostLog` and `mapGatewayLog` in
  `@selfhost/ledger`). Ids come from the gateway's request ids, so a window read twice is stored
  once.

| Gateway | Management API used                                                                    | Limits it holds                         |
| ------- | -------------------------------------------------------------------------------------- | --------------------------------------- |
| Bifrost | `/api/governance/teams`, `/api/governance/virtual-keys` (and `/rotate`), `/api/logs`   | day, week, month and run, per key, team |
| LiteLLM | `/team/*`, `/key/generate`, `/key/update`, `/key/block`, `/key/list`, `/spend/logs/v2` | one window per key and team             |

Calls go one at a time, at least 50 ms apart, with a timeout each and one retry after a 429.
`@selfhost/gateway/testing` has in-memory stand-ins for both management APIs.
