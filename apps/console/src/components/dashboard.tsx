import type { MeResponse, UsageResponse } from "@selfhost/schema";
import { LogOut } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { BreakdownTable } from "@/components/breakdown-table";
import { FilterBar } from "@/components/filters";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiRequestError, downloadUsageCsv, getUsage } from "@/lib/api";
import { DIMENSION_NAMES, formatCompact, formatCount, formatUsd } from "@/lib/format";
import {
  BREAKDOWNS,
  type Breakdown,
  CHART_METRICS,
  type ChartMetric,
  rangeOf,
  usageQuery,
  type View,
} from "@/lib/view";

// The chart library is most of the bundle, so it loads beside the numbers, not before them.
const UsageChart = lazy(() =>
  import("@/components/usage-chart").then((module) => ({ default: module.UsageChart })),
);

interface Loaded {
  main: UsageResponse;
  series: UsageResponse;
  options: Partial<Record<Breakdown, string[]>>;
}

const METRIC_NAMES: Record<ChartMetric, string> = {
  usd: "Cost",
  tokens: "Tokens",
  sessions: "Sessions",
};

/** Loads the view's rows, its daily series and the filter values, again on every change. */
function useUsage(view: View, breakdown: Breakdown, now: Date) {
  const [state, setState] = useState<{ data?: Loaded; error?: ApiRequestError }>({});
  const key = JSON.stringify([view, breakdown]);
  useEffect(() => {
    const abort = new AbortController();
    const { signal } = abort;
    Promise.all([
      getUsage(usageQuery(view, now, [breakdown]), signal),
      getUsage(usageQuery(view, now, ["day", breakdown]), signal),
      ...BREAKDOWNS.map((name) => getUsage(usageQuery(view, now, [name], false), signal)),
    ])
      .then(([main, series, ...lists]) => {
        if (!main || !series) return;
        const options: Loaded["options"] = {};
        BREAKDOWNS.forEach((name, index) => {
          options[name] = (lists[index]?.rows ?? []).map((row) => row.group[name] ?? "unknown");
        });
        setState({ data: { main, series, options } });
      })
      .catch((error: unknown) => {
        if (signal.aborted) return;
        setState((current) => ({
          ...current,
          error: error instanceof ApiRequestError ? error : new ApiRequestError(0, String(error)),
        }));
      });
    return () => abort.abort();
  }, [key]);
  return state;
}

function Stat({ title, value, detail }: { title: string; value: string; detail?: string }) {
  return (
    <Card className="gap-1 py-4">
      <CardHeader className="px-4">
        <CardTitle className="font-normal text-muted-foreground text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-4">
        <div className="font-semibold text-2xl tabular-nums tracking-tight">{value}</div>
        {detail ? <div className="mt-0.5 text-muted-foreground text-xs">{detail}</div> : null}
      </CardContent>
    </Card>
  );
}

function who(me: MeResponse): string {
  if (me.kind === "admin") return "Admin token";
  const role = me.role ? ` (${me.role})` : "";
  return `${me.person?.name || me.person?.id || "Signed in"}${role}`;
}

export interface DashboardProps {
  me: MeResponse;
  view: View;
  onChange: (view: View) => void;
  onSignOut?: () => void;
}

export function Dashboard({ me, view, onChange, onSignOut }: DashboardProps) {
  const now = useMemo(() => new Date(), []);
  const range = rangeOf(view, now);
  // A person in one team has no cross-team view: no team filter or breakdown.
  const teams = me.kind === "admin" ? null : (me.memberships ?? []).map((m) => m.team);
  const dimensions = BREAKDOWNS.filter(
    (name) => name !== "team" || teams === null || teams.length > 1,
  );
  const breakdown =
    view.breakdown && dimensions.includes(view.breakdown)
      ? view.breakdown
      : dimensions.includes("team")
        ? "team"
        : "person";
  const { data, error } = useUsage(view, breakdown, now);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string>();

  const exportCsv = () => {
    setExporting(true);
    setExportError(undefined);
    downloadUsageCsv(usageQuery(view, now, [breakdown]))
      .catch((failure: unknown) => setExportError(String((failure as Error).message)))
      .finally(() => setExporting(false));
  };

  const total = data?.main.total;
  const perMerged =
    total && total.prs_merged > 0
      ? `${formatUsd(total.usd / total.prs_merged)} per merged PR`
      : undefined;
  const order = (data?.main.rows ?? []).map((row) => row.group[breakdown] ?? "unknown");
  const picked = view.filters[breakdown] !== undefined;

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-baseline gap-3">
          <span className="font-semibold tracking-tight">selfhost</span>
          <h1 className="text-muted-foreground">Usage and cost</h1>
        </div>
        <div className="ml-auto flex items-center gap-2 text-muted-foreground text-sm">
          <span>
            {who(me)}
            {data?.main.org && data.main.org !== "default" ? `, org ${data.main.org}` : ""}
          </span>
          {onSignOut ? (
            <Button variant="ghost" size="sm" onClick={onSignOut}>
              <LogOut />
              Sign out
            </Button>
          ) : null}
        </div>
      </header>

      <FilterBar
        view={view}
        options={data?.options ?? {}}
        dimensions={dimensions}
        days={{ first: range.days[0] ?? "", last: range.days.at(-1) ?? "" }}
        onChange={onChange}
        onExport={exportCsv}
        exporting={exporting}
      />
      {exportError ? <p className="text-destructive text-sm">{exportError}</p> : null}

      {error ? (
        <Card>
          <CardContent className="text-sm">
            <p className="font-medium">The server refused this view.</p>
            <p className="text-muted-foreground">{error.message}</p>
          </CardContent>
        </Card>
      ) : null}

      <section className="grid grid-cols-2 gap-3 md:grid-cols-5" aria-label="Totals">
        {total ? (
          <>
            <Stat
              title="Cost"
              value={formatUsd(total.usd)}
              detail={`${formatCount(total.requests)} requests`}
            />
            <Stat
              title="Tokens"
              value={formatCompact(total.tokens)}
              detail={`${formatCompact(total.cache_read_tokens)} from cache`}
            />
            <Stat title="Sessions" value={formatCount(total.sessions)} />
            <Stat title="PRs opened" value={formatCount(total.prs_opened)} />
            <Stat title="PRs merged" value={formatCount(total.prs_merged)} detail={perMerged} />
          </>
        ) : (
          Array.from({ length: 5 }, (_, i) => i).map((i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))
        )}
      </section>

      <Card className="gap-2">
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="font-medium text-base">
            {METRIC_NAMES[view.metric]} per day by {DIMENSION_NAMES[breakdown].one.toLowerCase()}
          </CardTitle>
          <Tabs
            value={view.metric}
            onValueChange={(metric) => onChange({ ...view, metric: metric as ChartMetric })}
          >
            <TabsList>
              {CHART_METRICS.map((metric) => (
                <TabsTrigger key={metric} value={metric}>
                  {METRIC_NAMES[metric]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </CardHeader>
        <CardContent>
          {data ? (
            <Suspense fallback={<Skeleton className="h-64" />}>
              <UsageChart
                rows={data.series.rows}
                days={range.days}
                breakdown={breakdown}
                metric={view.metric}
                order={order}
              />
            </Suspense>
          ) : (
            <Skeleton className="h-64" />
          )}
        </CardContent>
      </Card>

      <Card className="gap-3">
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <Tabs
            value={breakdown}
            onValueChange={(next) => onChange({ ...view, breakdown: next as Breakdown })}
          >
            <TabsList>
              {dimensions.map((name) => (
                <TabsTrigger key={name} value={name}>
                  {DIMENSION_NAMES[name].many}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </CardHeader>
        <CardContent>
          {!data || !total ? (
            <Skeleton className="h-40" />
          ) : data.main.rows.length === 0 ? (
            <div className="py-10 text-center text-muted-foreground text-sm">
              <p>
                No usage in this range{Object.keys(view.filters).length ? " for these filters" : ""}
                .
              </p>
              <p className="mt-1">
                Import local agent logs with{" "}
                <code className="text-foreground">selfhost import</code>, or send agents'
                OpenTelemetry to this server.
              </p>
            </div>
          ) : (
            <>
              <BreakdownTable
                breakdown={breakdown}
                rows={data.main.rows}
                total={total}
                {...(picked
                  ? {}
                  : {
                      onPick: (value: string) =>
                        onChange({ ...view, filters: { ...view.filters, [breakdown]: value } }),
                    })}
              />
              <p className="mt-3 text-muted-foreground text-xs">
                A session counts once in every row its events fall in, and once in the total. A
                session reported by two sources counts its spend from one.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
