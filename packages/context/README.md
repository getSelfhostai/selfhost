# @selfhost/context

One context source for every coding agent. Rules, skills, slash commands, subagents and MCP
servers live once in `.selfhost/context/` next to `selfhost.toml`, and compile into each agent's
own files: Claude Code, Codex, Cursor, Copilot, Gemini CLI, OpenCode and Goose. Where an agent
can't express an item, the coverage says so; nothing is reported as compiled that the agent
does not load.

```ts
import { applyContextPlan, buildContext } from "@selfhost/context";

const built = await buildContext(repoRoot); // reads, validates, compiles, plans the writes
if (!built.ok)
  console.error(built.errors); // { file, line, field, message }
else {
  built.result.coverage; // selfhost.context_coverage/v1: one entry per item and agent
  built.plan.drift; // files that differ from what the source compiles to (a check)
  if (built.plan.conflicts.length === 0) applyContextPlan(built.target, built.plan);
}
```

`selfhost context compile` and `selfhost context check` (in `apps/cli`) run this.

## The source

```
.selfhost/context/
  rules/<name>.md              Markdown. Front matter (all optional): agents, globs, description.
  skills/<name>/SKILL.md       Agent Skills format: name, description, version (semver), plus
                               license, compatibility, metadata, allowed-tools,
                               disable-model-invocation and agents. Other keys are kept and
                               passed on. Files beside SKILL.md ship with the skill.
  commands/<name>.md           Front matter: description, argument-hint, agents. The body is the
                               prompt; $ARGUMENTS stands for what follows the command.
  agents/<name>.md             Front matter: name (the file name), description, tools (Claude
                               Code tool names), model (one for all agents, inherit, or a map
                               by agent id), agents. The body is the system prompt.
  mcp.json                     {"mcpServers": {"<name>": {...}}}: command, args, env for stdio;
                               url, headers and type http or sse for remote servers; agents.
                               ${VAR} and ${VAR:-default} read the environment.
```

`agents` is a list of agent ids (`claude_code`, `codex`, `cursor`, `copilot`, `gemini`,
`opencode`, `goose`) or `all`, the default. Names are lowercase letters and digits joined by
`-` (and `_` for rules, commands and subagents). The TypeBox schemas are in `src/schema.ts`;
`readContextSource` reports every problem with its file and line. Markdown in the repository's
`.ruler/` folder (such as the `selfhost-policy.md` that `selfhost policy compile --apply`
writes) goes into every rules file, as Ruler would put it.

Importers write the source with `writeContextItem(root, item)` (one rule, skill, command,
subagent or MCP server; MCP servers merge into `mcp.json`) or the pure `formatContextItem`. Both
validate the item first and refuse to replace an existing one unless asked.

## Layers

`mergeLayers` merges context layers in the order org, team, repo, personal, whatever order they
are given in. Later layers add items; when two layers define the same item (`rule:<name>`, ...,
or a skill and a command with one name) the earlier layer's is kept, so the org's items are a
floor, and each lost item comes back in `conflicts` with the item that was used and a message.
`buildContext(root, { layers })` merges the given layers with the repository's own and compiles
the result; with layers, a repository without `.selfhost/context` adds nothing instead of
failing. Item paths name their layer (`org:acme/rules/x.md`, `team:web/mcp.json`,
`personal/rules/x.md`), and generated files and the lock name them as sources.

A layer travels as files in the `.selfhost/context` layout (`{path, text, executable}`, UTF-8
only): `readLayerDir` and `writeLayerDir` read and write a folder, `readLayerFiles` validates
files like `readContextSource` does, `layerHash` hashes them, and `itemFiles` and `withItem`
take one item out of a layer and add it to another (an MCP server merges into `mcp.json`). The
team server keeps the org and team layers; `apps/cli` keeps the pulled ones and the person's
own in `~/.selfhost/context/`.

## Where items go

| Item            | Claude Code                    | Codex                                        | Cursor                                 | Copilot                                                                            | Gemini CLI                              | OpenCode                      | Goose                         |
| --------------- | ------------------------------ | -------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------- | ----------------------------- |
| rule            | `CLAUDE.md`                    | `AGENTS.md`                                  | `AGENTS.md`, or `.cursor/rules/*.mdc`  | `AGENTS.md`, or `.github/copilot-instructions.md`                                  | `GEMINI.md`                             | `AGENTS.md`                   | `AGENTS.md`, or `.goosehints` |
| rule with globs | `.claude/rules/*.md` (`paths`) | `AGENTS.md`, globs as text: partial          | `.cursor/rules/*.mdc` (`globs`)        | `.github/instructions/*.instructions.md` (`applyTo`)                               | `GEMINI.md`, as text: partial           | `AGENTS.md`, as text: partial | as text: partial              |
| skill           | `.claude/skills/<name>/`       | `.agents/skills/<name>/`                     | `.agents/skills/`                      | `.agents/skills/`: partial (VS Code's Copilot harness reads only `.github/skills`) | `.agents/skills/`                       | `.agents/skills/`             | `.agents/skills/`             |
| command         | `.claude/commands/*.md`        | none (prompts are user-level and deprecated) | `.cursor/skills/<name>/`, user-invoked | `.github/prompts/*.prompt.md`: partial (VS Code only)                              | `.gemini/commands/*.toml`               | `.opencode/commands/*.md`     | none                          |
| subagent        | `.claude/agents/*.md`          | `.codex/agents/*.toml`                       | `.cursor/agents/*.md`                  | `.github/agents/*.agent.md`                                                        | `.gemini/agents/*.md`                   | `.opencode/agents/*.md`       | `.agents/agents/*.md`         |
| MCP server      | `.mcp.json`                    | `[mcp_servers]` in `.codex/config.toml`      | `.cursor/mcp.json`                     | `.mcp.json`: partial (the cloud agent uses repository settings)                    | `mcpServers` in `.gemini/settings.json` | `mcp` in `opencode.json`      | none (user config only)       |

AGENTS.md is read by Codex, Cursor, Copilot, OpenCode and Goose, so a rule for any of them goes
there once. Codex and OpenCode have no other rules file, so a rule limited to them still lands
in AGENTS.md, and the coverage lists the other agents that read it (`n/a*`). A rule only some
of the other readers want goes to each one's own file instead. Each module in `src/compile/`
cites the vendor docs its mapping follows (checked 2026-11-08), and `src/compile/agents.ts`
lists which files each agent loads on its own, which is how the coverage finds items an agent
sees twice or sees although they are not for it.

Partial and none always come with the reason: a skill key the agent ignores (`allowed-tools` on
Codex), a tool list the agent can't hold (Cursor, Codex, Gemini CLI and Goose subagents), SSE
servers on Codex and OpenCode, `${VAR}` Codex can't read from the environment, an argument
placeholder Cursor doesn't document.

## Rules files and Ruler

[Ruler](https://github.com/intellectronica/ruler) (MIT) writes `CLAUDE.md`, `AGENTS.md`,
`GEMINI.md`, `.goosehints` and `.github/copilot-instructions.md`. For each file the compile puts
the sections routed to it in a scratch project's `.ruler/` folder and runs Ruler there for that
one agent, with MCP off (`runRulerAgents` from `@selfhost/compile/ruler`, the runner the policy
compiler uses). Ruler's `<!-- Source: -->` markers are then pointed at the real source files.
Ruler never runs in the repository itself. Running `ruler apply` by hand in a repository whose
rules files selfhost compiles replaces them; put Ruler rules in `.ruler/` and compile instead.

## Headers, the lock and check

Every generated file names its source:

- Markdown and text: an HTML comment on the first line.
- Markdown with front matter (skills, scoped rules, commands, subagents): a YAML comment on the
  first line inside the front matter, since agents need `---` at the top.
- TOML (Gemini commands, Codex subagents): a `#` comment on the first line. In
  `.codex/config.toml`, which keeps the person's own settings, selfhost owns one marked block
  (`# >>> selfhost context >>>`) whose note names the source.
- JSON (`.mcp.json`, `.cursor/mcp.json`) and the files a skill ships (scripts, assets) can't hold
  a comment; no `$comment` key is added, since not every agent documents tolerating one. They,
  and the keys selfhost owns in shared JSON files (`mcpServers` in `.gemini/settings.json`, `mcp`
  in `opencode.json`), are listed with their sources in the lock.

`.selfhost/context.lock.json` is written by every compile and committed. It lists the agents the
repository compiles for (the next compile keeps them), every generated file with its sources and
a hash of what selfhost owns in it, and for each skill its version and, per agent, the status and
the version that agent received (null when it got none). A skill whose content changed while its
version stayed the same, or whose version went down, gets a warning.

`planContext` compares the compiled files with the repository: `missing`, `outdated` (the source
changed: the file still hashes as the lock says), `edited` (someone changed the file) and
`stale` (no longer compiled; the compile removes it). `selfhost context check` fails on any of
them and says what to do. A compile refuses to replace a file selfhost did not write (no header
and not in the lock) unless `--force` is given, and never replaces an MCP server defined by hand
outside its TOML block.

## Golden files

`test/golden.test.ts` compiles `fixtures/context-source/repo` for each agent alone and for all of them,
and compares the output with `fixtures/context-source/expected/<target>/`. Paths git often ignores
locally keep a `.out` suffix there (`CLAUDE.md.out`, `.claude.out/`). Regenerate on purpose and
review the diff:

```sh
UPDATE_GOLDEN=1 pnpm --filter @selfhost/context test
git diff fixtures/context-source
```
