import {
  INVITE_TTL_MAX_SECONDS,
  INVITE_TTL_MIN_SECONDS,
  PERSON_ROLES,
  type Person,
  type PersonRole,
  type TeamInfo,
  type TeamRepo,
} from "@selfhost/schema";
import type { Command } from "commander";
import { pullContext } from "../context/layers.js";
import { plural } from "../format.js";
import { type PersonFrom, personSource } from "../import.js";
import { describeManaged } from "../policy/managed.js";
import { deploymentToken, latestDeployment } from "../up/record.js";
import { type Fetch, serverUrl, TeamApiError, TeamClient } from "./client.js";
import {
  clearMembership,
  pinExceptionKeys,
  readMembership,
  readSyncState,
  saveMembership,
  writableConfig,
  writeSyncState,
} from "./config.js";
import { type LaptopIo, type LaptopReport, reportLaptop } from "./laptop.js";
import { registerTeamPolicy } from "./policy.js";
import { pullPolicy } from "./sync.js";

export interface TeamIo {
  env: NodeJS.ProcessEnv;
  write: (line: string) => void;
  configPath: string;
  fetch: Fetch;
  /** Where `team policy push` looks for selfhost.toml. Default: the process's folder. */
  cwd?: string;
  /** Whether stdin is a terminal; `team policy push` refuses without one. */
  stdinIsTTY?: boolean;
  /** Join installs the managed settings and sends a heartbeat; without it, neither. */
  laptop?: LaptopIo;
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

/** `selfhost team role --json`. */
export interface TeamRoleReport {
  schema: "selfhost.team_role/v1";
  server: string;
  team: string;
  person: string;
  role: PersonRole;
}

/** `selfhost team add --json`. */
export interface TeamAddReport {
  schema: "selfhost.team_add/v1";
  server: string;
  team: string;
  person: string;
  role: PersonRole;
}

/** `selfhost team people --json`. */
export interface TeamPeopleReport {
  schema: "selfhost.team_people/v1";
  server: string;
  team: string;
  people: Person[];
}

/** `selfhost team repo add|remove|list --json`: the team's repos after the command. */
export interface TeamReposReport {
  schema: "selfhost.team_repos/v1";
  server: string;
  team: string;
  repos: TeamRepo[];
}

/** `selfhost join --json`. The token is saved, never printed. */
export interface JoinReport {
  schema: "selfhost.join/v1";
  server: string;
  team: TeamInfo;
  person: string;
  /**
   * Where the person id came from when --person was not given: SELFHOST_PERSON, git
   * user.email or, with neither, the OS user name. Null with --person, or when the invite named
   * the person.
   */
  person_from: PersonFrom | null;
  role: PersonRole;
  config: string;
  /** The org and team context layers pulled on joining, or null when they could not be. */
  context: { hash: string; layers: { kind: "org" | "team"; name: string; files: number }[] } | null;
  /** Why the context layers were not pulled; the next sync pulls them. */
  context_error?: string;
  /** Why the server's exception keys were not pinned; the next sync pins them. */
  exception_keys_error?: string;
  /** sha256 of the team policy pulled on joining, null when the team has none yet. */
  policy_hash?: string | null;
  /** Why the team policy was not pulled; the next sync pulls it. */
  policy_error?: string;
  /** The team policy's managed settings on this laptop, and the first heartbeat. */
  laptop?: LaptopReport;
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
  /** Admin commands the team's managed settings still need here, as the last sync found them. */
  managed_commands: string[];
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

export interface JsonOption {
  json?: boolean;
}

export interface AdminOptions extends JsonOption {
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

/** --token, else SELFHOST_TOKEN, else the token `selfhost up` saved when it set up the server. */
function adminToken(options: AdminOptions, io: TeamIo, server: string): string | undefined {
  return (
    options.token ??
    (io.env.SELFHOST_TOKEN?.trim() || undefined) ??
    deploymentToken(io.configPath, server)
  );
}

/**
 * The server, team and token a team command acts with: the flags, else this machine's
 * membership. The token is the admin token when there is one, else this machine's person token,
 * whose role in the team the server checks.
 */
export function teamTarget(options: AdminOptions, io: TeamIo, command: string) {
  const membership = readMembership(io.configPath);
  const url = options.server ?? membership?.server;
  if (!url) {
    throw new Error(`${command} needs the team server: pass --server <url>`);
  }
  const server = serverUrl(url);
  const own = membership?.server === server ? membership : undefined;
  const token = adminToken(options, io, server) ?? own?.token;
  if (!token) {
    throw new Error(
      `${command} needs the server's admin token (pass --token or set SELFHOST_TOKEN), or run it on a machine that joined the team as an owner or admin`,
    );
  }
  const client = new TeamClient(server, token, io.fetch);
  const team = options.team ?? own?.team;
  return { server, client, team };
}

export function needTeam(team: string | undefined, command: string): string {
  if (!team) throw new Error(`${command} needs the team: pass --team <id>`);
  return team;
}

/**
 * Creates a team on the server with the admin token and prints the command to share. The server
 * is --server, else the one `selfhost up` saved last.
 */
export async function teamInit(
  options: JsonOption & { server?: string; name?: string; token?: string; inviteTtl?: string },
  io: TeamIo,
): Promise<TeamInitReport> {
  const url = options.server ?? latestDeployment(io.configPath)?.server;
  if (!url) {
    throw new Error(
      "team init needs the team server: pass --server <url>, or set one up first with selfhost up",
    );
  }
  const server = serverUrl(url);
  const token = adminToken(options, io, server);
  if (!token) {
    throw new Error("team init needs the server's admin token: pass --token or set SELFHOST_TOKEN");
  }
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

/**
 * Creates another invite for a team, optionally for one person's email. The admin token, or an
 * owner or admin of the team.
 */
export async function teamInvite(
  options: AdminOptions & { email?: string; ttl?: string },
  io: TeamIo,
): Promise<TeamInviteReport> {
  const ttl = parseTtl(options.ttl, "--ttl");
  const { server, client, team: target } = teamTarget(options, io, "team invite");
  const team = needTeam(target, "team invite");
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
 * Revokes an invite (given as its code) or every token a person holds (given as their id). The
 * admin token, or an owner or admin of the team; only an owner revokes an owner. The person's
 * events stay in the ledger.
 */
export async function teamRevoke(
  target: string,
  options: AdminOptions,
  io: TeamIo,
): Promise<TeamRevokeReport> {
  const { server, client, team } = teamTarget(options, io, "team revoke");
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

const A_ROLE: Record<PersonRole, string> = {
  owner: "an owner",
  admin: "an admin",
  member: "a member",
};

function checkRole(role: string): PersonRole {
  if (!(PERSON_ROLES as readonly string[]).includes(role)) {
    throw new Error(`role: expected one of ${PERSON_ROLES.join(", ")}, got "${role}"`);
  }
  return role as PersonRole;
}

/** Changes a person's role in the team. Only owners can; a team always keeps an owner. */
export async function teamRole(
  person: string,
  role: string,
  options: AdminOptions,
  io: TeamIo,
): Promise<TeamRoleReport> {
  const wanted = checkRole(role);
  const { server, client, team: target } = teamTarget(options, io, "team role");
  const team = needTeam(target, "team role");
  const changed = await client.setRole(team, person.trim(), wanted);
  const report: TeamRoleReport = {
    schema: "selfhost.team_role/v1",
    server,
    team,
    person: changed.id,
    role: changed.role,
  };
  print(io, options.json, report, [
    `${changed.id} is now ${A_ROLE[changed.role]} of team ${team} on ${server}.`,
  ]);
  return report;
}

/** Adds someone already in another team of the org to this team. */
export async function teamAdd(
  person: string,
  options: AdminOptions & { role?: string },
  io: TeamIo,
): Promise<TeamAddReport> {
  const role = options.role === undefined ? undefined : checkRole(options.role);
  const { server, client, team: target } = teamTarget(options, io, "team add");
  const team = needTeam(target, "team add");
  const added = await client.addPerson(team, person.trim(), role);
  const report: TeamAddReport = {
    schema: "selfhost.team_add/v1",
    server,
    team,
    person: added.id,
    role: added.role,
  };
  print(io, options.json, report, [
    `Added ${added.id} to team ${team} on ${server} as ${A_ROLE[added.role]}. The tokens they hold already work in it.`,
  ]);
  return report;
}

/** Everyone in the team and their role. */
export async function teamPeople(options: AdminOptions, io: TeamIo): Promise<TeamPeopleReport> {
  const { server, client, team: target } = teamTarget(options, io, "team people");
  const team = needTeam(target, "team people");
  const { people } = await client.people(team);
  const report: TeamPeopleReport = { schema: "selfhost.team_people/v1", server, team, people };
  print(io, options.json, report, [
    `Team ${team} on ${server}: ${people.length === 1 ? "1 person" : `${people.length} people`}.`,
    ...people.map((p) => `  ${p.role.padEnd(6)}  ${p.id}${p.name ? ` (${p.name})` : ""}`),
  ]);
  return report;
}

/** Maps a repo to the team by its remote URL, unmaps one, or lists them. */
export async function teamRepo(
  action: "add" | "remove" | "list",
  remote: string | undefined,
  options: AdminOptions,
  io: TeamIo,
): Promise<TeamReposReport> {
  const { server, client, team: target } = teamTarget(options, io, `team repo ${action}`);
  const team = needTeam(target, `team repo ${action}`);
  if (action !== "list" && !remote) {
    throw new Error(`team repo ${action} needs the repo: a remote URL or owner/name`);
  }
  let line: string | undefined;
  let changed: string | undefined;
  if (action === "add") {
    const added = await client.addRepo(team, remote ?? "");
    changed = added.repo;
    line = `Team ${team} on ${server} owns ${added.repo} (${added.remote}): every run in it is the team's.`;
  } else if (action === "remove") {
    await client.removeRepo(team, (remote ?? "").toLowerCase());
    changed = (remote ?? "").toLowerCase();
    line = `Team ${team} on ${server} no longer owns ${remote}.`;
  }
  const { repos } = await client.repos(team);
  const report: TeamReposReport = { schema: "selfhost.team_repos/v1", server, team, repos };
  // After an add or a remove, the rest of the list only when there is a rest.
  const others = repos.filter((r) => r.repo.toLowerCase() !== changed).map((r) => r.repo);
  const summary = line
    ? others.length > 0
      ? [`It also owns ${others.join(", ")}.`]
      : []
    : [
        repos.length === 0
          ? `Team ${team} on ${server} owns no repos.`
          : `Team ${team} on ${server} owns ${repos.map((r) => r.repo).join(", ")}.`,
      ];
  print(io, options.json, report, [...(line ? [line] : []), ...summary]);
  return report;
}

/**
 * Joins a team with an invite and saves the server, token, person and team in the config file.
 * A refused invite or an unreadable config file changes no files.
 */
export async function joinTeam(
  url: string,
  invite: string,
  options: JsonOption & { person?: string; name?: string; managed?: boolean },
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
  const source = options.person === undefined ? personSource(io.env) : undefined;
  const person = options.person ?? source?.person ?? "";
  // An id from git or the OS user name is a guess: an invite for an email joins as that email.
  // SELFHOST_PERSON is as deliberate as --person.
  const guessed = source !== undefined && source.from !== "SELFHOST_PERSON";
  const joined = await new TeamClient(server, undefined, io.fetch).join(
    invite,
    person,
    options.name,
    guessed,
  );
  const membership = {
    server,
    token: joined.token,
    person: joined.person.id,
    team: joined.team.id,
  };
  saveMembership(io.configPath, membership);
  // The keys one-time exception grants are signed with, pinned before anything else here, so
  // the managed settings below pin them in their root-owned trust file too.
  let keysError: string | undefined;
  try {
    await pinExceptionKeys(new TeamClient(server, joined.token, io.fetch), io.configPath);
  } catch (failure) {
    keysError = failure instanceof Error ? failure.message : String(failure);
  }
  let context: JoinReport["context"] = null;
  let contextError: string | undefined;
  try {
    const client = new TeamClient(server, joined.token, io.fetch);
    const pulled = await pullContext(
      client,
      io.configPath,
      readSyncState(io.configPath, membership),
    );
    context = { hash: pulled.hash, layers: pulled.layers };
  } catch (failure) {
    contextError = failure instanceof Error ? failure.message : String(failure);
  }
  const laptop = io.laptop ? await joinLaptop(membership, options, io, io.laptop) : undefined;
  const report: JoinReport = {
    schema: "selfhost.join/v1",
    server,
    team: joined.team,
    person: joined.person.id,
    person_from: source && joined.person.id === source.person ? source.from : null,
    role: joined.person.role,
    config: io.configPath,
    context,
    ...(contextError === undefined ? {} : { context_error: contextError }),
    ...(keysError === undefined ? {} : { exception_keys_error: keysError }),
    ...(laptop ?? {}),
  };
  const layers = context?.layers ?? [];
  print(io, options.json, report, [
    `Joined team ${joined.team.name} (${joined.team.id}) on ${server} as ${joined.person.id} (${joined.person.role}).`,
    ...identityLines(report),
    "Your local ledger and selfhost.toml keep working as they are. The next selfhost import shares",
    "your local history and usage with the team and pulls the team policy.",
    contextError !== undefined
      ? `The team's context layers were not pulled (${contextError}); the next selfhost import pulls them.`
      : layers.length === 0
        ? "The team has no context layers yet."
        : `Pulled the ${layers.map((l) => `${l.kind} ${l.name}`).join(" and ")} context layers. Run selfhost context compile in a repository to give your agents the merged result; later syncs keep it up to date.`,
    ...joinLaptopLines(report),
  ]);
  return report;
}

/** Which identity join used when none was given, and how to join as another. */
function identityLines(report: JoinReport): string[] {
  const again =
    "To be someone else on the team, run selfhost team leave, then join again with --person <your email>.";
  switch (report.person_from) {
    case "os_user":
      return [
        `${report.person} is this computer's user name: git has no user.email here, and --person was not given. Your teammates see you by it. ${again}`,
      ];
    case "git":
      return [`${report.person} is your git user.email. ${again}`];
    case "SELFHOST_PERSON":
      return [`${report.person} is from SELFHOST_PERSON. ${again}`];
    default:
      return [];
  }
}

/** Pulls the team policy, installs its managed settings and sends the first heartbeat. */
async function joinLaptop(
  membership: { server: string; token: string; person: string; team: string },
  options: { managed?: boolean },
  io: TeamIo,
  laptop: LaptopIo,
): Promise<Pick<JoinReport, "policy_hash" | "policy_error" | "laptop">> {
  const client = new TeamClient(membership.server, membership.token, io.fetch);
  const state = readSyncState(io.configPath, membership);
  if (options.managed === false) {
    state.managed_off = true;
    writeSyncState(io.configPath, state);
  }
  let policyError: string | undefined;
  try {
    await pullPolicy(client, io.configPath, state);
  } catch (failure) {
    policyError = failure instanceof Error ? failure.message : String(failure);
  }
  const report = await reportLaptop(client, io.configPath, membership, state, laptop, true);
  return {
    policy_hash: state.policy_hash ?? null,
    ...(policyError === undefined ? {} : { policy_error: policyError }),
    laptop: report,
  };
}

function joinLaptopLines(report: JoinReport): string[] {
  const { laptop } = report;
  if (!laptop) return [];
  const lines: string[] = [];
  if (report.policy_error !== undefined) {
    lines.push(
      `The team policy was not pulled (${report.policy_error}); the next selfhost import pulls it and installs its managed settings.`,
    );
  } else if (laptop.managed_error !== undefined) {
    lines.push(`Managed settings not installed: ${laptop.managed_error}`);
  } else if (!laptop.managed) {
    lines.push(
      "The team has no policy yet, so there are no managed settings to install. Syncs install them once it has one.",
    );
  } else {
    lines.push(...describeManaged(laptop.managed));
    if (laptop.managed.state === "off") {
      lines.push(
        "Syncs keep reporting them; to install them, leave and join again without --no-managed.",
      );
    }
  }
  if (laptop.heartbeat.error !== undefined) {
    lines.push(
      `This laptop's config version did not reach the team (${laptop.heartbeat.error}); the next sync reports it.`,
    );
  }
  return lines;
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
    managed_commands: state?.managed_commands ?? [],
  };
  const lines = membership
    ? [
        `Team mode: team ${membership.team} on ${membership.server}, as ${membership.person}.`,
        `Last sync: ${report.last_sync ?? "never, run selfhost import"}.`,
        report.policy_hash
          ? `Team policy: ${report.policy_hash.slice(0, 12)}.`
          : "Team policy: none pulled yet. If the team has none, an owner or admin sets one with selfhost team policy push selfhost.toml.",
        ...(report.managed_commands.length > 0
          ? [
              "Managed settings: not installed here yet. Run once as an admin (selfhost never runs sudo itself):",
              ...report.managed_commands.map((command) => `  ${command}`),
            ]
          : []),
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
    .description(
      "create a team on a selfhost server, invite to it, manage its people, roles and repos, or leave it",
    );

  team
    .command("init")
    .description("create a team on a selfhost server and print the invite to share")
    .option(
      "--server <url>",
      "the selfhost server, like https://selfhost.example.com (default: the one selfhost up set up last)",
    )
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
      .option(
        "--token <token>",
        "the server's admin token (default: SELFHOST_TOKEN, else this machine's team token)",
      )
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

  adminOptions(
    team
      .command("role")
      .description("change a person's role in the team (owner, admin or member); owners only")
      .argument("<person>", "the person id, such as their git email")
      .argument("<role>", "owner, admin or member"),
  ).action((person: string, role: string, options: AdminOptions) =>
    guard(options.json, () => teamRole(person, role, options, io())),
  );

  adminOptions(
    team
      .command("add")
      .description("add someone already in another team of the org to this team")
      .argument("<person>", "the person id, such as their git email")
      .option("--role <role>", "member (default), admin or owner; admin and owner need an owner"),
  ).action((person: string, options: AdminOptions & { role?: string }) =>
    guard(options.json, () => teamAdd(person, options, io())),
  );

  adminOptions(
    team.command("people").description("list the people in the team and their roles"),
  ).action((options: AdminOptions) => guard(options.json, () => teamPeople(options, io())));

  adminOptions(
    team
      .command("repo")
      .description(
        "give a repo to the team by its remote URL, take it back, or list the team's repos",
      )
      .argument("<action>", "add, remove or list")
      .argument("[repo]", "remote URL (https://github.com/acme/api.git) or owner/name"),
  ).action((action: string, repo: string | undefined, options: AdminOptions) =>
    guard(options.json, () => {
      if (action !== "add" && action !== "remove" && action !== "list") {
        throw new Error(`team repo: expected add, remove or list, got "${action}"`);
      }
      return teamRepo(action, repo, options, io());
    }),
  );

  registerTeamPolicy(
    team,
    () => {
      const teamIo = io();
      return { ...teamIo, cwd: teamIo.cwd ?? process.cwd() };
    },
    fail,
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
    .option(
      "--no-managed",
      "do not install the team's managed settings on this laptop (syncs still report them)",
    )
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
