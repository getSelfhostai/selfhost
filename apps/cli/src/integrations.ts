import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import {
  checkIntegrations,
  IntegrationEditError,
  listIntegrations,
  localRepoView,
  setIntegrationTable,
} from "@selfhost/integrations";
import {
  formatConfigError,
  INTEGRATION_KINDS,
  INTEGRATION_TOOLS,
  INTEGRATIONS_SCHEMA,
  type IntegrationKind,
  type IntegrationStatus,
  type IntegrationsResponse,
  type InvalidPolicyError,
  parseConfig,
} from "@selfhost/schema";
import type { Command } from "commander";
import { findConfig } from "./find-config.js";
import { table } from "./format.js";
import { githubRepoFromRemote } from "./scan/git-attribution.js";
import { repoDir } from "./scan/index.js";
import { type Fetch, TeamApiError, TeamClient } from "./team/client.js";
import { readMembership } from "./team/config.js";

export interface IntegrationsIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  write: (line: string) => void;
  setExitCode: (code: number) => void;
  /** ~/.selfhost/config.json: with a team membership, the team server is used. */
  configPath: string;
  /** The team server in team mode; the tools themselves for a check in solo mode. */
  fetch?: Fetch;
}

export interface IntegrationsCommandOptions {
  config?: string;
  json?: boolean;
  setting?: string[];
}

export interface IntegrationReportRow {
  tool: string | null;
  /** null when nothing was checked: `list` in solo mode. */
  status: IntegrationStatus | null;
  detail: string | null;
  settings: Record<string, unknown>;
  /** When the check ran; null when nothing was checked. */
  checked_at: string | null;
}

/** `selfhost integrations --json`. */
export interface IntegrationsReport {
  schema: typeof INTEGRATIONS_SCHEMA;
  /** The team in team mode; null in solo mode. */
  team: string | null;
  /** Where the choices are kept: the team server, or the selfhost.toml path. */
  source: string;
  integrations: Record<IntegrationKind, IntegrationReportRow>;
}

/** The word that removes a job's tool in `set`. */
const NONE = "none";

type Mode =
  | { kind: "team"; client: TeamClient; team: string; server: string }
  | { kind: "solo"; path: string | undefined };

/** Team mode with a membership, unless --config names a file; else the selfhost.toml found here. */
function modeOf(options: IntegrationsCommandOptions, io: IntegrationsIo): Mode {
  const membership = options.config ? undefined : readMembership(io.configPath);
  if (membership) {
    const client = new TeamClient(
      membership.server,
      membership.token,
      io.fetch ?? globalThis.fetch,
    );
    return { kind: "team", client, team: membership.team, server: membership.server };
  }
  const location = findConfig(io.cwd, options.config, io.env);
  if (location && !existsSync(location.path)) throw new Error(`${location.path} does not exist`);
  return { kind: "solo", path: location?.path };
}

function readSolo(path: string | undefined) {
  const text = path ? readFileSync(path, "utf8") : "version = 1\n";
  const parsed = parseConfig(text);
  if (parsed.ok) return { text, config: parsed.config };
  const lines = parsed.errors.map((error) => `  ${formatConfigError(error, path)}`);
  throw new Error([`${path} is invalid. Run selfhost doctor.`, ...lines].join("\n"));
}

function originRepo(dir: string): string {
  try {
    const url = execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return githubRepoFromRemote(url) ?? basename(dir);
  } catch {
    return basename(dir);
  }
}

const fromServer = (body: IntegrationsResponse, server: string): IntegrationsReport => ({
  schema: INTEGRATIONS_SCHEMA,
  team: body.team,
  source: server,
  integrations: body.integrations,
});

async function soloReport(path: string | undefined, io: IntegrationsIo, check: boolean) {
  const { config } = readSolo(path);
  const source = path ?? "no selfhost.toml";
  if (!check) {
    const listed = listIntegrations(config.integrations);
    const integrations = Object.fromEntries(
      INTEGRATION_KINDS.map((kind) => [
        kind,
        { ...listed[kind], status: null, detail: null, checked_at: null },
      ]),
    ) as IntegrationsReport["integrations"];
    return { schema: INTEGRATIONS_SCHEMA, team: null, source, integrations } as IntegrationsReport;
  }
  const dir = repoDir(undefined, io.cwd);
  const integrations = await checkIntegrations(config.integrations, {
    env: io.env,
    fetch: (url, init) => (io.fetch ?? globalThis.fetch)(url, init ?? {}),
    repos: async () => (dir ? localRepoView(dir, originRepo(dir)) : undefined),
  });
  return { schema: INTEGRATIONS_SCHEMA, team: null, source, integrations } as IntegrationsReport;
}

async function report(options: IntegrationsCommandOptions, io: IntegrationsIo, check: boolean) {
  const mode = modeOf(options, io);
  if (mode.kind === "team") return fromServer(await mode.client.integrations(), mode.server);
  return soloReport(mode.path, io, check);
}

const STATUS_TEXT: Record<IntegrationStatus, string> = {
  connected: "connected",
  not_configured: "not set",
  error: "error",
};

function print(result: IntegrationsReport, write: (line: string) => void): void {
  write(
    result.team === null
      ? `Integrations in ${result.source}`
      : `Integrations of team ${result.team} on ${result.source}`,
  );
  table(
    INTEGRATION_KINDS.map((kind) => {
      const row = result.integrations[kind];
      const status =
        row.status === null ? (row.tool ? "not checked" : "not set") : STATUS_TEXT[row.status];
      return [kind, row.tool ?? "-", status];
    }),
    write,
  );
  const notes = INTEGRATION_KINDS.flatMap((kind) => {
    const row = result.integrations[kind];
    return row.detail && row.status !== "not_configured" ? [`  ${kind}: ${row.detail}`] : [];
  });
  if (notes.length > 0) {
    write("");
    for (const note of notes) write(note);
  }
  if (Object.values(result.integrations).some((row) => row.tool && row.status === null)) {
    write("");
    write("selfhost integrations check calls each tool to test it.");
  }
}

/** `selfhost integrations [list]`: each job's tool; in team mode as the server checked it. */
export async function runIntegrationsList(
  options: IntegrationsCommandOptions,
  io: IntegrationsIo,
): Promise<IntegrationsReport> {
  const result = await report(options, io, false);
  if (options.json) io.write(JSON.stringify(result, null, 2));
  else print(result, io.write);
  return result;
}

/** `selfhost integrations check`: exit code 1 when any picked tool fails its check. */
export async function runIntegrationsCheck(
  options: IntegrationsCommandOptions,
  io: IntegrationsIo,
): Promise<IntegrationsReport> {
  const result = await report(options, io, true);
  if (options.json) io.write(JSON.stringify(result, null, 2));
  else print(result, io.write);
  if (Object.values(result.integrations).some((row) => row.status === "error")) io.setExitCode(1);
  return result;
}

/** `--setting k=v`, repeatable; a dotted key such as headers_env.Authorization=X nests. */
export function parseSettings(values: readonly string[] = []): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const value of values) {
    const at = value.indexOf("=");
    const key = at === -1 ? "" : value.slice(0, at).trim();
    if (!key) throw new Error(`--setting: expected key=value, got "${value}"`);
    const parts = key.split(".");
    let into = settings;
    for (const part of parts.slice(0, -1)) {
      const next = into[part];
      into[part] = typeof next === "object" && next !== null ? next : {};
      into = into[part] as Record<string, unknown>;
    }
    into[parts[parts.length - 1] as string] = value.slice(at + 1).trim();
  }
  return settings;
}

function parseKind(value: string): IntegrationKind {
  if (!(INTEGRATION_KINDS as readonly string[]).includes(value)) {
    throw new Error(`Expected a job of ${INTEGRATION_KINDS.join(", ")}, got "${value}"`);
  }
  return value as IntegrationKind;
}

function parseTool(kind: IntegrationKind, value: string): string | null {
  if (value === NONE) return null;
  const tools = INTEGRATION_TOOLS[kind];
  if (!tools.includes(value)) {
    throw new Error(`Expected a ${kind} of ${tools.join(", ")} or ${NONE}, got "${value}"`);
  }
  return value;
}

const invalidLines = (errors: { field: string; message: string; line?: number }[]) =>
  errors.map(
    ({ field, message, line }) => `  ${field}${line ? ` (line ${line})` : ""}: ${message}`,
  );

/**
 * `selfhost integrations set <kind> <tool>`: writes [integrations.<kind>] into the team policy on
 * the server in team mode (owners and admins), else into selfhost.toml here, keeping the rest of
 * the file as it was. `none` removes it.
 */
export async function runIntegrationsSet(
  kindArg: string,
  toolArg: string,
  options: IntegrationsCommandOptions,
  io: IntegrationsIo,
): Promise<IntegrationsReport> {
  const kind = parseKind(kindArg);
  const tool = parseTool(kind, toolArg);
  const settings = parseSettings(options.setting);
  if (tool === null && Object.keys(settings).length > 0) {
    throw new Error(`--setting: ${NONE} removes [integrations.${kind}], so it takes no settings`);
  }
  if ("tool" in settings) throw new Error("--setting: give the tool as the second argument");
  const mode = modeOf(options, io);
  let result: IntegrationsReport;
  if (mode.kind === "team") {
    try {
      const body = await mode.client.setIntegration(kind, {
        tool,
        ...(Object.keys(settings).length > 0 ? { settings } : {}),
      });
      result = fromServer(body, mode.server);
    } catch (error) {
      const errors = (error as TeamApiError).body as InvalidPolicyError | undefined;
      if (error instanceof TeamApiError && Array.isArray(errors?.errors)) {
        throw new Error(
          [`The team server refused [integrations.${kind}]:`, ...invalidLines(errors.errors)].join(
            "\n",
          ),
        );
      }
      throw error;
    }
  } else {
    if (!mode.path) {
      throw new Error(
        "No selfhost.toml found from this directory up to the repository root. Run selfhost init, or pass --config <path>.",
      );
    }
    const { text } = readSolo(mode.path);
    let next: string;
    try {
      next = setIntegrationTable(text, kind, tool === null ? null : { tool, ...settings });
    } catch (error) {
      if (error instanceof IntegrationEditError) throw new Error(`${mode.path}: ${error.message}`);
      throw error;
    }
    const parsed = parseConfig(next);
    if (!parsed.ok) {
      throw new Error(
        [
          `[integrations.${kind}] would make ${mode.path} invalid, so nothing was written:`,
          ...parsed.errors.map((e) => `  ${formatConfigError(e)}`),
        ].join("\n"),
      );
    }
    if (next !== text) writeFileSync(mode.path, next);
    result = await soloReport(mode.path, io, false);
  }
  if (options.json) {
    io.write(JSON.stringify(result, null, 2));
  } else {
    const where = result.team === null ? result.source : `team ${result.team}`;
    io.write(
      tool === null
        ? `Removed [integrations.${kind}] from ${where}.`
        : `Set [integrations.${kind}] in ${where}: ${tool}.`,
    );
    const row = result.integrations[kind];
    if (row.status === "error" && row.detail) io.write(`Check: ${row.detail}`);
    else if (row.status === "connected" && row.detail) io.write(`Check: ${row.detail}`);
    else if (tool !== null) io.write("Run selfhost integrations check to test it.");
  }
  return result;
}

export function registerIntegrations(
  program: Command,
  io: () => IntegrationsIo,
  fail: (error: unknown, json: boolean | undefined) => void,
): void {
  const group = program
    .command("integrations")
    .description(
      "the router, tracer, runtime and reviewer the team picked, and whether each is connected",
    )
    .option("-c, --config <path>", "use this selfhost.toml, also on a machine in a team")
    .option("--json", "print JSON")
    .action(async (options: IntegrationsCommandOptions) => {
      try {
        await runIntegrationsList(options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });

  group
    .command("list")
    .description("each job's tool and settings; in team mode with the server's check")
    .option("-c, --config <path>", "use this selfhost.toml, also on a machine in a team")
    .option("--json", "print JSON")
    .action(async (options: IntegrationsCommandOptions) => {
      try {
        await runIntegrationsList(options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });

  group
    .command("check")
    .description(
      "test each tool is reachable and its key works, and say what to fix; exits 1 on a failure",
    )
    .option("-c, --config <path>", "use this selfhost.toml, also on a machine in a team")
    .option("--json", "print JSON")
    .action(async (options: IntegrationsCommandOptions) => {
      try {
        await runIntegrationsCheck(options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });

  group
    .command("set")
    .description(
      `pick the tool for a job (${INTEGRATION_KINDS.join(", ")}), or ${NONE} to remove it`,
    )
    .argument("<kind>", INTEGRATION_KINDS.join(", "))
    .argument("<tool>", `the tool, or ${NONE}`)
    .option(
      "--setting <key=value>",
      "a setting such as url=http://litellm:4000 or api_key_env=E2B_API_KEY; repeatable",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option("-c, --config <path>", "use this selfhost.toml, also on a machine in a team")
    .option("--json", "print JSON")
    .action(async (kind: string, tool: string, options: IntegrationsCommandOptions) => {
      try {
        await runIntegrationsSet(kind, tool, options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });
}
