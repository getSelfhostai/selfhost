// Records the registry responses the package guard tests replay, into fixtures/registries.
// Needs the network; run it on purpose, read the diff, then commit:
//
//   pnpm --filter @selfhost/package-guard capture
//
// Bodies keep only the fields the guard reads: maintainer names and emails, readmes and file
// lists are dropped. Values are as the registries returned them. Update RECORDED_AT in
// test/recorded.ts to the time of the capture, since tests measure package ages from it.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseConfig } from "@selfhost/schema";
import { checkCommand, type Fetch } from "../src/index.js";
import {
  CAPTURED_COMMANDS,
  fixturePath,
  RECORDED,
  type RecordedResponse,
} from "../test/recorded.js";

type Json = Record<string, unknown>;

function pick(value: Json, keys: string[]): Json {
  return Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, value[key]]));
}

/** The parts of a response body the guard reads. */
function trim(url: string, body: unknown): unknown {
  if (typeof body !== "object" || body === null) return body;
  const { host } = new URL(url);
  const value = body as Json;
  switch (host) {
    case "api.deps.dev":
      return {
        packageKey: value.packageKey,
        versions: ((value.versions ?? []) as Json[]).map((version) =>
          pick(version, ["versionKey", "publishedAt", "isDefault"]),
        ),
      };
    case "registry.npmjs.org":
      return pick(value, ["name", "version", "scripts", "gypfile"]);
    case "pypi.org":
      return {
        info: pick((value.info ?? {}) as Json, ["name", "version"]),
        urls: ((value.urls ?? []) as Json[]).map((file) =>
          pick(file, ["filename", "packagetype", "upload_time_iso_8601"]),
        ),
      };
    case "proxy.golang.org":
      return pick(value, ["Version", "Time"]);
    default:
      return body;
  }
}

const recording: Fetch = async (url, init) => {
  const response = await fetch(url, init);
  const text = init.method === "HEAD" ? "" : await response.text();
  let body: unknown;
  if (init.method !== "HEAD") {
    try {
      const parsed: unknown = JSON.parse(text);
      body = typeof parsed === "object" && parsed !== null ? trim(url, parsed) : text;
    } catch {
      body = text;
    }
  }
  const recorded: RecordedResponse = {
    status: response.status,
    ...(body !== undefined ? { body } : {}),
  };
  const file = join(RECORDED, fixturePath(init.method, url, init.body));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(recorded, null, 2)}\n`);
  console.log(`${response.status} ${init.method} ${url}`);
  return { status: response.status, text: async () => text };
};

const parsed = parseConfig(`version = 1
[packages]
mode = "enforce"
min_age_days = 60
`);
if (!parsed.ok) throw new Error("capture config does not validate");

for (const command of CAPTURED_COMMANDS) {
  const report = await checkCommand(command, parsed.config, {
    fetch: recording,
    now: () => new Date(),
    budgetMs: 60_000,
  });
  for (const install of report.installs) {
    for (const pkg of install.packages) {
      if (pkg.unchecked.length > 0)
        console.error(`unchecked ${pkg.name}: ${pkg.unchecked.join("; ")}`);
    }
  }
}
console.log(`Recorded at ${new Date().toISOString()}. Set RECORDED_AT in test/recorded.ts to it.`);
