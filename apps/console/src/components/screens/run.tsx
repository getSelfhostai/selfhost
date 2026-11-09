import {
  describeSecondOpinion,
  type EventsPage,
  type LedgerEvent,
  secondOpinionOf,
} from "@selfhost/schema";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { Empty, Failed, Loading, PageHeader, Section } from "@/components/common";
import { SecondOpinionBadges, SecondOpinions } from "@/components/second-opinions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getJson, getOptional, query } from "@/lib/api";
import { useConsole } from "@/lib/console-context";
import type { RunReport } from "@/lib/contracts";
import { agentName, formatCompact, formatTime, formatUsd } from "@/lib/format";
import { useApi } from "@/lib/use-api";

const PR_KINDS: Record<string, string> = {
  "pr.opened": "open",
  "pr.merged": "merged",
  "pr.closed": "closed",
};

const tokensOf = (event: LedgerEvent) =>
  event.cost
    ? event.cost.input_tokens +
      event.cost.output_tokens +
      event.cost.cache_read_tokens +
      event.cost.cache_write_tokens
    : 0;

/**
 * A run from its ledger events, for servers without GET /v1/runs/{id}: who, agent, model, repo,
 * when, cost and the pull requests its events name.
 */
export function runFromEvents(
  id: string,
  events: LedgerEvent[],
  nextCursor: string | null = null,
): RunReport {
  const sorted = byTime(events);
  const first = (pick: (event: LedgerEvent) => string | undefined) => {
    for (const event of sorted) {
      const value = pick(event);
      if (value) return value;
    }
    return null;
  };
  const prs = new Map<string, string>();
  for (const event of sorted) {
    const url = event.links?.pr_url;
    const state = PR_KINDS[event.kind];
    if (url) prs.set(url, state ?? prs.get(url) ?? "open");
  }
  return {
    schema: "selfhost.run/v1",
    run: {
      id,
      agent: sorted.find((e) => e.agent)?.agent ?? null,
      model: first((e) => e.model),
      person: first((e) => (e.actor.kind === "person" ? e.actor.id : undefined)),
      team: first((e) => e.team),
      repo: first((e) => e.repo),
      started_at: sorted[0]?.ts ?? null,
      ended_at: sorted.findLast((e) => e.kind === "session.ended")?.ts ?? null,
      cost_usd: sorted.reduce((sum, e) => sum + (e.cost?.usd ?? 0), 0),
      tokens: sorted.reduce((sum, e) => sum + tokensOf(e), 0),
    },
    events: sorted,
    prs: [...prs].map(([url, state]) => ({ url, state })),
    trace_url: null,
    next_cursor: nextCursor,
  };
}

const byTime = (events: LedgerEvent[]) =>
  [...events].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || (a.id < b.id ? -1 : 1));

/** Where a run's events come from: the run route, or the events of its session. */
type Source = "runs" | "events";

const runPath = (id: string, cursor?: string) =>
  `/v1/runs/${encodeURIComponent(id)}${query({ cursor })}`;
const eventsPath = (id: string, team: string | undefined, cursor?: string) =>
  `/v1/events${query({ session: id, team, limit: 1000, cursor })}`;

/**
 * The tool events a pre-tool hook stopped: the hook's own verdict names the tool event it was
 * about, so the call is shown as blocked rather than as one that ran.
 */
export function blockedToolEvents(events: readonly LedgerEvent[]): Set<string> {
  const blocked = new Set<string>();
  for (const event of events) {
    const toolEvent = event.data?.tool_event_id;
    if (event.kind !== "policy.evaluated" || typeof toolEvent !== "string") continue;
    const denied =
      event.data?.answer === "deny" ||
      (event.decision?.verdict === "block" && event.decision.mode !== "observe");
    if (denied) blocked.add(toolEvent);
  }
  return blocked;
}

/** One line for a ledger event in the timeline. `blocked`: a hook stopped this tool call. */
export function eventLine(event: LedgerEvent, blocked = false): { title: string; detail?: string } {
  const input = event.tool?.input_summary ?? event.target?.value;
  switch (event.kind) {
    case "session.started":
      return { title: "Session started" };
    case "session.ended":
      return { title: "Session ended" };
    case "prompt.submitted":
      return { title: "Prompt" };
    case "tool.called":
      return {
        title: `${blocked ? "Tool call blocked, did not run" : "Tool call"}: ${event.tool?.name ?? "unknown tool"}`,
        detail: input,
      };
    case "tool.result":
      return { title: `Tool result: ${event.tool?.name ?? "unknown tool"}` };
    case "approval.requested":
      return { title: "Asked a person", detail: input };
    case "decision.recorded":
      return {
        title: `Decision: ${event.decision?.verdict ?? "recorded"}${event.decision?.by ? ` by ${event.decision.by}` : ""}`,
        detail: event.decision?.reason,
      };
    case "policy.evaluated": {
      const mode = event.decision?.mode === "observe" ? "would have " : "";
      const verdict = event.decision?.verdict;
      const did =
        verdict === "block"
          ? `${mode}blocked`
          : verdict === "ask"
            ? `${mode}asked a person`
            : "allowed";
      return {
        title: `Rule ${event.decision?.rule_id ?? ""} ${did}`.replace("  ", " "),
        detail: input,
      };
    }
    case "cost.recorded":
      return {
        title: `Model request: ${formatUsd(event.cost?.usd ?? 0)}`,
        detail: `${formatCompact(tokensOf(event))} tokens${event.model ? `, ${event.model}` : ""}`,
      };
    case "commit.created":
      return { title: "Commit", detail: event.links?.commit_sha };
    case "pr.opened":
      return { title: "Pull request opened", detail: event.links?.pr_url };
    case "pr.merged":
      return { title: "Pull request merged", detail: event.links?.pr_url };
    case "pr.closed":
      return { title: "Pull request closed", detail: event.links?.pr_url };
    case "alert.raised":
      return { title: "Alert", detail: String(event.data?.alert ?? "") };
    case "review.submitted": {
      const opinion = secondOpinionOf(event);
      return {
        title: opinion ? `Second opinion: ${describeSecondOpinion(opinion)}` : "Second opinion",
        detail: event.links?.pr_url,
      };
    }
    default:
      return { title: event.kind };
  }
}

export function RunScreen() {
  const { view, me } = useConsole();
  const id = view.run;
  const team = view.filters.team ?? (me.kind === "person" ? me.team?.id : undefined);
  const loaded = useApi(id ? `run:${id}:${team ?? ""}` : null, async (signal) => {
    const run = await getOptional<RunReport>(runPath(id ?? ""), signal);
    if (run) return { report: run, source: "runs" as Source };
    const page = await getJson<EventsPage>(eventsPath(id ?? "", team), signal);
    return {
      report: runFromEvents(id ?? "", page.events, page.next_cursor),
      source: "events" as Source,
    };
  });
  const [more, setMore] = useState<{ key: string; events: LedgerEvent[]; cursor: string | null }>();
  const [loadingMore, setLoadingMore] = useState(false);
  const key = `${id}:${team ?? ""}`;
  const extra = more?.key === key ? more : undefined;

  if (!id) {
    return (
      <>
        <PageHeader title="Run" />
        <Empty title="No run picked">Open a run from the review list or the overview.</Empty>
      </>
    );
  }
  const report = loaded.data?.report;
  const cursor = extra ? extra.cursor : (report?.next_cursor ?? null);
  const data = report && {
    ...report,
    events: extra ? byTime([...report.events, ...extra.events]) : report.events,
  };
  const run = data?.run;
  const blocked = blockedToolEvents(data?.events ?? []);

  const loadMore = async () => {
    if (!cursor || !loaded.data) return;
    setLoadingMore(true);
    try {
      const page =
        loaded.data.source === "runs"
          ? await getJson<RunReport>(runPath(id, cursor)).then((r) => ({
              events: r.events,
              next_cursor: r.next_cursor,
            }))
          : await getJson<EventsPage>(eventsPath(id, team, cursor));
      setMore({
        key,
        events: [...(extra?.events ?? []), ...page.events],
        cursor: page.next_cursor,
      });
    } finally {
      setLoadingMore(false);
    }
  };
  return (
    <>
      <PageHeader
        title="Run"
        description={<span className="break-all font-mono text-xs">{id}</span>}
        actions={
          data?.trace_url ? (
            <Button asChild variant="outline" size="sm">
              <a href={data.trace_url} target="_blank" rel="noreferrer">
                Open in your tracer
                <ExternalLink />
              </a>
            </Button>
          ) : (
            <div className="flex flex-col items-end gap-1">
              <Button
                variant="outline"
                size="sm"
                disabled
                aria-describedby="tracer-hint"
                className="cursor-not-allowed border-dashed text-muted-foreground"
              >
                Open in your tracer
              </Button>
              <span id="tracer-hint" className="text-muted-foreground text-xs">
                No tracer link: set [integrations.tracer] run_url to link runs.
              </span>
            </div>
          )
        }
      />
      {loaded.error ? <Failed error={loaded.error} what="this run" /> : null}
      {!data && !loaded.error ? <Loading /> : null}
      {data && data.events.length === 0 ? (
        <Empty title="No events for this run">
          It may belong to a team you are not in, or its events have not reached the server yet.
        </Empty>
      ) : null}
      {run && data.events.length > 0 ? (
        <>
          <Card className="py-4">
            <CardContent className="px-4">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm md:grid-cols-4">
                <Fact name="Who" value={run.person ?? "Unknown"} />
                <Fact name="Agent" value={run.agent?.name ?? agentName(run.agent?.vendor)} />
                <Fact name="Model" value={run.model ?? "Unknown"} />
                <Fact name="Repo" value={run.repo ?? "None"} />
                <Fact name="Cost" value={formatUsd(run.cost_usd)} />
                <Fact name="Tokens" value={formatCompact(run.tokens)} />
                <Fact name="Started" value={run.started_at ? formatTime(run.started_at) : "-"} />
                <Fact name="Ended" value={run.ended_at ? formatTime(run.ended_at) : "Not ended"} />
              </dl>
            </CardContent>
          </Card>
          {data.prs.length > 0 ? (
            <Section title="Pull requests">
              <ul className="space-y-1 text-sm">
                {data.prs.map((pr) => (
                  <li key={pr.url} className="flex flex-wrap items-center gap-2">
                    <a
                      href={pr.url}
                      target="_blank"
                      rel="noreferrer"
                      className="break-all hover:underline"
                    >
                      {pr.url}
                    </a>
                    <Badge variant="outline">{pr.state}</Badge>
                    {pr.second_opinions ? (
                      <>
                        <SecondOpinionBadges opinions={pr.second_opinions} />
                        <div className="basis-full">
                          <SecondOpinions opinions={pr.second_opinions} />
                        </div>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
          <Section
            title="Timeline"
            description={`${data.events.length}${cursor ? "+" : ""} events, oldest first.`}
          >
            <ol className="relative space-y-3 border-l pl-4">
              {data.events.map((event) => {
                const line = eventLine(event, blocked.has(event.id));
                return (
                  <li key={event.id} className="text-sm">
                    <span className="absolute -left-1 mt-1.5 size-2 rounded-full bg-foreground/40" />
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-muted-foreground text-xs tabular-nums">
                        {formatTime(event.ts)}
                      </span>
                      <span>{line.title}</span>
                    </div>
                    {line.detail ? (
                      <div className="break-all font-mono text-muted-foreground text-xs">
                        {line.detail}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
            {cursor ? (
              <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? "Loading..." : "Load more events"}
              </Button>
            ) : null}
          </Section>
        </>
      ) : null}
    </>
  );
}

function Fact({ name, value }: { name: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{name}</dt>
      <dd className="truncate" title={value}>
        {value}
      </dd>
    </div>
  );
}
