import type { DecisionResponse, ReviewAction, ReviewItem, ReviewItemsPage } from "@selfhost/schema";
import { Check, ExternalLink, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Empty, Failed, Loading, PageHeader } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { can } from "@/lib/access";
import { ApiRequestError, getJson, query, send } from "@/lib/api";
import { RunLink, useConsole } from "@/lib/console-context";
import type { ReviewItemLinks } from "@/lib/contracts";
import { agentName, ago, formatTime } from "@/lib/format";
import { REVIEW_KIND_NAMES } from "@/lib/labels";
import { useApi } from "@/lib/use-api";

const HOUR = 3_600_000;
const SNOOZES = [
  { value: "1h", label: "1 hour", ms: HOUR },
  { value: "4h", label: "4 hours", ms: 4 * HOUR },
  { value: "1d", label: "1 day", ms: 24 * HOUR },
  { value: "7d", label: "1 week", ms: 7 * 24 * HOUR },
] as const;

/** What a person can do with an item when the server does not list it. */
const DEFAULT_ACTIONS: ReviewAction[] = ["approve", "deny", "snooze"];

/** The admin token answers as "admin"; a person token always answers as its person. */
const by = (admin: boolean) => (admin ? { by: "admin" } : {});

export function riskLevel(score: number): { label: string; className: string } {
  if (score >= 70)
    return { label: "High risk", className: "border-red-500/40 text-red-700 dark:text-red-300" };
  if (score >= 40) {
    return {
      label: "Medium risk",
      className: "border-amber-500/40 text-amber-700 dark:text-amber-300",
    };
  }
  return { label: "Low risk", className: "text-muted-foreground" };
}

/** An exception request's rule, the call the rule blocked, and what the agent should do instead. */
export function exceptionParts(item: ReviewItem) {
  const [why = "", instead] = (item.why?.text ?? "").split(" Instead: ");
  return {
    rule: item.why?.rule_id,
    call: item.title.replace(/^Allow once: /, ""),
    why,
    instead: instead?.trim() || undefined,
  };
}

/** The review list query for the team on screen: every item with the admin token and no team. */
export function reviewQuery(state: string, team: string | undefined, limit = 100) {
  return `/v1/review-items${query({ state, team, limit })}`;
}

function External({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 hover:underline"
    >
      {children}
      <ExternalLink className="size-3" />
    </a>
  );
}

interface Outcome {
  id: string;
  text: string;
  failed?: boolean;
}

function ItemCard({
  item,
  canAct,
  admin,
  now,
  linked,
  onDone,
}: {
  item: ReviewItem;
  canAct: boolean;
  admin: boolean;
  now: Date;
  /** Opened from a notification's link: shown first in view and outlined. */
  linked: boolean;
  onDone: (outcome: Outcome, closed: boolean) => void;
}) {
  const [open, setOpen] = useState(item.kind === "exception");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const actions = item.state === "open" ? (item.actions ?? DEFAULT_ACTIONS) : [];
  const risk = riskLevel(item.risk.score);
  const run = item.run_id ?? item.session_id;
  const links = item as ReviewItem & ReviewItemLinks;

  const act = async (what: () => Promise<Outcome>) => {
    setBusy(true);
    try {
      onDone(await what(), true);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 409) {
        onDone({ id: item.id, text: `Not recorded: ${error.message}`, failed: true }, true);
      } else {
        onDone({ id: item.id, text: String((error as Error).message), failed: true }, false);
      }
    } finally {
      setBusy(false);
    }
  };

  const decide = (verdict: "approve" | "deny" | "answer") =>
    act(async () => {
      const body = { verdict, ...(reason.trim() ? { reason: reason.trim() } : {}), ...by(admin) };
      await send<DecisionResponse>("POST", `/v1/review-items/${item.id}/decision`, body);
      const done = verdict === "approve" ? "Approved" : verdict === "deny" ? "Denied" : "Answered";
      return { id: item.id, text: `${done}: ${item.title}. Recorded in the decision log.` };
    });

  const snooze = (value: string) => {
    const choice = SNOOZES.find((s) => s.value === value);
    if (!choice) return;
    return act(async () => {
      const until = new Date(now.getTime() + choice.ms).toISOString();
      await send<ReviewItem>("POST", `/v1/review-items/${item.id}/snooze`, { until, ...by(admin) });
      return { id: item.id, text: `Snoozed for ${choice.label}: ${item.title}.` };
    });
  };

  const exception = item.kind === "exception" ? exceptionParts(item) : undefined;

  return (
    <Card
      id={`item-${item.id}`}
      className={linked ? "gap-3 py-4 ring-2 ring-amber-500" : "gap-3 py-4"}
      data-testid="review-item"
    >
      <CardContent className="space-y-3 px-4">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <Badge variant="secondary">{REVIEW_KIND_NAMES[item.kind]}</Badge>
          {item.blocking && item.state === "open" ? (
            <Badge className="bg-amber-500 text-white">Agent waiting</Badge>
          ) : null}
          <Badge variant="outline" className={risk.className}>
            {risk.label} {item.risk.score}
          </Badge>
          {item.snoozed_until && Date.parse(item.snoozed_until) > now.getTime() ? (
            <Badge variant="outline">Snoozed until {formatTime(item.snoozed_until)}</Badge>
          ) : null}
        </div>
        <div>
          <button
            type="button"
            className="text-left font-medium hover:underline"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {item.title}
          </button>
          <p className="mt-0.5 text-muted-foreground text-xs">
            {[
              item.repo,
              item.agent ? agentName(item.agent.vendor) : undefined,
              ago(item.created_at, now),
              item.owners.length > 0 ? `for ${item.owners.join(", ")}` : "no owner",
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>

        {exception ? (
          <dl className="grid gap-x-4 gap-y-1 rounded-lg bg-muted/50 p-3 text-sm sm:grid-cols-[8rem_1fr]">
            <dt className="text-muted-foreground">Rule</dt>
            <dd className="font-mono text-xs leading-5">{exception.rule ?? "Unknown rule"}</dd>
            <dt className="text-muted-foreground">Blocked call</dt>
            <dd className="break-all font-mono text-xs leading-5">{exception.call}</dd>
            <dt className="text-muted-foreground">Instead</dt>
            <dd>{exception.instead ?? "The rule names no alternative."}</dd>
            <dt className="text-muted-foreground">Approving</dt>
            <dd>Allows this exact call once.</dd>
          </dl>
        ) : null}

        {open ? (
          <div className="space-y-2 text-sm">
            {item.why && !exception ? (
              <p>
                {item.why.text}
                {item.why.rule_id ? (
                  <span className="text-muted-foreground"> (rule {item.why.rule_id})</span>
                ) : null}
              </p>
            ) : null}
            {item.risk.reasons.length > 0 ? (
              <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
                {item.risk.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            ) : null}
            {item.brief ? (
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/50 p-3 font-sans text-sm">
                {item.brief}
              </pre>
            ) : null}
            {item.answer ? (
              <p className="text-muted-foreground">
                {item.answer.verdict} by {item.answer.by}, {formatTime(item.answer.at)}
                {item.answer.reason ? `: ${item.answer.reason}` : ""}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
              {run ? <RunLink id={run}>Open the run</RunLink> : null}
              {!run && links.run_url ? (
                <External href={links.run_url}>Open the run</External>
              ) : null}
              {links.trace_url ? (
                <External href={links.trace_url}>Open in your tracer</External>
              ) : null}
              {item.url ? (
                <a
                  href={item.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 hover:underline"
                >
                  {item.kind === "pr" ? "Open the pull request" : "Open"}
                  <ExternalLink className="size-3" />
                </a>
              ) : null}
            </div>
          </div>
        ) : null}

        {canAct && actions.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            {actions.includes("approve") ||
            actions.includes("deny") ||
            actions.includes("answer") ? (
              <Input
                className="h-8 w-full sm:w-64"
                placeholder={actions.includes("answer") ? "Your answer" : "Reason (optional)"}
                aria-label={actions.includes("answer") ? "Answer" : "Reason"}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            ) : null}
            {actions.includes("answer") ? (
              <Button size="sm" disabled={busy || !reason.trim()} onClick={() => decide("answer")}>
                Send answer
              </Button>
            ) : null}
            {actions.includes("approve") ? (
              <Button size="sm" disabled={busy} onClick={() => decide("approve")}>
                <Check />
                Approve
              </Button>
            ) : null}
            {actions.includes("deny") ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => decide("deny")}>
                <X />
                Deny
              </Button>
            ) : null}
            {actions.includes("snooze") ? (
              <Select value="" onValueChange={snooze} disabled={busy}>
                <SelectTrigger size="sm" className="w-auto" aria-label="Snooze">
                  <SelectValue placeholder="Snooze" />
                </SelectTrigger>
                <SelectContent>
                  {SNOOZES.map((choice) => (
                    <SelectItem key={choice.value} value={choice.value}>
                      Snooze {choice.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function ReviewScreen() {
  const { me, view, team, now } = useConsole();
  const [state, setState] = useState<"open" | "answered">("open");
  const [outcome, setOutcome] = useState<Outcome>();
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const scoped = view.filters.team ?? (me.kind === "person" ? team : undefined);
  const list = useApi(`review:${state}:${scoped ?? ""}`, (signal) =>
    getJson<ReviewItemsPage>(reviewQuery(state, scoped), signal),
  );
  const items = (list.data?.items ?? []).filter((item) => !closed.has(item.id));
  const blocking = items.filter((item) => item.blocking).length;
  const admin = me.kind === "admin";
  const canAct = can(me, scoped ?? team, "work");
  // A notification links to ?screen=review&item=<id>.
  const [linked] = useState(() => new URLSearchParams(window.location.search).get("item"));
  const found = linked !== null && items.some((item) => item.id === linked);
  useEffect(() => {
    if (found) document.getElementById(`item-${linked}`)?.scrollIntoView?.({ block: "center" });
  }, [found, linked]);

  const done = (next: Outcome, close: boolean) => {
    setOutcome(next);
    if (close) {
      setClosed((current) => new Set(current).add(next.id));
      if (next.failed) list.reload();
    }
  };

  return (
    <>
      <PageHeader
        title="Review list"
        description="Everything waiting on a person, agents blocked first, then by risk."
        actions={
          <Tabs value={state} onValueChange={(next) => setState(next as "open" | "answered")}>
            <TabsList>
              <TabsTrigger value="open">Waiting</TabsTrigger>
              <TabsTrigger value="answered">Answered</TabsTrigger>
            </TabsList>
          </Tabs>
        }
      />
      {outcome ? (
        <p
          role="status"
          className={outcome.failed ? "text-destructive text-sm" : "text-muted-foreground text-sm"}
        >
          {outcome.text}
        </p>
      ) : null}
      {list.error ? <Failed error={list.error} what="the review list" /> : null}
      {!list.data && !list.error ? <Loading /> : null}
      {list.data && items.length === 0 ? (
        <Empty
          title={state === "open" ? "Nothing is waiting on a person." : "Nothing answered yet."}
        >
          {state === "open"
            ? "Approvals, questions, blocked calls and risky pull requests show up here."
            : null}
        </Empty>
      ) : null}
      {items.length > 0 ? (
        <section aria-label="Review items" className="space-y-3">
          {state === "open" ? (
            <p className="text-muted-foreground text-sm">
              {items.length} waiting{blocking ? `, ${blocking} with an agent blocked` : ""}.
              {canAct ? "" : " You can read this list; answering needs a member of the team."}
            </p>
          ) : null}
          {items.map((item) => (
            <ItemCard
              key={item.id}
              item={item}
              canAct={canAct}
              admin={admin}
              now={now}
              linked={item.id === linked}
              onDone={done}
            />
          ))}
        </section>
      ) : null}
    </>
  );
}
