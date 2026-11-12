import { costOf, hourlyPrice, RUNTIMES, sizeFor } from "../catalog.js";
import type { ExecResult, RuntimeAdapter, Sandbox, SandboxSpec, SandboxState } from "../types.js";
import {
  cloneCommand,
  emit,
  labelsMatch,
  labelsOf,
  loadSdk,
  MANAGED_LABEL,
  pollLogs,
  providerLabels,
  ranOutOfTime,
  readFileCommand,
  readFileOutput,
  secretValues,
  timedOutResult,
  withTimeout,
  writeFileCommand,
} from "./common.js";
import type { AdapterOptions } from "./options.js";

/** The parts of Modal's JavaScript SDK (modal 0.11, Apache-2.0) this adapter uses. */
export interface ModalSdk {
  ModalClient: new (params: {
    tokenId: string;
    tokenSecret: string;
    endpoint?: string;
  }) => ModalClientLike;
}

export interface ModalClientLike {
  apps: {
    fromName(name: string, params: { createIfMissing: boolean }): Promise<{ appId: string }>;
  };
  images: { fromRegistry(tag: string): unknown; fromId(imageId: string): Promise<unknown> };
  secrets: { fromObject(entries: Record<string, string>): Promise<unknown> };
  sandboxes: {
    create(app: unknown, image: unknown, params: Record<string, unknown>): Promise<ModalBox>;
    fromId(sandboxId: string): Promise<ModalBox>;
    list(params: { appId?: string; tags?: Record<string, string> }): AsyncIterable<ModalBox>;
  };
}

export interface ModalStream {
  getReader(): { read(): Promise<{ done: boolean; value?: string }> };
}

export interface ModalBox {
  sandboxId: string;
  exec(
    command: string[],
    params: { workdir?: string; env?: Record<string, string>; timeoutMs?: number },
  ): Promise<{ stdout: ModalStream; stderr: ModalStream; wait(): Promise<number> }>;
  getTags(): Promise<Record<string, string>>;
  poll(): Promise<number | null>;
  terminate(): Promise<void>;
  snapshotFilesystem(): Promise<{ imageId: string }>;
  logs: {
    fetch(params: { since: Date }): AsyncIterable<{ message: string; timestamp: Date }>;
  };
}

/** The Modal app every selfhost sandbox runs under. */
export const MODAL_APP = "selfhost-runtime";
const DEFAULT_IMAGE = "node:22-bookworm";

/** Tags selfhost keeps on a Modal sandbox, which has no start time or size of its own to read. */
const STARTED_TAG = "selfhost-started";
const CPU_TAG = "selfhost-cpu";
const MEMORY_TAG = "selfhost-memory-gib";
const REGION_TAG = "selfhost-region";

/**
 * Native network settings in the SDK's own names: `cidrAllowlist` is `outboundCidrAllowlist` in
 * modal 0.11; `blockNetwork` and the rest pass as they are.
 */
export function modalNetwork(create: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { cidrAllowlist, ...rest } = create;
  return cidrAllowlist === undefined
    ? { ...rest }
    : { ...rest, outboundCidrAllowlist: cidrAllowlist };
}

async function readAll(stream: ModalStream, onText: (text: string) => void): Promise<string> {
  const reader = stream.getReader();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    if (value) {
      text += value;
      onText(value);
    }
  }
}

/**
 * Modal through its JavaScript SDK. Each sandbox runs in the selfhost-runtime app with a sleeping
 * entrypoint, sized by the spec (vCPUs map to Modal's physical cores, two vCPUs each). Egress uses
 * Modal's outbound domain allowlist, secrets go in as a Modal secret, region is Modal's regions.
 * Snapshots are filesystem images a later create starts from.
 */
export function modalRuntime(options: AdapterOptions<ModalSdk>): RuntimeAdapter {
  const now = options.now ?? (() => new Date());
  const load =
    options.load ?? (() => loadSdk<ModalSdk>("modal", RUNTIMES.modal.sdk?.version ?? ""));
  let client: ModalClientLike | undefined;
  let appId: string | undefined;
  const connect = async () => {
    if (!client) {
      const sdk = await load();
      client = new sdk.ModalClient({
        tokenId: options.credentials.key,
        tokenSecret: options.credentials.secret ?? "",
        ...(options.settings.url ? { endpoint: options.settings.url } : {}),
      });
    }
    return client;
  };
  const app = async () => {
    const modal = await connect();
    const found = await modal.apps.fromName(MODAL_APP, { createIfMissing: true });
    appId = found.appId;
    return found;
  };
  const stopped = new Map<string, number>();

  function wrap(box: ModalBox, tags: Record<string, string>): Sandbox {
    const region = tags[REGION_TAG];
    const started = Number(tags[STARTED_TAG]) || now().getTime();
    const size = {
      cpu: Number(tags[CPU_TAG]) || RUNTIMES.modal.defaultSize.cpu,
      memoryGiB: Number(tags[MEMORY_TAG]) || RUNTIMES.modal.defaultSize.memoryGiB,
    };
    const rate = hourlyPrice("modal", size, { usdPerHour: options.settings.usd_per_hour, region });
    const state = async (): Promise<SandboxState> => {
      if (stopped.has(box.sandboxId)) return "stopped";
      try {
        return (await box.poll()) === null ? "running" : "stopped";
      } catch {
        return "stopped";
      }
    };
    const run = async (command: string, execOptions: Parameters<Sandbox["exec"]>[1] = {}) => {
      const timeoutMs = execOptions.timeoutMs;
      const begun = Date.now();
      const work = (async () => {
        const proc = await box.exec(["sh", "-c", command], {
          ...(execOptions.cwd ? { workdir: execOptions.cwd } : {}),
          ...(execOptions.env ? { env: { ...execOptions.env } } : {}),
          ...(timeoutMs ? { timeoutMs } : {}),
        });
        const [stdout, stderr] = await Promise.all([
          readAll(proc.stdout, (text) => emit(execOptions, undefined, "stdout", text)),
          readAll(proc.stderr, (text) => emit(execOptions, undefined, "stderr", text)),
        ]);
        return { exitCode: await proc.wait(), stdout, stderr };
      })();
      const answer = await withTimeout(work, timeoutMs ? timeoutMs + 5000 : undefined);
      if ("timedOut" in answer) return timedOutResult();
      const { exitCode, stdout, stderr } = answer.value;
      if (timeoutMs && exitCode !== 0 && ranOutOfTime(begun, timeoutMs)) {
        return timedOutResult(stdout, stderr);
      }
      return { exitCode, stdout, stderr, timedOut: false };
    };
    return {
      id: box.sandboxId,
      runtime: "modal",
      async exec(command, execOptions = {}): Promise<ExecResult> {
        if (stopped.has(box.sandboxId)) throw new Error(`Sandbox ${box.sandboxId} is stopped`);
        return run(command, execOptions);
      },
      async writeFile(path, content) {
        const result = await run(writeFileCommand(path, content));
        if (result.exitCode !== 0) {
          throw new Error(
            `Could not write ${path} in sandbox ${box.sandboxId}: ${result.stderr.trim()}`,
          );
        }
      },
      async readFile(path) {
        return readFileOutput(path, await run(readFileCommand(path)), box.sandboxId);
      },
      logs(signal) {
        return pollLogs(
          async (cursor) => {
            const lines: string[] = [];
            let next = cursor;
            for await (const entry of box.logs.fetch({
              since: new Date(Math.max(cursor, started)),
            })) {
              lines.push(entry.message.replace(/\n$/, ""));
              next = Math.max(next, entry.timestamp.getTime() + 1);
            }
            return { lines, cursor: next };
          },
          async () => (await state()) === "running",
          signal,
          options.logPollMs,
        );
      },
      async snapshot() {
        const image = await box.snapshotFilesystem();
        return { id: image.imageId };
      },
      status: state,
      async cost() {
        const end = stopped.get(box.sandboxId) ?? now().getTime();
        const seconds = Math.max(0, Math.round((end - started) / 1000));
        return { seconds, usd: costOf(seconds, rate), source: "list_price" as const };
      },
      async stop() {
        if (stopped.has(box.sandboxId)) return;
        await box.terminate();
        stopped.set(box.sandboxId, now().getTime());
      },
    };
  }

  return {
    kind: "modal",
    capabilities: {
      egress: true,
      secrets: true,
      snapshot: true,
      regions: RUNTIMES.modal.regions as readonly string[],
      labels: true,
      stderr: true,
    },
    async create(spec: SandboxSpec) {
      const modal = await connect();
      const found = await app();
      const ref = spec.image ?? options.settings.template ?? DEFAULT_IMAGE;
      const image = ref.startsWith("im-")
        ? await modal.images.fromId(ref)
        : modal.images.fromRegistry(ref);
      const size = sizeFor("modal", spec.size);
      const secrets = await secretValues(spec, options.secrets);
      const tags = {
        ...labelsOf(spec),
        [STARTED_TAG]: String(now().getTime()),
        [CPU_TAG]: String(size.cpu),
        [MEMORY_TAG]: String(size.memoryGiB),
        ...(spec.region ? { [REGION_TAG]: spec.region } : {}),
      };
      const box = await modal.sandboxes.create(found, image, {
        cpu: size.cpu / 2,
        memoryMiB: Math.round(size.memoryGiB * 1024),
        timeoutMs: spec.timeoutMinutes * 60_000,
        command: ["sleep", "infinity"],
        tags,
        ...(spec.env ? { env: { ...spec.env } } : {}),
        ...(Object.keys(secrets).length > 0
          ? { secrets: [await modal.secrets.fromObject(secrets)] }
          : {}),
        ...(spec.region ? { regions: [spec.region] } : {}),
        ...(spec.native?.create
          ? modalNetwork(spec.native.create)
          : spec.egress
            ? { outboundDomainAllowlist: [...spec.egress.allow] }
            : {}),
      });
      await spec.onCreated?.(box.sandboxId);
      const sandbox = wrap(box, tags);
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
      const modal = await connect();
      try {
        const box = await modal.sandboxes.fromId(id);
        if ((await box.poll()) !== null) return undefined;
        return wrap(box, await box.getTags());
      } catch {
        return undefined;
      }
    },
    async list(labels) {
      const modal = await connect();
      if (!appId) await app();
      const out: { id: string; state: SandboxState }[] = [];
      const want = providerLabels({ ...labels, [MANAGED_LABEL.key]: MANAGED_LABEL.value });
      for await (const box of modal.sandboxes.list({ ...(appId ? { appId } : {}), tags: want })) {
        if (stopped.has(box.sandboxId)) continue;
        if ((await box.poll()) !== null) continue;
        if (!labelsMatch(await box.getTags(), want)) continue;
        out.push({ id: box.sandboxId, state: "running" });
      }
      return out;
    },
  };
}
