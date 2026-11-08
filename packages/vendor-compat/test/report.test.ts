import { describe, expect, it } from "vitest";
import { renderPage } from "../src/page.js";
import { emptyPage, issueTitle, MAX_VERSIONS, mergeRun, type PageData } from "../src/report.js";
import { type Check, RUN_SCHEMA, type RunResults, type VendorRun } from "../src/types.js";

const pass = (id: string): Check => ({ id, status: "pass", detail: `${id} ok` });
const NOW = {
  now: new Date("2026-11-08T06:30:00Z"),
  runUrl: "https://github.com/o/r/actions/runs/7",
};

function vendorRun(vendor: VendorRun["vendor"], version: string, checks: Check[]): VendorRun {
  return { vendor, version, checks: [pass("install"), pass("version"), ...checks] };
}

function results(vendors: VendorRun[], suites: RunResults["suites"] = []): RunResults {
  return { schema: RUN_SCHEMA, started: NOW.now.toISOString(), vendors, suites };
}

const versionsOf = (page: PageData, id: string) =>
  page.vendors.find((v) => v.id === id)?.versions ?? [];

describe("mergeRun", () => {
  it("adds a passing version with no issue", () => {
    const { page, issues } = mergeRun(
      emptyPage(),
      results([vendorRun("codex", "0.167.0", [pass("hook-events")])]),
      NOW,
    );
    expect(issues).toEqual([]);
    expect(versionsOf(page, "codex")).toEqual([
      expect.objectContaining({
        version: "0.167.0",
        status: "passing",
        live: "not_run",
        first_tested: "2026-11-08",
        last_tested: "2026-11-08",
        run_url: NOW.runUrl,
      }),
    ]);
    expect(page.updated).toBe("2026-11-08T06:30:00.000Z");
  });

  it("marks a failing version broken, opens an issue, then updates and closes it", () => {
    const failing = vendorRun("claude_code", "2.1.320", [
      { id: "hook-events", status: "fail", detail: "claude doctor no longer lists: PreCompact" },
    ]);
    const first = mergeRun(emptyPage(), results([failing]), NOW);
    expect(versionsOf(first.page, "claude_code")[0]?.status).toBe("broken");
    expect(first.issues).toEqual([
      {
        action: "open",
        title: issueTitle("Claude Code", "2.1.320"),
        body: expect.stringContaining("claude doctor no longer lists: PreCompact"),
      },
    ]);
    expect(first.issues[0]?.body).toContain(NOW.runUrl);

    const later = { now: new Date("2026-11-09T06:30:00Z") };
    const second = mergeRun(first.page, results([failing]), later);
    expect(second.issues.map((i) => i.action)).toEqual(["update"]);

    const fixed = vendorRun("claude_code", "2.1.320", [pass("hook-events")]);
    const third = mergeRun(second.page, results([fixed]), later);
    expect(third.issues).toEqual([
      expect.objectContaining({ action: "close", title: issueTitle("Claude Code", "2.1.320") }),
    ]);
    expect(versionsOf(third.page, "claude_code")[0]).toMatchObject({
      status: "passing",
      first_tested: "2026-11-08",
      last_tested: "2026-11-09",
    });
  });

  it("never marks a version broken for a skipped check", () => {
    const run = vendorRun("codex", "0.167.0", [
      { id: "config", status: "skip", detail: "Needs root" },
      { id: "live-session", status: "skip", detail: "No OPENAI_API_KEY secret" },
    ]);
    const { page, issues } = mergeRun(emptyPage(), results([run]), NOW);
    expect(versionsOf(page, "codex")[0]).toMatchObject({ status: "passing", live: "not_run" });
    expect(issues).toEqual([]);
  });

  it("charges a failing fixture suite to the vendors it covers only", () => {
    const { page } = mergeRun(
      emptyPage(),
      results(
        [vendorRun("codex", "0.167.0", []), vendorRun("opencode", "1.19.5", [])],
        [
          {
            id: "importers",
            command: "pnpm --filter @selfhost/importers test",
            vendors: ["claude_code", "codex"],
            status: "fail",
            detail: "importers failed",
          },
        ],
      ),
      NOW,
    );
    expect(versionsOf(page, "codex")[0]?.status).toBe("broken");
    expect(versionsOf(page, "codex")[0]?.checks.at(-1)).toEqual({
      id: "suite:importers",
      status: "fail",
      detail: "importers failed",
    });
    expect(versionsOf(page, "opencode")[0]?.status).toBe("passing");
  });

  it("records the live session result", () => {
    const live = (status: Check["status"], hooks: Check["status"]) =>
      vendorRun("claude_code", "2.1.319", [
        { id: "live-session", status, detail: "" },
        ...(status === "pass" ? [{ id: "live-hooks", status: hooks, detail: "" }] : []),
      ]);
    const statusOf = (run: VendorRun) =>
      versionsOf(mergeRun(emptyPage(), results([run]), NOW).page, "claude_code")[0]?.live;
    expect(statusOf(live("pass", "pass"))).toBe("pass");
    expect(statusOf(live("pass", "fail"))).toBe("fail");
    expect(statusOf(live("skip", "skip"))).toBe("not_run");
  });

  it("masks secret-shaped text in check details", () => {
    const key = ["sk", "ant", "api03", "Q".repeat(40)].join("-");
    const run = vendorRun("claude_code", "2.1.319", [
      { id: "live-session", status: "fail", detail: `refused ${key}` },
    ]);
    const { page, issues } = mergeRun(emptyPage(), results([run]), NOW);
    expect(JSON.stringify(page)).not.toContain(key);
    expect(issues[0]?.body).not.toContain(key);
  });

  it("keeps the newest versions first, up to the cap", () => {
    let page = emptyPage();
    for (let i = 0; i < MAX_VERSIONS + 5; i++) {
      page = mergeRun(page, results([vendorRun("opencode", `1.${i}.0`, [])]), NOW).page;
    }
    const versions = versionsOf(page, "opencode").map((v) => v.version);
    expect(versions).toHaveLength(MAX_VERSIONS);
    expect(versions[0]).toBe(`1.${MAX_VERSIONS + 4}.0`);
    expect(versions.at(-1)).toBe("1.5.0");
  });
});

describe("renderPage", () => {
  it("shows untested vendors, versions, statuses and event schemas, with no em dash", () => {
    const run = vendorRun("codex", "0.167.0", [
      { id: "hook-fields", status: "fail", detail: "Not found in the CLI: <turn_id>" },
    ]);
    const html = renderPage(mergeRun(emptyPage(), results([run]), NOW).page);
    expect(html).not.toContain("\u2014");
    expect(html).toContain("<title>Vendor compatibility</title>");
    expect(html).toContain("Not tested yet");
    expect(html).toContain("<code>0.167.0</code>");
    expect(html).toContain("Failed: hook-fields");
    expect(html).toContain("Not found in the CLI: &lt;turn_id&gt;");
    expect(html).toContain("<code>selfhost.event/v1</code>");
    expect(html).not.toContain("<turn_id>");
  });
});
