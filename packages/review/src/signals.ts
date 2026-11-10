import { decisionPaths } from "@selfhost/ledger";
import {
  type AgentVendor,
  type LedgerEvent,
  REDACTED,
  type ReviewItemKind,
  type ReviewWhy,
} from "@selfhost/schema";

/**
 * What one ledger signal says about the item it belongs to. Signals with the same dedupeKey make
 * one item while it is open.
 */
export interface Draft {
  kind: ReviewItemKind;
  /**
   * The item's id when the signal fixes it: an exception request names its item before the item
   * exists. A newer signal with the same key and another id replaces the open item.
   */
  id?: string;
  dedupeKey: string;
  title: string;
  why: ReviewWhy;
  score: number;
  reasons: string[];
  /** The signal carries its own risk score (a PR's), which replaces the stored one. */
  scored: boolean;
  /** An agent waits on the answer. */
  blocking: boolean;
  /** Times out to a deny: a blocking approval. */
  timesOut: boolean;
  /**
   * The signal adds to the item `id` names and opens none: an agent's case for an exception the
   * hook already asked for. Nothing happens when that item is not on the list.
   */
  attach?: boolean;
  /** Markdown the person reads to decide: replaces the item's brief. */
  brief?: string;
  /** Tool an approval waits on, when known. Its next result in the session ends the wait. */
  tool?: string;
  paths: string[];
  /** The person named by the signal itself; otherwise the session's person is looked up. */
  person?: string;
  /** Team name on the event, matched against [teams]. */
  team?: string;
  url?: string;
}

/** Alerts that become items, by data.alert. Other alerts stay in the ledger only. */
const ALERT_KINDS: Record<string, ReviewItemKind> = {
  spend_spike: "spend_spike",
  limit_forecast: "budget",
  usage_limit: "budget",
  budget: "budget",
  budget_exceeded: "budget",
  sandbox_left_running: "budget",
  run_failed: "stuck_run",
  run_stuck: "stuck_run",
  api_error: "stuck_run",
  model_request_failed: "stuck_run",
  quality: "quality",
  quality_alarm: "quality",
};

/**
 * data.request of the approval.requested events the selfhost MCP server writes: an agent asks a
 * person a question, or makes its case for a one-time exception a block named.
 */
export const MCP_QUESTION_REQUEST = "mcp_question";
export const MCP_EXCEPTION_REQUEST = "mcp_exception";

/**
 * data.request of the approval.requested event the team server writes when a person proposes
 * one of their own context items to the team (POST /v1/context/proposals).
 */
export const CONTEXT_PROMOTION_REQUEST = "context_promotion";

/** Claude Code notification types that ask a question rather than for permission. */
const QUESTION_NOTIFICATIONS = new Set(["idle_prompt", "elicitation_dialog"]);

/** A policy verdict counts as live, so an agent can be waiting on it, within this of the call. */
const LIVE_EVALUATION_MS = 60_000;

const TITLE_MAX = 200;

const AGENT_NAMES: Record<AgentVendor, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  goose: "Goose",
  cursor: "Cursor",
  copilot: "Copilot",
  other: "An agent",
};

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const flat = value.replace(/\s+/g, " ").trim();
  return flat === "" ? undefined : flat;
}

/** A person id from a data field. Masked values (emails are masked under data) are no use. */
function personId(value: unknown): string | undefined {
  const id = text(value);
  return id && !id.includes("[redacted") ? id : undefined;
}

function title(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 3)}...` : flat;
}

function agentName(event: LedgerEvent): string {
  return event.agent ? AGENT_NAMES[event.agent.vendor] : "An agent";
}

/** "Bash: git push", "Edit: src/app.ts", or the tool alone. */
function call(event: LedgerEvent, tool: string | undefined): string | undefined {
  const input = text(event.tool?.input_summary) ?? text(event.target?.value);
  if (tool && input) return `${tool}: ${input}`;
  return tool ?? input;
}

function eventPerson(event: LedgerEvent): string | undefined {
  return event.actor.kind === "person" ? event.actor.id : undefined;
}

function clampScore(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item !== "")
    : [];
}

function base(event: LedgerEvent) {
  return {
    paths: decisionPaths(event),
    person: eventPerson(event),
    ...(event.team ? { team: event.team } : {}),
    ...(event.links?.run_url ? { url: event.links.run_url } : {}),
  };
}

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * A request an agent made through the selfhost MCP server. Its item id is in links.item_id: a
 * question opens that item; an exception request adds the agent's reason to the exception item
 * the hook opened when it blocked the call, and marks it blocking, since the agent now waits.
 */
function fromMcpRequest(event: LedgerEvent): Draft | undefined {
  const data = event.data ?? {};
  const id = event.links?.item_id?.toLowerCase();
  if (id === undefined || !UUIDV7.test(id)) return undefined;
  const agent = agentName(event);
  const common = {
    ...base(event),
    id,
    scored: false,
    blocking: true,
    timesOut: false,
  };
  if (data.request === MCP_QUESTION_REQUEST) {
    const question = text(data.question);
    if (!question) return undefined;
    const context = typeof data.context === "string" ? data.context.trim() : "";
    return {
      ...common,
      kind: "question",
      dedupeKey: `question:mcp:${id}`,
      title: title(question),
      why: {
        signal: "approval.requested",
        text: `${agent} asked this through the selfhost MCP server and waits for the answer.`,
      },
      score: 30,
      reasons: ["An agent is waiting for an answer"],
      ...(context ? { brief: context } : {}),
    };
  }
  if (data.request === MCP_EXCEPTION_REQUEST) {
    const reason = text(data.reason);
    return {
      ...common,
      kind: "exception",
      attach: true,
      dedupeKey: `exception:mcp:${id}`,
      title: "Exception request",
      why: { signal: "approval.requested", text: "The agent asks for this exception." },
      score: 0,
      reasons: [],
      ...(reason ? { brief: `${agent} asks for this exception: ${reason}` } : {}),
    };
  }
  return undefined;
}

/**
 * A person's context item proposed to the team. Its item id is the proposal's id, so approving
 * the item is what adds it to the team layer. It is not routed to the person who proposed it:
 * an owner or admin of the team answers it.
 */
function fromContextProposal(event: LedgerEvent): Draft | undefined {
  const data = event.data ?? {};
  const id = event.links?.item_id?.toLowerCase();
  const item = text(data.item);
  if (id === undefined || !UUIDV7.test(id) || !item) return undefined;
  const { person: _proposer, ...common } = base(event);
  const who = eventPerson(event) ?? "A team member";
  const summary = typeof data.summary === "string" ? data.summary.trim() : "";
  return {
    ...common,
    kind: "context_promotion",
    id,
    // A newer proposal of the same item replaces the open one.
    dedupeKey: `context_promotion:${item}`,
    title: title(`Add ${item} to the team's context`),
    why: {
      signal: "approval.requested",
      text: `${who} proposes their ${item} for everyone in the team. Approving adds it to the team layer, which every member's agents get on their next sync; it takes an owner or admin.`,
    },
    score: 20,
    reasons: ["Approving changes what every member's agents load"],
    scored: false,
    blocking: false,
    timesOut: false,
    ...(summary ? { brief: summary } : {}),
  };
}

/** approval.requested: a permission prompt is an approval, an idle prompt or elicitation a question. */
function fromApprovalRequest(event: LedgerEvent): Draft | undefined {
  if (event.data?.request === CONTEXT_PROMOTION_REQUEST) return fromContextProposal(event);
  const mcp = fromMcpRequest(event);
  if (mcp) return mcp;
  const data = event.data ?? {};
  const message = text(data.message);
  const waitKey = event.session_id ?? event.id;
  const agent = agentName(event);
  const notification = text(data.notification_type);
  if (notification && QUESTION_NOTIFICATIONS.has(notification)) {
    return {
      ...base(event),
      kind: "question",
      dedupeKey: `question:${waitKey}`,
      title: title(message ?? `${agent} is waiting for an answer`),
      why: {
        signal: "approval.requested",
        text:
          notification === "elicitation_dialog"
            ? "A tool asked a question and the agent waits for the answer."
            : "The agent stopped and waits for your input.",
      },
      score: 30,
      reasons: ["An agent is waiting for an answer"],
      scored: false,
      blocking: true,
      timesOut: false,
    };
  }
  const tool = event.tool?.name ?? /permission to use (\S+)/i.exec(message ?? "")?.[1];
  const what = call(event, event.tool?.name);
  return {
    ...base(event),
    kind: "approval",
    dedupeKey: `approval:${waitKey}`,
    title: title(
      message ?? (what ? `${agent} asks to use ${what}` : `${agent} is waiting for permission`),
    ),
    why: { signal: "approval.requested", text: "The agent is waiting for permission to go on." },
    score: 50,
    reasons: ["An agent is waiting for permission"],
    scored: false,
    blocking: true,
    timesOut: true,
    ...(tool ? { tool } : {}),
  };
}

/**
 * true when the verdict was given while the call was being made, so an agent can be waiting on
 * it. The observe pass (`selfhost policy observe`, source cli) judges calls after the fact.
 */
function isLive(event: LedgerEvent): boolean {
  if (event.source === "cli") return false;
  const evaluatedAt = event.data?.evaluated_at;
  if (typeof evaluatedAt !== "string") return true;
  return Math.abs(Date.parse(evaluatedAt) - Date.parse(event.ts)) <= LIVE_EVALUATION_MS;
}

/** The one-time exception a hook's block asks for: the item id it named and the call's hash. */
function exceptionRequest(event: LedgerEvent): { id: string; fingerprint: string } | undefined {
  const exception = event.data?.exception;
  if (exception === null || typeof exception !== "object") return undefined;
  const { id, fingerprint, used } = exception as Record<string, unknown>;
  if (used === true || typeof id !== "string" || !UUIDV7.test(id)) return undefined;
  if (typeof fingerprint !== "string" || fingerprint === "") return undefined;
  return { id, fingerprint };
}

/**
 * policy.evaluated in enforce mode: ask is an approval, block a blocked action, and a block that
 * carries an exception request (from a pre-tool hook) an exception item a person can approve to
 * allow the call once.
 */
function fromPolicyVerdict(event: LedgerEvent): Draft | undefined {
  const decision = event.decision;
  if (!decision || (decision.verdict !== "ask" && decision.verdict !== "block")) return undefined;
  if (decision.mode === "observe") return undefined;
  const rule = decision.rule_id ?? "unknown";
  const irreversible = event.data?.irreversible === true;
  const tool = event.tool?.name;
  const what = call(event, tool) ?? "an action";
  const why: ReviewWhy = {
    signal: "policy.evaluated",
    rule_id: rule,
    text: text(decision.reason) ?? `Rule ${rule} ${decision.verdict}s this action.`,
  };
  const irreversibleReason = irreversible ? ["The rule marks this action as irreversible"] : [];
  // A verdict recorded after the fact finds no agent waiting on it.
  const live = isLive(event);
  if (decision.verdict === "ask") {
    return {
      ...base(event),
      kind: "approval",
      dedupeKey: live
        ? `approval:${event.session_id ?? event.id}`
        : `ask:${rule}:${String(event.data?.tool_event_id ?? event.id)}`,
      title: title(`Approve ${what}`),
      why,
      score: irreversible ? 90 : 50,
      reasons: [`Rule ${rule} asks a person first`, ...irreversibleReason],
      scored: false,
      blocking: live,
      timesOut: live,
      ...(tool ? { tool } : {}),
    };
  }
  const exception = exceptionRequest(event);
  if (exception) {
    const alternative = text(event.data?.alternative);
    // The hook's verdict is a system event; the person who sent it is the one whose agent it was.
    const person = eventPerson(event) ?? personId(event.data?.sent_by);
    return {
      ...base(event),
      ...(person ? { person } : {}),
      kind: "exception",
      id: exception.id,
      // One open request per call: a retry replaces it, since the agent was given the new id.
      dedupeKey: `exception:${exception.fingerprint}`,
      title: title(`Allow once: ${what}`),
      why: { ...why, text: alternative ? `${why.text} Instead: ${alternative}` : why.text },
      score: irreversible ? 80 : 50,
      reasons: [
        `Rule ${rule} blocked it; approving allows this exact call once`,
        ...irreversibleReason,
      ],
      scored: false,
      // The hook denied the call and the agent went on: nobody waits on this answer. An agent
      // that makes its case over MCP and waits for the answer makes it blocking then.
      blocking: false,
      timesOut: false,
      ...(tool ? { tool } : {}),
    };
  }
  return {
    ...base(event),
    kind: "blocked_action",
    dedupeKey: `blocked:${rule}:${event.session_id ?? ""}:${what}`,
    title: title(live ? `Blocked ${what}` : `Rule ${rule} blocks ${what}`),
    why,
    score: irreversible ? 70 : 40,
    reasons: [`Rule ${rule} blocked it`, ...irreversibleReason],
    scored: false,
    blocking: false,
    timesOut: false,
  };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** alert.raised: spend spikes, budget and plan-limit warnings, failed runs and quality alarms. */
function fromAlert(event: LedgerEvent): Draft | undefined {
  const data = event.data ?? {};
  const alert = text(data.alert);
  const kind = alert ? ALERT_KINDS[alert] : undefined;
  if (!alert || !kind) return undefined;
  const message = text(data.message);
  const agent = agentName(event);
  const common = {
    ...base(event),
    kind,
    scored: false,
    blocking: false,
    timesOut: false,
  };
  const signal = `alert.raised:${alert}`;
  switch (kind) {
    case "spend_spike": {
      const series = (
        data.series !== null && typeof data.series === "object" ? data.series : {}
      ) as Record<string, unknown>;
      const person = personId(series.person) ?? personId(data.owner);
      return {
        ...common,
        dedupeKey: `spend_spike:${stable(data.series ?? data.owner ?? event.actor.id)}`,
        title: title(message ?? "Spend spike"),
        why: {
          signal,
          text: text(data.reason) ?? text(data.label) ?? "Spend jumped far above the usual rate.",
        },
        score: 90,
        reasons: ["Spend far above the usual rate can mean a stolen key"],
        ...(person ? { person } : {}),
      };
    }
    case "budget": {
      const person = personId(data.owner) ?? eventPerson(event);
      const window = text(data.window) ?? "";
      const hit = alert === "usage_limit";
      // Alerts stored before person ids were kept in their own messages lost the name.
      const named =
        person && message?.startsWith(`${REDACTED} `)
          ? `${person}${message.slice(REDACTED.length)}`
          : message;
      return {
        ...common,
        dedupeKey: `budget:${alert}:${person ?? event.actor.id}:${text(data.plan) ?? text(data.cap) ?? event.agent?.vendor ?? ""}:${window}`,
        title: title(
          named ??
            (hit
              ? `${agent} reached its ${window ? `${window} ` : ""}usage limit`
              : "Budget or plan limit warning"),
        ),
        why: {
          signal,
          text:
            text(data.suggestion) ??
            (hit
              ? `The agent stopped at a plan limit${text(data.resets_at) ? ` until ${data.resets_at}` : ""}.`
              : "Spend is on course to pass a budget or plan limit."),
        },
        score: hit ? 60 : 50,
        reasons: [hit ? "A plan limit stopped an agent" : "A budget or plan limit is close"],
        ...(person ? { person } : {}),
      };
    }
    case "stuck_run": {
      const failed = alert === "run_failed" || alert === "run_stuck";
      const error = text(data.error);
      return {
        ...common,
        dedupeKey: `stuck_run:${event.run_id ?? event.session_id ?? event.id}`,
        title: title(
          message ??
            (alert === "run_stuck"
              ? `${agent} run looks stuck`
              : `${agent} run failing${error ? `: ${error}` : ""}`),
        ),
        why: { signal, text: error ?? `The run reported ${alert}.` },
        score: failed ? 60 : 30,
        reasons: [failed ? "A run failed or stopped making progress" : "A run hit errors"],
      };
    }
    default: {
      const metric = text(data.metric) ?? text(data.check);
      return {
        ...common,
        dedupeKey: `quality:${metric ?? event.model ?? event.id}`,
        title: title(message ?? `Quality alarm${metric ? `: ${metric}` : ""}`),
        why: { signal, text: text(data.reason) ?? "A quality check fell below its threshold." },
        score: 60,
        reasons: ["Agent output quality dropped"],
      };
    }
  }
}

/** The dedupe key of a pull request's `pr` item: one open item per PR URL in a team scope. */
export const pullRequestKey = (url: string) => `pr:${url}`;

/** pr.opened for an agent PR. The risk score is an input (data.risk or data.risk_score). */
function fromPullRequest(event: LedgerEvent): Draft | undefined {
  const data = event.data ?? {};
  if (data.unattributed === true || !event.agent) return undefined;
  const url = event.links?.pr_url ?? (event.target?.type === "pr" ? event.target.value : undefined);
  if (!url) return undefined;
  const risk = data.risk !== null && typeof data.risk === "object" ? data.risk : undefined;
  const score =
    clampScore((risk as Record<string, unknown> | undefined)?.score) ?? clampScore(data.risk_score);
  const reasons = strings((risk as Record<string, unknown> | undefined)?.reasons);
  const number = typeof data.number === "number" ? `#${data.number}` : url;
  const signal = text(data.signal);
  return {
    ...base(event),
    paths: [...new Set([...decisionPaths(event), ...strings(data.files)])],
    kind: "pr",
    dedupeKey: pullRequestKey(url),
    title: title(text(data.title) ?? `Agent PR ${number}${event.repo ? ` in ${event.repo}` : ""}`),
    why: {
      signal: "pr.opened",
      text: `${agentName(event)} opened this pull request${signal ? ` (found by ${signal})` : ""}.`,
    },
    score: score ?? 50,
    reasons: score === undefined ? ["No risk score for this pull request yet"] : reasons,
    scored: score !== undefined,
    blocking: false,
    timesOut: false,
    url,
  };
}

/** The item a signal opens or adds to, or undefined when it opens none. */
export function draftFor(event: LedgerEvent): Draft | undefined {
  switch (event.kind) {
    case "approval.requested":
      return fromApprovalRequest(event);
    case "policy.evaluated":
      return fromPolicyVerdict(event);
    case "alert.raised":
      return fromAlert(event);
    case "pr.opened":
      return fromPullRequest(event);
    default:
      return undefined;
  }
}

/** The pull request a pr.merged or pr.closed event closes. */
export function closedPullRequest(event: LedgerEvent): string | undefined {
  if (event.kind !== "pr.merged" && event.kind !== "pr.closed") return undefined;
  return event.links?.pr_url ?? (event.target?.type === "pr" ? event.target.value : undefined);
}
