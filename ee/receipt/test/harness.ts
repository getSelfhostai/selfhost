import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FakeGitHubServer,
  type FakeState,
  OIDC_REQUEST_TOKEN,
  startFakeGitHub,
} from "./fake-github.js";
import { SAMPLE_APP } from "./helpers.js";

export const REPO = "acme/sample-app";
export const PULL = 7;
export const HEAD = "5786c5c9d81ca4218b7e44bf0007f5580f66c489";
export const BASE = "c3b8739bdcca2b4e2f5bdead2a8f238916813446";

export interface Harness {
  root: string;
  github: FakeGitHubServer;
  env: NodeJS.ProcessEnv;
  outputs(): Record<string, string>;
  summary(): string;
  close(): Promise<void>;
}

export interface HarnessOptions {
  /** The pull request's branch; codex/ makes it an agent pull request. */
  headRef?: string;
  event?: "pull_request" | "push";
  github?: Partial<FakeState>;
  inputs?: Record<string, string>;
  /** Changes made to the sample app's checkout before the run. */
  prepare?: (root: string) => void;
}

/**
 * A copy of the sample app as the checkout, a pull_request event for it, the fake GitHub API,
 * and the environment GitHub Actions gives the action's steps.
 */
export async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const temp = mkdtempSync(join(tmpdir(), "selfhost-receipt-action-"));
  const root = join(temp, "workspace");
  cpSync(SAMPLE_APP, root, { recursive: true });
  options.prepare?.(root);
  const github = await startFakeGitHub(REPO, PULL, HEAD, {
    files: [
      { filename: "src/greet.test.mjs", status: "modified" },
      { filename: "pages/about.html", status: "modified" },
    ],
    ...options.github,
  });
  const headRef = options.headRef ?? "codex/greeting";
  const event =
    options.event === "push"
      ? { ref: "refs/heads/main" }
      : {
          action: "synchronize",
          pull_request: {
            number: PULL,
            html_url: `https://github.com/${REPO}/pull/${PULL}`,
            body: "Greets by name.",
            user: { login: "dev", type: "User" },
            head: { sha: HEAD, ref: headRef },
            base: { sha: BASE, ref: "main" },
          },
        };
  writeFileSync(join(temp, "event.json"), JSON.stringify(event));
  mkdirSync(join(temp, "runner"), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...(process.env.PLAYWRIGHT_BROWSERS_PATH
      ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }
      : {}),
    ...(process.env.SELFHOST_RECEIPT_PLAYWRIGHT
      ? { SELFHOST_RECEIPT_PLAYWRIGHT: process.env.SELFHOST_RECEIPT_PLAYWRIGHT }
      : {}),
    GITHUB_ACTIONS: "true",
    GITHUB_WORKSPACE: root,
    GITHUB_REPOSITORY: REPO,
    GITHUB_EVENT_NAME: options.event ?? "pull_request",
    GITHUB_EVENT_PATH: join(temp, "event.json"),
    GITHUB_API_URL: github.url,
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_RUN_ID: "9001",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_WORKFLOW: "CI",
    GITHUB_OUTPUT: join(temp, "output"),
    GITHUB_STEP_SUMMARY: join(temp, "summary.md"),
    RUNNER_TEMP: join(temp, "runner"),
    ACTIONS_ID_TOKEN_REQUEST_URL: `${github.url}/oidc?api-version=2.0`,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: OIDC_REQUEST_TOKEN,
    INPUT_GITHUB_TOKEN: "fake-workflow-token",
    INPUT_SCREENSHOTS: "false",
    ...Object.fromEntries(
      Object.entries(options.inputs ?? {}).map(([name, value]) => [`INPUT_${name}`, value]),
    ),
  };
  const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");
  return {
    root,
    github,
    env,
    outputs: () =>
      Object.fromEntries(
        read(join(temp, "output"))
          .split("\n")
          .filter(Boolean)
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      ),
    summary: () => read(join(temp, "summary.md")),
    async close() {
      await github.close();
      rmSync(temp, { recursive: true, force: true });
    },
  };
}

/** A Vercel preview deployment of the head commit, served at `url`. */
export function previewDeployment(url: string): FakeState["deployments"][number] {
  return {
    id: 1,
    environment: "Preview",
    created_at: "2026-11-08T10:00:00Z",
    creator: { login: "vercel[bot]" },
    statuses: [{ state: "success", environment_url: url }],
  };
}
