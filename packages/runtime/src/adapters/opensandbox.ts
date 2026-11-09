import { openSandboxApi } from "@selfhost/integrations";
import { costOf, hourlyPrice, RUNTIMES, sizeFor } from "../catalog.js";
import type { ExecResult, RuntimeAdapter, Sandbox, SandboxSpec, SandboxState } from "../types.js";
import {
  bytesOf,
  cloneCommand,
  emit,
  LogBuffer,
  labelsMatch,
  labelsOf,
  loadSdk,
  MANAGED_LABEL,
  secretValues,
  timedOutResult,
  withTimeout,
} from "./common.js";
import type { AdapterOptions } from "./options.js";

/** The parts of the OpenSandbox TypeScript SDK (@alibaba-group/opensandbox 1.1, Apache-2.0). */
export interface OpenSandboxSdk {
  Sandbox: {
    create(opts: Record<string, unknown>): Promise<OpenSandboxBox>;
    connect(opts: { sandboxId: string } & Record<string, unknown>): Promise<OpenSandboxBox>;
  };
  SandboxManager: { create(opts: Record<string, unknown>): OpenSandboxManager };
}

export interface OpenSandboxInfo {
  id: string;
  metadata?: Record<string, string>;
  status: { state: string };
  createdAt: Date;
}

export interface OpenSandboxBox {
  id: string;
  commands: {
    run(
      command: string,
      opts: { workingDirectory?: string; timeoutSeconds?: number; envs?: Record<string, string> },
      handlers: {
        onStdout?: (message: { text: string }) => void;
        onStderr?: (message: { text: string }) => void;
      },
    ): Promise<{
      logs: { stdout: { text: string }[]; stderr: { text: string }[] };
      exitCode?: number | null;
      error?: { name: string; value: string };
    }>;
  };
  files: {
    writeFiles(
      entries: { path: string; data: Uint8Array | string; mode?: number }[],
    ): Promise<void>;
    readBytes(path: string): Promise<Uint8Array>;
  };
  getInfo(): Promise<OpenSandboxInfo>;
  credentialVault: { create(request: never): Promise<unknown> };
  kill(): Promise<void>;
  close(): Promise<void>;
}

export interface OpenSandboxManager {
  listSandboxInfos(filter: {
    states?: string[];
    metadata?: Record<string, string>;
    page?: number;
    pageSize?: number;
  }): Promise<{ items: OpenSandboxInfo[]; pagination?: { hasNextPage: boolean } }>;
  createSnapshot(sandboxId: string, request: { name: string }): Promise<{ id: string }>;
  close(): Promise<void>;
}

const DEFAULT_IMAGE = "node:22-bookworm";
const CPU_TAG = "selfhost-cpu";
const MEMORY_TAG = "selfhost-memory-gib";
const LIVE_STATES = ["Creating", "Running", "Pausing", "Paused", "Resuming"];

/** OpenSandbox's states, mapped to the contract's. */
export function openSandboxState(state: string): SandboxState {
  switch (state) {
    case "Running":
      return "running";
    case "Paused":
    case "Pausing":
      return "paused";
    case "Error":
      return "failed";
    case "Deleting":
    case "Deleted":
      return "stopped";
    default:
      return "starting";
  }
}

/**
 * The team's own server or cluster through OpenSandbox's SDK: Docker on a laptop or its
 * Kubernetes operator, the same API either way. url is the server; a server on localhost may run
 * without a key. Egress uses OpenSandbox's per-sandbox network policy (deny by default, the
 * spec's hosts allowed). Cost is the team's usd_per_hour from [runtime.providers.opensandbox],
 * zero without it.
 */
export function openSandboxRuntime(options: AdapterOptions<OpenSandboxSdk>): RuntimeAdapter {
  const now = options.now ?? (() => new Date());
  const load =
    options.load ??
    (() =>
      loadSdk<OpenSandboxSdk>(
        "@alibaba-group/opensandbox",
        RUNTIMES.opensandbox.sdk?.version ?? "",
      ));
  const connectionConfig = {
    domain: openSandboxApi(options.settings.url ?? "http://localhost:8080"),
    ...(options.credentials.key ? { apiKey: options.credentials.key } : {}),
  };
  const manager = async () => (await load()).SandboxManager.create({ connectionConfig });
  const stopped = new Map<string, number>();
  const logs = new Map<string, LogBuffer>();

  function wrap(box: OpenSandboxBox, info: OpenSandboxInfo): Sandbox {
    const started = info.createdAt.getTime();
    const size = {
      cpu: Number(info.metadata?.[CPU_TAG]) || RUNTIMES.opensandbox.defaultSize.cpu,
      memoryGiB: Number(info.metadata?.[MEMORY_TAG]) || RUNTIMES.opensandbox.defaultSize.memoryGiB,
    };
    const rate = hourlyPrice("opensandbox", size, { usdPerHour: options.settings.usd_per_hour });
    const log = logs.get(box.id) ?? new LogBuffer();
    logs.set(box.id, log);
    const state = async (): Promise<SandboxState> => {
      if (stopped.has(box.id)) return "stopped";
      try {
        return openSandboxState((await box.getInfo()).status.state);
      } catch {
        return "stopped";
      }
    };
    return {
      id: box.id,
      runtime: "opensandbox",
      async exec(command, execOptions = {}): Promise<ExecResult> {
        if (stopped.has(box.id)) throw new Error(`Sandbox ${box.id} is stopped`);
        log.push(`$ ${command}`);
        const timeoutMs = execOptions.timeoutMs;
        const begun = Date.now();
        const answer = await withTimeout(
          box.commands.run(
            command,
            {
              ...(execOptions.cwd ? { workingDirectory: execOptions.cwd } : {}),
              ...(execOptions.env ? { envs: { ...execOptions.env } } : {}),
              ...(timeoutMs ? { timeoutSeconds: Math.max(1, Math.ceil(timeoutMs / 1000)) } : {}),
            },
            {
              onStdout: (message) => emit(execOptions, log, "stdout", message.text),
              onStderr: (message) => emit(execOptions, log, "stderr", message.text),
            },
          ),
          timeoutMs ? timeoutMs + 5000 : undefined,
        );
        if ("timedOut" in answer) return timedOutResult();
        const execution = answer.value;
        const stdout = execution.logs.stdout.map((message) => message.text).join("");
        const stderr = execution.logs.stderr.map((message) => message.text).join("");
        const exitCode = execution.exitCode ?? (execution.error ? 1 : 0);
        if (timeoutMs && exitCode !== 0 && Date.now() - begun >= timeoutMs) {
          return timedOutResult(stdout, stderr);
        }
        return { exitCode, stdout, stderr, timedOut: false };
      },
      async writeFile(path, content) {
        await box.files.writeFiles([{ path, data: bytesOf(content), mode: 644 }]);
      },
      async readFile(path) {
        return new Uint8Array(await box.files.readBytes(path));
      },
      logs(signal) {
        return log.read(signal);
      },
      async snapshot() {
        const admin = await manager();
        try {
          return {
            id: (await admin.createSnapshot(box.id, { name: `selfhost-${now().getTime()}` })).id,
          };
        } finally {
          await admin.close();
        }
      },
      status: state,
      async cost() {
        const end = stopped.get(box.id) ?? now().getTime();
        const seconds = Math.max(0, Math.round((end - started) / 1000));
        return { seconds, usd: costOf(seconds, rate), source: "list_price" as const };
      },
      async stop() {
        if (stopped.has(box.id)) return;
        await box.kill();
        await box.close();
        stopped.set(box.id, now().getTime());
        log.close();
      },
    };
  }

  return {
    kind: "opensandbox",
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
      const size = sizeFor("opensandbox", spec.size);
      const ref = spec.image ?? options.settings.template ?? DEFAULT_IMAGE;
      const env = { ...spec.env, ...(await secretValues(spec, options.secrets)) };
      const box = await sdk.Sandbox.create({
        connectionConfig,
        ...(ref.startsWith("snapshot:") ? { snapshotId: ref.slice(9) } : { image: ref }),
        timeoutSeconds: spec.timeoutMinutes * 60,
        resource: { cpu: String(size.cpu), memory: `${size.memoryGiB}Gi` },
        env,
        metadata: {
          ...labelsOf(spec),
          [CPU_TAG]: String(size.cpu),
          [MEMORY_TAG]: String(size.memoryGiB),
        },
        ...(spec.egress
          ? {
              networkPolicy: {
                defaultAction: "deny",
                egress: spec.egress.allow.map((target) => ({ action: "allow", target })),
              },
            }
          : {}),
        ...spec.native?.create,
        ...(spec.native?.credentialVault ? { credentialProxy: { enabled: true } } : {}),
      });
      if (spec.native?.credentialVault) {
        try {
          await box.credentialVault.create(spec.native.credentialVault as never);
        } catch (error) {
          await box.kill();
          throw error;
        }
      }
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
      if (stopped.has(id)) return undefined;
      const sdk = await load();
      try {
        const box = await sdk.Sandbox.connect({ sandboxId: id, connectionConfig });
        const info = await box.getInfo();
        if (openSandboxState(info.status.state) === "stopped") return undefined;
        return wrap(box, info);
      } catch {
        return undefined;
      }
    },
    async list(labels) {
      const admin = await manager();
      const out: { id: string; state: SandboxState }[] = [];
      try {
        for (let page = 1; ; page++) {
          const answer = await admin.listSandboxInfos({
            states: LIVE_STATES,
            metadata: { ...labels, [MANAGED_LABEL.key]: MANAGED_LABEL.value },
            page,
            pageSize: 100,
          });
          for (const info of answer.items) {
            const state = openSandboxState(info.status.state);
            if (
              stopped.has(info.id) ||
              state === "stopped" ||
              !labelsMatch(info.metadata, labels)
            ) {
              continue;
            }
            out.push({ id: info.id, state });
          }
          if (!answer.pagination?.hasNextPage) break;
        }
      } finally {
        await admin.close();
      }
      return out;
    },
  };
}
