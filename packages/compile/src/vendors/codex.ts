import { CODEX_HOOK_EVENTS, type RuleAction } from "@selfhost/schema";
import { combine, notApplicable, notExpressible, type Part, unmapped } from "../mapping.js";
import { type CommandForm, reduceCommand, unplainReason } from "../regex.js";
import { targetOf } from "../target.js";
import type { Check, InstallPaths, Mapping, VendorCompiler } from "../types.js";

// Codex docs, checked 2026-11-08 (developers.openai.com/codex redirects to learn.chatgpt.com):
// - requirements.toml locations, [rules] prefix_rules (decision prompt or forbidden only),
//   [mcp_servers.<name>] identity by command or url, [permissions.filesystem] deny_read:
//   https://learn.chatgpt.com/docs/enterprise/managed-configuration
// - prefix_rule tokens, exact-prefix matching, and splitting of plain bash -lc scripts:
//   https://learn.chatgpt.com/docs/agent-configuration/rules
// - Managed hooks under [hooks] in requirements.toml, managed_dir, [features] hooks = true,
//   tool_name values (Bash, apply_patch, mcp__*), no hooks for hosted tools, ask unsupported:
//   https://learn.chatgpt.com/docs/hooks
export const CODEX_DOCS = [
  "https://learn.chatgpt.com/docs/enterprise/managed-configuration",
  "https://learn.chatgpt.com/docs/agent-configuration/rules",
  "https://learn.chatgpt.com/docs/hooks",
];

const REQUIREMENTS_PATHS: InstallPaths = {
  darwin: "/etc/codex/requirements.toml",
  linux: "/etc/codex/requirements.toml",
  win32: "C:\\ProgramData\\OpenAI\\Codex\\requirements.toml",
};

const HOOK_DIR = "/etc/codex/hooks";
const WINDOWS_HOOK_DIR = "C:\\ProgramData\\OpenAI\\Codex\\hooks";
const HOOK_SCRIPT = "selfhost-hook";

interface Entry {
  tokens: string[];
  decision: "forbidden" | "prompt";
  justification: string;
}

/** Tools Codex runs on its servers, which fire no hooks. */
const HOSTED_TOOLS = new Set(["WebSearch", "web_search"]);

const SPLITTING =
  "Codex splits a shell script into commands only when it is plain words joined by &&, ||, ; or |, so commands with redirections, $(...) or variables are missed";

function commandPart(form: CommandForm, action: RuleAction, message: string): Part<Entry> {
  const why = unplainReason(form.text);
  if (why) return unmapped(why);
  if (!form.start) {
    return unmapped(
      `prefix rules match from a command's first word, and ${form.text} has no ^ before it`,
    );
  }
  const text = form.text.trimEnd();
  const tokens = text.split(" ");
  const last = tokens[tokens.length - 1] as string;
  const gaps = [SPLITTING];
  if (form.end === "open" && !form.text.endsWith(" ")) {
    gaps.push(
      `a prefix rule matches whole words, so a last word that only starts with ${last} is missed`,
    );
  }
  if (form.end === "boundary") {
    gaps.push(`\\b also matches ${last} followed by punctuation, which a prefix rule misses`);
  }
  const decision = action === "block" ? "forbidden" : "prompt";
  return {
    entries: [{ tokens, decision, justification: message }],
    native: [`prefix_rule ${JSON.stringify(tokens)} ${decision}`],
    gap: gaps.join("; "),
  };
}

function commandMapping(pattern: string, check: Check): Mapping<Entry> {
  const reduced = reduceCommand(pattern);
  if (!reduced.ok) {
    return notExpressible(
      `Codex prefix rules match literal words, and the regular expression ${reduced.reason}.`,
      true,
    );
  }
  return combine(
    reduced.forms.map((form) => commandPart(form, check.action, check.message)),
    true,
  );
}

const TOOL_GAPS: Record<string, string> = {
  shell: "A prefix rule needs at least one word, so requirements.toml can't stop every command.",
  edit: "requirements.toml has no rule for apply_patch.",
  mcp: "requirements.toml allows or blocks whole MCP servers, not single tools.",
  other: "requirements.toml has no rule for single tools.",
};

function mapping(check: Check): Mapping<Entry> {
  if (check.list?.kind === "mcp") {
    return notExpressible(
      "requirements.toml allows an MCP server by its command or URL ([mcp_servers.<name>] identity), and [mcp] allow lists names only.",
      true,
    );
  }
  if (check.list?.kind === "models") {
    return notExpressible("requirements.toml has no model allow list.", true);
  }
  if (check.list?.kind === "egress") {
    return notExpressible(
      "Codex's sandbox turns network access on or off and has no host allow list.",
      true,
    );
  }
  const target = targetOf("codex", check.match ?? {});
  switch (target.kind) {
    case "never":
      return notApplicable(`${target.reason}.`);
    case "combined":
      return notExpressible("Codex prefix rules match commands only.", true);
    case "command":
      return commandMapping(target.pattern, check);
    case "path":
      return notExpressible(
        "Codex reports file paths only for apply_patch edits, and requirements.toml can deny reads ([permissions.filesystem] deny_read) but not edits.",
        true,
      );
    case "url":
      return notExpressible(
        "Codex has no fetch tool that reports a URL, and its hosted web search runs no hooks.",
        false,
      );
    case "tool":
      if (HOSTED_TOOLS.has(target.tool)) {
        return notExpressible(
          `requirements.toml has no rule for ${target.tool}, and hosted tools run no hooks.`,
          false,
        );
      }
      return notExpressible(TOOL_GAPS[target.toolKind] ?? (TOOL_GAPS.other as string), true);
  }
}

const str = (value: string) => JSON.stringify(value);

function prefixRule(entry: Entry): string {
  const pattern = entry.tokens.map((token) => `{ token = ${str(token)} }`).join(", ");
  return `  { pattern = [${pattern}], decision = ${str(entry.decision)}, justification = ${str(entry.justification)} },`;
}

function requirements(entries: Entry[]): string {
  const lines = [
    "# Codex requirements from selfhost.toml, written by selfhost policy compile.",
    "# Change selfhost.toml and compile again instead of editing this file.",
    "",
    "[features]",
    "hooks = true",
  ];
  if (entries.length > 0) {
    lines.push("", "[rules]", "prefix_rules = [", ...entries.map(prefixRule), "]");
  }
  lines.push(
    "",
    "[hooks]",
    `managed_dir = ${str(HOOK_DIR)}`,
    `windows_managed_dir = ${str(WINDOWS_HOOK_DIR)}`,
  );
  return `${lines.join("\n")}\n`;
}

function hookTables(hookCommand: string): string {
  return CODEX_HOOK_EVENTS.map((event) =>
    [
      `[[hooks.${event}]]`,
      "",
      `[[hooks.${event}.hooks]]`,
      'type = "command"',
      `command = ${str(`${HOOK_DIR}/${HOOK_SCRIPT}`)}`,
      `command_windows = ${str(hookCommand)}`,
    ].join("\n"),
  ).join("\n\n");
}

/**
 * Codex: requirements.toml with forbidden and prompt prefix rules and managed hooks that run
 * selfhost hook through a script in the managed hooks folder.
 */
export const codex: VendorCompiler = ({ version, checks, hookCommand }) => {
  const mappings = new Map<string, Mapping<Entry>>();
  const entries: Entry[] = [];
  for (const check of checks) {
    const result = mapping(check);
    mappings.set(check.id, result);
    if (check.mode === "enforce") entries.push(...result.entries);
  }
  const content = `${requirements(entries)}\n${hookTables(hookCommand)}\n`;
  const script = [
    "#!/bin/sh",
    "# Runs selfhost's hook for Codex. requirements.toml points Codex's managed hooks here.",
    `exec ${hookCommand}`,
    "",
  ].join("\n");
  const notes = [
    "requirements.toml applies to every Codex session on the machine, and users can't override it. It is one file: merge by hand if your organization already has one.",
    "Managed hooks skip the /hooks trust review, and [features] hooks = true turns hooks on where a user turned them off. If selfhost agents configure also added hooks to ~/.codex, Codex runs both.",
    "Codex's docs say rules decide which commands run outside the sandbox. Whether forbidden also stops a command Codex runs inside the sandbox needs a real Codex session to confirm.",
  ];
  if (checks.some((check) => check.action === "ask")) {
    notes.push("Codex hooks can't ask yet: an ask from the selfhost hook lets the call run.");
  }
  return {
    output: {
      vendor: "codex",
      version,
      files: [
        {
          name: "requirements.toml",
          content,
          description: "Codex requirements: forbidden and prompt prefix rules and managed hooks.",
          install: { kind: "system", paths: REQUIREMENTS_PATHS, mode: "0644" },
        },
        {
          name: `hooks/${HOOK_SCRIPT}`,
          content: script,
          description: "Script Codex's managed hooks run on macOS and Linux.",
          install: {
            kind: "system",
            paths: { darwin: `${HOOK_DIR}/${HOOK_SCRIPT}`, linux: `${HOOK_DIR}/${HOOK_SCRIPT}` },
            mode: "0755",
          },
        },
      ],
      calls: [],
    },
    mappings,
    coverage: { vendor: "codex", version, docs: CODEX_DOCS, notes },
  };
};
