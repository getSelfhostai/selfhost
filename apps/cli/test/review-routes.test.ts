import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mapClaudeCodeHook, openLedger } from "@selfhost/ledger";
import { describe, expect, it } from "vitest";
import type { ReviewListReport } from "../src/review-list.js";
import type { ReviewRoutesReport } from "../src/review-routes.js";
import { run, tempDir } from "./run.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures");
const ROUTES = join(FIXTURES, "routing", "selfhost.toml");
const NOW = new Date("2026-11-10T10:00:00.000Z");

describe("selfhost review routes", () => {
  it("explains every route for a pull request described by flags, as JSON", async () => {
    const dir = tempDir("routes");
    const result = await run(
      ["review", "routes", "-c", ROUTES, "--path", "db/schema.sql", "--risk", "40", "--json"],
      { cwd: dir.root },
    );
    expect(result.err).toBe("");
    const report = JSON.parse(result.out) as ReviewRoutesReport;
    expect(report.schema).toBe("selfhost.review_routes/v1");
    expect(report.input).toEqual({ kind: "pr", paths: ["db/schema.sql"], risk: 40 });
    expect(report.routing).toMatchObject({
      owners: ["dba@example.com"],
      route: { step: "route", id: "prod-db", why: "kind pr, path db/schema.sql" },
    });
    expect(report.routes.map((route) => [route.id, route.matched, route.empty ?? ""])).toEqual([
      ["prod-db", true, ""],
      ["db-admins", true, "role:admin needs a team server, which knows each person's role"],
      ["guardrails", false, ""],
      ["payments-high", false, ""],
      ["deploys", false, ""],
      ["docs", false, ""],
    ]);
    // On a laptop the admins are unknown, so nobody answering sends it to the fallback.
    expect(report.escalation).toEqual(["[review] fallback"]);
  });

  it("says when there is no CODEOWNERS file, and which route a team server would use", async () => {
    const dir = tempDir("routes-none");
    dir.write(".git/HEAD", "ref: refs/heads/main\n");
    dir.write(
      "selfhost.toml",
      [
        "version = 1",
        "[[review.routes]]",
        'id = "owners"',
        'to = ["codeowners"]',
        "[[review.routes]]",
        'id = "high-risk"',
        "min_risk = 80",
        'to = ["role:admin"]',
        "",
      ].join("\n"),
    );
    const result = await run(["review", "routes", "--risk", "80"], { cwd: dir.root });
    expect(result.out).toContain(
      "1. owners: matches (every item) but names nobody here: No CODEOWNERS file in the repository (.github/CODEOWNERS, CODEOWNERS, docs/CODEOWNERS)",
    );
    expect(result.out).toContain(
      'On the team server, which knows each person\'s role, [[review.routes]] "high-risk" takes it.',
    );
  });

  it("prints why each route matched or not, who gets it and where it escalates", async () => {
    const dir = tempDir("routes");
    const result = await run(
      ["review", "routes", "-c", ROUTES, "--kind", "approval", "--tool", "mcp__deploy__release"],
      { cwd: dir.root },
    );
    expect(result.out.split("\n")).toEqual([
      "approval, tool mcp__deploy__release, 0 files",
      "",
      "[[review.routes]], checked in order:",
      "  1. prod-db: no match, the item names no files",
      "  2. db-admins: no match, the item names no files",
      "  3. guardrails: no match, no rule raised the item",
      "  4. payments-high: no match, the item names no repo",
      "  5. deploys: matches (kind approval, tool mcp__deploy__release) -> pat@example.com, sam@example.com",
      "  6. docs: no match, kind approval is not pr",
      "",
      'Goes to pat@example.com, sam@example.com, from [[review.routes]] "deploys" (kind approval, tool mcp__deploy__release).',
    ]);
  });

  it("reads an item from the local review list with --item", async () => {
    const dir = tempDir("routes");
    const dataDir = dir.path("data");
    const ledger = await openLedger({ dataDir });
    const notification = JSON.parse(
      readFileSync(join(FIXTURES, "hooks", "claude-code", "Notification.json"), "utf8"),
    ) as Record<string, unknown>;
    await ledger.append(
      mapClaudeCodeHook(notification, {
        ts: "2026-11-10T09:50:00.000Z",
        person: "dev@example.com",
      }),
    );
    await ledger.close();
    const listed = await run(["review", "list", "-c", ROUTES, "--data-dir", dataDir, "--json"], {
      cwd: dir.root,
      now: NOW,
    });
    const [item] = (JSON.parse(listed.out) as ReviewListReport).items;
    const result = await run(
      ["review", "routes", "-c", ROUTES, "--data-dir", dataDir, "--item", item?.id ?? "", "--json"],
      { cwd: dir.root },
    );
    const report = JSON.parse(result.out) as ReviewRoutesReport;
    expect(report.item).toBe(item?.id);
    expect(report.input).toMatchObject({ kind: "approval", tool: "Bash" });
    expect(report.routing.route.step).toBe("owner");
    expect(report.routing.owners).toEqual(item?.owners);
  });

  it("refuses an unknown kind and a risk out of range", async () => {
    const dir = tempDir("routes");
    const kind = await run(["review", "routes", "-c", ROUTES, "--kind", "nope"], { cwd: dir.root });
    expect(kind.code).toBe(1);
    expect(kind.err).toMatch(/--kind: expected one of pr, approval/);
    const risk = await run(["review", "routes", "-c", ROUTES, "--risk", "101"], { cwd: dir.root });
    expect(risk.err).toMatch(/--risk: expected a score from 0 to 100/);
  });
});
