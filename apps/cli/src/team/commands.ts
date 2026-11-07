import type { PersonRole, TeamInfo } from "@selfhost/schema";
import type { Command } from "commander";
import { defaultPerson } from "../import.js";
import { type Fetch, serverUrl, TeamClient } from "./client.js";
import {
  clearMembership,
  readMembership,
  readSyncState,
  saveMembership,
  writableConfig,
} from "./config.js";

export interface TeamIo {
  env: NodeJS.ProcessEnv;
  write: (line: string) => void;
  configPath: string;
  fetch: Fetch;
}

/** `selfhost team init --json`. */
export interface TeamInitReport {
  schema: "selfhost.team_init/v1";
  server: string;
  team: TeamInfo;
  invite: string;
  join_command: string;
}

/** `selfhost join --json`. The token is saved, never printed. */
export interface JoinReport {
  schema: "selfhost.join/v1";
  server: string;
  team: TeamInfo;
  person: string;
  role: PersonRole;
  config: string;
}

/** `selfhost status --json`. */
export interface StatusReport {
  schema: "selfhost.status/v1";
  mode: "solo" | "team";
  config: string;
  server: string | null;
  team: string | null;
  person: string | null;
  last_sync: string | null;
  history_synced: boolean;
  policy_hash: string | null;
}

/** `selfhost team leave --json`. */
export interface LeaveReport {
  schema: "selfhost.team_leave/v1";
  mode: "solo";
  left: { server: string; team: string; person: string } | null;
}

interface JsonOption {
  json?: boolean;
}

const print = (io: TeamIo, json: boolean | undefined, report: object, lines: string[]) => {
  if (json) io.write(JSON.stringify(report, null, 2));
  else for (const line of lines) io.write(line);
};

/** Creates a team on the server with the admin token and prints the command to share. */
export async function teamInit(
  options: JsonOption & { server: string; name?: string; token?: string },
  io: TeamIo,
): Promise<TeamInitReport> {
  const server = serverUrl(options.server);
  const token = options.token ?? io.env.SELFHOST_TOKEN?.trim();
  if (!token)
    throw new Error("team init needs the server's admin token: pass --token or set SELFHOST_TOKEN");
  const { team, invite } = await new TeamClient(server, token, io.fetch).createTeam(
    options.name ?? "default",
  );
  const join = `selfhost join ${server} ${invite}`;
  const report: TeamInitReport = {
    schema: "selfhost.team_init/v1",
    server,
    team,
    invite,
    join_command: join,
  };
  print(io, options.json, report, [
    `Created team ${team.name} (${team.id}) on ${server}.`,
    "Share this with each teammate. Anyone holding the invite can join, so share it like a password:",
    `  ${join}`,
  ]);
  return report;
}

/**
 * Joins a team with an invite and saves the server, token, person and team in the config file.
 * A refused invite or an unreadable config file changes no files.
 */
export async function joinTeam(
  url: string,
  invite: string,
  options: JsonOption & { person?: string; name?: string },
  io: TeamIo,
): Promise<JoinReport> {
  const current = readMembership(io.configPath);
  if (current) {
    throw new Error(
      `Already in team ${current.team} on ${current.server} as ${current.person}. Run selfhost team leave first.`,
    );
  }
  writableConfig(io.configPath);
  const server = serverUrl(url);
  const person = options.person ?? defaultPerson(io.env);
  const joined = await new TeamClient(server, undefined, io.fetch).join(
    invite,
    person,
    options.name,
  );
  saveMembership(io.configPath, {
    server,
    token: joined.token,
    person: joined.person.id,
    team: joined.team.id,
  });
  const report: JoinReport = {
    schema: "selfhost.join/v1",
    server,
    team: joined.team,
    person: joined.person.id,
    role: joined.person.role,
    config: io.configPath,
  };
  print(io, options.json, report, [
    `Joined team ${joined.team.name} (${joined.team.id}) on ${server} as ${joined.person.id} (${joined.person.role}).`,
    "Your local ledger and selfhost.toml keep working as they are. The next selfhost import shares",
    "your local history and usage with the team and pulls the team policy.",
  ]);
  return report;
}

/** Solo or team, from local files only: status makes no network request. */
export function status(options: JsonOption, io: TeamIo): StatusReport {
  const membership = readMembership(io.configPath);
  const state = membership ? readSyncState(io.configPath, membership) : undefined;
  const report: StatusReport = {
    schema: "selfhost.status/v1",
    mode: membership ? "team" : "solo",
    config: io.configPath,
    server: membership?.server ?? null,
    team: membership?.team ?? null,
    person: membership?.person ?? null,
    last_sync: state?.last_sync ?? null,
    history_synced: state?.history_synced_at !== undefined,
    policy_hash: state?.policy_hash ?? null,
  };
  const lines = membership
    ? [
        `Team mode: team ${membership.team} on ${membership.server}, as ${membership.person}.`,
        `Last sync: ${report.last_sync ?? "never, run selfhost import"}.`,
        `Team policy: ${report.policy_hash ? report.policy_hash.slice(0, 12) : "none pulled yet"}.`,
      ]
    : ["Solo mode: everything stays on this machine."];
  print(io, options.json, report, lines);
  return report;
}

/** Back to solo mode. The local ledger is not touched. */
export function leaveTeam(options: JsonOption, io: TeamIo): LeaveReport {
  const left = clearMembership(io.configPath);
  const report: LeaveReport = {
    schema: "selfhost.team_leave/v1",
    mode: "solo",
    left: left ? { server: left.server, team: left.team, person: left.person } : null,
  };
  print(io, options.json, report, [
    left
      ? `Left team ${left.team} on ${left.server}. Back in solo mode; the local ledger is unchanged.`
      : "Not in a team: already in solo mode.",
  ]);
  return report;
}

export function registerTeam(
  program: Command,
  io: () => TeamIo,
  fail: (error: unknown, json: boolean | undefined) => void,
): void {
  const guard = async (json: boolean | undefined, fn: () => unknown) => {
    try {
      await fn();
    } catch (error) {
      fail(error, json);
    }
  };

  const team = program
    .command("team")
    .description("create a team on a selfhost server or leave one");

  team
    .command("init")
    .description("create a team on a selfhost server and print the invite to share")
    .requiredOption("--server <url>", "the selfhost server, like https://selfhost.example.com")
    .option("--name <team>", "team name", "default")
    .option("--token <token>", "the server's admin token (default: SELFHOST_TOKEN)")
    .option("--json", "print JSON")
    .action((options: Parameters<typeof teamInit>[0]) =>
      guard(options.json, () => teamInit(options, io())),
    );

  team
    .command("leave")
    .description("go back to solo mode; the local ledger stays as it is")
    .option("--json", "print JSON")
    .action((options: JsonOption) => guard(options.json, () => leaveTeam(options, io())));

  program
    .command("join")
    .description("join a team with an invite; usage and history then sync to the team server")
    .argument("<url>", "the team's selfhost server")
    .argument("<invite>", "invite code from selfhost team init")
    .option("--person <id>", "who you are on the team (default: git email)")
    .option("--name <name>", "display name")
    .option("--json", "print JSON")
    .action((url: string, invite: string, options: Parameters<typeof joinTeam>[2]) =>
      guard(options.json, () => joinTeam(url, invite, options, io())),
    );

  program
    .command("status")
    .description("show solo or team mode, the server, the person and the last sync")
    .option("--json", "print JSON")
    .action((options: JsonOption) => guard(options.json, () => status(options, io())));
}
