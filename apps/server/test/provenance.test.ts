import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Ledger, openLedger } from "@selfhost/ledger";
import {
  type CreateTeamResponse,
  createValidator,
  EVENT_SCHEMA,
  type JoinResponse,
  type LedgerEvent,
  parseConfig,
  type TeamProvenance,
  type TeamProvenanceModules,
  TeamProvenanceModulesSchema,
  TeamProvenanceSchema,
} from "@selfhost/schema";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { cloneModuleReverts } from "../src/github-risk.js";
import { clonesUnder } from "../src/provenance.js";
import { caller, TOKEN } from "./helpers.js";

const NOW = new Date("2026-11-08T00:00:00Z");
const day = (days: number) =>
  new Date(Date.parse("2026-10-01T09:00:00Z") + days * 86_400_000).toISOString();
const rows = (n: number, prefix: string) =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}\n`).join("");

/** acme/api cloned at <root>/acme/api: an agent's 60 lines in lib/, reverted two days later. */
function cloneFixture(root: string) {
  process.env.GIT_CONFIG_GLOBAL = devNull;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  const dir = join(root, "acme", "api");
  mkdirSync(dir, { recursive: true });
  const git = (args: string[], at = day(0)) =>
    execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Dev",
        GIT_AUTHOR_EMAIL: "dev@example.com",
        GIT_AUTHOR_DATE: at,
        GIT_COMMITTER_NAME: "Dev",
        GIT_COMMITTER_EMAIL: "dev@example.com",
        GIT_COMMITTER_DATE: at,
      },
    }).trim();
  const commit = (message: string, at: string, files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
      git(["add", path], at);
    }
    git(["commit", "-q", "-m", message], at);
    return git(["rev-parse", "HEAD"]);
  };
  git(["init", "-q", "-b", "main"]);
  commit("Initial", day(0), { "src/app.ts": rows(10, "app") });
  const money = commit("Add money", day(1), { "lib/money.ts": rows(60, "money") });
  git(["revert", "--no-edit", money], day(3));
  const routes = commit("Add routes", day(4), { "src/routes.ts": rows(20, "route") });
  return { money, routes };
}

let n = 0;
const event = (fields: Partial<LedgerEvent> & Pick<LedgerEvent, "kind" | "ts">): LedgerEvent => ({
  id: `01930c4e-2f1a-7b2c-9d3e-${(++n).toString(16).padStart(12, "0")}`,
  schema: EVENT_SCHEMA,
  source: "hook",
  actor: { kind: "agent", id: "claude_code:session:s1" },
  ...fields,
});

describe("GET /v1/teams/{team}/provenance", () => {
  let ledger: Ledger;
  let app: Hono;
  let clones: string;
  let shas: { money: string; routes: string };
  const as = {} as Record<"lead" | "outsider", ReturnType<typeof caller>>;

  beforeAll(async () => {
    clones = mkdtempSync(join(tmpdir(), "selfhost-clones-"));
    shas = cloneFixture(clones);
    ledger = await openLedger({ dataDir: "memory://" });
    app = createApp({
      version: "test",
      ledger,
      token: TOKEN,
      now: () => NOW,
      clones: clonesUnder(clones),
    });
    const admin = caller(app, TOKEN);
    const team = async (name: string) =>
      (await (await admin("/v1/teams", "POST", { name })).json()) as CreateTeamResponse;
    const joinTeam = async (invite: string, person: string) => {
      const res = await app.request("/v1/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invite, person }),
      });
      return ((await res.json()) as JoinResponse).token;
    };
    const web = await team("Web");
    const data = await team("Data");
    as.lead = caller(app, await joinTeam(web.invite, "lead@example.com"));
    as.outsider = caller(app, await joinTeam(data.invite, "dora@example.com"));
    for (const remote of ["https://github.com/acme/api.git", "acme/site"]) {
      expect((await as.lead("/v1/teams/web/repos", "POST", { remote })).status).toBe(201);
    }
    expect(
      (
        await as.lead("/v1/events", "POST", {
          events: [
            // The run that made the money commit recorded it.
            event({
              kind: "commit.created",
              ts: day(1),
              session_id: "s1",
              agent: { vendor: "claude_code" },
              model: "claude-opus-4-5",
              repo: "acme/api",
              links: { commit_sha: shas.money.slice(0, 7) },
            }),
            // acme/site has no clone: its merged pull request is all the server knows.
            event({
              kind: "pr.merged",
              source: "github",
              ts: day(5),
              repo: "acme/site",
              actor: { kind: "person", id: "lead@example.com" },
              agent: { vendor: "codex" },
              links: { pr_url: "https://github.com/acme/site/pull/2" },
              data: { number: 2, additions: 42 },
            }),
          ],
        })
      ).status,
    ).toBe(200);
  });

  afterAll(async () => {
    await ledger.close();
    rmSync(clones, { recursive: true, force: true });
  });

  it("reports each repo of the team: line by line from a clone, from the ledger without one", async () => {
    const res = await as.lead("/v1/teams/web/provenance?from=2026-10-01T00:00:00Z");
    expect(res.status).toBe(200);
    const body = (await res.json()) as TeamProvenance;
    const valid = createValidator(TeamProvenanceSchema).validate(body);
    expect(valid.ok ? [] : valid.errors).toEqual([]);
    expect(body).toMatchObject({ team: "web", from: "2026-10-01T00:00:00.000Z" });
    expect(body.to).toBe("2026-11-08T00:00:00.000Z");
    const [api, site] = body.repos;
    expect(api).toMatchObject({ repo: "acme/api", status: "computed", branch: "main", note: null });
    expect(
      api?.by_agent.map((r) => [r.vendor, r.model, r.lines, r.runs, r.reverted_lines]),
    ).toEqual([
      ["claude_code", "claude-opus-4-5", 60, 1, 60],
      ["unattributed", null, 30, 0, 0],
    ]);
    expect(site).toMatchObject({
      repo: "acme/site",
      status: "ledger_only",
      modules: [],
      totals: { lines: 42, agent_lines: 42, agent_revert_rework_rate: null },
    });
    expect(site?.note).toContain("no clone of acme/site");
  });

  it("ranks the team's modules by agent-written lines across its repos", async () => {
    const res = await as.lead("/v1/teams/web/provenance/modules?from=2026-10-01T00:00:00Z");
    const body = (await res.json()) as TeamProvenanceModules;
    const valid = createValidator(TeamProvenanceModulesSchema).validate(body);
    expect(valid.ok ? [] : valid.errors).toEqual([]);
    expect(body.threshold).toBe(0.25);
    expect(
      body.modules.map((m) => [m.rank, m.repo, m.module, m.agent_lines, m.above_threshold]),
    ).toEqual([
      [1, "acme/api", "lib", 60, true],
      [2, "acme/api", "src", 0, false],
    ]);
  });

  it("narrows to one repo of the team and refuses others", async () => {
    const one = (await (
      await as.lead("/v1/teams/web/provenance?repo=acme/site&from=2026-10-01T00:00:00Z")
    ).json()) as TeamProvenance;
    expect(one.repos.map((r) => r.repo)).toEqual(["acme/site"]);
    const other = await as.lead("/v1/teams/web/provenance?repo=acme/other");
    expect(other.status).toBe(404);
    const backwards = await as.lead(
      "/v1/teams/web/provenance?from=2026-11-01T00:00:00Z&to=2026-10-01T00:00:00Z",
    );
    expect(backwards.status).toBe(400);
  });

  it("is for people in the team and the admin token only", async () => {
    const res = await as.outsider("/v1/teams/web/provenance");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      "You are not in team web.",
    );
    expect((await caller(app, TOKEN)("/v1/teams/web/provenance")).status).toBe(200);
  });

  it("feeds the module revert rate of the touched modules into the GitHub risk score", async () => {
    const config = parseConfig("version = 1\n");
    if (!config.ok) throw new Error("defaults");
    const ctx = {
      pull: { owner: "Acme", repo: "api" } as Parameters<typeof cloneModuleReverts>[1]["pull"],
      config: config.config,
    };
    const files = [{ path: "lib/round.ts" }, { path: "src/app.ts" }];
    expect(
      await cloneModuleReverts(clonesUnder(clones), ctx, files, 90, { ledger, now: NOW }),
    ).toEqual({
      days: 90,
      modules: [
        { module: "lib", agentLines: 60, rate: 1 },
        { module: "src", agentLines: 0, rate: null },
      ],
    });
    expect(await cloneModuleReverts(undefined, ctx, files, 90, { now: NOW })).toBe(
      "the server has no clone of acme/api (SELFHOST_GIT_CLONES)",
    );
  });
});
