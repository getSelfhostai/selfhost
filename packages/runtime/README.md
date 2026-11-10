# @selfhost/runtime

One interface over the places a background agent runs: create a sandbox, run commands in it,
read and write files, stream its logs, snapshot it, stop it and read what it cost. selfhost
drives each provider only through its own SDK or API, and uses the provider's own features for
snapshots, network limits and secrets.

```ts
import { openRuntime, pickRuntime, trackSandbox } from "@selfhost/runtime";

const choice = pickRuntime(config, { size: { cpu: 2 } }, { env: process.env });
if (!choice.ok) throw new Error(`${choice.message} (${choice.rule})`);
const runtime = openRuntime(choice.kind, config, { env: process.env });
const sandbox = await trackSandbox(
  await runtime.create({ timeoutMinutes: 60, size: choice.size, labels: { run: "run-7" } }),
  {
    emit: (event) => ledger.append([event]),
    context: { run_id: "run-7", team: "web" },
    usdPerHour: choice.usdPerHour,
  },
);
await sandbox.exec("npm test", { onOutput: ({ text }) => process.stdout.write(text) });
sandbox.markRunEnded();
await sandbox.stop();
```

The contract is `RuntimeAdapter` and `Sandbox` in `src/types.ts`. `fakeRuntime()` is an
in-memory runtime for tests of code built on it.

## Runtimes

Each provider SDK is an optional peer dependency, loaded with a dynamic import the first time
that runtime is used, so selfhost installs, builds and tests without any of them. Install the
one you use next to selfhost; the error says which when it is missing. ComputeSDK is not used.

### E2B

- Package: `e2b@2.59.0` (MIT). Key: `E2B_API_KEY`, or `api_key_env`.
- Template: `template` in the settings, else `base`. Sizes come from the template.
- Egress: E2B's `allowOut` list, every other address denied. Secrets go in as environment
  variables. Labels are E2B metadata. Logs: `GET /v2/sandboxes/{id}/logs`.
- Snapshots: `createSnapshot`, which a later create starts from by its id.
- Price: $0.000014 per vCPU-second and $0.0000045 per GiB-second, billed per second while
  running ([pricing](https://e2b.dev/pricing)).

### Daytona

- Package: `@daytona/sdk@0.226.1`, Daytona's Apache-2.0 SDK. selfhost never uses or bundles
  Daytona server code.
- Key: `DAYTONA_API_KEY`. `url` sets the API (default `https://app.daytona.io/api`).
- Sandboxes are ephemeral (deleted on stop) with auto-stop off and a time to live of
  `timeoutMinutes`. A spec image with a tag or registry path is an image (and takes the size);
  anything else is a Daytona snapshot name.
- Region: Daytona's `target` (`us`, `eu`). Egress: `domainAllowList`. exec returns stdout and
  stderr merged, as Daytona does. Logs are the commands this process ran and their output.
- Price: $0.0504 per vCPU-hour, $0.0162 per GiB-hour, disk past 5 GiB at $0.000108 per
  GiB-hour ([pricing](https://www.daytona.io/pricing)).

### Modal

- Package: `modal@0.11.1`, Modal's JavaScript SDK (Apache-2.0). Keys: `MODAL_TOKEN_ID` and
  `MODAL_TOKEN_SECRET`.
- Sandboxes run in the `selfhost-runtime` app, from a registry image (`template`, default
  `node:22-bookworm`) or a filesystem snapshot image (`im-...`). vCPUs map to Modal's physical
  cores, two vCPUs each.
- Region: Modal's `regions`. Egress: `outboundDomainAllowlist`. Secrets: a Modal secret built
  from the values. Snapshots: `snapshotFilesystem`.
- Price: $0.00003942 per core-second and $0.00000667 per GiB-second for sandboxes; picking a
  region costs 1.15 to 1.75 times as much and the floor is used
  ([pricing](https://modal.com/pricing)).

### Coder

- REST API only (`/api/v2`) and the agent's reconnecting PTY WebSocket. No Coder code is used,
  so its AGPL never touches selfhost. Needs Node 22 or later for the built-in WebSocket.
- Settings: `url` (required), `template` (a template id, or a name in the token's first
  organization), key `CODER_SESSION_TOKEN`.
- A sandbox is a workspace named `selfhost-...`; stop deletes it. Workspaces have no labels, so
  `list` returns every workspace selfhost made, and the conformance suite skips the label
  filter. No snapshots. stderr arrives merged with stdout. Environment and secrets are applied
  to each command this process runs, not stored on the workspace.
- Price: none published; set `usd_per_hour` to the team's own rate.

### OpenSandbox (your own server)

[OpenSandbox](https://github.com/opensandbox-group/OpenSandbox) is the runtime for the team's
own server or cluster: Apache-2.0, foundation governed, one lifecycle API from Docker on a laptop
to its Kubernetes operator, with per-sandbox egress policy built in.

- Package: `@alibaba-group/opensandbox@1.1.1`. Settings: `url` (required, the server), key
  `OPEN_SANDBOX_API_KEY`. A server on localhost may run without a key.
- Egress: the sandbox's network policy, deny by default with the spec's hosts allowed. Snapshots:
  the server's snapshot API; create from one with image `snapshot:<id>`.
- Price: none; set `usd_per_hour` to what a sandbox costs the team.
- Local server: `uv pip install opensandbox-server`, then
  `opensandbox-server init-config ~/.sandbox.toml --example docker` and `opensandbox-server`
  (Docker must be running). On Kubernetes, install its operator and point `url` at the server.

## Egress and secrets from one policy

`[egress]` and `[secrets]` are translated into each provider's own controls by
`@selfhost/credentials` (`egressFor`, `secretsFor`). Pass the result as `spec.native`:
`native.create` is merged into the provider's create call as given (E2B `network`, Daytona
`domainAllowList` or `networkAllowList`, Modal `cidrAllowlist`, sent as the SDK's
`outboundCidrAllowlist`, or `blockNetwork`, OpenSandbox `networkPolicy`), and
`native.credentialVault` starts an OpenSandbox sandbox with its credential proxy on and writes the
vault, so injected secrets never enter the sandbox. Without `native`, an adapter applies
`spec.egress` itself. Coder declares `egress: false` and `secrets: false`: its Agent Firewall
lives in the template, not in the workspace API.

## Picking a runtime

`pickRuntime(config, request)` reads `[runtime]` in selfhost.toml:

```toml
[runtime]
default = "e2b"                 # used when a task names none and policy is default
allow = ["e2b", "daytona", "opensandbox"]
policy = "cheapest_allowed"     # or "default"
region = "us"
max_size = { cpu = 4, memory_gib = 8 }
leftover_minutes = 15

[runtime.providers.opensandbox]
url = "http://localhost:8080"
usd_per_hour = 0.02
```

A task that names a runtime outside `allow` is refused with rule `runtime.allow`; a size over
`max_size` with `runtime.max_size`; a region the runtime cannot serve with `runtime.region`; no
runtime at all with `runtime.default`. `cheapest_allowed` takes the allowed runtime that has a key
and the lowest list price for the size; runtimes without a price come last. How to reach a
runtime comes from `[runtime.providers.<name>]`. The deprecated `[integrations.runtime]` is read by
`parseConfig` as `[runtime] default` with `[runtime.providers.<tool>]`. `runtimeFor` answers a
refusal with `{ refusal: { rule, message } }` instead of an adapter, so callers show the reason
as it is.

## Keys and caps

Keys are read from the environment variables the settings name, never written to selfhost.toml,
the ledger or any output. With no key for the chosen runtime, `openRuntime` throws a
`RuntimeKeyError` that names the variable, and the run does not start: selfhost never runs a task
on a key it owns.

`[budget]` caps sandbox spend, always hard:

- `runtime_run_usd`: a run's sandbox is stopped once it costs this much.
- `runtime_daily_usd`: once the team's sandbox spend for the UTC day reaches it, new runs are
  refused (`RuntimeGuard.admit`) and running sandboxes are stopped (`RuntimeGuard.check`).

Each stop writes `sandbox.stopped` with reason `cap` and the cap's key, and an `alert.raised`
(`budget_exceeded`) that the review list turns into a budget item naming the cap.

## Ledger events

`trackSandbox` writes `sandbox.started` when it wraps a new sandbox and `sandbox.stopped` when it
stops. Both carry `data.sandbox`, a `selfhost.sandbox/v1` record: runtime, sandbox id, size,
region, list price per hour and billing model; the stop adds the reason, billed seconds, busy
seconds (a command was running), idle seconds (the rest) and, when the run had ended, how long
the sandbox outlived it. `sandbox.stopped` also carries `cost`: no tokens, the sandbox's dollars,
`estimated` when they came from the list price. Event ids are derived from the sandbox, so a stop
written twice is stored once.

## Idle waste and leftovers

`selfhost spend`, the console's spend screen and `GET /v1/teams/{team}/sandboxes` show, per
runtime, the share of sandbox cost paid while no command ran, over 7 and 30 days. Above 50% on a
runtime that bills reserved CPU and memory, they name the cheaper model (active-CPU billing, or
pausing between agent steps) with the saving scaled to a month. Idle is measured from command
timing, not CPU samples: a command that runs but does nothing counts as busy.

A sandbox still running `leftover_minutes` (15) after its run finished, failed or got stuck is
listed with its cost. `selfhost runtime reap` stops those it finds through each runtime's `list`
(only sandboxes carrying selfhost's label), writes the stop with reason `reaped`, and sends the
run's owner a review item. `--dry-run` lists them; sandboxes the ledger has no run for are only
stopped with `--include-unknown`.

## Conformance

`runConformance(adapter)` exercises every method: create, status, exec (output, exit codes,
stderr, cwd and env, streaming, timeouts), files (text, bytes, missing), get, list by label,
logs, snapshot, cost and stop (twice, then gone). It makes one sandbox and always stops it.

In CI it runs against `fakeRuntime` and against each adapter wired to an in-memory copy of its
SDK or API (`test/fakes.ts`), whose shapes `test/sdk-shapes.ts` type-checks against the real
SDKs. Against real accounts it runs when the credentials are set where the tests run:
`E2B_API_KEY`, `DAYTONA_API_KEY`, `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`, `CODER_URL` with
`CODER_SESSION_TOKEN` and `CODER_TEMPLATE`, or `OPENSANDBOX_URL`. `selfhost runtime check
--conformance` runs it from the command line.

The OpenSandbox suite does not run in the CI compose job: its server is a Python package that
starts sandboxes through the Docker socket, and its 1.1.0 server wheel is reported to fail at
startup. Run it against a local server with `OPENSANDBOX_URL=http://localhost:8080`.
