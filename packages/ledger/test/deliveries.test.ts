import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DELIVERY_RETENTION_DAYS, type DeliveryStore } from "../src/deliveries.js";
import { BACKENDS, type Store } from "./helpers.js";

const DAY_MS = 86_400_000;

describe.each(BACKENDS)("GitHub delivery store on $name", (backend) => {
  let store: Store;
  let deliveries: DeliveryStore;

  beforeAll(async () => {
    if (backend.skip) return;
    store = await backend.open();
    deliveries = store.ledger.deliveries;
  });

  afterAll(async () => {
    await store?.close();
  });

  const ids = async () =>
    (await store.db.query<{ id: string }>("SELECT id FROM github_deliveries ORDER BY id")).map(
      (row) => row.id,
    );

  it.skipIf(backend.skip)("claims a delivery id once", async () => {
    const id = "6a1c2b30-0000-11f0-8000-000000000001";
    expect(await deliveries.claim(id, { event: "pull_request" })).toBe(true);
    expect(await deliveries.claim(id, { event: "pull_request" })).toBe(false);
  });

  it.skipIf(backend.skip)("gives one of two racing claims the delivery", async () => {
    const id = "6a1c2b30-0000-11f0-8000-000000000002";
    const results = await Promise.all([
      deliveries.claim(id, { event: "pull_request" }),
      deliveries.claim(id, { event: "pull_request" }),
    ]);
    expect(results.sort()).toEqual([false, true]);
  });

  it.skipIf(backend.skip)("lets a released delivery be claimed again", async () => {
    const id = "6a1c2b30-0000-11f0-8000-000000000003";
    await deliveries.claim(id, { event: "pull_request" });
    await deliveries.release(id);
    expect(await deliveries.claim(id, { event: "pull_request" })).toBe(true);
  });

  it.skipIf(backend.skip)("forgets ids older than the retention window", async () => {
    const now = new Date("2026-11-08T12:00:00Z");
    const old = new Date(now.getTime() - (DELIVERY_RETENTION_DAYS + 1) * DAY_MS);
    await store.db.query("DELETE FROM github_deliveries");
    await deliveries.claim("old", { event: "pull_request", now: old });
    await deliveries.claim("recent", {
      event: "pull_request",
      now: new Date(now.getTime() - DAY_MS),
    });
    await deliveries.claim("new", { event: "pull_request", now });
    expect(await ids()).toEqual(["new", "recent"]);
    // A forgotten id counts as new again.
    expect(await deliveries.claim("old", { event: "pull_request", now })).toBe(true);
  });
});

describe.each(BACKENDS)("dropped review requests on $name", (backend) => {
  let store: Store;

  beforeAll(async () => {
    if (backend.skip) return;
    store = await backend.open();
  });

  afterAll(async () => {
    await store?.close();
  });

  it.skipIf(backend.skip)("adds to what a pull request dropped, and keeps the newest", async () => {
    const dropped = store.ledger.droppedReviewers;
    expect(await dropped.get("acme/web#1")).toEqual({ users: [], teams: [] });
    await dropped.add("acme/web#1", { users: [], teams: ["reviewers"] });
    expect(await dropped.add("acme/web#1", { users: ["dave"], teams: ["reviewers"] })).toEqual({
      users: ["dave"],
      teams: ["reviewers"],
    });
    expect(await dropped.get("acme/web#1")).toEqual({ users: ["dave"], teams: ["reviewers"] });
    // Nothing dropped writes nothing.
    await dropped.add("acme/web#2", { users: [], teams: [] });
    const count = async () =>
      (
        await store.db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM github_dropped_reviewers",
        )
      )[0]?.n;
    expect(await count()).toBe(1);
    await dropped.add("acme/web#3", { users: ["erin"], teams: [] }, 1);
    expect(await count()).toBe(1);
    expect(await dropped.get("acme/web#3")).toEqual({ users: ["erin"], teams: [] });
    expect(await dropped.get("acme/web#1")).toEqual({ users: [], teams: [] });
  });
});
