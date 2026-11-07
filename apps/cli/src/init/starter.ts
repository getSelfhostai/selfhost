import { writeFileSync } from "node:fs";

/**
 * The selfhost.toml `selfhost init` writes at the repository root when there is none. Every
 * rule is in observe mode, so nothing is blocked until someone promotes it.
 */
export const STARTER_CONFIG = `# selfhost.toml: rules for every coding agent working in this repository.
#
# Every rule starts in observe mode: selfhost records what the rule would have done and blocks
# nothing. See the hits with \`selfhost policy report\`. When a rule catches only what it should,
# turn it on with \`selfhost policy promote <rule id>\` and review that change like any other.
# Check this file with \`selfhost policy check\`.
version = 1

# .env files usually hold secrets. Matches .env, .env.local, .env.production and the like, but
# not templates such as .env.example.
[[rules]]
id = "no-env-files"
mode = "observe"
match = { path = "**/.env?(.!(example|sample|template))" }
action = "block"
message = "Agents do not read or write .env files."

# Force pushes rewrite shared history. --force-with-lease is not matched.
[[rules]]
id = "no-force-push"
mode = "observe"
match = { command = '\\bgit\\s+(-C\\s+\\S+\\s+)?push\\b.*\\s(--force|-f)(\\s|$)' }
action = "block"
message = "Force pushes are blocked. Push a new commit or open a pull request instead."
irreversible = true

# rm -rf on / or on the home folder.
[[rules]]
id = "no-rm-rf-root-or-home"
mode = "observe"
match = { command = '\\brm\\s+(-\\S+\\s+)+"?(/|~|\\$HOME|\\$\\{HOME\\})/?\\*?"?(\\s|[;&|)]|$)' }
action = "block"
message = "rm -rf on / or on the home folder is blocked."
irreversible = true

# Piping a download straight into a shell runs code nobody has read.
[[rules]]
id = "no-curl-pipe-shell"
mode = "observe"
match = { command = '\\b(curl|wget)\\b[^|]*\\|\\s*(sudo\\s+)?(ba|z|da)?sh\\b' }
action = "ask"
message = "Download the script and read it before running it."
`;

/** Rules in the starter file, for the summary line. */
export const STARTER_RULES = 4;

/** Writes the starter file; never replaces a file that appeared in the meantime. */
export function writeStarterConfig(path: string): void {
  writeFileSync(path, STARTER_CONFIG, { flag: "wx" });
}
