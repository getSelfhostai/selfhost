/**
 * In-memory stand-ins for each provider's SDK or API, shaped like the real ones (the shapes are
 * type-checked against the real SDKs in sdk-shapes.ts). Commands run in the test shell. Nothing
 * leaves the process.
 */
import type { Fetch } from "@selfhost/integrations";
import type { CoderSocket, CoderSocketFactory } from "../src/adapters/coder.js";
import type { DaytonaBox, DaytonaSdk } from "../src/adapters/daytona.js";
import type { E2BBox, E2BInfo, E2BSdk } from "../src/adapters/e2b.js";
import type { ModalBox, ModalSdk, ModalStream } from "../src/adapters/modal.js";
import type {
  OpenSandboxBox,
  OpenSandboxInfo,
  OpenSandboxSdk,
} from "../src/adapters/opensandbox.js";
import { runShell, type ShellOptions } from "./shell.js";

export interface CloudBox {
  id: string;
  labels: Record<string, string>;
  files: Map<string, Uint8Array>;
  alive: boolean;
  createdAt: Date;
  cpu: number;
  memoryGiB: number;
  env: Record<string, string>;
  params: Record<string, unknown>;
}

/** One fake provider account: its sandboxes, and the clock commands see. */
export class Cloud {
  readonly boxes = new Map<string, CloudBox>();
  private next = 1;
  constructor(
    readonly prefix: string,
    readonly now: () => Date = () => new Date(),
  ) {}

  add(
    labels: Record<string, string>,
    params: Record<string, unknown>,
    size = { cpu: 2, memoryGiB: 4 },
  ) {
    const box: CloudBox = {
      id: `${this.prefix}-${this.next++}`,
      labels: { ...labels },
      files: new Map(),
      alive: true,
      createdAt: this.now(),
      env: {},
      params,
      ...size,
    };
    this.boxes.set(box.id, box);
    return box;
  }

  live(id: string): CloudBox {
    const box = this.boxes.get(id);
    if (!box?.alive) throw Object.assign(new Error(`no sandbox ${id}`), { name: "NotFoundError" });
    return box;
  }

  run(box: CloudBox, command: string, options: ShellOptions = {}) {
    if (!box.alive) throw new Error(`sandbox ${box.id} is not running`);
    return runShell(command, box, { ...options, env: { ...box.env, ...options.env } });
  }
}

const matches = (have: Record<string, string>, want: Record<string, string> | undefined) =>
  Object.entries(want ?? {}).every(([key, value]) => have[key] === value);

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function fakeE2B(cloud: Cloud): E2BSdk {
  const info = (box: CloudBox): E2BInfo => ({
    sandboxId: box.id,
    metadata: box.labels,
    startedAt: box.createdAt,
    state: "running",
    cpuCount: box.cpu,
    memoryMB: box.memoryGiB * 1024,
  });
  const handle = (box: CloudBox): E2BBox => ({
    sandboxId: box.id,
    commands: {
      async run(cmd, opts) {
        const result = cloud.run(box, cmd, {
          ...(opts.cwd ? { cwd: opts.cwd } : {}),
          ...(opts.envs ? { env: opts.envs } : {}),
          ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
        });
        if (result.stdout) opts.onStdout?.(result.stdout);
        if (result.stderr) opts.onStderr?.(result.stderr);
        if (result.timedOut) throw Object.assign(new Error("deadline"), { name: "TimeoutError" });
        if (result.exitCode !== 0) {
          throw Object.assign(new Error("exit"), { name: "CommandExitError", ...result });
        }
        return result;
      },
    },
    files: {
      async write(path, data) {
        cloud.live(box.id);
        box.files.set(
          path,
          typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data),
        );
        return {};
      },
      async read(path) {
        const file = box.files.get(path);
        if (!file)
          throw Object.assign(new Error(`${path} not found`), { name: "FileNotFoundError" });
        return file;
      },
    },
    async createSnapshot() {
      return { snapshotId: `snap-${box.id}` };
    },
    async getInfo() {
      return info(cloud.live(box.id));
    },
    async isRunning() {
      return box.alive;
    },
    async kill() {
      box.alive = false;
      return true;
    },
  });
  return {
    Sandbox: {
      async create(_template, opts) {
        const box = cloud.add((opts.metadata as Record<string, string>) ?? {}, opts);
        box.env = { ...(opts.envs as Record<string, string>) };
        return handle(box);
      },
      async connect(id) {
        return handle(cloud.live(id));
      },
      list(opts) {
        const want = (opts.query as { metadata?: Record<string, string> }).metadata;
        const items = [...cloud.boxes.values()].filter((b) => b.alive && matches(b.labels, want));
        let done = false;
        return {
          get hasNext() {
            return !done;
          },
          async nextItems() {
            done = true;
            return items.map(info);
          },
        };
      },
    },
  };
}

/** GET .../v2/sandboxes/{id}/logs for the fake E2B: one boot line. */
export const e2bLogs: Fetch = async (url) => {
  const cursor = Number(new URL(url).searchParams.get("cursor") ?? "0");
  const logs =
    cursor === 0 ? [{ message: "envd started", timestamp: "2026-11-09T10:00:00.000Z" }] : [];
  return new Response(JSON.stringify({ logs }), { status: 200 });
};

export function fakeDaytona(cloud: Cloud): DaytonaSdk {
  const handle = (box: CloudBox): DaytonaBox => ({
    id: box.id,
    labels: box.labels,
    get state() {
      return box.alive ? "started" : "destroyed";
    },
    cpu: box.cpu,
    memory: box.memoryGiB,
    disk: 3,
    target: "us",
    createdAt: box.createdAt.toISOString(),
    process: {
      async executeCommand(command, cwd, env, timeout) {
        const result = cloud.run(box, command, {
          ...(cwd ? { cwd } : {}),
          ...(env ? { env } : {}),
          ...(timeout ? { timeoutMs: timeout * 1000 } : {}),
        });
        if (result.timedOut) {
          await delay((timeout ?? 0) * 1000);
          return { exitCode: -1, result: result.stdout };
        }
        return { exitCode: result.exitCode, result: result.stdout + result.stderr };
      },
    },
    fs: {
      async uploadFile(file, path) {
        cloud.live(box.id).files.set(path, new Uint8Array(file));
      },
      async downloadFile(path) {
        const file = box.files.get(path);
        if (!file) throw new Error(`file ${path} not found`);
        return Buffer.from(file);
      },
    },
    async createSnapshot() {},
    async refreshData() {},
    async delete() {
      box.alive = false;
    },
  });
  return {
    Daytona: class {
      async create(params: Record<string, unknown>) {
        const resources = params.resources as { cpu?: number; memory?: number } | undefined;
        const box = cloud.add((params.labels as Record<string, string>) ?? {}, params, {
          cpu: resources?.cpu ?? 1,
          memoryGiB: resources?.memory ?? 1,
        });
        box.env = { ...(params.envVars as Record<string, string>) };
        return handle(box);
      }
      async get(id: string) {
        const box = cloud.boxes.get(id);
        if (!box) throw new Error(`Sandbox ${id} not found`);
        return handle(box);
      }
      async *list(query?: Record<string, unknown>) {
        const want = query?.labels as Record<string, string> | undefined;
        for (const box of cloud.boxes.values()) {
          if (matches(box.labels, want)) yield handle(box);
        }
      }
    } as unknown as DaytonaSdk["Daytona"],
  };
}

const stream = (text: string): ModalStream => {
  let sent = false;
  return {
    getReader: () => ({
      async read() {
        if (sent || !text) return { done: true };
        sent = true;
        return { done: false, value: text };
      },
    }),
  };
};

export function fakeModal(cloud: Cloud): ModalSdk {
  const handle = (box: CloudBox): ModalBox => ({
    sandboxId: box.id,
    async exec(command, params) {
      const script =
        command[0] === "sh" && command[1] === "-c" ? (command[2] ?? "") : command.join(" ");
      const result = cloud.run(box, script, {
        ...(params.workdir ? { cwd: params.workdir } : {}),
        ...(params.env ? { env: params.env } : {}),
        ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
      });
      if (result.timedOut) await delay(params.timeoutMs ?? 0);
      return {
        stdout: stream(result.stdout),
        stderr: stream(result.stderr),
        wait: async () => (result.timedOut ? 137 : result.exitCode),
      };
    },
    async getTags() {
      return box.labels;
    },
    async poll() {
      return box.alive ? null : 0;
    },
    async terminate() {
      box.alive = false;
    },
    async snapshotFilesystem() {
      return { imageId: `im-${box.id}` };
    },
    logs: {
      async *fetch({ since }) {
        if (since.getTime() <= box.createdAt.getTime()) {
          yield { message: "sandbox started\n", timestamp: box.createdAt };
        }
      },
    },
  });
  return {
    ModalClient: class {
      apps = { fromName: async () => ({ appId: "ap-selfhost" }) };
      images = { fromRegistry: (tag: string) => ({ tag }), fromId: async (id: string) => ({ id }) };
      secrets = { fromObject: async (entries: Record<string, string>) => ({ entries }) };
      sandboxes = {
        create: async (_app: unknown, _image: unknown, params: Record<string, unknown>) => {
          const box = cloud.add((params.tags as Record<string, string>) ?? {}, params, {
            cpu: (params.cpu as number) * 2,
            memoryGiB: (params.memoryMiB as number) / 1024,
          });
          box.env = { ...(params.env as Record<string, string>) };
          for (const secret of (params.secrets as { entries: Record<string, string> }[]) ?? []) {
            Object.assign(box.env, secret.entries);
          }
          return handle(box);
        },
        fromId: async (id: string) => {
          const box = cloud.boxes.get(id);
          if (!box) throw new Error(`Sandbox ${id} not found`);
          return handle(box);
        },
        list: async function* (params: { tags?: Record<string, string> }) {
          for (const box of cloud.boxes.values()) {
            if (box.alive && matches(box.labels, params.tags)) yield handle(box);
          }
        },
      };
    } as unknown as ModalSdk["ModalClient"],
  };
}

export function fakeOpenSandbox(cloud: Cloud): OpenSandboxSdk {
  const info = (box: CloudBox): OpenSandboxInfo => ({
    id: box.id,
    metadata: box.labels,
    status: { state: box.alive ? "Running" : "Deleted" },
    createdAt: box.createdAt,
  });
  const handle = (box: CloudBox): OpenSandboxBox => ({
    id: box.id,
    commands: {
      async run(command, opts, handlers) {
        const result = cloud.run(box, command, {
          ...(opts.workingDirectory ? { cwd: opts.workingDirectory } : {}),
          ...(opts.envs ? { env: opts.envs } : {}),
          ...(opts.timeoutSeconds ? { timeoutMs: opts.timeoutSeconds * 1000 } : {}),
        });
        if (result.timedOut) await delay((opts.timeoutSeconds ?? 0) * 1000);
        if (result.stdout) handlers.onStdout?.({ text: result.stdout });
        if (result.stderr) handlers.onStderr?.({ text: result.stderr });
        const exitCode = result.timedOut ? 137 : result.exitCode;
        return {
          logs: { stdout: [{ text: result.stdout }], stderr: [{ text: result.stderr }] },
          exitCode,
          ...(exitCode !== 0 ? { error: { name: "CommandError", value: String(exitCode) } } : {}),
        };
      },
    },
    files: {
      async writeFiles(entries) {
        for (const entry of entries) {
          cloud
            .live(box.id)
            .files.set(
              entry.path,
              typeof entry.data === "string" ? new TextEncoder().encode(entry.data) : entry.data,
            );
        }
      },
      async readBytes(path) {
        const file = box.files.get(path);
        if (!file) throw new Error(`${path}: no such file`);
        return file;
      },
    },
    async getInfo() {
      return info(box);
    },
    credentialVault: {
      async create(request: never) {
        box.params.credentialVault = request;
        return {};
      },
    },
    async kill() {
      box.alive = false;
    },
    async close() {},
  });
  return {
    Sandbox: {
      async create(opts) {
        const resource = opts.resource as { cpu: string; memory: string };
        const box = cloud.add((opts.metadata as Record<string, string>) ?? {}, opts, {
          cpu: Number(resource.cpu),
          memoryGiB: Number.parseFloat(resource.memory),
        });
        box.env = { ...(opts.env as Record<string, string>) };
        return handle(box);
      },
      async connect(opts) {
        return handle(cloud.live(opts.sandboxId));
      },
    },
    SandboxManager: {
      create: () => ({
        async listSandboxInfos(filter) {
          const items = [...cloud.boxes.values()]
            .filter((box) => box.alive && matches(box.labels, filter.metadata))
            .map(info);
          return { items, pagination: { hasNextPage: false } };
        },
        async createSnapshot(id) {
          return { id: `snap-${id}` };
        },
        async close() {},
      }),
    },
  };
}

/** A Coder deployment: the REST routes the adapter calls, and the agent PTY WebSocket. */
export function fakeCoder(cloud: Cloud, base = "https://coder.example.com") {
  const token = "coder-test-token";
  const builds = new Map<string, { status: string; transition: string }>();
  const workspace = (box: CloudBox) => {
    const build = builds.get(box.id) ?? { status: "running", transition: "start" };
    return {
      id: box.id,
      name: box.labels.name ?? box.id,
      latest_build: {
        id: `build-${box.id}`,
        ...build,
        created_at: box.createdAt.toISOString(),
        resources: [{ agents: [{ id: `agent-${box.id}`, lifecycle_state: "ready" }] }],
      },
    };
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetch: Fetch = async (url, init = {}) => {
    const headers = new Headers(init.headers);
    if (headers.get("coder-session-token") !== token) return json({ message: "unauthorized" }, 401);
    const path = url.slice(`${base}/api/v2`.length);
    const method = init.method ?? "GET";
    if (method === "GET" && path === "/users/me") return json({ organization_ids: ["org-1"] });
    if (method === "GET" && path.startsWith("/organizations/org-1/templates/")) {
      return json({ id: "8b7c3c1e-0000-4000-8000-000000000001" });
    }
    if (method === "POST" && path === "/users/me/workspaces") {
      const body = JSON.parse(String(init.body)) as { name: string };
      const box = cloud.add({ name: body.name }, body);
      return json(workspace(box), 201);
    }
    if (method === "GET" && path.startsWith("/workspaces?q=")) {
      return json({ workspaces: [...cloud.boxes.values()].filter((b) => b.alive).map(workspace) });
    }
    const builds_ = /^\/workspaces\/([^/]+)\/builds$/.exec(path);
    if (method === "POST" && builds_?.[1]) {
      const box = cloud.boxes.get(builds_[1]);
      if (!box) return json({}, 404);
      box.alive = false;
      builds.set(box.id, { status: "deleted", transition: "delete" });
      return json({}, 201);
    }
    const one = /^\/workspaces\/([^/?]+)$/.exec(path);
    if (method === "GET" && one?.[1]) {
      const box = cloud.boxes.get(one[1]);
      return box ? json(workspace(box)) : json({ message: "not found" }, 404);
    }
    return json({ message: `no route ${method} ${path}` }, 404);
  };
  const webSocket: CoderSocketFactory = (url, socketHeaders) => {
    const parsed = new URL(url);
    const agent = /workspaceagents\/agent-([^/]+)\/pty/.exec(parsed.pathname)?.[1] ?? "";
    const socket: CoderSocket = {
      binaryType: "blob",
      onmessage: null,
      onclose: null,
      onerror: null,
      send() {},
      close() {
        setTimeout(() => socket.onclose?.(), 0);
      },
    };
    setTimeout(() => {
      if (socketHeaders["coder-session-token"] !== token) {
        socket.onerror?.({ message: "401" });
        return;
      }
      const box = cloud.boxes.get(agent);
      if (!box?.alive) {
        socket.onerror?.({ message: "agent offline" });
        return;
      }
      const result = runShell(parsed.searchParams.get("command") ?? "", box, { timeoutMs: 5000 });
      if (result.timedOut) return; // A long command: the socket stays open until closed.
      const output = (result.stdout + result.stderr).replace(/\n/g, "\r\n");
      socket.onmessage?.({ data: new TextEncoder().encode(output).buffer });
      socket.onclose?.();
    }, 0);
    return socket;
  };
  return { fetch, webSocket, token, base };
}
