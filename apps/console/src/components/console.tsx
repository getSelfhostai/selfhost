import type { MeResponse, OrgOverview } from "@selfhost/schema";
import { LogOut } from "lucide-react";
import { useMemo } from "react";
import { CodeScreen } from "@/components/screens/code";
import { IntegrationsScreen } from "@/components/screens/integrations";
import { OverviewScreen } from "@/components/screens/overview";
import { ReviewScreen } from "@/components/screens/review";
import { RulesScreen } from "@/components/screens/rules";
import { RunScreen } from "@/components/screens/run";
import { RunsScreen } from "@/components/screens/runs";
import { SpendScreen } from "@/components/screens/spend";
import { TeamScreen } from "@/components/screens/team";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { actorName, homeTeam } from "@/lib/access";
import { getJson } from "@/lib/api";
import { ConsoleProvider, type ConsoleState, screenView, ViewLink } from "@/lib/console-context";
import { useApi } from "@/lib/use-api";
import { cn } from "@/lib/utils";
import type { Screen, View } from "@/lib/view";

const NAV: { screen: Screen; name: string }[] = [
  { screen: "overview", name: "Overview" },
  { screen: "review", name: "Review list" },
  { screen: "runs", name: "Runs" },
  { screen: "rules", name: "Rules" },
  { screen: "spend", name: "Spend" },
  { screen: "code", name: "Code" },
  { screen: "integrations", name: "Integrations" },
  { screen: "team", name: "Team" },
];

const ALL = "__all__";

const TEAM_SCREENS = new Set<Screen>(["rules", "code", "integrations", "team"]);

/** The teams the caller can pick: their memberships, or every team of the org for the admin token. */
function useTeams(me: MeResponse, org: string) {
  const admin = me.kind === "admin";
  const { data } = useApi(admin ? `org:${org}` : null, (signal) =>
    getJson<OrgOverview>(`/v1/orgs/${encodeURIComponent(org)}/overview`, signal),
  );
  if (!admin) return (me.memberships ?? []).map((m) => m.team);
  return (data?.teams ?? []).map((t) => t.team.id);
}

function TeamPicker({
  teams,
  picked,
  allowAll,
  onPick,
}: {
  teams: string[];
  picked: string | undefined;
  allowAll: boolean;
  onPick: (team: string | undefined) => void;
}) {
  if (teams.length === 0 || (teams.length === 1 && !allowAll)) return null;
  return (
    <Select
      value={picked ?? ALL}
      onValueChange={(value) => onPick(value === ALL ? undefined : value)}
    >
      <SelectTrigger size="sm" className="w-auto min-w-36" aria-label="Team">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {allowAll ? <SelectItem value={ALL}>All teams</SelectItem> : null}
        {teams.map((team) => (
          <SelectItem key={team} value={team}>
            {team}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export interface ConsoleProps {
  me: MeResponse;
  view: View;
  onChange: (view: View) => void;
  onSignOut?: () => void;
  /** The clock, for tests. */
  now?: Date;
}

export function Console({ me, view, onChange, onSignOut, now: fixed }: ConsoleProps) {
  const now = useMemo(() => fixed ?? new Date(), [fixed]);
  const teams = useTeams(me, view.org ?? "default");
  const picked = view.filters.team;
  const team = picked ?? homeTeam(me) ?? teams[0];
  const state: ConsoleState = { me, view, now, team, teams, go: onChange };
  const screen = view.screen ?? "overview";
  const current = screen === "run" ? undefined : screen;
  // These screens are always about one team, so "All teams" is not offered there.
  const perTeam = TEAM_SCREENS.has(screen);

  const pick = (next: string | undefined) => {
    const filters = { ...view.filters };
    if (next === undefined) delete filters.team;
    else filters.team = next;
    onChange({ ...view, filters });
  };

  return (
    <ConsoleProvider value={state}>
      <div className="mx-auto max-w-7xl px-4 pb-10 sm:px-6">
        <header className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-5 pb-3">
          <ViewLink to={screenView(view, "overview")} className="font-semibold tracking-tight">
            selfhost
          </ViewLink>
          <TeamPicker
            teams={teams}
            picked={perTeam ? team : (picked ?? (me.kind === "admin" ? undefined : team))}
            allowAll={!perTeam && (me.kind === "admin" || teams.length > 1)}
            onPick={pick}
          />
          <div className="ml-auto flex items-center gap-2 text-muted-foreground text-sm">
            <span className="truncate">{actorName(me)}</span>
            {onSignOut ? (
              <Button variant="ghost" size="sm" onClick={onSignOut}>
                <LogOut />
                <span className="sr-only sm:not-sr-only">Sign out</span>
              </Button>
            ) : null}
          </div>
        </header>
        <nav
          aria-label="Console"
          className="-mx-4 mb-6 overflow-x-auto border-b px-4 [scrollbar-width:none] sm:mx-0 sm:px-0"
        >
          <ul className="flex min-w-max gap-1">
            {NAV.map((item) => (
              <li key={item.screen}>
                <ViewLink
                  to={screenView(view, item.screen)}
                  aria-current={current === item.screen ? "page" : undefined}
                  className={cn(
                    "-mb-px inline-block border-b-2 px-3 py-2 text-sm transition-colors",
                    current === item.screen
                      ? "border-foreground font-medium text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {item.name}
                </ViewLink>
              </li>
            ))}
          </ul>
        </nav>
        <main className="space-y-6">
          {screen === "overview" ? <OverviewScreen /> : null}
          {screen === "review" ? <ReviewScreen /> : null}
          {screen === "runs" ? <RunsScreen /> : null}
          {screen === "rules" ? <RulesScreen /> : null}
          {screen === "spend" ? <SpendScreen /> : null}
          {screen === "code" ? <CodeScreen /> : null}
          {screen === "run" ? <RunScreen /> : null}
          {screen === "integrations" ? <IntegrationsScreen /> : null}
          {screen === "team" ? <TeamScreen /> : null}
        </main>
      </div>
    </ConsoleProvider>
  );
}
