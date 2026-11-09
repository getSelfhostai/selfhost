import { describe, expect, it } from "vitest";
import { fakeRuntime } from "../src/index.js";

describe("fakeRuntime", () => {
  it("runs commands, keeps files, bills by the clock and stops once", async () => {
    let time = Date.parse("2026-11-09T10:00:00Z");
    const runtime = fakeRuntime({
      now: () => new Date(time),
      exec: (command) =>
        command === "npm test" ? { exitCode: 1, stderr: "1 failing" } : undefined,
    });
    const sandbox = await runtime.create({ timeoutMinutes: 30, labels: { run: "r1" } });
    await sandbox.writeFile("/work/a.txt", "hi");
    expect(new TextDecoder().decode(await sandbox.readFile("/work/a.txt"))).toBe("hi");
    expect(await sandbox.exec("npm test")).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "1 failing",
      timedOut: false,
    });
    expect(await runtime.list({ run: "r1" })).toEqual([{ id: sandbox.id, state: "running" }]);

    time += 90_000;
    await sandbox.stop();
    await sandbox.stop();
    time += 60_000;
    const cost = await sandbox.cost();
    expect([cost.seconds, cost.source]).toEqual([90, "list_price"]);
    expect(cost.usd).toBeCloseTo(0.009);
    expect(await runtime.list()).toEqual([]);
    await expect(sandbox.exec("ls")).rejects.toThrow("is stopped");
  });
});
