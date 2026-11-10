import type { LedgerEvent } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import { draftFor } from "../src/index.js";

const alert = (id: string, data: Record<string, unknown>): LedgerEvent => ({
  id,
  schema: "selfhost.event/v1",
  ts: "2026-11-09T12:00:00Z",
  source: "server",
  kind: "alert.raised",
  actor: { kind: "system", id: "selfhost-runtime" },
  run_id: "run-3",
  data,
});

describe("runtime alerts", () => {
  it("a runtime cap and a sandbox left running each open a budget item for the owner", () => {
    const cap = draftFor(
      alert("01930000-0000-7000-8000-000000000001", {
        alert: "budget_exceeded",
        message: "Run run-3 reached [budget] runtime_run_usd ($1.00)",
        cap: "runtime_run_usd",
        window: "run:run-3",
        owner: "ana@example.com",
      }),
    );
    expect(cap).toMatchObject({
      kind: "budget",
      person: "ana@example.com",
      title: "Run run-3 reached [budget] runtime_run_usd ($1.00)",
    });
    const left = (sandbox: string) =>
      draftFor(
        alert("01930000-0000-7000-8000-000000000002", {
          alert: "sandbox_left_running",
          message: `Sandbox ${sandbox} still ran after its run.`,
          window: sandbox,
          owner: "ana@example.com",
        }),
      );
    expect(left("e2")).toMatchObject({ kind: "budget", person: "ana@example.com" });
    expect(left("e2")?.dedupeKey).not.toBe(left("e3")?.dedupeKey);
    expect(left("e2")?.dedupeKey).not.toBe(cap?.dedupeKey);
  });
});

describe("gateway budget alerts", () => {
  it("names the person in a budget item stored with the name masked", () => {
    const draft = draftFor({
      ...alert("01930000-0000-7000-8000-000000000003", {
        alert: "budget_exceeded",
        message: "[redacted] spent the day's gateway budget of $0.01",
        owner: "bob@example.com",
        period: "day",
        window: "2026-11-09T00:00:00.000Z",
      }),
      source: "gateway",
      actor: { kind: "person", id: "bob@example.com" },
    });
    expect(draft).toMatchObject({
      kind: "budget",
      person: "bob@example.com",
      title: "bob@example.com spent the day's gateway budget of $0.01",
    });
  });
});
