import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { openLedger } from "@selfhost/ledger";
import { parseConfig } from "@selfhost/schema";
import { parse as parseToml } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MigrateConductorReport } from "../src/migrate/commands.js";
import { tomlString } from "../src/migrate/toml.js";
import { blockNetwork } from "./network.js";
import { run, tempDir } from "./run.js";

const fixtures = join(import.meta.dirname, "..", "..", "..", "fixtures", "conductor");
const EXPORT = join(fixtures, "export");
const NOW = new Date("2026-11-08T12:00:00Z");
const PERSON = "dev@example.com";

/** Copies the fixture repositories into a temporary folder, each one a git repository. */
function repos() {
  const dir = tempDir("migrate");
  cpSync(join(fixtures, "repos"), dir.root, { recursive: true });
  for (const name of readdirSync(dir.root)) mkdirSync(dir.path(name, ".git"));
  const config = tempDir("migrate-home");
  const migrate = (cwd: string, ...args: string[]) =>
    run(["migrate", "conductor", ...args], {
      cwd,
      now: NOW,
      env: { SELFHOST_PERSON: PERSON },
      configPath: config.path("config.json"),
    });
  return { dir, migrate, home: config };
}

/** Every file under the root (but .git) with its content hash, to prove nothing changed. */
function snapshot(root: string, skip: (name: string) => boolean = () => false) {
  const files: Record<string, string> = {};
  for (const name of readdirSync(root, { recursive: true, encoding: "utf8" }).sort()) {
    if (name.startsWith(".git") || skip(name)) continue;
    const path = join(root, name);
    if (lstatSync(path).isFile()) {
      files[name] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  }
  return files;
}

const report = (out: string) => JSON.parse(out) as MigrateConductorReport;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("selfhost migrate conductor", () => {
  it("--dry-run prints the mapping and the selfhost.toml diff, and writes nothing", async () => {
    const { dir, migrate } = repos();
    const before = snapshot(dir.root);
    const result = await migrate(dir.path("acme-web"), "--dry-run");
    expect(result.code).toBe(0);
    expect(snapshot(dir.root)).toEqual(before);
    const lines = result.out.split("\n");
    expect(lines[0]).toBe("Dry run: nothing is written.");
    expect(lines).toContain("  Read .conductor/settings.toml.");
    expect(result.out).toMatch(
      /^ {2}Not read: conductor\.json \(Conductor ignores it while \.conductor\/settings\.toml exists\)\. It sets scripts\.setup, scripts\.run, runScriptMode\.$/m,
    );
    expect(result.out).toMatch(
      /^ {2}Not read: \.conductor\/settings\.local\.toml \(personal overrides .*\)\. It sets scripts\.run\.web\.command, scripts\.run\.web\.default, environment_variables\.ANTHROPIC_BASE_URL\.$/m,
    );
    expect(result.out).not.toContain("127.0.0.1:4000");
    expect(result.out).not.toContain("replace-me");
    expect(result.out).toMatch(
      /^ {4}scripts\.run_mode +runtime\.run_mode +nonconcurrent is exclusive$/m,
    );
    expect(result.out).toMatch(
      /^ {4}environment_variables\.STRIPE_SECRET_KEY +looks like a secret/m,
    );
    expect(result.out).toContain("  Would add [runtime] to the end of selfhost.toml.");
    expect(result.out).toContain("    +[runtime.run.web]");
    expect(result.out).toContain("  Conductor's files are unchanged.");
    expect(result.out).toMatch(/^History\n {2}No history export given/m);
  });

  it("adds [runtime] after the existing selfhost.toml, byte for byte, and leaves Conductor's files alone", async () => {
    const { dir, migrate } = repos();
    const repo = dir.path("acme-web");
    const original = readFileSync(join(repo, "selfhost.toml"), "utf8");
    const conductor = snapshot(repo, (name) => name === "selfhost.toml");
    const result = await migrate(repo, "--json");
    expect(result.code).toBe(0);
    expect(snapshot(repo, (name) => name === "selfhost.toml")).toEqual(conductor);

    const text = readFileSync(join(repo, "selfhost.toml"), "utf8");
    expect(text.startsWith(`${original}\n# How each agent workspace`)).toBe(true);
    const parsed = parseConfig(text);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    expect(parsed.config.rules.map((rule) => rule.id)).toEqual(["no-prod-env"]);
    expect(parsed.config.runtime).toEqual({
      setup: 'pnpm install\ncp "$SELFHOST_ROOT_PATH/.env.local" .env.local\n./script/setup-db.sh\n',
      archive: "./script/workspace-archive.sh",
      run_mode: "exclusive",
      run: {
        web: { command: "pnpm dev --port $SELFHOST_PORT", default: true },
        api: { command: 'pnpm api --port "$((SELFHOST_PORT + 1))"', cwd: "services/api" },
        "e2e tests": { command: `pnpm test:e2e --base-url http://localhost:\${SELFHOST_PORT}` },
        sync: { command: 'curl -fsS "$CONDUCTOR_API_URL/v0/projects"' },
      },
      env: {
        API_BASE_URL: "http://localhost:$SELFHOST_PORT",
        LOG_LEVEL: "debug",
        CONDUCTOR_WORKSPACE_NAME: `\${SELFHOST_WORKSPACE_NAME}`,
        CONDUCTOR_PORT: `\${SELFHOST_PORT}`,
      },
    });
    expect(text).toContain("# Moved from Conductor's .conductor/settings.toml by selfhost");
    expect(text).toContain(
      "# Conductor names still read by script/setup-db.sh, script/workspace-archive.sh.",
    );
    expect(text).not.toContain("replace-me");

    const json = report(result.out);
    const [entry] = json.repos;
    expect(entry?.source).toEqual({ path: ".conductor/settings.toml", format: "settings.toml" });
    expect(entry?.config).toMatchObject({ path: join(repo, "selfhost.toml"), action: "updated" });
    expect(entry?.conductor_files.map((file) => [file.path, file.read, file.unchanged])).toEqual([
      [".conductor/settings.toml", true, true],
      [".conductor/settings.local.toml", false, true],
      ["conductor.json", false, true],
    ]);
    expect(entry?.mapped.map((item) => [item.from, item.to])).toEqual([
      ["scripts.setup", "runtime.setup"],
      ["scripts.archive", "runtime.archive"],
      ["scripts.run_mode", "runtime.run_mode"],
      ["scripts.run.web", "runtime.run.web"],
      ["scripts.run.api", "runtime.run.api"],
      ['scripts.run."e2e tests"', 'runtime.run."e2e tests"'],
      ["scripts.run.sync", "runtime.run.sync"],
      ["environment_variables.API_BASE_URL", "runtime.env.API_BASE_URL"],
      ["environment_variables.LOG_LEVEL", "runtime.env.LOG_LEVEL"],
    ]);
    expect(entry?.mapped.find((item) => item.from === "scripts.run.api")?.note).toBe(
      "options.cwd is cwd; args appended to the command",
    );
    expect(entry?.not_mapped.map((item) => item.key)).toEqual([
      "enterprise_data_privacy",
      "file_include_globs",
      "scripts.auto_run_after_setup",
      "scripts.run.web.icon",
      "scripts.run.api.available_in",
      "scripts.run.api.icon",
      'scripts.run."e2e tests".icon',
      'scripts.run."e2e tests".hide',
      "scripts.run.sync.available_in",
      "environment_variables.STRIPE_SECRET_KEY",
      "environment_variables.local.LOCAL_AGENT_MODE",
      "environment_variables.cloud.OPENAI_BASE_URL",
      "prompts.general",
      "git.archive_on_merge",
      "git.branch_prefix",
      "preview_urls",
    ]);
    expect(entry?.unknown).toEqual(["notify_on_finish", "scripts.teardown"]);
    expect(
      entry?.variables.map((use) => [use.name, use.to, use.where, use.files, use.reason !== null]),
    ).toEqual([
      ["CONDUCTOR_API_URL", null, ["scripts.run.sync"], [], true],
      ["CONDUCTOR_IS_LOCAL", null, [], ["script/setup-db.sh"], true],
      [
        "CONDUCTOR_PORT",
        "SELFHOST_PORT",
        [
          "scripts.run.web",
          "scripts.run.api",
          'scripts.run."e2e tests"',
          "environment_variables.API_BASE_URL",
        ],
        ["script/setup-db.sh"],
        false,
      ],
      ["CONDUCTOR_ROOT_PATH", "SELFHOST_ROOT_PATH", ["scripts.setup"], [], false],
      [
        "CONDUCTOR_WORKSPACE_NAME",
        "SELFHOST_WORKSPACE_NAME",
        [],
        ["script/setup-db.sh", "script/workspace-archive.sh"],
        false,
      ],
    ]);
    expect(json.history).toMatchObject({ path: null, status: "none" });
  });

  it("finds nothing new on a second run, and keeps a different [runtime] unless --force", async () => {
    const { dir, migrate } = repos();
    const repo = dir.path("acme-web");
    expect((await migrate(repo)).code).toBe(0);
    const again = await migrate(repo);
    expect(again.code).toBe(0);
    expect(again.out).toContain(
      "  No change to selfhost.toml: its [runtime] already holds these settings.",
    );

    const path = join(repo, "selfhost.toml");
    const edited = readFileSync(path, "utf8").replace('LOG_LEVEL = "debug"', 'LOG_LEVEL = "info"');
    writeFileSync(path, `${edited}\n# Notes for whoever edits this next.\n`);
    const kept = await migrate(repo);
    expect(kept.code).toBe(1);
    expect(kept.out).toContain(
      "  Left selfhost.toml as is: it already has a different [runtime]. Pass --force to replace it.",
    );
    expect(readFileSync(path, "utf8")).toBe(`${edited}\n# Notes for whoever edits this next.\n`);

    const forced = await migrate(repo, "--force");
    expect(forced.code).toBe(0);
    expect(forced.out).toContain("  Replaced [runtime] in selfhost.toml.");
    const text = readFileSync(path, "utf8");
    const parsed = parseConfig(text);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    expect(parsed.config.runtime?.env?.LOG_LEVEL).toBe("debug");
    expect(parsed.config.rules.map((rule) => rule.id)).toEqual(["no-prod-env"]);
    expect(text.match(/^\[runtime\]$/gm)).toHaveLength(1);
    expect(text.match(/# How each agent workspace/g)).toHaveLength(1);
    expect(text).toContain("# Notes for whoever edits this next.");
  });

  it("creates selfhost.toml from a legacy conductor.json", async () => {
    const { dir, migrate } = repos();
    const repo = dir.path("legacy-api");
    const result = await migrate(repo, "--json");
    expect(result.code).toBe(0);
    const [entry] = report(result.out).repos;
    expect(entry?.source).toEqual({ path: "conductor.json", format: "conductor.json" });
    expect(entry?.config?.action).toBe("created");
    expect(entry?.mapped.map((item) => [item.from, item.to, item.note])).toEqual([
      ["scripts.setup", "runtime.setup", null],
      ["scripts.run", "runtime.run.dev", "a single run command, named dev"],
      ["scripts.archive", "runtime.archive", null],
      ["runScriptMode", "runtime.run_mode", null],
    ]);
    expect(entry?.not_mapped.map((item) => item.key)).toEqual(["enterpriseDataPrivacy"]);
    const text = readFileSync(join(repo, "selfhost.toml"), "utf8");
    expect(text.split("\n")[0]).toBe("#:schema https://selfhost.ai/schema/selfhost.toml.v1.json");
    const parsed = parseConfig(text);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    expect(parsed.config.runtime).toEqual({
      setup: "pnpm install",
      archive: "./script/workspace-archive.sh",
      run_mode: "concurrent",
      run: { dev: { command: "pnpm dev --port $SELFHOST_PORT", default: true } },
    });
  });

  it("says so when a repository has no Conductor settings, and writes nothing there", async () => {
    const { dir, migrate } = repos();
    const repo = dir.path("no-settings");
    const result = await migrate(join(repo, ".git"));
    expect(result.code).toBe(0);
    expect(result.out).toContain("  No Conductor settings here: no .conductor/settings.toml");
    expect(result.out).toContain("Scripts set only in the Conductor app");
    expect(existsSync(join(repo, "selfhost.toml"))).toBe(false);
  });

  it("migrates several repositories with --repo and needs a repository without it", async () => {
    const { dir, migrate } = repos();
    const result = await migrate(dir.root, "--repo", "acme-web", "legacy-api", "--json");
    expect(result.code).toBe(0);
    expect(report(result.out).repos.map((entry) => [entry.repo, entry.config?.action])).toEqual([
      [dir.path("acme-web"), "updated"],
      [dir.path("legacy-api"), "created"],
    ]);
    const outside = await migrate(dir.root);
    expect(outside.code).toBe(1);
    expect(outside.err).toMatch(/Not in a git repository/);
  });

  it("reads .conductor/settings.json and refuses an invalid selfhost.toml without touching it", async () => {
    const { dir, migrate } = repos();
    const repo = dir.path("no-settings");
    dir.write(
      "no-settings/.conductor/settings.json",
      JSON.stringify({ scripts: { setup: "make deps", run: { app: { command: "make run" } } } }),
    );
    const created = await migrate(repo, "--json");
    expect(report(created.out).repos[0]?.source?.format).toBe("settings.json");
    const parsed = parseConfig(readFileSync(join(repo, "selfhost.toml"), "utf8"));
    expect(parsed.ok && parsed.config.runtime).toEqual({
      setup: "make deps",
      run_mode: "concurrent",
      run: { app: { command: "make run" } },
    });

    const legacy = dir.path("legacy-api");
    writeFileSync(join(legacy, "selfhost.toml"), "version = 1\n[ledger]\nretention = 3\n");
    const refused = await migrate(legacy);
    expect(refused.code).toBe(1);
    expect(refused.out).toMatch(/Error: .*selfhost\.toml is invalid/);
    expect(refused.out).toContain("ledger.retention");
    expect(readFileSync(join(legacy, "selfhost.toml"), "utf8")).toBe(
      "version = 1\n[ledger]\nretention = 3\n",
    );
  });

  it("moves the shared settings when a file it does not move fails to parse, and stops when that one does", async () => {
    const { dir, migrate } = repos();
    const repo = dir.path("acme-web");
    dir.write("acme-web/.conductor/settings.local.toml", "[scripts\nbroken");
    // Outside the repository: a symlinked script is not read.
    const outside = tempDir("migrate-outside").write("leak.sh", "echo $CONDUCTOR_SESSION_ID\n");
    symlinkSync(outside, join(repo, "script", "linked.sh"));
    const settings = readFileSync(join(repo, ".conductor", "settings.toml"), "utf8");
    writeFileSync(
      join(repo, ".conductor", "settings.toml"),
      settings.replace("./script/setup-db.sh\n", "./script/setup-db.sh\n./script/linked.sh\n"),
    );
    const result = await migrate(repo, "--json");
    expect(result.code).toBe(0);
    const [entry] = report(result.out).repos;
    expect(entry?.conductor_files.find((file) => file.role === "local")?.reason).toMatch(
      /^it could not be parsed: /,
    );
    expect(entry?.variables.map((use) => use.name)).not.toContain("CONDUCTOR_SESSION_ID");

    writeFileSync(join(repo, ".conductor", "settings.toml"), "[scripts]\nsetup = ");
    const broken = await migrate(repo);
    expect(broken.code).toBe(1);
    expect(broken.out).toMatch(/Error: \.conductor\/settings\.toml could not be parsed: /);
  });

  it("keeps CRLF line endings and writes scripts as one-line strings there", async () => {
    const { dir, migrate } = repos();
    const repo = dir.path("acme-web");
    const crlf = readFileSync(join(repo, "selfhost.toml"), "utf8").replaceAll("\n", "\r\n");
    writeFileSync(join(repo, "selfhost.toml"), crlf);
    expect((await migrate(repo)).code).toBe(0);
    const text = readFileSync(join(repo, "selfhost.toml"), "utf8");
    expect(text.startsWith(crlf)).toBe(true);
    expect(text.replaceAll("\r\n", "")).not.toContain("\n");
    expect(text).toContain(
      'setup = "pnpm install\\ncp \\"$SELFHOST_ROOT_PATH/.env.local\\" .env.local\\n./script/setup-db.sh\\n"',
    );
    expect(parseConfig(text).ok).toBe(true);
  });

  it("imports a history export once, and the second run finds only duplicates", async () => {
    const { dir, migrate, home } = repos();
    const dataDir = home.path("data");
    const attempts = blockNetwork();
    const args = ["--history", EXPORT, "--data-dir", dataDir, "--prompts", "--json"];
    const first = report((await migrate(dir.path("acme-web"), ...args)).out);
    expect(first.history).toMatchObject({
      path: EXPORT,
      status: "imported",
      files: 5,
      workspaces: 3,
      sessions: 5,
      messages: 14,
      events: 13,
      accepted: 13,
      duplicates: 0,
      skipped: [{ path: "session ses_porto_2", reason: "no timestamp in the export" }],
    });
    const second = await migrate(dir.path("acme-web"), ...args);
    expect(second.code).toBe(0);
    expect(report(second.out).history).toMatchObject({ accepted: 0, duplicates: 13 });
    expect(attempts).toEqual([]);

    const ledger = await openLedger({ dataDir });
    try {
      const page = await ledger.query({ kind: "session.started" });
      expect(page.events.map((event) => [event.session_id, event.ts, event.actor.id])).toEqual([
        ["ses_osaka_1", "2026-11-05T16:00:00.000Z", PERSON],
        ["ses_porto_1", "2026-11-02T14:00:00.000Z", PERSON],
        ["ses_lisbon_2", "2026-10-21T08:00:00.000Z", PERSON],
        ["ses_lisbon_1", "2026-10-20T09:01:00.000Z", PERSON],
      ]);
    } finally {
      await ledger.close();
    }
  });

  it("counts a history export in a dry run, and fails plainly on one it cannot read", async () => {
    const { dir, migrate, home } = repos();
    const dry = await migrate(dir.path("acme-web"), "--dry-run", "--history", EXPORT);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain(
      "  Would import 8 events from 5 sessions in 3 workspaces (14 messages, 5 files) into",
    );
    expect(existsSync(home.path("data"))).toBe(false);

    const empty = tempDir("migrate-empty");
    empty.write("account.json", JSON.stringify({ email: "dev@example.com", plan: "pro" }));
    const nothing = await migrate(dir.path("acme-web"), "--history", empty.root);
    expect(nothing.code).toBe(1);
    expect(nothing.out).toContain("found no Conductor session with a timestamp");
    expect(nothing.out).toContain("Conductor does not publish its export format");
    // The scripts were still moved.
    expect(readFileSync(dir.path("acme-web", "selfhost.toml"), "utf8")).toContain("[runtime]");

    const zip = await migrate(dir.path("legacy-api"), "--history", "export.zip");
    expect(zip.code).toBe(1);
    expect(zip.out).toMatch(/export\.zip is a zip archive\. Unpack it first/);
  });

  it("--undo puts each selfhost.toml back, and leaves one that was edited since", async () => {
    const { dir, migrate } = repos();
    const acme = dir.path("acme-web");
    const original = readFileSync(join(acme, "selfhost.toml"), "utf8");
    await migrate(dir.root, "--repo", "acme-web", "legacy-api");
    await migrate(dir.root, "--repo", "acme-web");

    const dry = await migrate(dir.root, "--undo", "--dry-run");
    expect(dry.out).toContain("Would restore acme-web/selfhost.toml byte for byte.");
    expect(dry.out).toContain("Would delete legacy-api/selfhost.toml, which migrate created.");
    expect(existsSync(dir.path("legacy-api", "selfhost.toml"))).toBe(true);

    writeFileSync(
      dir.path("legacy-api", "selfhost.toml"),
      `${readFileSync(dir.path("legacy-api", "selfhost.toml"), "utf8")}# mine\n`,
    );
    const undone = await migrate(dir.root, "--undo");
    expect(undone.code).toBe(1);
    expect(undone.out).toContain("Restored acme-web/selfhost.toml byte for byte.");
    expect(undone.out).toContain(
      "Left legacy-api/selfhost.toml as is: it was edited after migrate wrote it.",
    );
    expect(readFileSync(join(acme, "selfhost.toml"), "utf8")).toBe(original);
    expect(existsSync(dir.path("legacy-api", "selfhost.toml"))).toBe(true);
  });
});

describe("tomlString", () => {
  it.each([
    "pnpm dev",
    'cp "$A/.env" .env',
    "echo 'single' \"double\"",
    "line one\nline two\n",
    "ends with a quote'",
    "has '''three''' quotes\nand a newline",
    "tab\there and a bell \u0007",
    "back\\slash",
  ])("reads back %j", (text) => {
    expect(parseToml(`v = ${tomlString(text)}`).v).toBe(text);
  });
});
