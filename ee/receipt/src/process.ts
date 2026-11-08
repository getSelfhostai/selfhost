import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import type { OutputBuffer } from "./log.js";

/** bash with -e when there is one, as GitHub Actions runs `run` steps; else sh -e. */
const SHELL = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";

export interface CommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  output: OutputBuffer;
}

export interface Finished {
  /** Undefined when the command was killed. */
  exitCode?: number;
  timedOut: boolean;
  durationMs: number;
}

/** A command running in the background, in a process group of its own. */
export interface Started {
  readonly exited: Promise<Finished>;
  /** SIGTERM to the whole group, then SIGKILL after `graceMs`. Resolves once it has exited. */
  stop(graceMs?: number): Promise<Finished>;
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group has already exited.
  }
}

/**
 * Starts `command` in a shell and collects its output. With `timeoutMs`, the command and
 * everything it started are stopped once that time is up.
 */
export function startCommand(
  command: string,
  options: CommandOptions & { timeoutMs?: number },
): Started {
  const started = Date.now();
  const child = spawn(SHELL, ["-e", "-c", command], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let timedOut = false;
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk: string) => options.output.write(chunk));
  }
  const exited = new Promise<Finished>((resolve) => {
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      options.output.end();
      resolve({
        ...(code === null ? {} : { exitCode: code }),
        timedOut,
        durationMs: Date.now() - started,
      });
    };
    child.on("error", (error) => {
      options.output.write(`${error.message}\n`);
      finish(127);
    });
    child.on("close", (code) => finish(code));
    // A process the command left running in the background keeps its output open, so close
    // never comes: count the command as done shortly after the shell exits.
    child.on("exit", (code) => setTimeout(() => finish(code), 2000).unref());
  });
  const stop = async (graceMs = 5000) => {
    killGroup(child, "SIGTERM");
    const timer = setTimeout(() => killGroup(child, "SIGKILL"), graceMs);
    const result = await exited;
    clearTimeout(timer);
    // Processes that outlived the shell, such as a server a test started, go too.
    killGroup(child, "SIGKILL");
    return result;
  };
  if (options.timeoutMs !== undefined) {
    const limit = options.timeoutMs;
    const timer = setTimeout(() => {
      timedOut = true;
      options.output.write(`\n[stopped after ${Math.round(limit / 1000)} s]\n`);
      void stop();
    }, limit);
    void exited.then(() => clearTimeout(timer));
  }
  return { exited, stop };
}

/** Runs `command` to the end, or until `timeoutMs`; nothing it started outlives it. */
export async function runCommand(
  command: string,
  options: CommandOptions & { timeoutMs: number },
): Promise<Finished> {
  const run = startCommand(command, options);
  await run.exited;
  return run.stop(1000);
}

/** A TCP port nothing listens on right now, from the OS. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("No free port"))));
    });
  });
}

/**
 * Waits until `url` answers with any status under 500, or the command fails first, or the time
 * runs out. Redirects count as answers.
 */
export async function waitForUrl(
  url: string,
  options: { timeoutMs: number; exited: Promise<Finished>; intervalMs?: number },
): Promise<{ ready: true; ms: number } | { ready: false; ms: number; exited?: Finished }> {
  const started = Date.now();
  let exited: Finished | undefined;
  void options.exited.then((result) => {
    exited = result;
  });
  for (;;) {
    // A start command that exits 0 may have started the app in the background, so only a
    // failed exit ends the wait early.
    if (exited && exited.exitCode !== 0) return { ready: false, ms: Date.now() - started, exited };
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(2000),
      });
      await response.body?.cancel();
      if (response.status < 500) return { ready: true, ms: Date.now() - started };
    } catch {
      // Not listening yet.
    }
    if (Date.now() - started >= options.timeoutMs) {
      return { ready: false, ms: Date.now() - started, ...(exited ? { exited } : {}) };
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 500));
  }
}
