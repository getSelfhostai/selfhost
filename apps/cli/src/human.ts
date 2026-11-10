/**
 * Decisions only a person makes: approving or denying review items and exceptions, recording a
 * decision, changing a rule's mode or the team policy. The pre-tool hooks stop an agent from
 * running these commands (guard.selfhost_decision); this is the second check, in the command
 * itself, for a call the hooks never saw: it refuses inside a coding agent's session and when
 * no person is at the terminal.
 */

/**
 * Environment variables coding agents set for the commands they run. A variable that a person
 * may set in their own shell profile, such as CODEX_HOME, is not one, and neither is one an
 * editor sets in every terminal it opens, such as CURSOR_TRACE_ID.
 *
 * - Claude Code: CLAUDECODE, CLAUDE_CODE, CLAUDE_CODE_ENTRYPOINT, CLAUDE_CODE_SESSION_ID.
 * - Codex: CODEX_SANDBOX, CODEX_SANDBOX_NETWORK_DISABLED, CODEX_CI, CODEX_THREAD_ID and the
 *   CODEX_MANAGED_BY_* of its installers.
 * - Cursor's agent: CURSOR_AGENT, and CURSOR_EXTENSION_HOST_ROLE=agent-exec.
 * - OpenCode: OPENCODE, OPENCODE_CLIENT. Goose: GOOSE_TERMINAL. Gemini CLI: GEMINI_CLI.
 * - Augment: AUGMENT_AGENT. Antigravity: ANTIGRAVITY_AGENT.
 * - AI_AGENT, the name several agents (GitHub Copilot among them) set for the tools they run.
 */
export const AGENT_SESSION_VARIABLES = [
  "AI_AGENT",
  "CLAUDECODE",
  "CLAUDE_CODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "CODEX_CI",
  "CODEX_MANAGED_BY_NPM",
  "CODEX_MANAGED_BY_BUN",
  "CODEX_THREAD_ID",
  "CURSOR_AGENT",
  "OPENCODE",
  "OPENCODE_CLIENT",
  "GOOSE_TERMINAL",
  "GEMINI_CLI",
  "AUGMENT_AGENT",
  "ANTIGRAVITY_AGENT",
] as const;

/** Variables that mark an agent session only with this value. */
const AGENT_SESSION_VALUES: Readonly<Record<string, string>> = {
  CURSOR_EXTENSION_HOST_ROLE: "agent-exec",
};

/** The first agent session variable set in `env`, or undefined outside an agent session. */
export function agentSessionVariable(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const named = AGENT_SESSION_VARIABLES.find((name) => (env[name] ?? "").trim() !== "");
  if (named !== undefined) return named;
  return Object.keys(AGENT_SESSION_VALUES).find(
    (name) => (env[name] ?? "").trim() === AGENT_SESSION_VALUES[name],
  );
}

export interface HumanCheck {
  env: Readonly<Record<string, string | undefined>>;
  /** Whether stdin is a terminal a person types into. */
  stdinIsTTY: boolean;
}

/**
 * Throws unless a person runs the command: not inside an agent session, and at a terminal.
 * `what` names the command, like "selfhost inbox approve". `elsewhere` is where else a person
 * can do it, named in the refusal; null when only the command does it.
 */
export function requireHuman(
  what: string,
  check: HumanCheck,
  elsewhere: string | null = "answer in the console",
): void {
  const or = elsewhere === null ? "" : `, or ${elsewhere}`;
  const marker = agentSessionVariable(check.env);
  if (marker !== undefined) {
    throw new Error(
      `${what} is a person's decision, and this runs inside a coding agent session (${marker} is set), so it was refused. Run it yourself in a terminal outside the agent${or}.`,
    );
  }
  if (!check.stdinIsTTY) {
    throw new Error(
      `${what} is a person's decision and needs a person at a terminal; stdin is not one, so it was refused. Run it yourself in a terminal${or}.`,
    );
  }
}
