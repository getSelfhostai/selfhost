import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  connect,
  dumpDataDir,
  isPostgresUrl,
  loadDataDir,
  resolveDataDir,
  rowCounts,
  schemaStatus,
} from "@selfhost/ledger";
import type { SshTarget } from "./up/plan.js";
import type { Exec } from "./up/resources.js";
import { parseSshTarget, sshArgs, sshOptions } from "./up/ssh.js";
import { STACK_DIR } from "./up/stack.js";

export interface BackupOptions {
  dataDir?: string;
  host?: string;
  port?: string;
  identity?: string;
  dir?: string;
  force?: boolean;
  json?: boolean;
}

export interface BackupIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  write: (line: string) => void;
  now?: Date;
  exec: Exec;
}

/** `selfhost ledger backup --json` and `selfhost ledger restore --json`. */
export interface BackupReport {
  schema: "selfhost.ledger_backup/v1" | "selfhost.ledger_restore/v1";
  file: string;
  /** The embedded ledger folder, or user@host:<stack folder> for a Docker Compose install. */
  ledger: string;
  /** "pglite": a gzipped tar of the embedded ledger folder. "pg_dump": pg_dump --format=custom. */
  format: "pglite" | "pg_dump";
  /** Rows in each table of what was backed up or restored. */
  rows: Record<string, number>;
  /** Restore only: where the ledger that was replaced was moved, kept until you delete it. */
  previous?: string | null;
}

const stamp = (now: Date) =>
  now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");

function sshTarget(options: BackupOptions): { target: SshTarget; dir: string; login: string } {
  if (options.dataDir) {
    throw new Error("--host backs up the Docker Compose install on that server: drop --data-dir");
  }
  const port = options.port === undefined ? null : Number(options.port);
  if (port !== null && !(Number.isInteger(port) && port > 0)) {
    throw new Error(`--port: expected a port number, got "${options.port}"`);
  }
  const dir = options.dir ?? STACK_DIR;
  if (!/^\/[\w./-]+$/.test(dir)) throw new Error(`--dir: expected an absolute path, got "${dir}"`);
  const target = parseSshTarget(options.host as string, port, options.identity?.trim() || null);
  return { target, dir, login: `${target.user}@${target.host}` };
}

/** The embedded ledger folder; a Postgres url is refused, as pg_dump and pg_restore do that job. */
function embeddedDir(options: BackupOptions, io: BackupIo): string {
  const url = io.env.DATABASE_URL;
  if (url?.trim() && isPostgresUrl(url)) {
    throw new Error(
      "The ledger is in Postgres (DATABASE_URL): back it up with pg_dump --format=custom and restore it with pg_restore, or use --host for a Docker Compose install (deploy/docker/README.md).",
    );
  }
  return resolveDataDir(options.dataDir, io.env);
}

/** "rows: events=12 teams=1" from backup.sh or restore.sh. */
function parseRows(output: string): Record<string, number> {
  const line = output.split("\n").find((l) => l.startsWith("rows: ")) ?? "";
  return Object.fromEntries(
    line
      .slice("rows: ".length)
      .split(" ")
      .map((word) => word.split("="))
      .filter(([table, count]) => table && /^\d+$/.test(count ?? ""))
      .map(([table, count]) => [table, Number(count)]),
  );
}

async function run(io: BackupIo, command: string, args: string[], quiet: boolean) {
  const result = await io.exec(command, args, {
    onLine: (line) => {
      if (!quiet && line.trim() !== "") io.write(`  ${line}`);
    },
  });
  if (result.code === 127) throw new Error(`${command} is not on PATH: install OpenSSH.`);
  if (result.code !== 0) {
    const tail = `${result.stdout}\n${result.stderr}`
      .split("\n")
      .filter((line) => line.trim() !== "")
      .slice(-10);
    throw new Error(
      `${command} failed (exit ${result.code})${tail.length > 0 ? `:\n${tail.map((l) => `  | ${l}`).join("\n")}` : ""}`,
    );
  }
  return result.stdout;
}

async function countRows(dataDir: string) {
  const db = await connect({ dataDir });
  try {
    return { status: await schemaStatus(db), rows: await rowCounts(db) };
  } finally {
    await db.close();
  }
}

function report(value: BackupReport, io: BackupIo, json: boolean | undefined): BackupReport {
  if (json) {
    io.write(JSON.stringify(value, null, 2));
    return value;
  }
  const verb = value.schema === "selfhost.ledger_backup/v1" ? "Backed up" : "Restored";
  io.write(`${verb} ${value.ledger} ${verb === "Restored" ? "from" : "to"} ${value.file}`);
  io.write(
    `Rows: ${Object.entries(value.rows)
      .map(([table, count]) => `${table} ${count}`)
      .join(", ")}`,
  );
  if (value.previous) io.write(`The ledger it replaced is kept at ${value.previous}`);
  return value;
}

/**
 * Backs up the embedded ledger (a gzipped tar of its folder), or with --host the Docker Compose
 * install on that server: backup.sh there runs pg_dump, and the file comes back over scp.
 */
export async function runBackup(
  file: string | undefined,
  options: BackupOptions,
  io: BackupIo,
): Promise<BackupReport> {
  const now = io.now ?? new Date();
  if (options.host) {
    const { target, dir, login } = sshTarget(options);
    const name = `selfhost-${stamp(now)}.dump`;
    const local = resolve(io.cwd, file ?? name);
    const sudo = target.user === "root" ? "" : "sudo -n ";
    if (!options.json) io.write(`Backing up the database on ${login} with ${dir}/backup.sh`);
    const output = await run(
      io,
      "ssh",
      [...sshArgs(target), `cd ${dir} && ${sudo}./backup.sh backups/${name}`],
      Boolean(options.json),
    );
    await run(
      io,
      "scp",
      [...sshOptions(target, "-P"), `${login}:${dir}/backups/${name}`, `${local}.partial`],
      true,
    );
    renameSync(`${local}.partial`, local);
    return report(
      {
        schema: "selfhost.ledger_backup/v1",
        file: local,
        ledger: `${login}:${dir}`,
        format: "pg_dump",
        rows: parseRows(output),
      },
      io,
      options.json,
    );
  }

  const dataDir = embeddedDir(options, io);
  if (!existsSync(dataDir)) throw new Error(`There is no embedded ledger at ${dataDir}`);
  const local = resolve(io.cwd, file ?? `selfhost-${stamp(now)}.tar.gz`);
  const { rows } = await countRows(dataDir);
  // Written to a temporary name first, so a failed backup never looks like a good one.
  writeFileSync(`${local}.partial`, await dumpDataDir(dataDir));
  renameSync(`${local}.partial`, local);
  return report(
    { schema: "selfhost.ledger_backup/v1", file: local, ledger: dataDir, format: "pglite", rows },
    io,
    options.json,
  );
}

/**
 * Restores a backup from runBackup. The embedded ledger is unpacked next to the live one and
 * checked first, so a bad file changes nothing; the ledger it replaces is moved aside, not
 * deleted. With --host, the file goes to the server over scp and restore.sh there restores it.
 * A ledger that already holds events is only replaced with --force.
 */
export async function runRestore(
  file: string,
  options: BackupOptions,
  io: BackupIo,
): Promise<BackupReport> {
  const local = resolve(io.cwd, file);
  if (!existsSync(local)) throw new Error(`${local} does not exist`);
  const now = io.now ?? new Date();

  if (options.host) {
    const { target, dir, login } = sshTarget(options);
    const remote = `/tmp/selfhost-restore-${randomBytes(6).toString("hex")}.dump`;
    const sudo = target.user === "root" ? "" : "sudo -n ";
    await run(io, "scp", [...sshOptions(target, "-P"), local, `${login}:${remote}`], true);
    if (!options.json) io.write(`Restoring on ${login} with ${dir}/restore.sh`);
    const output = await run(
      io,
      "ssh",
      [
        ...sshArgs(target),
        `cd ${dir} && ${sudo}./restore.sh ${options.force ? "--force " : ""}${remote}; code=$?; rm -f ${remote}; exit $code`,
      ],
      Boolean(options.json),
    );
    return report(
      {
        schema: "selfhost.ledger_restore/v1",
        file: local,
        ledger: `${login}:${dir}`,
        format: "pg_dump",
        rows: parseRows(output),
      },
      io,
      options.json,
    );
  }

  const dataDir = embeddedDir(options, io);
  const scratch = `${dataDir}.restore-${process.pid}`;
  rmSync(scratch, { recursive: true, force: true });
  try {
    await loadDataDir(scratch, readFileSync(local));
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    throw new Error(
      `${local} is not a backup of an embedded ledger (${error instanceof Error ? error.message : error}). Nothing was changed.`,
    );
  }
  const restored = await countRows(scratch).catch((error: unknown) => {
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  });

  if (restored.status.unknown.length > 0) {
    rmSync(scratch, { recursive: true, force: true });
    throw new Error(
      `${local} is from a newer release (it has migration ${restored.status.unknown.join(", ")}): restore it with that release. Nothing was changed.`,
    );
  }

  let previous: string | null = null;
  if (existsSync(dataDir)) {
    const events = (await countRows(dataDir)).rows.events ?? 0;
    if (events > 0 && !options.force) {
      rmSync(scratch, { recursive: true, force: true });
      throw new Error(
        `The ledger at ${dataDir} already holds ${events} events. Rerun with --force to replace it; it is moved aside, not deleted.`,
      );
    }
    previous = `${dataDir}.before-restore-${stamp(now)}`;
    renameSync(dataDir, previous);
  }
  renameSync(scratch, dataDir);
  return report(
    {
      schema: "selfhost.ledger_restore/v1",
      file: local,
      ledger: dataDir,
      format: "pglite",
      rows: restored.rows,
      previous,
    },
    io,
    options.json,
  );
}
