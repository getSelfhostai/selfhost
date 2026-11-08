import type { PageData, PageVendor, PageVersion } from "./report.js";

// The compatibility page: one static HTML file next to compatibility.json, rewritten by every
// scheduled run. Plain HTML and CSS, no scripts, so it can be hosted anywhere as it is.

const html = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const STATUS_LABEL = { passing: "Passing", broken: "Broken" } as const;
const LIVE_LABEL = { pass: "Passed", fail: "Failed", not_run: "Not run" } as const;
const CHECK_LABEL = { pass: "pass", fail: "fail", skip: "skipped" } as const;

const CHECKS_EXPLAINED: [string, string][] = [
  ["install", "The release installs from its npm package or the vendor's download, on Linux x64."],
  ["version", "The installed CLI runs and reports the version that was installed."],
  [
    "hook-events",
    "Every hook event selfhost installs hooks for is still offered. For Claude Code the list comes from claude doctor; the events it offers that selfhost has no schema for are listed as not modeled.",
  ],
  [
    "hook-fields",
    "The payload fields selfhost reads and the answer fields it writes still appear in the CLI.",
  ],
  [
    "tool-inputs",
    "Claude Code's own sdk-tools.d.ts still declares the tool input fields the pre-tool check reads.",
  ],
  [
    "config",
    "The CLI loads the configuration selfhost policy compile writes for that release: claude doctor for Claude Code settings, codex features list for Codex requirements.toml.",
  ],
  [
    "suite:*",
    "Fixture sessions and hook payloads through selfhost's schemas, hook mappers, log importers, the selfhost hook command, and the policy and context compilers.",
  ],
  [
    "live-*",
    "With an API key in CI: a short real session with every hook capturing its payload, checked against the schemas, mapped to ledger events, and the session log imported.",
  ],
];

function cls(status: string): string {
  return `status status-${status.replace("_", "-")}`;
}

function failedSummary(entry: PageVersion): string {
  const failed = entry.checks.filter((c) => c.status === "fail").map((c) => c.id);
  return failed.length > 0 ? `Failed: ${failed.join(", ")}` : "";
}

function versionDetails(entry: PageVersion): string {
  const rows = entry.checks
    .map(
      (c) =>
        `<tr><td><code>${html(c.id)}</code></td><td><span class="${cls(c.status)}">${CHECK_LABEL[c.status]}</span></td><td><pre>${html(c.detail)}</pre></td></tr>`,
    )
    .join("\n");
  const extra = [
    entry.unmodeled_events.length > 0
      ? `<p>Hook events not modeled by selfhost yet: ${entry.unmodeled_events.map((e) => `<code>${html(e)}</code>`).join(", ")}</p>`
      : "",
    ...entry.notes.map((note) => `<p>${html(note)}</p>`),
    entry.run_url ? `<p><a href="${html(entry.run_url)}">CI run</a></p>` : "",
  ].join("\n");
  return `<details><summary>Checks</summary>
<table class="checks"><thead><tr><th>Check</th><th>Result</th><th>Detail</th></tr></thead>
<tbody>
${rows}
</tbody></table>
${extra}
</details>`;
}

function vendorSection(vendor: PageVendor): string {
  if (vendor.versions.length === 0) {
    return `<section id="${vendor.id}"><h2>${html(vendor.name)}</h2>
<p class="muted">Source: <code>${html(vendor.source)}</code>. Not tested yet.</p></section>`;
  }
  const rows = vendor.versions
    .map(
      (v) => `<tr>
<td><code>${html(v.version)}</code></td>
<td><span class="${cls(v.status)}">${STATUS_LABEL[v.status]}</span> <span class="muted">${html(failedSummary(v))}</span></td>
<td><span class="${cls(v.live)}">${LIVE_LABEL[v.live]}</span></td>
<td>${html(v.first_tested)}</td>
<td>${html(v.last_tested)}</td>
<td>${versionDetails(v)}</td>
</tr>`,
    )
    .join("\n");
  return `<section id="${vendor.id}"><h2>${html(vendor.name)}</h2>
<p class="muted">Source: <code>${html(vendor.source)}</code></p>
<div class="scroll"><table>
<thead><tr><th>Version</th><th>Status</th><th>Live session</th><th>First tested</th><th>Last tested</th><th></th></tr></thead>
<tbody>
${rows}
</tbody></table></div></section>`;
}

function summary(page: PageData): string {
  const rows = page.vendors
    .map((vendor) => {
      const newest = vendor.versions[0];
      if (!newest) {
        return `<tr><td><a href="#${vendor.id}">${html(vendor.name)}</a></td><td colspan="3" class="muted">Not tested yet</td></tr>`;
      }
      return `<tr><td><a href="#${vendor.id}">${html(vendor.name)}</a></td><td><code>${html(newest.version)}</code></td><td><span class="${cls(newest.status)}">${STATUS_LABEL[newest.status]}</span></td><td><span class="${cls(newest.live)}">${LIVE_LABEL[newest.live]}</span></td></tr>`;
    })
    .join("\n");
  return `<div class="scroll"><table>
<thead><tr><th>CLI</th><th>Newest tested</th><th>Status</th><th>Live session</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>`;
}

function eventSchemas(page: PageData): string {
  const rows = page.event_schemas.versions
    .map(
      (v) =>
        `<tr><td><code>${html(v.tag)}</code></td><td>${html(v.released)}</td><td>${v.supported_until ? `Until ${html(v.supported_until)}` : "Current"}</td></tr>`,
    )
    .join("\n");
  return `<p>Every event carries a schema version. The server accepts the current version, and an older one for ${page.event_schemas.support_months} months after the version that replaced it was released; older events are upgraded on the way in.</p>
<div class="scroll"><table>
<thead><tr><th>Event schema</th><th>Released</th><th>Accepted</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>`;
}

export function renderPage(page: PageData): string {
  const updated = page.updated
    ? `Last run ${html(page.updated.slice(0, 16).replace("T", " "))} UTC${page.run_url ? `, <a href="${html(page.run_url)}">CI run</a>` : ""}.`
    : "No run yet.";
  const explained = CHECKS_EXPLAINED.map(
    ([id, text]) => `<dt><code>${html(id)}</code></dt><dd>${html(text)}</dd>`,
  ).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vendor compatibility</title>
<meta name="description" content="Coding agent CLI releases tested against selfhost's hooks, log importers and policy compiler.">
<style>
:root {
  --bg: #ffffff;
  --fg: #1d1f23;
  --muted: #5d6470;
  --line: #e3e5e8;
  --soft: #f5f6f7;
  --pass: #17663a;
  --pass-bg: #e3f4e9;
  --fail: #a3201c;
  --fail-bg: #fbe5e3;
  --skip: #5d6470;
  --skip-bg: #eef0f2;
  --link: #1f5fbf;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #15171a;
    --fg: #e6e8eb;
    --muted: #9aa1ab;
    --line: #2c3036;
    --soft: #1d2024;
    --pass: #7fd6a0;
    --pass-bg: #163222;
    --fail: #f3a39d;
    --fail-bg: #3a1a18;
    --skip: #9aa1ab;
    --skip-bg: #23272c;
    --link: #8ab4f8;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
}
main { max-width: 980px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 28px; margin: 0 0 8px; }
h2 { font-size: 20px; margin: 40px 0 8px; }
a { color: var(--link); }
code, pre { font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
.muted { color: var(--muted); }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; margin: 8px 0; }
th, td { text-align: left; vertical-align: top; padding: 8px 10px; border-bottom: 1px solid var(--line); }
th { font-weight: 600; font-size: 13px; color: var(--muted); }
table.checks { background: var(--soft); }
table.checks td:first-child { white-space: nowrap; }
.status { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 13px; font-weight: 600; }
.status-pass, .status-passing { color: var(--pass); background: var(--pass-bg); }
.status-fail, .status-broken { color: var(--fail); background: var(--fail-bg); }
.status-skip, .status-not-run { color: var(--skip); background: var(--skip-bg); }
details summary { cursor: pointer; color: var(--link); }
dt { margin-top: 10px; }
dd { margin: 2px 0 0 0; color: var(--muted); }
</style>
</head>
<body>
<main>
<h1>Vendor compatibility</h1>
<p>Each new release of the coding agent CLIs selfhost supports is installed in CI and checked against selfhost's hooks, log importers and policy compiler: every week, and within hours of a release. A failing run marks that release broken here and opens an issue. ${updated}</p>
${summary(page)}
${page.vendors.map(vendorSection).join("\n")}
<section id="event-schemas"><h2>Event schema versions</h2>
${eventSchemas(page)}
</section>
<section id="checks"><h2>What each check covers</h2>
<dl>
${explained}
</dl>
<p class="muted">A skipped check could not run in that environment, for example a live session without an API key. Skipped checks never mark a release broken. The same data is in <a href="compatibility.json">compatibility.json</a>.</p>
</section>
</main>
</body>
</html>
`;
}
