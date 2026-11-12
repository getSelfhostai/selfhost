import { costOf, hourlyPrice, RUNTIMES } from "../catalog.js";
import type { ExecResult, RuntimeAdapter, Sandbox, SandboxSpec, SandboxState } from "../types.js";
import {
  cloneCommand,
  emit,
  LogBuffer,
  labelsMatch,
  labelsOf,
  loadSdk,
  MANAGED_LABEL,
  providerLabels,
  secretValues,
  timedOutResult,
  withTimeout,
} from "./common.js";
import type { AdapterOptions } from "./options.js";

/** The parts of Daytona's Apache-2.0 TypeScript SDK (@daytona/sdk 0.226) this adapter uses. */
export interface DaytonaSdk {
  Daytona: new (config: { apiKey: string; apiUrl?: string; target?: string }) => DaytonaClient;
}

export interface DaytonaClient {
  create(params: Record<string, unknown>, options?: { timeout?: number }): Promise<DaytonaBox>;
  get(sandboxIdOrName: string): Promise<DaytonaBox>;
  list(query?: Record<string, unknown>): AsyncIterable<DaytonaBox>;
}

export interface DaytonaBox {
  id: string;
  labels: Record<string, string>;
  state?: string;
  cpu: number;
  memory: number;
  disk: number;
  target: string;
  createdAt?: string;
  process: {
    executeCommand(
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeout?: number,
    ): Promise<{ exitCode: number; result: string }>;
  };
  fs: {
    uploadFile(file: Buffer, remotePath: string): Promise<void>;
    downloadFile(remotePath: string): Promise<Buffer>;
  };
  createSnapshot(name: string): Promise<void>;
  refreshData(): Promise<void>;
  delete(): Promise<void>;
}

/** Daytona's sandbox states, mapped to the contract's. */
export function daytonaState(state: string | undefined): SandboxState {
  switch (state) {
    case "started":
      return "running";
    case "paused":
    case "pausing":
      return "paused";
    case "error":
    case "build_failed":
      return "failed";
    case "stopped":
    case "stopping":
    case "destroyed":
    case "destroying":
    case "archived":
    case "archiving":
      return "stopped";
    default:
      return "starting";
  }
}

/** An image reference (has a tag or a registry path) rather than a Daytona snapshot name. */
const isImage = (value: string) => value.includes(":") || value.includes("/");

/**
 * Daytona through its Apache SDK only; no Daytona server code is used or bundled. Sandboxes are
 * ephemeral (deleted when stopped), have auto-stop off and live at most timeoutMinutes. Egress
 * uses Daytona's domainAllowList; region is Daytona's target. exec returns stdout and stderr
 * merged, as Daytona does. Logs are what this process ran and what it printed.
 */
export function daytonaRuntime(options: AdapterOptions<DaytonaSdk>): RuntimeAdapter {
  const now = options.now ?? (() => new Date());
  const load =
    options.load ??
    (() => loadSdk<DaytonaSdk>("@daytona/sdk", RUNTIMES.daytona.sdk?.version ?? ""));
  let client: DaytonaClient | undefined;
  const connect = async () => {
    if (client) return client;
    const sdk = await load();
    client = new sdk.Daytona({
      apiKey: options.credentials.key,
      ...(options.settings.url ? { apiUrl: options.settings.url } : {}),
    });
    return client;
  };
  const stopped = new Map<string, number>();
  const logs = new Map<string, LogBuffer>();

  function wrap(box: DaytonaBox): Sandbox {
    const started = box.createdAt ? Date.parse(box.createdAt) : now().getTime();
    const rate = hourlyPrice(
      "daytona",
      { cpu: box.cpu, memoryGiB: box.memory },
      { usdPerHour: options.settings.usd_per_hour, diskGiB: box.disk },
    );
    const log = logs.get(box.id) ?? new LogBuffer();
    logs.set(box.id, log);
    const state = async (): Promise<SandboxState> => {
      if (stopped.has(box.id)) return "stopped";
      try {
        await box.refreshData();
        return daytonaState(box.state);
      } catch {
        return "stopped";
      }
    };
    return {
      id: box.id,
      runtime: "daytona",
      async exec(command, execOptions = {}): Promise<ExecResult> {
        if (stopped.has(box.id)) throw new Error(`Sandbox ${box.id} is stopped`);
        log.push(`$ ${command}`);
        const timeoutMs = execOptions.timeoutMs;
        const begun = Date.now();
        const answer = await withTimeout(
          box.process.executeCommand(
            command,
            execOptions.cwd,
            execOptions.env ? { ...execOptions.env } : undefined,
            timeoutMs ? Math.max(1, Math.ceil(timeoutMs / 1000)) : 0,
          ),
          timeoutMs ? timeoutMs + 5000 : undefined,
        );
        if ("timedOut" in answer) return timedOutResult();
        const { exitCode, result } = answer.value;
        emit(execOptions, log, "stdout", result);
        const timedOut =
          Boolean(timeoutMs) && exitCode !== 0 && Date.now() - begun >= (timeoutMs ?? 0);
        return timedOut
          ? timedOutResult(result)
          : { exitCode, stdout: result, stderr: "", timedOut: false };
      },
      async writeFile(path, content) {
        await box.fs.uploadFile(
          Buffer.from(typeof content === "string" ? new TextEncoder().encode(content) : content),
          path,
        );
      },
      async readFile(path) {
        return new Uint8Array(await box.fs.downloadFile(path));
      },
      logs(signal) {
        return log.read(signal);
      },
      async snapshot() {
        const name = `selfhost-${box.id}-${now().getTime()}`;
        await box.createSnapshot(name);
        return { id: name };
      },
      status: state,
      async cost() {
        const end = stopped.get(box.id) ?? now().getTime();
        const seconds = Math.max(0, Math.round((end - started) / 1000));
        return { seconds, usd: costOf(seconds, rate), source: "list_price" as const };
      },
      async stop() {
        if (stopped.has(box.id)) return;
        await box.delete();
        stopped.set(box.id, now().getTime());
        log.close();
      },
    };
  }

  return {
    kind: "daytona",
    capabilities: {
      egress: true,
      secrets: true,
      snapshot: true,
      regions: RUNTIMES.daytona.regions as readonly string[],
      labels: true,
      stderr: false,
    },
    async create(spec: SandboxSpec) {
      const daytona = await connect();
      const image = spec.image ?? options.settings.template;
      const envVars = { ...spec.env, ...(await secretValues(spec, options.secrets)) };
      const base = {
        labels: labelsOf(spec),
        envVars,
        ephemeral: true,
        autoStopInterval: 0,
        ttlMinutes: spec.timeoutMinutes,
        ...(spec.region ? { target: spec.region } : {}),
        ...(spec.native?.create ??
          (spec.egress ? { domainAllowList: spec.egress.allow.join(",") } : {})),
      };
      const params =
        image && isImage(image)
          ? {
              ...base,
              image,
              ...(spec.size
                ? { resources: { cpu: spec.size.cpu, memory: spec.size.memoryGiB } }
                : {}),
            }
          : { ...base, ...(image ? { snapshot: image } : {}) };
      const box = await daytona.create(params);
      await spec.onCreated?.(box.id);
      const sandbox = wrap(box);
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
      const daytona = await connect();
      try {
        const box = await daytona.get(id);
        return daytonaState(box.state) === "stopped" ? undefined : wrap(box);
      } catch {
        return undefined;
      }
    },
    async list(labels) {
      const daytona = await connect();
      const out: { id: string; state: SandboxState }[] = [];
      for await (const box of daytona.list({
        labels: providerLabels({ ...labels, [MANAGED_LABEL.key]: MANAGED_LABEL.value }),
      })) {
        const state = daytonaState(box.state);
        if (stopped.has(box.id) || state === "stopped" || !labelsMatch(box.labels, labels))
          continue;
        out.push({ id: box.id, state });
      }
      return out;
    },
  };
}
