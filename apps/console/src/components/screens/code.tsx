import type { ProvenanceReport, TeamProvenance, TeamProvenanceModules } from "@selfhost/schema";
import { Empty, Failed, Loading, PageHeader, Section } from "@/components/common";
import { NoTeamYet, SoloCode } from "@/components/solo";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getJson, query, teamPath } from "@/lib/api";
import { useConsole } from "@/lib/console-context";
import { agentName, formatCompact, formatCount, formatShare } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import { rangeOf } from "@/lib/view";

type Module = TeamProvenanceModules["modules"][number];

function RepoCard({ report }: { report: ProvenanceReport }) {
  const { totals } = report;
  const top = report.by_agent.filter((row) => row.vendor !== "unattributed").slice(0, 3);
  return (
    <Card className="gap-2 py-4" data-testid="repo">
      <CardContent className="space-y-3 px-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium">{report.repo ?? "Unknown repo"}</span>
          {report.status === "ledger_only" ? (
            <Badge variant="outline" title={report.note ?? undefined}>
              From pull requests only
            </Badge>
          ) : null}
        </div>
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">Written by agents</dt>
            <dd className="font-semibold text-lg tabular-nums">
              {formatShare(totals.agent_share)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Reverted or reworked</dt>
            <dd className="font-semibold text-lg tabular-nums">
              {formatShare(totals.agent_revert_rework_rate)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Lines merged</dt>
            <dd className="tabular-nums">
              {formatCompact(totals.agent_lines)} of {formatCompact(totals.lines)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Merges</dt>
            <dd className="tabular-nums">{formatCount(totals.landings)}</dd>
          </div>
        </dl>
        {top.length > 0 ? (
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground text-xs">
            {top.map((row) => (
              <li key={`${row.vendor}:${row.model}`}>
                {agentName(row.vendor)}
                {row.model ? ` ${row.model}` : ""}: {formatShare(row.share)} of lines
                {row.revert_rate === null
                  ? ""
                  : `, ${formatShare(row.revert_rate)} reverted, ${formatShare(row.rework_rate)} reworked`}
              </li>
            ))}
          </ul>
        ) : null}
        {report.status === "ledger_only" && report.note ? (
          <p className="text-muted-foreground text-xs">{report.note}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ModuleTable({ modules }: { modules: Module[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Module</TableHead>
            <TableHead className="text-right">Agent lines</TableHead>
            <TableHead className="text-right">Written by agents</TableHead>
            <TableHead className="text-right">Reverted or reworked</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {modules.map((row) => (
            <TableRow key={`${row.repo}:${row.module}`}>
              <TableCell>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs">{row.module}</span>
                  {row.above_threshold ? (
                    <Badge
                      variant="outline"
                      className="border-red-500/40 text-red-700 dark:text-red-300"
                    >
                      Flagged
                    </Badge>
                  ) : null}
                </div>
                <div className="text-muted-foreground text-xs">{row.repo}</div>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatCompact(row.agent_lines)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatShare(row.agent_share)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatShare(row.agent_revert_rework_rate)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function CodeScreen() {
  const { team, view, now } = useConsole();
  const range = rangeOf(view, now);
  const key = team ? `code:${team}:${range.from}:${range.to}` : null;
  const loaded = useApi(key, async (signal) => {
    const base = teamPath(team ?? "");
    const q = query({ from: range.from, to: range.to });
    const [repos, modules] = await Promise.all([
      getJson<TeamProvenance>(`${base}/provenance${q}`, signal),
      getJson<TeamProvenanceModules>(`${base}/provenance/modules${q}`, signal),
    ]);
    return { repos, modules };
  });

  if (!team) {
    return <NoTeamYet title="Code" render={(solo) => <SoloCode solo={solo} />} />;
  }
  const data = loaded.data;
  const flagged = data?.modules.modules.filter((row) => row.above_threshold) ?? [];
  return (
    <>
      <PageHeader
        title="Code"
        description={`How much of team ${team}'s merged code agents wrote, and how much of it was reverted or reworked soon after.`}
      />
      {loaded.error ? <Failed error={loaded.error} what="code provenance" /> : null}
      {!data && !loaded.error ? <Loading /> : null}
      {data ? (
        <>
          {flagged.length > 0 ? (
            <Section
              title="Flagged modules"
              description={`Agent code here is reverted or reworked more than ${formatShare(data.modules.threshold)} of the time. New pull requests that touch them score higher risk.`}
            >
              <ModuleTable modules={flagged} />
            </Section>
          ) : null}
          <Section title="Repos">
            {data.repos.repos.length === 0 ? (
              <Empty title="No repos mapped to this team">
                Add one on the Team screen, or with{" "}
                <code className="text-foreground">selfhost team repo add</code>.
              </Empty>
            ) : (
              <div className="space-y-3">
                {data.repos.repos.map((report) => (
                  <RepoCard key={report.repo ?? ""} report={report} />
                ))}
              </div>
            )}
          </Section>
          {data.modules.modules.length > 0 ? (
            <Section title="Modules" description="Most agent-written lines first.">
              <ModuleTable modules={data.modules.modules} />
            </Section>
          ) : null}
        </>
      ) : null}
    </>
  );
}
