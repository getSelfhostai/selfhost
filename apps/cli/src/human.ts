/**
 * Decisions only a person makes: approving or denying review items and exceptions, recording a
 * decision, changing a rule's mode or the team policy. The pre-tool hooks stop an agent from
 * running these commands (guard.selfhost_decision); this is the second check, in the command
 * itself, for a call the hooks never saw: it refuses inside a coding agent's session and when
 * no person is at the terminal.
 */

/**
 * Environment variables coding agents set for the commands they run. A variable that a person
 * may set in their own shell profile, such as CODEX_HOME, is not one.
 */
export const AGENT_SESSION_VARIABLES = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "CODEX_MANAGED_BY_NPM",
  "CODEX_MANAGED_BY_BUN",
  "CODEX_THREAD_ID",
  "CURSOR_AGENT",
  "OPENCODE",
  "GOOSE_TERMINAL",
  "GEMINI_CLI",
] as const;

/** The first agent session variable set in `env`, or undefined outside an agent session. */
export function agentSessionVariable(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  return AGENT_SESSION_VARIABLES.find((name) => (env[name] ?? "").trim() !== "");
}

export interface HumanCheck {
  env: Readonly<Record<string, string | undefined>>;
  /** Whether stdin is a terminal a person types into. */
  stdinIsTTY: boolean;
}

/**
 * Throws unless a person runs the command: not inside an agent session, and at a terminal.
 * `what` names the command, like "selfhost inbox approve".
 */
export function requireHuman(what: string, check: HumanCheck): void {
  const marker = agentSessionVariable(check.env);
  if (marker !== undefined) {
    throw new Error(
      `${what} is a person's decision, and this runs inside a coding agent session (${marker} is set), so it was refused. Run it yourself in a terminal outside the agent, or answer in the console.`,
    );
  }
  if (!check.stdinIsTTY) {
    throw new Error(
      `${what} is a person's decision and needs a person at a terminal; stdin is not one, so it was refused. Run it yourself in a terminal, or answer in the console.`,
    );
  }
}
