import type { AdvisorRecommendation, AdvisorReport } from "@selfhost/schema";
import type { ReactNode } from "react";
import { Failed, Section } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getOptional, query } from "@/lib/api";
import { RunLink, screenView, useConsole, ViewLink } from "@/lib/console-context";
import { agentName, formatCacheHits, formatCount, formatShare, formatUsd } from "@/lib/format";
import { useApi } from "@/lib/use-api";

/**
 * The weekly advisor on the Overview: up to 3 changes to make, then one line per section, from
 * GET /v1/advisor. The same report is the Monday note people get through their targets.
 */
export function WeeklyAdvisor() {
  const { me, view, team } = useConsole();
  const scoped = view.filters.team ?? (me.kind === "person" ? team : undefined);
  const loaded = useApi<AdvisorReport | null>(`advisor:${scoped ?? ""}`, (signal) =>
    getOptional<AdvisorReport>(`/v1/advisor${query({ team: scoped })}`, signal),
  );

  // A server from before the advisor answers 404: show nothing rather than an error.
  if (loaded.data === null) return null;
  const report = loaded.data;

  return (
    <Section
      title="Weekly advisor"
      description={
        report?.scope === "self"
          ? "Your agents' last 7 days and what to change. Your team's owners and admins see the whole team."
          : "The last 7 days of agents and what to change, picked from the ledger by fixed rules. It also goes out as a weekly note."
      }
    >
      {loaded.error ? <Failed error={loaded.error} what="the weekly advisor" /> : null}
      {!report ? (
        !loaded.error ? (
          <Skeleton className="h-32 rounded-xl" />
        ) : null
      ) : (
        <div className="space-y-3">
          <Card className="py-0">
            <CardContent className="divide-y px-0">
              {report.recommendations.length === 0 ? (
                <p className="px-4 py-3 text-muted-foreground text-sm">
                  Nothing to change this week.
                </p>
              ) : (
                report.recommendations.map((rec, index) => (
                  <Recommendation key={rec.title} rec={rec} n={index + 1} />
                ))
              )}
            </CardContent>
          </Card>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <Line title="What shipped">
              {formatCount(report.shipped.merged)} agent PRs merged,{" "}
              {formatCount(report.shipped.opened)} opened
              {report.shipped.by[0]
                ? `; most from ${report.shipped.by[0].person} with ${agentName(report.shipped.by[0].agent)}`
                : ""}
            </Line>
            <Line title="What got blocked">
              {formatCount(report.blocked.blocked)} blocked, {formatCount(report.blocked.asked)}{" "}
              sent to a person
              {report.blocked.would_block + report.blocked.would_ask > 0
                ? `, ${formatCount(report.blocked.would_block + report.blocked.would_ask)} recorded only`
                : ""}
              {report.blocked.exceptions.requested > 0
                ? `; ${formatCount(report.blocked.exceptions.requested)} exceptions asked`
                : ""}
              {report.blocked.rules[0] ? (
                <>
                  {"; busiest "}
                  {report.blocked.rules[0].run ? (
                    <RunLink id={report.blocked.rules[0].run}>
                      {report.blocked.rules[0].rule_id}
                    </RunLink>
                  ) : (
                    report.blocked.rules[0].rule_id
                  )}
                </>
              ) : null}
            </Line>
            <Line title="Where money went">
              {formatUsd(report.spend.usd)} on models
              {report.spend.vendor_usd > 0
                ? ` (${formatUsd(report.spend.vendor_usd)} from vendor reports)`
                : ""}
              , {formatCacheHits(report.spend.cache_hit_rate)} cache hits
              {report.spend.sandbox
                ? `; sandboxes ${formatUsd(report.spend.sandbox.billed_usd)}, ${formatShare(report.spend.sandbox.idle_share)} idle`
                : ""}
            </Line>
            <Line title="Quality">
              {formatCount(report.quality.reverted)} reverted,{" "}
              {formatCount(report.quality.reworked)} reworked
              {report.quality.signals.length > 0
                ? `; ${formatCount(report.quality.signals.filter((s) => s.state === "open").length)} learned signals waiting`
                : ""}
              {report.quality.reverts[0]?.run ? (
                <>
                  {"; latest "}
                  <RunLink id={report.quality.reverts[0].run}>run</RunLink>
                </>
              ) : null}
            </Line>
            <Line title="Who worked where">
              {report.presence.work.length === 0
                ? "No sessions with a repository"
                : report.presence.work
                    .slice(0, 3)
                    .map((w) => `${w.person} in ${w.repos[0]?.repo ?? "?"}`)
                    .join(", ")}
              {report.presence.overlaps.length > 0
                ? `; ${formatCount(report.presence.overlaps.length)} files edited by two runs at once`
                : ""}
            </Line>
          </dl>
        </div>
      )}
    </Section>
  );
}

function Line({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <dt className="font-medium">{title}</dt>
      <dd className="text-muted-foreground">{children}</dd>
    </div>
  );
}

function Recommendation({ rec, n }: { rec: AdvisorRecommendation; n: number }) {
  const { view } = useConsole();
  return (
    <div className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3 text-sm">
      <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
        <ViewLink to={screenView(view, rec.screen)} className="font-medium hover:underline">
          {n}. {rec.title}
        </ViewLink>
        <div className="text-muted-foreground text-xs">
          {rec.why}
          {rec.run ? (
            <>
              {" "}
              <RunLink id={rec.run}>See the run.</RunLink>
            </>
          ) : null}
        </div>
      </div>
      {rec.saving_usd ? (
        <Badge variant="outline">Saves {formatUsd(rec.saving_usd)}/mo</Badge>
      ) : null}
    </div>
  );
}
