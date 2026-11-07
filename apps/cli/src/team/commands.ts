import {
  INVITE_TTL_MAX_SECONDS,
  INVITE_TTL_MIN_SECONDS,
  type PersonRole,
  type TeamInfo,
} from "@selfhost/schema";
import type { Command } from "commander";
import { plural } from "../format.js";
import { defaultPerson } from "../import.js";
import { type Fetch, serverUrl, TeamApiError, TeamClient } from "./client.js";
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
  invite_expires_at: string;
  join_command: string;
}

/** `selfhost team invite --json`. */
export interface TeamInviteReport {
  schema: "selfhost.team_invite/v1";
  server: string;
  team: string;
  invite: string;
  /** sha256 of the invite code, the id the server knows it by. */
  id: string;
  /** The one person who can join with it, or null when anyone holding it can. */
  email: string | null;
  expires_at: string;
  join_command: string;
}

/** `selfhost team revoke --json`. One of invite and person is set. */
export interface TeamRevokeReport {
  schema: "selfhost.team_revoke/v1";
  server: string;
  team: string;
  /** Id of the revoked invite (the sha256 of its code). */
  invite: string | null;
  /** The person whose tokens were revoked. */
  person: string | null;
  /** Tokens and open invites of the person revoked by this call; null for an invite. */
  revoked: number | null;
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
  /** Whether the server revoked this machine's person token; null when not in a team. */
  token_revoked: boolean | null;
  /** Why the token could not be revoked. Membership was still removed from this machine. */
  error?: string;
}

interface JsonOption {
  json?: boolean;
}

interface AdminOptions extends JsonOption {
  server?: string;
  team?: string;
  token?: string;
}

const print = (io: TeamIo, json: boolean | undefined, report: object, lines: string[]) => {
  if (json) io.write(JSON.stringify(report, null, 2));
  else for (const line of lines) io.write(line);
};

const DURATION_UNITS: Record<string, number> = { m: 60, h: 3600, d: 86_400 };

/** Seconds in a duration like 30m, 12h or 7d, within what the server accepts for an invite. */
export function parseTtl(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d+)([mhd])$/.exec(value.trim());
  const seconds = match ? Number(match[1]) * (DURATION_UNITS[match[2] ?? ""] ?? 0) : Number.NaN;
  if (!(seconds >= INVITE_TTL_MIN_SECONDS && seconds <= INVITE_TTL_MAX_SECONDS)) {
    throw new Error(
      `${flag}: expected a duration from 1m to 365d, like 7d, 12h or 30m, got "${value}"`,
    );
  }
  return seconds;
}

const SHELL_SAFE = /^[\w@%+=:,./-]+$/;
const shellWord = (word: string) =>
  SHELL_SAFE.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

function joinCommand(server: string, invite: string, email?: string): string {
  const person = email === undefined ? "" : ` --person ${shellWord(email)}`;
  return `selfhost join ${server} ${invite}${person}`;
}

const shortTime = (iso: string) => iso.replace("T", " ").replace(/:\d{2}\.\d{3}Z$/, " UTC");

function adminToken(options: AdminOptions, io: TeamIo, command: string): string {
  const token = options.token ?? io.env.SELFHOST_TOKEN?.trim();
  if (!token) {
    throw new Error(
      `${command} needs the server's admin token: pass --token or set SELFHOST_TOKEN`,
    );
  }
  return token;
}

/** The server and team an admin command acts on: the flags, else this machine's membership. */
function adminTarget(options: AdminOptions, io: TeamIo, command: string) {
  const membership = readMembership(io.configPath);
  const url = options.server ?? membership?.server;
  if (!url) {
    throw new Error(`${command} needs the team server: pass --server <url>`);
  }
  const server = serverUrl(url);
  const client = new TeamClient(server, adminToken(options, io, command), io.fetch);
  const team = options.team ?? (membership?.server === server ? membership.team : undefined);
  return { server, client, team };
}

/** Creates a team on the server with the admin token and prints the command to share. */
export async function teamInit(
  options: JsonOption & { server: string; name?: string; token?: string; inviteTtl?: string },
  io: TeamIo,
): Promise<TeamInitReport> {
  const server = serverUrl(options.server);
  const token = adminToken(options, io, "team init");
  const ttl = parseTtl(options.inviteTtl, "--invite-ttl");
  const created = await new TeamClient(server, token, io.fetch).createTeam(
    options.name ?? "default",
    ttl,
  );
  const { team, invite } = created;
  const join = joinCommand(server, invite);
  const report: TeamInitReport = {
    schema: "selfhost.team_init/v1",
    server,
    team,
    invite,
    invite_expires_at: created.invite_expires_at,
    join_command: join,
  };
  print(io, options.json, report, [
    `Created team ${team.name} (${team.id}) on ${server}.`,
    `Share this with each teammate until ${shortTime(created.invite_expires_at)}, when the invite expires.`,
    "Anyone holding the invite can join until then, so share it like a password:",
    `  ${join}`,
  ]);
  return report;
}

/** Creates another invite for a team, optionally for one person's email. Admin token only. */
export async function teamInvite(
  options: AdminOptions & { email?: string; ttl?: string },
  io: TeamIo,
): Promise<TeamInviteReport> {
  const ttl = parseTtl(options.ttl, "--ttl");
  const { server, client, team } = adminTarget(options, io, "team invite");
  if (!team) throw new Error("team invite needs the team: pass --team <id>");
  const email = options.email?.trim();
  const created = await client.createInvite(team, {
    ...(ttl === undefined ? {} : { ttl_seconds: ttl }),
    ...(email ? { email } : {}),
  });
  const join = joinCommand(server, created.invite, created.email);
  const report: TeamInviteReport = {
    schema: "selfhost.team_invite/v1",
    server,
    team: created.team,
    invite: created.invite,
    id: created.id,
    email: created.email ?? null,
    expires_at: created.expires_at,
    join_command: join,
  };
  const until = shortTime(created.expires_at);
  print(io, options.json, report, [
    created.email
      ? `Created an invite to team ${created.team} on ${server} for ${created.email}, until ${until}.`
      : `Created an invite to team ${created.team} on ${server}, until ${until}.`,
    created.email
      ? `Only ${created.email} can join with it. Send them:`
      : "Anyone holding it can join until then, so share it like a password:",
    `  ${join}`,
    `Revoke it early with: selfhost team revoke ${created.invite}`,
  ]);
  return report;
}

const INVITE_PREFIX = "selfhost_inv_";

/**
 * Revokes an invite (given as its code) or every token a person holds (given as their id).
 * Admin token only. The person's events stay in the ledger.
 */
export async function teamRevoke(
  target: string,
  options: AdminOptions,
  io: TeamIo,
): Promise<TeamRevokeReport> {
  const { server, client, team } = adminTarget(options, io, "team revoke");
  if (target.startsWith(INVITE_PREFIX)) {
    const invite = await client.revokeInvite(target);
    const report: TeamRevokeReport = {
      schema: "selfhost.team_revoke/v1",
      server,
      team: invite.team,
      invite: invite.id,
      person: null,
      revoked: null,
    };
    print(io, options.json, report, [
      `Revoked the invite to team ${invite.team} on ${server}. Joining with it now fails; people who already joined keep their tokens.`,
    ]);
    return report;
  }
  if (!team) throw new Error("team revoke needs the team of the person: pass --team <id>");
  const person = target.trim();
  const { revoked } = await client.revokePerson(team, person);
  const report: TeamRevokeReport = {
    schema: "selfhost.team_revoke/v1",
    server,
    team,
    invite: null,
    person,
    revoked,
  };
  print(io, options.json, report, [
    revoked > 0
      ? `Revoked ${person}'s access to team ${team} on ${server} (${plural(revoked, "token")}, counting open invites for their email). Their events stay in the ledger.`
      : `${person} has nothing left to revoke in team ${team} on ${server}.`,
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

/**
 * Back to solo mode: revokes this machine's person token on the server, then removes the
 * membership. When the server cannot revoke it, the membership is removed anyway and the
 * report says the token still works there. The local ledger is not touched.
 */
export async function leaveTeam(options: JsonOption, io: TeamIo): Promise<LeaveReport> {
  const membership = readMembership(io.configPath);
  let revoked: boolean | null = null;
  let error: string | undefined;
  if (membership) {
    try {
      await new TeamClient(membership.server, membership.token, io.fetch).revokeOwnToken();
      revoked = true;
    } catch (failure) {
      // 401: the server no longer accepts the token, so there is nothing left to revoke.
      revoked = failure instanceof TeamApiError && failure.status === 401;
      if (!revoked) error = failure instanceof Error ? failure.message : String(failure);
    }
  }
  const left = clearMembership(io.configPath);
  const report: LeaveReport = {
    schema: "selfhost.team_leave/v1",
    mode: "solo",
    left: left ? { server: left.server, team: left.team, person: left.person } : null,
    token_revoked: revoked,
    ...(error === undefined ? {} : { error }),
  };
  const lines = !left
    ? ["Not in a team: already in solo mode."]
    : revoked
      ? [
          `Left team ${left.team} on ${left.server} and revoked this machine's token there.`,
          "Back in solo mode; the local ledger is unchanged.",
        ]
      : [
          `Left team ${left.team} on this machine only: the server did not revoke its token (${error}).`,
          `The token keeps working on ${left.server} until a team admin runs: selfhost team revoke ${shellWord(left.person)}`,
          "Back in solo mode; the local ledger is unchanged.",
        ];
  print(io, options.json, report, lines);
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
    .description("create a team on a selfhost server, invite to it, revoke access or leave it");

  team
    .command("init")
    .description("create a team on a selfhost server and print the invite to share")
    .requiredOption("--server <url>", "the selfhost server, like https://selfhost.example.com")
    .option("--name <team>", "team name", "default")
    .option(
      "--invite-ttl <duration>",
      "how long the invite works, like 7d, 12h or 30m (default: 7d)",
    )
    .option("--token <token>", "the server's admin token (default: SELFHOST_TOKEN)")
    .option("--json", "print JSON")
    .action((options: Parameters<typeof teamInit>[0]) =>
      guard(options.json, () => teamInit(options, io())),
    );

  const adminOptions = (command: Command) =>
    command
      .option("--server <url>", "the selfhost server (default: the one this machine joined)")
      .option("--team <id>", "team id (default: the one this machine joined)")
      .option("--token <token>", "the server's admin token (default: SELFHOST_TOKEN)")
      .option("--json", "print JSON");

  adminOptions(
    team
      .command("invite")
      .description("create another invite to a team, optionally for one person")
      .option("--email <email>", "only this person can join with it, and joins as this email")
      .option("--ttl <duration>", "how long the invite works, like 7d, 12h or 30m (default: 7d)"),
  ).action((options: Parameters<typeof teamInvite>[0]) =>
    guard(options.json, () => teamInvite(options, io())),
  );

  adminOptions(
    team
      .command("revoke")
      .description("revoke an invite, or every token a person holds; their events stay")
      .argument("<invite-or-person>", "an invite code, or a person id such as their git email"),
  ).action((target: string, options: AdminOptions) =>
    guard(options.json, () => teamRevoke(target, options, io())),
  );

  team
    .command("leave")
    .description(
      "revoke this machine's team token and go back to solo mode; the local ledger stays",
    )
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
