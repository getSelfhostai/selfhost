import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { connectCheck } from "./connect.js";
import { installVendor } from "./install.js";
import { live } from "./live.js";
import { renderPage } from "./page.js";
import { probe } from "./probe.js";
import { emptyPage, mergeRun, type PageData } from "./report.js";
import { runSuite, SUITES } from "./suites.js";
import { REPO_ROOT, RUN_SCHEMA, type RunResults, vendorById } from "./types.js";

const USAGE = `Usage: pnpm --filter @selfhost/vendor-compat compat <command> [options]

  install --versions '{"claude_code":"2.1.319"}' --dir <dir> --results <file>
  probe   --results <file>           offline checks of each installed CLI
  suites  --results <file>           fixture suites through hooks, importers and compilers
  connect --results <file>           each CLI with gateway connect's settings, against a local stand-in gateway
  live    --results <file>           real sessions where ANTHROPIC_API_KEY / OPENAI_API_KEY are set
  report  --results <file> [--out docs/compatibility] [--run-url <url>] [--issues <file>]
  page    [--out docs/compatibility] rewrite index.html from compatibility.json

Paths are absolute or relative to the repository root.`;

const DEFAULT_OUT = join(REPO_ROOT, "docs", "compatibility");

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    versions: { type: "string" },
    dir: { type: "string" },
    results: { type: "string" },
    out: { type: "string" },
    "run-url": { type: "string" },
    issues: { type: "string" },
  },
});

const path = (value: string | undefined, name: string) => {
  if (!value) throw new Error(`--${name} is required\n\n${USAGE}`);
  return resolve(REPO_ROOT, value);
};

function readResults(file: string): RunResults {
  if (!existsSync(file)) {
    return { schema: RUN_SCHEMA, started: new Date().toISOString(), vendors: [], suites: [] };
  }
  return JSON.parse(readFileSync(file, "utf8")) as RunResults;
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function printChecks(results: RunResults): void {
  for (const vendor of results.vendors) {
    console.log(`${vendor.vendor} ${vendor.version}`);
    for (const check of vendor.checks) {
      console.log(`  ${check.status.padEnd(4)} ${check.id}: ${check.detail.split("\n")[0]}`);
    }
  }
  for (const suite of results.suites) console.log(`suite ${suite.status} ${suite.id}`);
}

function readPage(out: string): PageData {
  const file = join(out, "compatibility.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as PageData) : emptyPage();
}

function writePage(out: string, page: PageData): void {
  writeJson(join(out, "compatibility.json"), page);
  writeFileSync(join(out, "index.html"), renderPage(page));
}

async function main(): Promise<void> {
  const [command] = positionals;
  if (command === "page") {
    const out = values.out ? resolve(REPO_ROOT, values.out) : DEFAULT_OUT;
    writePage(out, readPage(out));
    return;
  }
  const resultsFile = path(values.results, "results");
  const results = readResults(resultsFile);
  switch (command) {
    case "install": {
      const versions = JSON.parse(values.versions ?? "{}") as Record<string, string>;
      const dir = path(values.dir, "dir");
      for (const [id, version] of Object.entries(versions)) {
        const installed = await installVendor(vendorById(id), version, dir);
        results.vendors = [...results.vendors.filter((v) => v.vendor !== id), installed];
      }
      break;
    }
    case "probe":
      results.vendors = results.vendors.map(probe);
      break;
    case "suites":
      results.suites = SUITES.map(runSuite);
      break;
    case "connect":
      for (const vendor of results.vendors) await connectCheck(vendor);
      break;
    case "live":
      for (const vendor of results.vendors) await live(vendor);
      break;
    case "report": {
      const out = values.out ? resolve(REPO_ROOT, values.out) : DEFAULT_OUT;
      const { page, issues } = mergeRun(readPage(out), results, {
        now: new Date(),
        ...(values["run-url"] ? { runUrl: values["run-url"] } : {}),
      });
      writePage(out, page);
      if (values.issues) writeJson(resolve(REPO_ROOT, values.issues), issues);
      for (const issue of issues) console.log(`${issue.action}: ${issue.title}`);
      return;
    }
    default:
      throw new Error(`Unknown command ${command ?? "(none)"}\n\n${USAGE}`);
  }
  writeJson(resultsFile, results);
  printChecks(results);
}

await main();
