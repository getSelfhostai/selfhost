import { costOf, hourlyPrice, RUNTIMES } from "../catalog.js";
import type { ExecResult, RuntimeAdapter, Sandbox, SandboxSpec, SandboxState } from "../types.js";
import {
  bytesOf,
  cloneCommand,
  emit,
  labelsMatch,
  labelsOf,
  loadSdk,
  MANAGED_LABEL,
  pollLogs,
  secretValues,
  timedOutResult,
} from "./common.js";
import type { AdapterOptions } from "./options.js";

/** The parts of the e2b SDK this adapter uses (e2b 2.59, MIT). */
export interface E2BSdk {
  Sandbox: {
    create(template: string, opts: Record<string, unknown>): Promise<E2BBox>;
    connect(sandboxId: string, opts: Record<string, unknown>): Promise<E2BBox>;
    list(opts: Record<string, unknown>): { hasNext: boolean; nextItems(): Promise<E2BInfo[]> };
  };
}

export interface E2BInfo {
  sandboxId: string;
  metadata: Record<string, string>;
  startedAt: Date;
  state: "running" | "paused";
  cpuCount: number;
  memoryMB: number;
}

export interface E2BBox {
  sandboxId: string;
  commands: {
    run(
      cmd: string,
      opts: {
        cwd?: string;
        envs?: Record<string, string>;
        timeoutMs?: number;
        onStdout?: (data: string) => void;
        onStderr?: (data: string) => void;
      },
    ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  };
  files: {
    write(path: string, data: string | ArrayBuffer): Promise<unknown>;
    read(path: string, opts: { format: "bytes" }): Promise<Uint8Array>;
  };
  createSnapshot(): Promise<{ snapshotId: string }>;
  getInfo(): Promise<E2BInfo>;
  isRunning(): Promise<boolean>;
  kill(): Promise<boolean>;
}

const DEFAULT_TEMPLATE = "base";
const DEFAULT_API = "https://api.e2b.app";

/** The SDK's domain for an API url: https://api.e2b.app is e2b.app. */
function domainOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return new URL(url).hostname.replace(/^api\./, "");
}

/**
 * E2B through its SDK. Egress uses E2B's own allowOut list (every other host is denied); secrets
 * go in as environment variables; sizes come from the template; logs come from GET
 * /v2/sandboxes/{id}/logs. Cost is billed seconds at the list price for the sandbox's CPU and
 * memory.
 */
export function e2bRuntime(options: AdapterOptions<E2BSdk>): RuntimeAdapter {
  const now = options.now ?? (() => new Date());
  const load = options.load ?? (() => loadSdk<E2BSdk>("e2b", RUNTIMES.e2b.sdk?.version ?? ""));
  const fetch = options.fetch ?? globalThis.fetch;
  const connection = {
    apiKey: options.credentials.key,
    ...(domainOf(options.settings.url) ? { domain: domainOf(options.settings.url) } : {}),
  };
  const api = options.settings.url ?? DEFAULT_API;
  const stopped = new Map<string, number>();

  function wrap(box: E2BBox, info: E2BInfo): Sandbox {
    const started = info.startedAt.getTime();
    const rate = hourlyPrice(
      "e2b",
      { cpu: info.cpuCount, memoryGiB: info.memoryMB / 1024 },
      { usdPerHour: options.settings.usd_per_hour },
    );
    const state = async (): Promise<SandboxState> => {
      if (stopped.has(box.sandboxId)) return "stopped";
      try {
        return (await box.isRunning()) ? "running" : "stopped";
      } catch {
        return "stopped";
      }
    };
    return {
      id: box.sandboxId,
      runtime: "e2b",
      async exec(command, execOptions = {}): Promise<ExecResult> {
        if (stopped.has(box.sandboxId)) throw new Error(`Sandbox ${box.sandboxId} is stopped`);
        let stdout = "";
        let stderr = "";
        try {
          const result = await box.commands.run(command, {
            ...(execOptions.cwd ? { cwd: execOptions.cwd } : {}),
            ...(execOptions.env ? { envs: { ...execOptions.env } } : {}),
            timeoutMs: execOptions.timeoutMs ?? 0,
            onStdout: (data) => {
              stdout += data;
              emit(execOptions, undefined, "stdout", data);
            },
            onStderr: (data) => {
              stderr += data;
              emit(execOptions, undefined, "stderr", data);
            },
          });
          return {
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            timedOut: false,
          };
        } catch (error) {
          const failed = error as {
            name?: string;
            exitCode?: unknown;
            stdout?: string;
            stderr?: string;
          };
          if (typeof failed.exitCode === "number") {
            return {
              exitCode: failed.exitCode,
              stdout: failed.stdout ?? stdout,
              stderr: failed.stderr ?? stderr,
              timedOut: false,
            };
          }
          if (failed.name === "TimeoutError" && execOptions.timeoutMs) {
            return timedOutResult(stdout, stderr);
          }
          throw error;
        }
      },
      async writeFile(path, content) {
        const bytes = bytesOf(content);
        await box.files.write(
          path,
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        );
      },
      async readFile(path) {
        return new Uint8Array(await box.files.read(path, { format: "bytes" }));
      },
      logs(signal) {
        return pollLogs(
          async (cursor) => {
            const url = `${api}/v2/sandboxes/${encodeURIComponent(box.sandboxId)}/logs?cursor=${cursor}&direction=forward`;
            const response = await fetch(url, {
              headers: { "x-api-key": options.credentials.key },
            });
            if (!response.ok) return { lines: [], cursor };
            const body = (await response.json()) as {
              logs?: { message: string; timestamp: string }[];
            };
            const logs = body.logs ?? [];
            const last = logs.at(-1);
            return {
              lines: logs.map((entry) => entry.message),
              cursor: last ? Date.parse(last.timestamp) + 1 : cursor,
            };
          },
          async () => (await state()) === "running",
          signal,
          options.logPollMs,
        );
      },
      async snapshot() {
        const snapshot = await box.createSnapshot();
        return { id: snapshot.snapshotId };
      },
      status: state,
      async cost() {
        const end = stopped.get(box.sandboxId) ?? now().getTime();
        const seconds = Math.max(0, Math.round((end - started) / 1000));
        return { seconds, usd: costOf(seconds, rate), source: "list_price" as const };
      },
      async stop() {
        if (stopped.has(box.sandboxId)) return;
        await box.kill();
        stopped.set(box.sandboxId, now().getTime());
      },
    };
  }

  return {
    kind: "e2b",
    capabilities: {
      egress: true,
      secrets: true,
      snapshot: true,
      regions: [],
      labels: true,
      stderr: true,
    },
    async create(spec: SandboxSpec) {
      const sdk = await load();
      const envs = { ...spec.env, ...(await secretValues(spec, options.secrets)) };
      const box = await sdk.Sandbox.create(
        spec.image ?? options.settings.template ?? DEFAULT_TEMPLATE,
        {
          ...connection,
          metadata: labelsOf(spec),
          envs,
          timeoutMs: spec.timeoutMinutes * 60_000,
          ...(spec.egress
            ? { network: { allowOut: [...spec.egress.allow], denyOut: ["0.0.0.0/0"] } }
            : {}),
          ...spec.native?.create,
        },
      );
      const sandbox = wrap(box, await box.getInfo());
      if (spec.repo) {
        const cloned = await sandbox.exec(cloneCommand(spec.repo));
        if (cloned.exitCode !== 0) {
          await sandbox.stop();
          throw new Error(`Could not clone ${spec.repo.url}: ${cloned.stderr.trim()}`);
        }
      }
      return sandbox;
    },
    async get(id) {
      const sdk = await load();
      if (stopped.has(id)) return undefined;
      try {
        const box = await sdk.Sandbox.connect(id, connection);
        return wrap(box, await box.getInfo());
      } catch {
        return undefined;
      }
    },
    async list(labels) {
      const sdk = await load();
      const pages = sdk.Sandbox.list({
        ...connection,
        query: {
          metadata: { ...labels, [MANAGED_LABEL.key]: MANAGED_LABEL.value },
          state: ["running", "paused"],
        },
      });
      const out: { id: string; state: SandboxState }[] = [];
      while (pages.hasNext) {
        for (const info of await pages.nextItems()) {
          if (stopped.has(info.sandboxId) || !labelsMatch(info.metadata, labels)) continue;
          out.push({ id: info.sandboxId, state: info.state === "paused" ? "paused" : "running" });
        }
      }
      return out;
    },
  };
}
