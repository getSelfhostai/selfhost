import type { ReviewerPullRequests, ReviewerTool } from "@selfhost/schema";
import type { Settings } from "../types.js";
import { BRIEF_MARKER, SECOND_OPINION_MARKER } from "./marker.js";

/**
 * Versions `selfhost review setup` pins, each a release at least two weeks old when it was
 * picked. Actions are pinned to the commit of the release tag and images to their digest, so a
 * moved tag cannot change what runs on the team's key.
 */
export const REVIEWER_PINS = {
  checkout: {
    uses: "actions/checkout",
    sha: "3d3c42e5aac5ba805825da76410c181273ba90b1",
    version: "v7.0.1",
  },
  claudeCodeAction: {
    uses: "anthropics/claude-code-action",
    sha: "ae68417a745a5df4b2124873632bd73a2255e6f6",
    version: "v1.0.259",
  },
  /** The PR-Agent action is a wrapper around this image; the image is what runs. */
  prAgent: {
    image: "pragent/pr-agent",
    tag: "0.49.0-github_action",
    digest: "sha256:b1ed6e8de56eb4d6e4169ee0d5c209bb5ed1ef071a01c0c042c64b80192a785c",
    version: "v0.49.0",
  },
} as const;

/** The job names the workflows run under; the GitHub App reads a failed run back by its name. */
export const REVIEWER_JOB_NAMES = {
  "pr-agent": "PR-Agent review",
  "claude-code-action": "Claude Code review",
} as const satisfies Partial<Record<ReviewerTool, string>>;

/** Where each tool's file goes in the repository. */
export const REVIEWER_FILES: Record<ReviewerTool, string> = {
  "pr-agent": ".github/workflows/selfhost-pr-agent.yml",
  "claude-code-action": ".github/workflows/selfhost-claude-review.yml",
  coderabbit: ".coderabbit.yaml",
};

export interface ReviewerSetupOptions {
  /** `[integrations.reviewer]` without `tool`, when selfhost.toml picks this tool. */
  settings?: Settings<"reviewer">;
  /**
   * GitHub Actions `if:` expression that is true on agent pull requests, with or without
   * `labeled` events in the trigger: `agentPullCondition()` in @selfhost/attribution.
   */
  agentCondition: (labelEvents: boolean) => string;
  /** Labels the selfhost GitHub App puts on agent pull requests, for CodeRabbit's filter. */
  agentLabels: readonly string[];
  /** Bot accounts that open agent pull requests, which the Claude Code action must be told it may run for. */
  agentBots: readonly string[];
  /**
   * The selfhost GitHub App's bot login, such as acme-selfhost[bot]. The App's label is what
   * marks some agent pull requests, and the Claude Code action only runs on a `labeled` event from
   * a bot it is told about, so without this its workflow leaves `labeled` out.
   */
  appBot?: string;
}

export interface SetupFile {
  /** Path in the repository. */
  path: string;
  text: string;
}

export interface SetupSecret {
  /** The repository or org secret the file reads. selfhost never sees its value. */
  name: string;
  holds: string;
}

export interface ReviewerSetup {
  tool: ReviewerTool;
  name: string;
  files: SetupFile[];
  secrets: SetupSecret[];
  pullRequests: ReviewerPullRequests;
  /** What else to do, one line each. */
  next: string[];
}

/** A setting that cannot be written into the file, with what to change. */
export class ReviewerSetupError extends Error {
  override name = "ReviewerSetupError";
}

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;

/**
 * Names of secrets that hold one person's subscription login rather than an API key. A reviewer
 * runs on every pull request the team opens, so it runs on the org's key, never on a person's
 * plan (which the vendors' terms tie to that person).
 */
const SUBSCRIPTION_SECRET = /OAUTH|SUBSCRIPTION|SESSION/i;

/** The instructions every reviewer gets, so a second opinion tries to break the change. */
export function reviewInstructions(style: boolean): string[] {
  return [
    "You are a second opinion on a pull request a coding agent wrote. Do not summarize it: try to break it.",
    "Look for an input that fails, a case it misses, a flow it breaks, or a test that passes without testing the change.",
    "Prove each finding with a failing test (give the test code) or exact repro steps. Leave out what you cannot prove.",
    style
      ? "Style, formatting and naming comments are welcome after the findings."
      : "Do not comment on style, formatting or naming.",
  ];
}

/** Where the run behind the pull request is, for reviewers that read the conversation. */
const RUN_CONTEXT = `The selfhost brief comment on this pull request (it starts with ${BRIEF_MARKER}) describes the agent run behind it: the plan, the tests it ran, guardrail hits and cost. Read it first. If there is no brief, review the diff alone and say so at the top of your review.`;

function header(tool: string, lines: string[]): string {
  return [
    `# Written by selfhost review setup ${tool}. Edit it freely; run the command again with --force`,
    "# to write it afresh.",
    ...lines.map((line) => `# ${line}`),
  ].join("\n");
}

/** A YAML block scalar body, indented. */
const block = (lines: readonly string[], indent: number) =>
  lines.map((line) => (line === "" ? "" : `${" ".repeat(indent)}${line}`)).join("\n");

/** One line per term, all at one indent, so a folded scalar joins them with spaces. */
const condition = (expression: string, indent: number) =>
  block(
    expression.split("\n").map((line) => line.trim()),
    indent,
  );

/** A single-quoted YAML string. */
const yamlString = (text: string) => `'${text.replaceAll("'", "''")}'`;

function trigger(labelEvents: boolean): string {
  const types = labelEvents
    ? "[opened, synchronize, reopened, ready_for_review, labeled]"
    : "[opened, synchronize, reopened, ready_for_review]";
  return `on:\n  pull_request:\n    types: ${types}`;
}

/**
 * The workflow's concurrency: a newer push to the pull request cancels the review of the older
 * one. A `labeled` event runs in a group of its own label, so the App labeling a pull request
 * seconds after it opens (its risk label, then its agent label) never cancels the review the
 * opening started: the job's `if` skips most label events, but concurrency is applied first.
 */
function concurrency(prefix: string, labelEvents: boolean): string {
  const action = "github.event.action == 'labeled'";
  const lane = labelEvents
    ? `-\${{ ${action} && format('label-{0}', github.event.label.name) || 'change' }}`
    : "";
  return `concurrency:\n  group: ${prefix}-\${{ github.event.pull_request.number }}${lane}\n  cancel-in-progress: true`;
}

function jobCondition(
  pullRequests: ReviewerPullRequests,
  options: ReviewerSetupOptions,
  labelEvents: boolean,
): string {
  if (pullRequests === "all") return "    if: github.event.pull_request.draft == false";
  return `    if: >-\n${condition(options.agentCondition(labelEvents), 6)}`;
}

function checkModel(model: string | undefined): string | undefined {
  if (model !== undefined && !MODEL.test(model)) {
    throw new ReviewerSetupError(
      `[integrations.reviewer] model "${model}" is not a model id: letters, digits and . _ : / @ - only.`,
    );
  }
  return model;
}

function keySecret(tool: ReviewerTool, fallback: string, keyEnv: string | undefined): string {
  const name = keyEnv ?? fallback;
  if (SUBSCRIPTION_SECRET.test(name)) {
    throw new ReviewerSetupError(
      `[integrations.reviewer] api_key_env = "${name}" looks like a personal subscription login, not an API key. ${tool} reviews every pull request the team opens, so it runs on the org's API key from a repository or org secret, never on one person's plan. Create an API key for the org, store it as a secret, and set api_key_env to that secret's name.`,
    );
  }
  return name;
}

/** PR-Agent reads its key from OPENAI_KEY, or ANTHROPIC.KEY for an anthropic/ model. */
function prAgent(options: ReviewerSetupOptions, pullRequests: ReviewerPullRequests): ReviewerSetup {
  const settings = options.settings ?? {};
  const model = checkModel(settings.model);
  const anthropic = model?.startsWith("anthropic/") ?? false;
  const secret = keySecret(
    "pr-agent",
    anthropic ? "ANTHROPIC_KEY" : "OPENAI_KEY",
    settings.api_key_env,
  );
  const keyVariable = anthropic ? "ANTHROPIC.KEY" : "OPENAI_KEY";
  const pin = REVIEWER_PINS.prAgent;
  const actions =
    pullRequests === "agent"
      ? '["opened", "reopened", "ready_for_review", "labeled"]'
      : '["opened", "reopened", "ready_for_review"]';
  const instructions = [...reviewInstructions(settings.style ?? false)].join(" ");
  const text = `${header("pr-agent", [
    "A second opinion on agent pull requests from PR-Agent (https://github.com/the-pr-agent/pr-agent),",
    "on this repository's own model API key: model calls go from this runner to the model vendor and",
    "selfhost pays nothing per review. The selfhost GitHub App reads the review back into the review",
    "list and the risk score.",
  ])}
name: PR-Agent review
${trigger(pullRequests === "agent")}
${concurrency("selfhost-pr-agent", pullRequests === "agent")}
permissions:
  contents: read
  issues: write
  pull-requests: write
jobs:
  review:
    name: ${REVIEWER_JOB_NAMES["pr-agent"]}
${jobCondition(pullRequests, options, pullRequests === "agent")}
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      # The run behind the pull request (plan, tests run, guardrail hits, cost), from the brief the
      # selfhost GitHub App posted. With no brief, PR-Agent is told it reviews the diff alone.
      - name: Read the selfhost brief
        env:
          GH_TOKEN: \${{ github.token }}
          PR: \${{ github.event.pull_request.number }}
        run: |
          gh api "repos/$GITHUB_REPOSITORY/issues/$PR/comments" --paginate \\
            --jq '.[] | select(.body | contains("${BRIEF_MARKER}")) | .body' > selfhost-brief.md
          if [ ! -s selfhost-brief.md ]; then
            echo "No selfhost brief on this pull request: no agent run was found for it. Review the diff alone, and say so in the review." > selfhost-brief.md
          fi
      - name: PR-Agent
        uses: docker://${pin.image}:${pin.tag}@${pin.digest} # ${pin.version}
        env:
          ${keyVariable}: \${{ secrets.${secret} }}
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          ARTIFACT_PATH: selfhost-brief.md
          ARTIFACT_INSTRUCTIONS: ${yamlString("This is the selfhost brief: the agent run behind this pull request (plan, tests run, guardrail hits, cost). Use it to judge what the tests did not cover.")}
          github_action_config.auto_review: "true"
          github_action_config.auto_describe: "false"
          github_action_config.auto_improve: "false"
          github_action_config.pr_actions: ${yamlString(actions)}
          github_action_config.handle_push_trigger: "true"
          github_action_config.push_commands: '["/review"]'
          github_action_config.push_trigger_ignore_bot_commits: "false"
          pr_reviewer.require_merge_recommendation: "true"
          pr_reviewer.require_risk_assessment: "true"
          pr_reviewer.enable_review_labels_effort: "false"
          pr_reviewer.enable_review_labels_security: "false"
          pr_reviewer.extra_instructions: ${yamlString(instructions)}
${model ? `          config.model: ${yamlString(model)}\n          config.fallback_models: '[]'\n` : ""}`;
  return {
    tool: "pr-agent",
    name: "PR-Agent",
    pullRequests,
    files: [{ path: REVIEWER_FILES["pr-agent"], text }],
    secrets: [
      {
        name: secret,
        holds: anthropic
          ? "an Anthropic API key of the org (not a Claude subscription login)"
          : "an OpenAI API key of the org (set [integrations.reviewer] model to anthropic/<model> to use Anthropic)",
      },
    ],
    next: [],
  };
}

function claudeCodeAction(
  options: ReviewerSetupOptions,
  pullRequests: ReviewerPullRequests,
): ReviewerSetup {
  const settings = options.settings ?? {};
  const model = checkModel(settings.model);
  const secret = keySecret("claude-code-action", "ANTHROPIC_API_KEY", settings.api_key_env);
  const pin = REVIEWER_PINS.claudeCodeAction;
  const checkout = REVIEWER_PINS.checkout;
  const labelEvents = pullRequests === "agent" && options.appBot !== undefined;
  const bots = [...options.agentBots, ...(options.appBot ? [options.appBot] : [])];
  const prompt = [
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, kept as written.
    "REPO: ${{ github.repository }}",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, kept as written.
    "PR NUMBER: ${{ github.event.pull_request.number }}",
    "",
    ...reviewInstructions(settings.style ?? false),
    "",
    RUN_CONTEXT,
    "",
    "Read the change with gh pr diff and the conversation with gh pr view --comments.",
    "Put each finding on its line with mcp__github_inline_comment__create_inline_comment.",
    "Then post one summary comment with gh pr comment: the findings, most severe first, each with its test or repro.",
    "End that comment with this line, filled in, exactly once:",
    `<!-- ${SECOND_OPINION_MARKER} tool=claude-code-action verdict=VERDICT findings=N severity=SEVERITY -->`,
    "VERDICT is changes when a finding must be fixed before merge, comment when there are findings that need not block it, approve when there are none.",
    "N is the number of findings. SEVERITY is the highest of critical, high, medium or low, or none when there are no findings.",
  ];
  const tools = [
    "mcp__github_inline_comment__create_inline_comment",
    "Bash(gh pr comment:*)",
    "Bash(gh pr diff:*)",
    "Bash(gh pr view:*)",
  ].join(",");
  const claudeArgs = [...(model ? [`--model ${model}`] : []), `--allowedTools "${tools}"`];
  const text = `${header("claude-code-action", [
    "A second opinion on agent pull requests from the Claude Code GitHub Action",
    "(https://github.com/anthropics/claude-code-action), on this repository's own Anthropic API key:",
    "model calls go from this runner to Anthropic and selfhost pays nothing per review. The selfhost",
    "GitHub App reads the review back into the review list and the risk score.",
  ])}
name: Claude Code review
${trigger(labelEvents)}
${concurrency("selfhost-claude-review", labelEvents)}
permissions:
  contents: read
  issues: read
  pull-requests: write
  id-token: write
jobs:
  review:
    name: ${REVIEWER_JOB_NAMES["claude-code-action"]}
${jobCondition(pullRequests, options, labelEvents)}
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: ${checkout.uses}@${checkout.sha} # ${checkout.version}
        with:
          fetch-depth: 1
      - uses: ${pin.uses}@${pin.sha} # ${pin.version}
        with:
          # The org's API key. Not claude_code_oauth_token: that is one person's subscription.
          anthropic_api_key: \${{ secrets.${secret} }}
          github_token: \${{ github.token }}
          # Agents open pull requests from bot accounts; the action skips bots it is not told about.
          allowed_bots: ${yamlString(bots.join(","))}
          prompt: |
${block(prompt, 12)}
          claude_args: >-
${block(claudeArgs, 12)}
`;
  return {
    tool: "claude-code-action",
    name: "Claude Code GitHub Action",
    pullRequests,
    files: [{ path: REVIEWER_FILES["claude-code-action"], text }],
    secrets: [
      { name: secret, holds: "an Anthropic API key of the org (not a Claude subscription login)" },
    ],
    next:
      pullRequests === "agent" && !labelEvents
        ? [
            "A pull request only the selfhost GitHub App's label marks as an agent's is reviewed from its next push. Pass --app-bot <the App's bot login> to review it when it is labeled.",
          ]
        : [],
  };
}

/** CodeRabbit is a hosted GitHub App: the file configures it, and the App does the rest. */
function coderabbit(
  options: ReviewerSetupOptions,
  pullRequests: ReviewerPullRequests,
): ReviewerSetup {
  const settings = options.settings ?? {};
  const style = settings.style ?? false;
  const instructions = reviewInstructions(style);
  const labels =
    pullRequests === "agent"
      ? `    # Agent pull requests only: the labels the selfhost GitHub App puts on them.\n    labels:\n${options.agentLabels.map((label) => `      - ${yamlString(label)}`).join("\n")}\n`
      : "";
  const text = `${header("coderabbit", [
    "A second opinion on agent pull requests from CodeRabbit (https://docs.coderabbit.ai). CodeRabbit",
    "runs as its own GitHub App on its own models; this file only tells it what to review and how.",
    "The selfhost GitHub App reads its reviews back into the review list and the risk score.",
  ])}
# yaml-language-server: $schema=https://coderabbit.ai/integrations/schema.v2.json
language: en-US
reviews:
  # chill leaves out nitpicks; assertive adds them.
  profile: ${style ? "assertive" : "chill"}
  high_level_summary: true
  poem: false
  review_status: true
  # Automatic approvals stay off: an AI approval should not count toward merging an agent's
  # pull request. Findings still come through as review comments.
  auto_approvals:
    enabled: false
  auto_review:
    enabled: true
    drafts: false
${labels}  path_instructions:
    - path: "**"
      instructions: |
${block(instructions, 8)}
`;
  return {
    tool: "coderabbit",
    name: "CodeRabbit",
    pullRequests,
    files: [{ path: REVIEWER_FILES.coderabbit, text }],
    secrets: [],
    next: [
      "Install the CodeRabbit GitHub App on the repository: https://github.com/apps/coderabbitai. It runs on CodeRabbit's models and plan, not on a key of yours (free on public repositories, paid seats on private ones).",
      ...(settings.model
        ? ["CodeRabbit picks its own models, so [integrations.reviewer] model is not used."]
        : []),
      ...(pullRequests === "agent"
        ? [
            "CodeRabbit reviews a pull request once the selfhost GitHub App has labeled it as an agent's. If it labels after CodeRabbit looked, comment @coderabbitai review on the pull request.",
          ]
        : []),
    ],
  };
}

const BUILDERS: Record<
  ReviewerTool,
  (options: ReviewerSetupOptions, pullRequests: ReviewerPullRequests) => ReviewerSetup
> = {
  "pr-agent": prAgent,
  "claude-code-action": claudeCodeAction,
  coderabbit,
};

/**
 * The file that wires one existing reviewer into a repository, with pinned versions, the secret it
 * reads its key from (named, never valued), and what else the team has to do. Runs on agent pull
 * requests unless `[integrations.reviewer] pull_requests = "all"`. Pure: nothing is written.
 */
export function reviewerSetup(tool: ReviewerTool, options: ReviewerSetupOptions): ReviewerSetup {
  const pullRequests = options.settings?.pull_requests ?? "agent";
  const setup = BUILDERS[tool](options, pullRequests);
  return {
    ...setup,
    next: [
      ...setup.secrets.map(
        (secret) =>
          `Add the repository or org secret ${secret.name}: ${secret.holds}. Settings > Secrets and variables > Actions, or gh secret set ${secret.name}.`,
      ),
      ...setup.next,
      `Commit ${setup.files.map((file) => file.path).join(" and ")} to the default branch.`,
      "With the selfhost GitHub App installed, each review lands on the pull request's item in the review list and counts in its risk score.",
    ],
  };
}
