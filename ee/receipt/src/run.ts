import { createWriteStream, existsSync, mkdirSync, readFileSync, type WriteStream } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import type {
  Receipt,
  ReceiptApp,
  ReceiptPreview,
  ReceiptScreens,
  ReceiptShot,
  ReceiptStep,
  ReceiptTestRun,
} from "@selfhost/schema";
import { OutputBuffer } from "./log.js";
import type { ScreenshotBrowser } from "./playwright.js";
import { freePort, runCommand, type Started, startCommand, waitForUrl } from "./process.js";
import { assembleReceipt } from "./receipt.js";
import { mapScreens, screenUrl, shotFile } from "./screens.js";
import { type ChangedFile, type PlannedTestRun, planTests, type RepoProbe } from "./select.js";
import { expandVariables, type ReceiptSettings } from "./settings.js";

/** The setup script may install everything from scratch. */
const SETUP_TIMEOUT_MS = 30 * 60_000;

export interface RunReceiptOptions {
  /** The checkout, absolute. Commands run there unless a cwd says otherwise. */
  root: string;
  /** Where logs/ and screens/ are written, absolute. */
  outDir: string;
  settings: ReceiptSettings;
  repo: string;
  pull: Receipt["pull"];
  changed: ChangedFile[];
  /** The pull request's branch and the branch it merges into, for the SELFHOST_ variables. */
  branch: string;
  defaultBranch: string;
  /** Looks up the preview environment once the tests have run. Default: none. */
  preview?: () => Promise<ReceiptPreview>;
  /** Opens the browser for the screenshots; undefined skips them with a note. */
  browser?: () => Promise<ScreenshotBrowser>;
  /** Progress lines for the CI log. */
  log?: (line: string) => void;
  /** The environment commands start from. Default: process.env. */
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

/** Reads the checkout for test selection. */
export function fileProbe(root: string): RepoProbe {
  return {
    read(path) {
      try {
        return readFileSync(join(root, path), "utf8");
      } catch {
        return undefined;
      }
    },
    exists: (path) => existsSync(join(root, path)),
  };
}

class Logs {
  private readonly streams: WriteStream[] = [];

  constructor(
    private readonly outDir: string,
    private readonly settings: ReceiptSettings,
  ) {}

  /** An output buffer that also writes the whole masked log to logs/<name>.log. */
  open(name: string): { buffer: OutputBuffer; file: string } {
    const file = `logs/${name}.log`;
    mkdirSync(join(this.outDir, "logs"), { recursive: true });
    const stream = createWriteStream(join(this.outDir, file));
    this.streams.push(stream);
    const buffer = new OutputBuffer({
      patterns: this.settings.redaction,
      sink: (line) => stream.write(`${line}\n`),
    });
    return { buffer, file };
  }

  async close(): Promise<void> {
    await Promise.all(
      this.streams.map((stream) => new Promise<void>((done) => stream.end(() => done()))),
    );
  }
}

const slug = (text: string) =>
  text
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "run";

function withBins(env: NodeJS.ProcessEnv, root: string, dirs: string[]): NodeJS.ProcessEnv {
  if (dirs.length === 0) return env;
  const bins = dirs.map((dir) => join(root, dir, "node_modules", ".bin"));
  return { ...env, PATH: [...bins, env.PATH ?? ""].filter(Boolean).join(delimiter) };
}

/**
 * Runs the receipt for one pull request in its checkout: the setup script, then the app in the
 * background until it answers, then the tests the pull request adds or changes, then the
 * preview lookup, then a screenshot of each mapped screen (on the app, else on the preview).
 * Every command's whole log goes to outDir/logs, masked; the receipt keeps the tail of each one
 * that failed. Nothing here throws for a failing app or test: the receipt says what failed.
 */
export async function runReceipt(options: RunReceiptOptions): Promise<Receipt> {
  const { root, outDir, settings } = options;
  const say = options.log ?? (() => {});
  const now = options.now ?? (() => new Date());
  const notes: string[] = [];
  const logs = new Logs(outDir, settings);
  mkdirSync(outDir, { recursive: true });

  const port = settings.port ?? (await freePort());
  const variables: Record<string, string> = {
    SELFHOST_WORKSPACE_NAME: options.branch,
    SELFHOST_WORKSPACE_PATH: root,
    SELFHOST_ROOT_PATH: root,
    SELFHOST_DEFAULT_BRANCH: options.defaultBranch,
    SELFHOST_PORT: String(port),
  };
  const runtimeEnv = Object.fromEntries(
    Object.entries(settings.env).map(([name, value]) => [name, expandVariables(value, variables)]),
  );
  const env: NodeJS.ProcessEnv = {
    ...(options.env ?? process.env),
    ...runtimeEnv,
    ...variables,
    CI: "true",
    NO_COLOR: "1",
  };

  let setup: ReceiptStep | undefined;
  if (settings.setup) {
    say(`receipt: setup: ${settings.setup.split("\n")[0]}`);
    const { buffer, file } = logs.open("setup");
    const result = await runCommand(settings.setup, {
      cwd: root,
      env,
      output: buffer,
      timeoutMs: SETUP_TIMEOUT_MS,
    });
    const passed = result.exitCode === 0;
    setup = {
      command: settings.setup.trim(),
      status: passed ? "passed" : "failed",
      ...(result.exitCode === undefined ? {} : { exit_code: result.exitCode }),
      duration_ms: result.durationMs,
      ...(passed ? {} : { log: buffer.toLog(file) }),
    };
  }
  const setupFailed = setup?.status === "failed";

  // The app.
  let app: ReceiptApp;
  let running: Started | undefined;
  const readyUrl = expandVariables(settings.readyUrl, variables);
  if (!settings.start) {
    app = { status: "not_configured" };
  } else if (setupFailed) {
    app = {
      status: "failed",
      command: settings.start.command,
      error: "Not started, because setup failed.",
    };
  } else if (!/^https?:\/\//i.test(readyUrl) || !URL.canParse(readyUrl)) {
    app = {
      status: "failed",
      command: settings.start.command,
      error: `Not started: the ready URL ${readyUrl} is not an http or https URL.`,
    };
  } else {
    const { command, cwd } = settings.start;
    say(`receipt: starting the app: ${command}`);
    const { buffer, file } = logs.open("app");
    running = startCommand(command, {
      cwd: resolve(root, cwd),
      env: { ...env, PORT: String(port) },
      output: buffer,
    });
    const wait = await waitForUrl(readyUrl, {
      timeoutMs: settings.readyTimeoutMs,
      exited: running.exited,
    });
    if (wait.ready) {
      say(`receipt: the app answered at ${readyUrl} after ${wait.ms} ms`);
      app = { status: "started", command, url: readyUrl, duration_ms: wait.ms };
    } else {
      const finished = wait.exited;
      if (!finished) await running.stop();
      running = undefined;
      const error = finished
        ? `The start command exited${finished.exitCode === undefined ? "" : ` with code ${finished.exitCode}`} before ${readyUrl} answered.`
        : `${readyUrl} did not answer within ${Math.round(settings.readyTimeoutMs / 1000)} s.`;
      say(`receipt: the app did not start: ${error}`);
      app = {
        status: "failed",
        command,
        url: readyUrl,
        duration_ms: wait.ms,
        ...(finished?.exitCode === undefined ? {} : { exit_code: finished.exitCode }),
        error,
        log: buffer.toLog(file),
      };
    }
  }

  try {
    // The tests.
    const plan = planTests(options.changed, fileProbe(root), {
      ...(settings.testCommand ? { testCommand: settings.testCommand } : {}),
      testGlobs: settings.testGlobs,
      maxTests: settings.maxTests,
    });
    const runs: ReceiptTestRun[] = [];
    const notRun = [...plan.notRun];
    if (setupFailed) {
      for (const run of plan.runs) {
        for (const path of run.files) notRun.push({ path, reason: "Setup failed." });
      }
    } else {
      for (const [index, planned] of plan.runs.entries()) {
        runs.push(await runTest(planned, index, { root, env, logs, settings, say }));
      }
    }

    // The preview.
    const preview: ReceiptPreview = options.preview ? await options.preview() : { status: "none" };

    // The screenshots.
    const screens = await captureScreens({
      options,
      app,
      preview,
      notes,
    });

    return assembleReceipt({
      repo: options.repo,
      pull: options.pull,
      created_at: now().toISOString(),
      ...(setup ? { setup } : {}),
      app,
      tests: { runs, not_run: notRun },
      screens,
      preview,
      notes,
    });
  } finally {
    await running?.stop();
    await logs.close();
  }
}

async function runTest(
  planned: PlannedTestRun,
  index: number,
  context: {
    root: string;
    env: NodeJS.ProcessEnv;
    logs: Logs;
    settings: ReceiptSettings;
    say: (line: string) => void;
  },
): Promise<ReceiptTestRun> {
  const { root, env, logs, settings, say } = context;
  say(`receipt: test: ${planned.command}${planned.cwd === "." ? "" : ` (in ${planned.cwd})`}`);
  const { buffer, file } = logs.open(`test-${index + 1}-${slug(planned.files[0] ?? "")}`);
  const result = await runCommand(planned.command, {
    cwd: resolve(root, planned.cwd),
    env: withBins(env, root, planned.bins),
    output: buffer,
    timeoutMs: settings.testTimeoutMs,
  });
  const status = result.timedOut ? "timed_out" : result.exitCode === 0 ? "passed" : "failed";
  say(`receipt: test ${status} in ${result.durationMs} ms`);
  return {
    files: planned.files,
    runner: planned.runner,
    command: planned.command,
    cwd: planned.cwd,
    status,
    ...(result.exitCode === undefined ? {} : { exit_code: result.exitCode }),
    duration_ms: result.durationMs,
    ...(status === "passed" ? {} : { log: buffer.toLog(file) }),
  };
}

async function captureScreens({
  options,
  app,
  preview,
  notes,
}: {
  options: RunReceiptOptions;
  app: ReceiptApp;
  preview: ReceiptPreview;
  notes: string[];
}): Promise<ReceiptScreens> {
  const { settings, outDir } = options;
  const base =
    app.status === "started" && app.url
      ? { url: new URL(app.url).origin, source: "app" as const }
      : preview.status === "ready" && preview.url
        ? { url: preview.url, source: "preview" as const }
        : undefined;
  if (!base) {
    if (app.status !== "failed") {
      notes.push("No screenshots: no start command and no ready preview to open the screens on.");
    } else {
      notes.push("The app did not start and there is no ready preview, so no screenshots.");
    }
    return { source: "none", shots: [] };
  }
  const plan = mapScreens(options.changed, settings.screens, settings.maxScreens);
  notes.push(...plan.notes);
  if (plan.shots.length === 0) return { base_url: base.url, source: base.source, shots: [] };
  if (!options.browser) {
    notes.push("Screenshots are turned off.");
    return { base_url: base.url, source: base.source, shots: [] };
  }

  let browser: ScreenshotBrowser;
  try {
    browser = await options.browser();
  } catch (error) {
    const message = (error as Error).message.split("\n")[0] ?? "unknown error";
    return {
      base_url: base.url,
      source: base.source,
      shots: plan.shots.map((shot) => ({
        path: shot.path,
        url: screenUrl(base.url, shot.path),
        files: shot.files,
        status: "failed",
        error: `The browser did not start: ${message}`,
      })),
    };
  }
  const taken = new Set<string>();
  const shots: ReceiptShot[] = [];
  try {
    for (const planned of plan.shots) {
      const url = screenUrl(base.url, planned.path);
      const image = shotFile(planned.path, taken);
      const target = join(outDir, image);
      mkdirSync(dirname(target), { recursive: true });
      options.log?.(`receipt: screenshot of ${url}`);
      try {
        const capture = await browser.capture(url, target);
        const bad = capture.httpStatus !== undefined && capture.httpStatus >= 400;
        shots.push({
          path: planned.path,
          url,
          files: planned.files,
          status: bad ? "failed" : "captured",
          ...(capture.httpStatus === undefined ? {} : { http_status: capture.httpStatus }),
          ...(existsSync(target) ? { image } : {}),
          ...(capture.pageErrors.length > 0 ? { page_errors: capture.pageErrors } : {}),
          ...(bad ? { error: `The page answered HTTP ${capture.httpStatus}.` } : {}),
        });
      } catch (error) {
        shots.push({
          path: planned.path,
          url,
          files: planned.files,
          status: "failed",
          error: (error as Error).message.split("\n")[0] ?? "unknown error",
        });
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return { base_url: base.url, source: base.source, shots };
}
