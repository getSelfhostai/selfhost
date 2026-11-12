import { createHash } from "node:crypto";
import type { ExecOptions, ExecResult, SandboxSpec, SecretRef } from "../types.js";

/** Label every sandbox selfhost creates carries, so list and the reaper only see its own. */
export const MANAGED_LABEL = { key: "selfhost", value: "managed" } as const;

/** Where a spec's repository is cloned, under the sandbox's default working directory. */
export const REPO_DIR = "repo";

/** How long logs() waits between polls of a provider's log API. */
export const LOG_POLL_MS = 2000;

/** A secret's value from where its reference points. Only env: refs resolve by default. */
export type SecretResolver = (ref: SecretRef) => string | Promise<string>;

/** Resolves `env:NAME` from the environment selfhost runs in; other schemes need a resolver. */
export function envSecrets(env: Readonly<Record<string, string | undefined>>): SecretResolver {
  return (ref) => {
    if (!ref.from.startsWith("env:")) {
      throw new Error(
        `Secret ${ref.name} comes from ${ref.from.split(":")[0]}:, which this runtime cannot read. Use env:NAME.`,
      );
    }
    const name = ref.from.slice(4);
    const value = env[name];
    if (value === undefined || value === "") {
      throw new Error(`Secret ${ref.name}: the environment variable ${name} is not set.`);
    }
    return value;
  };
}

/**
 * The spec's secrets as name to value, for providers that take them as environment variables:
 * from the spec's own resolver (the run's issued credentials) first, then the adapter's.
 */
export async function secretValues(
  spec: SandboxSpec,
  resolve: SecretResolver,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const ref of spec.secrets ?? []) {
    out[ref.name] = (await spec.resolveSecret?.(ref)) ?? (await resolve(ref));
  }
  return out;
}

/** Labels to attach: the spec's plus the managed label, with values every provider accepts. */
export function labelsOf(spec: SandboxSpec): Record<string, string> {
  return providerLabels({ ...spec.labels, [MANAGED_LABEL.key]: MANAGED_LABEL.value });
}

/** A Kubernetes label value: at most 63 characters, alphanumeric at both ends, then - _ . inside. */
const LABEL_VALUE = /^(?:[A-Za-z0-9](?:[-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?)?$/;

/**
 * A label value in the strictest form a provider takes: OpenSandbox (and anything on Kubernetes)
 * refuses a value like an email address. A value that already fits is kept; any other becomes
 * `h-` and a hash of it, the same every time, so a list by that label still finds the sandbox.
 * The value itself stays in the ledger (the run's person and team on the run and its sandbox
 * events), never in the provider's labels.
 */
export function labelValue(value: string): string {
  if (LABEL_VALUE.test(value)) return value;
  return `h-${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

/** Labels with every value as labelValue writes it, for create calls and list filters alike. */
export function providerLabels(labels: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(labels).map(([key, value]) => [key, labelValue(value)]));
}

/** Whether `have`, as a provider stores it, holds every label in `want`. */
export function labelsMatch(
  have: Readonly<Record<string, string>> | undefined,
  want: Readonly<Record<string, string>> | undefined,
): boolean {
  return Object.entries(want ?? {}).every(([key, value]) => have?.[key] === labelValue(value));
}

/** One argument for sh, in single quotes. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** A command with its cwd and env applied, for providers whose exec takes only a string. */
export function shellCommand(command: string, options: Pick<ExecOptions, "cwd" | "env"> = {}) {
  const env = Object.entries(options.env ?? {})
    .map(([key, value]) => `export ${key}=${shellQuote(value)}; `)
    .join("");
  const cd = options.cwd ? `cd ${shellQuote(options.cwd)} && ` : "";
  return `${env}${cd}${command}`;
}

/** The git command that clones a spec's repository into REPO_DIR. */
export function cloneCommand(repo: NonNullable<SandboxSpec["repo"]>): string {
  const branch = repo.ref ? ` --branch ${shellQuote(repo.ref)}` : "";
  return `git clone --depth 1${branch} ${shellQuote(repo.url)} ${REPO_DIR}`;
}

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

export const bytesOf = (content: string | Uint8Array) =>
  typeof content === "string" ? new TextEncoder().encode(content) : content;

/** A shell command that writes `content` to `path`, through base64 so any bytes survive. */
export function writeFileCommand(path: string, content: string | Uint8Array): string {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) || "/" : ".";
  return `mkdir -p ${shellQuote(dir)} && printf %s ${shellQuote(toBase64(bytesOf(content)))} | base64 -d > ${shellQuote(path)}`;
}

/** A shell command that prints `path` as base64; readFileOutput decodes what it prints. */
export function readFileCommand(path: string): string {
  return `base64 < ${shellQuote(path)}`;
}

export function readFileOutput(path: string, result: ExecResult, sandboxId: string): Uint8Array {
  if (result.exitCode !== 0) {
    throw new Error(
      `No such file in sandbox ${sandboxId}: ${path}${result.stderr ? ` (${result.stderr.trim()})` : ""}`,
    );
  }
  return new Uint8Array(Buffer.from(result.stdout.replace(/\s+/g, ""), "base64"));
}

/** The value of `work`, or timedOut once `ms` passes first. The work itself is not cancelled. */
export async function withTimeout<T>(
  work: Promise<T>,
  ms: number | undefined,
): Promise<{ value: T } | { timedOut: true }> {
  if (!ms) return { value: await work };
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  try {
    return await Promise.race([work.then((value) => ({ value })), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The result of a command stopped by its timeoutMs. */
export const timedOutResult = (stdout = "", stderr = ""): ExecResult => ({
  exitCode: 124,
  stdout,
  stderr,
  timedOut: true,
});

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

/**
 * Log lines from a provider API that only answers "lines since": every line from the start,
 * then new ones each poll until the sandbox stops or the signal aborts.
 */
export async function* pollLogs(
  fetchSince: (cursor: number) => Promise<{ lines: string[]; cursor: number }>,
  running: () => Promise<boolean>,
  signal?: AbortSignal,
  intervalMs = LOG_POLL_MS,
): AsyncGenerator<string> {
  let cursor = 0;
  while (!signal?.aborted) {
    const alive = await running();
    const page = await fetchSince(cursor);
    cursor = page.cursor;
    for (const line of page.lines) {
      if (signal?.aborted) return;
      yield line;
    }
    if (!alive) return;
    await sleep(intervalMs, signal);
  }
}

/**
 * The log of a sandbox whose provider has no log API: what this process ran in it and what that
 * printed. Readers get every line from the start, then new ones until it is closed.
 */
export class LogBuffer {
  readonly lines: string[] = [];
  private closed = false;
  private waiters: (() => void)[] = [];

  push(text: string): void {
    for (const line of text.split(/\r?\n/)) {
      if (line !== "") this.lines.push(line);
    }
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  async *read(signal?: AbortSignal): AsyncGenerator<string> {
    let index = 0;
    const onAbort = () => this.wake();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      while (!signal?.aborted) {
        while (index < this.lines.length) {
          if (signal?.aborted) return;
          yield this.lines[index++] as string;
        }
        if (this.closed) return;
        await new Promise<void>((resolve) => this.waiters.push(resolve));
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

/** Calls onOutput for one chunk, and records it in the log. */
export function emit(
  options: ExecOptions,
  log: LogBuffer | undefined,
  stream: "stdout" | "stderr",
  text: string,
): void {
  if (!text) return;
  options.onOutput?.({ stream, text });
  log?.push(text);
}

/** Loads an optional SDK, with the install command in the error when it is missing. */
export async function loadSdk<T>(name: string, version: string): Promise<T> {
  try {
    return (await import(/* @vite-ignore */ name)) as T;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
      throw new Error(
        `This runtime needs the ${name} package, which is not installed. Install it next to selfhost: npm install ${name}@${version} (the selfhost server's Docker image already includes every runtime's package).`,
      );
    }
    throw error;
  }
}

/**
 * Whether a command that failed ran for its whole timeout, so the provider stopped it. Timers can
 * fire a few milliseconds early against the clock, so a small margin keeps a real timeout from
 * reading as an ordinary failure.
 */
export function ranOutOfTime(begun: number, timeoutMs: number, now: number = Date.now()): boolean {
  return now - begun >= timeoutMs - 250;
}
