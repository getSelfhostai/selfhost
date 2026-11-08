#!/usr/bin/env node
// Finds the newest release of every vendor CLI in vendors.json and decides whether the
// compatibility run should go: with --force, or when a newest release is untested or broken on
// the compatibility page. No dependencies, so the scheduled release check needs no install.
//
// Usage: node packages/vendor-compat/scripts/latest.mjs [--force] [--github-output]
//
// Prints {"run": bool, "versions": {vendor: version}, "reasons": [...]} and, with
// --github-output, writes run and versions to $GITHUB_OUTPUT.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export const VENDORS = JSON.parse(
  readFileSync(new URL("../vendors.json", import.meta.url), "utf8"),
).vendors;

const PAGE_DATA = fileURLToPath(
  new URL("../../../docs/compatibility/compatibility.json", import.meta.url),
);

/** The version the Cursor installer script downloads. */
export function cursorVersion(script) {
  return script.match(/downloads\.cursor\.com\/lab\/([0-9][0-9A-Za-z.-]*)\//)?.[1];
}

async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.text();
}

/** The newest release of one vendor CLI. */
export async function latestVersion(vendor, get = fetchText) {
  if (vendor.npm) {
    const body = JSON.parse(await get(`https://registry.npmjs.org/${vendor.npm}/latest`));
    if (typeof body.version !== "string") throw new Error(`${vendor.npm}: no version in /latest`);
    return body.version;
  }
  const version = cursorVersion(await get(vendor.installer));
  if (!version) throw new Error(`${vendor.installer}: no download URL with a version`);
  return version;
}

/**
 * Which vendors to test: all of them when forced, else those whose newest release the page has
 * not tested or lists as broken. A vendor whose lookup failed is left out with a warning.
 */
export function plan(latest, page, force) {
  const versions = {};
  const reasons = [];
  for (const [id, found] of Object.entries(latest)) {
    if (found.error) {
      reasons.push(`${id}: ${found.error}, left out of this run`);
      continue;
    }
    versions[id] = found.version;
    const known = page?.vendors?.find((v) => v.id === id)?.versions ?? [];
    const entry = known.find((v) => v.version === found.version);
    if (!entry) reasons.push(`${id} ${found.version} is not tested yet`);
    else if (entry.status === "broken") reasons.push(`${id} ${found.version} is broken, retesting`);
  }
  const due = reasons.some((r) => !r.endsWith("left out of this run"));
  return {
    run: Object.keys(versions).length > 0 && (force || due),
    versions,
    reasons: force ? ["forced", ...reasons] : reasons,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force") || process.env.FORCE === "true";
  const latest = {};
  for (const vendor of VENDORS) {
    try {
      latest[vendor.id] = { version: await latestVersion(vendor) };
    } catch (error) {
      latest[vendor.id] = { error: error instanceof Error ? error.message : String(error) };
    }
  }
  const page = existsSync(PAGE_DATA) ? JSON.parse(readFileSync(PAGE_DATA, "utf8")) : undefined;
  const result = plan(latest, page, force);
  console.log(JSON.stringify(result, null, 2));
  for (const reason of result.reasons) {
    if (reason.endsWith("left out of this run")) console.log(`::warning::${reason}`);
  }
  if (args.includes("--github-output") && process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `run=${result.run}\nversions=${JSON.stringify(result.versions)}\n`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
