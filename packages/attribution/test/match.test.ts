import type { AgentVendor as SchemaAgentVendor } from "@selfhost/schema";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  accountVendor,
  branchVendor,
  resolve,
  sessionMatches,
  trailerMatches,
} from "../src/match.js";
import type { AgentVendor } from "../src/types.js";
import { claudeModel } from "../src/vendors.js";

const none = new Map();

describe("vendor patterns", () => {
  it("uses the ledger's vendor list", () => {
    expectTypeOf<AgentVendor>().toEqualTypeOf<SchemaAgentVendor>();
  });

  it("reads the model from Claude Code's trailer name", () => {
    expect(claudeModel("Claude Opus 4.5")).toBe("claude-opus-4-5");
    expect(claudeModel("Claude Sonnet 5")).toBe("claude-sonnet-5");
    expect(claudeModel("Claude Opus 4.5 (1M context)")).toBe("claude-opus-4-5");
    expect(claudeModel("Claude")).toBeUndefined();
    expect(claudeModel("Claude Code")).toBeUndefined();
  });

  it.each([
    ["Co-Authored-By: Claude <noreply@anthropic.com>", "claude_code"],
    ["co-authored-by: Claude Code <noreply@anthropic.com>", "claude_code"],
    ["Co-authored-by: Codex <noreply@openai.com>", "codex"],
    ["Co-authored-by: Cursor Agent <cursoragent@cursor.com>", "cursor"],
    ["Made-with: Cursor", "cursor"],
    ["Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>", "copilot"],
    [
      "Co-authored-by: copilot-swe-agent[bot] <198982749+Copilot@users.noreply.github.com>",
      "copilot",
    ],
    [
      "Co-authored-by: opencode-agent[bot] <opencode-agent[bot]@users.noreply.github.com>",
      "opencode",
    ],
    ["Co-authored-by: Amp <amp@ampcode.com>", "other"],
    ["Generated with [Claude Code](https://claude.ai/code)", "claude_code"],
    ["Generated with [Codex](https://openai.com/codex/).", "codex"],
  ])("matches %s", (line, vendor) => {
    expect(trailerMatches(`Subject\n\n${line}\n`)).toEqual([
      expect.objectContaining({ signal: "co_author_trailer", vendor }),
    ]);
  });

  it.each([
    "Co-authored-by: Claude Monet <claude.monet@example.com>",
    "Co-authored-by: alice <5100001+alice@users.noreply.github.com>",
    "Co-authored-by: Copilot <12345+Copilot@users.noreply.github.com>",
    "We could ask Codex <noreply@openai.com> about this later.",
    "Made with Cursor, mostly.",
  ])("ignores %s", (line) => {
    expect(trailerMatches(`Subject\n\n${line}\n`)).toEqual([]);
  });

  it("tells agent accounts from people", () => {
    expect(accountVendor({ login: "Copilot", type: "Bot" })).toBe("copilot");
    expect(accountVendor({ login: "Claude", type: "Bot" })).toBe("claude_code");
    expect(accountVendor({ login: "claude", type: "User" })).toBeUndefined();
    expect(accountVendor({ login: "chatgpt-codex-connector[bot]" })).toBe("codex");
    expect(accountVendor({ login: "google-labs-jules[bot]" })).toBe("other");
    expect(accountVendor({ login: "dependabot[bot]" })).toBeUndefined();
    expect(accountVendor({ email: "242468646+Claude@users.noreply.github.com" })).toBe(
      "claude_code",
    );
    expect(accountVendor({ email: "41898282+github-actions[bot]@users.noreply.github.com" })).toBe(
      undefined,
    );
  });

  it("maps branch prefixes, local or remote", () => {
    expect(branchVendor("claude/issue-12-20261001-0930")).toBe("claude_code");
    expect(branchVendor("refs/remotes/origin/codex/fix-typo")).toBe("codex");
    expect(branchVendor("refs/heads/devin/1760262000-audit-csv")).toBe("other");
    expect(branchVendor("refs/heads/feature/claude/notes")).toBeUndefined();
    expect(branchVendor("claude-experiments")).toBeUndefined();
  });

  it("finds vendor session links", () => {
    const body = [
      "https://chatgpt.com/codex/tasks/task_e_68f1c2a9d4b84c0e9a7f3b2d1c0e5a64",
      "https://cursor.com/agents/bc-1f2e3d4c-5b6a-4789-8abc-def012345678",
      "https://opencode.ai/s/aB3dE5fG",
      "Link to Devin session: https://app.devin.ai/sessions/0123456789abcdef0123456789abcdef",
      "https://jules.google.com/task/12345678901234567890",
    ].join("\n");
    expect(sessionMatches(body, none).map((m) => [m.vendor, m.sessionId])).toEqual([
      ["codex", "task_e_68f1c2a9d4b84c0e9a7f3b2d1c0e5a64"],
      ["cursor", "bc-1f2e3d4c-5b6a-4789-8abc-def012345678"],
      ["opencode", "aB3dE5fG"],
      ["other", "0123456789abcdef0123456789abcdef"],
    ]);
  });

  it("finds known session ids only as whole tokens", () => {
    const known = new Map([["0f9e8d7c-aaaa-bbbb", { vendor: "codex" as const, model: "gpt-5.5" }]]);
    expect(sessionMatches("thread 0f9e8d7c-aaaa-bbbb done", known)).toEqual([
      { signal: "session_id", vendor: "codex", sessionId: "0f9e8d7c-aaaa-bbbb", model: "gpt-5.5" },
    ]);
    expect(sessionMatches("thread 0f9e8d7c-aaaa-bbbb-cccc", known)).toEqual([]);
  });
});

describe("resolve", () => {
  it("takes the strongest signal and fills model and session from the same vendor", () => {
    expect(
      resolve([
        { signal: "branch_prefix", vendor: "codex" },
        { signal: "co_author_trailer", vendor: "codex" },
        { signal: "file_time_match", vendor: "codex", sessionId: "s1", model: "gpt-5.5" },
        { signal: "session_id", vendor: "claude_code", sessionId: "s2" },
      ]),
    ).toEqual({
      agent: { vendor: "codex", model: "gpt-5.5" },
      signal: "co_author_trailer",
      sessionId: "s1",
    });
  });

  it("returns nothing for no evidence or a tie at the strongest signal", () => {
    expect(resolve([])).toBeUndefined();
    expect(
      resolve([
        { signal: "co_author_trailer", vendor: "codex" },
        { signal: "co_author_trailer", vendor: "claude_code" },
        { signal: "branch_prefix", vendor: "codex" },
      ]),
    ).toBeUndefined();
  });

  it("lets the majority win at the strongest signal", () => {
    expect(
      resolve([
        { signal: "co_author_trailer", vendor: "claude_code", model: "claude-opus-4-5" },
        { signal: "co_author_trailer", vendor: "claude_code", model: "claude-opus-4-5" },
        { signal: "co_author_trailer", vendor: "codex" },
      ])?.agent,
    ).toEqual({ vendor: "claude_code", model: "claude-opus-4-5" });
  });
});
