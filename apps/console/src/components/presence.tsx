import type { AgentVendor, PresenceResponse, PresenceRun } from "@selfhost/schema";
import { useEffect } from "react";
import { Failed, Section } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getOptional, query } from "@/lib/api";
import { RunLink, useConsole } from "@/lib/console-context";
import { ago, plural } from "@/lib/format";
import { useApi } from "@/lib/use-api";

/** How often the view is read again: presence is about right now. */
const REFRESH_MS = 30_000;
/** Files shown per run before "and N more". */
const FILES_SHOWN = 3;

const AGENT_NAMES: Record<AgentVendor, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  goose: "Goose",
  cursor: "Cursor",
  copilot: "Copilot",
  other: "Agent",
};

const OWNER_VIA: Record<NonNullable<PresenceRun["owner_via"]>, string> = {
  handoff: "handed over",
  named_agent: "owns the agent",
  person: "working in it",
  trigger: "started it",
  schedule: "owns the schedule",
  fallback: "review fallback",
};

interface Branch {
  name: string | null;
  runs: PresenceRun[];
}

interface Repo {
  name: string | null;
  branches: Branch[];
}

/** Runs by repo, then branch, in the order the server sorted them. */
export function groupPresence(runs: readonly PresenceRun[]): Repo[] {
  const repos: Repo[] = [];
  for (const run of runs) {
    let repo = repos.find((r) => r.name === run.repo);
    if (!repo) {
      repo = { name: run.repo, branches: [] };
      repos.push(repo);
    }
    let branch = repo.branches.find((b) => b.name === run.branch);
    if (!branch) {
      branch = { name: run.branch, runs: [] };
      repo.branches.push(branch);
    }
    branch.runs.push(run);
  }
  return repos;
}

/** Who is in the run: a named agent, else the person, else the agent session. */
const workerOf = (run: PresenceRun) =>
  run.named_agent ?? run.person ?? run.actor.name ?? run.actor.id;

/** People and named agents working right now, by repo and branch, with each run's owner. */
export function WorkingNow() {
  const { me, view, team, now } = useConsole();
  const scoped = view.filters.team ?? (me.kind === "person" ? team : undefined);
  const loaded = useApi<PresenceResponse | null>(`presence:${scoped ?? ""}`, (signal) =>
    getOptional<PresenceResponse>(`/v1/presence${query({ team: scoped })}`, signal),
  );
  const { reload } = loaded;
  useEffect(() => {
    const timer = setInterval(reload, REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload]);

  // A server from before presence answers 404: show nothing rather than an error.
  if (loaded.data === null) return null;
  const presence = loaded.data;
  // Times are relative to the answer, which is read again every REFRESH_MS.
  const at = presence ? new Date(presence.at) : now;
  const overlapped = new Set(presence?.overlaps.flatMap((o) => o.runs) ?? []);
  const people = new Set(presence?.runs.map(workerOf) ?? []);

  return (
    <Section
      title="Working now"
      description={
        presence
          ? `People and agents with activity in the last ${presence.idle_minutes} minutes, by repo and branch, and who owns each run.`
          : "People and agents active right now, by repo and branch, and who owns each run."
      }
    >
      {loaded.error ? <Failed error={loaded.error} what="who is working now" /> : null}
      {!presence ? (
        !loaded.error ? (
          <Skeleton className="h-24 rounded-xl" />
        ) : null
      ) : presence.runs.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nobody is working right now. Runs show up here from their first event until they end or go
          quiet for {presence.idle_minutes} minutes.
        </p>
      ) : (
        <div className="space-y-3">
          <p className="text-muted-foreground text-sm">
            {plural(people.size, "person or agent", "people and agents")} in{" "}
            {plural(presence.runs.length, "active run")}
            {presence.overlaps.length > 0
              ? `, ${plural(presence.overlaps.length, "file")} edited by more than one run`
              : ""}
            .
          </p>
          {presence.overlaps.length > 0 ? (
            <Card className="border-amber-500/50 py-0">
              <CardContent className="divide-y px-0">
                {presence.overlaps.map((overlap) => (
                  <div key={`${overlap.repo}:${overlap.file}`} className="px-4 py-3 text-sm">
                    <span className="font-medium">{overlap.file}</span>
                    <span className="text-muted-foreground">
                      {" "}
                      in {overlap.repo}: {plural(overlap.runs.length, "run")} editing it since{" "}
                      {ago(overlap.since, at)}. Owners warned:{" "}
                      {overlap.owners.join(", ") || "nobody"}.
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}
          {groupPresence(presence.runs).map((repo) => (
            <Card key={repo.name ?? ""} className="gap-0 py-0">
              <div className="border-b px-4 py-2 font-medium text-sm">
                {repo.name ?? "No repo recorded"}
              </div>
              <CardContent className="divide-y px-0">
                {repo.branches.map((branch) => (
                  <div key={branch.name ?? ""} className="px-4 py-2">
                    <div className="text-muted-foreground text-xs">
                      {branch.name ? `Branch ${branch.name}` : "Branch not known"}
                    </div>
                    {branch.runs.map((run) => (
                      <PresenceRow
                        key={run.id}
                        run={run}
                        now={at}
                        overlapping={overlapped.has(run.id)}
                      />
                    ))}
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </Section>
  );
}

function PresenceRow({
  run,
  now,
  overlapping,
}: {
  run: PresenceRun;
  now: Date;
  overlapping: boolean;
}) {
  const worker = workerOf(run);
  const more = run.files.length - FILES_SHOWN;
  return (
    <div className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2 text-sm">
      <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{worker}</span>
          {run.named_agent ? <Badge variant="outline">Named agent</Badge> : null}
          <span className="text-muted-foreground text-xs">
            {run.agent ? AGENT_NAMES[run.agent.vendor] : "Agent"}
            {" · "}
            {run.kind === "session" ? <RunLink id={run.id}>run</RunLink> : "background run"}
            {" · "}started {ago(run.started_at, now)}, last {ago(run.last_event_at, now)}
          </span>
        </div>
        {run.files.length > 0 ? (
          <div className="truncate text-muted-foreground text-xs">
            Editing {run.files.slice(0, FILES_SHOWN).join(", ")}
            {more > 0 ? ` and ${more} more` : ""}
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {overlapping ? <Badge className="bg-amber-500 text-white">Overlap</Badge> : null}
        <Badge variant="outline" title={run.owner_via ? OWNER_VIA[run.owner_via] : undefined}>
          {run.owner
            ? run.owner === worker
              ? `Owner ${run.owner}`
              : `Owner ${run.owner}${run.owner_via ? ` (${OWNER_VIA[run.owner_via]})` : ""}`
            : "No owner"}
        </Badge>
      </div>
    </div>
  );
}
