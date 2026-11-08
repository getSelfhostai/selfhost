import type { Receipt, ReceiptLog, ReceiptPreview, ReceiptTestRun } from "@selfhost/schema";
import { block, code, duration, escapeText, link, plural, shortSha } from "./markdown.js";
import { receiptCounts } from "./receipt.js";

/**
 * The first line of the receipt comment. The server and the action find the comment they
 * posted before by it and edit it in place.
 */
export const RECEIPT_MARKER = "<!-- selfhost:receipt v1 -->";

/** GitHub's limit on a comment body, in characters. */
export const COMMENT_LIMIT = 65_536;

const VERDICT_WORD: Record<Receipt["verdict"], string> = {
  passed: "Passed",
  failed: "Failed",
  nothing_checked: "Nothing checked",
};

const TEST_RESULT: Record<ReceiptTestRun["status"], string> = {
  passed: "passed",
  failed: "**failed**",
  timed_out: "**timed out**",
};

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The receipt in one sentence: "Failed. The app did not start, 1 of 2 test runs failed." */
export function receiptHeadline(receipt: Receipt): string {
  const counts = receiptCounts(receipt);
  const parts: string[] = [];
  if (receipt.setup?.status === "failed") parts.push("setup failed");
  if (receipt.app.status === "failed") parts.push("the app did not start");
  if (counts.failedRuns > 0) {
    parts.push(`${counts.failedRuns} of ${plural(counts.runs, "test run")} failed`);
  } else if (counts.runs > 0) {
    parts.push(`${plural(counts.runs, "test run")} passed`);
  } else if (counts.notRun > 0) {
    parts.push("no changed test could be run");
  } else {
    parts.push("no tests added or changed");
  }
  if (counts.failedShots > 0) {
    parts.push(`${counts.failedShots} of ${plural(counts.shots, "screenshot")} failed`);
  } else if (counts.shots > 0) {
    parts.push(`${plural(counts.shots, "screen")} captured`);
  }
  const preview: Partial<Record<ReceiptPreview["status"], string>> = {
    ready: "preview ready",
    pending: "preview still deploying",
    failed: "the preview deployment failed",
  };
  const said = preview[receipt.preview.status];
  if (said) parts.push(said);
  return `${VERDICT_WORD[receipt.verdict]}. ${capitalize(parts.join(", "))}.`;
}

function logBlock(title: string, log: ReceiptLog | undefined, chars: number, open: boolean) {
  if (!log || chars <= 0 || log.tail === "") return [];
  let tail = log.tail;
  if (tail.length > chars) tail = tail.slice(tail.length - chars).replace(/^[^\n]*\n/, "");
  const shown = tail.split("\n").length;
  const of = log.lines > shown ? `, last ${shown} of ${log.lines} lines` : "";
  const where = log.file ? `, whole log in ${code(log.file)}` : "";
  return [
    "",
    `<details${open ? " open" : ""}><summary>${escapeText(title)}${of}${where}</summary>`,
    "",
    block(tail),
    "",
    "</details>",
  ];
}

function previewSection(preview: ReceiptPreview): string[] {
  const name = preview.name ? ` ${code(preview.name)}` : "";
  const from =
    preview.source === "commit_status"
      ? "commit status"
      : preview.source === "input"
        ? "the action's preview-url input"
        : "deployment";
  const by = preview.provider ? ` on ${escapeText(preview.provider)}` : "";
  switch (preview.status) {
    case "ready":
      return [`${link(preview.url ?? "", preview.url)}, from the${name} ${from}${by}.`];
    case "pending":
      return [
        `The${name} ${from}${by} was still deploying when the receipt finished. Screenshots and logs are below.`,
      ];
    case "failed":
      return [`**The${name} ${from}${by} failed.**`];
    case "none":
      return [
        "No preview environment for this commit: no GitHub deployment and no deploy-preview status. Screenshots and logs are below.",
      ];
  }
}

function setupSection(receipt: Receipt, chars: number): string[] {
  const setup = receipt.setup;
  if (!setup) return [];
  const lines =
    setup.status === "passed"
      ? [`${code(setup.command)} passed in ${duration(setup.duration_ms)}.`]
      : [
          `**${code(setup.command)} failed**${setup.exit_code === undefined ? "" : ` with exit code ${setup.exit_code}`} after ${duration(setup.duration_ms)}. The app was not started and no tests ran.`,
          ...logBlock("Setup output", setup.log, chars, true),
        ];
  return ["", "### Setup", "", ...lines];
}

function appSection(receipt: Receipt, chars: number): string[] {
  const { app } = receipt;
  const lines: string[] = [];
  if (app.status === "started") {
    lines.push(
      `Started with ${code(app.command ?? "")} and answered at ${code(app.url ?? "")}${app.duration_ms === undefined ? "" : ` after ${duration(app.duration_ms)}`}.`,
    );
  } else if (app.status === "failed") {
    lines.push(`**The app did not start.** ${escapeText(app.error ?? "")}`.trimEnd());
    if (app.command) lines.push("", `Start command: ${code(app.command)}.`);
    lines.push(...logBlock("App output", app.log, chars, true));
  } else {
    lines.push(
      "Not started: selfhost.toml has no [receipt] start and no default [runtime.run] command, and the action has no start input.",
    );
  }
  return ["", "### App", "", ...lines];
}

function testsSection(receipt: Receipt, chars: number): string[] {
  const { runs, not_run: notRun } = receipt.tests;
  const lines: string[] = [];
  if (runs.length === 0 && notRun.length === 0) {
    lines.push("The pull request adds or changes no test files.");
  }
  if (runs.length > 0) {
    lines.push("| Result | Tests | Runner | Time |", "| --- | --- | --- | --- |");
    for (const run of runs) {
      const files = run.files.map(code).join("<br>");
      lines.push(
        `| ${TEST_RESULT[run.status]} | ${files} | ${run.runner} | ${duration(run.duration_ms)} |`,
      );
    }
    for (const run of runs.filter((r) => r.status !== "passed")) {
      const cwd = run.cwd === "." ? "" : ` in ${run.cwd}`;
      const exit = run.exit_code === undefined ? "" : `, exit code ${run.exit_code}`;
      lines.push(...logBlock(`Output of ${run.command}${cwd}${exit}`, run.log, chars, true));
    }
  }
  if (notRun.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Not run:", "");
    for (const item of notRun) lines.push(`- ${code(item.path)}: ${escapeText(item.reason)}`);
  }
  return ["", "### Tests", "", ...lines];
}

function screensSection(receipt: Receipt): string[] {
  const { screens, artifact } = receipt;
  const lines: string[] = [];
  if (screens.shots.length === 0) {
    lines.push(
      screens.source === "none"
        ? "No screenshots: the app was not started and there is no ready preview to open the screens on."
        : "No screens to capture.",
    );
    return ["", "### Screens", "", ...lines];
  }
  const where = screens.source === "preview" ? "the preview" : "the app started for the receipt";
  const images = artifact?.url
    ? ` Images are in the ${link(artifact.name, artifact.url)} artifact.`
    : artifact
      ? ` Images are in the ${code(artifact.name)} artifact of the CI run.`
      : "";
  lines.push(`Captured with Playwright (Chromium) on ${where}.${images}`, "");
  lines.push("| Screen | Result | Changed files |", "| --- | --- | --- |");
  for (const shot of screens.shots) {
    const result =
      shot.status === "captured"
        ? `captured${shot.image ? ` as ${code(shot.image)}` : ""}${shot.http_status ? `, HTTP ${shot.http_status}` : ""}`
        : `**failed**${shot.http_status ? `, HTTP ${shot.http_status}` : ""}${shot.error ? `: ${escapeText(shot.error)}` : ""}`;
    const errors = shot.page_errors?.length
      ? `<br>Page errors: ${shot.page_errors.map((e) => code(e.slice(0, 200))).join(", ")}`
      : "";
    const files = shot.files.length > 0 ? shot.files.map(code).join("<br>") : "(home page)";
    // The app ran on the CI runner, so its URLs open nowhere else; the preview's do.
    const screen = screens.source === "preview" ? link(shot.path, shot.url) : code(shot.path);
    lines.push(`| ${screen} | ${result}${errors} | ${files} |`);
  }
  return ["", "### Screens", "", ...lines];
}

export interface RenderOptions {
  /** The receipt on the team server. */
  receiptUrl?: string;
  /** Default: GitHub's comment limit. */
  maxChars?: number;
}

function render(receipt: Receipt, chars: number, options: RenderOptions): string {
  const ran = receipt.ci?.run_url
    ? `Made by ${link(`CI run ${receipt.ci.run_id}`, receipt.ci.run_url)}`
    : "Made";
  const artifact = receipt.artifact
    ? receipt.artifact.url
      ? ` Screenshots, logs and receipt.html: ${link(receipt.artifact.name, receipt.artifact.url)}.`
      : ` Screenshots, logs and receipt.html are in the ${code(receipt.artifact.name)} artifact.`
    : "";
  const stored = options.receiptUrl ? ` ${link("Stored receipt", options.receiptUrl)}.` : "";
  const parts = [
    RECEIPT_MARKER,
    "## Proof receipt",
    "",
    `**${receiptHeadline(receipt)}**`,
    "",
    `${ran} on head commit ${code(shortSha(receipt.pull.head_sha))}.${artifact}${stored}`,
    "",
    "### Preview",
    "",
    ...previewSection(receipt.preview),
    ...setupSection(receipt, chars),
    ...appSection(receipt, chars),
    ...testsSection(receipt, chars),
    ...screensSection(receipt),
  ];
  if (receipt.notes.length > 0) {
    parts.push("", "### Notes", "", ...receipt.notes.map((note) => `- ${escapeText(note)}`));
  }
  return `${parts.join("\n")}\n`;
}

/**
 * The receipt as a pull request comment in Markdown, starting with RECEIPT_MARKER: the verdict,
 * the preview link, setup, the app, each test run and each screenshot, with the output of
 * whatever failed. Log tails shrink until it fits in `maxChars`.
 */
export function renderReceipt(receipt: Receipt, options: RenderOptions = {}): string {
  const max = options.maxChars ?? COMMENT_LIMIT;
  for (const chars of [6000, 2000, 600, 0]) {
    const text = render(receipt, chars, options);
    if (text.length <= max) return text;
  }
  const cut = "\n\nThe receipt was cut to fit the comment size limit.\n";
  return `${render(receipt, 0, options).slice(0, Math.max(0, max - cut.length))}${cut}`;
}

export interface BriefSectionOptions {
  /** The pull request's head commit now. A receipt for another commit is called out. */
  headSha: string;
  /** The receipt comment on the pull request. */
  commentUrl?: string;
  receiptUrl?: string;
}

/** The receipt's section of the review brief: its headline and where the whole receipt is. */
export function receiptBriefSection(receipt: Receipt, options: BriefSectionOptions): string {
  const lines = ["### Proof receipt", ""];
  const stale = receipt.pull.head_sha.toLowerCase() !== options.headSha.toLowerCase();
  if (stale) {
    lines.push(
      `The newest receipt is for commit ${code(shortSha(receipt.pull.head_sha))}, not the head commit ${code(shortSha(options.headSha))}; the next CI run makes a new one. It said: ${receiptHeadline(receipt)}`,
    );
  } else {
    lines.push(`**${receiptHeadline(receipt)}**`);
  }
  const links = [
    ...(options.commentUrl ? [link("Full receipt", options.commentUrl)] : []),
    ...(receipt.preview.status === "ready" && receipt.preview.url
      ? [link("Preview", receipt.preview.url)]
      : []),
    ...(receipt.artifact?.url ? [link("Screenshots and logs", receipt.artifact.url)] : []),
    ...(receipt.ci?.run_url ? [link("CI run", receipt.ci.run_url)] : []),
    ...(options.receiptUrl ? [link("Stored receipt", options.receiptUrl)] : []),
  ];
  if (links.length > 0) lines.push("", `${links.join(", ")}.`);
  return lines.join("\n");
}
