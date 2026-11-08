import type {
  PolicyCoverageResponse,
  PolicyObservedResponse,
  PolicyResponse,
  ReviewItem,
  UsageResponse,
} from "@selfhost/schema";

/** API answers for a seeded team "web", shaped like the server's. */

const item = (overrides: Partial<ReviewItem> & Pick<ReviewItem, "id" | "kind" | "title">) =>
  ({
    schema: "selfhost.review_item/v1",
    created_at: "2026-11-08T09:00:00.000Z",
    updated_at: "2026-11-08T09:00:00.000Z",
    state: "open",
    blocking: false,
    risk: { score: 20, reasons: [] },
    owners: ["ada@example.com"],
    source_event_ids: [],
    ...overrides,
  }) as ReviewItem;

export const EXCEPTION = item({
  id: "0193ffff-0000-7000-8000-000000000001",
  kind: "exception",
  title: "Allow once: git push --force origin main",
  blocking: true,
  risk: {
    score: 80,
    reasons: ["Rule no-force-push blocked it; approving allows this exact call once"],
  },
  why: {
    signal: "policy.evaluated",
    rule_id: "no-force-push",
    text: "Force pushes are blocked. Instead: Open a pull request instead.",
  },
  session_id: "sess-1",
  actions: ["approve", "deny", "snooze"],
});

export const RISKY_PR = item({
  id: "0193ffff-0000-7000-8000-000000000002",
  kind: "pr",
  title: "Rewrite billing webhooks",
  repo: "acme/api",
  url: "https://github.com/acme/api/pull/7",
  risk: { score: 75, reasons: ["Touches billing/ (flagged module)"] },
  run_id: "run-7",
  actions: ["approve", "deny", "snooze", "open"],
});

export const QUESTION = item({
  id: "0193ffff-0000-7000-8000-000000000003",
  kind: "question",
  title: "Which region should the bucket go in?",
  blocking: true,
  risk: { score: 30, reasons: ["An agent is waiting for an answer"] },
  actions: ["answer", "snooze"],
});

export const REVIEW_PAGE = { items: [EXCEPTION, RISKY_PR, QUESTION], next_cursor: null };

const totals = {
  usd: 42.5,
  tokens: 1_200_000,
  input_tokens: 400_000,
  output_tokens: 200_000,
  cache_read_tokens: 500_000,
  cache_write_tokens: 100_000,
  requests: 310,
  sessions: 12,
  prs_opened: 6,
  prs_merged: 5,
};

export const USAGE: UsageResponse = {
  org: "default",
  from: "2026-11-02T00:00:00.000Z",
  to: "2026-11-09T00:00:00.000Z",
  group_by: [],
  filters: { team: "web" },
  teams: ["web"],
  rows: [{ group: {}, ...totals }],
  total: totals,
};

export const POLICY_TEXT = `version = 1

# Agents push through pull requests.
[[rules]]
id = "no-force-push"
mode = "observe"
match = { command = 'git push --force' }
action = "block"
message = "Force pushes are blocked."

[[rules]]
id = "ask-migrations"
mode = "enforce"
match = { path = "db/migrations/**" }
action = "ask"
message = "Migrations need a person."
`;

export const POLICY = {
  hash: "a".repeat(64),
  team: "web",
  layers: [{ kind: "team", name: "web" }],
  text: POLICY_TEXT,
  loaded_at: "2026-11-01T00:00:00.000Z",
  config: {
    version: 1,
    rules: [
      {
        id: "no-force-push",
        mode: "observe",
        match: { command: "git push --force" },
        action: "block",
        message: "Force pushes are blocked.",
      },
      {
        id: "ask-migrations",
        mode: "enforce",
        match: { path: "db/migrations/**" },
        action: "ask",
        message: "Migrations need a person.",
      },
    ],
    guardrails: { mode: "enforce", disable: ["guard.prod_sql"] },
  },
  effective_rules: [],
} as unknown as PolicyResponse;

const coverage = (rule_id: string, mode: "observe" | "enforce", action: "block" | "ask") =>
  (
    [
      ["claude_code", "compiled", "record"],
      ["codex", "partial", "record"],
      ["cursor", "not_expressible", "none"],
      ["copilot", "not_applicable", "none"],
    ] as const
  ).map(([vendor, status, hook]) => ({
    rule_id,
    vendor,
    mode,
    action,
    status,
    native: [],
    hook,
    detail: `${vendor} detail`,
  }));

export const COVERAGE = {
  hash: "a".repeat(64),
  team: "web",
  coverage: {
    schema: "selfhost.policy_coverage/v1",
    team: "web",
    vendors: [],
    rules: [
      ...coverage("no-force-push", "observe", "block"),
      ...coverage("ask-migrations", "enforce", "ask"),
    ],
  },
} as unknown as PolicyCoverageResponse;

export const OBSERVED: PolicyObservedResponse = {
  schema: "selfhost.policy_observed/v1",
  team: "web",
  from: "2026-11-01T12:00:00.000Z",
  to: "2026-11-08T12:00:00.000Z",
  rules: [
    {
      rule_id: "no-force-push",
      mode: "observe",
      would_block: 4,
      would_ask: 0,
      blocked: 0,
      asked: 0,
      sessions: 3,
      likely_false_positives: 1,
      examples: [
        {
          tool: "Bash",
          input: "git push --force origin main",
          hits: 3,
          likely_false_positive: null,
        },
      ],
      more_examples: 0,
    },
    {
      rule_id: "ask-migrations",
      mode: "enforce",
      would_block: 0,
      would_ask: 0,
      blocked: 0,
      asked: 2,
      sessions: 2,
      likely_false_positives: 0,
      examples: [],
      more_examples: 0,
    },
    {
      rule_id: "guard.force_push",
      mode: "enforce",
      would_block: 0,
      would_ask: 0,
      blocked: 1,
      asked: 0,
      sessions: 1,
      likely_false_positives: 0,
      examples: [],
      more_examples: 0,
    },
  ],
  totals: { would_block: 4, would_ask: 0, blocked: 1, asked: 2 },
};

export const PROVENANCE = {
  team: "web",
  from: "2026-10-09T00:00:00.000Z",
  to: "2026-11-09T00:00:00.000Z",
  repos: [
    {
      schema: "selfhost.provenance/v1",
      repo: "acme/api",
      status: "computed",
      note: null,
      from: "2026-10-09T00:00:00.000Z",
      to: "2026-11-09T00:00:00.000Z",
      branch: "origin/main",
      head: "abc1234",
      window_days: 14,
      threshold: 0.2,
      min_module_lines: 50,
      totals: {
        lines: 10_000,
        agent_lines: 4_200,
        agent_share: 0.42,
        landings: 31,
        agent_reverted_lines: 120,
        agent_reworked_lines: 300,
        agent_revert_rework_rate: 0.1,
      },
      by_agent: [
        {
          vendor: "claude_code",
          model: "claude-sonnet-4-5",
          lines: 3_000,
          share: 0.3,
          landings: 20,
          runs: 25,
          reverted_lines: 60,
          reworked_lines: 200,
          open_lines: 0,
          revert_rate: 0.02,
          rework_rate: 0.067,
          revert_rework_rate: 0.087,
        },
      ],
      by_person: [],
      modules: [],
      vendor_reported: [],
    },
    {
      schema: "selfhost.provenance/v1",
      repo: "acme/web",
      status: "ledger_only",
      note: "No clone of acme/web on the server.",
      from: "2026-10-09T00:00:00.000Z",
      to: "2026-11-09T00:00:00.000Z",
      branch: null,
      head: null,
      window_days: 14,
      threshold: 0.2,
      min_module_lines: 50,
      totals: {
        lines: 900,
        agent_lines: 300,
        agent_share: 0.333,
        landings: 4,
        agent_reverted_lines: null,
        agent_reworked_lines: null,
        agent_revert_rework_rate: null,
      },
      by_agent: [],
      by_person: [],
      modules: [],
      vendor_reported: [],
    },
  ],
};

const moduleRow = (module: string, rate: number, flagged: boolean, rank: number) => ({
  repo: "acme/api",
  module,
  lines: 2_000,
  agent_lines: 900,
  agent_share: 0.45,
  agent_reverted_lines: 50,
  agent_reworked_lines: 200,
  agent_revert_rework_rate: rate,
  above_threshold: flagged,
  by_agent: [],
  rank,
});

export const MODULES = {
  team: "web",
  from: "2026-10-09T00:00:00.000Z",
  to: "2026-11-09T00:00:00.000Z",
  threshold: 0.2,
  modules: [moduleRow("billing", 0.31, true, 1), moduleRow("auth", 0.05, false, 2)],
};
