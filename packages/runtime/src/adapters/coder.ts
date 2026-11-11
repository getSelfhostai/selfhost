import { randomBytes, randomUUID } from "node:crypto";
import { costOf, hourlyPrice, RUNTIMES } from "../catalog.js";
import type {
  ExecOptions,
  ExecResult,
  RuntimeAdapter,
  Sandbox,
  SandboxSpec,
  SandboxState,
} from "../types.js";
import {
  bytesOf,
  cloneCommand,
  emit,
  LogBuffer,
  readFileCommand,
  readFileOutput,
  secretValues,
  shellCommand,
  shellQuote,
  timedOutResult,
} from "./common.js";
import type { AdapterOptions } from "./options.js";

/**
 * Coder through its REST API only (/api/v2); no Coder code is used, so its AGPL never reaches
 * selfhost. A sandbox is a workspace made from [runtime.providers.coder] template. Commands run
 * through the workspace agent's reconnecting PTY, a WebSocket the API serves.
 */

/** A WebSocket as this adapter uses it; the global one in Node 22 and later fits. */
export interface CoderSocket {
  binaryType: string;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export type CoderSocketFactory = (url: string, headers: Record<string, string>) => CoderSocket;

export interface CoderOptions extends AdapterOptions {
  /** Opens the agent PTY WebSocket. Default: the global WebSocket, with the token header. */
  webSocket?: CoderSocketFactory;
  /** How long create waits for the workspace agent. Default 10 minutes. */
  readyTimeoutMs?: number;
}

interface Build {
  id: string;
  status: string;
  transition: string;
  created_at: string;
  updated_at?: string;
  resources?: { agents?: { id: string; lifecycle_state?: string; status?: string }[] }[];
}

interface Workspace {
  id: string;
  name: string;
  latest_build: Build;
}

/** Workspaces selfhost makes are named with this prefix, since a workspace has no labels. */
export const CODER_PREFIX = "selfhost-";
/** Marks a command's exit status in the PTY output. */
const EXIT_MARKER = "__SELFHOST_EXIT__";
/** Base64 characters per write call, to keep each command short. */
const WRITE_CHUNK = 3000;
/** The PTY reader prints this once echo is off and it waits for the command. */
export const PTY_READY_MARKER = "__SELFHOST_READY__";

/**
 * What the PTY URL runs: a fixed reader. The command itself, with the run's environment and
 * secrets, goes over the socket once the reader says it is ready, base64 encoded on one line
 * with echo off, so no value is ever in a URL, where proxies and Coder's own logs keep it.
 */
export const PTY_BOOTSTRAP = `sh -c 'stty -echo -icanon 2>/dev/null; echo ${PTY_READY_MARKER}; IFS= read -r c; eval "$(printf %s "$c" | base64 -d)"'`;

/** A Coder build's status, mapped to the contract's. */
export function coderState(build: Build | undefined): SandboxState {
  if (!build) return "stopped";
  if (build.transition === "delete" || build.transition === "stop") {
    return build.status === "failed" ? "failed" : "stopped";
  }
  switch (build.status) {
    case "running":
      return "running";
    case "failed":
      return "failed";
    case "pending":
    case "starting":
      return "starting";
    default:
      return "stopped";
  }
}

/** The PTY's output with the exit marker taken out, line endings made \n. */
export function parsePtyOutput(raw: string): { exitCode: number | undefined; output: string } {
  const text = raw.replace(/\r\n/g, "\n");
  const match = new RegExp(`\\n?${EXIT_MARKER}(\\d+)\\n?`).exec(text);
  if (!match) return { exitCode: undefined, output: text };
  return {
    exitCode: Number(match[1]),
    output: text.slice(0, match.index) + text.slice(match.index + match[0].length),
  };
}

const defaultSocket: CoderSocketFactory = (url, headers) => {
  const WebSocketClass = (
    globalThis as { WebSocket?: new (url: string, init?: unknown) => CoderSocket }
  ).WebSocket;
  if (!WebSocketClass) {
    throw new Error("The Coder runtime needs Node 22 or later, which has a built-in WebSocket.");
  }
  return new WebSocketClass(url, { headers });
};

export function coderRuntime(options: CoderOptions): RuntimeAdapter {
  const now = options.now ?? (() => new Date());
  const fetch = options.fetch ?? globalThis.fetch;
  const openSocket = options.webSocket ?? defaultSocket;
  const pollMs = options.logPollMs ?? 2000;
  const base = (options.settings.url ?? "").replace(/\/+$/, "");
  const token = { "coder-session-token": options.credentials.key };
  const stopped = new Map<string, number>();
  const logs = new Map<string, LogBuffer>();
  /** Environment for each workspace's commands: spec env and secrets, held by this process only. */
  const envs = new Map<string, Record<string, string>>();

  async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${base}/api/v2${path}`, {
      method,
      headers: { ...token, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const error = new Error(`Coder ${method} ${path} answered ${response.status}`) as Error & {
        status: number;
      };
      error.status = response.status;
      throw error;
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async function templateId(template: string): Promise<string> {
    if (/^[0-9a-f-]{36}$/i.test(template)) return template;
    const me = await api<{ organization_ids: string[] }>("GET", "/users/me");
    const org = me.organization_ids[0];
    if (!org) throw new Error("The Coder user behind the token belongs to no organization.");
    const found = await api<{ id: string }>(
      "GET",
      `/organizations/${org}/templates/${encodeURIComponent(template)}`,
    );
    return found.id;
  }

  const agentOf = (workspace: Workspace) =>
    workspace.latest_build.resources?.flatMap((resource) => resource.agents ?? [])[0];

  /**
   * Runs one command in the agent's PTY; stdout and stderr arrive merged. The URL carries only
   * PTY_BOOTSTRAP; the command and its environment go on the socket once the reader is ready.
   */
  function pty(agent: string, command: string, execOptions: ExecOptions, log?: LogBuffer) {
    const wrapped = `sh -c ${shellQuote(command)}; printf '\\n${EXIT_MARKER}%s\\n' "$?"`;
    const url = new URL(`${base}/api/v2/workspaceagents/${agent}/pty`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("reconnect", randomUUID());
    url.searchParams.set("width", "200");
    url.searchParams.set("height", "50");
    url.searchParams.set("command", PTY_BOOTSTRAP);
    return new Promise<ExecResult>((resolve, reject) => {
      const socket = openSocket(url.toString(), token);
      socket.binaryType = "arraybuffer";
      let prelude = "";
      let ready = false;
      let raw = "";
      let done = false;
      const decoder = new TextDecoder();
      const timer = execOptions.timeoutMs
        ? setTimeout(() => {
            done = true;
            socket.close();
            resolve(timedOutResult(parsePtyOutput(raw).output));
          }, execOptions.timeoutMs)
        : undefined;
      socket.onmessage = (event) => {
        let text =
          typeof event.data === "string"
            ? event.data
            : decoder.decode(new Uint8Array(event.data as ArrayBuffer), { stream: true });
        if (!ready) {
          prelude += text;
          const at = prelude.indexOf(PTY_READY_MARKER);
          if (at === -1) return;
          ready = true;
          text = prelude.slice(at + PTY_READY_MARKER.length).replace(/^\r?\n/, "");
          socket.send(JSON.stringify({ data: `${Buffer.from(wrapped).toString("base64")}\n` }));
          if (text === "") return;
        }
        raw += text;
        const shown = text.replace(new RegExp(`\\r?\\n?${EXIT_MARKER}\\d*\\r?\\n?`), "");
        emit(execOptions, log, "stdout", shown.replace(/\r\n/g, "\n"));
      };
      socket.onerror = (event) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(
          new Error(
            `The Coder agent PTY failed: ${String((event as { message?: string }).message ?? "error")}`,
          ),
        );
      };
      socket.onclose = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const { exitCode, output } = parsePtyOutput(raw);
        resolve({ exitCode: exitCode ?? 255, stdout: output, stderr: "", timedOut: false });
      };
    });
  }

  function wrap(workspace: Workspace): Sandbox {
    const id = workspace.id;
    const started = Date.parse(workspace.latest_build.created_at);
    const rate = hourlyPrice("coder", RUNTIMES.coder.defaultSize, {
      usdPerHour: options.settings.usd_per_hour,
    });
    const log = logs.get(id) ?? new LogBuffer();
    logs.set(id, log);
    const agent = agentOf(workspace)?.id ?? "";
    const state = async (): Promise<SandboxState> => {
      if (stopped.has(id)) return "stopped";
      try {
        return coderState((await api<Workspace>("GET", `/workspaces/${id}`)).latest_build);
      } catch {
        return "stopped";
      }
    };
    const run = (command: string, execOptions: ExecOptions = {}) =>
      pty(
        agent,
        shellCommand(command, {
          ...(execOptions.cwd ? { cwd: execOptions.cwd } : {}),
          env: { ...envs.get(id), ...execOptions.env },
        }),
        execOptions,
        log,
      );
    return {
      id,
      runtime: "coder",
      async exec(command, execOptions = {}) {
        if (stopped.has(id)) throw new Error(`Sandbox ${id} is stopped`);
        log.push(`$ ${command}`);
        return run(command, execOptions);
      },
      async writeFile(path, content) {
        const encoded = Buffer.from(bytesOf(content)).toString("base64");
        const staged = `${path}.selfhost-b64`;
        const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) || "/" : ".";
        let step = await run(`mkdir -p ${shellQuote(dir)} && : > ${shellQuote(staged)}`);
        for (let at = 0; step.exitCode === 0 && at < encoded.length; at += WRITE_CHUNK) {
          step = await run(
            `printf %s ${shellQuote(encoded.slice(at, at + WRITE_CHUNK))} >> ${shellQuote(staged)}`,
          );
        }
        if (step.exitCode === 0) {
          step = await run(
            `base64 -d ${shellQuote(staged)} > ${shellQuote(path)} && rm -f ${shellQuote(staged)}`,
          );
        }
        if (step.exitCode !== 0) {
          throw new Error(`Could not write ${path} in workspace ${id}: ${step.stdout.trim()}`);
        }
      },
      async readFile(path) {
        return readFileOutput(path, await run(readFileCommand(path)), id);
      },
      logs(signal) {
        return log.read(signal);
      },
      async snapshot(): Promise<{ id: string }> {
        throw new Error("Coder workspaces have no snapshots; start a new one from the template.");
      },
      status: state,
      async cost() {
        const end = stopped.get(id) ?? now().getTime();
        const seconds = Math.max(0, Math.round((end - started) / 1000));
        return { seconds, usd: costOf(seconds, rate), source: "list_price" as const };
      },
      async stop() {
        if (stopped.has(id)) return;
        await api("POST", `/workspaces/${id}/builds`, { transition: "delete" });
        stopped.set(id, now().getTime());
        envs.delete(id);
        log.close();
      },
    };
  }

  async function ready(id: string): Promise<Workspace> {
    const deadline = Date.now() + (options.readyTimeoutMs ?? 600_000);
    for (;;) {
      const workspace = await api<Workspace>("GET", `/workspaces/${id}`);
      const status = workspace.latest_build.status;
      const agent = agentOf(workspace);
      if (status === "failed" || status === "canceled") {
        throw new Error(`Coder workspace ${workspace.name} failed to start (${status}).`);
      }
      if (status === "running" && agent && (agent.lifecycle_state ?? "ready") === "ready") {
        return workspace;
      }
      if (Date.now() > deadline) {
        throw new Error(`Coder workspace ${workspace.name} was not ready in time.`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  return {
    kind: "coder",
    capabilities: {
      egress: false,
      secrets: false,
      snapshot: false,
      regions: [],
      labels: false,
      stderr: false,
    },
    async create(spec: SandboxSpec) {
      const template = spec.image ?? options.settings.template;
      if (!template) {
        throw new Error(
          "Set template in [runtime.providers.coder] to the Coder template background runs use.",
        );
      }
      const created = await api<Workspace>("POST", "/users/me/workspaces", {
        template_id: await templateId(template),
        name: `${CODER_PREFIX}${randomBytes(6).toString("hex")}`,
        ttl_ms: spec.timeoutMinutes * 60_000,
      });
      envs.set(created.id, { ...spec.env, ...(await secretValues(spec, options.secrets)) });
      const sandbox = wrap(await ready(created.id));
      if (spec.repo) {
        const cloned = await sandbox.exec(cloneCommand(spec.repo));
        if (cloned.exitCode !== 0) {
          await sandbox.stop();
          throw new Error(`Could not clone ${spec.repo.url}: ${cloned.stdout.trim()}`);
        }
      }
      return sandbox;
    },
    async get(id) {
      if (stopped.has(id)) return undefined;
      try {
        const workspace = await api<Workspace>("GET", `/workspaces/${id}`);
        const state = coderState(workspace.latest_build);
        return state === "stopped" || !workspace.name.startsWith(CODER_PREFIX)
          ? undefined
          : wrap(workspace);
      } catch {
        return undefined;
      }
    },
    async list() {
      const query = encodeURIComponent(`owner:me name:${CODER_PREFIX}`);
      const answer = await api<{ workspaces: Workspace[] }>("GET", `/workspaces?q=${query}`);
      return answer.workspaces
        .filter(
          (workspace) => workspace.name.startsWith(CODER_PREFIX) && !stopped.has(workspace.id),
        )
        .map((workspace) => ({ id: workspace.id, state: coderState(workspace.latest_build) }))
        .filter((entry) => entry.state !== "stopped");
    },
  };
}
