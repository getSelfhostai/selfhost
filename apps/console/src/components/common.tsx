import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { ApiRequestError } from "@/lib/api";
import { ViewLink } from "@/lib/console-context";
import { cn } from "@/lib/utils";
import type { View } from "@/lib/view";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <div className="min-w-0">
        <h1 className="font-semibold text-xl tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-muted-foreground text-sm">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** One number with its name, as a card; a link to its screen when `to` is given. */
export function Stat({
  title,
  value,
  detail,
  to,
  tone,
}: {
  title: string;
  value: string;
  detail?: ReactNode;
  to?: View;
  tone?: "attention";
}) {
  const body = (
    <Card
      className={cn(
        "h-full gap-1 py-4",
        to && "transition-colors hover:border-foreground/25",
        tone === "attention" && "border-amber-500/50",
      )}
    >
      <CardHeader className="px-4">
        <CardTitle className="font-normal text-muted-foreground text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-4">
        <div className="font-semibold text-2xl tabular-nums tracking-tight">{value}</div>
        {detail ? <div className="mt-0.5 text-muted-foreground text-xs">{detail}</div> : null}
      </CardContent>
    </Card>
  );
  if (!to) return body;
  return (
    <ViewLink to={to} className="block rounded-xl focus-visible:outline-2" aria-label={title}>
      {body}
    </ViewLink>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed px-4 py-10 text-center text-sm">
      <p className="font-medium">{title}</p>
      {children ? <div className="mt-1 text-muted-foreground">{children}</div> : null}
    </div>
  );
}

export function Failed({ error, what }: { error: ApiRequestError; what: string }) {
  return (
    <Card role="alert">
      <CardContent className="text-sm">
        <p className="font-medium">Could not load {what}.</p>
        <p className="text-muted-foreground">{error.message}</p>
      </CardContent>
    </Card>
  );
}

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => i).map((i) => (
        <Skeleton key={i} className="h-12 rounded-lg" />
      ))}
    </div>
  );
}

/** Says why a team screen shows nothing: there is no team to show. */
export function NoTeam() {
  return (
    <Empty title="No team on this server yet">
      Create one with <code className="text-foreground">selfhost team init</code>, then pick it at
      the top.
    </Empty>
  );
}

export function Section({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="font-medium text-base">{title}</h2>
          {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
