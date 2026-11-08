import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compilePolicy, VENDOR_VERSIONS } from "@selfhost/compile";
import {
  CLAUDE_CODE_HOOK_EVENTS,
  CLAUDE_CODE_HOOK_SCHEMAS,
  CODEX_HOOK_EVENTS,
  CODEX_HOOK_SCHEMAS,
  type CompileVendor,
  parseConfig,
} from "@selfhost/schema";
import { parse as parseToml } from "smol-toml";
import { isolatedEnv, type Output, run, tail, tempDir } from "./exec.js";
import { searchFiles } from "./install.js";
import {
  doctorInvalidSettings,
  doctorValidEvents,
  interfaceFields,
  missingStrings,
} from "./strings.js";
import { type Check, REPO_ROOT, type VendorRun } from "./types.js";

// Offline checks of an installed CLI: no API key, no network beyond what the CLI does on its
// own, and a fresh HOME. Each one asks whether something selfhost relies on is still there.

const POLICY = join(REPO_ROOT, "fixtures", "compile", "selfhost.toml");

/** Fields the pre-tool answer is written in (answerText in apps/cli/src/hooks/vendors.ts). */
const CLAUDE_CODEX_ANSWER = [
  "hookSpecificOutput",
  "permissionDecision",
  "permissionDecisionReason",
  "systemMessage",
];

/** The notify payload fields mapCodexNotify reads (packages/ledger/src/sources/hooks.ts). */
const CODEX_NOTIFY = ["agent-turn-complete", "thread-id", "turn-id", "input-messages"];

/** Payload and answer fields selfhost reads and writes for Cursor (apps/cli/src/hooks/vendors.ts). */
const CURSOR_FIELDS = [
  "hook_event_name",
  "conversation_id",
  "workspace_roots",
  "tool_name",
  "tool_input",
  "file_path",
  "user_message",
  "agent_message",
];

/** OpenCode plugin hook and the event fields it reads (apps/cli/src/guard/opencode-plugin.ts). */
const OPENCODE_HOOKS = ["tool.execute.before"];
const OPENCODE_FIELDS = ["sessionID", "callID"];

/** Claude Code tool inputs the pre-tool check reads, from the CLI's own sdk-tools.d.ts. */
const CLAUDE_TOOL_INPUTS: [string, string][] = [
  ["BashInput", "command"],
  ["FileReadInput", "file_path"],
  ["FileEditInput", "file_path"],
  ["FileWriteInput", "file_path"],
  ["NotebookEditInput", "notebook_path"],
  ["WebFetchInput", "url"],
];

const CODEX_REQUIREMENTS = "/etc/codex/requirements.toml";

/** What Codex must refuse, to show it reads the requirements file at all. */
const CODEX_CANARY = '[features]\nhooks = "yes"\n';

const unique = (values: Iterable<string>) => [...new Set(values)];

/** The files selfhost policy compile writes for this vendor and version, by name. */
export function compiledFiles(vendor: CompileVendor, version?: string): Map<string, string> {
  const parsed = parseConfig(readFileSync(POLICY, "utf8"));
  if (!parsed.ok) throw new Error(`${POLICY}: ${JSON.stringify(parsed.errors)}`);
  const result = compilePolicy(parsed.config, {
    vendors: [vendor],
    ...(version ? { versions: { [vendor]: version } } : {}),
  });
  return new Map((result.vendors[0]?.files ?? []).map((file) => [file.name, file.content]));
}

/** Fields a hook schema requires on at least one event. */
export function requiredFields(schemas: Record<string, unknown>): string[] {
  return unique(
    Object.values(schemas).flatMap((schema) => (schema as { required?: string[] }).required ?? []),
  ).sort();
}

function versionCheck(installed: VendorRun, out: Output, pattern: RegExp): Check {
  const found = (out.stdout + out.stderr).match(pattern)?.[1];
  if (out.status !== 0 || found === undefined) {
    return { id: "version", status: "fail", detail: `--version did not run:\n${tail(out)}` };
  }
  return found === installed.version
    ? { id: "version", status: "pass", detail: `Reports ${found}` }
    : { id: "version", status: "fail", detail: `Installed ${installed.version}, reports ${found}` };
}

function presence(id: string, what: string, files: string[], needles: string[]): Check {
  const missing = missingStrings(files, needles);
  return missing.length === 0
    ? { id, status: "pass", detail: `All ${needles.length} ${what} found: ${needles.join(", ")}` }
    : { id, status: "fail", detail: `Not found in the CLI: ${missing.join(", ")}` };
}

function claudeDoctor(bin: string, settings: unknown): Output {
  const project = tempDir("project");
  mkdirSync(join(project, ".claude"));
  writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify(settings, null, 2));
  const out = run(bin, ["doctor"], { cwd: project, env: isolatedEnv() });
  return { ...out, stdout: `${out.stdout}\n${out.stderr}` };
}

function probeClaudeCode(installed: VendorRun, bin: string): void {
  const checks = installed.checks;
  checks.push(
    versionCheck(
      installed,
      run(bin, ["--version"], { env: isolatedEnv() }),
      /^(\S+) \(Claude Code\)/m,
    ),
  );

  const settingsText = compiledFiles("claude_code", installed.version).get(
    "managed-settings.d/selfhost.json",
  );
  const settings = settingsText ? JSON.parse(settingsText) : {};
  const needed = unique([...CLAUDE_CODE_HOOK_EVENTS, ...Object.keys(settings.hooks ?? {})]);

  // Doctor lists the valid hook events when settings name one it does not know.
  const canary = claudeDoctor(bin, {
    hooks: { SelfhostProbeEvent: [{ hooks: [{ type: "command", command: "true" }] }] },
  });
  const offered = doctorValidEvents(canary.stdout);
  if (offered) {
    const missing = needed.filter((event) => !offered.includes(event));
    const known = new Set<string>(CLAUDE_CODE_HOOK_EVENTS);
    installed.unmodeled = offered.filter((event) => !known.has(event));
    checks.push(
      missing.length === 0
        ? {
            id: "hook-events",
            status: "pass",
            detail: `claude doctor lists all ${needed.length} hook events selfhost uses among its ${offered.length}`,
          }
        : {
            id: "hook-events",
            status: "fail",
            detail: `claude doctor no longer lists: ${missing.join(", ")}`,
          },
    );
  } else {
    checks.push(presence("hook-events", "hook events", [bin], needed));
  }

  checks.push(
    presence(
      "hook-fields",
      "payload and answer fields",
      [bin],
      [
        ...requiredFields(CLAUDE_CODE_HOOK_SCHEMAS),
        "transcript_path",
        "tool_use_id",
        ...CLAUDE_CODEX_ANSWER,
      ],
    ),
  );

  const dts = join(
    installed.dir ?? "",
    "node_modules",
    "@anthropic-ai",
    "claude-code",
    "sdk-tools.d.ts",
  );
  if (!existsSync(dts)) {
    checks.push({ id: "tool-inputs", status: "skip", detail: "The package has no sdk-tools.d.ts" });
  } else {
    const text = readFileSync(dts, "utf8");
    const missing = CLAUDE_TOOL_INPUTS.filter(
      ([name, field]) => !interfaceFields(text, name)?.includes(field),
    ).map(([name, field]) => `${name}.${field}`);
    checks.push(
      missing.length === 0
        ? {
            id: "tool-inputs",
            status: "pass",
            detail: `sdk-tools.d.ts still declares ${CLAUDE_TOOL_INPUTS.map(([n, f]) => `${n}.${f}`).join(", ")}`,
          }
        : {
            id: "tool-inputs",
            status: "fail",
            detail: `sdk-tools.d.ts lost ${missing.join(", ")}`,
          },
    );
  }

  if (doctorInvalidSettings(canary.stdout).length === 0) {
    checks.push({
      id: "config",
      status: "skip",
      detail: "claude doctor did not flag a known-bad settings file, so it cannot vouch for ours",
    });
  } else {
    const problems = doctorInvalidSettings(claudeDoctor(bin, settings).stdout);
    checks.push(
      problems.length === 0
        ? {
            id: "config",
            status: "pass",
            detail: "claude doctor accepts the managed settings selfhost compiles for this version",
          }
        : { id: "config", status: "fail", detail: `claude doctor: ${problems.join("\n")}` },
    );
  }
}

function canWriteEtc(): boolean {
  return process.platform === "linux" && run("sudo", ["-n", "true"]).status === 0;
}

function probeCodex(installed: VendorRun, bin: string): void {
  const checks = installed.checks;
  const env = isolatedEnv();
  checks.push(versionCheck(installed, run(bin, ["--version"], { env }), /codex-cli (\S+)/));

  const requirements = compiledFiles("codex", installed.version).get("requirements.toml") ?? "";
  const hooks = (parseToml(requirements).hooks ?? {}) as Record<string, unknown>;
  const compiledEvents = Object.keys(hooks).filter((key) => Array.isArray(hooks[key]));
  checks.push(
    presence(
      "hook-events",
      "hook events",
      [bin],
      unique([...CODEX_HOOK_EVENTS, ...compiledEvents]),
    ),
  );
  checks.push(
    presence(
      "hook-fields",
      "payload, notify and answer fields",
      [bin],
      [...requiredFields(CODEX_HOOK_SCHEMAS), "turn_id", ...CODEX_NOTIFY, ...CLAUDE_CODEX_ANSWER],
    ),
  );

  if (!canWriteEtc()) {
    checks.push({
      id: "config",
      status: "skip",
      detail: `Needs root to write ${CODEX_REQUIREMENTS}; runs on the CI runner`,
    });
    return;
  }
  if (existsSync(CODEX_REQUIREMENTS)) {
    checks.push({
      id: "config",
      status: "skip",
      detail: `${CODEX_REQUIREMENTS} already exists and is left alone`,
    });
    return;
  }
  const write = (text: string) =>
    run("sudo", ["sh", "-c", `mkdir -p /etc/codex && cat > ${CODEX_REQUIREMENTS}`], {
      input: text,
    });
  const load = () => run(bin, ["features", "list"], { env });
  try {
    write(CODEX_CANARY);
    if (load().status === 0) {
      checks.push({
        id: "config",
        status: "skip",
        detail: `Codex loaded a known-bad ${CODEX_REQUIREMENTS}, so it cannot vouch for ours`,
      });
      return;
    }
    write(requirements);
    const out = load();
    checks.push(
      out.status === 0
        ? {
            id: "config",
            status: "pass",
            detail: "Codex loads the requirements.toml selfhost compiles for this version",
          }
        : {
            id: "config",
            status: "fail",
            detail: `Codex rejects requirements.toml:\n${tail(out)}`,
          },
    );
  } finally {
    run("sudo", ["rm", "-f", CODEX_REQUIREMENTS]);
  }
}

function probeCursor(installed: VendorRun, bin: string): void {
  const checks = installed.checks;
  checks.push(
    versionCheck(installed, run(bin, ["--version"], { env: isolatedEnv() }), /^(\S+)\s*$/m),
  );
  const hooks = JSON.parse(compiledFiles("cursor").get("hooks.json") ?? "{}").hooks ?? {};
  const files = searchFiles(installed);
  checks.push(presence("hook-events", "hook events", files, Object.keys(hooks)));
  checks.push(presence("hook-fields", "payload and answer fields", files, CURSOR_FIELDS));
}

function probeOpenCode(installed: VendorRun, bin: string): void {
  const checks = installed.checks;
  checks.push(
    versionCheck(installed, run(bin, ["--version"], { env: isolatedEnv() }), /^(\S+)\s*$/m),
  );
  checks.push(presence("hook-events", "plugin hooks", [bin], OPENCODE_HOOKS));
  checks.push(presence("hook-fields", "plugin event fields", [bin], OPENCODE_FIELDS));
}

/** Runs every offline check for one installed CLI and adds them to its results. */
export function probe(installed: VendorRun): VendorRun {
  const bin = installed.bin;
  if (!bin) return installed;
  try {
    if (installed.vendor === "claude_code") probeClaudeCode(installed, bin);
    else if (installed.vendor === "codex") probeCodex(installed, bin);
    else if (installed.vendor === "cursor") probeCursor(installed, bin);
    else probeOpenCode(installed, bin);
  } catch (error) {
    installed.checks.push({
      id: "probe",
      status: "fail",
      detail: `The checks stopped: ${error instanceof Error ? error.stack : String(error)}`,
    });
  }
  if (installed.vendor === "claude_code" || installed.vendor === "codex") {
    const known: readonly string[] = VENDOR_VERSIONS[installed.vendor];
    if (!known.includes(installed.version)) {
      installed.notes = [
        ...(installed.notes ?? []),
        `No compile golden files for ${installed.version} yet (newest: ${known.at(-1)}). Review its config changes and add it to VENDOR_VERSIONS.`,
      ];
    }
  }
  return installed;
}
