# @selfhost/package-guard

Checks every package an agent installs against its registry before the install runs, so an
invented name (the slopsquatting trap: agents make up plausible package names, and attackers
register them) never reaches `npm install`. A name the registry does not have is blocked; a
version younger than `min_age_days`, or one that runs code at install, is flagged; a known
malicious package, a denied one and any install from a blocked registry are blocked. The
allow list skips every check. Apache-2.0.

```ts
import { packageGuard } from "@selfhost/package-guard";

const guard = packageGuard(config, {
  fetch, // the global fetch, or a stand-in
  now: () => new Date(),
  cacheDir: join(homedir(), ".selfhost", "cache", "packages"), // optional: shared between hook processes
  budgetMs: 3000, // optional, the default
  env: process.env, // optional: registry variables such as npm_config_registry
});
const hits = await guard({ tool: "Bash", command: "npm i reqeusts" });
// [{ rule_id: "packages.not_found", mode, verdict: "block", message, irreversible: false }]
```

`packageChecker(deps)` is the same guard as `(call, config) => Promise<PolicyHit[]>`, the shape
of an extra check the pre-tool hook awaits. `checkCommand(command, config, deps)` returns the full
report (each install, each package with its status, version, publish time, findings and what
could not be checked) and `packageHits(report, config)` turns it into hits. `parseInstalls`
is the pure command parser. `selfhost packages check "<command>"` runs it by hand.

## Rules and verdicts

One hit per rule id per tool call; its message names every package that broke the rule. Hits
take the mode of `[packages]` (`observe` records, `enforce` applies, `off` checks nothing and
makes no network call).

| Rule id                     | When                                                                                                                                                   | Verdict                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `packages.deny`             | The name matches `[packages] deny`                                                                                                                     | block                                                     |
| `packages.blocked_registry` | The install names a registry, index or proxy in `blocked_registries`, or uses a default one that is, or installs a URL or git spec from a blocked host | block                                                     |
| `packages.malicious`        | osv.dev lists a `MAL-` advisory for the version, or for the name when the registry no longer has it                                                    | block                                                     |
| `packages.not_found`        | The registry has no package by that name, or no such version                                                                                           | block                                                     |
| `packages.too_new`          | The version was published fewer than `min_age_days` ago, or so recently that deps.dev does not list it yet                                             | ask                                                       |
| `packages.install_scripts`  | An npm version with `preinstall`, `install` or `postinstall` scripts or a `binding.gyp`, or a PyPI release with no wheel (pip runs its build code)     | `install_scripts`: ask (default), block, or allow to skip |
| `packages.unchecked`        | A lookup failed or ran out of time                                                                                                                     | ask, always in observe mode                               |

A flag is an `ask` verdict: in enforce mode the hook stops the call for a person's approval,
in observe mode it is recorded. `packages.unchecked` is the fail-open note: the install goes
ahead and the trace says what was not checked and why. Every hit becomes a `policy.evaluated`
event through the hook, so it shows in the session's trace, and the review brief lists the
blocks and flags of the pull request's sessions under Blocked actions (unchecked installs as a
note there).

Allow and deny entries are names or globs ([picomatch](https://github.com/micromatch/picomatch):
`*` stays within one `/` segment, so a Go module prefix needs `**`). `npm:`, `pypi:`, `cargo:`
or `go:` in front limits an entry to one registry. PyPI names compare normalized (PEP 503).
Deny wins over allow. A package from a private registry the guard cannot see (a scope in
`.npmrc`, a private Go module) belongs on the allow list, or in `GOPRIVATE` for Go.

## What it reads

The parser uses [shell-quote](https://github.com/ljharb/shell-quote) and finds installs in
chains, pipelines, lines, `bash -c` and `eval`, behind `sudo`, `env`, `time` and `corepack`:

- npm, pnpm, yarn and bun `add` and `install` (and npm's aliases such as `i` and `isntall`);
  `npx`, `npm exec`, `pnpm dlx`, `pnpx`, `bunx`, `bun x` and `yarn dlx` (the package they run,
  or `--package`); `npm init <x>` and `create <x>` (the `create-<x>` package). Versions, tags,
  ranges, scopes and `alias@npm:name` are read.
- `pip install`, `python -m pip`, `uv pip install`, `uv add`, `uv tool install` and `run`,
  `uv run --with`, `uvx` (and `--from`, `--with`), `poetry add` and `pipx install`, `run` and
  `inject`. Extras and markers are dropped; `==1.2.3` is an exact version.
- `cargo add` and `cargo install` (`--version`, `name@version`; a bare version is exact for
  install and a caret requirement for add).
- `go get`, and `go install` and `go run` at an `@version`. A package path is matched to the
  longest module path that exists.

Git, GitHub, URL, tarball, folder, editable, workspace and requirements-file installs are not
looked up; the report says why. Registries come from `--registry`, `--@scope:registry`,
`-i`/`--index-url`, `--extra-index-url`, `--find-links`, uv `--index`, poetry `--source`,
cargo `--registry` and `--index`, `GOPROXY`, and the registry variables in the command or in
`env`. An install through a registry other than the public one is checked against
`blocked_registries` but not looked up: the guard cannot see what that registry serves.

## Lookups

No keys. One time budget covers every lookup in a call; requests run in parallel.

| Service                                                      | For                                                                                                                                                                                    |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| deps.dev v3 `GetPackage`                                     | Whether the package exists, every version with its publish time, and the default version, for npm, PyPI, crates.io and Go alike                                                        |
| npm registry, `/<name>/<version or tag>`                     | npm existence (authoritative), tag resolution, and install scripts. The full or abbreviated package document is megabytes for popular packages; the per-version manifest is about 2 KB |
| PyPI JSON API, `/pypi/<name>/<version>/json`                 | Whether the release ships a wheel                                                                                                                                                      |
| osv.dev `querybatch`                                         | `MAL-` advisories (the OpenSSF malicious packages feed OSV-Scanner uses), as ids only                                                                                                  |
| PyPI and the crates.io sparse index (HEAD), proxy.golang.org | Confirmation when deps.dev does not list a name, so a package too new for deps.dev is flagged as new instead of blocked as missing                                                     |

A cold check takes one or two round trips: 0.6 to 1.5 seconds for a typical install when
measured in November 2026. With `cacheDir` a repeat check takes a few milliseconds.
Lookups are cached as JSON files keyed by a hash of the lookup: package lists and advisories
for an hour, a published version for a week, a name that does not exist for ten minutes (it
may be registered any minute). When the budget runs out (3 seconds by default) or a registry
fails, the packages it could not check are reported as `packages.unchecked` and the install
goes ahead.

Not checked: build scripts of crates (crates.io does not publish whether a crate has a
`build.rs`), and Go has no install scripts. PyPI version ranges resolve to the default
version.

## Tests

Integration tests replay real registry responses recorded in
[`fixtures/registries`](../../fixtures/registries/manifest.json) and never use the network.
`pnpm --filter @selfhost/package-guard capture` records them again.
