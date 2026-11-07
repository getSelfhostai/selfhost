# @selfhost/policy

Evaluates the rules in `selfhost.toml` against tool calls, and records in the ledger what each
rule would have blocked. Rules are plain matches (tool name, command regex, path glob, URL glob,
MCP server and model allow lists), so the evaluator is a small pure TypeScript function instead
of OPA or Cedar: it gives the same decision for the same call and policy every time, with no
policy runtime to ship.

```ts
import { evaluate, observeLedger, policySource, toolCallFromEvent } from "@selfhost/policy";

const hits = evaluate(config, { agent: "codex", tool: "exec_command", command: "git push -f" });
// [{ rule_id, mode: "observe" | "enforce", verdict: "block" | "ask", message, irreversible }]

const source = await policySource("selfhost.toml"); // { path, hash, commit?, dirty }
await observeLedger(ledger, config, source, { repoRoot, since, team });
```

## Matching

- Every field a rule's `match` gives must match. `tool` is the exact name the agent reports
  (`Bash` for Claude Code, `exec_command` for Codex), so a rule with only `command` covers shell
  calls from every agent. `command` is a regular expression tested anywhere in the command.
  `path` and `url` are globs ([picomatch](https://github.com/micromatch/picomatch)) where `*`
  stays inside one `/` segment, `**` spans any number, and both match dotfiles.
- `[mcp] allow` is tested against the server in `mcp__<server>__<tool>`, the naming Claude Code
  and Codex share, and `[models] allow` against the model id. A call outside a non-empty list
  fires the built-in check `mcp.allow` or `models.allow`. Both are block verdicts, default to
  observe, and take team overrides like rules: `[teams.<name>.rules."mcp.allow"]`.
- `[teams.<name>.rules.<id>]` overrides mode, agents, action and message. A rule limited to some
  agents fires only when the call's agent is known and listed. Mode off never fires.
- Hits come back in a fixed order: rules in file order, then `mcp.allow`, then `models.allow`.

## Observe

`observeLedger` pages through the `tool.called` events in the ledger and appends one
`policy.evaluated` event per hit. It runs after the fact and never stops anything. A tool call
counts when its session ran inside `repoRoot` (the `cwd` of its `session.started` event) or it
touched a file there by absolute path; file paths are made relative to the root.

Each event copies `session_id`, `agent`, `model`, `repo`, `tool`, `target` and `redacted` from
the tool call, keeps its `ts`, and adds `source: "cli"`, `actor: { kind: "system", id:
"selfhost-policy" }`, `team` when one was given, `decision` (`verdict`, `by`, `reason` (the
message), `rule_id`, `mode`, `policy_commit` when the file is committed, `policy_hash`) and
`data` (`tool_event_id`, `evaluated_at`, and `irreversible: true` for irreversible rules).
`decision.mode` is the check's mode for the team: a hit from an enforce rule says what hooks
will block, not something that was blocked. The event id is derived from the tool call's id,
the rule id and the policy hash, so a second run with the same file writes nothing new and
reports the hits as duplicates; a changed file records again.

What the ledger stores limits what rules see: commands and file paths are the stored summaries
(for imported logs, the first line with secrets masked, at most 120 characters), a Codex patch
lists its first file only, and relative paths resolve against the folder the session started
in.

`policySource(path)` hashes the file (SHA-256 of its bytes) and asks git, without a shell, for
the last commit that changed it. `dirty` is true when those bytes are not the file as committed
at HEAD, including when it was never committed.
