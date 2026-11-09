import type {
  PolicyCoverageResponse,
  PolicyObservedResponse,
  PolicyObservedRule,
  PolicyResponse,
  RuleAction,
  RuleCoverage,
  RuleMode,
} from "@selfhost/schema";
import { ShieldCheck } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Empty, Failed, Loading, NoTeam, PageHeader, Section } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { can } from "@/lib/access";
import { getJson, getOptional, query, send } from "@/lib/api";
import { useConsole } from "@/lib/console-context";
import { agentName, formatCount, plural } from "@/lib/format";
import { COVERAGE_VENDORS, GUARDRAILS, modeLabel } from "@/lib/labels";
import { useApi } from "@/lib/use-api";
import { cn } from "@/lib/utils";

/** The id the guardrails row goes by: one switch turns them all to blocking. */
export const GUARDRAILS_ROW = "guardrails";

interface Row {
  id: string;
  name: string;
  detail?: string;
  mode: RuleMode;
  action: RuleAction;
  /** Promoted through [teams.<team>.rules.<id>] instead of the rule itself. */
  override: boolean;
}

interface Loaded {
  policy: PolicyResponse | null;
  coverage: PolicyCoverageResponse | null;
  observed: PolicyObservedResponse | null;
}

/** Every rule of the team's policy with its mode and action after the team's overrides. */
export function ruleRows(policy: PolicyResponse, team: string): Row[] {
  const overrides = policy.config.teams?.[team]?.rules ?? {};
  return (policy.config.rules ?? []).map((rule) => {
    const override = overrides[rule.id];
    return {
      id: rule.id,
      name: rule.id,
      detail: rule.description ?? rule.message,
      mode: override?.mode ?? rule.mode ?? "observe",
      action: override?.action ?? rule.action,
      override: override?.mode !== undefined,
    };
  });
}

/** The guardrails' shared mode; a guardrail in disable is off. */
export function guardrailMode(policy: PolicyResponse, id: string): RuleMode {
  const guardrails = policy.config.guardrails;
  if (guardrails?.disable?.includes(id as never)) return "off";
  return guardrails?.mode ?? "enforce";
}

/** Whether the vendor can block the rule once it is enforced, natively or through the hook. */
export function enforceability(entry: RuleCoverage | undefined): {
  label: string;
  tone: "yes" | "partly" | "no" | "na";
} {
  if (!entry || entry.status === "not_applicable") return { label: "Does not apply", tone: "na" };
  if (entry.status === "compiled" || entry.hook !== "none")
    return { label: "Can block", tone: "yes" };
  if (entry.status === "partial") return { label: "Partly", tone: "partly" };
  return { label: "Cannot block", tone: "no" };
}

const TONES = {
  yes: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
  partly: "border-amber-500/40 text-amber-700 dark:text-amber-300",
  no: "border-red-500/40 text-red-700 dark:text-red-300",
  na: "text-muted-foreground",
} as const;

function ModeBadge({ mode, action }: { mode: RuleMode; action: RuleAction }) {
  return (
    <Badge
      variant={mode === "enforce" ? "default" : "outline"}
      className={cn(mode === "off" && "text-muted-foreground")}
    >
      {modeLabel(mode, action)}
    </Badge>
  );
}

/** What the rule did, or would have done, in the window. */
export function weekText(hits: PolicyObservedRule | undefined): string {
  if (!hits) return "Nothing in the last 7 days";
  const parts: string[] = [];
  if (hits.blocked) parts.push(`Blocked ${formatCount(hits.blocked)}`);
  if (hits.asked) parts.push(`Asked about ${formatCount(hits.asked)}`);
  if (hits.would_block) parts.push(`Would have blocked ${formatCount(hits.would_block)}`);
  if (hits.would_ask) parts.push(`Would have asked about ${formatCount(hits.would_ask)}`);
  if (parts.length === 0) return "Nothing in the last 7 days";
  return `${parts.join(", ")} in ${plural(hits.sessions, "session")}`;
}

function Coverage({ entries }: { entries: RuleCoverage[] }) {
  if (entries.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1" aria-label="Which agent tools can enforce it">
      {COVERAGE_VENDORS.map((vendor) => {
        const entry = entries.find((e) => e.vendor === vendor);
        const { label, tone } = enforceability(entry);
        return (
          <li key={vendor}>
            <Badge variant="outline" className={TONES[tone]} title={entry?.detail}>
              {agentName(vendor)}: {label}
            </Badge>
          </li>
        );
      })}
    </ul>
  );
}

function RuleCard({
  row,
  hits,
  coverage,
  action,
}: {
  row: Row;
  hits: PolicyObservedRule | undefined;
  coverage: RuleCoverage[];
  action?: ReactNode;
}) {
  return (
    <Card className="gap-2 py-4" data-testid="rule">
      <CardContent className="space-y-2 px-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium font-mono text-sm">{row.name}</span>
              <ModeBadge mode={row.mode} action={row.action} />
            </div>
            {row.detail ? (
              <p className="mt-0.5 text-muted-foreground text-sm">{row.detail}</p>
            ) : null}
          </div>
          {action}
        </div>
        <p className="text-sm">
          {weekText(hits)}
          {hits?.likely_false_positives ? (
            <span className="text-muted-foreground">
              {" "}
              ({plural(hits.likely_false_positives, "likely false positive")})
            </span>
          ) : null}
        </p>
        {hits && hits.examples.length > 0 ? (
          <ul className="space-y-0.5 text-muted-foreground text-xs">
            {hits.examples.map((example) => (
              <li key={`${example.tool}:${example.input}`} className="break-all font-mono">
                {example.tool}: {example.input ?? "no input recorded"} ({example.hits})
              </li>
            ))}
          </ul>
        ) : null}
        <Coverage entries={coverage} />
      </CardContent>
    </Card>
  );
}

/** One line per [[review.routes]] entry: what it matches, who gets it, when it escalates. */
export function routeRows(policy: PolicyResponse) {
  const review = policy.config.review;
  return (review?.routes ?? []).map((route) => {
    const match = [
      route.kinds ? `kind ${route.kinds.join(" or ")}` : undefined,
      route.repos ? `repo ${route.repos.join(", ")}` : undefined,
      route.paths ? `files ${route.paths.join(", ")}` : undefined,
      route.min_risk !== undefined ? `risk ${route.min_risk} or more` : undefined,
      route.rule_ids ? `rule ${route.rule_ids.join(", ")}` : undefined,
      route.tools ? `tool ${route.tools.join(", ")}` : undefined,
    ].filter((part): part is string => part !== undefined);
    return {
      id: route.id,
      description: route.description,
      match: match.length > 0 ? match.join("; ") : "every item",
      to: route.to.join(", "),
      escalate:
        route.escalate_after_minutes !== undefined
          ? `After ${route.escalate_after_minutes} minutes, the next matching route`
          : undefined,
    };
  });
}

/** [review.auto_approve] in words. */
export function autoApproveText(policy: PolicyResponse): string {
  const auto = policy.config.review?.auto_approve;
  if (!auto?.enabled) return "Off: every agent pull request waits for a person.";
  const how = auto.dry_run === false ? "On" : "Dry run (records only)";
  const paths = (auto.allowed_paths ?? ["docs/**", "**/*.md"]).join(", ");
  return `${how}: risk ${auto.max_risk ?? 20} or less, only ${paths}, ${auto.require_green_checks === false ? "checks not required" : "green checks"}, no guardrail hits.`;
}

function RoutingSection({ policy }: { policy: PolicyResponse }) {
  const rows = routeRows(policy);
  const fallback = policy.config.review?.fallback ?? [];
  return (
    <Section
      title="Review routing"
      description="Read only. Change [[review.routes]] and [review.auto_approve] in selfhost.toml; selfhost review routes explains where an item goes."
    >
      <div className="space-y-3">
        {rows.length === 0 ? (
          <Empty title="No [[review.routes]]: items go to their owner, team or fallback." />
        ) : (
          rows.map((row, index) => (
            <Card key={row.id} className="gap-2 py-4" data-testid="route">
              <CardContent className="space-y-1 px-4 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground">{index + 1}.</span>
                  <span className="font-medium font-mono">{row.id}</span>
                </div>
                {row.description ? (
                  <p className="text-muted-foreground">{row.description}</p>
                ) : null}
                <p>Matches {row.match}</p>
                <p>Goes to {row.to}</p>
                {row.escalate ? <p className="text-muted-foreground">{row.escalate}</p> : null}
              </CardContent>
            </Card>
          ))
        )}
        <p className="text-muted-foreground text-sm">
          Nothing matches: [review.owners], then the session's person, the team, then{" "}
          {fallback.length > 0 ? fallback.join(", ") : "nobody (every reader sees it)"}.
        </p>
        <p className="text-sm" data-testid="auto-approve">
          Auto-approve: {autoApproveText(policy)}
        </p>
      </div>
    </Section>
  );
}

export function RulesScreen() {
  const { me, team } = useConsole();
  const loaded = useApi<Loaded>(team ? `rules:${team}` : null, async (signal) => {
    const q = query({ team });
    const [policy, coverage, observed] = await Promise.all([
      getOptional<PolicyResponse>(`/v1/policy${q}`, signal),
      getOptional<PolicyCoverageResponse>(`/v1/policy/coverage${q}`, signal),
      getOptional<PolicyObservedResponse>(`/v1/policy/observed${q}`, signal),
    ]);
    return { policy, coverage, observed };
  });
  const [busy, setBusy] = useState<string>();
  const [confirming, setConfirming] = useState<string>();
  const [message, setMessage] = useState<{ text: string; failed?: boolean }>();

  if (!team) {
    return (
      <>
        <PageHeader title="Rules" />
        <NoTeam />
      </>
    );
  }
  const canWrite = can(me, team, "policy.write");
  const data = loaded.data;
  const policy = data?.policy;
  // One-click edits rewrite the team's own selfhost.toml, which the API returns as text only
  // when it is the one layer in use.
  const ownText = policy?.layers?.length === 1 && policy.layers[0]?.kind === "team";

  const promote = async (row: Row) => {
    setConfirming(undefined);
    setBusy(row.id);
    setMessage(undefined);
    try {
      const { promoteRule, setGuardrailsMode } = await import("@selfhost/policy/promote");
      const fresh = await getJson<PolicyResponse>(`/v1/policy${query({ team })}`);
      if (fresh.text === undefined) throw new Error("The server did not return the policy text.");
      const result =
        row.id === GUARDRAILS_ROW
          ? setGuardrailsMode(fresh.text)
          : promoteRule(fresh.text, row.id, row.override ? { team } : {});
      if (result.changed) {
        await send("PUT", `/v1/policy${query({ team })}`, { text: result.text });
        if (me.kind === "admin") {
          await send("POST", "/v1/decisions", {
            verdict: "approve",
            by: "admin",
            question: `Change rule ${row.id} from ${result.from} to enforce for team ${team}`,
            ...(row.id === GUARDRAILS_ROW ? {} : { rule_id: row.id }),
            surface: "rule_promotion",
          }).catch(() => undefined);
        }
      }
      const does = row.action === "ask" ? "asks a person first" : "blocks";
      setMessage({
        text: result.changed
          ? `${row.name} now ${does}. The team's selfhost.toml changed on line ${result.line}.`
          : `${row.name} already ${does}.`,
      });
      loaded.reload();
    } catch (error) {
      setMessage({ text: (error as Error).message, failed: true });
    } finally {
      setBusy(undefined);
    }
  };

  const startButton = (row: Row) => {
    if (!canWrite || row.mode !== "observe") return undefined;
    const asks = row.action === "ask";
    const start = asks ? "Start asking" : "Start blocking";
    if (confirming === row.id) {
      return (
        <fieldset className="flex flex-col items-end gap-2 text-right" aria-label={start}>
          <p className="max-w-xs text-muted-foreground text-xs">
            {asks
              ? `Every agent in team ${team} then waits for a person before a call ${row.name} matches.`
              : `Every agent in team ${team} is then stopped on the calls ${row.name} matches.`}{" "}
            This changes the team's selfhost.toml.
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setConfirming(undefined)}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => promote(row)}>
              <ShieldCheck />
              {asks ? "Yes, start asking" : "Yes, start blocking"}
            </Button>
          </div>
        </fieldset>
      );
    }
    return (
      <Button
        size="sm"
        disabled={!ownText || busy !== undefined}
        title={
          ownText
            ? undefined
            : "This team's rules sit on an org floor. Promote it in the team's selfhost.toml with selfhost policy promote."
        }
        onClick={() => setConfirming(row.id)}
      >
        <ShieldCheck />
        {busy === row.id ? "Saving..." : start}
      </Button>
    );
  };

  const rows = policy ? ruleRows(policy, team) : [];
  const hitsOf = (id: string) => data?.observed?.rules.find((rule) => rule.rule_id === id);
  const coverageOf = (id: string) =>
    data?.coverage?.coverage.rules.filter((rule) => rule.rule_id === id) ?? [];
  const guardMode = policy ? (policy.config.guardrails?.mode ?? "enforce") : "enforce";
  const guardRow: Row = {
    id: GUARDRAILS_ROW,
    name: "Guardrails",
    mode: guardMode,
    action: "block",
    override: false,
  };
  const recording = rows.filter((row) => row.mode === "observe").length;

  return (
    <>
      <PageHeader
        title="Rules"
        description={`Team ${team}. Rules start by recording what they would do, then block once you trust them.`}
      />
      {message ? (
        <p role="status" className={message.failed ? "text-destructive text-sm" : "text-sm"}>
          {message.text}
        </p>
      ) : null}
      {loaded.error ? <Failed error={loaded.error} what="the rules" /> : null}
      {!data && !loaded.error ? <Loading /> : null}
      {data && !policy ? (
        <Empty title="This team has no rules yet">
          Start a selfhost.toml with <code className="text-foreground">selfhost init</code> and
          store it for the team with <code className="text-foreground">PUT /v1/policy</code>.
        </Empty>
      ) : null}
      {policy ? (
        <>
          {!canWrite ? (
            <p className="text-muted-foreground text-sm">
              You can read these rules. Owners and admins of the team change them.
            </p>
          ) : !ownText && recording > 0 ? (
            <p className="text-muted-foreground text-sm">
              These rules build on your org's floor, so promote them in the team's selfhost.toml
              with <code className="text-foreground">selfhost policy promote</code>.
            </p>
          ) : null}
          {data?.observed === null ? (
            <p className="text-muted-foreground text-sm">
              This server does not report rule hits yet, so the last 7 days are not shown.
            </p>
          ) : null}
          <Section
            title="Rules"
            description={`${plural(rows.length, "rule")}, ${formatCount(recording)} recording only.`}
          >
            {rows.length === 0 ? (
              <Empty title="No [[rules]] in the team's selfhost.toml." />
            ) : (
              <div className="space-y-3">
                {rows.map((row) => (
                  <RuleCard
                    key={row.id}
                    row={row}
                    hits={hitsOf(row.id)}
                    coverage={coverageOf(row.id)}
                    action={startButton(row)}
                  />
                ))}
              </div>
            )}
          </Section>
          <Section
            title="Guardrails"
            description="Built in: the pre-tool hook checks them on top of the rules."
            actions={
              <div className="flex items-center gap-2">
                <ModeBadge mode={guardMode} action="block" />
                {startButton(guardRow)}
              </div>
            }
          >
            <div className="space-y-3">
              {GUARDRAILS.map((guard) => (
                <RuleCard
                  key={guard.id}
                  row={{
                    id: guard.id,
                    name: guard.id,
                    detail: guard.name,
                    mode: guardrailMode(policy, guard.id),
                    action: "block",
                    override: false,
                  }}
                  hits={hitsOf(guard.id)}
                  coverage={coverageOf(guard.id)}
                />
              ))}
            </div>
          </Section>
          <RoutingSection policy={policy} />
        </>
      ) : null}
    </>
  );
}
