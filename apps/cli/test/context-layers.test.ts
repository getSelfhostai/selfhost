import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Ledger, openLedger } from "@selfhost/ledger";
import type { ContextResponse } from "@selfhost/schema";
import { createApp } from "@selfhost/server/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blockNetwork } from "./network.js";
import { run, tempDir } from "./run.js";

/**
 * A team server and two joined laptops: the team's owner (lead) and a member (dev). The admin
 * sets the org layer, the lead the team layer, each laptop has its own repository and personal
 * items, and dev proposes a personal rule that the lead approves.
 */

const fixtures = join(import.meta.dirname, "..", "..", "..", "fixtures");
const SERVER = "http://team.test";
const ADMIN = "admin-token";
const LEAD = "lead@example.com";
const DEV = "dev@example.com";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

let ledger: Ledger;
let fetch: Fetch;

beforeEach(async () => {
  // The importers read the log folders from the process environment.
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(fixtures, "claude-code"));
  vi.stubEnv("CODEX_HOME", join(fixtures, "codex"));
  ledger = await openLedger({ dataDir: "memory://" });
  const app = createApp({ version: "test", ledger, token: ADMIN });
  fetch = async (url, init) => app.request(url, init);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await ledger.close();
});

const parse = (out: string) => JSON.parse(out);

async function admin(path: string, init: RequestInit = {}) {
  return fetch(`${SERVER}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
  });
}

function laptop(person: string) {
  const home = tempDir("layers-home");
  const repo = tempDir("layers-repo");
  const configPath = home.path(".selfhost", "config.json");
  const deps = { configPath, fetch, cwd: repo.root };
  return {
    person,
    repo,
    deps,
    personal: (relative: string, text: string) =>
      home.write(join(".selfhost", "context", "personal", relative), text),
    cli: (args: string[]) => run(args, deps),
    async sync() {
      const args = ["import", "--json", "--data-dir", "memory://", "--since", "2026-10-01"];
      const imported = await run([...args, "--person", person], deps);
      expect(imported.code).toBe(0);
      return parse(imported.out).sync;
    },
    async compile() {
      const compiled = await run(
        ["context", "compile", "--agent", "claude", "codex", "--json"],
        deps,
      );
      expect(compiled.err).toBe("");
      expect([compiled.code, compiled.code === 0 ? "" : compiled.out]).toEqual([0, ""]);
      return parse(compiled.out);
    },
    read: (relative: string) => readFileSync(repo.path(relative), "utf8"),
  };
}

const ORG_RULE = "Never print secrets, keys or tokens.";
const TEAM_COPY = "Secrets are fine in test fixtures.";

/** The admin's folders for the org layer and the lead's for the team layer. */
function layerFolders() {
  const folders = tempDir("layers-src");
  folders.write("org/rules/no-secrets.md", `${ORG_RULE}\n`);
  folders.write("team/rules/no-secrets.md", `${TEAM_COPY}\n`);
  folders.write("team/rules/review-style.md", "Review for behavior first, style last.\n");
  // The team's memory store, plugged in over MCP like any other server.
  folders.write(
    "team/mcp.json",
    JSON.stringify({
      mcpServers: { "team-memory": { type: "http", url: "https://memory.acme.dev/mcp" } },
    }),
  );
  return folders;
}

async function teamWithTwoLaptops() {
  const adminHome = tempDir("layers-admin");
  const adminDeps = {
    configPath: adminHome.path("config.json"),
    fetch,
    env: { SELFHOST_TOKEN: ADMIN },
  };
  const init = await run(
    ["team", "init", "--server", SERVER, "--name", "Web", "--json"],
    adminDeps,
  );
  expect(init.code).toBe(0);
  const { invite } = parse(init.out);
  const lead = laptop(LEAD);
  const dev = laptop(DEV);
  const joinLead = await lead.cli(["join", SERVER, invite, "--person", LEAD, "--json"]);
  expect(parse(joinLead.out)).toMatchObject({ role: "owner", context: { layers: [] } });
  const folders = layerFolders();
  const org = await run(
    ["context", "push", folders.path("org"), "--org", "default", "--server", SERVER, "--json"],
    { ...adminDeps, cwd: folders.root },
  );
  expect(org.code).toBe(0);
  expect(parse(org.out)).toMatchObject({ layer: "org", name: "default", files: 1 });
  const team = await lead.cli(["context", "push", folders.path("team"), "--json"]);
  expect(team.code).toBe(0);
  // The team's copy of the org rule is stored, and the push says the org floor replaces it.
  expect(parse(team.out)).toMatchObject({ layer: "team", name: "web", files: 3 });
  expect(parse(team.out).conflicts.map((c: { lost: { item: string } }) => c.lost.item)).toEqual([
    "rule:no-secrets",
  ]);
  const joinDev = await dev.cli(["join", SERVER, invite, "--person", DEV, "--json"]);
  expect(parse(joinDev.out)).toMatchObject({
    role: "member",
    context: {
      layers: [
        { kind: "org", name: "default", files: 1 },
        { kind: "team", name: "web", files: 3 },
      ],
    },
  });
  return { lead, dev, folders, adminDeps };
}

describe("org, team, repo and personal layers", () => {
  it("merge in order on each laptop, the org floor wins, and the lost items are named", async () => {
    const attempts = blockNetwork();
    const { dev } = await teamWithTwoLaptops();
    dev.repo.write(".selfhost/context/rules/repo-tests.md", "Run pnpm test before a commit.\n");
    dev.personal("rules/tabs.md", "Indent with tabs.\n");
    dev.personal("rules/review-style.md", "Skip reviews on Fridays.\n");
    dev.personal("mcp.json", JSON.stringify({ mcpServers: { notes: { command: "notes-mcp" } } }));

    const report = await dev.compile();
    expect(report.layers).toEqual([
      { kind: "org", name: "default" },
      { kind: "team", name: "web" },
      { kind: "repo", name: expect.any(String) },
      { kind: "personal", name: "personal" },
    ]);
    expect(
      report.layer_conflicts.map(
        (c: { lost: { item: string; layer: string }; kept: { layer: string } }) => [
          c.lost.item,
          c.lost.layer,
          c.kept.layer,
        ],
      ),
    ).toEqual([
      ["rule:no-secrets", "team", "org"],
      ["rule:review-style", "personal", "team"],
    ]);
    expect(report.layer_conflicts[0].message).toContain("the org floor, which always wins");

    const claude = dev.read("CLAUDE.md");
    const order = [
      ORG_RULE,
      "Review for behavior first",
      "Run pnpm test before a commit.",
      "Indent with tabs.",
    ].map((text) => claude.indexOf(text));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(claude).not.toContain(TEAM_COPY);
    expect(claude).not.toContain("Skip reviews on Fridays.");

    // The team memory server compiles into every agent like any other MCP server.
    expect(JSON.parse(dev.read(".mcp.json")).mcpServers).toMatchObject({
      "team-memory": { type: "http", url: "https://memory.acme.dev/mcp" },
      notes: { command: "notes-mcp" },
    });
    expect(dev.read(".codex/config.toml")).toContain("[mcp_servers.team-memory]");

    // CI checks the repository's own layer, which has none of the others.
    const check = await dev.cli(["context", "compile", "--no-layers", "--out", "ci", "--json"]);
    expect(parse(check.out).layers).toEqual([{ kind: "repo", name: expect.any(String) }]);
    expect(attempts).toEqual([]);
  });

  it("keeps personal items personal until an owner or admin approves a proposal", async () => {
    const attempts = blockNetwork();
    const { lead, dev } = await teamWithTwoLaptops();
    dev.personal("rules/tabs.md", "Indent with tabs.\n");
    await dev.compile();
    // The lead joined before the layers were set: the first sync pulls them.
    await lead.sync();
    await lead.compile();
    expect(dev.read("CLAUDE.md")).toContain("Indent with tabs.");
    expect(lead.read("CLAUDE.md")).not.toContain("Indent with tabs.");

    const proposed = await dev.cli(["context", "propose", "rule:tabs", "--json"]);
    expect(proposed.code).toBe(0);
    const { proposal, approve_command } = parse(proposed.out);
    expect(proposal).toMatchObject({ team: "web", person: DEV, item: "rule:tabs", state: "open" });
    expect(approve_command).toBe(`selfhost inbox approve ${proposal.id}`);
    const again = await dev.cli(["context", "propose", "rule:nothing", "--json"]);
    expect(again.code).toBe(1);
    expect(again.out).toContain("has no rule:nothing");

    // Not yet the team's: the lead's sync pulls no new item.
    expect((await lead.sync()).context_repos).toBeUndefined();
    expect(lead.read("CLAUDE.md")).not.toContain("Indent with tabs.");

    // A member cannot approve it, not even their own.
    const byMember = await dev.cli(["inbox", "approve", proposal.id, "--json"]);
    expect(byMember.code).toBe(1);
    expect(byMember.out).toContain("needs the owner or admin role in team web");

    const byOwner = await lead.cli(["inbox", "approve", proposal.id, "--json"]);
    expect(byOwner.code).toBe(0);
    expect(parse(byOwner.out)).toMatchObject({ outcome: "applied", item: { state: "answered" } });

    // The lead's next sync pulls the team layer with the rule and compiles the lead's repo again.
    const synced = await lead.sync();
    expect(synced.context_repos).toEqual([{ root: lead.repo.root, changed: expect.any(Number) }]);
    expect(lead.read("CLAUDE.md")).toContain("Indent with tabs.");

    const context = (await (await admin("/v1/context?team=web")).json()) as ContextResponse;
    expect(context.proposals[0]).toMatchObject({
      id: proposal.id,
      state: "applied",
      decided_by: LEAD,
    });
    expect(context.layers[1]?.files.map((f) => f.path)).toContain("rules/tabs.md");

    // On dev's laptop the team's copy now comes first, and the personal one is named as lost.
    await dev.sync();
    const report = await dev.compile();
    expect(report.layer_conflicts.map((c: { lost: { path: string } }) => c.lost.path)).toEqual([
      "team:web/rules/no-secrets.md",
      "personal/rules/tabs.md",
    ]);
    expect(attempts).toEqual([]);
  });

  it("refuses an approval by someone without the role and a deny, and never applies them", async () => {
    blockNetwork();
    const { dev } = await teamWithTwoLaptops();
    dev.personal("rules/tabs.md", "Indent with tabs.\n");
    dev.personal("rules/spaces.md", "Indent with spaces.\n");
    const tabs = parse((await dev.cli(["context", "propose", "rule:tabs", "--json"])).out).proposal;
    const spaces = parse(
      (await dev.cli(["context", "propose", "rule:spaces", "--json"])).out,
    ).proposal;
    // The admin token answers as the person it names; dev is a member, so it is not applied.
    const decide = (id: string, verdict: string, by: string) =>
      admin(`/v1/review-items/${id}/decision`, {
        method: "POST",
        body: JSON.stringify({ verdict, by }),
      });
    expect((await decide(tabs.id, "approve", DEV)).status).toBe(200);
    expect((await decide(spaces.id, "deny", LEAD)).status).toBe(200);
    const context = (await (await admin("/v1/context?team=web")).json()) as ContextResponse;
    expect(Object.fromEntries(context.proposals.map((p) => [p.item, [p.state, p.note]]))).toEqual({
      "rule:tabs": ["refused", `Approved by ${DEV}, who is not an owner or admin of team web.`],
      "rule:spaces": ["refused", `Denied by ${LEAD}.`],
    });
    expect(context.layers[1]?.files.map((f) => f.path)).not.toContain("rules/tabs.md");

    // An item the org or team layer has already cannot be proposed.
    dev.personal("rules/review-style.md", "Mine.\n");
    const taken = await dev.cli(["context", "propose", "rule:review-style", "--json"]);
    expect(taken.code).toBe(1);
    expect(taken.out).toContain("already has rule:review-style");
  });

  it("brings a change at any layer to a joined laptop on its next sync", async () => {
    blockNetwork();
    const { dev, folders, adminDeps } = await teamWithTwoLaptops();
    await dev.compile();
    expect(dev.read("CLAUDE.md")).toContain(ORG_RULE);

    folders.write("org/rules/no-secrets.md", "Never print or log secrets.\n");
    const pushed = await run(
      ["context", "push", folders.path("org"), "--org", "default", "--server", SERVER, "--json"],
      { ...adminDeps, cwd: folders.root },
    );
    expect(pushed.code).toBe(0);
    const synced = await dev.sync();
    expect(synced.context_repos).toEqual([{ root: dev.repo.root, changed: expect.any(Number) }]);
    expect(dev.read("CLAUDE.md")).toContain("Never print or log secrets.");

    // Leaving the team takes the pulled layers off the laptop; personal items stay.
    dev.personal("rules/tabs.md", "Indent with tabs.\n");
    await dev.cli(["team", "leave", "--json"]);
    const solo = await dev.compile();
    expect(solo.layers.map((l: { kind: string }) => l.kind)).toEqual(["repo", "personal"]);
    expect(existsSync(dev.repo.path("CLAUDE.md"))).toBe(true);
    expect(dev.read("CLAUDE.md")).not.toContain("Never print or log secrets.");
  });
});
