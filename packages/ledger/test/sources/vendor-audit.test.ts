import { validateEvent } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import { SourcePayloadError } from "../../src/sources/common.js";
import { mapVendorAudit } from "../../src/sources/vendor-audit.js";
import { readJson } from "../helpers.js";

const page = readJson("sources", "vendor-audit", "anthropic-compliance-activities.json");
const events = mapVendorAudit(page);

describe("Anthropic Compliance API style activity", () => {
  it("maps Claude Code activity and skips other products", () => {
    expect(events.map((e) => e.kind)).toEqual([
      "session.started",
      "prompt.submitted",
      "decision.recorded",
      "cost.recorded",
      "session.ended",
    ]);
  });

  it("produces valid events labelled vendor_api", () => {
    for (const event of events) {
      const result = validateEvent(event);
      expect(result.ok ? [] : result.errors).toEqual([]);
      expect(event).toMatchObject({
        source: "vendor_api",
        actor: { kind: "person", id: "dev@example.com", name: "Dev" },
        agent: { vendor: "claude_code", version: "2.1.308" },
        session_id: "665bce74-4bdc-4164-8bb1-cc4246de2400",
      });
    }
  });

  it("records usage with the reported cost and the person's decision", () => {
    expect(events[3]?.cost).toEqual({
      input_tokens: 42,
      output_tokens: 2210,
      cache_read_tokens: 96120,
      cache_write_tokens: 14388,
      usd: 0.1873,
      estimated: true,
    });
    // The audit feed does not say which part of the agent made the request.
    expect(events[3]?.data?.request_type).toBe("unknown");
    expect(events[2]).toMatchObject({
      tool: { name: "Bash" },
      decision: { verdict: "approve", by: "dev@example.com" },
    });
  });

  it("derives ids from activity ids", () => {
    expect(mapVendorAudit(page).map((e) => e.id)).toEqual(events.map((e) => e.id));
    const single = (page as { data: unknown[] }).data[0];
    expect(mapVendorAudit(single)[0]?.id).toBe(events[0]?.id);
  });

  it("rejects records without id, type or created_at", () => {
    expect(() => mapVendorAudit({ data: [{ type: "claude_code_session_started" }] })).toThrow(
      SourcePayloadError,
    );
  });
});
