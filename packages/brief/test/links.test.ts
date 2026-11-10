import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { code, escapeText, lineUrl, traceCommand, traceUrl } from "../src/index.js";

const local = { repo: "acme/acme-api", base: "b".repeat(40), head: "h".repeat(40), commits: [] };

describe("lineUrl", () => {
  it("points at the diff view of a pull request, R for new lines and L for old ones", () => {
    const pr = { ...local, pr: { number: 7, url: "https://github.com/acme/acme-api/pull/7" } };
    const hash = createHash("sha256").update("src/a b.ts").digest("hex");
    expect(lineUrl(pr, "src/a b.ts", 3)).toBe(`${pr.pr.url}/files#diff-${hash}R3`);
    expect(lineUrl(pr, "src/a b.ts", 3, "old")).toBe(`${pr.pr.url}/files#diff-${hash}L3`);
    expect(lineUrl(pr, "src/a b.ts")).toBe(`${pr.pr.url}/files#diff-${hash}`);
  });

  it("points local commits at the file on GitHub, escaping what would break a link", () => {
    expect(lineUrl(local, "app/(admin)/page #1.tsx", 4)).toBe(
      `https://github.com/acme/acme-api/blob/${"h".repeat(40)}/app/%28admin%29/page%20%231.tsx#L4`,
    );
    expect(lineUrl(local, "old.ts", 2, "old")).toBe(
      `https://github.com/acme/acme-api/blob/${"b".repeat(40)}/old.ts#L2`,
    );
    expect(lineUrl({ ...local, repo: undefined }, "old.ts", 2)).toBeUndefined();
  });
});

describe("trace links", () => {
  it("opens the run view in the team server's console, or names the local command", () => {
    expect(traceUrl("https://selfhost.example.com/", "sess 1")).toBe(
      "https://selfhost.example.com/?screen=run&run=sess%201",
    );
    expect(traceUrl(undefined, "sess-1")).toBeUndefined();
    expect(traceCommand("0199f2a4-6c1d")).toBe("selfhost review trace 0199f2a4-6c1d");
    expect(traceCommand("it's 1")).toBe("selfhost review trace 'it'\\''s 1'");
  });
});

describe("Markdown escaping", () => {
  it("keeps backticks inside a code span and text on one line", () => {
    // Padded on both sides, which CommonMark strips, so the trailing backtick stays inside.
    expect(code("echo `date`")).toBe("`` echo `date` ``");
    expect(code("a\nb")).toBe("`a b`");
    expect(escapeText("<!-- x --> [link](u) *bold* snake_case _lead")).toBe(
      "\\<!-- x --\\> \\[link\\](u) \\*bold\\* snake_case \\_lead",
    );
  });
});
