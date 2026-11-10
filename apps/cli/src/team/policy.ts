import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CONFIG_FILE_NAME,
  formatConfigError,
  type InvalidPolicyError,
  type PolicyResponse,
  parseConfig,
} from "@selfhost/schema";
import type { Command } from "commander";
import { findConfig } from "../find-config.js";
import { requireHuman } from "../human.js";
import { type Fetch, TeamApiError, TeamClient } from "./client.js";
import { readMembership } from "./config.js";

/**
 * `selfhost team policy push | pull | show`: the team's selfhost.toml on its server. Anyone in
 * the team reads it; push needs the owner or admin role there, which the server checks, and a
 * person at a terminal, since it changes what every agent in the team is held to.
 */

export interface TeamPolicyIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  write: (line: string) => void;
  configPath: string;
  fetch: Fetch;
  /** Whether stdin is a terminal; push refuses without one. */
  stdinIsTTY?: boolean;
}

interface TeamPolicyOptions {
  team?: string;
  json?: boolean;
  force?: boolean;
}

/** `selfhost team policy push|pull|show --json`. */
export interface TeamPolicyReport {
  schema: "selfhost.team_policy/v1";
  server: string;
  team: string;
  /** sha256 of the team's selfhost.toml in use after the command. */
  hash: string;
  /** The file pushed or written; null for show. */
  file: string | null;
  text: string;
}

function client(io: TeamPolicyIo, command: string) {
  const membership = readMembership(io.configPath);
  if (!membership) {
    throw new Error(
      `${command} works in team mode: join a team first with selfhost join <server> <invite>`,
    );
  }
  return { membership, client: new TeamClient(membership.server, membership.token, io.fetch) };
}

function report(
  server: string,
  team: string,
  policy: PolicyResponse,
  file: string | null,
): TeamPolicyReport {
  return {
    schema: "selfhost.team_policy/v1",
    server,
    team,
    hash: policy.hash,
    file,
    text: policy.text ?? "",
  };
}

/** Validates a selfhost.toml and sends it as the team's policy. */
export async function pushTeamPolicy(
  fileArg: string | undefined,
  options: TeamPolicyOptions,
  io: TeamPolicyIo,
): Promise<TeamPolicyReport> {
  requireHuman(
    "selfhost team policy push",
    { env: io.env, stdinIsTTY: io.stdinIsTTY === true },
    null,
  );
  const { membership, client: team } = client(io, "selfhost team policy push");
  const file = fileArg
    ? resolve(io.cwd, fileArg)
    : // The repository's own file, never the team policy this machine pulled.
      findConfig(io.cwd, undefined, io.env, undefined)?.path;
  if (!file || !existsSync(file)) {
    throw new Error(
      fileArg
        ? `${fileArg} does not exist`
        : `No ${CONFIG_FILE_NAME} found from this directory up to the repository root: pass the file to push`,
    );
  }
  const text = readFileSync(file, "utf8");
  const parsed = parseConfig(text);
  if (!parsed.ok) {
    throw new Error(
      [
        `${file} is not valid, so nothing was sent:`,
        ...parsed.errors.map((error) => `  ${formatConfigError(error, file)}`),
      ].join("\n"),
    );
  }
  const target = options.team ?? membership.team;
  let policy: PolicyResponse;
  try {
    policy = await team.setPolicy(text, target);
  } catch (error) {
    const body = error instanceof TeamApiError ? (error.body as InvalidPolicyError) : undefined;
    if (body && Array.isArray(body.errors)) {
      throw new Error(
        [
          `The team server refused ${file}:`,
          ...body.errors.map(
            ({ field, message, line }) => `  ${field}${line ? ` (line ${line})` : ""}: ${message}`,
          ),
        ].join("\n"),
      );
    }
    throw error;
  }
  const result = report(membership.server, target, policy, file);
  if (options.json) io.write(JSON.stringify(result, null, 2));
  else {
    io.write(`Pushed ${file} as team ${target}'s policy on ${membership.server}.`);
    io.write(
      `Policy ${policy.hash.slice(0, 12)}: every laptop in the team pulls it on its next selfhost import.`,
    );
  }
  return result;
}

async function readTeamPolicy(options: TeamPolicyOptions, io: TeamPolicyIo, command: string) {
  const { membership, client: team } = client(io, command);
  const target = options.team ?? membership.team;
  const policy = await team.policy(options.team);
  if (!policy) {
    throw new Error(
      `Team ${target} has no policy on ${membership.server} yet. An owner or admin sets one with selfhost team policy push selfhost.toml.`,
    );
  }
  return { server: membership.server, team: target, policy };
}

/** Prints the team's selfhost.toml in use. */
export async function showTeamPolicy(
  options: TeamPolicyOptions,
  io: TeamPolicyIo,
): Promise<TeamPolicyReport> {
  const { server, team, policy } = await readTeamPolicy(options, io, "selfhost team policy show");
  const result = report(server, team, policy, null);
  if (options.json) io.write(JSON.stringify(result, null, 2));
  else io.write(result.text.replace(/\n$/, ""));
  return result;
}

/** Writes the team's selfhost.toml to a file, which it replaces only with --force. */
export async function pullTeamPolicy(
  fileArg: string | undefined,
  options: TeamPolicyOptions,
  io: TeamPolicyIo,
): Promise<TeamPolicyReport> {
  const { server, team, policy } = await readTeamPolicy(options, io, "selfhost team policy pull");
  const file = resolve(io.cwd, fileArg ?? CONFIG_FILE_NAME);
  if (existsSync(file) && !options.force) {
    throw new Error(`${file} exists: pass --force to replace it, or another file`);
  }
  writeFileSync(file, policy.text ?? "");
  const result = report(server, team, policy, file);
  if (options.json) io.write(JSON.stringify(result, null, 2));
  else io.write(`Wrote team ${team}'s policy ${policy.hash.slice(0, 12)} to ${file}.`);
  return result;
}

export function registerTeamPolicy(
  team: Command,
  io: () => TeamPolicyIo,
  fail: (error: unknown, json: boolean | undefined) => void,
): void {
  const guard = async (json: boolean | undefined, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (error) {
      fail(error, json);
    }
  };
  const policy = team
    .command("policy")
    .description(
      "the team's selfhost.toml on its server: push one (owners and admins), pull or show it",
    );
  const common = (command: Command) =>
    command
      .option("--team <id>", "team id (default: the one this machine joined)")
      .option("--json", "print JSON");
  common(
    policy
      .command("push")
      .description("validate a selfhost.toml and make it the team's policy; owners and admins")
      .argument("[file]", "the file to push (default: selfhost.toml of this repository)"),
  ).action((file: string | undefined, options: TeamPolicyOptions) =>
    guard(options.json, () => pushTeamPolicy(file, options, io())),
  );
  common(
    policy
      .command("pull")
      .description("write the team's policy to a file")
      .argument("[file]", "where to write it (default: selfhost.toml here)")
      .option("--force", "replace the file when it exists"),
  ).action((file: string | undefined, options: TeamPolicyOptions) =>
    guard(options.json, () => pullTeamPolicy(file, options, io())),
  );
  common(policy.command("show").description("print the team's policy")).action(
    (options: TeamPolicyOptions) => guard(options.json, () => showTeamPolicy(options, io())),
  );
}
