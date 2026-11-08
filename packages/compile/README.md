# @selfhost/compile

Compiles `selfhost.toml` into each coding agent vendor's own controls, and says for every rule
and vendor how much of it those controls cover. One rule is written once; Claude Code, Codex,
Cursor and GitHub Copilot each get the closest native form, and a rule a vendor can't express is
never reported as covered.

```ts
import { compilePolicy } from "@selfhost/compile";

const { vendors, coverage, rules } = compilePolicy(config, { team: "platform" });
// vendors: per vendor, files (content plus where they install) and GitHub API calls
// coverage: selfhost.policy_coverage/v1, one entry per rule and vendor
// rules: .ruler/selfhost-policy.md, the policy as text for Ruler
```

`compilePolicy` is pure: no file is read or written. `selfhost policy compile` writes the output
folder and, with `--apply`, the rules files; `GET /v1/policy/coverage` on the server returns the
coverage for the team policy.

## Coverage

Each rule gets one entry per vendor:

- `compiled`: the native entries cover every call the rule matches.
- `partial`: they cover some; `detail` says what they miss.
- `not_expressible`: the vendor has no control for it.
- `not_applicable`: the rule can't match on that vendor (mode off, limited to other agents, or it
  names another vendor's tool, such as `Bash` on Cursor, whose shell tool is `Shell`).

`hook` says whether the selfhost pre-tool hook covers the rule on that vendor: `enforce`,
`record` for observe rules, or `none` (Copilot has no selfhost hook, and no vendor runs hooks on
a hosted web fetch). Only enforced rules become native entries: native controls block, and an
observe rule must not. Observe rules show the status they will get once enforced.

## How rules map

Rules match on `tool` (exact name), `command` (a regular expression tested anywhere in the
command), `path` (a glob from the repository root) and `url` (a glob). Vendors match commands by
prefix or wildcard, not by regular expression, so `command` compiles only when it reduces to
literal text (`reduceCommand`): literal characters, `^`, `$`, a trailing `\b` or `(\s|$)`,
alternation, `?` and whitespace classes between words. Write `^git push --force(\s|$)` to get a
rule every vendor can express.

| Rule                       | Claude Code                                                            | Codex                                                                                       | Cursor                                                  | Copilot                                                              |
| -------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------- |
| `^cmd`                     | `Bash(cmd*)`: compiled                                                 | `prefix_rules` tokens: partial (only plain scripts are split; a longer last word is missed) | none                                                    | `Shell(cmd)`, `Shell(cmd *)`: partial (a longer last word is missed) |
| `^cmd(\s\|$)`, `^cmd$`     | `Bash(cmd *)`, `Bash(cmd)`: compiled                                   | prefix rule: partial                                                                        | none                                                    | `Shell(...)`: compiled                                               |
| `cmd` without `^`          | `Bash(*cmd*)`: partial (wrappers and `VAR=` are taken off first)       | none                                                                                        | none                                                    | none                                                                 |
| `.*`, classes, lookarounds | none                                                                   | none                                                                                        | none                                                    | none                                                                 |
| `path` glob                | `Read(./g)`, `Edit(./g)`: partial (`./` is the session's start folder) | none (no edit rule; only `apply_patch` reports paths)                                       | none                                                    | `Read(/g)`, `Edit(/g)`: compiled                                     |
| `url` whole site           | `WebFetch(domain:...)`: compiled (`*.` needs 2.1.172)                  | none, no hook                                                                               | none, no hook                                           | `Domain(...)`: compiled                                              |
| `tool` only                | the tool name: compiled                                                | none                                                                                        | none                                                    | none                                                                 |
| `[mcp] allow` names        | `allowedMcpServers` + `allowManagedMcpServersOnly`: compiled           | none (needs command or URL identity)                                                        | `mcpAllowlist` in `~/.cursor/permissions.json`: partial | `allowedMcpServers`: compiled                                        |
| `[models] allow` ids       | `availableModels`: partial                                             | none                                                                                        | none                                                    | none                                                                 |

Every vendor except Copilot also gets hooks that run `selfhost hook <agent>` on each event: in
the Claude Code fragment, as managed hooks in `requirements.toml` (through a script in
`/etc/codex/hooks`, as Codex asks), and in Cursor's enterprise `hooks.json`. Each vendor module
in `src/vendors/` cites the docs its mapping follows.

## Rules files and Ruler

The policy text goes to `.ruler/selfhost-policy.md`, and [Ruler](https://github.com/intellectronica/ruler)
(MIT) writes it into each agent's rules file: `CLAUDE.md` for Claude Code, `AGENTS.md` for the
others. `runRuler` (from `@selfhost/compile/ruler`) runs it with MCP propagation off, so it
writes rules files only. Everything else selfhost writes (managed settings, `requirements.toml`,
`hooks.json`, Copilot's settings) installs outside the repository, and Ruler refuses to write
outside the project, so no Ruler run, selfhost's or a person's own, overwrites them. With MCP on,
Ruler rewrites a project's `.codex/config.toml`, which is why selfhost puts no hooks there.
`test/ruler.test.ts` checks both by running Ruler.

## Versions

`VENDOR_VERSIONS` lists the vendor config versions with a golden fixture in
`fixtures/compile/<vendor>/<version>/`; the newest is the default target. See
`fixtures/README.md` for adding a version when a vendor ships one. The vendor compatibility
workflow ([`packages/vendor-compat`](../vendor-compat/README.md)) reruns the golden tests on each
new Claude Code and Codex release, checks that the CLI itself loads the files compiled for that
release, and notes a release that has no golden folder yet.
