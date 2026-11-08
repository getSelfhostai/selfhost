import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Receipt } from "@selfhost/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReceiptStore } from "../src/receipts.js";
import { BACKENDS, REPO_ROOT, type Store } from "./helpers.js";

const fixture = (): Receipt =>
  JSON.parse(
    readFileSync(
      join(REPO_ROOT, "packages/schema/fixtures/receipt/valid/passed-with-preview.json"),
      "utf8",
    ),
  );

const OTHER_HEAD = "b2e4f6a8c0d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9";

describe.each(BACKENDS)("receipt store on $name", (backend) => {
  let store: Store;
  let receipts: ReceiptStore;

  beforeAll(async () => {
    if (backend.skip) return;
    store = await backend.open();
    receipts = store.ledger.receipts;
  });

  afterAll(async () => {
    await store?.close();
  });

  it.skipIf(backend.skip)("stores a receipt and reads it back by id", async () => {
    const receipt = { ...fixture(), repo: "Acme/Acme-Web" };
    const added = await receipts.add(receipt, { now: new Date("2026-11-08T10:00:00Z") });
    expect(added).toMatchObject({
      repo: "acme/acme-web",
      pull: 42,
      head_sha: receipt.pull.head_sha,
      created_at: "2026-11-08T10:00:00.000Z",
    });
    expect(added.comment_url).toBeUndefined();
    expect(await receipts.get(added.id)).toEqual(added);
    expect((await receipts.get(added.id))?.receipt).toEqual(receipt);
  });

  it.skipIf(backend.skip)("answers undefined for an id that is not a uuid", async () => {
    expect(await receipts.get("not-a-uuid")).toBeUndefined();
    expect(await receipts.get("00000000-0000-4000-8000-000000000000")).toBeUndefined();
  });

  it.skipIf(backend.skip)("finds the newest receipt of a pull request and head", async () => {
    const base = { ...fixture(), pull: { ...fixture().pull, number: 7 } };
    const first = await receipts.add(base, { now: new Date("2026-11-08T11:00:00Z") });
    const second = await receipts.add(
      { ...base, verdict: "failed" },
      { now: new Date("2026-11-08T11:05:00Z") },
    );
    const newer = await receipts.add(
      { ...base, pull: { ...base.pull, head_sha: OTHER_HEAD.toUpperCase() } },
      { now: new Date("2026-11-08T11:10:00Z") },
    );
    expect((await receipts.latest("ACME/acme-web", 7))?.id).toBe(newer.id);
    expect((await receipts.latest("acme/acme-web", 7, base.pull.head_sha))?.id).toBe(second.id);
    expect((await receipts.latest("acme/acme-web", 7, OTHER_HEAD))?.head_sha).toBe(OTHER_HEAD);
    expect(await receipts.latest("acme/acme-web", 8)).toBeUndefined();
    expect(first.id).not.toBe(second.id);
  });

  it.skipIf(backend.skip)("records the comment a receipt was posted as", async () => {
    const added = await receipts.add({ ...fixture(), pull: { ...fixture().pull, number: 9 } });
    const url = "https://github.com/acme/acme-web/pull/9#issuecomment-1";
    await receipts.setComment(added.id, url);
    expect((await receipts.get(added.id))?.comment_url).toBe(url);
  });
});
