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

/** Every rule id the package guard records starts with this. */
export const PACKAGE_RULE_PREFIX = "packages.";
/** Rule ids the package guard records for installs that break [packages], one per check. */
export const PACKAGE_RULE_IDS = {
  /** The registry has no package by that name: block. */
  not_found: "packages.not_found",
  /** The version was published fewer than min_age_days ago: ask. */
  too_new: "packages.too_new",
  /** The package runs code at install: install_scripts decides. */
  install_scripts: "packages.install_scripts",
  /** The install uses a registry in blocked_registries: block. */
  blocked_registry: "packages.blocked_registry",
  /** The package is in deny: block. */
  deny: "packages.deny",
  /** OSV lists the package or version as malicious: block. */
  malicious: "packages.malicious",
  /** The registry could not be reached in time, so the install ran unchecked: always observe. */
  unchecked: "packages.unchecked",
} as const;

export const INSTALL_SCRIPT_ACTIONS = ["ask", "block", "allow"] as const;
export type InstallScriptAction = (typeof INSTALL_SCRIPT_ACTIONS)[number];

/** Rule ids of the built-in guardrails that pre-tool hooks apply, in the order they are checked. */
export const GUARDRAIL_IDS = [
  "guard.force_push",
  "guard.reset_hard",
  "guard.rm_outside_workspace",
  "guard.secret_read",
  "guard.prod_sql",
  "guard.prod_credentials",
] as const;

export type GuardrailId = (typeof GUARDRAIL_IDS)[number];

/** [runtime] run_mode: whether run commands of several workspaces may run at the same time. */
export const RUN_MODES = ["concurrent", "exclusive"] as const;
export type RunMode = (typeof RUN_MODES)[number];

/**
 * Variables the runtime sets for every [runtime] setup, run and archive command, and that
 * [runtime.env] values may refer to. Names that start with SELFHOST_ are reserved for these.
 */
export const RUNTIME_VARIABLES = {
  SELFHOST_WORKSPACE_NAME: "Name of the workspace, which also names its branch.",
  SELFHOST_WORKSPACE_PATH: "Folder of the workspace checkout. Every command starts there.",
  SELFHOST_ROOT_PATH:
    "Folder of the repository's main checkout. In a sandbox it is the workspace folder.",
  SELFHOST_DEFAULT_BRANCH: "Branch the workspace was cut from and merges into, usually main.",
  SELFHOST_PORT:
    "First of 10 ports kept for the workspace, so SELFHOST_PORT to SELFHOST_PORT + 9 are free to use.",
} as const;
export type RuntimeVariable = keyof typeof RUNTIME_VARIABLES;
export const RUNTIME_VARIABLE_PREFIX = "SELFHOST_";

const RUN_NAME_PATTERN = "^[A-Za-z0-9][A-Za-z0-9 _-]*$";
const ENV_NAME_PATTERN = "^[A-Za-z_][A-Za-z0-9_]*$";

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
    alternative: Type.Optional(
      NonEmpty({
        description:
          'What the agent should do instead, shown with the message when the rule blocks or asks, for example "Open a pull request instead."',
      }),
    ),
    docs: Type.Optional(
      Url({ description: "Page that explains the rule, linked from every block and ask." }),
    ),
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
    alternative: Type.Optional(NonEmpty({ description: "Alternative for this team." })),
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

export const RunCommandSchema = Type.Object(
  {
    command: NonEmpty({
      description:
        "Shell command that starts the app, a server, a worker, a watcher or a test loop in the workspace.",
    }),
    cwd: Type.Optional(
      NonEmpty({ description: "Folder to run it in, relative to the workspace folder." }),
    ),
    default: Type.Optional(
      Type.Boolean({
        description: "The command to start when none is named. At most one command sets it.",
      }),
    ),
  },
  { additionalProperties: false, description: "One named command that runs the project." },
);

const variableList = Object.keys(RUNTIME_VARIABLES).join(", ");

export const RuntimeSchema = Type.Object(
  {
    setup: Type.Optional(
      NonEmpty({
        description:
          "Shell script run in each new workspace after checkout and before the agent starts: install dependencies, generate files, link local config.",
      }),
    ),
    run: Type.Optional(
      Type.Record(Type.String({ pattern: RUN_NAME_PATTERN }), RunCommandSchema, {
        additionalProperties: false,
        description:
          "Named commands that run the project in a workspace, for example [runtime.run.dev].",
      }),
    ),
    run_mode: Type.Optional(
      StringEnum(RUN_MODES, {
        default: "concurrent",
        description:
          "concurrent lets the run commands of several workspaces run at once. exclusive stops the others first, for projects that need one fixed port, database or Docker stack.",
      }),
    ),
    archive: Type.Optional(
      NonEmpty({
        description:
          "Shell script run before a workspace is archived, to clean up what it made outside its own folder.",
      }),
    ),
    env: Type.Optional(
      Type.Record(Type.String({ pattern: ENV_NAME_PATTERN }), Type.String(), {
        additionalProperties: false,
        description: `Environment variables for the setup, run and archive commands. Values may refer to the variables selfhost sets (${variableList}) as $NAME or \${NAME}. This file is shared: keep secrets out of it.`,
      }),
    ),
  },
  {
    additionalProperties: false,
    description: `How each agent workspace is set up, run and cleaned up, read by the runtime plugin. Commands run in the workspace folder with ${variableList} set.`,
  },
);

export const ReceiptConfigSchema = Type.Object(
  {
    start: Type.Optional(
      NonEmpty({
        description:
          "Shell command that starts the app for the proof receipt's screenshots. Default: the default [runtime.run] command.",
      }),
    ),
    cwd: Type.Optional(
      NonEmpty({
        description:
          "Folder to run start in, relative to the repository root. Default: the run command's cwd.",
      }),
    ),
    port: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 65535,
        description:
          "Port the app listens on, passed to start as SELFHOST_PORT and PORT. Default: a free port.",
      }),
    ),
    ready_url: Type.Optional(
      NonEmpty({
        description:
          "URL that answers once the app is up, also the base URL of the screens. $SELFHOST_PORT expands. Default: http://127.0.0.1:$SELFHOST_PORT/.",
      }),
    ),
    ready_timeout_seconds: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "Seconds to wait for ready_url to answer before the app counts as failed. Default: 120.",
      }),
    ),
    test_command: Type.Optional(
      NonEmpty({
        description:
          "Command for the tests the pull request adds or changes, run from the repository root: {file} is one test file (run once per file), {files} all of them (run once). Default: the runner each file's package uses (vitest, jest, node --test, pytest or go test).",
      }),
    ),
    tests: Type.Optional(
      Type.Array(NonEmpty(), {
        description:
          "Extra globs of test files, on top of the usual names (*.test.*, *.spec.*, __tests__/, test_*.py, *_test.py, *_test.go).",
      }),
    ),
    test_timeout_seconds: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "Seconds each test run may take before it is stopped. Default: 600.",
      }),
    ),
    max_tests: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "Most test runs per receipt; the rest are listed as not run. Default: 20.",
      }),
    ),
    screens: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Union([NonEmpty(), Type.Array(NonEmpty(), { minItems: 1 })], {
          description:
            "URL path, or paths, of the screens that show these files, such as /settings.",
        }),
        {
          description:
            "Globs of changed files to the screens Playwright takes screenshots of. Without it the receipt captures the home page.",
        },
      ),
    ),
    max_screens: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "Most screenshots per receipt. Default: 10.",
      }),
    ),
  },
  {
    additionalProperties: false,
    description:
      "The proof receipt on agent pull requests: how CI starts the app, runs the tests the change adds or edits, and which screens it takes screenshots of. Setup and the start command come from [runtime] unless set here.",
  },
);

const PlanTiersSchema = (plan: string) =>
  Type.Optional(
    Type.Record(Type.String({ pattern: "^[a-z0-9_]+$" }), PlanLimitsSchema, {
      additionalProperties: false,
      description: `${plan} plan tiers by name, for example max_5x. Each one overrides the same tier in the built-in table.`,
    }),
  );

const BudgetUsd = (window: string) =>
  Type.Optional(
    Type.Number({
      exclusiveMinimum: 0,
      description: `Spend allowed per ${window} (UTC), in API-equivalent USD.`,
    }),
  );

export const BudgetSchema = Type.Object(
  {
    daily_usd: BudgetUsd("day"),
    weekly_usd: BudgetUsd("week, from Monday"),
    monthly_usd: BudgetUsd("calendar month"),
  },
  {
    additionalProperties: false,
    minProperties: 1,
    description:
      "Spend budget of the team whose selfhost.toml this is; in the org policy, of the whole org. Spend is shown against it. Nothing is charged back and nothing is stopped.",
  },
);

/** A day, YYYY-MM-DD (midnight UTC), or a date-time with a zone. */
const DAY_OR_TIME_PATTERN =
  "^\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:\\d{2}))?$";

const BaselineTime = (description: string) =>
  Type.Optional(
    Type.String({
      pattern: DAY_OR_TIME_PATTERN,
      description: `${description} A day (YYYY-MM-DD, midnight UTC) or a date-time with a zone, in quotes.`,
    }),
  );

export const RoiConfigSchema = Type.Object(
  {
    baseline_from: BaselineTime("Start of the baseline period, included."),
    baseline_to: BaselineTime("End of the baseline period, excluded."),
  },
  {
    additionalProperties: false,
    description:
      "Cost per merged pull request. The baseline it is compared with is the team's first 7 days of data unless both baseline_from and baseline_to are set. Either way it is computed once, after the period ends, and frozen.",
  },
);

export const ROUTER_TOOLS = ["bifrost", "litellm"] as const;
export const TRACER_TOOLS = ["langfuse", "phoenix", "datadog", "otlp"] as const;
export const RUNTIME_TOOLS = ["e2b", "daytona", "modal", "coder"] as const;
export const REVIEWER_TOOLS = ["pr-agent", "claude-code-action", "coderabbit"] as const;
export type RouterTool = (typeof ROUTER_TOOLS)[number];
export type TracerTool = (typeof TRACER_TOOLS)[number];
export type RuntimeTool = (typeof RUNTIME_TOOLS)[number];
export type ReviewerTool = (typeof REVIEWER_TOOLS)[number];

const EnvName = (description: string) => Type.String({ pattern: ENV_NAME_PATTERN, description });
const HttpUrl = (description: string) => Type.String({ pattern: "^https?://", description });

export const IntegrationsSchema = Type.Object(
  {
    router: Type.Optional(
      Type.Object(
        {
          tool: StringEnum(ROUTER_TOOLS, {
            description:
              "The AI gateway agents' model traffic goes through: bifrost (bundled with the selfhost server) or litellm (one the team already runs).",
          }),
          url: Type.Optional(
            HttpUrl(
              "The gateway's address. Unset uses the bundled Bifrost at http://bifrost:8080.",
            ),
          ),
          admin_key_env: Type.Optional(
            EnvName("Environment variable on the server that holds the gateway's admin key."),
          ),
        },
        { additionalProperties: false, description: "The AI gateway (model router)." },
      ),
    ),
    tracer: Type.Optional(
      Type.Object(
        {
          tool: StringEnum(TRACER_TOOLS, {
            description:
              "Where selfhost sends agent traces: langfuse, phoenix, datadog, or otlp for any OpenTelemetry endpoint.",
          }),
          endpoint: HttpUrl(
            "The tracer's OTLP over HTTP endpoint. Spans go to <endpoint>/v1/traces as protobuf, unless it already ends in /v1/traces.",
          ),
          headers_env: Type.Optional(
            Type.Record(
              Type.String(),
              EnvName("Environment variable that holds the header value."),
              {
                description:
                  "Headers to send, by name, each read from an environment variable on the server (for API keys).",
              },
            ),
          ),
          run_url: Type.Optional(
            Type.String({
              description:
                "Link template to one run in the tracer's own UI, for the console's run view and pull request briefs. {run_id} is replaced with the run (session) id and {trace_id} with the 32-hex OpenTelemetry trace id selfhost sends it under.",
            }),
          ),
        },
        { additionalProperties: false, description: "The tracing tool the team already uses." },
      ),
    ),
    runtime: Type.Optional(
      Type.Object(
        {
          tool: StringEnum(RUNTIME_TOOLS, {
            description: "Where background agents run: e2b, daytona, modal or coder.",
          }),
          url: Type.Optional(
            HttpUrl("The provider's API address, for coder and self-hosted providers."),
          ),
          api_key_env: Type.Optional(
            EnvName("Environment variable on the server that holds the provider's API key."),
          ),
          template: Type.Optional(
            NonEmpty({ description: "The provider's template, snapshot or image to start from." }),
          ),
        },
        { additionalProperties: false, description: "The runtime for background agents." },
      ),
    ),
    reviewer: Type.Optional(
      Type.Object(
        {
          tool: StringEnum(REVIEWER_TOOLS, {
            description:
              "The AI reviewer whose findings join the review list: pr-agent, claude-code-action or coderabbit.",
          }),
          api_key_env: Type.Optional(
            EnvName(
              "Environment variable that holds the reviewer's model API key, in CI or on the server.",
            ),
          ),
        },
        { additionalProperties: false, description: "The AI code reviewer." },
      ),
    ),
  },
  {
    additionalProperties: false,
    default: {},
    description:
      "The tool selfhost plugs in for each job. Pick the best one and swap it any time; selfhost connects it and keeps the record. Secrets are named by environment variable, never written here.",
  },
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
          exception_expiry_minutes: Type.Optional(
            Type.Integer({
              minimum: 1,
              default: 30,
              description:
                "Minutes a one-time exception stays usable once a person approves it. The blocked call is allowed once in that time, then blocked again.",
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
          revert_rate_threshold: Type.Optional(
            Type.Number({
              minimum: 0,
              maximum: 1,
              default: 0.25,
              description:
                "Share of a module's agent-written lines reverted or reworked within revert_window_days of merge (fix-forward edits count as rework), from 0 to 1. New pull requests that touch a module above it score higher risk.",
            }),
          ),
          revert_window_days: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: 90,
              default: 14,
              description:
                "Days after a merge in which a later commit that changes or deletes the merged lines counts as a revert or rework.",
            }),
          ),
          modules: Type.Optional(
            Type.Record(
              Type.String({ minLength: 1 }),
              Type.Array(NonEmpty(), {
                minItems: 1,
                description: "Path globs of the files in this module.",
              }),
              {
                default: {},
                description:
                  "Module name to path globs, for agent-written code share and revert rates. The first module whose glob matches a file holds it; other files belong to their top folder (module_depth folders deep).",
              },
            ),
          ),
          module_depth: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: 5,
              default: 1,
              description:
                "How many leading folders name the module of a file no modules glob matches: 1 gives apps, 2 gives apps/server. Files at the top of the repository are in the module (root).",
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
              description:
                'Package names or globs installed without any registry check, for example "@acme/*". Prefix one with npm:, pypi:, cargo: or go: to limit it to that registry.',
            }),
          ),
          deny: Type.Optional(
            Type.Array(NonEmpty(), {
              default: [],
              description:
                "Package names or globs to deny, with the same prefixes as allow. Deny wins over allow.",
            }),
          ),
          min_age_days: Type.Optional(
            Type.Integer({
              minimum: 0,
              description: "Flag package versions published fewer than this many days ago.",
            }),
          ),
          blocked_registries: Type.Optional(
            Type.Array(NonEmpty(), {
              default: [],
              description:
                'Registry hosts, URLs or globs installs may not use, for example "registry.npmjs.cf" or "*.example.com". Matched against every registry, index or proxy an install names (--registry, --index-url, --extra-index-url, GOPROXY, cargo --index or --registry) or else its default one, and against the host of a URL or git install.',
            }),
          ),
          install_scripts: Type.Optional(
            StringEnum(INSTALL_SCRIPT_ACTIONS, {
              default: "ask",
              description:
                "Packages that run code at install (npm install scripts, a PyPI release with no wheel): ask flags them for a person, block stops them, allow skips the check.",
            }),
          ),
        },
        {
          additionalProperties: false,
          default: {},
          description: `Checks on every package an agent installs with npm, pnpm, yarn, bun, pip, uv, poetry, pipx, cargo or go, recorded under rule ids that start with "${PACKAGE_RULE_PREFIX}".`,
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
    guardrails: Type.Optional(
      Type.Object(
        {
          mode: Type.Optional(
            StringEnum(RULE_MODES, {
              default: "enforce",
              description:
                "enforce blocks what the guardrails catch, observe records it and blocks nothing, off turns them all off.",
            }),
          ),
          disable: Type.Optional(
            Type.Array(StringEnum(GUARDRAIL_IDS), {
              default: [],
              description: "Guardrails to turn off, by rule id.",
            }),
          ),
          prod_connections: Type.Optional(
            Type.Array(NonEmpty(), {
              default: [],
              description:
                "Globs that mark production databases, matched against the hosts, connection URLs, database names and environment variable names in a command. DROP or TRUNCATE in a command that names one is blocked under guard.prod_sql.",
            }),
          ),
          prod_credentials: Type.Optional(
            Type.Array(NonEmpty(), {
              default: [],
              description:
                "Globs that mark production credentials, matched against the environment variable names a command reads or sets, the values of --profile, --context and similar flags, and the paths of files a tool reads (~/ is the home folder). A match is blocked under guard.prod_credentials.",
            }),
          ),
        },
        {
          additionalProperties: false,
          default: {},
          description: `Built-in guardrails the pre-tool hooks apply on top of [[rules]]: force push, git reset --hard, rm -rf outside the workspace, reading .env and key files, DROP or TRUNCATE on production databases and use of production credentials. They block by default. Rule ids: ${GUARDRAIL_IDS.join(", ")}.`,
        },
      ),
    ),
    budget: Type.Optional(BudgetSchema),
    teams: Type.Optional(
      Type.Record(Type.String(), TeamSchema, { default: {}, description: "Teams by name." }),
    ),
    runtime: Type.Optional(RuntimeSchema),
    receipt: Type.Optional(ReceiptConfigSchema),
    integrations: Type.Optional(IntegrationsSchema),
    roi: Type.Optional(RoiConfigSchema),
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
export type Runtime = Static<typeof RuntimeSchema>;
export type RunCommand = Static<typeof RunCommandSchema>;
export type ReceiptConfig = Static<typeof ReceiptConfigSchema>;
export type Budget = Static<typeof BudgetSchema>;
export type RoiConfig = Static<typeof RoiConfigSchema>;

type Present<T> = Exclude<T, undefined>;

export type ResolvedRule = Rule & Required<Pick<Rule, "mode" | "agents" | "irreversible">>;
export type ResolvedTeam = Required<Team>;

/** A config after defaults are applied: every section is present. */
export type ResolvedSelfhostConfig = Omit<
  SelfhostConfig,
  | "ledger"
  | "redaction"
  | "rules"
  | "review"
  | "packages"
  | "mcp"
  | "models"
  | "alerts"
  | "guardrails"
  | "teams"
  | "integrations"
> & {
  ledger: Required<Present<SelfhostConfig["ledger"]>>;
  redaction: Present<SelfhostConfig["redaction"]>;
  rules: ResolvedRule[];
  review: Present<SelfhostConfig["review"]> &
    Required<Omit<Present<SelfhostConfig["review"]>, "github_team">>;
  packages: Present<SelfhostConfig["packages"]> &
    Required<
      Pick<
        Present<SelfhostConfig["packages"]>,
        "mode" | "allow" | "deny" | "blocked_registries" | "install_scripts"
      >
    >;
  mcp: Required<Present<SelfhostConfig["mcp"]>>;
  models: Required<Present<SelfhostConfig["models"]>>;
  alerts: Present<SelfhostConfig["alerts"]> &
    Required<Omit<Present<SelfhostConfig["alerts"]>, "runbook_url">>;
  guardrails: Required<Present<SelfhostConfig["guardrails"]>>;
  integrations: Present<SelfhostConfig["integrations"]>;
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

export interface ParseOptions {
  /**
   * Rule ids defined in another layer of the same policy, such as the org floor, that
   * `[teams.<name>.rules.<id>]` overrides in this file may name.
   */
  knownRuleIds?: ReadonlySet<string>;
}

function semanticErrors(
  config: ResolvedSelfhostConfig,
  { knownRuleIds = new Set() }: ParseOptions = {},
): SegmentError[] {
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
    } else if (rule.id.startsWith(PACKAGE_RULE_PREFIX)) {
      errors.push({
        segments: ["rules", index, "id"],
        message: `Rule id "${rule.id}" is reserved: ids that start with "${PACKAGE_RULE_PREFIX}" belong to [packages]`,
      });
    } else if ((GUARDRAIL_IDS as readonly string[]).includes(rule.id)) {
      errors.push({
        segments: ["rules", index, "id"],
        message: `Rule id "${rule.id}" is reserved for the built-in guardrail; set it in [guardrails]`,
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
      if (!ruleIds.has(ruleId) && !builtIn.has(ruleId) && !knownRuleIds.has(ruleId)) {
        errors.push({
          segments: ["teams", team, "rules", ruleId],
          message: `Override for unknown rule "${ruleId}"`,
        });
      }
    }
  }
  if (config.runtime) errors.push(...runtimeErrors(config.runtime));
  if (config.roi) errors.push(...roiErrors(config.roi));
  return errors;
}

/** The baseline period as dates, when [roi] sets one. */
export function roiBaselinePeriod(
  roi: RoiConfig | undefined,
): { from: Date; to: Date } | undefined {
  if (roi?.baseline_from === undefined || roi.baseline_to === undefined) return undefined;
  return { from: new Date(roi.baseline_from), to: new Date(roi.baseline_to) };
}

function roiErrors(roi: RoiConfig): SegmentError[] {
  const from = roi.baseline_from;
  const to = roi.baseline_to;
  if ((from === undefined) !== (to === undefined)) {
    const missing = from === undefined ? "baseline_from" : "baseline_to";
    return [{ segments: ["roi", missing], message: "Set both baseline_from and baseline_to" }];
  }
  for (const field of ["baseline_from", "baseline_to"] as const) {
    const value = roi[field];
    if (value !== undefined && Number.isNaN(Date.parse(value))) {
      return [{ segments: ["roi", field], message: `Not a valid date: ${value}` }];
    }
  }
  const period = roiBaselinePeriod(roi);
  if (period && period.from >= period.to) {
    return [{ segments: ["roi", "baseline_to"], message: "Expected a time after baseline_from" }];
  }
  return [];
}

function runtimeErrors(runtime: Runtime): SegmentError[] {
  const errors: SegmentError[] = [];
  let firstDefault: string | undefined;
  for (const [name, command] of Object.entries(runtime.run ?? {})) {
    if (command.default !== true) continue;
    if (firstDefault === undefined) firstDefault = name;
    else {
      errors.push({
        segments: ["runtime", "run", name, "default"],
        message: `Only one run command can be the default; runtime.run.${firstDefault} already is`,
      });
    }
  }
  for (const name of Object.keys(runtime.env ?? {})) {
    if (name.startsWith(RUNTIME_VARIABLE_PREFIX)) {
      errors.push({
        segments: ["runtime", "env", name],
        message: `Names that start with ${RUNTIME_VARIABLE_PREFIX} are set by selfhost for each workspace`,
      });
    }
  }
  return errors;
}

function check(
  value: unknown,
  options?: ParseOptions,
): { config?: ResolvedSelfhostConfig; errors: SegmentError[] } {
  const withDefaults = Value.Default(SelfhostConfigSchema, Value.Clone(value));
  const errors = schemaErrors(configCheck(), withDefaults);
  if (errors.length > 0) return { errors };
  const config = withDefaults as ResolvedSelfhostConfig;
  const semantic = semanticErrors(config, options);
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
export function parseConfig(text: string, options?: ParseOptions): ConfigResult {
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
  const { config, errors } = check(raw, options);
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
