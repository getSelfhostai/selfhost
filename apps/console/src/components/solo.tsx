import type { RuleAction, RuleMode } from "@selfhost/schema";
import type { ReactNode } from "react";
import { Empty, Loading, NoTeam, PageHeader, Section } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { SoloResponse } from "@/lib/contracts";
import { plural } from "@/lib/format";
import { GUARDRAILS, INTEGRATION_NAMES, modeLabel, toolName } from "@/lib/labels";
import { useSolo } from "@/lib/solo";

type Solo = SoloResponse;
type ValidPolicy = Extract<NonNullable<Solo["policy"]>, { valid: true }>;

const Code = ({ children }: { children: ReactNode }) => (
  <code className="text-foreground">{children}</code>
);

/**
 * A team screen with no team: in solo mode, what this laptop has instead (`render`); on a team
 * server, the empty state that says to create a team.
 */
export function NoTeamYet({
  title,
  description,
  render,
}: {
  title: string;
  description?: string;
  render: (solo: Solo) => ReactNode;
}) {
  const solo = useSolo();
  if (solo === undefined) {
    return (
      <>
        <PageHeader title={title} />
        <Loading rows={2} />
      </>
    );
  }
  if (solo === null) {
    return (
      <>
        <PageHeader title={title} />
        <NoTeam />
      </>
    );
  }
  return (
    <>
      <PageHeader title={title} description={description} />
      {render(solo)}
    </>
  );
}

/** Says where the laptop's selfhost.toml is, or that there is none or it is invalid. */
function PolicyState({ solo, children }: { solo: Solo; children: (p: ValidPolicy) => ReactNode }) {
  const policy = solo.policy;
  if (policy === null) {
    return (
      <Empty title="No selfhost.toml where the console started">
        Start one in the repository with <Code>selfhost init</Code>, then run{" "}
        <Code>selfhost console</Code> there.
      </Empty>
    );
  }
  if (!policy.valid) {
    return (
      <Empty title={`${policy.path} is invalid`}>
        {policy.errors.map((error) => `${error.field}: ${error.message}`).join("; ")}. Run{" "}
        <Code>selfhost doctor</Code> for the lines.
      </Empty>
    );
  }
  return <>{children(policy)}</>;
}

const ModeBadge = ({ mode, action }: { mode: string; action: string }) => (
  <Badge variant={mode === "enforce" ? "default" : "outline"}>
    {modeLabel(mode as RuleMode, action as RuleAction)}
  </Badge>
);

/** The laptop's own rules, read-only: changing them is an edit of selfhost.toml. */
export function SoloRules({ solo }: { solo: Solo }) {
  return (
    <PolicyState solo={solo}>
      {(policy) => (
        <>
          <p className="text-muted-foreground text-sm">
            The rules in <Code>{policy.path}</Code>, read-only. Change them in the file, or turn one
            on with <Code>selfhost policy promote &lt;rule&gt;</Code>.
          </p>
          <Section title="Rules" description={plural(policy.rules.length, "rule")}>
            {policy.rules.length === 0 ? (
              <Empty title="No [[rules]] in selfhost.toml." />
            ) : (
              <div className="space-y-3">
                {policy.rules.map((rule) => (
                  <Card key={rule.id} className="gap-2 py-4" data-testid="rule">
                    <CardContent className="space-y-1 px-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium font-mono text-sm">{rule.id}</span>
                        <ModeBadge mode={rule.mode ?? "observe"} action={rule.action} />
                      </div>
                      <p className="text-muted-foreground text-sm">{rule.message}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </Section>
          <Section
            title="Guardrails"
            description="Built in: the pre-tool hook checks them on top of the rules."
            actions={<ModeBadge mode={policy.guardrails.mode} action="block" />}
          >
            <ul className="space-y-1 text-sm">
              {GUARDRAILS.map((guard) => (
                <li key={guard.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">{guard.id}</span>
                  <span className="text-muted-foreground">{guard.name}</span>
                  {policy.guardrails.disable.includes(guard.id) ? (
                    <Badge variant="outline">Off</Badge>
                  ) : null}
                </li>
              ))}
            </ul>
          </Section>
        </>
      )}
    </PolicyState>
  );
}

/** The laptop's [integrations], read-only. */
export function SoloIntegrations({ solo }: { solo: Solo }) {
  return (
    <PolicyState solo={solo}>
      {(policy) => (
        <>
          <p className="text-muted-foreground text-sm">
            [integrations] in <Code>{policy.path}</Code>, read-only. Change them in the file.
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            {(Object.keys(INTEGRATION_NAMES) as (keyof typeof INTEGRATION_NAMES)[]).map((kind) => {
              const tool = policy.integrations[kind]?.tool;
              return (
                <Card key={kind} className="gap-2" data-testid="integration">
                  <CardHeader>
                    <CardTitle className="font-medium text-base">
                      {INTEGRATION_NAMES[kind].title}
                    </CardTitle>
                    <CardDescription>{INTEGRATION_NAMES[kind].blurb}</CardDescription>
                  </CardHeader>
                  <CardContent className="text-sm">
                    <p className="font-medium">{tool ? toolName(tool) : "None picked"}</p>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </>
      )}
    </PolicyState>
  );
}

/** You are solo: how to add people. */
export function SoloTeam({ solo }: { solo: Solo }) {
  return (
    <Empty title="You are solo">
      This console reads this laptop's own ledger. To add people, run <Code>{solo.team_init}</Code>:
      it starts a team on a server and prints the invite others join with.
    </Empty>
  );
}

/** Code provenance is kept per team. */
export function SoloCode({ solo }: { solo: Solo }) {
  return (
    <Empty title="Code provenance is kept per team">
      On this laptop, <Code>selfhost provenance</Code> in a repository shows how much of its code
      agents wrote. To see it here for your repos, start a team with <Code>{solo.team_init}</Code>.
    </Empty>
  );
}
