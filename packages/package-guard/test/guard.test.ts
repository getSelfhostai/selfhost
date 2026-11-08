import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, type ResolvedSelfhostConfig } from "@selfhost/schema";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkCommand,
  type Fetch,
  type GuardDeps,
  PACKAGE_ALTERNATIVES,
  type PackageReport,
  packageChecker,
  packageGuard,
  packageHits,
} from "../src/index.js";
import { RECORDED_AT, type Replay, replay } from "./recorded.js";

function config(packages: string): ResolvedSelfhostConfig {
  const result = parseConfig(`version = 1\n[packages]\n${packages}\n`);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.config;
}

const ENFORCE = config('mode = "enforce"\nmin_age_days = 60');

const replays: Replay[] = [];
const dirs: string[] = [];

/** A replay of the recorded responses; every test fails if it asked for one not recorded. */
function recorded(overrides: Parameters<typeof replay>[0] = {}): Replay {
  const r = replay(overrides);
  replays.push(r);
  return r;
}

afterEach(() => {
  for (const r of replays.splice(0)) expect(r.missing).toEqual([]);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function deps(fetch: Fetch, extra: Partial<GuardDeps> = {}): GuardDeps {
  return { fetch, now: () => RECORDED_AT, ...extra };
}

async function check(command: string, cfg = ENFORCE, extra: Partial<GuardDeps> = {}) {
  const r = recorded();
  const report = await checkCommand(command, cfg, deps(r.fetch, extra));
  return { report, hits: packageHits(report, cfg), calls: r.calls };
}

/** Each package as `name version: status [rule ids]`. */
function statuses(report: PackageReport): string[] {
  return report.installs.flatMap((install) =>
    install.packages.map((p) => {
      const rules = p.findings.map((f) => f.rule_id);
      return `${p.name}${p.version ? ` ${p.version}` : ""}: ${p.status}${rules.length ? ` ${rules.join(",")}` : ""}`;
    }),
  );
}

describe("npm", () => {
  it("passes old packages, flags install scripts and new versions, and blocks invented names", async () => {
    const { report, hits } = await check(
      "npm install left-pad bcrypt shell-quote @types/shell-quote@1.7.5 && npm i react-hooks-form-validator-pro",
    );
    expect(statuses(report)).toEqual([
      "left-pad 1.3.0: ok",
      "bcrypt 6.0.0: flagged packages.install_scripts",
      "shell-quote 1.12.0: flagged packages.too_new",
      "@types/shell-quote 1.7.5: ok",
      "react-hooks-form-validator-pro: blocked packages.not_found",
    ]);
    expect(hits).toEqual([
      {
        rule_id: "packages.not_found",
        mode: "enforce",
        verdict: "block",
        message:
          "npm has no package named react-hooks-form-validator-pro. Check the name: attackers register the names agents invent.",
        alternative: PACKAGE_ALTERNATIVES["packages.not_found"],
        irreversible: false,
      },
      {
        rule_id: "packages.too_new",
        mode: "enforce",
        verdict: "ask",
        message:
          "shell-quote 1.12.0 (npm) was published 36 days ago; [packages] min_age_days is 60.",
        alternative: PACKAGE_ALTERNATIVES["packages.too_new"],
        irreversible: false,
      },
      {
        rule_id: "packages.install_scripts",
        mode: "enforce",
        verdict: "ask",
        message: "bcrypt 6.0.0 (npm) runs code at install (install).",
        alternative: PACKAGE_ALTERNATIVES["packages.install_scripts"],
        irreversible: false,
      },
    ]);
  });

  it("resolves ranges, tags and aliases, and blocks a version that does not exist", async () => {
    const { report, hits } = await check(
      "npm i left-pad@^1.1.0 left-pad@latest lp@npm:left-pad@1.3.0 left-pad@9.9.9",
    );
    expect(statuses(report)).toEqual([
      "left-pad 1.3.0: ok",
      "left-pad 1.3.0: ok",
      "left-pad 1.3.0: ok",
      "left-pad: blocked packages.not_found",
    ]);
    expect(hits.map((h) => h.message)).toEqual(["npm has no version 9.9.9 of left-pad."]);
  });

  it("blocks a known malicious package even after the registry removed it", async () => {
    const { report, hits } = await check("npm i flatmap-stream@0.1.1");
    expect(statuses(report)).toEqual(["flatmap-stream: blocked packages.malicious"]);
    expect(hits).toMatchObject([
      {
        rule_id: "packages.malicious",
        verdict: "block",
        message: "flatmap-stream (npm) is known malware (MAL-2025-20690 on osv.dev).",
      },
    ]);
  });

  it.each([
    "npx -y cowsay hello",
    "pnpm dlx cowsay hello",
    "bunx cowsay hello",
    "yarn dlx cowsay hello",
    "pnpm add cowsay",
    "yarn add cowsay",
    "bun add cowsay",
  ])("checks the package %s installs", async (command) => {
    const { report, hits } = await check(command);
    expect(statuses(report)).toEqual(["cowsay 1.6.0: ok"]);
    expect(hits).toEqual([]);
  });

  it("flags a version so new deps.dev does not list it yet", async () => {
    const r = recorded({
      "GET https://api.deps.dev/v3/systems/npm/packages/left-pad": {
        status: 404,
        body: "package not found",
      },
    });
    const report = await checkCommand("npm i left-pad", ENFORCE, deps(r.fetch));
    expect(packageHits(report, ENFORCE)).toMatchObject([
      {
        rule_id: "packages.too_new",
        verdict: "ask",
        message:
          "left-pad 1.3.0 (npm) is so new that deps.dev does not list it yet; [packages] min_age_days is 60.",
      },
    ]);
  });
});

describe("PyPI", () => {
  it("passes wheels, flags sdist-only releases and blocks invented names", async () => {
    const { report, hits } = await check(
      "pip install requests==2.32.3 docopt flask-sqlalchemy-async-session-pro",
    );
    expect(statuses(report)).toEqual([
      "requests 2.32.3: ok",
      "docopt 0.6.2: flagged packages.install_scripts",
      "flask-sqlalchemy-async-session-pro: blocked packages.not_found",
    ]);
    expect(hits.map((h) => [h.rule_id, h.verdict, h.message])).toEqual([
      [
        "packages.not_found",
        "block",
        "PyPI has no package named flask-sqlalchemy-async-session-pro. Check the name: attackers register the names agents invent.",
      ],
      [
        "packages.install_scripts",
        "ask",
        "docopt 0.6.2 (PyPI) has no wheel, so installing it runs its build code.",
      ],
    ]);
  });

  it.each([
    ["uv add requests", "requests 2.34.2: ok"],
    ["python3 -m pip install requests==2.32.3", "requests 2.32.3: ok"],
    ["uv pip install 'requests[socks]==2.32.3'", "requests 2.32.3: ok"],
    ["poetry add docopt@0.6.2", "docopt 0.6.2: flagged packages.install_scripts"],
    ["pipx install docopt", "docopt 0.6.2: flagged packages.install_scripts"],
    ["uvx --from docopt docopt-cli", "docopt 0.6.2: flagged packages.install_scripts"],
  ])("checks %s", async (command, expected) => {
    const { report } = await check(command);
    expect(statuses(report)).toEqual([expected]);
  });
});

describe("crates.io", () => {
  it("resolves requirements, flags new crates and blocks invented names", async () => {
    const { report, hits } = await check("cargo add cfg-if itoa@1.0 tokio-retry-backoff-utils");
    expect(statuses(report)).toEqual([
      "cfg-if 1.0.5: flagged packages.too_new",
      "itoa 1.0.18: ok",
      "tokio-retry-backoff-utils: blocked packages.not_found",
    ]);
    expect(hits.map((h) => h.message)).toEqual([
      "crates.io has no crate named tokio-retry-backoff-utils. Check the name: attackers register the names agents invent.",
      "cfg-if 1.0.5 (crates.io) was published 52 days ago; [packages] min_age_days is 60.",
    ]);
  });

  it("installs exactly the version cargo install --version names", async () => {
    const { report } = await check("cargo install ripgrep --version 14.1.0");
    expect(statuses(report)).toEqual(["ripgrep 14.1.0: ok"]);
  });
});

describe("Go", () => {
  it("checks modules at a version and at latest", async () => {
    const { report, hits } = await check(
      "go get github.com/google/uuid@v1.6.0 golang.org/x/sync@latest",
    );
    expect(statuses(report)).toEqual([
      "github.com/google/uuid v1.6.0: ok",
      "golang.org/x/sync v0.24.0: flagged packages.too_new",
    ]);
    expect(hits.map((h) => h.message)).toEqual([
      "golang.org/x/sync v0.24.0 (Go) was published 45 days ago; [packages] min_age_days is 60.",
    ]);
  });

  it("finds the module a package path belongs to", async () => {
    const { report } = await check("go install github.com/pkg/errors/subpkg@v0.9.1");
    expect(statuses(report)).toEqual(["github.com/pkg/errors v0.9.1: ok"]);
  });

  it("blocks a module neither deps.dev nor the module proxy has", async () => {
    const { report, hits } = await check("go get github.com/gin-gonic/gin-jwt-middleware");
    expect(statuses(report)).toEqual([
      "github.com/gin-gonic/gin-jwt-middleware: blocked packages.not_found",
    ]);
    expect(hits[0]?.message).toBe(
      "No Go module provides github.com/gin-gonic/gin-jwt-middleware. Check the name: attackers register the names agents invent.",
    );
  });

  it("does not look up modules GOPRIVATE covers", async () => {
    const { report, calls } = await check(
      "GOPRIVATE=github.com/acme/* go get github.com/acme/internal",
    );
    expect(report.installs[0]?.packages[0]).toMatchObject({
      status: "skipped",
      note: "matches GOPRIVATE or GONOPROXY (github.com/acme/*)",
    });
    expect(calls).toEqual([]);
  });
});

describe("[packages] rules", () => {
  it("skips every check for packages on the allow list, with registry prefixes", async () => {
    const cfg = config(
      'mode = "enforce"\nmin_age_days = 60\nallow = ["react-hooks-form-*", "pypi:docopt", "cargo:docopt"]',
    );
    const { report, hits, calls } = await check(
      "npm i react-hooks-form-validator-pro && pip install docopt",
      cfg,
    );
    expect(statuses(report)).toEqual([
      "react-hooks-form-validator-pro: allowed",
      "docopt: allowed",
    ]);
    expect(report.installs[1]?.packages[0]?.note).toBe("on [packages] allow (pypi:docopt)");
    expect(hits).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("blocks denied packages without a lookup, and deny wins over allow", async () => {
    const cfg = config(
      'mode = "enforce"\nallow = ["left-*"]\ndeny = ["npm:left-pad", "pypi:bcrypt"]',
    );
    const { report, hits, calls } = await check("npm i left-pad", cfg);
    expect(statuses(report)).toEqual(["left-pad: blocked packages.deny"]);
    expect(hits).toMatchObject([
      {
        rule_id: "packages.deny",
        verdict: "block",
        message: "left-pad (npm) is in [packages] deny (npm:left-pad).",
      },
    ]);
    expect(calls).toEqual([]);
  });

  it("blocks installs from blocked registries, named or by default, and from blocked git hosts", async () => {
    const cfg = config(
      'mode = "enforce"\nblocked_registries = ["*.evil.example.com", "https://pypi.org/**", "crates.io"]',
    );
    const { report, hits, calls } = await check(
      "npm i x --registry https://npm.evil.example.com/ && pip install requests && cargo add serde && npm i git+https://git.evil.example.com/x.git",
      cfg,
    );
    expect(report.installs.map((i) => i.findings.map((f) => f.rule_id))).toEqual([
      ["packages.blocked_registry"],
      ["packages.blocked_registry"],
      ["packages.blocked_registry"],
      ["packages.blocked_registry"],
    ]);
    expect(hits).toEqual([
      {
        rule_id: "packages.blocked_registry",
        mode: "enforce",
        verdict: "block",
        message:
          "npm uses https://npm.evil.example.com/, which [packages] blocked_registries blocks (*.evil.example.com). pip uses https://pypi.org/simple/, which [packages] blocked_registries blocks (https://pypi.org/**). cargo uses crates.io, which [packages] blocked_registries blocks (crates.io). git+https://git.evil.example.com/x.git comes from git.evil.example.com, which [packages] blocked_registries blocks (*.evil.example.com).",
        alternative: PACKAGE_ALTERNATIVES["packages.blocked_registry"],
        irreversible: false,
      },
    ]);
    expect(calls).toEqual([]);
  });

  it("does not look up packages from a registry it cannot check", async () => {
    const { report, hits, calls } = await check(
      "pip install acme-internal --index-url https://pypi.acme.example.com/simple",
    );
    expect(report.installs[0]?.packages[0]).toMatchObject({
      status: "skipped",
      note: "installs through https://pypi.acme.example.com/simple, which the guard does not look up",
    });
    expect(hits).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("blocks or skips install scripts as install_scripts says", async () => {
    const block = config('mode = "enforce"\ninstall_scripts = "block"');
    expect((await check("npm i bcrypt", block)).hits).toMatchObject([
      { rule_id: "packages.install_scripts", verdict: "block" },
    ]);
    const allow = config('mode = "enforce"\ninstall_scripts = "allow"');
    expect((await check("npm i bcrypt && pip install docopt", allow)).hits).toEqual([]);
  });

  it("checks no age without min_age_days", async () => {
    const { hits } = await check("npm i shell-quote", config('mode = "enforce"'));
    expect(hits).toEqual([]);
  });

  it("records hits in observe mode, and does nothing in mode off", async () => {
    const observe = config("min_age_days = 60");
    expect((await check("npm i shell-quote", observe)).hits).toMatchObject([
      { rule_id: "packages.too_new", mode: "observe", verdict: "ask" },
    ]);
    const off = config('mode = "off"');
    const { report, hits, calls } = await check("npm i react-hooks-form-validator-pro", off);
    expect(report.installs).toEqual([]);
    expect(hits).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("failures", () => {
  it("fails open when the network is down, with an observe-only note", async () => {
    const down: Fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const report = await checkCommand(
      "npm i left-pad && go get github.com/google/uuid",
      ENFORCE,
      deps(down),
    );
    expect(statuses(report)).toEqual(["left-pad: unchecked", "github.com/google/uuid: unchecked"]);
    expect(packageHits(report, ENFORCE)).toEqual([
      {
        rule_id: "packages.unchecked",
        mode: "observe",
        verdict: "ask",
        message:
          "Could not fully check left-pad (npm), github.com/google/uuid (Go): deps.dev could not be reached (fetch failed); the npm registry could not be reached (fetch failed); osv.dev could not be reached (fetch failed). They were not blocked.",
        irreversible: false,
      },
    ]);
  });

  it("gives up on registries that do not answer within the time budget", async () => {
    const hang: Fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const started = Date.now();
    const report = await checkCommand(
      "pip install requests",
      ENFORCE,
      deps(hang, { budgetMs: 50 }),
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(packageHits(report, ENFORCE)).toMatchObject([
      {
        rule_id: "packages.unchecked",
        mode: "observe",
        message:
          "Could not fully check requests (PyPI): deps.dev did not answer within 50 ms; osv.dev did not answer within 50 ms. It was not blocked.",
      },
    ]);
  });

  it("reports a server error as unchecked and keeps what it did learn", async () => {
    const r = recorded({
      "POST https://api.osv.dev/v1/querybatch": { status: 503, body: "unavailable" },
    });
    const report = await checkCommand("npm i shell-quote", ENFORCE, deps(r.fetch));
    expect(statuses(report)).toEqual(["shell-quote 1.12.0: flagged packages.too_new"]);
    expect(report.installs[0]?.packages[0]?.unchecked).toEqual(["osv.dev answered HTTP 503"]);
    expect(packageHits(report, ENFORCE).map((h) => [h.rule_id, h.mode])).toEqual([
      ["packages.too_new", "enforce"],
      ["packages.unchecked", "observe"],
    ]);
  });
});

describe("cache", () => {
  function cacheDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "selfhost-package-guard-"));
    dirs.push(dir);
    return dir;
  }

  it("answers from disk in a later process, until each lookup expires", async () => {
    const dir = cacheDir();
    const first = recorded();
    await checkCommand(
      "npm i left-pad react-hooks-form-validator-pro",
      ENFORCE,
      deps(first.fetch, { cacheDir: dir }),
    );
    expect(first.calls.length).toBeGreaterThan(0);
    expect(readdirSync(dir).length).toBeGreaterThan(0);

    // A new guard with no network gets the same answer from the files.
    const down: Fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const again = await checkCommand(
      "npm i left-pad react-hooks-form-validator-pro",
      ENFORCE,
      deps(down, { cacheDir: dir }),
    );
    expect(statuses(again)).toEqual([
      "left-pad 1.3.0: ok",
      "react-hooks-form-validator-pro: blocked packages.not_found",
    ]);

    // Eleven minutes on, the missing name is asked about again; left-pad still comes from disk.
    const later = recorded();
    const at = new Date(RECORDED_AT.getTime() + 11 * 60_000);
    await checkCommand(
      "npm i left-pad react-hooks-form-validator-pro",
      ENFORCE,
      deps(later.fetch, { cacheDir: dir, now: () => at }),
    );
    expect(later.calls.sort()).toEqual([
      "GET https://api.deps.dev/v3/systems/npm/packages/react-hooks-form-validator-pro",
      "GET https://registry.npmjs.org/react-hooks-form-validator-pro/latest",
    ]);

    // Two hours on, the package list and the advisories are fetched again too.
    const hours = recorded();
    const twoHours = new Date(RECORDED_AT.getTime() + 2 * 3_600_000);
    await checkCommand(
      "npm i left-pad",
      ENFORCE,
      deps(hours.fetch, { cacheDir: dir, now: () => twoHours }),
    );
    expect(hours.calls.sort()).toEqual([
      "GET https://api.deps.dev/v3/systems/npm/packages/left-pad",
      "GET https://registry.npmjs.org/left-pad/latest",
      "POST https://api.osv.dev/v1/querybatch",
    ]);
  });

  it("fetches a package asked for twice in one command once", async () => {
    const { calls } = await check("npm i left-pad && pnpm add left-pad");
    expect(calls.filter((c) => c.includes("deps.dev"))).toHaveLength(1);
  });
});

describe("packageGuard", () => {
  it("checks the command of a tool call and keeps its cache between calls", async () => {
    const r = recorded();
    const guard = packageGuard(ENFORCE, deps(r.fetch));
    const call = { agent: "claude_code" as const, tool: "Bash", command: "npm i shell-quote" };
    expect(await guard(call)).toMatchObject([{ rule_id: "packages.too_new" }]);
    const made = r.calls.length;
    expect(await guard(call)).toMatchObject([{ rule_id: "packages.too_new" }]);
    expect(r.calls.length).toBe(made);
  });

  it("returns nothing, without a lookup, for calls that install nothing", async () => {
    const r = recorded();
    const guard = packageGuard(ENFORCE, deps(r.fetch));
    expect(await guard({ tool: "Edit", path: "src/index.ts" })).toEqual([]);
    expect(await guard({ tool: "Bash", command: "npm test && git status" })).toEqual([]);
    expect(r.calls).toEqual([]);
  });

  it("also comes in the evaluator's (call, config) shape", async () => {
    const r = recorded();
    const checker = packageChecker(deps(r.fetch));
    const call = { tool: "exec_command", command: "pip install docopt" };
    expect(await checker(call, ENFORCE)).toMatchObject([{ rule_id: "packages.install_scripts" }]);
    expect(await checker(call, config('mode = "off"'))).toEqual([]);
  });
});
