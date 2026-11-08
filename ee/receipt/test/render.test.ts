import type { Receipt } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import { renderReceiptHtml } from "../src/html.js";
import { receiptVerdict } from "../src/receipt.js";
import {
  RECEIPT_MARKER,
  receiptBriefSection,
  receiptHeadline,
  renderReceipt,
} from "../src/render.js";
import { receiptFixture } from "./helpers.js";

const failingTests = (): Receipt => {
  const receipt = receiptFixture("passed-with-preview");
  receipt.verdict = "failed";
  receipt.tests.runs.push({
    files: ["src/pages/settings/Team.test.tsx"],
    runner: "vitest",
    command: "vitest run src/pages/settings/Team.test.tsx",
    cwd: ".",
    status: "failed",
    exit_code: 1,
    duration_ms: 2300,
    log: {
      tail: "FAIL src/pages/settings/Team.test.tsx\nAssertionError: expected 2 to be 3\n```",
      lines: 40,
      file: "logs/test-2-src-pages-settings-Team-test-tsx.log",
    },
  });
  return receipt;
};

describe("receiptVerdict", () => {
  it("fails on any failed step and is nothing_checked with nothing to show", () => {
    const passed = receiptFixture("passed-with-preview");
    expect(receiptVerdict(passed)).toBe("passed");
    expect(receiptVerdict(failingTests())).toBe("failed");
    expect(receiptVerdict(receiptFixture("app-failed"))).toBe("failed");
    expect(
      receiptVerdict({
        ...passed,
        tests: { runs: [], not_run: [] },
        screens: { source: "none", shots: [] },
        preview: { status: "none" },
      }),
    ).toBe("nothing_checked");
    expect(receiptVerdict({ ...passed, preview: { status: "failed" } })).toBe("failed");
  });
});

describe("receiptHeadline", () => {
  it("says what passed and what failed in one sentence", () => {
    expect(receiptHeadline(receiptFixture("passed-with-preview"))).toBe(
      "Passed. 1 test run passed, 1 screen captured, preview ready.",
    );
    expect(receiptHeadline(failingTests())).toBe(
      "Failed. 1 of 2 test runs failed, 1 screen captured, preview ready.",
    );
    expect(receiptHeadline(receiptFixture("app-failed"))).toBe(
      "Failed. The app did not start, no changed test could be run.",
    );
  });
});

describe("renderReceipt", () => {
  it("renders the passing receipt with its preview link, tests and screens", () => {
    const text = renderReceipt(receiptFixture("passed-with-preview"), {
      receiptUrl: "https://selfhost.example.com/v1/receipts/1",
    });
    expect(text.startsWith(`${RECEIPT_MARKER}\n## Proof receipt\n`)).toBe(true);
    expect(text).toContain("**Passed. 1 test run passed, 1 screen captured, preview ready.**");
    expect(text).toContain(
      "[https://acme-web-git-agent-billing-acme.vercel.app](https://acme-web-git-agent-billing-acme.vercel.app), from the `Preview` deployment on vercel.",
    );
    expect(text).toContain("| passed | `src/pages/settings/Billing.test.tsx` | vitest | 1.9 s |");
    expect(text).toContain(
      "| `/settings/billing` | captured as `screens/settings-billing.png`, HTTP 200 | `src/pages/settings/Billing.tsx` |",
    );
    expect(text).toContain("[Stored receipt](https://selfhost.example.com/v1/receipts/1)");
    expect(text).not.toContain("<details");
  });

  it("says plainly that a test failed, with its output in a fence it cannot break", () => {
    const text = renderReceipt(failingTests());
    expect(text).toContain("| **failed** | `src/pages/settings/Team.test.tsx` | vitest | 2.3 s |");
    expect(text).toContain(
      "<details open><summary>Output of vitest run src/pages/settings/Team.test.tsx, exit code 1, last 3 of 40 lines, whole log in `logs/test-2-src-pages-settings-Team-test-tsx.log`</summary>",
    );
    expect(text).toContain("````text\nFAIL src/pages/settings/Team.test.tsx");
  });

  it("says plainly that the app did not start, with its log, and lists tests not run", () => {
    const text = renderReceipt(receiptFixture("app-failed"));
    expect(text).toContain(
      "**The app did not start.** The start command exited with code 1 before http://127.0.0.1:41235/ answered.",
    );
    expect(text).toContain("Error: Cannot find module './config'");
    expect(text).toContain("No preview environment for this commit");
    expect(text).toContain(
      "- `spec/models/user_spec.rb`: No runner for Ruby test files; set \\[receipt\\] test_command.",
    );
    expect(text).toContain("### Notes\n\n- The app did not start, so no screenshots were taken.");
  });

  it("shrinks log tails until the comment fits", () => {
    const receipt = failingTests();
    const run = receipt.tests.runs[1];
    if (!run?.log) throw new Error("fixture");
    run.log.tail = Array.from({ length: 60 }, (_, i) => `${i} ${"x".repeat(90)}`).join("\n");
    const full = renderReceipt(receipt);
    const small = renderReceipt(receipt, { maxChars: 4000 });
    expect(small.length).toBeLessThanOrEqual(4000);
    expect(small.length).toBeLessThan(full.length);
    expect(small).toContain("| **failed** |");
  });

  it("keeps mentions and HTML in reasons from rendering", () => {
    const receipt = receiptFixture("app-failed");
    receipt.notes = ["ping @octocat <img src=x>"];
    const text = renderReceipt(receipt);
    expect(text).toContain("ping @​octocat \\<img src=x\\>");
  });
});

describe("receiptBriefSection", () => {
  it("links the full receipt, the preview, the artifact and the CI run", () => {
    const receipt = receiptFixture("passed-with-preview");
    expect(
      receiptBriefSection(receipt, {
        headSha: receipt.pull.head_sha,
        commentUrl: "https://github.com/acme/acme-web/pull/42#issuecomment-7",
      }),
    ).toBe(
      [
        "### Proof receipt",
        "",
        "**Passed. 1 test run passed, 1 screen captured, preview ready.**",
        "",
        "[Full receipt](https://github.com/acme/acme-web/pull/42#issuecomment-7), [Preview](https://acme-web-git-agent-billing-acme.vercel.app), [Screenshots and logs](https://github.com/acme/acme-web/actions/runs/9001/artifacts/77), [CI run](https://github.com/acme/acme-web/actions/runs/9001/attempts/1).",
      ].join("\n"),
    );
  });

  it("calls out a receipt for an older commit", () => {
    const receipt = receiptFixture("passed-with-preview");
    const text = receiptBriefSection(receipt, {
      headSha: "b2e4f6a8c0d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9",
    });
    expect(text).toContain(
      "The newest receipt is for commit `5786c5c`, not the head commit `b2e4f6a`; the next CI run makes a new one.",
    );
  });
});

describe("renderReceiptHtml", () => {
  it("is one page with the screenshots embedded and every value escaped", () => {
    const receipt = receiptFixture("passed-with-preview");
    receipt.notes = ["<script>alert(1)</script>"];
    const html = renderReceiptHtml(
      receipt,
      new Map([["screens/settings-billing.png", new Uint8Array([137, 80, 78, 71])]]),
    );
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('src="data:image/png;base64,iVBORw=="');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toMatch(/(?:src|href)="(?!data:|https?:)/);
  });
});
