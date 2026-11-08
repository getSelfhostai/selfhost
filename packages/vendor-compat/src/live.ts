import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseLogFile } from "@selfhost/importers";
import { mapClaudeCodeHook, mapCodexHook, mapCodexNotify } from "@selfhost/ledger";
import {
  CLAUDE_CODE_HOOK_EVENTS,
  CODEX_HOOK_EVENTS,
  type LedgerEvent,
  validateClaudeCodeHook,
  validateCodexHook,
  validateCodexNotify,
  validateEvent,
} from "@selfhost/schema";
import { isolatedEnv, type Output, run, tail, tempDir } from "./exec.js";
import type { Check, VendorRun } from "./types.js";

// A real session per CLI, when CI has an API key for it: every hook event writes its payload to a
// folder, then the payloads go through the hook schemas and mappers and the session log the CLI
// wrote goes through the importer. Without a key the step is skipped and nothing is marked broken.

export const LIVE_KEYS: Partial<Record<VendorRun["vendor"], string>> = {
  claude_code: "ANTHROPIC_API_KEY",
  codex: "OPENAI_API_KEY",
};

const PROMPT =
  "Run the shell command `echo selfhost-compat > compat.txt`, then read compat.txt and reply with its contents.";

/** Writes each payload a hook gets (stdin, or Codex notify's last argument) to its own file. */
const CAPTURE_SCRIPT = `import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [dir, kind] = process.argv.slice(2);
const body = kind === "notify" ? process.argv.at(-1) : readFileSync(0, "utf8");
writeFileSync(join(dir, \`\${kind}-\${Date.now()}-\${process.pid}.json\`), body);
`;

const NO_ACCOUNT = /\b(401|402|403|429)\b|credit|quota|rate limit|api key|authenticat|billing/i;

export interface CapturedSession {
  vendor: "claude_code" | "codex";
  /** Folder of captured payloads, named hook-*.json or notify-*.json. */
  payloads: string;
  /** Claude config dir or Codex home the session log was written to. */
  logs: string;
}

function listFiles(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return listFiles(path, ext);
    return name.endsWith(ext) ? [path] : [];
  });
}

function eventErrors(events: LedgerEvent[], where: string): string[] {
  return events.flatMap((event) => {
    const result = validateEvent(event);
    return result.ok
      ? []
      : result.errors.map((e) => `${where}: ${event.kind} ${e.field}: ${e.message}`);
  });
}

/**
 * Checks what a session left behind: each hook payload against selfhost's schema for it and
 * mapped to valid events, and the session log through the importer.
 */
export async function checkCapturedSession(session: CapturedSession): Promise<Check[]> {
  const problems: string[] = [];
  const fired = new Set<string>();
  const ctx = { ts: new Date().toISOString(), person: "compat@example.com" };
  for (const file of listFiles(session.payloads, ".json").sort()) {
    const name = file.slice(file.lastIndexOf("/") + 1);
    let payload: unknown;
    try {
      payload = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      problems.push(`${name}: not JSON`);
      continue;
    }
    const notify = name.startsWith("notify-");
    const validate =
      session.vendor === "claude_code"
        ? validateClaudeCodeHook
        : notify
          ? validateCodexNotify
          : validateCodexHook;
    const result = validate(payload);
    const event = String(
      (payload as Record<string, unknown>)[notify ? "type" : "hook_event_name"] ?? "?",
    );
    fired.add(event);
    if (!result.ok) {
      for (const e of result.errors) problems.push(`${event} ${e.field}: ${e.message}`);
      continue;
    }
    const map =
      session.vendor === "claude_code" ? mapClaudeCodeHook : notify ? mapCodexNotify : mapCodexHook;
    try {
      problems.push(...eventErrors(map(payload, ctx), event));
    } catch (error) {
      problems.push(`${event}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const known: readonly string[] =
    session.vendor === "claude_code" ? CLAUDE_CODE_HOOK_EVENTS : CODEX_HOOK_EVENTS;
  const unmodeled = [...fired].filter((e) => !known.includes(e) && e !== "agent-turn-complete");
  const checks: Check[] = [];
  if (fired.size === 0) {
    checks.push({ id: "live-hooks", status: "fail", detail: "No hook fired during the session" });
  } else if (!fired.has("PreToolUse")) {
    checks.push({
      id: "live-hooks",
      status: "fail",
      detail: `PreToolUse did not fire; fired: ${[...fired].sort().join(", ")}`,
    });
  } else {
    checks.push(
      problems.length === 0
        ? {
            id: "live-hooks",
            status: "pass",
            detail: `Payloads match the schemas and map to valid events: ${[...fired].sort().join(", ")}${unmodeled.length ? `. Not modeled: ${unmodeled.join(", ")}` : ""}`,
          }
        : { id: "live-hooks", status: "fail", detail: problems.slice(0, 20).join("\n") },
    );
  }

  const logRoot = session.vendor === "claude_code" ? join(session.logs, "projects") : session.logs;
  const logs = listFiles(logRoot, ".jsonl");
  const events: LedgerEvent[] = [];
  const importProblems: string[] = [];
  for (const file of logs) {
    try {
      const parsed = await parseLogFile(session.vendor, file, {
        since: new Date(0),
        actorId: "compat",
      });
      events.push(...parsed.events);
      importProblems.push(...eventErrors(parsed.events, file.slice(logRoot.length + 1)));
    } catch (error) {
      importProblems.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const kinds = new Set<string>(events.map((e) => e.kind));
  const missing = ["session.started", "tool.called"].filter((kind) => !kinds.has(kind));
  checks.push(
    logs.length === 0
      ? { id: "live-import", status: "fail", detail: `No session log under ${logRoot}` }
      : importProblems.length > 0 || missing.length > 0
        ? {
            id: "live-import",
            status: "fail",
            detail: [
              ...(missing.length ? [`No ${missing.join(" or ")} event in the import`] : []),
              ...importProblems.slice(0, 20),
            ].join("\n"),
          }
        : {
            id: "live-import",
            status: "pass",
            detail: `${logs.length} log file(s) imported as ${events.length} valid events: ${[...kinds].sort().join(", ")}`,
          },
  );
  return checks;
}

function hookCommand(script: string, dir: string, kind: string): string {
  return `node ${JSON.stringify(script)} ${JSON.stringify(dir)} ${kind}`;
}

function sessionFolders() {
  const payloads = tempDir("payloads");
  const script = join(tempDir("capture"), "capture.mjs");
  writeFileSync(script, CAPTURE_SCRIPT);
  const project = tempDir("project");
  run("git", ["init", "-q"], { cwd: project });
  writeFileSync(join(project, "README.md"), "# compat\n");
  return { payloads, script, project };
}

function sessionCheck(out: Output): Check | undefined {
  if (out.status === 0) return undefined;
  const text = tail(out, 20);
  // An account problem (key, credit, rate limit) says nothing about the CLI release.
  return NO_ACCOUNT.test(text)
    ? { id: "live-session", status: "skip", detail: `The API refused the session:\n${text}` }
    : { id: "live-session", status: "fail", detail: `The session failed:\n${text}` };
}

async function liveClaudeCode(bin: string, key: string): Promise<Check[]> {
  const { payloads, script, project } = sessionFolders();
  const env = isolatedEnv({ ANTHROPIC_API_KEY: key });
  const hooks = Object.fromEntries(
    CLAUDE_CODE_HOOK_EVENTS.map((event) => [
      event,
      [{ hooks: [{ type: "command", command: hookCommand(script, payloads, "hook") }] }],
    ]),
  );
  const settings = join(project, "compat-settings.json");
  writeFileSync(settings, JSON.stringify({ hooks }));
  const model = process.env.COMPAT_CLAUDE_MODEL || "haiku";
  const out = run(
    bin,
    [
      "-p",
      PROMPT,
      "--settings",
      settings,
      "--model",
      model,
      "--max-budget-usd",
      "0.25",
      "--allowedTools",
      "Bash(echo:*),Read",
      "--permission-mode",
      "acceptEdits",
      "--output-format",
      "json",
    ],
    { cwd: project, env, timeoutMs: 300_000 },
  );
  const failed = sessionCheck(out);
  if (failed) return [failed];
  const session = {
    id: "live-session",
    status: "pass",
    detail: `claude -p with ${model}`,
  } as const;
  const logs = env.CLAUDE_CONFIG_DIR ?? "";
  return [session, ...(await checkCapturedSession({ vendor: "claude_code", payloads, logs }))];
}

async function liveCodex(bin: string, key: string): Promise<Check[]> {
  const { payloads, script, project } = sessionFolders();
  const env = isolatedEnv({ CODEX_API_KEY: key, OPENAI_API_KEY: key });
  const home = env.CODEX_HOME ?? "";
  mkdirSync(home, { recursive: true });
  const command = JSON.stringify(hookCommand(script, payloads, "hook"));
  const config = [
    `notify = ${JSON.stringify(["node", script, payloads, "notify"])}`,
    "",
    "[features]",
    "hooks = true",
    ...CODEX_HOOK_EVENTS.flatMap((event) => [
      "",
      `[[hooks.${event}]]`,
      `[[hooks.${event}.hooks]]`,
      'type = "command"',
      `command = ${command}`,
    ]),
    "",
  ].join("\n");
  writeFileSync(join(home, "config.toml"), config);
  const model = process.env.COMPAT_CODEX_MODEL;
  const out = run(
    bin,
    [
      "exec",
      "--skip-git-repo-check",
      "--dangerously-bypass-hook-trust",
      "--sandbox",
      "workspace-write",
      ...(model ? ["--model", model] : []),
      PROMPT,
    ],
    { cwd: project, env, timeoutMs: 300_000 },
  );
  const failed = sessionCheck(out);
  if (failed) return [failed];
  const session = {
    id: "live-session",
    status: "pass",
    detail: `codex exec with ${model ?? "the default model"}`,
  } as const;
  return [session, ...(await checkCapturedSession({ vendor: "codex", payloads, logs: home }))];
}

/** Runs a live session when the vendor's key is set, else records why it was skipped. */
export async function live(installed: VendorRun): Promise<VendorRun> {
  const name = LIVE_KEYS[installed.vendor];
  const key = name ? process.env[name] : undefined;
  if (!installed.bin) return installed;
  if (!name) {
    installed.checks.push({
      id: "live-session",
      status: "skip",
      detail: "No live session for this CLI yet",
    });
    return installed;
  }
  if (!key) {
    installed.checks.push({
      id: "live-session",
      status: "skip",
      detail: `No ${name} secret, so no live session ran`,
    });
    return installed;
  }
  try {
    const checks =
      installed.vendor === "claude_code"
        ? await liveClaudeCode(installed.bin, key)
        : await liveCodex(installed.bin, key);
    // CLI output goes on the public page: never let the key through, even in an error.
    installed.checks.push(
      ...checks.map((check) => ({ ...check, detail: check.detail.replaceAll(key, "[key]") })),
    );
  } catch (error) {
    installed.checks.push({
      id: "live-session",
      status: "fail",
      detail: `The live check stopped: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  return installed;
}
