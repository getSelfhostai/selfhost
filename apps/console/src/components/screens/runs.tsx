import type { BackgroundAgent, BackgroundRun, BackgroundRunsResponse } from "@selfhost/schema";
import { Square } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Empty, Failed, Loading, PageHeader, Section } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getJson, query, send } from "@/lib/api";
import { useConsole } from "@/lib/console-context";
import { ago, formatUsd } from "@/lib/format";
import { useApi } from "@/lib/use-api";

/** How often the list is read again while a run is going. */
const REFRESH_MS = 15_000;

const FINAL: readonly BackgroundRun["state"][] = [
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "stuck",
];
const isFinalRunState = (state: BackgroundRun["state"]) => FINAL.includes(state);

const AGENT_NAMES: Record<BackgroundAgent, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  goose: "Goose",
};

const STATE_TONE: Partial<Record<BackgroundRun["state"], string>> = {
  failed: "border-destructive/50 text-destructive",
  stuck: "border-amber-500/50 text-amber-700 dark:text-amber-300",
  timed_out: "border-amber-500/50 text-amber-700 dark:text-amber-300",
  succeeded: "border-emerald-500/50 text-emerald-700 dark:text-emerald-300",
};

const stateLabel = (state: BackgroundRun["state"]) => state.replace("_", " ");

function StartRun({ team, onStarted }: { team: string; onStarted: () => void }) {
  const [task, setTask] = useState("");
  const [repo, setRepo] = useState("");
  const [agent, setAgent] = useState<BackgroundAgent>("claude");
  const [note, setNote] = useState<{ text: string; failed?: boolean }>();
  const [busy, setBusy] = useState(false);

  const start = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const run = await send<BackgroundRun>("POST", "/v1/background-runs", {
        task: task.trim(),
        repo: repo.trim(),
        agent,
        team,
        source: "console",
      });
      setTask("");
      setNote({ text: `Started run ${run.id} on branch ${run.branch}.` });
      onStarted();
    } catch (error) {
      setNote({ text: (error as Error).message, failed: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Start a run"
      description="The agent works in a sandbox on the team's runtime, under your own login, with the team's rules. It ends in one pull request."
    >
      <form onSubmit={start} className="flex flex-wrap items-center gap-2">
        <Input
          className="w-full sm:flex-1"
          placeholder="What should the agent do?"
          aria-label="Task"
          value={task}
          onChange={(event) => setTask(event.target.value)}
        />
        <Input
          className="w-full sm:w-48"
          placeholder="owner/name"
          aria-label="Repository"
          value={repo}
          onChange={(event) => setRepo(event.target.value)}
        />
        <Select value={agent} onValueChange={(value) => setAgent(value as BackgroundAgent)}>
          <SelectTrigger size="sm" className="w-36" aria-label="Agent">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(AGENT_NAMES) as BackgroundAgent[]).map((name) => (
              <SelectItem key={name} value={name}>
                {AGENT_NAMES[name]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="submit"
          size="sm"
          disabled={busy || !task.trim() || !/^[\w.-]+\/[\w.-]+$/.test(repo.trim())}
        >
          Start run
        </Button>
      </form>
      {note ? (
        <p
          role="status"
          className={note.failed ? "text-destructive text-sm" : "text-muted-foreground text-sm"}
        >
          {note.text}
        </p>
      ) : null}
    </Section>
  );
}

/**
 * Background runs: the start form for a person token, the kill switches in force, and every run
 * of the picked team (or the caller's teams) with its state, health line, live cost and pull
 * request. The list is read again every 15 seconds while a run is going.
 */
export function RunsScreen() {
  const { me, view, now, team } = useConsole();
  const picked = view.filters.team;
  const key = `background-runs:${picked ?? ""}`;
  const loaded = useApi(key, (signal) =>
    getJson<BackgroundRunsResponse>(
      `/v1/background-runs${query({ team: picked, limit: 50 })}`,
      signal,
    ),
  );
  const { data, reload } = loaded;
  const going = data?.runs.some((run) => !isFinalRunState(run.state)) ?? false;
  const [note, setNote] = useState<string>();

  useEffect(() => {
    if (!going) return;
    const timer = setInterval(reload, REFRESH_MS);
    return () => clearInterval(timer);
  }, [going, reload]);

  const cancel = async (run: BackgroundRun) => {
    try {
      const stopped = await send<BackgroundRun>(
        "POST",
        `/v1/background-runs/${encodeURIComponent(run.id)}/cancel`,
        {},
      );
      setNote(`Run ${stopped.id} is ${stateLabel(stopped.state)}.`);
      reload();
    } catch (error) {
      setNote((error as Error).message);
    }
  };

  return (
    <>
      <PageHeader
        title="Background runs"
        description={
          <>
            Agent CLIs working in sandboxes, started here, from <code>selfhost run</code>, GitHub,
            webhooks or a schedule. Follow one live with <code>selfhost tail --run &lt;id&gt;</code>
            .
          </>
        }
      />
      {me.kind === "person" && team ? <StartRun team={team} onStarted={reload} /> : null}
      {data?.kills.map((kill) => (
        <p
          key={`${kill.scope}:${kill.target}`}
          role="alert"
          className="rounded-xl border border-amber-500/50 px-4 py-2 text-sm"
        >
          The {kill.scope} kill switch for {kill.target} is on ({kill.by}, {ago(kill.at, now)}):
          runs are stopped and new ones refused. Clear it with{" "}
          <code>selfhost runs kill --clear</code>.
        </p>
      ))}
      {note ? (
        <p role="status" className="text-muted-foreground text-sm">
          {note}
        </p>
      ) : null}
      {loaded.error ? <Failed error={loaded.error} what="the runs" /> : null}
      {!data && !loaded.error ? <Loading /> : null}
      {data && data.runs.length === 0 ? (
        <Empty title="No background runs yet">
          Start one above, with <code>selfhost run "&lt;task&gt;"</code>, or comment{" "}
          <code>/selfhost run</code> on a GitHub issue.
        </Empty>
      ) : null}
      {data && data.runs.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Task</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Health</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead>Pull request</TableHead>
                <TableHead className="text-right">Started</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.runs.map((run) => (
                <TableRow key={run.id} data-testid="background-run">
                  <TableCell className="max-w-md">
                    <div className="truncate font-medium text-sm">{run.task.split("\n")[0]}</div>
                    <div className="text-muted-foreground text-xs">
                      {AGENT_NAMES[run.agent]} · {run.repo} ·{" "}
                      {run.person ?? `${run.trigger.source} ${run.trigger.sender}`}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={STATE_TONE[run.state]}>
                      {stateLabel(run.state)}
                    </Badge>
                    {run.reason ? (
                      <div
                        className="mt-1 max-w-xs truncate text-muted-foreground text-xs"
                        title={run.reason}
                      >
                        {run.reason}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-sm">
                    {run.health?.line ?? "-"}
                    {run.gate && run.gate.result !== "skipped" ? (
                      <div className="text-muted-foreground text-xs">
                        Tests first: {run.gate.result}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatUsd(run.cost.usd)}
                  </TableCell>
                  <TableCell className="text-sm">
                    {run.pr_url ? (
                      <a className="underline underline-offset-4" href={run.pr_url}>
                        {run.pr_url.replace(/^https:\/\/github\.com\//, "")}
                      </a>
                    ) : (
                      "-"
                    )}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground text-sm">
                    {ago(run.created_at, now)}
                  </TableCell>
                  <TableCell className="text-right">
                    {!isFinalRunState(run.state) ? (
                      <Button size="sm" variant="ghost" onClick={() => void cancel(run)}>
                        <Square />
                        Stop
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </>
  );
}
