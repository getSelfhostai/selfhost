# @selfhost/vendor-compat

Checks each new Claude Code, Codex, Cursor and OpenCode CLI release against selfhost's hooks,
log importers, compilers and `selfhost gateway connect`, and writes the compatibility page in
[`docs/compatibility/`](../../docs/compatibility/): `index.html` and the same data in
`compatibility.json`. `.github/workflows/vendor-compat.yml` runs it.

## When it runs

- Weekly (Monday 05:17 UTC), every check for the newest release of every CLI.
- Every six hours, `scripts/latest.mjs` looks up the newest releases (npm `/latest`, and the
  version in the URL Cursor's installer downloads) with no install. The checks run only when a
  newest release is not on the page yet, or is listed as broken.
- By hand: Actions, Vendor compatibility, Run workflow.

## What a run does

Each command adds to one results file, records failures there and exits 0, so one broken CLI
does not stop the others from being checked.

- `compat install`: installs each release under a temp folder with `--ignore-scripts` (Cursor:
  downloads and unpacks its package without running the installer). Nothing is installed
  globally.
- `compat probe`: offline, with a fresh HOME and no key. `--version` reports the installed
  version; the hook events selfhost hooks are still offered (Claude Code: the list
  `claude doctor` prints, which also names events selfhost does not model yet; the others: the
  names in the CLI); the payload and answer fields selfhost reads and writes still appear; Claude
  Code's `sdk-tools.d.ts` still declares the tool inputs the pre-tool check reads; and the CLI
  loads what `selfhost policy compile` writes for that release (`claude doctor` on the managed
  settings, `codex features list` on `/etc/codex/requirements.toml`, which needs root and so
  runs on CI only). Each config check first feeds the CLI a known-bad file and is skipped if the
  CLI does not complain about it.
- `compat suites`: the fixture sessions and hook payloads through the schemas, hook mappers,
  importers, `selfhost hook`, the policy and context compile golden files, and gateway connect
  and disconnect on fixture configs per agent.
- `compat connect`: no key needed. For Claude Code, Codex and OpenCode, the settings
  `selfhost gateway connect` writes go into a fresh home, pointing at a stand-in gateway on
  127.0.0.1 that answers 401; the CLI runs one prompt (`claude -p`, `codex exec`,
  `opencode run`), and the `gateway-connect` check passes when the model request reaches the
  stand-in at the gateway's path with the virtual key. Cursor can't use a gateway and gets no
  check; Goose is not installed here, so only its fixture tests cover it. The page's Gateway
  connect table shows the result for the newest tested version of each agent.
- `compat live`: with `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` set, a short real session
  (`claude -p`, `codex exec`) with a hook on every event writing its payload to a folder. The
  payloads must match selfhost's schemas and map to valid ledger events, and the session log the
  CLI wrote must import. Without a key the step is skipped.
- `compat report`: merges the run into `compatibility.json`, rewrites `index.html`, and lists
  the issues to open, update or close.

A failed check marks that release broken on the page; the workflow opens an issue titled
`Vendor compatibility: <CLI> <version> is broken` (or comments on the open one), commits the
page and fails. When a later run passes, the page says passing and the issue is closed. A skipped
check (no key, no root, a CLI that would not say) never marks a release broken. Check details are
masked for secret-shaped text before they are written.

## Run it locally

```sh
S=$(mktemp -d)
node packages/vendor-compat/scripts/latest.mjs --force          # newest versions, as JSON
pnpm --filter @selfhost/vendor-compat compat install --versions '{"codex":"0.167.0"}' --dir "$S/vendors" --results "$S/results.json"
pnpm --filter @selfhost/vendor-compat compat probe --results "$S/results.json"
pnpm --filter @selfhost/vendor-compat compat suites --results "$S/results.json"
pnpm --filter @selfhost/vendor-compat compat connect --results "$S/results.json"
pnpm --filter @selfhost/vendor-compat compat report --results "$S/results.json" --out "$S/page"
```

`compat live` spends API credit when a key is in the environment. `--out` defaults to
`docs/compatibility`; point it elsewhere to look at a page without changing the committed one.

## Fixing a broken release

1. Open the run from the issue and read the failed checks.
2. A hook event or field that is gone: check the vendor's hooks docs (cited in
   `apps/cli/src/hooks/vendors.ts` and `packages/schema/src/hooks/`), update the schema and the
   mapper, and add a payload fixture under `fixtures/hooks/<vendor>/`.
3. A config the CLI refuses: update `packages/compile/src/vendors/<vendor>.ts`, gating new syntax
   on the version, add the version to `VENDOR_VERSIONS` and its golden folder (see
   `fixtures/README.md`).
4. A failed `gateway-connect`: the CLI changed a setting connect writes. Check the vendor's
   docs (cited in `packages/agents/src/config/vendors.ts`), update the gateway item there and
   its fixture in `packages/agents/test/gateway.test.ts`.
5. A session log the importer cannot read: capture a scrubbed session with
   `scripts/capture-fixtures.mjs` and fix `packages/importers`.
6. Merge, then run the workflow by hand. The broken release is also retested every six hours.

## Secrets and settings

- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (repository secrets): turn on the live sessions. Each
  live run is one short session per CLI; Claude Code is capped with `--max-budget-usd 0.25`.
- `COMPAT_CLAUDE_MODEL` (default `haiku`) and `COMPAT_CODEX_MODEL` (default: the CLI's default),
  as repository variables, pick the models.
