# @selfhost/policy

Evaluates the rules in `selfhost.toml` and the built-in guardrails against tool calls, and records
in the ledger what each rule would have blocked. Rules are plain matches (tool name, command regex,
path glob, URL glob, MCP server and model allow lists), so the evaluator is a small pure TypeScript
function instead of OPA or Cedar: it gives the same decision for the same call and policy every
time, with no policy runtime to ship.

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

## Guardrails

`guardrailHits(config, call, context)` runs the built-in guardrails, each a rule with a stable
id that gives `PolicyHit`s in the mode `[guardrails] mode` sets (default enforce; `disable`
turns single ones off). `checkToolCall(config, call, options)` is what pre-tool hooks run: the
rules and allow lists (`evaluate`), then the guardrails, then extra checkers, and the verdict.
Enforce hits decide, block before ask; observe hits are listed and never applied. The
`@selfhost/policy/pretool` entry point exports only this, so a hook does not load the ledger.

```ts
import { checkToolCall } from "@selfhost/policy/pretool";

const decision = await checkToolCall(config, call, { env: process.env, realpath, checkers });
// { verdict: "allow" | "block" | "ask", hit?, hits, failures }
```

An extra checker is `(call, config, { signal }) => Promise<PolicyHit[]>`. Checkers run in
parallel within `budgetMs` (default 2000); one that throws or is still running then gives no hits,
is listed in `failures`, and the call goes ahead.

Shell commands are read with [shell-quote](https://github.com/ljharb/shell-quote) and split into
simple commands (`&&`, `||`, `;`, `|`, `&`, newlines outside quotes, subshells). The guardrails
look through `sudo`, `doas`, `env`, `nice`, `nohup`, `time`, `timeout`, `command`, `exec`,
`xargs`, `stdbuf`, `ionice` and `caffeinate`, leading `NAME=value` words, `bash -c`, `sh -c` and
other shells' `-c`, `eval`, `$(...)` and backticks (also inside double quotes), `<(...)`,
`env -S`, `find -exec`, and `cd` earlier in the line, and follow `NAME=value` and `export` set
earlier in the line. Heredoc bodies are read as commands, which catches `bash <<EOF` and can
flag text written to a file the same way.

| Rule id                      | Fires on                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `guard.force_push`           | `git push` with `--force`, `-f` (also in clusters such as `-uf`), `--mirror` or a `+refspec`, past git's global options. `--force-with-lease` asks: it only protects commits the agent has not fetched, and agents fetch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `guard.reset_hard`           | `git reset --hard`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `guard.rm_outside_workspace` | Recursive `rm` (`-r`, `-R`, `--recursive`) of a path outside the workspace root (the repository root, else the call's folder) and outside `/tmp`, `/private/tmp`, `/var/tmp` and `$TMPDIR`, resolved against `cd`, `~`, `$HOME` and variables set in the line, and through symlinks (`rm x/` follows a link, `rm x` removes the link). The workspace, the home folder or a folder holding either is always blocked. A target that cannot be resolved before it runs (`$UNKNOWN`, `$(...)`, `xargs`, `find -exec`) asks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `guard.secret_read`          | A file tool reading a secret file (Claude Code `Read`, `Grep`, `Edit` and `MultiEdit`, which echo the file back; Cursor `beforeReadFile`; OpenCode `read`, `edit`, `grep`), and the file operands of shell readers (`cat`, `less`, `head`, `tail`, `grep`, `rg`, `awk`, `sed`, `jq`, `base64`, `xxd`, `tar`, `zip` and the like), copy sources (`cp`, `scp`, `rsync`), `<` redirects, `curl -d @file`, `-T`, `file://`, `openssl -in`, `ssh-keygen -f`, `ssh -i`, `dd if=` and `git show rev:path`. Secret files: `.env`, `.env.*` and `*.env` except `.example`, `.sample`, `.template` and `.dist`; `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519` and their `_sk` forms; `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.p8`, `*.jks`, `*.keystore`, `*.ppk`, `*.kdbx`; `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`, `.pgpass`, `.my.cnf`, `.htpasswd`, `.boto`, `.s3cfg`, `.vault-token`, `.credentials.json`, `credentials.json`, `secrets.{json,yml,yaml}`; and by place `~/.ssh` (not `*.pub`, `known_hosts`, `config`, `authorized_keys`), `~/.gnupg`, `~/.aws/credentials` and its token caches, `~/.docker/config.json`, `~/.kube/config`, `~/.config/gcloud`, `~/.config/gh/hosts.yml`, Azure token caches, Terraform's credentials file, the Codex, Cursor and OpenCode login files and `~/.selfhost/config.json`. Writing a secret file and naming it (`echo .env >> .gitignore`, `ls`, `chmod`) is not a read. |
| `guard.prod_sql`             | A command with `DROP TABLE`, `DROP DATABASE` (and schema, view, index, role and the like) or `TRUNCATE`, or `dropdb`, `mysqladmin drop`, `rails db:drop`, that names a connection matching `prod_connections`: a word, a URL's host or database, a `key=value`'s parts or a `$VARIABLE` name. Off until something is marked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `guard.prod_credentials`     | A command that reads or sets a variable matching `prod_credentials` (`$PROD_TOKEN`, `PROD_TOKEN=...`), passes a matching `--profile`, `--context`, `--kube-context`, `--project`, `--account`, `--subscription` or `--org`, sets a matching `*PROFILE*`, `*CONTEXT*` or `*PROJECT*` variable or `kubectl config use-context`, or reads a file matching a marker that starts with `/` or `~/` (also through `--kubeconfig`, `GOOGLE_APPLICATION_CREDENTIALS` and `KUBECONFIG`); and `env`, `printenv`, `export -p` or `set` alone while a matching variable is in the environment. Off until something is marked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Every guardrail hit carries an `alternative` (`GUARDRAILS[id].alternative`, more specific for
some findings, such as `--force-with-lease`), which the hooks show the agent with the message:
push to a new branch and open a pull request instead of a force push; commit, stash or `git
restore <file>` instead of `git reset --hard`; delete inside the workspace or leave it to the
user; read `.env.example` or ask for the one value instead of reading a secret file; run DROP or
TRUNCATE on a local or staging database or as a migration a person applies; use development
credentials or let the user run the production step. Rules give theirs in `alternative`, and
`[mcp]` and `[models]` hits have one too. `~/.selfhost/exceptions/key`, which signs one-time
exceptions, counts as a secret file.

### Known bypasses

The guardrails read the command text before it runs. They do not run it, read the files it
runs, or know the shell's aliases, functions and profile, so these get through (each is a test
in `test/bypasses.test.ts`, which fails if a change starts catching it):

- A script written first and then run (`printf 'rm -rf /etc' > x.sh && sh x.sh`), an encoded
  command (`echo ... | base64 -d | sh`), a command held in a variable (`cmd="rm -rf /etc"; $cmd`),
  an interpreter (`python3 -c`, `node -e`, `perl -e`), `make` and package scripts.
- Shell aliases and functions, git aliases (`git config alias.fp 'push --force'`), a forcing
  refspec in git config, and wrappers it does not know (`parallel`).
- Other ways to delete or drop work: `find -delete`, `rsync --delete`, `mv`, `git checkout -- .`,
  `git clean -fdx`, `git restore`, `git push origin :branch`; a symlink made in the same command.
- Secrets read by a program itself (`python3 -c "open('.env')"`), `source .env` and then printing,
  a glob (`cat .e*`), an archive of the folder, `git diff` of the file, and tools that print
  resolved settings (`docker compose config`). `Grep` over a folder is not checked.
- SQL in a file (`psql -f drop.sql`) or a connection set outside the command (`PGHOST` in the
  shell profile); credentials selected outside the command (`AWS_PROFILE` exported in the
  profile); MCP database tools (use a rule on the tool name).

Known false positives, all on the safe side: heredoc text written to a file can be read as
commands; `rm -rf $(pwd)/build` asks; public certificates named `*.pem` and `sed -i` on a `.env`
file are blocked.

## Promote

`promoteRule(text, ruleId, { team?, to? })` changes one rule's mode in selfhost.toml text (by
default to enforce) and `setGuardrailsMode(text, to?)` sets `[guardrails] mode`. Each changes
only the mode line, or adds one line, so comments, quoting and key order stay as written, and
returns `{ text, changed, from, to, line }`. `selfhost policy promote` and the console's "Start
blocking" both use them. The `@selfhost/policy/promote` entry point imports only
`@selfhost/schema`, so it loads in a browser.
