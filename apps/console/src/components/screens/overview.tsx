import type {
  PolicyObservedResponse,
  ReviewItem,
  ReviewItemsPage,
  UsageResponse,
} from "@selfhost/schema";
import { Failed, PageHeader, Section, Stat } from "@/components/common";
import { reviewQuery, riskLevel } from "@/components/screens/review";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getJson, getOptional, query } from "@/lib/api";
import { RunLink, screenView, useConsole, ViewLink } from "@/lib/console-context";
import { ago, formatCount, formatUsd, plural } from "@/lib/format";
import { REVIEW_KIND_NAMES } from "@/lib/labels";
import { useApi } from "@/lib/use-api";
import { rangeOf } from "@/lib/view";

/** A pull request item at or above this risk counts as risky. */
export const RISKY_PR_SCORE = 70;

interface Week {
  usage: UsageResponse;
  review: ReviewItemsPage;
  observed: PolicyObservedResponse | null;
}

export function OverviewScreen() {
  const { me, view, team, now } = useConsole();
  const scoped = view.filters.team ?? (me.kind === "person" ? team : undefined);
  const week = rangeOf({ range: "7d", filters: {}, metric: "usd" }, now);
  const loaded = useApi<Week>(`overview:${scoped ?? ""}:${week.from}`, async (signal) => {
    const [usage, review, observed] = await Promise.all([
      getJson<UsageResponse>(
        `/v1/usage${query({ from: week.from, to: week.to, team: scoped, org: view.org })}`,
        signal,
      ),
      getJson<ReviewItemsPage>(reviewQuery("open", scoped, 1000), signal),
      scoped
        ? getOptional<PolicyObservedResponse>(
            `/v1/policy/observed${query({ team: scoped, from: week.from, to: week.to })}`,
            signal,
          )
        : Promise.resolve(null),
    ]);
    return { usage, review, observed };
  });

  const data = loaded.data;
  const total = data?.usage.total;
  const items = data?.review.items ?? [];
  const blocking = items.filter((item) => item.blocking).length;
  const risky = items.filter((item) => item.kind === "pr" && item.risk.score >= RISKY_PR_SCORE);
  const totals = data?.observed?.totals;
  const to = (screen: "review" | "rules" | "spend" | "code") => screenView(view, screen);

  return (
    <>
      <PageHeader
        title="This week"
        description={`What agents did in the last 7 days${scoped ? ` for team ${scoped}` : " across every team"}, and what needs a person.`}
      />
      {loaded.error ? <Failed error={loaded.error} what="this week" /> : null}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-3" aria-label="This week">
        {data && total ? (
          <>
            <Stat
              title="Waiting on a person"
              value={formatCount(items.length)}
              detail={
                blocking
                  ? `${plural(blocking, "agent")} blocked until someone answers`
                  : "No agent is blocked"
              }
              tone={blocking ? "attention" : undefined}
              to={to("review")}
            />
            <Stat
              title="Risky PRs"
              value={formatCount(risky.length)}
              detail={`Open agent PRs with risk ${RISKY_PR_SCORE} or more`}
              to={to("review")}
            />
            <Stat
              title="Blocks and asks from rules"
              value={totals ? formatCount(totals.blocked + totals.asked) : "-"}
              detail={
                !scoped
                  ? "Pick a team to see its rules"
                  : !totals
                    ? "Not reported by this server yet"
                    : totals.would_block + totals.would_ask > 0
                      ? `${formatCount(totals.would_block + totals.would_ask)} more from rules still recording only`
                      : `${formatCount(totals.blocked)} blocked, ${formatCount(totals.asked)} sent to a person`
              }
              to={to("rules")}
            />
            <Stat
              title="Agent sessions"
              value={formatCount(total.sessions)}
              detail={`${formatCount(total.requests)} model requests`}
              to={to("spend")}
            />
            <Stat
              title="Cost"
              value={formatUsd(total.usd)}
              detail={
                total.prs_merged > 0
                  ? `${formatUsd(total.usd / total.prs_merged)} per merged PR`
                  : "No PRs merged yet"
              }
              to={to("spend")}
            />
            <Stat
              title="PRs merged"
              value={formatCount(total.prs_merged)}
              detail={`${formatCount(total.prs_opened)} opened`}
              to={to("code")}
            />
          </>
        ) : !loaded.error ? (
          Array.from({ length: 6 }, (_, i) => i).map((i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))
        ) : null}
      </section>
      {data ? (
        <Section
          title="Needs a person"
          description="The top of the review list."
          actions={
            items.length > 5 ? (
              <ViewLink to={to("review")} className="text-sm hover:underline">
                See all {formatCount(items.length)}
              </ViewLink>
            ) : undefined
          }
        >
          {items.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Nothing is waiting. Agents are not blocked on anyone.
            </p>
          ) : (
            <Card className="py-0">
              <CardContent className="divide-y px-0">
                {items.slice(0, 5).map((item) => (
                  <AttentionRow key={item.id} item={item} now={now} />
                ))}
              </CardContent>
            </Card>
          )}
        </Section>
      ) : null}
    </>
  );
}

function AttentionRow({ item, now }: { item: ReviewItem; now: Date }) {
  const { view } = useConsole();
  const run = item.run_id ?? item.session_id;
  const risk = riskLevel(item.risk.score);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
      <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
        <ViewLink to={screenView(view, "review")} className="font-medium hover:underline">
          {item.title}
        </ViewLink>
        <div className="text-muted-foreground text-xs">
          {REVIEW_KIND_NAMES[item.kind]} · {ago(item.created_at, now)}
          {item.repo ? ` · ${item.repo}` : ""}
          {run ? (
            <>
              {" · "}
              <RunLink id={run}>run</RunLink>
            </>
          ) : null}
        </div>
      </div>
      <div className="flex gap-1">
        {item.blocking ? <Badge className="bg-amber-500 text-white">Agent waiting</Badge> : null}
        <Badge variant="outline" className={risk.className}>
          {risk.label}
        </Badge>
      </div>
    </div>
  );
}
