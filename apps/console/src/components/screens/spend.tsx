import type { BudgetResponse, SandboxWasteResponse } from "@selfhost/schema";
import { PageHeader } from "@/components/common";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { UsageView } from "@/components/usage-view";
import { getJson, getOptional, query, teamPath } from "@/lib/api";
import { useConsole } from "@/lib/console-context";
import type { RoiReport } from "@/lib/contracts";
import { agentName, formatCount, formatUsd } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import { rangeOf } from "@/lib/view";

function BudgetCard({ team }: { team: string }) {
  const { data, error } = useApi(`budget:${team}`, (signal) =>
    getJson<BudgetResponse>(`/v1/budget${query({ team, period: "month" })}`, signal),
  );
  return (
    <Card className="gap-2">
      <CardHeader>
        <CardTitle className="font-medium text-base">Budget this month</CardTitle>
        <CardDescription>Team {team}. Shown against spend; nothing is stopped.</CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        {error ? (
          <p className="text-muted-foreground">{error.message}</p>
        ) : !data ? (
          <Skeleton className="h-16" />
        ) : (
          <BudgetBody budget={data} />
        )}
      </CardContent>
    </Card>
  );
}

function BudgetBody({ budget }: { budget: BudgetResponse }) {
  const { spent_usd, limit_usd, remaining_usd, forecast_usd } = budget;
  const share = limit_usd ? Math.min(1, spent_usd / limit_usd) : 0;
  const spentOver = limit_usd !== null && spent_usd > limit_usd;
  const over =
    spentOver || (limit_usd !== null && forecast_usd !== null && forecast_usd > limit_usd);
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-semibold text-2xl tabular-nums">{formatUsd(spent_usd)}</span>
        <span className="text-muted-foreground">
          {limit_usd === null ? "No budget set" : `of ${formatUsd(limit_usd)}`}
        </span>
      </div>
      {limit_usd !== null ? (
        <div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
          <div
            className={over ? "h-full bg-amber-500" : "h-full bg-foreground/70"}
            style={{ width: `${share * 100}%` }}
          />
        </div>
      ) : null}
      <p className="text-muted-foreground">
        {limit_usd === null
          ? "Set [budget] monthly_usd in the team's selfhost.toml to track it here."
          : spentOver
            ? `${formatUsd(spent_usd - limit_usd)} over.`
            : `${formatUsd(remaining_usd ?? 0)} left.`}{" "}
        {forecast_usd === null
          ? "Too early in the month to forecast."
          : `On pace for ${formatUsd(forecast_usd)} by month end${over ? ", over budget" : ""}.`}
      </p>
    </div>
  );
}

function RoiCard({ team, from, to }: { team: string; from: string; to: string }) {
  const { data, error } = useApi(`roi:${team}:${from}:${to}`, (signal) =>
    getOptional<RoiReport>(`${teamPath(team)}/roi${query({ from, to })}`, signal),
  );
  return (
    <Card className="gap-2">
      <CardHeader>
        <CardTitle className="font-medium text-base">Cost per merged PR</CardTitle>
        <CardDescription>Agent spend over the pull requests it got merged.</CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        {error ? (
          <p className="text-muted-foreground">{error.message}</p>
        ) : data === undefined ? (
          <Skeleton className="h-16" />
        ) : data === null ? (
          <p className="text-muted-foreground">
            This server does not report cost per merged PR yet. It appears here once the server is
            updated.
          </p>
        ) : (
          <RoiBody roi={data} />
        )}
      </CardContent>
    </Card>
  );
}

function RoiBody({ roi }: { roi: RoiReport }) {
  const before = roi.baseline?.cost_per_merged_pr ?? null;
  const now = roi.cost_per_merged_pr;
  const change = before !== null && now !== null && before > 0 ? (now - before) / before : null;
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-semibold text-2xl tabular-nums">
          {now === null ? "No merges" : formatUsd(now)}
        </span>
        <span className="text-muted-foreground">
          {formatCount(roi.merged_prs)} merged, {formatUsd(roi.cost_usd)}
        </span>
      </div>
      {change !== null ? (
        <p className="text-muted-foreground">
          {change <= 0 ? "Down" : "Up"} {Math.abs(Math.round(change * 100))}% from{" "}
          {formatUsd(before ?? 0)} the period before.
        </p>
      ) : null}
      {roi.by_agent.length > 0 ? (
        <ul className="divide-y">
          {roi.by_agent.map((row) => (
            <li key={`${row.agent}:${row.model}`} className="flex justify-between gap-2 py-1">
              <span className="truncate">
                {agentName(row.agent)}
                {row.model ? <span className="text-muted-foreground"> {row.model}</span> : null}
              </span>
              <span className="tabular-nums">
                {row.cost_per_merged_pr === null ? "-" : formatUsd(row.cost_per_merged_pr)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const percentOf = (share: number) => `${Math.round(share * 100)}%`;

/**
 * Sandbox cost of the team's background runs: idle share per runtime, cheaper billing where most
 * of it is idle, and sandboxes left running after their run. Hidden when the server has no
 * report yet or the team has no sandboxes.
 */
function SandboxCard({ team }: { team: string }) {
  const { data } = useApi(`sandboxes:${team}`, (signal) =>
    getOptional<SandboxWasteResponse>(`${teamPath(team)}/sandboxes`, signal),
  );
  const week = data?.windows.find((window) => window.days === 7);
  const month = data?.windows.find((window) => window.days === 30);
  if (!data || !month || month.by_runtime.length === 0) return null;
  return (
    <Card className="gap-2 md:col-span-2">
      <CardHeader>
        <CardTitle className="font-medium text-base">Sandboxes</CardTitle>
        <CardDescription>
          What background runs' sandboxes cost. Idle is billed time with no command running, while
          the agent waits on the model.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <ul className="divide-y">
          {month.by_runtime.map((row) => {
            const recent = week?.by_runtime.find((entry) => entry.runtime === row.runtime);
            return (
              <li key={row.runtime} className="flex justify-between gap-2 py-1">
                <span>{row.runtime}</span>
                <span className="text-right tabular-nums">
                  {recent
                    ? `7 days ${formatUsd(recent.billed_usd)}, ${percentOf(recent.idle_share)} idle. `
                    : ""}
                  30 days {formatUsd(row.billed_usd)}, {percentOf(row.idle_share)} idle
                </span>
              </li>
            );
          })}
        </ul>
        {week?.by_runtime.flatMap((row) =>
          row.suggestion ? (
            <p key={`tip:${row.runtime}`} className="text-muted-foreground">
              {row.suggestion.text}
            </p>
          ) : (
            []
          ),
        )}
        {data.leftovers.length > 0 ? (
          <div className="space-y-1">
            <p className="font-medium">
              Left running more than {data.leftover_minutes} minutes after their run
            </p>
            <ul className="divide-y">
              {data.leftovers.map((left) => (
                <li key={left.sandbox_id} className="flex justify-between gap-2 py-1">
                  <span className="truncate">
                    {left.runtime} {left.sandbox_id}
                    <span className="text-muted-foreground">
                      {" "}
                      run {left.run_id ?? "unknown"}
                      {left.stopped_at === null ? ", still running" : ""}
                    </span>
                  </span>
                  <span className="tabular-nums">
                    {formatUsd(left.after_run_usd)} after {Math.round(left.minutes_after_run)} min
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function SpendScreen() {
  const { me, view, now, go } = useConsole();
  const team = view.filters.team ?? (me.kind === "person" ? me.team?.id : undefined);
  const range = rangeOf(view, now);
  return (
    <>
      <PageHeader
        title="Spend"
        description="Tokens, cost and pull requests by team, developer, agent and model."
      />
      {team ? (
        <div className="grid gap-3 md:grid-cols-2">
          <BudgetCard team={team} />
          <RoiCard team={team} from={range.from} to={range.to} />
          <SandboxCard team={team} />
        </div>
      ) : null}
      <UsageView me={me} view={view} onChange={go} now={now} />
    </>
  );
}
