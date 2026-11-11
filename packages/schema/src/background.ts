import { type Static, Type } from "@sinclair/typebox";
import { DateTime, NonEmpty, RepoSlug, StringEnum, Url } from "./common.js";
import { createValidator } from "./validate.js";

/**
 * Background runs: a task handed to an existing coding agent CLI (Claude Code headless, Codex
 * exec, OpenCode, Goose) inside a sandbox on the team's runtime. selfhost starts the sandbox,
 * clones the repo on a new branch, installs the team's hooks, runs the agent, gates the result,
 * opens one pull request and stops the sandbox. It never writes an agent of its own.
 *
 * The run record (`selfhost.background_run/v1`) is what GET /v1/background-runs answers. The
 * ledger gets five event kinds, each with its own versioned shape under `data`:
 * run.triggered (data.trigger), run.updated (data.background_run), run.output (data.output),
 * run.health (data.health) and run.gate (data.gate).
 */

export const BACKGROUND_RUN_SCHEMA = "selfhost.background_run/v1";
export const RUN_TRIGGER_SCHEMA = "selfhost.run_trigger/v1";
export const RUN_HEALTH_SCHEMA = "selfhost.run_health/v1";
export const RUN_GATE_SCHEMA = "selfhost.run_gate/v1";
export const RUN_OUTPUT_SCHEMA = "selfhost.run_output/v1";

/** The ledger event kinds background runs write, in the order a run writes them. */
export const BACKGROUND_EVENT_KINDS = [
  "run.triggered",
  "run.updated",
  "run.output",
  "run.health",
  "run.gate",
] as const;
export type BackgroundEventKind = (typeof BACKGROUND_EVENT_KINDS)[number];

/** The agent CLIs a background run can drive, by the name people type. */
export const BACKGROUND_AGENTS = ["claude", "codex", "opencode", "goose"] as const;
export type BackgroundAgent = (typeof BACKGROUND_AGENTS)[number];

/**
 * queued: accepted, waiting to start. starting: sandbox, clone, agent install and hooks.
 * running: the agent works. testing: the tests-first gate. pushing: branch push and pull request.
 * The rest are final.
 */
export const BACKGROUND_RUN_STATES = [
  "queued",
  "starting",
  "running",
  "testing",
  "pushing",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "stuck",
] as const;
export type BackgroundRunState = (typeof BACKGROUND_RUN_STATES)[number];

export const FINAL_RUN_STATES: readonly BackgroundRunState[] = [
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "stuck",
];

export const isFinalRunState = (state: BackgroundRunState) => FINAL_RUN_STATES.includes(state);

/** Where a run came from. */
export const RUN_TRIGGER_SOURCES = [
  "cli",
  "api",
  "console",
  "github_comment",
  "github_label",
  "schedule",
  "webhook",
] as const;
export type RunTriggerSource = (typeof RUN_TRIGGER_SOURCES)[number];

/**
 * What the agent in the sandbox signed in with. person_login: the starting person's own Claude
 * or Codex login. team_api_key: the team's key, for triggers with no person. gateway_key: a
 * per-run virtual key on the team's AI gateway. none: no credential was set up by selfhost.
 */
export const RUN_CREDENTIAL_KINDS = [
  "person_login",
  "team_api_key",
  "gateway_key",
  "none",
] as const;
export type RunCredentialKind = (typeof RUN_CREDENTIAL_KINDS)[number];

/** ok: output is flowing. quiet: no output for a while, under the stall limit. stuck: stopped. */
export const RUN_HEALTH_STATUSES = ["ok", "quiet", "stuck", "lost"] as const;
export type RunHealthStatus = (typeof RUN_HEALTH_STATUSES)[number];

/** Why run health stopped a run. */
export const RUN_STUCK_REASONS = ["no_output", "loop", "sandbox_lost"] as const;
export type RunStuckReason = (typeof RUN_STUCK_REASONS)[number];

/** off: no gate. observe: run it and report, open the pull request anyway. enforce: block it. */
export const GATE_MODES = ["off", "observe", "enforce"] as const;
export type GateMode = (typeof GATE_MODES)[number];

/** passed, failed, or skipped (gate off, or no test command found). */
export const GATE_RESULTS = ["passed", "failed", "skipped"] as const;
export type GateResult = (typeof GATE_RESULTS)[number];

/** The gate's checks, each passed or failed on its own. */
export const GATE_CHECKS = ["tests_first", "tests_pass", "dependencies", "size"] as const;
export type GateCheckName = (typeof GATE_CHECKS)[number];

/** The kill switch scopes. A run's own switch is cancel. */
export const KILL_SCOPES = ["team", "org"] as const;
export type KillScope = (typeof KILL_SCOPES)[number];

const NullableText = (description: string) =>
  Type.Union([Type.String(), Type.Null()], { description });
const NullableTime = (description: string) =>
  Type.Union([DateTime(), Type.Null()], { description });
const Usd = (description: string) => Type.Number({ minimum: 0, description });

export const RunTriggerSchema = Type.Object(
  {
    source: StringEnum(RUN_TRIGGER_SOURCES, { description: "Where the run came from." }),
    sender: NonEmpty({
      description:
        "Who sent it, as the source names them: a GitHub login, a webhook's sender field, a schedule name, or a selfhost person id for the CLI, API and console.",
    }),
    person: NullableText(
      "The selfhost person the sender maps to, or null for a schedule, or a sender with no mapping.",
    ),
    ref: Type.Optional(
      Type.String({
        description:
          "What the trigger points at: the issue or pull request URL, the schedule name, or the webhook delivery id.",
      }),
    ),
  },
  { additionalProperties: false, title: "RunTrigger", description: "Who or what started a run." },
);

export const RunCostSchema = Type.Object(
  {
    runtime_usd: Usd("Sandbox time so far, as the runtime reports it or at its list price."),
    model_usd: Usd(
      "Model spend so far: cost.recorded events the run's gateway key or hooks wrote.",
    ),
    usd: Usd("runtime_usd plus model_usd."),
    source: StringEnum(["provider", "list_price"] as const, {
      description: "Whether runtime_usd came from the provider or from the list price.",
    }),
  },
  { additionalProperties: false, title: "RunCost" },
);

export const RunHealthSchema = Type.Object(
  {
    status: StringEnum(RUN_HEALTH_STATUSES, {
      description:
        "ok: output is flowing. quiet: no output for a while. stuck: run health stopped it. lost: the sandbox stopped answering.",
    }),
    reason: Type.Optional(
      StringEnum(RUN_STUCK_REASONS, {
        description:
          "Why it was stopped: no_output for stall_minutes, loop for the same tool call loop_repeats times in a row, or sandbox_lost.",
      }),
    ),
    line: NonEmpty({ description: "One line for the run view, such as `quiet for 6m`." }),
    heartbeat_at: NullableTime("The sandbox's last heartbeat."),
    last_output_at: NullableTime("When the agent last printed anything."),
    repeats: Type.Optional(
      Type.Integer({ minimum: 0, description: "Identical tool calls in a row at the last check." }),
    ),
    tool: Type.Optional(Type.String({ description: "The tool call that repeated, summarized." })),
  },
  { additionalProperties: false, title: "RunHealth" },
);

export const GateCheckSchema = Type.Object(
  {
    name: StringEnum(GATE_CHECKS, {
      description:
        "tests_first: a changed test fails on the base and passes on the head. tests_pass: the test command passes on the head. dependencies: every added package exists in its registry. size: the diff is under pr_size_cap.",
    }),
    ok: Type.Boolean(),
    detail: NonEmpty({ description: "What was found, in one line." }),
  },
  { additionalProperties: false, title: "GateCheck" },
);

export const RunGateSchema = Type.Object(
  {
    mode: StringEnum(GATE_MODES, { description: "[background] tests_first when the gate ran." }),
    result: StringEnum(GATE_RESULTS, {
      description: "passed when every check passed, failed when one did, skipped when off.",
    }),
    command: NullableText("The test command, from selfhost.toml or detected, or null."),
    command_from: Type.Optional(
      StringEnum(["config", "package.json", "pyproject", "cargo", "go", "ci"] as const, {
        description: "Where the test command came from.",
      }),
    ),
    tests_changed: Type.Array(Type.String(), {
      description: "Test files the run added or changed.",
    }),
    checks: Type.Array(GateCheckSchema),
    summary: NonEmpty({ description: "One line, as the pull request check shows it." }),
    output: Type.Optional(
      Type.String({ description: "The end of the failing test output, at most 4000 characters." }),
    ),
    blocked: Type.Boolean({
      description: "true when the gate stopped the pull request from opening (enforce only).",
    }),
  },
  { additionalProperties: false, title: "RunGate", description: "The tests-first gate's verdict." },
);

export const BackgroundRunSchema = Type.Object(
  {
    schema: Type.Literal(BACKGROUND_RUN_SCHEMA),
    id: NonEmpty({ description: "Run id, also run_id on the run's ledger events." }),
    team: NonEmpty({ description: "The team the run belongs to." }),
    org: Type.Optional(Type.String({ description: "The team's org." })),
    repo: RepoSlug({ description: "Repository as owner/name." }),
    task: NonEmpty({ description: "What the agent was asked to do." }),
    agent: StringEnum(BACKGROUND_AGENTS, { description: "The agent CLI." }),
    runtime: NonEmpty({ description: "The runtime kind the sandbox ran on, such as e2b." }),
    state: StringEnum(BACKGROUND_RUN_STATES),
    reason: NullableText("Why the run ended as it did, or why it is waiting. null while normal."),
    person: NullableText(
      "The person the run works for, whose login the agent uses. null for runs with no person.",
    ),
    trigger: RunTriggerSchema,
    credential: Type.Union([StringEnum(RUN_CREDENTIAL_KINDS), Type.Null()], {
      description: "What the agent signed in with, once the sandbox is set up.",
    }),
    base: NullableText("The branch the run was cut from, once known."),
    branch: NonEmpty({ description: "The run's own branch. Two runs never share one." }),
    sandbox_id: NullableText("The sandbox, while it exists."),
    attempt: Type.Integer({ minimum: 1, description: "Current attempt, 1 for the first." }),
    max_attempts: Type.Integer({ minimum: 1, description: "1 plus [background] max_retries." }),
    timeout_minutes: Type.Integer({ minimum: 1 }),
    pr_url: Type.Union([Url(), Type.Null()], { description: "The run's one pull request." }),
    created_at: DateTime(),
    started_at: NullableTime("When the sandbox was asked for."),
    ended_at: NullableTime("When the run reached a final state."),
    updated_at: DateTime(),
    cancel: Type.Union(
      [
        Type.Object(
          { by: NonEmpty(), at: DateTime(), scope: StringEnum(["run", ...KILL_SCOPES] as const) },
          { additionalProperties: false },
        ),
        Type.Null(),
      ],
      { description: "Who stopped the run, and through which switch, once someone did." },
    ),
    cost: RunCostSchema,
    health: Type.Union([RunHealthSchema, Type.Null()], {
      description: "Run health at the last check, or null before the agent starts.",
    }),
    gate: Type.Union([RunGateSchema, Type.Null()], {
      description: "The tests-first gate's verdict, once it ran.",
    }),
  },
  {
    additionalProperties: false,
    title: "BackgroundRun",
    description: "One background run, as GET /v1/background-runs/{id} answers it.",
  },
);

export type RunTrigger = Static<typeof RunTriggerSchema>;
export type RunCost = Static<typeof RunCostSchema>;
export type RunHealth = Static<typeof RunHealthSchema>;
export type GateCheck = Static<typeof GateCheckSchema>;
export type RunGate = Static<typeof RunGateSchema>;
export type BackgroundRun = Static<typeof BackgroundRunSchema>;

export const backgroundRunValidator = createValidator(BackgroundRunSchema);

/** data.trigger of a run.triggered event: every trigger, accepted or refused. */
export const RunTriggeredDataSchema = Type.Object(
  {
    schema: Type.Literal(RUN_TRIGGER_SCHEMA),
    ...RunTriggerSchema.properties,
    accepted: Type.Boolean(),
    reason: Type.Optional(Type.String({ description: "Why it was refused." })),
    run_id: Type.Optional(Type.String({ description: "The run it started." })),
  },
  { additionalProperties: false, title: "RunTriggeredData" },
);
export type RunTriggeredData = Static<typeof RunTriggeredDataSchema>;

// Config ---------------------------------------------------------------------------------------

export const ScheduleSchema = Type.Object(
  {
    name: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$", description: "Unique name." }),
    cron: NonEmpty({
      description:
        "Five-field cron in UTC: minute hour day-of-month month day-of-week, with *, lists, ranges and steps.",
    }),
    repo: RepoSlug({ description: "Repository the run works on, as owner/name." }),
    task: NonEmpty({ description: "What the agent is asked to do." }),
    agent: Type.Optional(
      StringEnum(BACKGROUND_AGENTS, { description: "Default: [background] agent." }),
    ),
  },
  { additionalProperties: false, description: "A run started on a schedule, with the team's key." },
);
export type Schedule = Static<typeof ScheduleSchema>;

export const BackgroundConfigSchema = Type.Object(
  {
    agent: Type.Optional(
      StringEnum(BACKGROUND_AGENTS, {
        default: "claude",
        description: "The agent CLI a run uses when none is named.",
      }),
    ),
    timeout_minutes: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 1440,
        default: 60,
        description:
          "A run is stopped with its sandbox after this long and marked timed_out. A run can ask for less or more, up to 1440.",
      }),
    ),
    max_retries: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 5,
        default: 1,
        description:
          "Times a run is tried again after a runtime error (the sandbox could not be created or stopped answering). The agent's own failures are not retried.",
      }),
    ),
    allowed: Type.Optional(
      Type.Array(NonEmpty(), {
        default: [],
        uniqueItems: true,
        description:
          "Person ids who may start runs from GitHub, webhooks and the API. Empty lets every person in the team. Only people in the team count: someone listed who was revoked from it, or never joined, is refused. GitHub senders are mapped to people through [review] github_logins.",
      }),
    ),
    rate_limit_per_hour: Type.Optional(
      Type.Integer({
        minimum: 0,
        default: 20,
        description: "Most runs the team may start in any hour. 0 for no limit.",
      }),
    ),
    max_concurrent: Type.Optional(
      Type.Integer({
        minimum: 0,
        default: 5,
        description: "Most runs of the team going at once. 0 for no limit.",
      }),
    ),
    test_command: Type.Optional(
      NonEmpty({
        description:
          "The command the tests-first gate runs in the sandbox. Unset: detected from package.json, pyproject.toml, Cargo.toml, go.mod or the CI workflow.",
      }),
    ),
    tests_first: Type.Optional(
      StringEnum(GATE_MODES, {
        default: "observe",
        description:
          "The tests-first gate: the run must add or change a test that fails on the base and passes on the head, every added package must exist and the diff must be under pr_size_cap. observe reports it as a check on the pull request; enforce opens no pull request when it fails; off skips it.",
      }),
    ),
    pr_size_cap: Type.Optional(
      Type.Integer({
        minimum: 0,
        default: 0,
        description: "Most changed lines (added plus removed) a run's diff may have. 0 for no cap.",
      }),
    ),
    stall_minutes: Type.Optional(
      Type.Integer({
        minimum: 1,
        default: 10,
        description: "Run health stops a run whose agent printed nothing for this long.",
      }),
    ),
    loop_repeats: Type.Optional(
      Type.Integer({
        minimum: 2,
        default: 6,
        description:
          "Run health stops a run that made the same tool call this many times in a row.",
      }),
    ),
    heartbeat_seconds: Type.Optional(
      Type.Integer({
        minimum: 5,
        default: 30,
        description: "How often the sandbox is checked, the cost read and the health line updated.",
      }),
    ),
    webhook_secret_env: Type.Optional(
      Type.String({
        pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
        description:
          "Environment variable on the server that holds the secret signed webhooks are checked with. Unset: the webhook trigger is off.",
      }),
    ),
    webhook_senders: Type.Optional(
      Type.Array(NonEmpty(), {
        description:
          "The person ids a signed webhook may start runs for: the people the bridge that holds the secret speaks for. A sender not on it is refused, so the secret alone does not let a bridge act as anyone. Empty: every signed webhook is refused.",
      }),
    ),
    github_label: Type.Optional(
      NonEmpty({
        default: "selfhost",
        description:
          "Adding this label to an issue starts a run on it, with the issue as the task.",
      }),
    ),
    github_command: Type.Optional(
      NonEmpty({
        default: "/selfhost run",
        description:
          "A comment on an issue or pull request that starts with this starts a run; the rest of the comment is the task.",
      }),
    ),
    schedules: Type.Optional(
      Type.Array(ScheduleSchema, { default: [], description: "Runs started on a schedule." }),
    ),
  },
  {
    additionalProperties: false,
    description:
      "Background runs: an agent CLI working in a sandbox on the team's runtime, started from the CLI, the console, GitHub, a signed webhook or a schedule.",
  },
);
export type BackgroundConfig = Static<typeof BackgroundConfigSchema>;
export type ResolvedBackgroundConfig = Required<
  Omit<BackgroundConfig, "webhook_secret_env" | "test_command">
> &
  Pick<BackgroundConfig, "webhook_secret_env" | "test_command">;

/** [background] with every default filled in, from a config that may not have the section. */
export function backgroundSettings(config: {
  background?: BackgroundConfig;
}): ResolvedBackgroundConfig {
  const section = config.background ?? {};
  return {
    agent: section.agent ?? "claude",
    timeout_minutes: section.timeout_minutes ?? 60,
    max_retries: section.max_retries ?? 1,
    allowed: section.allowed ?? [],
    rate_limit_per_hour: section.rate_limit_per_hour ?? 20,
    max_concurrent: section.max_concurrent ?? 5,
    tests_first: section.tests_first ?? "observe",
    pr_size_cap: section.pr_size_cap ?? 0,
    stall_minutes: section.stall_minutes ?? 10,
    loop_repeats: section.loop_repeats ?? 6,
    heartbeat_seconds: section.heartbeat_seconds ?? 30,
    webhook_senders: section.webhook_senders ?? [],
    github_label: section.github_label ?? "selfhost",
    github_command: section.github_command ?? "/selfhost run",
    schedules: section.schedules ?? [],
    ...(section.webhook_secret_env ? { webhook_secret_env: section.webhook_secret_env } : {}),
    ...(section.test_command ? { test_command: section.test_command } : {}),
  };
}

// API ------------------------------------------------------------------------------------------

export const StartRunRequestSchema = Type.Object(
  {
    task: NonEmpty({ description: "What the agent is asked to do." }),
    repo: RepoSlug({ description: "Repository as owner/name." }),
    agent: Type.Optional(StringEnum(BACKGROUND_AGENTS)),
    runtime: Type.Optional(
      NonEmpty({ description: "Runtime kind; default: the team's [runtime] default." }),
    ),
    team: Type.Optional(NonEmpty({ description: "Default: the caller's team." })),
    base: Type.Optional(NonEmpty({ description: "Branch to start from; default: the repo's." })),
    timeout_minutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1440 })),
    source: Type.Optional(
      StringEnum(["cli", "api", "console"] as const, {
        description: "Which surface sent it; recorded on the trigger. Default: api.",
      }),
    ),
  },
  { additionalProperties: false, title: "StartRunRequest" },
);
export type StartRunRequest = Static<typeof StartRunRequestSchema>;

export const WebhookRunRequestSchema = Type.Object(
  {
    task: NonEmpty(),
    repo: RepoSlug(),
    sender: NonEmpty({ description: "The person id the bridge says sent it." }),
    team: Type.Optional(NonEmpty()),
    agent: Type.Optional(StringEnum(BACKGROUND_AGENTS)),
    ref: Type.Optional(Type.String({ description: "A link back to the message." })),
  },
  { additionalProperties: false, title: "WebhookRunRequest" },
);
export type WebhookRunRequest = Static<typeof WebhookRunRequestSchema>;

export const BackgroundRunsQuerySchema = Type.Object(
  {
    team: Type.Optional(NonEmpty()),
    state: Type.Optional(StringEnum(["active", "final", ...BACKGROUND_RUN_STATES] as const)),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
  },
  { additionalProperties: false },
);
export type BackgroundRunsQuery = Static<typeof BackgroundRunsQuerySchema>;

export const BackgroundRunsResponseSchema = Type.Object(
  {
    runs: Type.Array(BackgroundRunSchema, { description: "Newest first." }),
    kills: Type.Array(
      Type.Object(
        { scope: StringEnum(KILL_SCOPES), target: NonEmpty(), by: NonEmpty(), at: DateTime() },
        { additionalProperties: false },
      ),
      { description: "Kill switches in force that cover the listed teams." },
    ),
  },
  { additionalProperties: false, title: "BackgroundRunsResponse" },
);
export type BackgroundRunsResponse = Static<typeof BackgroundRunsResponseSchema>;

export const KillRequestSchema = Type.Object(
  {
    scope: StringEnum(KILL_SCOPES),
    target: NonEmpty({ description: "The team id or org id." }),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false, title: "KillRequest" },
);
export type KillRequest = Static<typeof KillRequestSchema>;

export const KillResponseSchema = Type.Object(
  {
    scope: StringEnum(KILL_SCOPES),
    target: NonEmpty(),
    active: Type.Boolean({ description: "true while new runs in the scope are refused." }),
    stopped: Type.Array(NonEmpty(), { description: "Runs this call stopped." }),
  },
  { additionalProperties: false, title: "KillResponse" },
);
export type KillResponse = Static<typeof KillResponseSchema>;
