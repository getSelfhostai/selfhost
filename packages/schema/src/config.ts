import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { parse as parseToml, TomlError } from "smol-toml";
import { NonEmpty, StringEnum, Url } from "./common.js";
import { AGENT_VENDORS } from "./event.js";
import { TomlLineIndex } from "./toml-lines.js";
import {
  type FieldError,
  formatField,
  lazyCheck,
  type SegmentError,
  schemaErrors,
} from "./validate.js";

export const CONFIG_FILE_NAME = "selfhost.toml";

/**
 * Where the JSON Schema of selfhost.toml is published, and its `$id`. Editors with a TOML
 * language server (Taplo, Even Better TOML) read it from the first line of the file.
 */
export const CONFIG_SCHEMA_URL = "https://selfhost.ai/schema/selfhost.toml.v1.json";

/** First line of every selfhost.toml selfhost writes: the Taplo schema directive. */
export const CONFIG_SCHEMA_DIRECTIVE = `#:schema ${CONFIG_SCHEMA_URL}`;

export const RULE_MODES = ["observe", "enforce", "off"] as const;
export const RULE_ACTIONS = ["block", "ask"] as const;
export const AGENT_SELECTORS = ["all", ...AGENT_VENDORS] as const;

export type RuleMode = (typeof RULE_MODES)[number];
export type RuleAction = (typeof RULE_ACTIONS)[number];

/** Rule id recorded when a tool call reaches an MCP server that is not in [mcp] allow. */
export const MCP_ALLOW_RULE_ID = "mcp.allow";
/** Rule id recorded when a tool call runs on a model that is not in [models] allow. */
export const MODELS_ALLOW_RULE_ID = "models.allow";
export const BUILT_IN_RULE_IDS = [MCP_ALLOW_RULE_ID, MODELS_ALLOW_RULE_ID] as const;

const RULE_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_.-]*$";
/** GitHub logins: letters, digits and single hyphens, at most 39 characters. */
const GITHUB_LOGIN_PATTERN = "^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$";
const GITHUB_TEAM_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_.-]*$";

const RuleModeSchema = (description: string, withDefault: boolean) =>
  StringEnum(RULE_MODES, withDefault ? { description, default: "observe" } : { description });

const RuleActionSchema = (description: string) => StringEnum(RULE_ACTIONS, { description });

const AgentsSchema = (withDefault: boolean) =>
  Type.Array(StringEnum(AGENT_SELECTORS, { description: "An agent, or all." }), {
    minItems: 1,
    description: 'Agents the rule applies to. "all" matches every agent.',
    ...(withDefault ? { default: ["all"] } : {}),
  });

export const RuleMatchSchema = Type.Object(
  {
    tool: Type.Optional(
      NonEmpty({ description: "Exact tool name, for example Bash, Edit or an MCP tool name." }),
    ),
    command: Type.Optional(
      NonEmpty({ description: "Regular expression tested against shell commands." }),
    ),
    path: Type.Optional(
      NonEmpty({ description: "Glob tested against file paths relative to the repository root." }),
    ),
    url: Type.Optional(NonEmpty({ description: "Glob tested against URLs the agent requests." })),
  },
  {
    additionalProperties: false,
    minProperties: 1,
    description: "What the rule matches. Every field given must match.",
  },
);

export const RuleSchema = Type.Object(
  {
    id: Type.String({
      pattern: RULE_ID_PATTERN,
      description: "Stable rule id, recorded on every decision the rule makes.",
    }),
    description: Type.Optional(Type.String({ description: "What the rule is for." })),
    mode: Type.Optional(
      RuleModeSchema(
        "observe records what the rule would have done, enforce applies it, off disables it.",
        true,
      ),
    ),
    agents: Type.Optional(AgentsSchema(true)),
    match: RuleMatchSchema,
    action: RuleActionSchema("block stops the action, ask sends it to a person."),
    message: NonEmpty({ description: "Shown to the agent and the person when the rule fires." }),
    irreversible: Type.Optional(
      Type.Boolean({
        default: false,
        description: "true when the matched action cannot be undone, which raises review risk.",
      }),
    ),
  },
  {
    additionalProperties: false,
    description: "One rule: what it matches, what it does and whether it is enforced yet.",
  },
);

export const RedactionSchema = Type.Object(
  {
    name: NonEmpty({
      description:
        "Name of the pattern. Each match is stored as [redacted:<name>] and the field's path goes in the event's redacted list.",
    }),
    pattern: NonEmpty({
      description:
        "Regular expression whose matches are masked before storage, on top of the built-in secret and email patterns.",
    }),
  },
  {
    additionalProperties: false,
    description: "A pattern masked in everything the ledger stores.",
  },
);

/** [mcp] and [models]: an allow list checked on every tool call, with its own rule id. */
const AllowListSection = (ruleId: string, what: { one: string; many: string; against: string }) =>
  Type.Object(
    {
      mode: Type.Optional(
        RuleModeSchema(
          `observe records calls that break the allow list, enforce blocks them, off turns the check off. Set it per team with [teams.<name>.rules."${ruleId}"].`,
          true,
        ),
      ),
      allow: Type.Optional(
        Type.Array(NonEmpty(), {
          default: [],
          description: `Names or globs of the ${what.many} agents may use, matched against ${what.against}. Empty or absent allows every ${what.one}.`,
        }),
      ),
    },
    {
      additionalProperties: false,
      default: {},
      description: `Allowed ${what.many}. A call outside the list gets a block verdict recorded under rule id "${ruleId}".`,
    },
  );

export const RuleOverrideSchema = Type.Object(
  {
    mode: Type.Optional(RuleModeSchema("Mode for this team.", false)),
    agents: Type.Optional(AgentsSchema(false)),
    action: Type.Optional(RuleActionSchema("Action for this team.")),
    message: Type.Optional(NonEmpty({ description: "Message for this team." })),
  },
  {
    additionalProperties: false,
    minProperties: 1,
    description: "Fields of the rule this team sees differently. The rest come from the rule.",
  },
);

export const TeamSchema = Type.Object(
  {
    members: Type.Optional(
      Type.Array(NonEmpty({ description: "Person id, as in [review] owners." }), {
        default: [],
        description: "People in the team.",
      }),
    ),
    rules: Type.Optional(
      Type.Record(Type.String(), RuleOverrideSchema, {
        default: {},
        description: `Per-rule overrides for this team, keyed by rule id. "${MCP_ALLOW_RULE_ID}" and "${MODELS_ALLOW_RULE_ID}" override the [mcp] and [models] checks.`,
      }),
    ),
  },
  // The default lets Value.Default fill members and rules inside the teams record.
  {
    additionalProperties: false,
    default: {},
    description: "A team: its members and the rule overrides that apply to them.",
  },
);

const UsdPerWindow = (description: string) =>
  Type.Optional(Type.Number({ exclusiveMinimum: 0, description }));

export const PlanLimitsSchema = Type.Object(
  {
    session_usd: UsdPerWindow("Usage that fills the 5-hour session window."),
    weekly_usd: UsdPerWindow("Usage that fills the weekly window."),
  },
  {
    additionalProperties: false,
    minProperties: 1,
    description:
      "Approximate limits of one plan tier, in API-equivalent USD (the estimated cost the ledger records for the same tokens).",
  },
);

const PlanTiersSchema = (plan: string) =>
  Type.Optional(
    Type.Record(Type.String({ pattern: "^[a-z0-9_]+$" }), PlanLimitsSchema, {
      additionalProperties: false,
      description: `${plan} plan tiers by name, for example max_5x. Each one overrides the same tier in the built-in table.`,
    }),
  );

export const SelfhostConfigSchema = Type.Object(
  {
    version: Type.Literal(1, { description: "selfhost.toml format version." }),
    org: Type.Optional(
      Type.Object(
        { name: NonEmpty({ description: "Organization name." }) },
        { additionalProperties: false, description: "The organization this file belongs to." },
      ),
    ),
    ledger: Type.Optional(
      Type.Object(
        {
          retention_days: Type.Optional(
            Type.Integer({ minimum: 1, default: 90, description: "Days to keep ledger events." }),
          ),
          log_prompts: Type.Optional(
            Type.Boolean({
              default: false,
              description: "Store prompt text. Off by default: only metadata is stored.",
            }),
          ),
        },
        {
          additionalProperties: false,
          default: {},
          description: "What the ledger keeps and for how long.",
        },
      ),
    ),
    redaction: Type.Optional(
      Type.Array(RedactionSchema, {
        default: [],
        description:
          "Extra patterns to mask before anything is stored, on top of the built-in secret and email patterns.",
      }),
    ),
    rules: Type.Optional(
      Type.Array(RuleSchema, {
        default: [],
        description:
          "Rules checked on every tool call, in file order. Each starts in observe and moves to enforce with selfhost policy promote.",
      }),
    ),
    review: Type.Optional(
      Type.Object(
        {
          high_risk_paths: Type.Optional(
            Type.Array(NonEmpty(), {
              default: [],
              description: "Globs whose changes always rank as high risk.",
            }),
          ),
          high_risk_threshold: Type.Optional(
            Type.Integer({
              minimum: 0,
              maximum: 100,
              default: 70,
              description: "Risk score at or above which an item counts as high risk.",
            }),
          ),
          owners: Type.Optional(
            Type.Record(
              Type.String(),
              Type.Array(NonEmpty(), {
                minItems: 1,
                description: "People who review changes under this glob.",
              }),
              {
                default: {},
                description: "Path glob to the people who review changes under it.",
              },
            ),
          ),
          fallback: Type.Optional(
            Type.Array(NonEmpty(), {
              default: [],
              description:
                "People who get review items that match no owner glob, have no session person and no team in [teams].",
            }),
          ),
          approval_timeout_minutes: Type.Optional(
            Type.Integer({
              minimum: 1,
              default: 30,
              description:
                "Minutes an approval that blocks an agent waits for an answer. Then it is denied and the deny is written to the decision log.",
            }),
          ),
          github_logins: Type.Optional(
            Type.Record(
              Type.String(),
              Type.String({
                pattern: GITHUB_LOGIN_PATTERN,
                description: "GitHub login, without the @.",
              }),
              {
                default: {},
                description:
                  "Person id (as in owners) to GitHub login. The GitHub App requests a review from the owner the review list picked under this login.",
              },
            ),
          ),
          github_team: Type.Optional(
            Type.String({
              pattern: GITHUB_TEAM_PATTERN,
              description:
                "Slug of the GitHub team asked to review when the owner has no login in github_logins, as in github.com/orgs/<org>/teams/<slug>.",
            }),
          ),
          block_merge_on_high: Type.Optional(
            Type.Boolean({
              default: false,
              description:
                "Fail the selfhost/review check on high risk pull requests. It blocks a merge only once branch protection or a ruleset makes the check required.",
            }),
          ),
        },
        {
          additionalProperties: false,
          default: {},
          description: "How agent work is scored, routed and timed in the review list.",
        },
      ),
    ),
    packages: Type.Optional(
      Type.Object(
        {
          mode: Type.Optional(
            RuleModeSchema(
              "observe logs installs that break the policy, enforce blocks them.",
              true,
            ),
          ),
          allow: Type.Optional(
            Type.Array(NonEmpty(), {
              default: [],
              description: "Package names or globs to allow.",
            }),
          ),
          deny: Type.Optional(
            Type.Array(NonEmpty(), { default: [], description: "Package names or globs to deny." }),
          ),
          min_age_days: Type.Optional(
            Type.Integer({
              minimum: 0,
              description: "Flag package versions published fewer than this many days ago.",
            }),
          ),
        },
        {
          additionalProperties: false,
          default: {},
          description: "Which packages agents may install.",
        },
      ),
    ),
    mcp: Type.Optional(
      AllowListSection(MCP_ALLOW_RULE_ID, {
        one: "MCP server",
        many: "MCP servers",
        against: "the server part of the tool name, mcp__<server>__<tool>",
      }),
    ),
    models: Type.Optional(
      AllowListSection(MODELS_ALLOW_RULE_ID, {
        one: "model",
        many: "models",
        against: "the model id the agent reports",
      }),
    ),
    alerts: Type.Optional(
      Type.Object(
        {
          spike_factor: Type.Optional(
            Type.Number({
              exclusiveMinimum: 1,
              default: 10,
              description:
                "Raise a spend spike when spend exceeds this multiple of the usual rate.",
            }),
          ),
          spike_floor_usd: Type.Optional(
            Type.Number({
              minimum: 0,
              default: 5,
              description: "Spend under this many USD in 15 minutes never raises a spike alarm.",
            }),
          ),
          spike_baseline_days: Type.Optional(
            Type.Integer({
              minimum: 3,
              maximum: 60,
              default: 14,
              description:
                "Trailing days the spike baseline uses for each 15-minute slot of the day.",
            }),
          ),
          forecast_warn_hours: Type.Optional(
            Type.Number({
              exclusiveMinimum: 0,
              default: 24,
              description: "Warn when a plan limit is forecast to run out within this many hours.",
            }),
          ),
          runbook_url: Type.Optional(
            Url({ description: "Key rotation runbook linked from spend spike alarms." }),
          ),
        },
        {
          additionalProperties: false,
          default: {},
          description: "When the spend spike alarm and the plan limit forecast speak up.",
        },
      ),
    ),
    plans: Type.Optional(
      Type.Object(
        {
          as_of: Type.Optional(
            Type.String({
              pattern: "^\\d{4}-\\d{2}-\\d{2}$",
              description: "Day the limits below were last checked, YYYY-MM-DD.",
            }),
          ),
          claude: PlanTiersSchema("Claude"),
          codex: PlanTiersSchema("Codex"),
          overflow: Type.Optional(
            Type.Object(
              {
                key: NonEmpty({
                  description:
                    "Team API key to overflow to, by its gateway alias, suggested when a plan limit is about to run out.",
                }),
                monthly_cap_usd: Type.Number({
                  exclusiveMinimum: 0,
                  description: "Spend cap on that key per calendar month (UTC).",
                }),
              },
              {
                additionalProperties: false,
                description: "Team API key suggested when a plan limit is about to run out.",
              },
            ),
          ),
        },
        {
          additionalProperties: false,
          description:
            "Subscription plan limits for the limit forecast. Vendors do not publish them as numbers, so these override a dated built-in table. Each person sets their own tier.",
        },
      ),
    ),
    teams: Type.Optional(
      Type.Record(Type.String(), TeamSchema, { default: {}, description: "Teams by name." }),
    ),
  },
  {
    $id: CONFIG_SCHEMA_URL,
    title: "SelfhostConfig",
    description:
      "selfhost.toml: team config compiled into each agent's own config. Rules start in observe and move to enforce.",
    additionalProperties: false,
  },
);

export type SelfhostConfig = Static<typeof SelfhostConfigSchema>;
export type Rule = Static<typeof RuleSchema>;
export type RuleMatch = Static<typeof RuleMatchSchema>;
export type RuleOverride = Static<typeof RuleOverrideSchema>;
export type Team = Static<typeof TeamSchema>;
export type PlanLimits = Static<typeof PlanLimitsSchema>;

type Present<T> = Exclude<T, undefined>;

export type ResolvedRule = Rule & Required<Pick<Rule, "mode" | "agents" | "irreversible">>;
export type ResolvedTeam = Required<Team>;

/** A config after defaults are applied: every section is present. */
export type ResolvedSelfhostConfig = Omit<
  SelfhostConfig,
  "ledger" | "redaction" | "rules" | "review" | "packages" | "mcp" | "models" | "alerts" | "teams"
> & {
  ledger: Required<Present<SelfhostConfig["ledger"]>>;
  redaction: Present<SelfhostConfig["redaction"]>;
  rules: ResolvedRule[];
  review: Present<SelfhostConfig["review"]> &
    Required<Omit<Present<SelfhostConfig["review"]>, "github_team">>;
  packages: Present<SelfhostConfig["packages"]> &
    Required<Pick<Present<SelfhostConfig["packages"]>, "mode" | "allow" | "deny">>;
  mcp: Required<Present<SelfhostConfig["mcp"]>>;
  models: Required<Present<SelfhostConfig["models"]>>;
  alerts: Present<SelfhostConfig["alerts"]> &
    Required<Omit<Present<SelfhostConfig["alerts"]>, "runbook_url">>;
  teams: Record<string, ResolvedTeam>;
};

export type ConfigResult =
  | { ok: true; config: ResolvedSelfhostConfig }
  | { ok: false; errors: FieldError[] };

const configCheck = lazyCheck(SelfhostConfigSchema);

function regexError(pattern: string): string | undefined {
  try {
    new RegExp(pattern);
    return undefined;
  } catch (error) {
    return `Invalid regular expression: ${(error as Error).message}`;
  }
}

function semanticErrors(config: ResolvedSelfhostConfig): SegmentError[] {
  const errors: SegmentError[] = [];
  const ruleIds = new Map<string, number>();
  // A built-in id is taken only once its allow list is in use, so files written before
  // [mcp] and [models] existed stay valid.
  const builtIn = new Map([
    [MCP_ALLOW_RULE_ID, config.mcp.allow.length > 0 ? "[mcp] allow" : undefined],
    [MODELS_ALLOW_RULE_ID, config.models.allow.length > 0 ? "[models] allow" : undefined],
  ]);
  config.rules.forEach((rule, index) => {
    const earlier = ruleIds.get(rule.id);
    const reservedBy = builtIn.get(rule.id);
    if (earlier !== undefined) {
      errors.push({
        segments: ["rules", index, "id"],
        message: `Duplicate rule id "${rule.id}", also used by rules[${earlier}]`,
      });
    } else if (reservedBy) {
      errors.push({
        segments: ["rules", index, "id"],
        message: `Rule id "${rule.id}" is reserved for ${reservedBy}`,
      });
    } else {
      ruleIds.set(rule.id, index);
    }
    if (rule.match.command !== undefined) {
      const message = regexError(rule.match.command);
      if (message) errors.push({ segments: ["rules", index, "match", "command"], message });
    }
  });
  config.redaction.forEach((redaction, index) => {
    const message = regexError(redaction.pattern);
    if (message) errors.push({ segments: ["redaction", index, "pattern"], message });
  });
  for (const [team, { rules }] of Object.entries(config.teams)) {
    for (const ruleId of Object.keys(rules)) {
      if (!ruleIds.has(ruleId) && !builtIn.has(ruleId)) {
        errors.push({
          segments: ["teams", team, "rules", ruleId],
          message: `Override for unknown rule "${ruleId}"`,
        });
      }
    }
  }
  return errors;
}

function check(value: unknown): { config?: ResolvedSelfhostConfig; errors: SegmentError[] } {
  const withDefaults = Value.Default(SelfhostConfigSchema, Value.Clone(value));
  const errors = schemaErrors(configCheck(), withDefaults);
  if (errors.length > 0) return { errors };
  const config = withDefaults as ResolvedSelfhostConfig;
  const semantic = semanticErrors(config);
  return semantic.length > 0 ? { errors: semantic } : { config, errors: [] };
}

/** Validates an already parsed config object and applies defaults. */
export function validateConfig(value: unknown): ConfigResult {
  const { config, errors } = check(value);
  if (config) return { ok: true, config };
  return {
    ok: false,
    errors: errors.map((e) => ({ field: formatField(e.segments), message: e.message })),
  };
}

/**
 * Parses selfhost.toml text, applies defaults and validates it. Errors name the field and,
 * when it can be found, the line.
 */
export function parseConfig(text: string): ConfigResult {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (error) {
    if (error instanceof TomlError) {
      const message = error.message.split("\n")[0] ?? error.message;
      return {
        ok: false,
        errors: [{ field: "(toml)", message, line: error.line, column: error.column }],
      };
    }
    throw error;
  }
  const { config, errors } = check(raw);
  if (config) return { ok: true, config };
  const lines = new TomlLineIndex(text);
  return {
    ok: false,
    errors: errors.map((e) => {
      const line = lines.lineOf(e.segments);
      const field = formatField(e.segments);
      return line === undefined
        ? { field, message: e.message }
        : { field, message: e.message, line };
    }),
  };
}

export function formatConfigError(error: FieldError, file = CONFIG_FILE_NAME): string {
  const where = error.line === undefined ? file : `${file}:${error.line}`;
  return `${where}: ${error.field}: ${error.message}`;
}
