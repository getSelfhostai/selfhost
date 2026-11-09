import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import {
  BUILT_IN_RULE_IDS,
  CONFIG_SCHEMA_DIRECTIVE,
  type ConfigResult,
  INSTALL_SCRIPT_ACTIONS,
  MCP_ALLOW_RULE_ID,
  MODELS_ALLOW_RULE_ID,
  parseConfig,
  type ResolvedRule,
  type ResolvedSelfhostConfig,
  type RuleMode,
} from "./config.js";
import { TomlLineIndex } from "./toml-lines.js";
import { type FieldError, formatField, type Segment } from "./validate.js";

/**
 * Policy layers: org, then team, then repo. The org's selfhost.toml is a floor. A team's or a
 * repo's file can add rules and tighten the org's, and anything that would relax the org's
 * fails validation and names the org rule:
 *
 * - a rule the org has, restated with a lower mode (off < observe < enforce), with ask where the
 *   org blocks, with fewer agents, with another match, or no longer irreversible;
 * - a `[teams.<name>.rules.<id>]` override of an org rule (or of an org allow list) that does
 *   any of those, measured against the org rule with the org's own override for that name;
 * - in a section the org file has: `[mcp]` and `[models]` with a lower mode or an allow list
 *   that widens the org's (an entry the org's list does not cover, or an empty list, which
 *   allows everything); `[packages]` with a lower mode, an allow entry the org's allow does not
 *   cover, a lower min_age_days or a softer install_scripts (allow < ask < block);
 *   `[guardrails]` with a lower mode or a guardrail the org keeps on in disable;
 * - a `[[redaction]]` pattern with the name of an org pattern but another pattern;
 * - `log_prompts = true` when the org file sets `[ledger] log_prompts = false`;
 * - a `[[review.routes]]` entry with the id of an org route but other fields;
 * - in `[review.auto_approve]`, against each key the org file sets: `enabled = true` where the
 *   org has false, `dry_run = false` where the org has true, a higher `max_risk`, an
 *   `allowed_paths` entry the org's list does not cover, or a `require_*` turned off.
 *
 * Lists that only add protection (deny, blocked_registries, prod_connections,
 * prod_credentials, redaction patterns, team members) are joined. `[[review.routes]]` are
 * joined by id with the org's first, so an org route takes an item before any route a team or a
 * repo adds. Other sections (review, alerts, plans, ledger retention) merge key by key with the
 * later layer winning. `[budget]`
 * is not inherited: the org's is the org's total, a team's is its own. `[integrations]` is a
 * choice, not a floor: a later layer's `[integrations.<kind>]` replaces the org's table for that
 * kind whole, so a team that picks another tool does not inherit the org tool's settings.
 */

export type LayerKind = "org" | "team" | "repo";

/** A layer's selfhost.toml, stored on the server. */
export interface PolicyLayer {
  kind: LayerKind;
  /** Org id, team id or repo slug, named in the composed file's header. */
  name: string;
  text: string;
}

/** A field of a team or repo file that would relax the org floor. */
export interface FloorError extends FieldError {
  /** The org rule or setting relaxed, such as no-force-push or [mcp] allow. */
  org_rule: string;
}

export type LayerError = FieldError & { org_rule?: string };

export type LayerResult =
  | { ok: true; config: ResolvedSelfhostConfig }
  | { ok: false; errors: LayerError[] };

/** A floor error in one layer of a composed policy. */
export interface LayerConflict extends FloorError {
  layer: PolicyLayer;
}

export interface ComposedPolicy {
  /** The selfhost.toml in use: one layer's text as it is, or the layers merged into one file. */
  text: string;
  config: ResolvedSelfhostConfig;
  /** Fields of later layers that relax the org floor. The org's value is used for each. */
  conflicts: LayerConflict[];
}

type Table = Record<string, unknown>;

const isTable = (value: unknown): value is Table =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const MODE_RANK: Record<RuleMode, number> = { off: 0, observe: 1, enforce: 2 };
const INSTALL_RANK = Object.fromEntries(INSTALL_SCRIPT_ACTIONS.map((a, i) => [a, i]));
const ALLOW_LISTS = [
  ["mcp", MCP_ALLOW_RULE_ID, "MCP server"],
  ["models", MODELS_ALLOW_RULE_ID, "model"],
] as const;

/** Glob characters the subset check understands; anything else in an org entry is literal. */
const SIMPLE_GLOB = /^[^{}[\]()!+@]*$/;

/** Whether an allow list entry of a later layer allows nothing beyond the org's list. */
export function withinList(entry: string, list: readonly string[]): boolean {
  return list.some(
    (glob) => glob === entry || (SIMPLE_GLOB.test(glob) && globRegex(glob).test(entry)),
  );
}

function globRegex(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string;
    if (ch === "*" && glob[i + 1] === "*") {
      source += ".*";
      i += 1;
    } else if (ch === "*") source += "[^/]*";
    else if (ch === "?") source += "[^/]";
    else source += ch.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "i");
}

function parseRaw(text: string): Table {
  const raw = parseToml(text);
  return isTable(raw) ? raw : {};
}

const clone = <T>(value: T): T => structuredClone(value);

/** Deep equality of parsed TOML values, ignoring key order. */
function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameValue(item, b[index]))
    );
  }
  if (isTable(a) && isTable(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((key) => sameValue(a[key], b[key]));
  }
  return a === b;
}

/** Rule ids an org file defines, which a later layer's overrides may name. */
function ruleIdsOf(config: ResolvedSelfhostConfig): Set<string> {
  return new Set(config.rules.map((rule) => rule.id));
}

function sameMatch(a: ResolvedRule["match"], b: ResolvedRule["match"]): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => a[key as keyof typeof a] === b[key as keyof typeof b]);
}

/** Whether `agents` reaches every agent `floor` does. */
function coversAgents(agents: readonly string[], floor: readonly string[]): boolean {
  if (agents.includes("all")) return true;
  return !floor.includes("all") && floor.every((agent) => agents.includes(agent));
}

interface RuleLike {
  mode?: RuleMode;
  action?: string;
  agents?: readonly string[];
}

/** What in `layer` relaxes `floor`, as [field, message] pairs. */
function relaxedFields(floor: Required<RuleLike>, layer: RuleLike): [string, string][] {
  const problems: [string, string][] = [];
  if (layer.mode !== undefined && MODE_RANK[layer.mode] < MODE_RANK[floor.mode]) {
    problems.push(["mode", `mode "${layer.mode}" is below the org's "${floor.mode}"`]);
  }
  if (layer.action === "ask" && floor.action === "block") {
    problems.push(["action", 'action "ask" turns the org\'s block into a question']);
  }
  if (layer.agents !== undefined && !coversAgents(layer.agents, floor.agents)) {
    problems.push([
      "agents",
      `agents ${JSON.stringify(layer.agents)} leave out agents the org applies it to (${JSON.stringify(floor.agents)})`,
    ]);
  }
  return problems;
}

interface Floor {
  raw: Table;
  config: ResolvedSelfhostConfig;
}

interface Layer {
  raw: Table;
  config: ResolvedSelfhostConfig;
}

/** One layer's checks against the org floor, without line numbers. */
function floorErrors(floor: Floor, layer: Layer): (FloorError & { segments: Segment[] })[] {
  const errors: (FloorError & { segments: Segment[] })[] = [];
  const add = (segments: Segment[], org_rule: string, message: string) =>
    errors.push({ segments, field: formatField(segments), org_rule, message });
  const orgRules = new Map(floor.config.rules.map((rule) => [rule.id, rule]));

  layer.config.rules.forEach((rule, index) => {
    const org = orgRules.get(rule.id);
    if (!org) return;
    const label = `Relaxes org rule "${rule.id}"`;
    for (const [field, message] of relaxedFields(org, rule)) {
      add(["rules", index, field], rule.id, `${label}: ${message}`);
    }
    if (!sameMatch(rule.match, org.match)) {
      add(
        ["rules", index, "match"],
        rule.id,
        `${label}: match differs from the org rule's. Restate an org rule only to tighten it, or add a rule with a new id.`,
      );
    }
    if (org.irreversible && !rule.irreversible) {
      add(["rules", index, "irreversible"], rule.id, `${label}: the org marks it irreversible`);
    }
  });

  for (const [team, { rules }] of Object.entries(layer.config.teams)) {
    for (const [id, override] of Object.entries(rules)) {
      const base = overrideFloor(floor, team, id);
      if (!base) continue;
      for (const [field, message] of relaxedFields(base, override)) {
        add(["teams", team, "rules", id, field], id, `Relaxes org rule "${id}": ${message}`);
      }
    }
  }

  for (const [section, ruleId, what] of ALLOW_LISTS) {
    const orgSection = floor.raw[section];
    const layerSection = layer.raw[section];
    if (!isTable(orgSection) || !isTable(layerSection)) continue;
    const org = floor.config[section];
    const mine = layer.config[section];
    if (layerSection.mode !== undefined && MODE_RANK[mine.mode] < MODE_RANK[org.mode]) {
      add(
        [section, "mode"],
        `[${section}] mode`,
        `Relaxes the org's [${section}] ("${ruleId}"): mode "${mine.mode}" is below the org's "${org.mode}"`,
      );
    }
    if (layerSection.allow === undefined || org.allow.length === 0) continue;
    if (mine.allow.length === 0) {
      add(
        [section, "allow"],
        `[${section}] allow`,
        `Widens the org's [${section}] allow: an empty list allows every ${what}`,
      );
    }
    mine.allow.forEach((entry, index) => {
      if (withinList(entry, org.allow)) return;
      add(
        [section, "allow", index],
        `[${section}] allow`,
        `Widens the org's [${section}] allow: "${entry}" is not in it`,
      );
    });
  }

  const orgPackages = floor.raw.packages;
  const layerPackages = layer.raw.packages;
  if (isTable(orgPackages) && isTable(layerPackages)) {
    const org = floor.config.packages;
    const mine = layer.config.packages;
    const label = (key: string) => `[packages] ${key}`;
    if (layerPackages.mode !== undefined && MODE_RANK[mine.mode] < MODE_RANK[org.mode]) {
      add(
        ["packages", "mode"],
        label("mode"),
        `Relaxes the org's [packages]: mode "${mine.mode}" is below the org's "${org.mode}"`,
      );
    }
    if (layerPackages.allow !== undefined) {
      mine.allow.forEach((entry, index) => {
        if (withinList(entry, org.allow)) return;
        add(
          ["packages", "allow", index],
          label("allow"),
          `Widens the org's [packages] allow: "${entry}" would skip the org's package checks`,
        );
      });
    }
    if (
      org.min_age_days !== undefined &&
      mine.min_age_days !== undefined &&
      mine.min_age_days < org.min_age_days
    ) {
      add(
        ["packages", "min_age_days"],
        label("min_age_days"),
        `Relaxes the org's [packages]: min_age_days ${mine.min_age_days} is below the org's ${org.min_age_days}`,
      );
    }
    if (
      layerPackages.install_scripts !== undefined &&
      (INSTALL_RANK[mine.install_scripts] ?? 0) < (INSTALL_RANK[org.install_scripts] ?? 0)
    ) {
      add(
        ["packages", "install_scripts"],
        label("install_scripts"),
        `Relaxes the org's [packages]: install_scripts "${mine.install_scripts}" is softer than the org's "${org.install_scripts}"`,
      );
    }
  }

  const orgGuardrails = floor.raw.guardrails;
  const layerGuardrails = layer.raw.guardrails;
  if (isTable(orgGuardrails) && isTable(layerGuardrails)) {
    const org = floor.config.guardrails;
    const mine = layer.config.guardrails;
    if (layerGuardrails.mode !== undefined && MODE_RANK[mine.mode] < MODE_RANK[org.mode]) {
      add(
        ["guardrails", "mode"],
        "[guardrails] mode",
        `Relaxes the org's [guardrails]: mode "${mine.mode}" is below the org's "${org.mode}"`,
      );
    }
    mine.disable.forEach((id, index) => {
      if (org.disable.includes(id)) return;
      add(
        ["guardrails", "disable", index],
        id,
        `Relaxes org guardrail "${id}": the org keeps it on`,
      );
    });
  }

  const orgPatterns = new Map(floor.config.redaction.map((r) => [r.name, r.pattern]));
  layer.config.redaction.forEach((redaction, index) => {
    const pattern = orgPatterns.get(redaction.name);
    if (pattern === undefined || pattern === redaction.pattern) return;
    add(
      ["redaction", index, "pattern"],
      `[[redaction]] ${redaction.name}`,
      `Replaces the org's redaction pattern "${redaction.name}": add a pattern with a new name instead`,
    );
  });

  const orgReview = isTable(floor.raw.review) ? floor.raw.review : {};
  const layerReview = isTable(layer.raw.review) ? layer.raw.review : {};
  const orgRoutes = new Map(floor.config.review.routes.map((route) => [route.id, route]));
  if (Array.isArray(layerReview.routes)) {
    layer.config.review.routes.forEach((route, index) => {
      const org = orgRoutes.get(route.id);
      if (!org || sameValue(org, route)) return;
      add(
        ["review", "routes", index],
        `[[review.routes]] ${route.id}`,
        `Changes org route "${route.id}": restate an org route only as it is, or add a route with a new id`,
      );
    });
  }
  const orgAuto = orgReview.auto_approve;
  const layerAuto = layerReview.auto_approve;
  if (isTable(orgAuto) && isTable(layerAuto)) {
    const org = floor.config.review.auto_approve;
    const mine = layer.config.review.auto_approve;
    const label = (key: string) => `[review.auto_approve] ${key}`;
    const relax = (key: string, message: string) =>
      add(
        ["review", "auto_approve", key],
        label(key),
        `Relaxes the org's [review.auto_approve]: ${message}`,
      );
    if (orgAuto.enabled === false && layerAuto.enabled === true) {
      relax("enabled", "the org keeps auto-approve off");
    }
    if (orgAuto.dry_run === true && layerAuto.dry_run === false) {
      relax("dry_run", "the org keeps auto-approve in dry run");
    }
    if (orgAuto.max_risk !== undefined && layerAuto.max_risk !== undefined) {
      if (mine.max_risk > org.max_risk) {
        relax("max_risk", `max_risk ${mine.max_risk} is above the org's ${org.max_risk}`);
      }
    }
    if (orgAuto.allowed_paths !== undefined && layerAuto.allowed_paths !== undefined) {
      mine.allowed_paths.forEach((entry, index) => {
        if (withinList(entry, org.allowed_paths)) return;
        add(
          ["review", "auto_approve", "allowed_paths", index],
          label("allowed_paths"),
          `Widens the org's [review.auto_approve] allowed_paths: "${entry}" is not in it`,
        );
      });
    }
    for (const key of ["require_green_checks", "require_second_opinion"] as const) {
      if (orgAuto[key] === true && layerAuto[key] === false) relax(key, `the org sets ${key}`);
    }
  }

  const orgLedger = floor.raw.ledger;
  const layerLedger = layer.raw.ledger;
  if (isTable(orgLedger) && orgLedger.log_prompts === false && isTable(layerLedger)) {
    if (layerLedger.log_prompts === true) {
      add(
        ["ledger", "log_prompts"],
        "[ledger] log_prompts",
        "Relaxes the org's [ledger]: the org stores no prompt text",
      );
    }
  }
  return errors;
}

/**
 * The org rule, with the org's own override for `team` applied, that an override of rule `id`
 * for `team` is measured against. undefined when the org has no such rule or allow list.
 */
function overrideFloor(floor: Floor, team: string, id: string): Required<RuleLike> | undefined {
  const own = floor.config.teams[team]?.rules[id] ?? {};
  const rule = floor.config.rules.find((r) => r.id === id);
  if (rule) return { mode: rule.mode, action: rule.action, agents: rule.agents, ...own };
  const list = ALLOW_LISTS.find(([, ruleId]) => ruleId === id);
  if (!list || !isTable(floor.raw[list[0]])) return undefined;
  const section = floor.config[list[0]];
  if (section.allow.length === 0) return undefined;
  return { mode: section.mode, action: "block", agents: ["all"], ...own };
}

function parseFloor(text: string): Floor {
  const parsed = parseConfig(text);
  if (!parsed.ok) throw new Error("The org's selfhost.toml is invalid");
  return { raw: parseRaw(text), config: parsed.config };
}

function parseLayer(text: string, floor: Floor | undefined): ConfigResult {
  return parseConfig(text, floor ? { knownRuleIds: ruleIdsOf(floor.config) } : undefined);
}

/** Rule ids a file's [teams.<name>.rules] overrides name. */
function overrideIds(raw: Table): Set<string> {
  const ids = new Set<string>();
  for (const team of Object.values(isTable(raw.teams) ? raw.teams : {})) {
    if (isTable(team) && isTable(team.rules)) for (const id of Object.keys(team.rules)) ids.add(id);
  }
  return ids;
}

/**
 * Validates a team's or a repo's selfhost.toml on top of the org floor: the file itself, as
 * selfhost doctor checks it (its overrides may name org rules), then every field that would
 * relax the org floor, each naming the org rule. Without an org policy only the file is checked.
 */
export function checkLayer(orgText: string | undefined, text: string): LayerResult {
  const floor = orgText === undefined ? undefined : parseFloor(orgText);
  const parsed = parseLayer(text, floor);
  if (!parsed.ok) return parsed;
  if (!floor) return parsed;
  const lines = new TomlLineIndex(text);
  const errors = floorErrors(floor, { raw: parseRaw(text), config: parsed.config }).map(
    ({ segments, ...error }) => {
      const line = lines.lineOf(segments);
      return line === undefined ? error : { ...error, line };
    },
  );
  return errors.length > 0 ? { ok: false, errors } : parsed;
}

const unionStrings = (a: unknown, b: unknown): string[] => [
  ...new Set([
    ...(Array.isArray(a) ? (a as string[]) : []),
    ...(Array.isArray(b) ? (b as string[]) : []),
  ]),
];

/** Tables merge key by key, the layer winning; anything else is replaced. */
function deepMerge(base: unknown, layer: unknown): unknown {
  if (!isTable(base) || !isTable(layer)) return clone(layer);
  const merged: Table = clone(base);
  for (const [key, value] of Object.entries(layer)) merged[key] = deepMerge(merged[key], value);
  return merged;
}

/**
 * Merges one layer into the policy so far. Fields named in `blocked` (field paths of floor
 * errors in this layer) keep the value they had, which is the org's.
 */
function mergeLayer(
  into: Table,
  layer: Table,
  floor: Floor | undefined,
  blocked: Set<string>,
): Table {
  const out = clone(into);
  const orgRuleIds = floor ? ruleIdsOf(floor.config) : new Set<string>();
  const isBlocked = (...segments: Segment[]) => {
    const prefix = formatField(segments);
    return [...blocked].some(
      (field) =>
        field === prefix || field.startsWith(`${prefix}.`) || field.startsWith(`${prefix}[`),
    );
  };

  for (const [key, value] of Object.entries(layer)) {
    switch (key) {
      case "version":
      case "budget":
        out[key] = clone(value);
        break;
      case "org":
        if (!floor || !isTable(floor.raw.org)) out.org = clone(value);
        break;
      case "rules": {
        const rules = Array.isArray(out.rules) ? (out.rules as Table[]) : [];
        (Array.isArray(value) ? value : []).forEach((rule, index) => {
          if (!isTable(rule)) return;
          const at = rules.findIndex((r) => r.id === rule.id);
          if (at === -1) rules.push(clone(rule));
          else if (!(orgRuleIds.has(String(rule.id)) && isBlocked("rules", index))) {
            rules[at] = { ...rules[at], ...clone(rule) };
          }
        });
        out.rules = rules;
        break;
      }
      case "teams": {
        const teams = isTable(out.teams) ? out.teams : {};
        for (const [name, team] of Object.entries(isTable(value) ? value : {})) {
          if (!isTable(team)) continue;
          const current = isTable(teams[name]) ? (teams[name] as Table) : {};
          const members = unionStrings(current.members, team.members);
          const rules: Table = isTable(current.rules) ? clone(current.rules) : {};
          for (const [id, override] of Object.entries(isTable(team.rules) ? team.rules : {})) {
            if (isBlocked("teams", name, "rules", id)) continue;
            rules[id] = { ...(isTable(rules[id]) ? rules[id] : {}), ...clone(override as Table) };
          }
          const merged = {
            ...current,
            ...(members.length > 0 ? { members } : {}),
            ...(Object.keys(rules).length > 0 ? { rules } : {}),
          };
          if (Object.keys(merged).length > 0) teams[name] = merged;
        }
        out.teams = teams;
        break;
      }
      case "redaction": {
        const patterns = Array.isArray(out.redaction) ? (out.redaction as Table[]) : [];
        for (const redaction of Array.isArray(value) ? value : []) {
          if (!isTable(redaction)) continue;
          if (patterns.some((r) => r.name === redaction.name)) continue;
          patterns.push(clone(redaction));
        }
        out.redaction = patterns;
        break;
      }
      case "packages":
      case "guardrails":
      case "mcp":
      case "models": {
        const section: Table = isTable(out[key]) ? clone(out[key] as Table) : {};
        const unions = ["deny", "blocked_registries", "prod_connections", "prod_credentials"];
        for (const [field, fieldValue] of Object.entries(isTable(value) ? value : {})) {
          if (isBlocked(key, field)) continue;
          if (unions.includes(field)) section[field] = unionStrings(section[field], fieldValue);
          else if (field === "min_age_days" && typeof section[field] === "number") {
            section[field] = Math.max(section[field] as number, fieldValue as number);
          } else section[field] = clone(fieldValue);
        }
        out[key] = section;
        break;
      }
      case "integrations": {
        const section: Table = isTable(out.integrations) ? clone(out.integrations) : {};
        for (const [kind, table] of Object.entries(isTable(value) ? value : {})) {
          section[kind] = clone(table);
        }
        out.integrations = section;
        break;
      }
      case "review": {
        const section: Table = isTable(out.review) ? clone(out.review) : {};
        for (const [field, fieldValue] of Object.entries(isTable(value) ? value : {})) {
          if (field === "routes") {
            const routes = Array.isArray(section.routes) ? (section.routes as Table[]) : [];
            (Array.isArray(fieldValue) ? fieldValue : []).forEach((route, index) => {
              if (!isTable(route) || isBlocked("review", "routes", index)) return;
              const at = routes.findIndex((r) => r.id === route.id);
              if (at === -1) routes.push(clone(route));
              else routes[at] = clone(route);
            });
            section.routes = routes;
          } else if (field === "auto_approve" && isTable(fieldValue)) {
            const auto: Table = isTable(section.auto_approve) ? clone(section.auto_approve) : {};
            for (const [key, setting] of Object.entries(fieldValue)) {
              if (!isBlocked("review", "auto_approve", key)) auto[key] = clone(setting);
            }
            section.auto_approve = auto;
          } else section[field] = deepMerge(section[field], fieldValue);
        }
        out.review = section;
        break;
      }
      case "ledger":
        out.ledger = isBlocked("ledger", "log_prompts")
          ? deepMerge(out.ledger, { ...(value as Table), log_prompts: false })
          : deepMerge(out.ledger, value);
        break;
      default:
        out[key] = deepMerge(out[key], value);
    }
  }
  return out;
}

/** Drops overrides of rules the composed policy no longer has, such as an org rule removed later. */
function dropStaleOverrides(raw: Table): void {
  if (!isTable(raw.teams)) return;
  const ids = new Set<string>([
    ...(Array.isArray(raw.rules) ? raw.rules : []).filter(isTable).map((r) => String(r.id)),
    ...BUILT_IN_RULE_IDS,
  ]);
  for (const team of Object.values(raw.teams)) {
    if (!isTable(team) || !isTable(team.rules)) continue;
    for (const id of Object.keys(team.rules)) if (!ids.has(id)) delete team.rules[id];
  }
}

function header(layers: readonly PolicyLayer[]): string {
  const names = layers.map((layer) => `${layer.kind} ${layer.name}`).join(", then ");
  return `${CONFIG_SCHEMA_DIRECTIVE}\n# The policy in use: ${names}. Change those, not this file.\n`;
}

/**
 * The policy in use for a team or a repo: the org floor, then the team's file, then the repo's.
 * A single layer is used as it is, so a team with no org policy keeps its own text and hash.
 * Every stored layer was checked when it was set; if the org floor was raised since, a field
 * that now relaxes it is listed in conflicts and the org's value is used. Each layer's own
 * errors throw, since only valid files are stored.
 */
export function composePolicy(present: readonly PolicyLayer[]): ComposedPolicy {
  const [first] = present;
  if (!first) throw new Error("composePolicy needs at least one layer");
  if (present.length === 1 && first.kind !== "org") {
    const parsed = parseConfig(first.text);
    if (!parsed.ok) throw new Error(`The ${first.kind} policy of ${first.name} is invalid`);
    return { text: first.text, config: parsed.config, conflicts: [] };
  }
  const floor = first.kind === "org" ? parseFloor(first.text) : undefined;
  let raw: Table = floor ? clone(floor.raw) : {};
  delete raw.budget;
  const conflicts: LayerConflict[] = [];
  for (const layer of floor ? present.slice(1) : present) {
    const own = parseRaw(layer.text);
    // Overrides of rules an earlier layer has since removed are dropped below, not refused.
    const parsed = parseConfig(layer.text, { knownRuleIds: overrideIds(own) });
    if (!parsed.ok) throw new Error(`The ${layer.kind} policy of ${layer.name} is invalid`);
    const errors = floor ? floorErrors(floor, { raw: own, config: parsed.config }) : [];
    const lines = new TomlLineIndex(layer.text);
    for (const { segments, ...error } of errors) {
      const line = lines.lineOf(segments);
      conflicts.push({ ...error, ...(line === undefined ? {} : { line }), layer });
    }
    raw = mergeLayer(raw, own, floor, new Set(errors.map((e) => e.field)));
  }
  raw.version = 1;
  dropStaleOverrides(raw);
  const text = header(present) + stringifyToml(raw);
  const parsed = parseConfig(text);
  if (!parsed.ok) {
    const [error] = parsed.errors;
    throw new Error(`The composed policy is invalid: ${error?.field}: ${error?.message}`);
  }
  return { text, config: parsed.config, conflicts };
}
