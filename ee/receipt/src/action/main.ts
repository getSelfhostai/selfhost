import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { webhookPullAgent } from "@selfhost/attribution";
import { parseConfig, type Receipt, type ReceiptPreview } from "@selfhost/schema";
import { renderReceiptHtml } from "../html.js";
import { launchBrowser } from "../playwright.js";
import { findPreview, givenPreview } from "../preview.js";
import { RECEIPT_MARKER, receiptHeadline, renderReceipt } from "../render.js";
import { runReceipt } from "../run.js";
import { receiptSettings } from "../settings.js";
import { type GitHubApi, GitHubError, githubApi } from "./github.js";

/** The action's inputs, which action.yml passes as INPUT_<NAME> variables. */
export interface ActionInputs {
  serverUrl?: string;
  githubToken: string;
  config: string;
  workingDirectory: string;
  setup?: string;
  start?: string;
  readyUrl?: string;
  testCommand?: string;
  previewUrl?: string;
  previewTimeoutMs: number;
  agentOnly: boolean;
  screenshots: boolean;
  failOnFailure: boolean;
  artifactName: string;
}

interface PullPayload {
  number: number;
  html_url: string;
  body: string | null;
  user: { login: string; type?: string } | null;
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
}

/** Writes what the action does to the CI log, and the step outputs and summary. */
interface ActionIo {
  env: NodeJS.ProcessEnv;
  log(line: string): void;
  github?: GitHubApi;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export const escapeCommand = (text: string) =>
  text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

function readInputs(env: NodeJS.ProcessEnv): ActionInputs {
  const value = (name: string) => {
    const raw = env[`INPUT_${name}`]?.trim();
    return raw ? raw : undefined;
  };
  const flag = (name: string, fallback: boolean) => {
    const raw = value(name)?.toLowerCase();
    return raw === undefined ? fallback : raw === "true";
  };
  const optional = (key: keyof ActionInputs, name: string) => {
    const found = value(name);
    return found ? { [key]: found } : {};
  };
  const timeout = Number(value("PREVIEW_TIMEOUT") ?? "300");
  return {
    ...optional("serverUrl", "SERVER_URL"),
    githubToken: value("GITHUB_TOKEN") ?? "",
    config: value("CONFIG") ?? "selfhost.toml",
    workingDirectory: value("WORKING_DIRECTORY") ?? ".",
    ...optional("setup", "SETUP"),
    ...optional("start", "START"),
    ...optional("readyUrl", "READY_URL"),
    ...optional("testCommand", "TEST_COMMAND"),
    ...optional("previewUrl", "PREVIEW_URL"),
    previewTimeoutMs: (Number.isFinite(timeout) && timeout >= 0 ? timeout : 300) * 1000,
    agentOnly: flag("AGENT_ONLY", true),
    screenshots: flag("SCREENSHOTS", true),
    failOnFailure: flag("FAIL_ON_FAILURE", true),
    artifactName: value("ARTIFACT_NAME") ?? "selfhost-receipt",
  };
}

function outDir(env: NodeJS.ProcessEnv): string {
  return join(env.RUNNER_TEMP ?? resolve(".selfhost-receipt-tmp"), "selfhost-receipt");
}

function setOutput(env: NodeJS.ProcessEnv, name: string, value: string): void {
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function summary(env: NodeJS.ProcessEnv, markdown: string): void {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

export const errorLine = (error: unknown) =>
  error instanceof Error ? (error.message.split("\n")[0] ?? error.name) : String(error);

/**
 * The preview environment of the head commit: the preview-url input when given, else the
 * GitHub deployments and commit statuses of the commit, waited on while one is still deploying.
 */
async function lookUpPreview(
  inputs: ActionInputs,
  github: GitHubApi,
  repo: string,
  sha: string,
  io: ActionIo,
  notes: string[],
): Promise<ReceiptPreview> {
  if (inputs.previewUrl) return givenPreview(inputs.previewUrl);
  const sleep = io.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const started = Date.now();
  for (;;) {
    let found: ReceiptPreview;
    try {
      const [deployments, statuses] = await Promise.all([
        github.deployments(repo, sha),
        github.statuses(repo, sha),
      ]);
      found = findPreview(deployments, statuses);
    } catch (error) {
      notes.push(
        `Could not read the commit's deployments and statuses (${errorLine(error)}); give the job deployments: read and statuses: read.`,
      );
      return { status: "none" };
    }
    if (found.status !== "pending" || Date.now() - started >= inputs.previewTimeoutMs) {
      return found;
    }
    io.log(`receipt: waiting for the ${found.name ?? "preview"} deployment`);
    await sleep(10_000);
  }
}

/** `run`: makes the receipt and writes receipt.json, receipt.md, receipt.html, logs and screens. */
async function run(io: ActionIo): Promise<number> {
  const { env, log } = io;
  const inputs = readInputs(env);
  const repo = env.GITHUB_REPOSITORY ?? "";
  const eventPath = env.GITHUB_EVENT_PATH;
  const event =
    eventPath && existsSync(eventPath) ? JSON.parse(readFileSync(eventPath, "utf8")) : {};
  const pull = (event as { pull_request?: PullPayload }).pull_request;
  if (!pull) {
    const why = `The proof receipt runs on pull requests; this run is for a ${env.GITHUB_EVENT_NAME ?? "non pull request"} event.`;
    log(`::notice::${escapeCommand(why)}`);
    setOutput(env, "skipped", "true");
    return 0;
  }
  if (
    inputs.agentOnly &&
    !webhookPullAgent({ user: pull.user, body: pull.body, head: { ref: pull.head.ref } })
  ) {
    const why = `#${pull.number} is not an agent pull request (no agent bot, trailer or branch prefix), so it gets no receipt. Set agent-only: false to make one for every pull request.`;
    log(`::notice::${escapeCommand(why)}`);
    summary(env, `## Proof receipt\n\n${why}`);
    setOutput(env, "skipped", "true");
    return 0;
  }

  const root = resolve(env.GITHUB_WORKSPACE ?? ".", inputs.workingDirectory);
  const notes: string[] = [];
  const configPath = resolve(root, inputs.config);
  let config: ReturnType<typeof parseConfig> | undefined;
  if (existsSync(configPath)) {
    config = parseConfig(readFileSync(configPath, "utf8"));
    if (!config.ok) {
      for (const error of config.errors) {
        log(
          `::error file=${inputs.config}${error.line ? `,line=${error.line}` : ""}::${escapeCommand(`${error.field}: ${error.message}`)}`,
        );
      }
      const [first] = config.errors;
      notes.push(
        `${inputs.config} is not valid (${first?.field}: ${first?.message}), so the receipt used the action inputs only.`,
      );
    }
  } else {
    notes.push(
      `No ${inputs.config} in the repository, so the receipt used the action inputs only.`,
    );
  }
  const settings = receiptSettings(config?.ok ? config.config : undefined, {
    ...(inputs.setup ? { setup: inputs.setup } : {}),
    ...(inputs.start ? { start: inputs.start } : {}),
    ...(inputs.readyUrl ? { readyUrl: inputs.readyUrl } : {}),
    ...(inputs.testCommand ? { testCommand: inputs.testCommand } : {}),
  });

  const github = io.github ?? githubApi(inputs.githubToken, env.GITHUB_API_URL);
  const changed = await github.pullFiles(repo, pull.number);
  const dir = outDir(env);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const receipt = await runReceipt({
    root,
    outDir: dir,
    settings,
    repo,
    pull: {
      number: pull.number,
      url: pull.html_url,
      head_sha: pull.head.sha,
      base_sha: pull.base.sha,
    },
    changed,
    branch: pull.head.ref,
    defaultBranch: pull.base.ref,
    preview: () => lookUpPreview(inputs, github, repo, pull.head.sha, io, notes),
    ...(inputs.screenshots
      ? { browser: () => launchBrowser(root, env.SELFHOST_RECEIPT_PLAYWRIGHT) }
      : {}),
    log,
    env,
  });
  receipt.notes.unshift(...notes);
  const server = env.GITHUB_SERVER_URL ?? "https://github.com";
  if (env.GITHUB_RUN_ID) {
    const attempt = Number(env.GITHUB_RUN_ATTEMPT ?? "1") || 1;
    receipt.ci = {
      run_url: `${server}/${repo}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${attempt}`,
      run_id: env.GITHUB_RUN_ID,
      attempt,
      ...(env.GITHUB_WORKFLOW ? { workflow: env.GITHUB_WORKFLOW } : {}),
    };
  }
  receipt.artifact = { name: inputs.artifactName };
  writeReceipt(dir, receipt);
  log(`receipt: ${receiptHeadline(receipt)}`);
  setOutput(env, "dir", dir);
  setOutput(env, "verdict", receipt.verdict);
  return 0;
}

function writeReceipt(dir: string, receipt: Receipt): void {
  const images = new Map<string, Uint8Array>();
  for (const shot of receipt.screens.shots) {
    const file = shot.image ? join(dir, shot.image) : undefined;
    if (shot.image && file && existsSync(file)) images.set(shot.image, readFileSync(file));
  }
  writeFileSync(join(dir, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  writeFileSync(join(dir, "receipt.md"), renderReceipt(receipt));
  writeFileSync(join(dir, "receipt.html"), renderReceiptHtml(receipt, images));
}

/** The audience the server checks: its own base URL, without a trailing slash. */
export const receiptAudience = (serverUrl: string) => serverUrl.replace(/\/+$/, "");

/** A GitHub Actions OIDC token for `audience`; needs `permissions: id-token: write`. */
async function oidcToken(env: NodeJS.ProcessEnv, audience: string, fetcher: typeof fetch) {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const token = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !token) {
    throw new Error("No GitHub OIDC token: give the job permissions: id-token: write");
  }
  const separator = url.includes("?") ? "&" : "?";
  const response = await fetcher(`${url}${separator}audience=${encodeURIComponent(audience)}`, {
    headers: { authorization: `bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`The OIDC token request answered ${response.status}`);
  const value = ((await response.json()) as { value?: string }).value;
  if (!value) throw new Error("The OIDC token response had no token");
  return value;
}

/** What POST /v1/receipts answers. */
interface PostedReceipt {
  id: string;
  url?: string;
  comment_url?: string;
  brief?: string;
}

async function postReceipt(
  inputs: ActionInputs & { serverUrl: string },
  receipt: Receipt,
  io: ActionIo,
): Promise<PostedReceipt> {
  const fetcher = io.fetch ?? fetch;
  const base = receiptAudience(inputs.serverUrl);
  const token = await oidcToken(io.env, base, fetcher);
  const response = await fetcher(`${base}/v1/receipts`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(receipt),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let message = text.slice(0, 200);
    try {
      message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
    } catch {
      // Not JSON.
    }
    throw new Error(`The server answered ${response.status}: ${message}`);
  }
  return (await response.json()) as PostedReceipt;
}

/**
 * `report`: adds the artifact link, writes the job summary, and attaches the receipt to the pull
 * request: through the selfhost server when server-url is set (its GitHub App posts the comment
 * and links it from the review brief), else as a comment with the workflow's token. Exits 1 when
 * the receipt failed and fail-on-failure is on.
 */
async function report(io: ActionIo): Promise<number> {
  const { env, log } = io;
  const inputs = readInputs(env);
  const file = join(outDir(env), "receipt.json");
  if (!existsSync(file)) {
    log("receipt: no receipt to report");
    return 0;
  }
  const receipt = JSON.parse(readFileSync(file, "utf8")) as Receipt;
  const artifactUrl = env.SELFHOST_RECEIPT_ARTIFACT_URL?.trim();
  receipt.artifact = { name: inputs.artifactName, ...(artifactUrl ? { url: artifactUrl } : {}) };
  summary(env, renderReceipt(receipt).replace(`${RECEIPT_MARKER}\n`, ""));

  let attached = false;
  if (inputs.serverUrl) {
    try {
      const posted = await postReceipt({ ...inputs, serverUrl: inputs.serverUrl }, receipt, io);
      log(`receipt: stored on the selfhost server as ${posted.id}`);
      if (posted.url) setOutput(env, "receipt-url", posted.url);
      if (posted.comment_url) setOutput(env, "comment-url", posted.comment_url);
      if (posted.brief === "stale") {
        log("receipt: the pull request has a newer head commit, so the server only stored it");
      }
      attached = true;
    } catch (error) {
      log(
        `::warning::${escapeCommand(`Could not post the receipt to ${inputs.serverUrl}: ${errorLine(error)}. Commenting with the workflow token instead.`)}`,
      );
    }
  }
  if (!attached) {
    const github = io.github ?? githubApi(inputs.githubToken, env.GITHUB_API_URL);
    try {
      const url = await github.upsertComment(
        receipt.repo,
        receipt.pull.number,
        RECEIPT_MARKER,
        renderReceipt(receipt),
      );
      log(`receipt: commented on the pull request: ${url}`);
      setOutput(env, "comment-url", url);
    } catch (error) {
      const hint =
        error instanceof GitHubError && (error.status === 403 || error.status === 404)
          ? " Give the job pull-requests: write; pull requests from forks get a read-only token, so the receipt is in the job summary only."
          : "";
      log(
        `::warning::${escapeCommand(`Could not comment on the pull request: ${errorLine(error)}.${hint}`)}`,
      );
    }
  }

  if (receipt.verdict === "failed") {
    log(`::error::${escapeCommand(`Proof receipt: ${receiptHeadline(receipt)}`)}`);
    return inputs.failOnFailure ? 1 : 0;
  }
  return 0;
}

export async function main(command: string | undefined, io: ActionIo): Promise<number> {
  if (command === "run") return run(io);
  if (command === "report") return report(io);
  io.log(`::error::Unknown command ${command ?? "(none)"}: expected run or report`);
  return 2;
}
