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

/** The header a signed webhook carries: `sha256=` and the HMAC-SHA256 of the body in hex. */
export const WEBHOOK_SIGNATURE_HEADER = "x-selfhost-signature-256";

export function signWebhook(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** Whether `signature` signs `body` under `secret`. */
export function verifyWebhook(
  secret: string,
  body: string,
  signature: string | undefined,
): boolean {
  if (!secret || !signature) return false;
  const expected = Buffer.from(signWebhook(secret, body));
  const given = Buffer.from(signature.trim());
  return expected.length === given.length && timingSafeEqual(expected, given);
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
