import { AGENT_VENDORS } from "@selfhost/schema";
import { AGENT_LOGINS, BOT_LOGINS, BRANCH_PREFIXES, FOOTERS, SESSION_LINKS } from "./vendors.js";

/** The selfhost GitHub App's agent labels, `selfhost:agent-<vendor>` (AGENT_LABEL_PREFIX). */
export const AGENT_LABEL_PREFIX = "selfhost:agent-";

const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;

const unique = (items: string[]) => [...new Set(items)];

/** The webhook-side signals (`webhookPullAgent`) as GitHub Actions expression terms. */
function attributionTerms(pull: string): string[] {
  const body = `${pull}.body`;
  const login = `${pull}.user.login`;
  const head = `${pull}.head.ref`;
  return [
    ...unique(BRANCH_PREFIXES.map(([prefix]) => prefix)).map(
      (prefix) => `startsWith(${head}, ${quote(prefix)})`,
    ),
    ...Object.keys(BOT_LOGINS).map((bot) => `${login} == ${quote(bot)}`),
    ...Object.keys(AGENT_LOGINS).map(
      (agent) => `(${pull}.user.type == 'Bot' && ${login} == ${quote(agent)})`,
    ),
    ...unique([...FOOTERS, ...SESSION_LINKS].flatMap((rule) => rule.texts)).map(
      (text) => `contains(${body}, ${quote(text)})`,
    ),
  ];
}

export interface AgentPullConditionOptions {
  /** The selfhost GitHub App's agent label prefix. Default AGENT_LABEL_PREFIX. */
  labelPrefix?: string;
  /**
   * The workflow also runs on `labeled`, so a pull request only the App's label marks as an
   * agent's is reviewed as soon as it is labeled. Default true.
   */
  labelEvents?: boolean;
}

/**
 * A GitHub Actions `if:` expression, for a workflow on `pull_request`, that is true on pull
 * requests an agent opened: the same signals selfhost attributes a pull request by when its
 * webhook arrives (an agent branch prefix, an agent account as author, an agent's attribution
 * line or session link in the description), or an agent label the selfhost GitHub App put on it.
 * With label events, a labeled event counts only for an agent label on a pull request the other
 * signals do not already catch, so the reviewer does not run twice when the App labels a pull
 * request it ran on at open. Actions compares strings ignoring case, as GitHub does.
 */
export function agentPullCondition(options: AgentPullConditionOptions = {}): string {
  const prefix = options.labelPrefix ?? AGENT_LABEL_PREFIX;
  const pull = "github.event.pull_request";
  const signals = attributionTerms(pull).join(" ||\n    ");
  const labeled = `contains(join(${pull}.labels.*.name, ' '), ${quote(prefix)})`;
  if (options.labelEvents === false) {
    return [`${pull}.draft == false && (`, `    ${labeled} ||`, `    ${signals}`, ")"].join("\n");
  }
  return [
    `${pull}.draft == false && (`,
    `  (github.event.action == 'labeled' && startsWith(github.event.label.name, ${quote(prefix)}) && !(`,
    `    ${signals}`,
    "  )) ||",
    `  (github.event.action != 'labeled' && (`,
    `    ${labeled} ||`,
    `    ${signals}`,
    "  ))",
    ")",
  ].join("\n");
}

/**
 * Logins of the accounts agents open pull requests from, for tools that skip bot actors unless
 * told about them (the Claude Code action's allowed_bots).
 */
export function agentAccounts(): string[] {
  return [...Object.keys(BOT_LOGINS), ...Object.keys(AGENT_LOGINS).map((login) => `${login}[bot]`)];
}

/** The App's agent label for each vendor, as @selfhost/github's agentLabel writes them. */
export function agentLabels(labelPrefix = AGENT_LABEL_PREFIX): string[] {
  return AGENT_VENDORS.map((vendor) => `${labelPrefix}${vendor.replaceAll("_", "-")}`);
}
