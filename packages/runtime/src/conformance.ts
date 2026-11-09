import type { RuntimeAdapter, Sandbox, SandboxSpec, SandboxState } from "./types.js";

/** Label the suite puts on its sandboxes, so list checks only see the suite's own. */
export const CONFORMANCE_LABEL = "selfhost-conformance";

export const CONFORMANCE_CHECKS = [
  "create",
  "status.running",
  "exec.stdout",
  "exec.exit_code",
  "exec.stderr",
  "exec.cwd_env",
  "exec.on_output",
  "exec.timeout",
  "files.text",
  "files.bytes",
  "files.missing",
  "get.reattach",
  "get.unknown",
  "list.labels",
  "logs",
  "snapshot",
  "cost",
  "stop",
  "stop.twice",
  "stop.after",
  "cost.after_stop",
] as const;
export type ConformanceCheckName = (typeof CONFORMANCE_CHECKS)[number];

export interface ConformanceCheck {
  name: ConformanceCheckName;
  status: "pass" | "fail" | "skip";
  /** Why it failed or was skipped. */
  detail?: string;
  ms: number;
}

export interface ConformanceReport {
  kind: string;
  ok: boolean;
  sandboxId?: string;
  checks: ConformanceCheck[];
}

export interface ConformanceOptions {
  /** Spec fields for the provider: image, region, size. timeoutMinutes defaults to 10. */
  spec?: Partial<SandboxSpec>;
  /** Unique per suite run; labels the sandbox. Default: a random id. */
  runId?: string;
  /** timeoutMs the timeout check gives a 30-second sleep. Default 2000. */
  execTimeoutMs?: number;
  /** How long to wait for the sandbox to report running. Default 120 seconds. */
  readyTimeoutMs?: number;
  /** Progress lines, one per check. */
  log?: (line: string) => void;
}

class CheckFailed extends Error {}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CheckFailed(message);
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  sandbox: Sandbox,
  want: SandboxState,
  timeoutMs: number,
): Promise<SandboxState> {
  const deadline = Date.now() + timeoutMs;
  let state = await sandbox.status();
  while (state !== want && Date.now() < deadline) {
    await sleep(250);
    state = await sandbox.status();
  }
  return state;
}

/**
 * Exercises every method of the runtime contract against one adapter: create, exec (output,
 * exit codes, stderr, cwd and env, streaming, timeouts), files, get, list by label, logs,
 * snapshot, cost and stop. It makes one sandbox and always stops it. Against a real provider it
 * costs a minute or two of the smallest sandbox. Checks a provider cannot do by design, as its
 * capabilities say (snapshots on Coder), are checked to fail cleanly instead.
 */
export async function runConformance(
  adapter: RuntimeAdapter,
  options: ConformanceOptions = {},
): Promise<ConformanceReport> {
  const runId =
    options.runId ?? `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const execTimeoutMs = options.execTimeoutMs ?? 2000;
  const checks: ConformanceCheck[] = [];
  const caps = adapter.capabilities;
  let sandbox: Sandbox | undefined;
  let stoppedAt = false;

  /** Runs one check; a check that returns a string was skipped for that reason. */
  async function check(name: ConformanceCheckName, run: () => Promise<unknown>) {
    const begun = Date.now();
    if (!sandbox && name !== "create" && name !== "get.unknown") {
      checks.push({ name, status: "skip", detail: "no sandbox", ms: 0 });
      return;
    }
    try {
      const answer = await run();
      const skipped = typeof answer === "string" ? answer : undefined;
      checks.push({
        name,
        status: skipped ? "skip" : "pass",
        ...(skipped ? { detail: skipped } : {}),
        ms: Date.now() - begun,
      });
    } catch (error) {
      checks.push({
        name,
        status: "fail",
        detail: error instanceof Error ? error.message : String(error),
        ms: Date.now() - begun,
      });
    }
    const last = checks.at(-1);
    options.log?.(`${last?.status} ${name}${last?.detail ? `: ${last.detail}` : ""}`);
  }

  const live = () => sandbox as Sandbox;
  try {
    await check("create", async () => {
      sandbox = await adapter.create({
        timeoutMinutes: 10,
        ...options.spec,
        labels: { ...options.spec?.labels, [CONFORMANCE_LABEL]: runId },
      });
      expect(sandbox.id, "create returned a sandbox without an id");
      expect(
        sandbox.runtime === adapter.kind,
        `runtime is ${sandbox.runtime}, not ${adapter.kind}`,
      );
    });
    await check("status.running", async () => {
      const state = await waitFor(live(), "running", options.readyTimeoutMs ?? 120_000);
      expect(state === "running", `status is ${state} after create`);
    });
    await check("exec.stdout", async () => {
      const result = await live().exec("echo selfhost-ok");
      expect(result.exitCode === 0, `exit code ${result.exitCode}`);
      expect(result.stdout.trim() === "selfhost-ok", `stdout was ${JSON.stringify(result.stdout)}`);
      expect(result.timedOut === false, "timedOut was true");
    });
    await check("exec.exit_code", async () => {
      const result = await live().exec("exit 3");
      expect(result.exitCode === 3, `exit 3 gave exit code ${result.exitCode}`);
    });
    await check("exec.stderr", async () => {
      const result = await live().exec("echo selfhost-err 1>&2");
      const where = caps.stderr === false ? result.stdout : result.stderr;
      expect(
        where.includes("selfhost-err"),
        `stderr text missing (stdout ${JSON.stringify(result.stdout)}, stderr ${JSON.stringify(result.stderr)})`,
      );
    });
    await check("exec.cwd_env", async () => {
      const result = await live().exec('pwd; echo "v=$SELFHOST_CONFORMANCE"', {
        cwd: "/tmp",
        env: { SELFHOST_CONFORMANCE: "yes" },
      });
      expect(result.stdout.includes("/tmp"), `cwd not applied: ${JSON.stringify(result.stdout)}`);
      expect(result.stdout.includes("v=yes"), `env not applied: ${JSON.stringify(result.stdout)}`);
    });
    await check("exec.on_output", async () => {
      const chunks: string[] = [];
      await live().exec("echo streamed", { onOutput: (chunk) => chunks.push(chunk.text) });
      expect(chunks.join("").includes("streamed"), "onOutput did not see the output");
    });
    await check("exec.timeout", async () => {
      const begun = Date.now();
      const result = await live().exec("sleep 30", { timeoutMs: execTimeoutMs });
      expect(result.timedOut, "a 30-second sleep with a short timeoutMs did not time out");
      expect(Date.now() - begun < execTimeoutMs + 15_000, "the timeout took far too long");
    });
    const dir = `/tmp/${CONFORMANCE_LABEL}`;
    await check("files.text", async () => {
      await live().writeFile(`${dir}/a.txt`, "hello\nworld\n");
      const back = text(await live().readFile(`${dir}/a.txt`));
      expect(back === "hello\nworld\n", `read back ${JSON.stringify(back)}`);
      const seen = await live().exec(`cat ${dir}/a.txt`);
      expect(seen.stdout.includes("world"), "exec does not see the written file");
    });
    await check("files.bytes", async () => {
      const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
      await live().writeFile(`${dir}/b.bin`, bytes);
      const back = await live().readFile(`${dir}/b.bin`);
      expect(
        back.length === 256 && back.every((value, i) => value === i),
        `read back ${back.length} bytes that differ`,
      );
    });
    await check("files.missing", async () => {
      let threw = false;
      try {
        await live().readFile(`${dir}/no-such-file`);
      } catch {
        threw = true;
      }
      expect(threw, "reading a missing file did not reject");
    });
    await check("get.reattach", async () => {
      const again = await adapter.get(live().id);
      expect(again, "get did not find the sandbox");
      expect(again.id === live().id, `get returned ${again.id}`);
      const result = await again.exec("echo again");
      expect(result.stdout.trim() === "again", "the reattached sandbox did not run a command");
    });
    await check("get.unknown", async () => {
      expect(
        (await adapter.get("selfhost-no-such-sandbox")) === undefined,
        "get of an unknown id did not answer undefined",
      );
    });
    await check("list.labels", async () => {
      const found = await adapter.list({ [CONFORMANCE_LABEL]: runId });
      expect(
        found.some((entry) => entry.id === live().id),
        "list with the sandbox's label did not include it",
      );
      if (caps.labels === false) return "the runtime has no labels to filter by";
      const other = await adapter.list({ [CONFORMANCE_LABEL]: `${runId}-other` });
      expect(!other.some((entry) => entry.id === live().id), "list with another label included it");
    });
    await check("logs", async () => {
      const controller = new AbortController();
      const lines: string[] = [];
      const reading = (async () => {
        for await (const line of live().logs(controller.signal)) {
          expect(typeof line === "string", "a log line is not a string");
          lines.push(line);
        }
      })();
      await sleep(1000);
      controller.abort();
      const ended = await Promise.race([reading.then(() => true), sleep(10_000).then(() => false)]);
      expect(ended, "logs did not end within 10 seconds of the signal aborting");
    });
    await check("snapshot", async () => {
      if (!caps.snapshot) {
        let threw = false;
        try {
          await live().snapshot();
        } catch {
          threw = true;
        }
        expect(threw, "snapshot did not reject on a runtime without snapshots");
        return "the runtime has no snapshots; it rejects as it should";
      }
      const snapshot = await live().snapshot();
      expect(snapshot.id, "snapshot returned no id");
    });
    await check("cost", async () => {
      const cost = await live().cost();
      expect(Number.isFinite(cost.seconds) && cost.seconds >= 0, `seconds ${cost.seconds}`);
      expect(Number.isFinite(cost.usd) && cost.usd >= 0, `usd ${cost.usd}`);
      expect(cost.source === "provider" || cost.source === "list_price", `source ${cost.source}`);
    });
    await check("stop", async () => {
      await live().stop();
      stoppedAt = true;
      const state = await waitFor(live(), "stopped", 60_000);
      expect(state === "stopped", `status is ${state} after stop`);
    });
    await check("stop.twice", async () => {
      await live().stop();
    });
    await check("stop.after", async () => {
      const listed = await adapter.list({ [CONFORMANCE_LABEL]: runId });
      expect(!listed.some((entry) => entry.id === live().id), "list still shows it");
      let threw = false;
      try {
        await live().exec("echo late");
      } catch {
        threw = true;
      }
      expect(threw, "exec after stop did not reject");
      const again = await adapter.get(live().id);
      expect(
        again === undefined || (await again.status()) === "stopped",
        "get after stop found a live sandbox",
      );
    });
    await check("cost.after_stop", async () => {
      const first = await live().cost();
      await sleep(1100);
      const second = await live().cost();
      expect(first.seconds === second.seconds, "billed seconds still grow after stop");
    });
  } finally {
    if (sandbox && !stoppedAt) {
      try {
        await sandbox.stop();
      } catch {
        // The report already says what failed; a stop that fails here leaves it to the reaper.
      }
    }
  }
  return {
    kind: adapter.kind,
    ok: checks.every((entry) => entry.status !== "fail"),
    ...(sandbox ? { sandboxId: sandbox.id } : {}),
    checks,
  };
}

/** The failed checks of a report, one per line, or "" when every check passed or skipped. */
export function conformanceFailures(report: ConformanceReport): string {
  return report.checks
    .filter((entry) => entry.status === "fail")
    .map((entry) => `${report.kind} ${entry.name}: ${entry.detail ?? "failed"}`)
    .join("\n");
}
