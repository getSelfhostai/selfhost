import type {
  CreateInviteResponse,
  Person,
  PersonRole,
  TeamInvitesResponse,
  TeamPeopleResponse,
  TeamReposResponse,
} from "@selfhost/schema";
import { Copy, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Empty, Failed, Loading, NoTeam, PageHeader, Section } from "@/components/common";
import { Notifications } from "@/components/notifications";
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
import { can } from "@/lib/access";
import { getJson, send, teamPath } from "@/lib/api";
import { useConsole } from "@/lib/console-context";
import { formatTime } from "@/lib/format";
import { useApi } from "@/lib/use-api";

const ROLES: { value: PersonRole; label: string }[] = [
  { value: "owner", label: "Owner" },
  { value: "admin", label: "Admin" },
  { value: "member", label: "Member" },
];

const roleLabel = (role: PersonRole) => ROLES.find((r) => r.value === role)?.label ?? role;

const DAY = 86_400;

/** The line a person runs to join: this server's address and the invite. */
const joinLine = (invite: string) => `selfhost join ${window.location.origin} ${invite}`;
const LIFETIMES = [
  { value: String(DAY), label: "1 day" },
  { value: String(7 * DAY), label: "7 days" },
  { value: String(30 * DAY), label: "30 days" },
];

function Note({ text, failed }: { text?: string; failed?: boolean }) {
  if (!text) return null;
  return (
    <p
      role="status"
      className={failed ? "text-destructive text-sm" : "text-muted-foreground text-sm"}
    >
      {text}
    </p>
  );
}

function People({ team }: { team: string }) {
  const { me } = useConsole();
  const loaded = useApi(`people:${team}`, (signal) =>
    getJson<TeamPeopleResponse>(`${teamPath(team)}/people`, signal),
  );
  const [note, setNote] = useState<{ text: string; failed?: boolean }>();
  const canRoles = can(me, team, "roles");

  const setRole = async (person: Person, role: PersonRole) => {
    try {
      await send("PUT", `${teamPath(team)}/people/${encodeURIComponent(person.id)}/role`, { role });
      setNote({ text: `${person.name || person.id} is now ${roleLabel(role).toLowerCase()}.` });
      loaded.reload();
    } catch (error) {
      setNote({ text: (error as Error).message, failed: true });
    }
  };

  return (
    <Section title="People" description={canRoles ? "Owners change roles." : undefined}>
      <Note {...note} />
      {loaded.error ? <Failed error={loaded.error} what="the people" /> : null}
      {!loaded.data && !loaded.error ? <Loading rows={2} /> : null}
      {loaded.data ? (
        <Card className="py-0">
          <CardContent className="divide-y px-0">
            {loaded.data.people.map((person) => (
              <div
                key={person.id}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
                data-testid="person"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium text-sm">{person.name || person.id}</div>
                  {person.name ? (
                    <div className="truncate text-muted-foreground text-xs">{person.id}</div>
                  ) : null}
                </div>
                {canRoles ? (
                  <Select
                    value={person.role}
                    onValueChange={(role) => setRole(person, role as PersonRole)}
                  >
                    <SelectTrigger size="sm" className="w-32" aria-label={`Role of ${person.id}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ROLES.map((role) => (
                        <SelectItem key={role.value} value={role.value}>
                          {role.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Badge variant="outline">{roleLabel(person.role)}</Badge>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </Section>
  );
}

function Invites({ team }: { team: string }) {
  const loaded = useApi(`invites:${team}`, (signal) =>
    getJson<TeamInvitesResponse>(`${teamPath(team)}/invites`, signal),
  );
  const [email, setEmail] = useState("");
  const [ttl, setTtl] = useState(String(7 * DAY));
  const [created, setCreated] = useState<CreateInviteResponse>();
  const [note, setNote] = useState<{ text: string; failed?: boolean }>();

  const create = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const invite = await send<CreateInviteResponse>("POST", `${teamPath(team)}/invites`, {
        ttl_seconds: Number(ttl),
        ...(email.trim() ? { email: email.trim() } : {}),
      });
      setCreated(invite);
      setEmail("");
      setNote(undefined);
      loaded.reload();
    } catch (error) {
      setNote({ text: (error as Error).message, failed: true });
    }
  };

  const revoke = async (id: string) => {
    try {
      await send("DELETE", `/v1/invites/${id}`);
      if (created?.id === id) setCreated(undefined);
      setNote({ text: "Invite revoked. People who joined with it keep their access." });
      loaded.reload();
    } catch (error) {
      setNote({ text: (error as Error).message, failed: true });
    }
  };

  return (
    <Section title="Invites" description="Codes that let someone join this team.">
      <form onSubmit={create} className="flex flex-wrap items-center gap-2">
        <Input
          className="w-full sm:w-64"
          type="email"
          placeholder="Email (optional, for one person)"
          aria-label="Invite email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <Select value={ttl} onValueChange={setTtl}>
          <SelectTrigger className="w-32" aria-label="Invite works for">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LIFETIMES.map((choice) => (
              <SelectItem key={choice.value} value={choice.value}>
                {choice.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="submit" size="sm">
          Create invite
        </Button>
      </form>
      {created ? (
        <Card className="gap-2 border-amber-500/50 py-3" role="status">
          <CardContent className="space-y-2 px-4 text-sm">
            <p>
              Share this code{created.email ? ` with ${created.email}` : ""}. It is shown once, and
              anyone holding it can join until {formatTime(created.expires_at)}.
            </p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs">
                {joinLine(created.invite)}
              </code>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void navigator.clipboard?.writeText(joinLine(created.invite))}
              >
                <Copy />
                Copy
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              They run this line on their laptop, or <code>selfhost init --team</code> with it.
            </p>
          </CardContent>
        </Card>
      ) : null}
      <Note {...note} />
      {loaded.error ? <Failed error={loaded.error} what="the invites" /> : null}
      {loaded.data && loaded.data.invites.length === 0 ? (
        <p className="text-muted-foreground text-sm">No open invites.</p>
      ) : null}
      {loaded.data && loaded.data.invites.length > 0 ? (
        <ul className="divide-y rounded-xl border">
          {loaded.data.invites.map((invite) => (
            <li
              key={invite.id}
              className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm"
              data-testid="invite"
            >
              <span>
                {invite.email ?? "Anyone with the code"}
                <span className="text-muted-foreground">
                  {" "}
                  · works until {formatTime(invite.expires_at)}
                </span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => revoke(invite.id)}>
                <Trash2 />
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}

function Repos({ team }: { team: string }) {
  const { me } = useConsole();
  const loaded = useApi(`repos:${team}`, (signal) =>
    getJson<TeamReposResponse>(`${teamPath(team)}/repos`, signal),
  );
  const [remote, setRemote] = useState("");
  const [note, setNote] = useState<{ text: string; failed?: boolean }>();
  const canWrite = can(me, team, "settings.write");

  const add = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await send("POST", `${teamPath(team)}/repos`, { remote: remote.trim() });
      setRemote("");
      setNote(undefined);
      loaded.reload();
    } catch (error) {
      setNote({ text: (error as Error).message, failed: true });
    }
  };

  const remove = async (repo: string) => {
    try {
      await send("DELETE", `${teamPath(team)}/repos/${repo}`);
      setNote({
        text: `${repo} is no longer this team's. Events already written keep their team.`,
      });
      loaded.reload();
    } catch (error) {
      setNote({ text: (error as Error).message, failed: true });
    }
  };

  return (
    <Section title="Repos" description="Every agent run in these repos counts for this team.">
      {canWrite ? (
        <form onSubmit={add} className="flex flex-wrap items-center gap-2">
          <Input
            className="w-full sm:w-80"
            placeholder="https://github.com/acme/api.git or acme/api"
            aria-label="Repo remote"
            value={remote}
            onChange={(event) => setRemote(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={!remote.trim()}>
            Add repo
          </Button>
        </form>
      ) : null}
      <Note {...note} />
      {loaded.error ? <Failed error={loaded.error} what="the repos" /> : null}
      {loaded.data && loaded.data.repos.length === 0 ? (
        <Empty title="No repos mapped yet">
          Runs count for the team of the person who ran them.
        </Empty>
      ) : null}
      {loaded.data && loaded.data.repos.length > 0 ? (
        <ul className="divide-y rounded-xl border">
          {loaded.data.repos.map((repo) => (
            <li
              key={repo.repo}
              className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm"
              data-testid="repo"
            >
              <span className="min-w-0 truncate">
                {repo.repo}
                {repo.has_policy ? (
                  <Badge variant="outline" className="ml-2">
                    Own rules
                  </Badge>
                ) : null}
              </span>
              {canWrite ? (
                <Button size="sm" variant="ghost" onClick={() => remove(repo.repo)}>
                  <Trash2 />
                  Remove
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}

export function TeamScreen() {
  const { me, team } = useConsole();
  if (!team) {
    return (
      <>
        <PageHeader title="Team" />
        <NoTeam />
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="Team"
        description={
          can(me, team, "settings.write")
            ? `People, invites and repos of team ${team}.`
            : `People and repos of team ${team}. Owners and admins change them.`
        }
      />
      <People team={team} />
      {can(me, team, "invites") ? <Invites team={team} /> : null}
      <Repos team={team} />
      {me.kind === "person" ? <Notifications /> : null}
    </>
  );
}
