import { relative, resolve } from "node:path";
import {
  formatContextError,
  itemFiles,
  parseItemId,
  readContextDir,
  readLayerDir,
} from "@selfhost/context";
import type { ContextConflict, ContextProposal } from "@selfhost/schema";
import type { Command } from "commander";
import { plural } from "../format.js";
import { TeamClient } from "../team/client.js";
import {
  type AdminOptions,
  type JsonOption,
  needTeam,
  type TeamIo,
  teamTarget,
} from "../team/commands.js";
import { readMembership } from "../team/config.js";
import { PERSONAL, personalDir } from "./layers.js";

export interface ContextTeamIo extends TeamIo {
  cwd: string;
}

/** `selfhost context push --json`. */
export interface ContextPushReport {
  schema: "selfhost.context_push/v1";
  server: string;
  layer: "org" | "team";
  /** The org id or team id. */
  name: string;
  hash: string;
  files: number;
  /** Team items the org layer replaces, after this push. */
  conflicts: ContextConflict[];
}

/** `selfhost context propose --json`. */
export interface ContextProposeReport {
  schema: "selfhost.context_propose/v1";
  server: string;
  proposal: ContextProposal;
  approve_command: string;
}

const print = (io: TeamIo, json: boolean | undefined, report: object, lines: string[]) => {
  if (json) io.write(JSON.stringify(report, null, 2));
  else for (const line of lines) io.write(line);
};

/**
 * Sets the team's context layer (or with --org the org's) from a folder in the
 * .selfhost/context layout. An owner or admin of the team, or the admin token; the org layer
 * takes the admin token. Every member gets it on their next sync.
 */
export async function contextPush(
  dir: string,
  options: AdminOptions & { org?: string },
  io: ContextTeamIo,
): Promise<ContextPushReport> {
  const folder = resolve(io.cwd, dir);
  const shown = relative(io.cwd, folder) || ".";
  const read = readContextDir(folder, shown);
  if (!read.ok) {
    throw new Error(
      `${shown} has ${plural(read.errors.length, "problem")}, nothing was sent:\n${read.errors.map((e) => `  ${formatContextError(e)}`).join("\n")}`,
    );
  }
  const files = readLayerDir(folder);
  const { server, client, team } = teamTarget(options, io, "context push");
  let report: ContextPushReport;
  if (options.org !== undefined) {
    const stored = await client.setOrgContext(options.org, files);
    report = {
      schema: "selfhost.context_push/v1",
      server,
      layer: "org",
      name: stored.org,
      hash: stored.hash,
      files: stored.files.length,
      conflicts: [],
    };
  } else {
    const name = needTeam(team, "context push");
    const stored = await client.setContext(name, files);
    report = {
      schema: "selfhost.context_push/v1",
      server,
      layer: "team",
      name,
      hash: stored.layers.find((layer) => layer.kind === "team")?.hash ?? stored.hash,
      files: files.length,
      conflicts: stored.conflicts,
    };
  }
  print(io, options.json, report, [
    `Set the ${report.layer} context layer of ${report.name} on ${server} from ${shown} (${plural(report.files, "file")}).`,
    report.layer === "org"
      ? "Its items come first on every member's laptop of the org: nobody's layer replaces them."
      : "Every member's agents get it on their next sync.",
    ...(report.conflicts.length > 0
      ? [
          "The org layer replaces these team items:",
          ...report.conflicts.map((c) => `  ${c.message}`),
        ]
      : []),
  ]);
  return report;
}

/**
 * Proposes one of the person's own items (from ~/.selfhost/context/personal) to their team. It
 * applies to the team only once an owner or admin approves the review item it opens.
 */
export async function contextPropose(
  item: string,
  options: JsonOption & { team?: string },
  io: ContextTeamIo,
): Promise<ContextProposeReport> {
  const membership = readMembership(io.configPath);
  if (!membership) {
    throw new Error("context propose needs a team: join one first with selfhost join");
  }
  const ref = parseItemId(item);
  if (!ref) {
    throw new Error(
      `Expected an item as kind:name, like rule:no-secrets, skill:review or mcp:notes, got "${item}"`,
    );
  }
  const dir = personalDir(io.configPath);
  const files = itemFiles(readLayerDir(dir), ref);
  if (files.length === 0) {
    throw new Error(
      `Your ${PERSONAL} layer (${dir}) has no ${item}. Personal items use the .selfhost/context layout there: rules/<name>.md, skills/<name>/SKILL.md, commands/<name>.md, agents/<name>.md and mcp.json.`,
    );
  }
  const client = new TeamClient(membership.server, membership.token, io.fetch);
  const proposal = await client.proposeContext({
    item,
    files,
    ...(options.team ? { team: options.team } : {}),
  });
  const approve = `selfhost inbox approve ${proposal.id}`;
  const report: ContextProposeReport = {
    schema: "selfhost.context_propose/v1",
    server: membership.server,
    proposal,
    approve_command: approve,
  };
  print(io, options.json, report, [
    `Proposed your ${item} to team ${proposal.team} on ${membership.server}.`,
    "It stays personal until an owner or admin of the team approves it; then every member gets it on their next sync:",
    `  ${approve}`,
  ]);
  return report;
}

/** Adds `context push` and `context propose`. */
export function registerContextTeam(
  context: Command,
  io: () => ContextTeamIo,
  fail: (error: unknown, json: boolean | undefined) => void,
): void {
  const guard = async (json: boolean | undefined, fn: () => unknown) => {
    try {
      await fn();
    } catch (error) {
      fail(error, json);
    }
  };

  context
    .command("push")
    .description(
      "set the team's context layer (or with --org the org's) from a folder in the .selfhost/context layout",
    )
    .argument("<dir>", "folder with rules/, skills/, commands/, agents/ and mcp.json")
    .option("--org <org>", "set the org's layer instead, the floor of every team (admin token)")
    .option("--server <url>", "the selfhost server (default: the one this machine joined)")
    .option("--team <id>", "team id (default: the one this machine joined)")
    .option(
      "--token <token>",
      "the server's admin token (default: SELFHOST_TOKEN, else this machine's team token)",
    )
    .option("--json", "print JSON")
    .action((dir: string, options: AdminOptions & { org?: string }) =>
      guard(options.json, () => contextPush(dir, options, io())),
    );

  context
    .command("propose")
    .description(
      "propose one of your personal items to the team; it applies once an owner or admin approves it",
    )
    .argument("<item>", "kind:name, like rule:no-secrets, skill:review or mcp:notes")
    .option("--team <id>", "team to propose it to (default: the one this machine joined)")
    .option("--json", "print JSON")
    .action((item: string, options: JsonOption & { team?: string }) =>
      guard(options.json, () => contextPropose(item, options, io())),
    );
}
