import { spawn } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type AgentId,
  applyAgentConfig,
  GATEWAY_PROFILE,
  type GatewaySpec,
  planAgentConfig,
} from "@selfhost/agents";
import { isolatedEnv, tempDir } from "./exec.js";
import type { Check, VendorId, VendorRun } from "./types.js";

// Whether `selfhost gateway connect` works on a CLI release: the settings it writes go into a
// fresh home, the CLI runs one prompt, and a stand-in gateway on 127.0.0.1 checks the model
// request arrives at the gateway's address with the virtual key. The stand-in answers 401, so no
// model runs, no API key is needed and nothing leaves the machine.

export const CONNECT_CHECK = "gateway-connect";

/** The virtual key the stand-in expects. Not a real key anywhere. */
export const STAND_IN_KEY = "sk-bf-selfhost-compat";

interface ConnectRun {
  agent: AgentId;
  /** Arguments that make the CLI send one model request and exit. */
  args: string[];
  /** Where on the stand-in the model request must land. */
  path: string;
}

const PROMPT = "Reply with the word ok.";

/** One prompt per CLI that connect writes settings for. Cursor can't use a gateway. */
export const CONNECT_RUNS: Partial<Record<VendorId, ConnectRun>> = {
  claude_code: {
    agent: "claude_code",
    args: ["-p", PROMPT, "--max-turns", "1"],
    path: "/llm/anthropic/v1/messages",
  },
  codex: {
    agent: "codex",
    args: ["exec", "--skip-git-repo-check", PROMPT],
    path: "/llm/openai/v1/responses",
  },
  opencode: {
    agent: "opencode",
    args: ["run", "--model", "anthropic/claude-sonnet-4-5", PROMPT],
    path: "/llm/anthropic/v1/messages",
  },
};

export interface SeenRequest {
  method: string;
  path: string;
  /** Which header carried the stand-in's key, or null. */
  keyIn: "authorization" | "x-api-key" | null;
}

function keyHeader(req: IncomingMessage): SeenRequest["keyIn"] {
  if (req.headers.authorization === `Bearer ${STAND_IN_KEY}`) return "authorization";
  if (req.headers["x-api-key"] === STAND_IN_KEY) return "x-api-key";
  return null;
}

/** Runs the CLI against a stand-in gateway until the model request arrives, or it gives up. */
export async function standInSession(
  agent: AgentId,
  command: string,
  args: string[],
  { expect, timeoutMs = 120_000 }: { expect: string; timeoutMs?: number },
): Promise<{ seen: SeenRequest[]; matched: boolean; output: string; error: string | null }> {
  const seen: SeenRequest[] = [];
  let finish: () => void = () => {};
  const arrived = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const server = createServer((req, res) => {
    const request = {
      method: req.method ?? "",
      path: (req.url ?? "").split("?")[0] ?? "",
      keyIn: keyHeader(req),
    };
    seen.push(request);
    req.resume();
    res.writeHead(401, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        type: "error",
        error: { type: "authentication_error", message: "selfhost compat stand-in gateway" },
      }),
    );
    if (request.path.startsWith(expect) && request.keyIn) finish();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/llm`;
  const gateway: GatewaySpec = {
    anthropic: `${base}/anthropic`,
    openai: `${base}/openai/v1`,
    key: STAND_IN_KEY,
  };
  const env = isolatedEnv();
  const home = env.HOME ?? tempDir("home");
  try {
    const plan = planAgentConfig(agent, {
      home,
      processEnv: env,
      profile: GATEWAY_PROFILE,
      gateway,
    });
    const stuck = plan.items.filter((item) => item.status !== "create");
    if (stuck.length > 0) {
      const what = stuck.map((item) => `${item.status}: ${item.message ?? ""}`).join("\n");
      return { seen, matched: false, output: "", error: `connect could not write: ${what}` };
    }
    applyAgentConfig(plan);
    const project = tempDir("project");
    const child = spawn(command, args, { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const exited = new Promise<string | null>((resolve) => {
      child.on("error", (error) => resolve(error.message));
      child.on("exit", () => resolve(null));
    });
    const timer = new Promise<string>((resolve) =>
      setTimeout(() => resolve(`no model request within ${timeoutMs / 1000}s`), timeoutMs).unref(),
    );
    const error = await Promise.race([arrived.then(() => null), exited, timer]);
    child.kill("SIGKILL");
    const matched = seen.some((r) => r.path.startsWith(expect) && r.keyIn !== null);
    return { seen, matched, output: output.slice(-4000), error: matched ? null : error };
  } finally {
    server.close();
  }
}

function describeSeen(seen: SeenRequest[]): string {
  if (seen.length === 0) return "The stand-in gateway got no request.";
  return `The stand-in gateway got: ${seen
    .slice(0, 10)
    .map((r) => `${r.method} ${r.path} (key ${r.keyIn ? `in ${r.keyIn}` : "missing"})`)
    .join(", ")}`;
}

/** Adds the gateway-connect check to one installed CLI's results. */
export async function connectCheck(installed: VendorRun): Promise<VendorRun> {
  const run = CONNECT_RUNS[installed.vendor];
  if (!run || !installed.bin) return installed;
  let check: Check;
  try {
    const result = await standInSession(run.agent, installed.bin, run.args, { expect: run.path });
    const hit = result.seen.find((r) => r.path.startsWith(run.path) && r.keyIn);
    check = hit
      ? {
          id: CONNECT_CHECK,
          status: "pass",
          detail: `With the settings selfhost gateway connect writes, ${hit.method} ${hit.path} reached the stand-in gateway with the virtual key in ${hit.keyIn}`,
        }
      : {
          id: CONNECT_CHECK,
          status: "fail",
          detail: [
            `No ${run.path} request with the virtual key${result.error ? `: ${result.error}` : ""}.`,
            describeSeen(result.seen),
            result.output.trim().split("\n").slice(-12).join("\n"),
          ]
            .filter(Boolean)
            .join("\n"),
        };
  } catch (error) {
    check = {
      id: CONNECT_CHECK,
      status: "fail",
      detail: `The check stopped: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  installed.checks.push(check);
  return installed;
}
