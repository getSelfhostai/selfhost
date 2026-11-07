import type { ToolCall } from "@selfhost/policy";

/**
 * Tool calls whose effect lands outside the repository and cannot be taken back by reverting the
 * pull request. Every pattern is in this file. They are deliberately simple: they read the
 * stored command (the first line, at most 120 characters, secrets masked) or the MCP tool name,
 * so a command split over lines or hidden in a script is not seen, and a match is not proof
 * that the call succeeded.
 */
export const OUTSIDE_EFFECT_KINDS = [
  "payment",
  "email",
  "production_data",
  "publish",
  "infrastructure",
] as const;

export type OutsideEffectKind = (typeof OUTSIDE_EFFECT_KINDS)[number];

export interface OutsideEffect {
  kind: OutsideEffectKind;
  /** The pattern's label. */
  label: string;
  /** What matched: the part of the command, the MCP tool name, or the client and host. */
  evidence: string;
}

interface EffectPattern {
  kind: OutsideEffectKind;
  label: string;
  /** Tested against shell commands. */
  command?: RegExp;
  /** Tested against MCP tools named mcp__<server>__<tool>. */
  mcp?: { server: RegExp; tool: RegExp };
}

/**
 * `program` followed, in the same command segment (before any |, ; or &), by one of `verbs` as a
 * whole word, so flags in between still match: `terraform -chdir=infra apply`,
 * `kubectl -n prod delete`.
 */
const run = (program: string, verbs: string) =>
  new RegExp(`\\b(?:${program})\\b[^|;&\\n]*?\\s(?:${verbs})(?=\\s|$)`);

const PAYMENT_WRITES = "create|update|delete|cancel|capture|confirm|refund|pay";

export const OUTSIDE_EFFECTS: readonly EffectPattern[] = [
  { kind: "payment", label: "Stripe CLI write", command: run("stripe", `${PAYMENT_WRITES}|post`) },
  {
    kind: "payment",
    label: "payment MCP tool",
    mcp: { server: /stripe|paypal|square|adyen/i, tool: new RegExp(`^(?:${PAYMENT_WRITES})`, "i") },
  },
  { kind: "email", label: "Amazon SES send", command: /\baws\s+sesv?2?\s+send-[a-z-]+/ },
  {
    kind: "email",
    label: "email API send",
    command: /\bapi\.sendgrid\.com\/v3\/mail\/send\b|\bapi\.mailgun\.net\/v3\/\S+\/messages\b/,
  },
  { kind: "email", label: "sendmail", command: /\b(?:sendmail|swaks)\b/ },
  {
    kind: "email",
    label: "email MCP tool",
    mcp: { server: /gmail|outlook|sendgrid|resend|mailgun|postmark|ses/i, tool: /^send/i },
  },
  { kind: "publish", label: "package publish", command: run("npm|pnpm|yarn|bun|cargo", "publish") },
  { kind: "publish", label: "package upload", command: run("twine", "upload") },
  { kind: "publish", label: "gem or image push", command: run("gem|docker", "push") },
  { kind: "publish", label: "GitHub release", command: run("gh\\s+release", "create") },
  {
    kind: "infrastructure",
    label: "Terraform apply",
    command: run("terraform|tofu", "apply|destroy|import"),
  },
  { kind: "infrastructure", label: "Pulumi up", command: run("pulumi", "up|destroy") },
  {
    kind: "infrastructure",
    label: "kubectl write",
    command: run("kubectl", "apply|create|delete|replace|patch|scale|rollout|set|edit"),
  },
  {
    kind: "infrastructure",
    label: "Helm release change",
    command: run("helm", "install|upgrade|uninstall|rollback"),
  },
  { kind: "infrastructure", label: "CDK deploy", command: run("cdk", "deploy|destroy") },
  {
    kind: "infrastructure",
    label: "production deploy",
    command:
      /\bvercel\b[^|;&\n]*\s--prod\b|\bfly(?:ctl)?\s+deploy\b|\bwrangler\s+(?:deploy|publish)\b/,
  },
];

/** Database clients whose writes land in a database: flagged only when they name a remote host. */
const DATABASE_CLIENT = /\b(psql|mysql|mongosh)\b([^|;&\n]*)/;

const HOST_PATTERNS = [
  /(?:^|\s)-h\s*([^\s'"]+)/,
  /--host(?:=|\s+)([^\s'"]+)/,
  /\bhost=([^\s'"]+)/,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/(?:[^@/\s]*@)?([^:/?\s,'"]+)/,
];

/**
 * Local: localhost and *.localhost, loopback addresses, 0.0.0.0, a unix socket path, and a name
 * with no dot (a Docker Compose service such as `db`).
 */
export function isLocalHost(host: string): boolean {
  const name = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    name === "localhost" ||
    name.endsWith(".localhost") ||
    name === "::1" ||
    name === "0.0.0.0" ||
    /^127\.\d+\.\d+\.\d+$/.test(name) ||
    name.startsWith("/") ||
    (!name.includes(".") && !name.includes(":"))
  );
}

function databaseEffect(command: string): OutsideEffect | undefined {
  const client = DATABASE_CLIENT.exec(command);
  if (!client) return undefined;
  const args = client[2] ?? "";
  for (const pattern of HOST_PATTERNS) {
    const host = pattern.exec(args)?.[1];
    if (host && !isLocalHost(host)) {
      return {
        kind: "production_data",
        label: "database client on a remote host",
        evidence: `${client[1]} ${host}`,
      };
    }
  }
  return undefined;
}

function mcpTool(tool: string): string {
  const parts = tool.split("__");
  return parts.length >= 3 ? parts.slice(2).join("__") : "";
}

/** The outside effects one tool call matches, in OUTSIDE_EFFECTS order, then the database check. */
export function outsideEffects(call: ToolCall): OutsideEffect[] {
  const found: OutsideEffect[] = [];
  for (const pattern of OUTSIDE_EFFECTS) {
    if (pattern.command && call.command !== undefined) {
      const match = pattern.command.exec(call.command);
      if (match)
        found.push({ kind: pattern.kind, label: pattern.label, evidence: match[0].trim() });
    }
    if (pattern.mcp && call.mcpServer !== undefined) {
      const tool = mcpTool(call.tool);
      if (pattern.mcp.server.test(call.mcpServer) && pattern.mcp.tool.test(tool)) {
        found.push({ kind: pattern.kind, label: pattern.label, evidence: call.tool });
      }
    }
  }
  if (call.command !== undefined) {
    const database = databaseEffect(call.command);
    if (database) found.push(database);
  }
  return found;
}
