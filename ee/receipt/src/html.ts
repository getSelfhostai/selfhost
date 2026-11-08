import type { Receipt, ReceiptLog } from "@selfhost/schema";
import { duration, shortSha } from "./markdown.js";
import { receiptHeadline } from "./render.js";

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

const href = (url: string | undefined) =>
  url && /^https?:\/\//i.test(url) ? escapeHtml(url) : undefined;

function a(text: string, url: string | undefined): string {
  const target = href(url);
  return target ? `<a href="${target}">${escapeHtml(text)}</a>` : escapeHtml(text);
}

function logHtml(title: string, log: ReceiptLog | undefined): string {
  if (!log || log.tail === "") return "";
  const where = log.file ? ` (whole log in ${escapeHtml(log.file)})` : "";
  return `<details open><summary>${escapeHtml(title)}${where}</summary><pre>${escapeHtml(log.tail)}</pre></details>`;
}

const STYLE = `
:root { --bg: #ffffff; --fg: #1f2328; --muted: #59636e; --line: #d1d9e0; --ok: #1a7f37; --bad: #cf222e; --code: #f6f8fa; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --line: #3d444d; --ok: #3fb950; --bad: #f85149; --code: #151b23; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1040px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 24px; margin: 0 0 4px; }
h2 { font-size: 17px; margin: 32px 0 8px; padding-bottom: 4px; border-bottom: 1px solid var(--line); }
p { margin: 8px 0; }
.muted { color: var(--muted); }
.verdict { font-weight: 600; }
.passed { color: var(--ok); }
.failed, .timed_out { color: var(--bad); font-weight: 600; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
pre { background: var(--code); padding: 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; border-radius: 6px; }
details { margin: 8px 0; }
.shots { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }
figure { margin: 0; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
figure img { display: block; width: 100%; height: auto; }
figcaption { padding: 8px; font-size: 13px; }
a { color: inherit; }
`;

/**
 * The receipt as one HTML page with no outside references: screenshots are embedded from
 * `images` (artifact path to PNG bytes), so the page opens straight from the downloaded
 * artifact.
 */
export function renderReceiptHtml(receipt: Receipt, images: Map<string, Uint8Array>): string {
  const { app, tests, screens, preview } = receipt;
  const parts: string[] = [];
  parts.push(
    `<h1>Proof receipt</h1>`,
    `<p class="muted">${a(`${receipt.repo}#${receipt.pull.number}`, receipt.pull.url)}, head commit <code>${escapeHtml(shortSha(receipt.pull.head_sha))}</code>, ${escapeHtml(receipt.created_at)}${receipt.ci ? `, ${a(`CI run ${receipt.ci.run_id}`, receipt.ci.run_url)}` : ""}</p>`,
    `<p class="verdict ${escapeHtml(receipt.verdict)}">${escapeHtml(receiptHeadline(receipt))}</p>`,
  );

  parts.push("<h2>Preview</h2>");
  parts.push(
    preview.status === "ready"
      ? `<p>${a(preview.url ?? "", preview.url)}${preview.name ? ` (${escapeHtml(preview.name)})` : ""}</p>`
      : `<p>${escapeHtml(
          preview.status === "pending"
            ? "The preview was still deploying when the receipt finished."
            : preview.status === "failed"
              ? "The preview deployment failed."
              : "No preview environment for this commit.",
        )}</p>`,
  );

  if (receipt.setup) {
    const { setup } = receipt;
    parts.push(
      "<h2>Setup</h2>",
      `<p><code>${escapeHtml(setup.command)}</code> <span class="${setup.status}">${setup.status}</span> in ${escapeHtml(duration(setup.duration_ms))}.</p>`,
      setup.status === "failed" ? logHtml("Setup output", setup.log) : "",
    );
  }

  parts.push("<h2>App</h2>");
  if (app.status === "started") {
    parts.push(
      `<p>Started with <code>${escapeHtml(app.command ?? "")}</code>, answered at <code>${escapeHtml(app.url ?? "")}</code>${app.duration_ms === undefined ? "" : ` after ${escapeHtml(duration(app.duration_ms))}`}.</p>`,
    );
  } else if (app.status === "failed") {
    parts.push(
      `<p class="failed">The app did not start. ${escapeHtml(app.error ?? "")}</p>`,
      logHtml("App output", app.log),
    );
  } else {
    parts.push("<p>No start command configured.</p>");
  }

  parts.push("<h2>Tests</h2>");
  if (tests.runs.length === 0 && tests.not_run.length === 0) {
    parts.push("<p>The pull request adds or changes no test files.</p>");
  }
  if (tests.runs.length > 0) {
    parts.push(
      "<table><thead><tr><th>Result</th><th>Tests</th><th>Runner</th><th>Time</th></tr></thead><tbody>",
      ...tests.runs.map(
        (run) =>
          `<tr><td class="${run.status}">${escapeHtml(run.status.replace("_", " "))}</td><td>${run.files.map((f) => `<code>${escapeHtml(f)}</code>`).join("<br>")}</td><td>${escapeHtml(run.runner)}</td><td>${escapeHtml(duration(run.duration_ms))}</td></tr>`,
      ),
      "</tbody></table>",
      ...tests.runs
        .filter((run) => run.status !== "passed")
        .map((run) => logHtml(`Output of ${run.command}`, run.log)),
    );
  }
  if (tests.not_run.length > 0) {
    parts.push(
      "<p>Not run:</p><ul>",
      ...tests.not_run.map(
        (t) => `<li><code>${escapeHtml(t.path)}</code>: ${escapeHtml(t.reason)}</li>`,
      ),
      "</ul>",
    );
  }

  parts.push("<h2>Screens</h2>");
  if (screens.shots.length === 0) parts.push("<p>No screenshots.</p>");
  else {
    parts.push('<div class="shots">');
    for (const shot of screens.shots) {
      const bytes = shot.image ? images.get(shot.image) : undefined;
      const img = bytes
        ? `<img alt="${escapeHtml(shot.path)}" src="data:image/png;base64,${Buffer.from(bytes).toString("base64")}">`
        : "";
      const result =
        shot.status === "captured"
          ? `<span class="passed">captured</span>`
          : `<span class="failed">failed</span>${shot.error ? `: ${escapeHtml(shot.error)}` : ""}`;
      const files = shot.files.length > 0 ? shot.files.map(escapeHtml).join(", ") : "home page";
      parts.push(
        `<figure>${img}<figcaption>${screens.source === "preview" ? a(shot.path, shot.url) : `<code>${escapeHtml(shot.path)}</code>`} ${result}${shot.http_status ? `, HTTP ${shot.http_status}` : ""}<br><span class="muted">${files}</span></figcaption></figure>`,
      );
    }
    parts.push("</div>");
  }

  if (receipt.notes.length > 0) {
    parts.push(
      "<h2>Notes</h2><ul>",
      ...receipt.notes.map((note) => `<li>${escapeHtml(note)}</li>`),
      "</ul>",
    );
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Proof receipt</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${parts.filter(Boolean).join("\n")}
</main>
</body>
</html>
`;
}
