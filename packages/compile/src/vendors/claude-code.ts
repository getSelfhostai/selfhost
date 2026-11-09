import { CLAUDE_CODE_HOOK_EVENTS, type RuleAction } from "@selfhost/schema";
import picomatch from "picomatch/posix.js";
import { unplainGlob, urlHost } from "../glob.js";
import { code, combine, notApplicable, notExpressible, type Part, unmapped } from "../mapping.js";
import { type CommandForm, reduceCommand, unplainReason } from "../regex.js";
import { targetOf } from "../target.js";
import type { Check, InstallPaths, Mapping, VendorCompiler } from "../types.js";
import { atLeast } from "../versions.js";

// Claude Code docs, checked 2026-11-08:
// - Managed settings paths and the managed-settings.d/ drop-in folder (2.1.83 or later):
//   https://code.claude.com/docs/en/settings
// - Permission rules: Bash(...) prefix and * wildcards, compound commands, wrappers, Read and
//   Edit gitignore paths with ./ for the start folder, WebFetch(domain:...), mcp__ tool names:
//   https://code.claude.com/docs/en/permissions
// - allowedMcpServers (serverName: letters, digits, - and _), allowManagedMcpServersOnly,
//   availableModels, availableModelsMatch (2.1.283 or later):
//   https://code.claude.com/docs/en/settings-reference
// - Hooks shape, and identical handlers in several settings files running once:
//   https://code.claude.com/docs/en/hooks
export const CLAUDE_CODE_DOCS = [
  "https://code.claude.com/docs/en/settings",
  "https://code.claude.com/docs/en/permissions",
  "https://code.claude.com/docs/en/settings-reference",
  "https://code.claude.com/docs/en/hooks",
];

const MANAGED_PATHS: InstallPaths = {
  darwin: "/Library/Application Support/ClaudeCode/managed-settings.d/selfhost.json",
  linux: "/etc/claude-code/managed-settings.d/selfhost.json",
  win32: "C:\\Program Files\\ClaudeCode\\managed-settings.d\\selfhost.json",
};

/** Domain wildcards in WebFetch rules match subdomains from this version. */
const DOMAIN_WILDCARDS = "2.1.172";
/** availableModelsMatch, to make a model id permit only the version it names. */
const MODELS_MATCH = "2.1.283";

type Entry =
  | { kind: "permission"; list: "deny" | "ask"; rule: string }
  | { kind: "mcp"; name: string }
  | { kind: "model"; id: string }
  | { kind: "domain"; domain: string };

const listOf = (action: RuleAction) => (action === "block" ? "deny" : "ask");

function permissions(rules: string[], action: RuleAction, gap?: string): Part<Entry> {
  const list = listOf(action);
  return {
    entries: rules.map((rule) => ({ kind: "permission", list, rule })),
    native: rules.map((rule) => `${list}: ${rule}`),
    gap,
  };
}

function commandPart(form: CommandForm, action: RuleAction): Part<Entry> {
  const why = unplainReason(form.text);
  if (why) return unmapped(why);
  const t = form.text;
  const gaps: string[] = [];
  let rules: string[];
  if (form.start) {
    rules =
      form.end === "open"
        ? [`Bash(${t}*)`]
        : form.end === "exact"
          ? [`Bash(${t})`]
          : [`Bash(${t} *)`];
    if (form.end === "boundary") {
      gaps.push(`\\b also matches ${t} followed by punctuation, which Bash(${t} *) misses`);
    }
  } else {
    rules =
      form.end === "open"
        ? [`Bash(*${t}*)`]
        : form.end === "exact"
          ? [`Bash(*${t})`]
          : [`Bash(*${t} *)`, `Bash(*${t})`];
    gaps.push(
      `the regular expression has no ^, and Claude Code matches each command after taking off wrappers such as timeout and leading VAR=value, so ${t} inside those is missed`,
    );
  }
  if (form.collapsed) {
    gaps.push(`\\s between words is written as one space, so other whitespace there is missed`);
  }
  return permissions(rules, action, gaps.length > 0 ? gaps.join("; ") : undefined);
}

function commandMapping(pattern: string, action: RuleAction): Mapping<Entry> {
  const reduced = reduceCommand(pattern);
  if (!reduced.ok) {
    return notExpressible(
      `Claude Code matches commands by prefix and * wildcards, and the regular expression ${reduced.reason}.`,
      true,
    );
  }
  return combine(
    reduced.forms.map((form) => commandPart(form, action)),
    true,
    {
      covered:
        "Bash rules cover every command the regular expression matches. Claude Code also applies them to each part of a compound command and looks through wrappers such as timeout, so they block a little more.",
    },
  );
}

function pathMapping(
  glob: string,
  access: "any" | "read" | "edit",
  action: RuleAction,
): Mapping<Entry> {
  const why = unplainGlob(glob);
  if (why) return notExpressible(`Claude Code path rules use gitignore globs, and ${why}.`, true);
  const tools = access === "read" ? ["Read"] : access === "edit" ? ["Edit"] : ["Read", "Edit"];
  return combine(
    [
      permissions(
        tools.map((tool) => `${tool}(./${glob})`),
        action,
        "Claude Code reads ./ from the folder a session starts in and selfhost reads paths from the repository root, so a session started in a subfolder is missed",
      ),
    ],
    true,
    {
      extra:
        access === "read"
          ? "A Read rule in Claude Code also stops edits of the same files."
          : access === "edit"
            ? "Edit rules also cover Write and NotebookEdit."
            : undefined,
    },
  );
}

function urlMapping(glob: string, action: RuleAction, version: string): Mapping<Entry> {
  const host = urlHost(glob);
  if (typeof host === "string") return notExpressible(`${host}.`, true);
  if (host.match !== "host" && !atLeast(version, DOMAIN_WILDCARDS)) {
    return notExpressible(
      `WebFetch domain wildcards need Claude Code ${DOMAIN_WILDCARDS} or later.`,
      true,
    );
  }
  const domain =
    host.match === "all" ? "*" : host.match === "subdomains" ? `*.${host.host}` : host.host;
  return combine([permissions([`WebFetch(domain:${domain})`], action)], true, {
    covered: `WebFetch(domain:${domain}) blocks the whole site over http and https, on any port.`,
  });
}

function toolMapping(tool: string, action: RuleAction): Mapping<Entry> {
  if (!/^[A-Za-z0-9_.-]+$/.test(tool)) {
    return notExpressible(`Claude Code rules can't carry the tool name ${code(tool)}.`, true);
  }
  return combine([permissions([tool], action)], true, {
    covered: `A bare ${tool} rule covers every call to the tool.`,
  });
}

function mcpMapping(allow: string[]): Mapping<Entry> {
  const bad = allow.filter((name) => !/^[A-Za-z0-9_-]+$/.test(name));
  if (bad.length > 0) {
    return notExpressible(
      `allowedMcpServers matches server names exactly (letters, digits, - and _), and ${bad.map(code).join(", ")} ${bad.length === 1 ? "is not one" : "are not"}.`,
      true,
    );
  }
  return combine(
    [
      {
        entries: allow.map((name): Entry => ({ kind: "mcp", name })),
        native: allow.map((name) => `allowedMcpServers: ${name}`),
      },
    ],
    true,
    {
      covered:
        "allowedMcpServers, made the only MCP allowlist by allowManagedMcpServersOnly, blocks every other server name. Like selfhost, it trusts the name the user gave the server.",
    },
  );
}

function modelsMapping(allow: string[], version: string): Mapping<Entry> {
  const globs = allow.filter((id) => picomatch.scan(id).isGlob);
  if (globs.length > 0) {
    return notExpressible(
      `availableModels takes model ids and aliases, not globs such as ${globs.map(code).join(", ")}.`,
      true,
    );
  }
  const exact = atLeast(version, MODELS_MATCH);
  return combine(
    [
      {
        entries: allow.map((id): Entry => ({ kind: "model", id })),
        native: allow.map((id) => `availableModels: ${id}`),
        gap: exact
          ? "availableModels with availableModelsMatch exact still lets a listed id through with its dated release id, and an alias such as sonnet lets its whole family through"
          : `before ${MODELS_MATCH}, availableModels lets a listed id through with every later version that extends it`,
      },
    ],
    true,
  );
}

/**
 * [egress] allow as the sandbox's network allow list: sandbox.network.allowedDomains, locked to
 * managed settings by allowManagedDomainsOnly. The sandbox covers Bash commands and what they
 * start; WebFetch, web search and MCP servers run outside it, so the hook checks those.
 */
function egressMapping(allow: string[]): Mapping<Entry> {
  const ranges = allow.filter((entry) => entry.includes("/"));
  const domains = allow.filter((entry) => !entry.includes("/"));
  const gaps = [
    "the sandbox limits Bash commands and the programs they start; WebFetch, web search and MCP servers reach the network outside it",
  ];
  if (ranges.length > 0) {
    gaps.push(
      `allowedDomains takes names and addresses, not ranges such as ${ranges.map(code).join(", ")}`,
    );
  }
  return combine(
    [
      {
        entries: domains.map((domain): Entry => ({ kind: "domain", domain })),
        native:
          domains.length > 0
            ? domains.map((domain) => `sandbox.network.allowedDomains: ${domain}`)
            : ["sandbox.network.allowedDomains: (none)"],
        gap: gaps.join("; "),
      },
    ],
    true,
  );
}

function mapping(check: Check, version: string): Mapping<Entry> {
  if (check.list?.kind === "egress") return egressMapping(check.list.allow);
  if (check.list?.kind === "mcp") return mcpMapping(check.list.allow);
  if (check.list?.kind === "models") return modelsMapping(check.list.allow, version);
  const target = targetOf("claude_code", check.match ?? {});
  switch (target.kind) {
    case "never":
      return notApplicable(`${target.reason}.`);
    case "combined":
      return notExpressible(
        `Each Claude Code permission rule tests one thing, and this rule tests ${target.fields.join(" and ")} together.`,
        true,
      );
    case "command":
      return commandMapping(target.pattern, check.action);
    case "path":
      return pathMapping(target.glob, target.access, check.action);
    case "url":
      return urlMapping(target.glob, check.action, version);
    case "tool":
      return toolMapping(target.tool, check.action);
  }
}

/**
 * Claude Code: one managed-settings.d fragment with permission deny and ask rules, the MCP and
 * model allow lists, and hooks that run selfhost hook on every event.
 */
export const claudeCode: VendorCompiler = ({ version, checks, hookCommand }) => {
  const mappings = new Map<string, Mapping<Entry>>();
  const deny: string[] = [];
  const ask: string[] = [];
  const servers: string[] = [];
  const models: string[] = [];
  let domains: string[] | undefined;
  for (const check of checks) {
    const result = mapping(check, version);
    mappings.set(check.id, result);
    if (check.mode !== "enforce") continue;
    if (check.list?.kind === "egress") domains = [];
    for (const entry of result.entries) {
      if (entry.kind === "permission") (entry.list === "deny" ? deny : ask).push(entry.rule);
      else if (entry.kind === "mcp") servers.push(entry.name);
      else if (entry.kind === "domain") domains?.push(entry.domain);
      else models.push(entry.id);
    }
  }
  const settings: Record<string, unknown> = {
    $schema: "https://json.schemastore.org/claude-code-settings.json",
  };
  if (deny.length > 0 || ask.length > 0) {
    settings.permissions = {
      ...(deny.length > 0 ? { deny: [...new Set(deny)] } : {}),
      ...(ask.length > 0 ? { ask: [...new Set(ask)] } : {}),
    };
  }
  if (servers.length > 0) {
    settings.allowedMcpServers = servers.map((serverName) => ({ serverName }));
    settings.allowManagedMcpServersOnly = true;
  }
  if (models.length > 0) {
    settings.availableModels = models;
    if (atLeast(version, MODELS_MATCH)) settings.availableModelsMatch = "exact";
  }
  if (domains) {
    settings.sandbox = {
      enabled: true,
      network: { allowedDomains: [...new Set(domains)], allowManagedDomainsOnly: true },
    };
  }
  settings.hooks = Object.fromEntries(
    CLAUDE_CODE_HOOK_EVENTS.map((event) => [
      event,
      [{ hooks: [{ type: "command", command: hookCommand }] }],
    ]),
  );
  const notes = [
    "Managed settings apply to every project on the machine, and a deny rule from any settings file wins over an allow.",
    "Claude Code's docs say Bash rules match the command as written, not the program: git -C . push and sh -c '...' get past a Bash(git push *) rule. The selfhost hook checks every Bash call as well.",
    "The hooks run the same command selfhost agents configure writes, and Claude Code runs identical handlers once.",
  ];
  if (servers.length > 0) {
    notes.push(
      "allowManagedMcpServersOnly makes this the only MCP allowlist: allowlists in user and project settings are ignored.",
    );
  }
  if (domains) {
    notes.push(
      "sandbox.enabled runs Bash commands in Claude Code's sandbox, and allowManagedDomainsOnly makes [egress] allow its only network allow list: other hosts are blocked without a prompt.",
    );
  }
  return {
    output: {
      vendor: "claude_code",
      version,
      files: [
        {
          name: "managed-settings.d/selfhost.json",
          content: `${JSON.stringify(settings, null, 2)}\n`,
          description:
            "Claude Code managed settings: permission rules, MCP and model allow lists, and hooks that run selfhost hook.",
          install: { kind: "system", paths: MANAGED_PATHS, mode: "0644" },
        },
      ],
      calls: [],
    },
    mappings,
    coverage: { vendor: "claude_code", version, docs: CLAUDE_CODE_DOCS, notes },
  };
};
