import { compareVersions } from "@selfhost/compile";
import { type EventVersionsFile, eventVersionsFile, maskSecrets } from "@selfhost/schema";
import {
  type Check,
  type RunResults,
  type SuiteRun,
  VENDORS,
  type VendorId,
  type VendorRun,
} from "./types.js";

export const PAGE_SCHEMA = "selfhost.vendor_compat/v1";

/** Versions kept per vendor on the page, newest first. */
export const MAX_VERSIONS = 30;

export type LiveStatus = "pass" | "fail" | "not_run";

export interface PageVersion {
  version: string;
  status: "passing" | "broken";
  live: LiveStatus;
  /** YYYY-MM-DD in UTC. */
  first_tested: string;
  last_tested: string;
  run_url: string | null;
  checks: Check[];
  unmodeled_events: string[];
  notes: string[];
}

export interface PageVendor {
  id: VendorId;
  name: string;
  /** The npm package or installer the CLI comes from. */
  source: string;
  versions: PageVersion[];
}

export interface PageData {
  schema: typeof PAGE_SCHEMA;
  /** When the last run finished, or null before the first one. */
  updated: string | null;
  run_url: string | null;
  event_schemas: EventVersionsFile;
  vendors: PageVendor[];
}

export interface IssueAction {
  action: "open" | "update" | "close";
  title: string;
  body: string;
}

const LIVE_CHECKS = new Set(["live-session", "live-hooks", "live-import"]);

export function emptyPage(): PageData {
  return {
    schema: PAGE_SCHEMA,
    updated: null,
    run_url: null,
    event_schemas: eventVersionsFile(),
    vendors: VENDORS.map((v) => ({
      id: v.id,
      name: v.name,
      source: v.npm ?? v.installer ?? "",
      versions: [],
    })),
  };
}

export function issueTitle(name: string, version: string): string {
  return `Vendor compatibility: ${name} ${version} is broken`;
}

function liveStatus(checks: Check[]): LiveStatus {
  const live = checks.filter((c) => LIVE_CHECKS.has(c.id));
  if (live.some((c) => c.status === "fail")) return "fail";
  return live.some((c) => c.id === "live-session" && c.status === "pass") ? "pass" : "not_run";
}

const masked = (check: Check): Check => ({ ...check, detail: maskSecrets(check.detail).text });

/** A vendor run's own checks plus the fixture suites that cover the vendor. */
export function versionChecks(run: VendorRun, suites: SuiteRun[]): Check[] {
  return [
    ...run.checks,
    ...suites
      .filter((suite) => suite.vendors.includes(run.vendor))
      .map((suite) => ({ id: `suite:${suite.id}`, status: suite.status, detail: suite.detail })),
  ].map(masked);
}

function issueBody(vendor: PageVendor, entry: PageVersion): string {
  const failed = entry.checks.filter((c) => c.status === "fail");
  return [
    `The scheduled vendor compatibility run found ${vendor.name} ${entry.version} (${vendor.source}) broken.`,
    "",
    entry.run_url ? `Run: ${entry.run_url}` : "",
    "",
    ...failed.flatMap((c) => [`### ${c.id}`, "", "```", c.detail, "```", ""]),
    "Fix within one day. Start from packages/vendor-compat/README.md: it says what each check covers and how to rerun it. The page marks the version passing, and this issue closes, once a run passes.",
  ]
    .filter((line, i, all) => !(line === "" && all[i - 1] === ""))
    .join("\n");
}

/**
 * Merges one run into the page data. Returns the new page and the issues to open for versions
 * that broke, update for versions still broken, and close for versions fixed since.
 */
export function mergeRun(
  page: PageData,
  results: RunResults,
  options: { now: Date; runUrl?: string },
): { page: PageData; issues: IssueAction[] } {
  const day = options.now.toISOString().slice(0, 10);
  const issues: IssueAction[] = [];
  const vendors = emptyPage().vendors.map((fresh) => {
    const old = page.vendors.find((v) => v.id === fresh.id);
    return { ...fresh, versions: [...(old?.versions ?? [])] };
  });
  for (const run of results.vendors) {
    const vendor = vendors.find((v) => v.id === run.vendor);
    if (!vendor) continue;
    const checks = versionChecks(run, results.suites);
    const previous = vendor.versions.find((v) => v.version === run.version);
    const entry: PageVersion = {
      version: run.version,
      status: checks.some((c) => c.status === "fail") ? "broken" : "passing",
      live: liveStatus(checks),
      first_tested: previous?.first_tested ?? day,
      last_tested: day,
      run_url: options.runUrl ?? null,
      checks,
      unmodeled_events: run.unmodeled ?? [],
      notes: run.notes ?? [],
    };
    vendor.versions = [entry, ...vendor.versions.filter((v) => v.version !== run.version)];
    const title = issueTitle(vendor.name, run.version);
    if (entry.status === "broken") {
      issues.push({
        action: previous?.status === "broken" ? "update" : "open",
        title,
        body: issueBody(vendor, entry),
      });
    } else if (previous?.status === "broken") {
      issues.push({
        action: "close",
        title,
        body: `Fixed: ${vendor.name} ${run.version} passes every check${entry.run_url ? ` in ${entry.run_url}` : ""}.`,
      });
    }
  }
  for (const vendor of vendors) {
    vendor.versions.sort((a, b) => compareVersions(b.version, a.version));
    vendor.versions = vendor.versions.slice(0, MAX_VERSIONS);
  }
  return {
    page: {
      schema: PAGE_SCHEMA,
      updated: options.now.toISOString(),
      run_url: options.runUrl ?? null,
      event_schemas: eventVersionsFile(),
      vendors,
    },
    issues,
  };
}
