import type { RuleAction } from "@selfhost/schema";
import { unplainGlob, urlHost } from "../glob.js";
import { code, combine, notApplicable, notExpressible, type Part, unmapped } from "../mapping.js";
import { type CommandForm, reduceCommand, unplainReason } from "../regex.js";
import { targetOf } from "../target.js";
import type {
  ApiCall,
  Check,
  InstallPaths,
  Mapping,
  OutputFile,
  VendorCompiler,
} from "../types.js";

// GitHub Copilot docs, checked 2026-11-08:
// - Enterprise managed settings: permissions.deny and ask with Shell(...) (`<command> *` for a
//   prefix, otherwise exact text), Read(...) and Edit(...) (`/` is the workspace root),
//   Domain(...) (`*.` includes the domain itself), allowedMcpServers by serverName, and any
//   managed permission rule making unmatched operations ask:
//   https://docs.github.com/en/copilot/reference/enterprise-administrators/enterprise-managed-settings
// - Delivery: copilot/managed-settings.json in the enterprise's .github-private repository, or
//   a root-owned file at the paths below:
//   https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-enterprise/use-managed-settings/deploy-managed-settings
// - Writing a repository file through the REST API:
//   https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents
export const COPILOT_DOCS = [
  "https://docs.github.com/en/copilot/reference/enterprise-administrators/enterprise-managed-settings",
  "https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-enterprise/use-managed-settings/deploy-managed-settings",
  "https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents",
];

const MANAGED_PATHS: InstallPaths = {
  darwin: "/Library/Application Support/GitHubCopilot/managed-settings.json",
  linux: "/etc/github-copilot/managed-settings.json",
  win32: "C:\\Program Files\\GitHubCopilot\\managed-settings.json",
};

/** Where server-managed settings live in the enterprise's .github-private repository. */
export const COPILOT_SETTINGS_PATH = "copilot/managed-settings.json";

type Entry =
  | { kind: "permission"; list: "deny" | "ask"; rule: string }
  | { kind: "mcp"; name: string };

function permissions(rules: string[], action: RuleAction, gap?: string): Part<Entry> {
  const list = action === "block" ? "deny" : "ask";
  return {
    entries: rules.map((rule) => ({ kind: "permission", list, rule })),
    native: rules.map((rule) => `${list}: ${rule}`),
    gap,
  };
}

function commandPart(form: CommandForm, action: RuleAction): Part<Entry> {
  const why = unplainReason(form.text);
  if (why) return unmapped(why);
  if (!form.start) {
    return unmapped(
      `Shell(...) matches a command prefix or the exact text, and ${form.text} has no ^ before it`,
    );
  }
  const t = form.text.trimEnd();
  const gaps: string[] = [];
  let rules: string[];
  if (form.end === "exact") rules = [`Shell(${t})`];
  else if (form.end === "open" && form.text.endsWith(" ")) rules = [`Shell(${t} *)`];
  else rules = [`Shell(${t})`, `Shell(${t} *)`];
  if (form.end === "open" && !form.text.endsWith(" ")) {
    gaps.push(`Shell(${t} *) matches whole words, so ${t} followed by more characters is missed`);
  }
  if (form.end === "boundary") {
    gaps.push(`\\b also matches ${t} followed by punctuation, which Shell(${t} *) misses`);
  }
  if (form.collapsed) {
    gaps.push("\\s between words is written as one space, so other whitespace there is missed");
  }
  return permissions(rules, action, gaps.length > 0 ? gaps.join("; ") : undefined);
}

function commandMapping(pattern: string, action: RuleAction): Mapping<Entry> {
  const reduced = reduceCommand(pattern);
  if (!reduced.ok) {
    return notExpressible(
      `Copilot's Shell(...) rules match a prefix or exact text, and the regular expression ${reduced.reason}.`,
      false,
    );
  }
  return combine(
    reduced.forms.map((form) => commandPart(form, action)),
    false,
    { covered: "Shell rules cover every command the regular expression matches." },
  );
}

function pathMapping(
  glob: string,
  access: "any" | "read" | "edit",
  action: RuleAction,
): Mapping<Entry> {
  const why = unplainGlob(glob);
  if (why) return notExpressible(`Copilot path rules use plain globs, and ${why}.`, false);
  const tools = access === "read" ? ["Read"] : access === "edit" ? ["Edit"] : ["Read", "Edit"];
  return combine(
    [
      permissions(
        tools.map((tool) => `${tool}(/${glob})`),
        action,
      ),
    ],
    false,
    {
      covered:
        "In Copilot's rules / is the workspace root, as selfhost reads paths from the repository root.",
    },
  );
}

function urlMapping(glob: string, action: RuleAction): Mapping<Entry> {
  const host = urlHost(glob);
  if (typeof host === "string") return notExpressible(`${host}.`, false);
  if (host.match === "all") {
    return notExpressible("Copilot's docs don't say Domain(*) matches every host.", false);
  }
  const domain = host.match === "subdomains" ? `*.${host.host}` : host.host;
  return combine([permissions([`Domain(${domain})`], action)], false, {
    covered:
      host.match === "subdomains"
        ? `Domain(${domain}) covers the subdomains, and also ${host.host} itself.`
        : `Domain(${domain}) covers the whole site.`,
  });
}

function mcpMapping(allow: string[]): Mapping<Entry> {
  const bad = allow.filter((name) => !/^[A-Za-z0-9_./-]+$/.test(name));
  if (bad.length > 0) {
    return notExpressible(
      `allowedMcpServers matches server names exactly, without wildcards, and ${bad.map(code).join(", ")} ${bad.length === 1 ? "is not one" : "are not"}.`,
      false,
    );
  }
  return combine(
    [
      {
        entries: allow.map((name): Entry => ({ kind: "mcp", name })),
        native: allow.map((name) => `allowedMcpServers: ${name}`),
      },
    ],
    false,
    {
      covered:
        "allowedMcpServers blocks every other server name. Like selfhost, it trusts the name the user gave the server.",
    },
  );
}

function mapping(check: Check): Mapping<Entry> {
  if (check.list?.kind === "mcp") return mcpMapping(check.list.allow);
  if (check.list?.kind === "models") {
    return notExpressible(
      "Copilot's managed settings pick a default model and have no allow list.",
      false,
    );
  }
  const target = targetOf("copilot", check.match ?? {});
  switch (target.kind) {
    case "never":
      return notApplicable(`${target.reason}.`);
    case "combined":
      return notExpressible("Each Copilot permission rule tests one thing.", false);
    case "command":
      return commandMapping(target.pattern, check.action);
    case "path":
      return pathMapping(target.glob, target.access, check.action);
    case "url":
      return urlMapping(target.glob, check.action);
    case "tool":
      return notExpressible(
        "Copilot's managed rules cover shell commands, file paths and domains, not tools by name.",
        false,
      );
  }
}

/**
 * GitHub Copilot: enterprise managed settings with permission rules and the MCP allow list,
 * as a root-owned file and as a REST API call that writes it to the enterprise's
 * .github-private repository. Copilot has no selfhost hook.
 */
export const copilot: VendorCompiler = ({ version, checks }) => {
  const mappings = new Map<string, Mapping<Entry>>();
  const deny: string[] = [];
  const ask: string[] = [];
  const servers: string[] = [];
  for (const check of checks) {
    const result = mapping(check);
    mappings.set(check.id, result);
    if (check.mode !== "enforce") continue;
    for (const entry of result.entries) {
      if (entry.kind === "mcp") servers.push(entry.name);
      else (entry.list === "deny" ? deny : ask).push(entry.rule);
    }
  }
  const notes = [
    "selfhost has no Copilot hook, so nothing covers what these rules miss.",
    "Copilot treats any managed permission rule as a policy: once one is set, every operation no rule matches asks for approval.",
    "The .github-private copy reaches only users who get their Copilot license from the enterprise; the file-based copy applies on the machine, and Copilot CLI on macOS and Linux reads it only when root owns it and it is not group- or world-writable.",
    "Not checked against a Copilot Business or Enterprise organization.",
  ];
  const files: OutputFile[] = [];
  const calls: ApiCall[] = [];
  if (deny.length > 0 || ask.length > 0 || servers.length > 0) {
    const settings: Record<string, unknown> = {};
    if (deny.length > 0 || ask.length > 0) {
      settings.permissions = {
        ...(deny.length > 0 ? { deny: [...new Set(deny)] } : {}),
        ...(ask.length > 0 ? { ask: [...new Set(ask)] } : {}),
      };
    }
    if (servers.length > 0)
      settings.allowedMcpServers = servers.map((serverName) => ({ serverName }));
    const content = `${JSON.stringify(settings, null, 2)}\n`;
    files.push({
      name: "managed-settings.json",
      content,
      description: "Copilot enterprise managed settings: permission rules and the MCP allow list.",
      install: { kind: "system", paths: MANAGED_PATHS, mode: "0644" },
    });
    calls.push({
      method: "PUT",
      path: `/repos/{owner}/{repo}/contents/${COPILOT_SETTINGS_PATH}`,
      body: {
        message: "Update Copilot managed settings from selfhost.toml",
        content: Buffer.from(content, "utf8").toString("base64"),
      },
      description:
        "Writes managed-settings.json to the enterprise's .github-private repository, where Copilot reads server-managed settings.",
      needsSha: true,
    });
  } else {
    notes.unshift("No enforced rule compiles for Copilot, so nothing is written.");
  }
  return {
    output: { vendor: "copilot", version, files, calls },
    mappings,
    coverage: { vendor: "copilot", version, docs: COPILOT_DOCS, notes },
  };
};
