import { manualClock } from "@selfhost/background";
import { databaseOf, type Ledger, openLedger } from "@selfhost/ledger";
import { openReviewList, refreshReviewList } from "@selfhost/review";
import { type ExecOptions, type FakeSandbox, fakeRuntime } from "@selfhost/runtime";
import {
  type BackgroundRun,
  type CreateTeamResponse,
  type JoinResponse,
  parseConfig,
  type ReviewItemsPage,
} from "@selfhost/schema";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createBackground } from "../src/background.js";
import { caller, TOKEN } from "./helpers.js";

const open: Ledger[] = [];
afterEach(async () => {
  for (const ledger of open.splice(0)) await ledger.close();
});

/** A sandbox where the agent exits 1 straight away. */
function failing(command: string, _sandbox: FakeSandbox, _options: ExecOptions) {
  if (command === 'printf %s "$HOME"') return { stdout: "/home/user" };
  if (command.startsWith("git rev-parse --abbrev-ref")) return { stdout: "main\n" };
  if (command === "git rev-parse HEAD") return { stdout: `${"1".repeat(40)}\n` };
  if (command.startsWith("claude -p")) return { exitCode: 1, stderr: "agent crashed\n" };
  return undefined;
}

describe("a failed background run", () => {
  it("reaches the inbox of the run's person in the run's team, on a repo no team claimed", async () => {
    const ledger = await openLedger({ dataDir: "memory://" });
    open.push(ledger);
    const clock = manualClock("2026-11-09T01:59:00Z");
    const parsed = parseConfig("version = 1\n");
    if (!parsed.ok) throw new Error("bad defaults");
    const runtime = fakeRuntime({ now: () => clock.now(), exec: failing });
    const background = createBackground(ledger, {
      config: parsed.config,
      version: "0.4.0",
      runtime: () => runtime,
      clock,
      env: {},
      fetch: async () => new Response("{}", { status: 404 }),
      log: () => {},
    });
    const server = createApp({ version: "test", ledger, token: TOKEN, background });
    const admin = caller(server, TOKEN);
    const created = (await (
      await admin("/v1/teams", "POST", { name: "Web" })
    ).json()) as CreateTeamResponse;
    const joined = (await (
      await server.request("/v1/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invite: created.invite, person: "carol@example.com" }),
      })
    ).json()) as JoinResponse;
    const carol = caller(server, joined.token);

    // The org's only team may run on a repo nobody claimed, so repo ownership names no team.
    const res = await carol("/v1/background-runs", "POST", {
      task: "Add a multiply function",
      repo: "localtest/tiny",
    });
    expect(res.status).toBe(202);
    const started = (await res.json()) as BackgroundRun;
    await background.runner.idle();
    const run = (await (await carol(`/v1/background-runs/${started.id}`)).json()) as BackgroundRun;
    expect(run.state).toBe("failed");

    const stored = await databaseOf(ledger).query<{ team: string | null }>(
      "SELECT team FROM events WHERE kind = 'alert.raised' AND body ->> 'run_id' = $1",
      [run.id],
    );
    expect(stored).toEqual([{ team: "web" }]);

    await refreshReviewList(ledger, openReviewList(ledger, { now: () => clock.now() }));
    const inbox = (await (await carol("/v1/review-items")).json()) as ReviewItemsPage;
    expect(inbox.items).toEqual([
      expect.objectContaining({
        kind: "stuck_run",
        run_id: run.id,
        owners: ["carol@example.com"],
      }),
    ]);
    const team = (await (await admin("/v1/review-items?team=web")).json()) as ReviewItemsPage;
    expect(team.items.map((item) => item.run_id)).toEqual([run.id]);
  });
});
