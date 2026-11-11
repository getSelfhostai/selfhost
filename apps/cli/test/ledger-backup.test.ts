import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { connect, MIGRATIONS, migrate, openLedger } from "@selfhost/ledger";
import { describe, expect, it, vi } from "vitest";
import { seedLedger } from "../../../fixtures/ledger/seed.js";
import type { BackupReport } from "../src/backup.js";
import type { LedgerMigrateReport, LedgerStatusReport } from "../src/ledger.js";
import type { ExecOptions, ExecResult } from "../src/up/resources.js";
import { run, tempDir } from "./run.js";

const NOW = new Date("2026-11-08T12:00:00.000Z");
const LATEST = MIGRATIONS.at(-1)?.version as string;

/** An embedded ledger with seed rows in every table, at these migrations. */
async function seeded(dataDir: string, migrations = MIGRATIONS) {
  const db = await connect({ dataDir });
  try {
    await migrate(db, migrations);
    await seedLedger(db);
  } finally {
    await db.close();
  }
}

const json = <T>(result: { code: number; out: string; err: string }): T => {
  expect(result.err).toBe("");
  expect(result.code).toBe(0);
  return JSON.parse(result.out) as T;
};

const status = async (dataDir: string) =>
  json<LedgerStatusReport>(await run(["ledger", "status", "--data-dir", dataDir, "--json"]));

describe("selfhost ledger backup and restore, embedded ledger", () => {
  it("restores into a fresh install with the same rows in every table", async () => {
    const dir = tempDir("backup");
    const data = dir.path("old", "data");
    await seeded(data);
    const before = await status(data);

    const backup = json<BackupReport>(
      await run(["ledger", "backup", "--data-dir", data, "--json"], { cwd: dir.root, now: NOW }),
    );
    expect(backup).toMatchObject({
      schema: "selfhost.ledger_backup/v1",
      file: dir.path("selfhost-20261108T120000Z.tar.gz"),
      ledger: data,
      format: "pglite",
      rows: before.rows,
    });
    expect(backup.rows.events).toBe(3);

    // A fresh install: the ledger exists, with its migrations and no events.
    const fresh = dir.path("new", "data");
    await (await openLedger({ dataDir: fresh })).close();
    const restored = json<BackupReport>(
      await run(["ledger", "restore", backup.file, "--data-dir", fresh, "--json"], { now: NOW }),
    );
    expect(restored).toMatchObject({
      schema: "selfhost.ledger_restore/v1",
      ledger: fresh,
      rows: before.rows,
      previous: `${fresh}.before-restore-20261108T120000Z`,
    });
    expect((await status(fresh)).rows).toEqual(before.rows);
    const ledger = await openLedger({ dataDir: fresh });
    try {
      expect((await ledger.query({})).events).toHaveLength(3);
    } finally {
      await ledger.close();
    }
  });

  it("restores a previous release's backup, which the next open upgrades", async () => {
    const dir = tempDir("backup-old");
    const data = dir.path("data");
    await seeded(data, MIGRATIONS.slice(0, -1));
    const file = dir.path("old.tar.gz");
    const backup = json<BackupReport>(
      await run(["ledger", "backup", file, "--data-dir", data, "--json"]),
    );
    const fresh = dir.path("fresh");
    json(await run(["ledger", "restore", file, "--data-dir", fresh, "--json"]));
    expect((await status(fresh)).pending).toEqual([LATEST]);

    const migrated = json<LedgerMigrateReport>(
      await run(["ledger", "migrate", "--data-dir", fresh, "--json"]),
    );
    expect(migrated).toMatchObject({ applied: [LATEST], current: LATEST, rolled_back: [] });
    const after = await status(fresh);
    for (const [table, count] of Object.entries(backup.rows)) {
      if (table !== "schema_migrations") expect(after.rows[table], table).toBe(count);
    }
  });

  it("replaces a ledger with events only with --force, and keeps the one it replaced", async () => {
    const dir = tempDir("backup-force");
    const data = dir.path("data");
    await seeded(data);
    const file = dir.path("b.tar.gz");
    json(await run(["ledger", "backup", file, "--data-dir", data, "--json"]));

    const refused = await run(["ledger", "restore", file, "--data-dir", data]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(
      `The ledger at ${data} already holds 3 events. Rerun with --force`,
    );
    expect(existsSync(`${data}.restore-${process.pid}`)).toBe(false);

    const forced = await run(["ledger", "restore", file, "--data-dir", data, "--force"], {
      now: NOW,
    });
    expect(forced.code).toBe(0);
    expect(forced.out).toContain(`Restored ${data} from ${file}`);
    expect(forced.out).toContain("events 3");
    expect(forced.out).toContain(
      `The ledger it replaced is kept at ${data}.before-restore-20261108T120000Z`,
    );
  });

  it("leaves the ledger alone when the file is not a backup", async () => {
    const dir = tempDir("backup-bad");
    const data = dir.path("data");
    await seeded(data);
    const before = await status(data);
    const bad = dir.write("bad.tar.gz", "not a backup");
    const result = await run(["ledger", "restore", bad, "--data-dir", data, "--force"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain(`${bad} is not a backup of an embedded ledger`);
    expect((await status(data)).rows).toEqual(before.rows);
  });

  it("points a Postgres ledger at pg_dump, and needs a ledger to back up", async () => {
    const dir = tempDir("backup-pg");
    const pg = await run(["ledger", "backup"], {
      env: { DATABASE_URL: "postgres://x@localhost/x" },
    });
    expect(pg.code).toBe(1);
    expect(pg.err).toContain("back it up with pg_dump --format=custom");
    const none = await run(["ledger", "backup", "--data-dir", dir.path("none")]);
    expect(none.err).toBe(`There is no embedded ledger at ${dir.path("none")}`);
  });
});

/** Every entry of a gzipped tar: its name, type flag and mode. */
function tarEntries(file: string) {
  const tar = gunzipSync(readFileSync(file));
  const entries: { name: string; type: string; mode: number }[] = [];
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (from: number, length: number) =>
      header
        .subarray(from, from + length)
        .toString("ascii")
        .replace(/\0.*$/s, "")
        .trim();
    entries.push({
      name: text(0, 100),
      type: String.fromCharCode(header[156] ?? 0),
      mode: Number.parseInt(text(100, 8), 8),
    });
    at += 512 + Math.ceil(Number.parseInt(text(124, 12) || "0", 8) / 512) * 512;
  }
  return entries;
}

const modeOf = (path: string) => statSync(path).mode & 0o777;

describe("selfhost ledger files are for their owner only", () => {
  it("makes new ledgers and backups private, entries included", async () => {
    const dir = tempDir("private");
    const data = dir.path("home", ".selfhost", "data");
    await seeded(data);
    expect(modeOf(data)).toBe(0o700);
    const backup = json<BackupReport>(
      await run(["ledger", "backup", "--data-dir", data, "--json"], { cwd: dir.root, now: NOW }),
    );
    expect(modeOf(backup.file)).toBe(0o600);
    const entries = tarEntries(backup.file);
    expect(entries.length).toBeGreaterThan(10);
    for (const entry of entries) {
      expect(entry.mode, entry.name).toBe(entry.type === "5" ? 0o700 : 0o600);
    }
    const fresh = dir.path("fresh");
    json(await run(["ledger", "restore", backup.file, "--data-dir", fresh, "--json"]));
    expect(modeOf(fresh)).toBe(0o700);
    const loose = readdirSync(fresh, { recursive: true, withFileTypes: true }).filter(
      (entry) => (statSync(join(entry.parentPath, entry.name)).mode & 0o077) !== 0,
    );
    expect(loose.map((entry) => entry.name)).toEqual([]);
  });

  it("keeps the files private while the ledger is open, not only after it closes", async () => {
    const dir = tempDir("open");
    const data = dir.path("data");
    const ledger = await openLedger({ dataDir: data });
    try {
      expect(modeOf(data)).toBe(0o700);
      const loose = readdirSync(data, { recursive: true, withFileTypes: true }).filter(
        (entry) =>
          entry.isFile() && (statSync(join(entry.parentPath, entry.name)).mode & 0o077) !== 0,
      );
      expect(loose.map((entry) => entry.name)).toEqual([]);
    } finally {
      await ledger.close();
    }
  });

  it("fixes a ledger an earlier release left open to others, once, with a note", async () => {
    const dir = tempDir("loose");
    const data = dir.path("data");
    await seeded(data);
    chmodSync(data, 0o755);
    const file = join(data, "PG_VERSION");
    chmodSync(file, 0o666);
    const notes: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation((line) => notes.push(String(line)));
    try {
      await (await openLedger({ dataDir: data })).close();
      await (await openLedger({ dataDir: data })).close();
    } finally {
      error.mockRestore();
    }
    expect(modeOf(data)).toBe(0o700);
    expect(modeOf(file)).toBe(0o600);
    expect(notes).toEqual([
      expect.stringMatching(/was readable by other users; it is now private/),
    ]);
  });
});

describe("selfhost ledger commands wait for import --watch", () => {
  /** A watcher record as `selfhost import --watch` writes it, for a process that is alive. */
  function watching(configPath: string, dataDir?: string) {
    const feed = join(dirname(configPath), "feed");
    mkdirSync(feed, { recursive: true });
    writeFileSync(
      join(feed, "watcher.json"),
      JSON.stringify({
        schema: "selfhost.feed_watcher/v1",
        pid: process.ppid,
        started_at: NOW.toISOString(),
        ...(dataDir ? { data_dir: dataDir } : {}),
      }),
    );
  }

  it("refuses restore, backup, migrate and prune while a watcher holds the ledger", async () => {
    const dir = tempDir("busy");
    const data = dir.path("data");
    await seeded(data);
    const configPath = dir.path("selfhost", "config.json");
    const file = dir.path("backup.tar.gz");
    json(await run(["ledger", "backup", file, "--data-dir", data, "--json"], { configPath }));
    watching(configPath, data);
    for (const args of [
      ["restore", file, "--force"],
      ["backup", dir.path("again.tar.gz")],
      ["migrate"],
      ["prune", "--days", "1"],
    ]) {
      const result = await run(["ledger", ...args, "--data-dir", data], { configPath });
      expect(result.code, args[0]).toBe(1);
      expect(result.err).toMatch(
        new RegExp(
          `selfhost import --watch \\(pid ${process.ppid}\\) has the ledger at .* open, so selfhost ledger ${args[0]} was refused.*kill ${process.ppid}`,
        ),
      );
    }
    expect(existsSync(`${data}.before-restore-20261108T120000Z`)).toBe(false);
    // A watcher on another ledger, or one that is gone, does not hold this one.
    watching(configPath, dir.path("other"));
    json(
      await run(["ledger", "restore", file, "--force", "--data-dir", data, "--json"], {
        configPath,
      }),
    );
  });

  it("counts a watcher from an earlier release as holding the default ledger", async () => {
    const dir = tempDir("busy-default");
    const data = dir.path("data");
    await seeded(data);
    const configPath = dir.path("selfhost", "config.json");
    watching(configPath);
    const env = { SELFHOST_DATA_DIR: data };
    const result = await run(["ledger", "migrate"], { configPath, env });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/selfhost import --watch/);
  });
});

describe("selfhost ledger status and migrate", () => {
  it("rolls back to a version and upgrades again", async () => {
    const data = tempDir("migrate").path("data");
    await seeded(data);
    const [target, previous] = MIGRATIONS.slice(-3, -1).map((m) => m.version) as [string, string];
    const down = json<LedgerMigrateReport>(
      await run(["ledger", "migrate", "--to", target.slice(0, 4), "--data-dir", data, "--json"]),
    );
    expect(down).toMatchObject({
      rolled_back: [LATEST, previous],
      applied: [],
      current: target,
      pending: [previous, LATEST],
    });
    const up = await run(["ledger", "migrate", "--data-dir", data]);
    expect(up.out).toContain(`Applied ${previous}, ${LATEST}`);
    expect((await status(data)).pending).toEqual([]);
  });

  it("reports a schema from a newer release, and every command that opens it refuses", async () => {
    const data = tempDir("newer").path("data");
    await seeded(data);
    const db = await connect({ dataDir: data });
    await db.query("INSERT INTO schema_migrations (version) VALUES ('9999_newer')");
    await db.close();

    const text = await run(["ledger", "status", "--data-dir", data]);
    expect(text.out).toContain("From a newer release: 9999_newer.");
    for (const args of [["migrate"], ["migrate", "--to", "0"], ["prune"]]) {
      const result = await run(["ledger", ...args, "--data-dir", data]);
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.err).toContain(
        `The database schema is newer than this release: it has 9999_newer, and this release knows migrations up to ${LATEST}`,
      );
    }
  });
});

describe("selfhost ledger backup and restore --host", () => {
  function fakeSsh(output: string) {
    const calls: { command: string; args: string[] }[] = [];
    const exec = async (
      command: string,
      args: string[],
      options?: ExecOptions,
    ): Promise<ExecResult> => {
      calls.push({ command, args });
      // scp down: the file arrives at the last argument.
      const last = args.at(-1) ?? "";
      if (command === "scp" && last.endsWith(".partial")) writeFileSync(last, "PGDMP");
      const stdout = command === "ssh" ? output : "";
      for (const line of stdout.split("\n")) options?.onLine?.(line);
      return { code: 0, stdout, stderr: "" };
    };
    return { exec, calls };
  }

  it("runs backup.sh on the server and copies the dump here", async () => {
    const dir = tempDir("ssh-backup");
    const ssh = fakeSsh(
      "Backed up to backups/selfhost-20261108T120000Z.dump\nrows: events=12 schema_migrations=9 teams=1\n",
    );
    const result = json<BackupReport>(
      await run(["ledger", "backup", "--host", "ubuntu@203.0.113.10", "--port", "2222", "--json"], {
        cwd: dir.root,
        now: NOW,
        exec: ssh.exec,
      }),
    );
    expect(result).toEqual({
      schema: "selfhost.ledger_backup/v1",
      file: dir.path("selfhost-20261108T120000Z.dump"),
      ledger: "ubuntu@203.0.113.10:/opt/selfhost/deploy/docker",
      format: "pg_dump",
      rows: { events: 12, schema_migrations: 9, teams: 1 },
    });
    expect(readFileSync(result.file, "utf8")).toBe("PGDMP");
    const [backup, copy] = ssh.calls;
    expect(backup?.command).toBe("ssh");
    expect(backup?.args).toContain("BatchMode=yes");
    expect(backup?.args.slice(-2)).toEqual([
      "ubuntu@203.0.113.10",
      "cd /opt/selfhost/deploy/docker && sudo -n ./backup.sh backups/selfhost-20261108T120000Z.dump",
    ]);
    expect(copy?.command).toBe("scp");
    expect(copy?.args).toContain("-P");
    expect(copy?.args).not.toContain("-p");
    expect(copy?.args.slice(-2)).toEqual([
      "ubuntu@203.0.113.10:/opt/selfhost/deploy/docker/backups/selfhost-20261108T120000Z.dump",
      `${result.file}.partial`,
    ]);
  });

  it("copies the dump to the server and runs restore.sh there", async () => {
    const dir = tempDir("ssh-restore");
    const file = dir.write("selfhost.dump", "PGDMP");
    const ssh = fakeSsh("Restored /tmp/x.dump\nrows: events=12 teams=1\n");
    const result = await run(
      ["ledger", "restore", file, "--host", "root@203.0.113.10", "--force", "--dir", "/srv/stack"],
      { exec: ssh.exec },
    );
    expect(result.code).toBe(0);
    expect(result.out).toContain("Rows: events 12, teams 1");
    const [copy, restore] = ssh.calls;
    const remote = copy?.args.at(-1)?.replace("root@203.0.113.10:", "") ?? "";
    expect(copy?.args.at(-2)).toBe(file);
    expect(remote).toMatch(/^\/tmp\/selfhost-restore-[0-9a-f]{12}\.dump$/);
    expect(restore?.args.at(-1)).toBe(
      `cd /srv/stack && ./restore.sh --force ${remote}; code=$?; rm -f ${remote}; exit $code`,
    );
  });

  it("stops on a failed ssh with the server's last lines", async () => {
    const dir = tempDir("ssh-fail");
    const exec = async (command: string): Promise<ExecResult> =>
      command === "scp"
        ? { code: 0, stdout: "", stderr: "" }
        : {
            code: 1,
            stdout: "",
            stderr: "The database already holds 12 events. Rerun with --force to replace them.\n",
          };
    const file = dir.write("selfhost.dump", "PGDMP");
    const result = await run(["ledger", "restore", file, "--host", "203.0.113.10"], { exec });
    expect(result.code).toBe(1);
    expect(result.err).toContain("ssh failed (exit 1)");
    expect(result.err).toContain("| The database already holds 12 events.");
  });
});
