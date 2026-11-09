import { BACKGROUND_RUN_SCHEMA, type BackgroundRun } from "@selfhost/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BackgroundRunStore } from "../src/background.js";
import { BACKENDS, type Store } from "./helpers.js";

const run = (id: string, extra: Partial<BackgroundRun> = {}): BackgroundRun => ({
  schema: BACKGROUND_RUN_SCHEMA,
  id,
  team: "platform",
  org: "acme",
  repo: "acme/web",
  task: "Fix the flaky login test",
  agent: "claude",
  runtime: "e2b",
  state: "queued",
  reason: null,
  person: "alice@example.com",
  trigger: { source: "cli", sender: "alice@example.com", person: "alice@example.com" },
  credential: null,
  base: null,
  branch: `claude/selfhost-${id}`,
  sandbox_id: null,
  attempt: 1,
  max_attempts: 2,
  timeout_minutes: 60,
  pr_url: null,
  created_at: "2026-11-09T10:00:00.000Z",
  started_at: null,
  ended_at: null,
  updated_at: "2026-11-09T10:00:00.000Z",
  cancel: null,
  cost: { runtime_usd: 0, model_usd: 0, usd: 0, source: "list_price" },
  health: null,
  gate: null,
  ...extra,
});

describe.each(BACKENDS)("background run store on $name", (backend) => {
  let store: Store;
  let runs: BackgroundRunStore;

  beforeAll(async () => {
    if (backend.skip) return;
    store = await backend.open();
    runs = store.ledger.backgroundRuns;
  });

  afterAll(async () => {
    await store?.close();
  });

  it.skipIf(backend.skip)("creates once, saves, lists newest first and counts", async () => {
    expect(await runs.create(run("r1"))).toBe(true);
    expect(await runs.create(run("r1"))).toBe(false);
    await runs.create(run("r2", { created_at: "2026-11-09T11:00:00.000Z" }));
    await runs.create(run("r3", { team: "web", created_at: "2026-11-09T12:00:00.000Z" }));

    const saved = await runs.save({
      ...run("r1"),
      state: "succeeded",
      pr_url: "https://github.com/acme/web/pull/7",
    });
    expect(saved.state).toBe("succeeded");
    expect((await runs.get("r1"))?.pr_url).toBe("https://github.com/acme/web/pull/7");
    expect(await runs.get("missing")).toBeUndefined();

    expect((await runs.list({ teams: ["platform"] })).map((r) => r.id)).toEqual(["r2", "r1"]);
    expect((await runs.list({ states: ["queued"] })).map((r) => r.id)).toEqual(["r3", "r2"]);
    expect(await runs.countSince("platform", new Date("2026-11-09T10:30:00Z"))).toBe(1);
    expect(await runs.countActive("platform")).toBe(1);
  });

  it.skipIf(backend.skip)("keeps a cancel that lands between a read and a write", async () => {
    await runs.create(run("c1"));
    const read = await runs.get("c1");
    const cancel = { by: "bob@example.com", at: "2026-11-09T10:05:00.000Z", scope: "run" as const };
    expect(await runs.requestCancel("c1", cancel)).toBe(true);
    expect(await runs.requestCancel("c1", { ...cancel, by: "carol@example.com" })).toBe(false);
    const saved = await runs.save({ ...(read as BackgroundRun), state: "running" });
    expect(saved.cancel).toEqual(cancel);
    await runs.save({ ...saved, state: "cancelled" });
    await runs.create(run("c2", { state: "failed" }));
    expect(await runs.requestCancel("c2", cancel)).toBe(false);
  });

  it.skipIf(backend.skip)("turns team and org kill switches on and off once", async () => {
    const at = "2026-11-09T10:00:00.000Z";
    expect(
      await runs.kill({ scope: "team", target: "platform", by: "alice@example.com", at }),
    ).toBe(true);
    expect(await runs.kill({ scope: "team", target: "platform", by: "bob@example.com", at })).toBe(
      false,
    );
    await runs.kill({
      scope: "org",
      target: "acme",
      by: "alice@example.com",
      at,
      reason: "incident",
    });
    expect(
      (await runs.activeKills({ teams: ["platform"], orgs: ["acme"] })).map((k) => [k.scope, k.by]),
    ).toEqual([
      ["team", "alice@example.com"],
      ["org", "alice@example.com"],
    ]);
    expect(await runs.clearKill("team", "platform", "bob@example.com", new Date(at))).toBe(true);
    expect(await runs.clearKill("team", "platform", "bob@example.com", new Date(at))).toBe(false);
    expect(await runs.activeKills({ teams: ["platform"] })).toEqual([]);
    expect(await runs.kill({ scope: "team", target: "platform", by: "bob@example.com", at })).toBe(
      true,
    );
  });
});
