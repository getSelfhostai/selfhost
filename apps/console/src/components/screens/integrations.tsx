import { useState } from "react";
import { Empty, Failed, Loading, PageHeader } from "@/components/common";
import { NoTeamYet, SoloIntegrations } from "@/components/solo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { can } from "@/lib/access";
import { getOptional, query, send } from "@/lib/api";
import { useConsole } from "@/lib/console-context";
import {
  INTEGRATION_KINDS,
  type Integration,
  type IntegrationKind,
  type IntegrationStatus,
  type IntegrationsReport,
} from "@/lib/contracts";
import { INTEGRATION_NAMES, INTEGRATION_SETTINGS, INTEGRATION_TOOLS, toolName } from "@/lib/labels";
import { useApi } from "@/lib/use-api";

const STATUS: Record<IntegrationStatus, { label: string; className: string }> = {
  connected: {
    label: "Connected",
    className: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
  },
  not_configured: { label: "Not set up", className: "text-muted-foreground" },
  error: { label: "Error", className: "border-red-500/40 text-red-700 dark:text-red-300" },
};

const NONE = "__none__";

function Editor({
  kind,
  integration,
  team,
  onSaved,
  onCancel,
}: {
  kind: IntegrationKind;
  integration: Integration;
  team: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [tool, setTool] = useState(integration.tool ?? NONE);
  const [settings, setSettings] = useState<Record<string, unknown>>(integration.settings);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const clean = Object.fromEntries(
        Object.entries(settings).filter(([, value]) => value !== "" && value !== undefined),
      );
      await send("PUT", `/v1/integrations/${kind}${query({ team })}`, {
        tool: tool === NONE ? null : tool,
        settings: tool === NONE ? {} : clean,
      });
      onSaved();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 border-t pt-3">
      <Select value={tool} onValueChange={setTool}>
        <SelectTrigger className="w-full" aria-label={`${INTEGRATION_NAMES[kind].title} tool`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>None</SelectItem>
          {INTEGRATION_TOOLS[kind].map((option) => (
            <SelectItem key={option} value={option}>
              {toolName(option)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {tool !== NONE
        ? INTEGRATION_SETTINGS[kind].map((field) => (
            <div key={field.key} className="space-y-1 text-sm">
              <span className="text-muted-foreground">{field.label}</span>
              <Input
                aria-label={field.label}
                value={String(settings[field.key] ?? "")}
                onChange={(event) => setSettings({ ...settings, [field.key]: event.target.value })}
              />
            </div>
          ))
        : null}
      <p className="text-muted-foreground text-xs">
        Secrets are named by the environment variable that holds them on the server, never typed
        here.
      </p>
      {error ? <p className="text-destructive text-sm">{error}</p> : null}
      <div className="flex gap-2">
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? "Saving..." : "Save"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function IntegrationsScreen() {
  const { me, team } = useConsole();
  const [editing, setEditing] = useState<IntegrationKind>();
  const loaded = useApi(team ? `integrations:${team}` : null, (signal) =>
    getOptional<IntegrationsReport>(`/v1/integrations${query({ team })}`, signal),
  );

  if (!team) {
    return <NoTeamYet title="Integrations" render={(solo) => <SoloIntegrations solo={solo} />} />;
  }
  const canWrite = can(me, team, "settings.write");
  const data = loaded.data;
  return (
    <>
      <PageHeader
        title="Integrations"
        description="The tools this team picked for each job. selfhost connects them and keeps the record."
      />
      {loaded.error ? <Failed error={loaded.error} what="the integrations" /> : null}
      {data === undefined && !loaded.error ? <Loading rows={2} /> : null}
      {data === null ? (
        <Empty title="Integrations are not on this server yet">
          Once the server is updated, the router, tracer, runtime and reviewer the team picks in
          [integrations] show here with their status.
        </Empty>
      ) : null}
      {data ? (
        <div className="grid gap-3 md:grid-cols-2">
          {INTEGRATION_KINDS.map((kind) => {
            const integration = data.integrations[kind] ?? {
              tool: null,
              status: "not_configured",
              detail: "",
              settings: {},
            };
            const status = STATUS[integration.status] ?? STATUS.not_configured;
            return (
              <Card key={kind} className="gap-2" data-testid="integration">
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="font-medium text-base">
                      {INTEGRATION_NAMES[kind].title}
                    </CardTitle>
                    <Badge variant="outline" className={status.className}>
                      {status.label}
                    </Badge>
                  </div>
                  <CardDescription>{INTEGRATION_NAMES[kind].blurb}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <p className="font-medium">
                    {integration.tool ? toolName(integration.tool) : "None picked"}
                  </p>
                  {integration.detail ? (
                    <p className="text-muted-foreground">{integration.detail}</p>
                  ) : null}
                  {integration.source === "server_environment" ? (
                    <p className="text-muted-foreground" data-testid="integration-source">
                      Source: the server's environment. Picking a tool here gives this team its own.
                    </p>
                  ) : null}
                  {editing === kind ? (
                    <Editor
                      kind={kind}
                      integration={integration}
                      team={team}
                      onCancel={() => setEditing(undefined)}
                      onSaved={() => {
                        setEditing(undefined);
                        loaded.reload();
                      }}
                    />
                  ) : canWrite ? (
                    <Button size="sm" variant="outline" onClick={() => setEditing(kind)}>
                      {integration.tool ? "Change" : "Pick a tool"}
                    </Button>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : null}
    </>
  );
}
