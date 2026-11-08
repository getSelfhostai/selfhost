import { CURSOR_HOOK_EVENTS } from "@selfhost/agents";
import picomatch from "picomatch/posix.js";
import { code, combine, notApplicable, notExpressible } from "../mapping.js";
import { targetOf } from "../target.js";
import type { Check, InstallPaths, Mapping, OutputFile, VendorCompiler } from "../types.js";

// Cursor docs, checked 2026-11-08:
// - hooks.json format and enterprise paths, preToolUse tool names, fail-open by default:
//   https://cursor.com/docs/hooks
// - Team rules: dashboard only, Teams and Enterprise, no API: https://cursor.com/docs/rules
//   and https://cursor.com/docs/account/teams/admin-api
// - MCP allowlist: dashboard (Enterprise), or ~/.cursor/permissions.json mcpAllowlist with
//   server:tool entries delivered by device management:
//   https://cursor.com/docs/enterprise/model-and-integration-management
// - CLI permissions in cli-config.json are per user and CLI only:
//   https://cursor.com/docs/cli/reference/permissions
export const CURSOR_DOCS = [
  "https://cursor.com/docs/hooks",
  "https://cursor.com/docs/rules",
  "https://cursor.com/docs/enterprise/model-and-integration-management",
  "https://cursor.com/docs/cli/reference/permissions",
];

const HOOKS_PATHS: InstallPaths = {
  darwin: "/Library/Application Support/Cursor/hooks.json",
  linux: "/etc/cursor/hooks.json",
  win32: "C:\\ProgramData\\Cursor\\hooks.json",
};

const PERMISSIONS_PATHS: InstallPaths = {
  darwin: "~/.cursor/permissions.json",
  linux: "~/.cursor/permissions.json",
  win32: "~/.cursor/permissions.json",
};

type Entry = { kind: "mcp"; entry: string };

const NO_MANAGED_RULES =
  "Cursor has no admin-managed deny list for %s: the team dashboard sets run modes and has no API, and cli-config.json permissions are per user and CLI only.";

function mcpMapping(allow: string[]): Mapping<Entry> {
  // Cursor's * matches any characters; other glob syntax has no equivalent.
  const bad = allow.filter((name) => {
    const scan = picomatch.scan(name);
    return !/^[A-Za-z0-9_.*-]+$/.test(name) || scan.isBrace || scan.isExtglob;
  });
  if (bad.length > 0) {
    return notExpressible(
      `Cursor's mcpAllowlist takes names with * wildcards, and ${bad.map(code).join(", ")} ${bad.length === 1 ? "is not one" : "are not"}.`,
      true,
    );
  }
  return combine(
    [
      {
        entries: allow.map((name): Entry => ({ kind: "mcp", entry: `${name}:*` })),
        native: allow.map((name) => `mcpAllowlist: ${name}:*`),
        gap: "~/.cursor/permissions.json sits in each user's home, so it holds only where device management delivers and locks it, and a dashboard MCP allowlist replaces it",
      },
    ],
    true,
  );
}

function mapping(check: Check): Mapping<Entry> {
  if (check.list?.kind === "mcp") return mcpMapping(check.list.allow);
  if (check.list?.kind === "models") {
    return notExpressible(
      "Cursor sets model access in the team dashboard, which selfhost does not write, and its hooks don't report the model.",
      false,
    );
  }
  const target = targetOf("cursor", check.match ?? {});
  switch (target.kind) {
    case "never":
      return notApplicable(`${target.reason}.`);
    case "url":
      return notExpressible(
        "Cursor's hooks don't name a fetch tool, so neither a native rule nor the selfhost hook sees the URL.",
        false,
      );
    case "command":
      return notExpressible(NO_MANAGED_RULES.replace("%s", "commands"), true);
    case "path":
      return notExpressible(NO_MANAGED_RULES.replace("%s", "files"), true);
    default:
      return notExpressible(NO_MANAGED_RULES.replace("%s", "tools"), true);
  }
}

/**
 * Cursor: enterprise hooks.json that runs selfhost hook on every agent event, the policy text
 * to paste into the dashboard's team rules, and an mcpAllowlist for device management.
 */
export const cursor: VendorCompiler = ({ version, checks, hookCommand, rulesText }) => {
  const mappings = new Map<string, Mapping<Entry>>();
  const allowlist: string[] = [];
  for (const check of checks) {
    const result = mapping(check);
    mappings.set(check.id, result);
    if (check.mode === "enforce") allowlist.push(...result.entries.map((entry) => entry.entry));
  }
  const hooks = {
    version: 1,
    hooks: Object.fromEntries(
      CURSOR_HOOK_EVENTS.map((event) => [event, [{ command: hookCommand }]]),
    ),
  };
  const files: OutputFile[] = [
    {
      name: "hooks.json",
      content: `${JSON.stringify(hooks, null, 2)}\n`,
      description: "Cursor enterprise hooks that run selfhost hook on every agent event.",
      install: { kind: "system", paths: HOOKS_PATHS, mode: "0644" },
    },
  ];
  if (rulesText !== "") {
    files.push({
      name: "team-rules.md",
      content: rulesText,
      description: "The policy as a Cursor team rule. Turn on Enforce this rule when you add it.",
      install: {
        kind: "dashboard",
        where: "Cursor dashboard, Team content, Rules (https://cursor.com/dashboard/team-content)",
      },
    });
  }
  if (allowlist.length > 0) {
    files.push({
      name: "permissions.json",
      content: `${JSON.stringify({ mcpAllowlist: allowlist }, null, 2)}\n`,
      description: "Cursor MCP allowlist for device management to deliver to each user.",
      install: { kind: "mdm", paths: PERMISSIONS_PATHS },
    });
  }
  const notes = [
    "The enterprise hooks.json applies to every user on the machine. Cursor runs hooks fail-open: a crash or timeout lets the call through unless failClosed is set, which selfhost leaves off. If selfhost agents configure also wrote ~/.cursor/hooks.json, Cursor runs both.",
    "Team rules, team hooks and the MCP allowlist live in the Cursor dashboard (Teams and Enterprise) with no API. Not checked against a Cursor Teams account.",
    "Cursor's MCP tool names (MCP:<tool>) carry no server, so rules naming mcp__<server>__<tool> never match in Cursor.",
  ];
  return {
    output: { vendor: "cursor", version, files, calls: [] },
    mappings,
    coverage: { vendor: "cursor", version, docs: CURSOR_DOCS, notes },
  };
};
