import { createHmac, timingSafeEqual } from "node:crypto";
import {
  BACKGROUND_AGENTS,
  type BackgroundAgent,
  cronTimes,
  parseCron,
  type ResolvedBackgroundConfig,
  type Schedule,
} from "@selfhost/schema";

/** A run asked for on GitHub: a comment command or a label on an issue. */
export interface GitHubRunRequest {
  source: "github_comment" | "github_label";
  repo: string;
  /** The issue or pull request number, to answer on. */
  number: number;
  /** The GitHub login that asked. */
  sender: string;
  task: string;
  agent?: BackgroundAgent;
  /** The issue, pull request or comment URL. */
  url: string;
  installation?: number;
}

interface IssuePayload {
  action?: string;
  issue?: {
    number: number;
    title?: string;
    body?: string | null;
    html_url?: string;
    pull_request?: unknown;
  };
  comment?: { body?: string; html_url?: string; user?: { login?: string; type?: string } };
  label?: { name?: string };
  sender?: { login?: string; type?: string };
  repository?: { full_name?: string; name?: string; owner?: { login?: string } };
  installation?: { id?: number };
}

const repoOf = (payload: IssuePayload) =>
  payload.repository?.full_name ??
  (payload.repository?.owner?.login && payload.repository.name
    ? `${payload.repository.owner.login}/${payload.repository.name}`
    : undefined);

function issueTask(issue: NonNullable<IssuePayload["issue"]>): string {
  const what = issue.pull_request ? "pull request" : "issue";
  const body = issue.body?.trim();
  return [
    `Resolve GitHub ${what} #${issue.number}: ${issue.title ?? ""}`.trim(),
    ...(body ? ["", body] : []),
  ].join("\n");
}

/**
 * The run a GitHub delivery asks for, or why it asks for none: an issue_comment that starts with
 * [background] github_command (`/selfhost run [--agent codex] <task>`, the issue itself when no
 * task follows), or an issues delivery labeled with [background] github_label. Comments from
 * bots never start a run.
 */
export function githubRunRequest(
  event: string,
  payload: unknown,
  background: Pick<ResolvedBackgroundConfig, "github_command" | "github_label">,
): GitHubRunRequest | { skip: string } {
  const body = (payload ?? {}) as IssuePayload;
  const repo = repoOf(body);
  const issue = body.issue;
  if (!repo || !issue) return { skip: "no issue in the payload" };
  const installation = body.installation?.id;
  const where = { repo, number: issue.number, ...(installation ? { installation } : {}) };

  if (event === "issue_comment") {
    if (body.action !== "created") return { skip: `action ${body.action} is not handled` };
    const text = body.comment?.body?.trim() ?? "";
    const command = background.github_command;
    if (!text.toLowerCase().startsWith(command.toLowerCase())) return { skip: "not a run command" };
    const user = body.comment?.user;
    if (!user?.login) return { skip: "no comment author" };
    if (user.type === "Bot") return { skip: "comments from bots start no runs" };
    let rest = text.slice(command.length).trim();
    let agent: BackgroundAgent | undefined;
    const flag = /^--agent[= ]+(\S+)\s*/.exec(rest);
    if (flag) {
      const name = flag[1]?.toLowerCase() as BackgroundAgent;
      if (!BACKGROUND_AGENTS.includes(name)) {
        return { skip: `unknown agent ${flag[1]}; one of ${BACKGROUND_AGENTS.join(", ")}` };
      }
      agent = name;
      rest = rest.slice(flag[0].length).trim();
    }
    return {
      source: "github_comment",
      ...where,
      sender: user.login,
      task: rest || issueTask(issue),
      ...(agent ? { agent } : {}),
      url:
        body.comment?.html_url ??
        issue.html_url ??
        `https://github.com/${repo}/issues/${issue.number}`,
    };
  }

  if (event === "issues") {
    if (body.action !== "labeled") return { skip: `action ${body.action} is not handled` };
    if (body.label?.name?.toLowerCase() !== background.github_label.toLowerCase()) {
      return { skip: "not the run label" };
    }
    const sender = body.sender;
    if (!sender?.login) return { skip: "no sender" };
    if (sender.type === "Bot") return { skip: "labels from bots start no runs" };
    return {
      source: "github_label",
      ...where,
      sender: sender.login,
      task: issueTask(issue),
      url: issue.html_url ?? `https://github.com/${repo}/issues/${issue.number}`,
    };
  }
  return { skip: `${event} events start no runs` };
}

/** The selfhost person a GitHub login belongs to, from [review] github_logins. */
export function personForLogin(
  login: string,
  githubLogins: Readonly<Record<string, string>>,
): string | undefined {
  const wanted = login.toLowerCase();
  return Object.entries(githubLogins).find(([, value]) => value.toLowerCase() === wanted)?.[0];
}

/**
 * The headers a signed webhook carries: when it was sent (Unix seconds), a delivery id the
 * sender makes up once per request, and `sha256=` with the HMAC-SHA256 in hex of
 * `<timestamp>.<delivery>.<body>`. The server takes each delivery id once and only within
 * WEBHOOK_MAX_AGE_SECONDS of its timestamp, so a captured request cannot be sent again.
 */
export const WEBHOOK_SIGNATURE_HEADER = "x-selfhost-signature-256";
export const WEBHOOK_TIMESTAMP_HEADER = "x-selfhost-timestamp";
export const WEBHOOK_DELIVERY_HEADER = "x-selfhost-delivery";
export const WEBHOOK_MAX_AGE_SECONDS = 300;

export interface WebhookStamp {
  /** Unix seconds, as sent in WEBHOOK_TIMESTAMP_HEADER. */
  timestamp: string;
  /** WEBHOOK_DELIVERY_HEADER: 8 to 128 letters, digits, dots, dashes or underscores. */
  delivery: string;
}

const DELIVERY_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

export function signWebhook(secret: string, body: string, stamp: WebhookStamp): string {
  const signed = `${stamp.timestamp}.${stamp.delivery}.${body}`;
  return `sha256=${createHmac("sha256", secret).update(signed).digest("hex")}`;
}

/** Whether `signature` signs `body` with this timestamp and delivery id under `secret`. */
export function verifyWebhook(
  secret: string,
  body: string,
  stamp: Partial<WebhookStamp>,
  signature: string | undefined,
): boolean {
  if (!secret || !signature || !stamp.timestamp || !stamp.delivery) return false;
  const expected = Buffer.from(
    signWebhook(secret, body, { timestamp: stamp.timestamp, delivery: stamp.delivery }),
  );
  const given = Buffer.from(signature.trim());
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * Why a webhook's timestamp or delivery id is refused, or undefined when they are fine: the
 * timestamp is Unix seconds within WEBHOOK_MAX_AGE_SECONDS of `now`, either way, and the
 * delivery id has the expected form. Whether the id was seen before is the server's to check.
 */
export function webhookStampProblem(stamp: Partial<WebhookStamp>, now: Date): string | undefined {
  if (!stamp.timestamp || !/^\d{1,12}$/.test(stamp.timestamp)) {
    return `${WEBHOOK_TIMESTAMP_HEADER} must be the Unix time in seconds the request was sent`;
  }
  const age = Math.abs(now.getTime() / 1000 - Number(stamp.timestamp));
  if (age > WEBHOOK_MAX_AGE_SECONDS) {
    return `${WEBHOOK_TIMESTAMP_HEADER} is more than ${WEBHOOK_MAX_AGE_SECONDS / 60} minutes from the server's time`;
  }
  if (!stamp.delivery || !DELIVERY_PATTERN.test(stamp.delivery)) {
    return `${WEBHOOK_DELIVERY_HEADER} must be a new id for each request: 8 to 128 letters, digits, dots, dashes or underscores`;
  }
  return undefined;
}

/** A schedule that fell due, with the minute it is for. */
export interface DueSchedule {
  schedule: Schedule;
  at: Date;
  /** The trigger ref, the same for every server that sees the same minute. */
  ref: string;
}

/**
 * The [background] schedules due in (after, until], at most one minute each, so a scheduler that
 * was down starts each missed schedule once.
 */
export function dueSchedules(
  background: Pick<ResolvedBackgroundConfig, "schedules">,
  after: Date,
  until: Date,
): DueSchedule[] {
  const due: DueSchedule[] = [];
  for (const schedule of background.schedules) {
    const cron = parseCron(schedule.cron);
    if (typeof cron === "string") continue;
    const [at] = cronTimes(cron, after, until, 1);
    if (at) due.push({ schedule, at, ref: `schedule:${schedule.name}@${at.toISOString()}` });
  }
  return due;
}
