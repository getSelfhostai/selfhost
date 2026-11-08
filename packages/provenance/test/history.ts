import type { RunCommit } from "../src/index.js";
import { ALICE, BOB, CURSOR_AGENT, day, FixtureRepo, GITHUB, lines, text } from "./helpers.js";

const claudeLink = (id: string) => `Claude-Session: https://claude.ai/code/session_${id}`;
const codexLink = (id: string) => `https://chatgpt.com/codex/tasks/task_e_${id}`;

/** The handlers file after the agent's change on day 1, with two blank lines among them. */
const HANDLERS = [...lines(5, "base"), ...lines(10, "agent"), "", "", ...lines(10, "agent", 11)];

export interface History {
  repo: FixtureRepo;
  shas: Record<string, string>;
  /** What the ledger recorded: the goose session made the parser commit. */
  runs: RunCommit[];
}

/**
 * One repository with every case the provenance must handle, on main unless noted:
 *
 * - day 0, Alice: the root commit, 7 lines.
 * - day 1, Claude Code (session link): 20 lines (and 2 blank) in src/app.ts.
 * - day 2, Codex (task link): 60 lines in lib/util.ts.
 * - day 2.5, Bob: reindents one Claude line, which is not a change of it.
 * - day 3, Bob: fixes forward three Claude lines (rework).
 * - day 4, Alice: `git revert` of the Codex commit (revert).
 * - day 5, Cursor's agent account: 12 lines in web/page.ts.
 * - day 6, Alice: deletes web/page.ts with no revert message (a wholesale revert).
 * - day 7, Alice: 8 lines in pkg/old.ts, a commit the goose session recorded in the ledger.
 * - day 8, Alice: renames pkg/old.ts to pkg/new.ts (no change).
 * - day 9, Bob: edits two of the goose lines in pkg/new.ts (rework through the rename).
 * - day 10: merge of pull request #7 from claude/search: a Claude Code commit with 6 lines and
 *   Bob's 4 lines of docs.
 * - day 11, squash merge #9: 5 lines, with the Codex task link in the squash body.
 * - day 12, squash merge #11: 7 plain lines; GitHub says Copilot made the pull request.
 * - day 13, rebase merge: two Claude Code commits landed at once, the second editing two lines
 *   of the first (not rework: it landed with it).
 * - day 20, Bob: edits a Claude line from day 1, after its 14 days.
 * - day 36, Claude Code: 3 lines in docs/late.md, merged less than 14 days before the end.
 */
export function buildHistory(): History {
  const repo = new FixtureRepo();
  const shas: Record<string, string> = {};
  shas.base = repo.commit({
    message: "Initial",
    at: day(0),
    files: { "README.md": text(lines(2, "readme")), "src/app.ts": text(lines(5, "base")) },
  });
  shas.handlers = repo.commit({
    message: `Add handlers\n\n${claudeLink("01Handlers")}\n`,
    at: day(1),
    files: { "src/app.ts": text(HANDLERS) },
  });
  shas.util = repo.commit({
    message: `Add util\n\n${codexLink("0123abcd")}\n`,
    at: day(2),
    files: { "lib/util.ts": text(lines(60, "util")) },
  });
  const reindented = HANDLERS.map((row) => (row === "agent 15" ? "    agent 15" : row));
  shas.reindent = repo.commit({
    message: "Indent",
    at: day(2, 12),
    author: BOB,
    files: { "src/app.ts": text(reindented) },
  });
  const fixed = reindented.map((row) =>
    ["agent 3", "agent 4", "agent 5"].includes(row) ? row.replace("agent", "fixed") : row,
  );
  shas.fix = repo.commit({
    message: "Fix handler bounds",
    at: day(3),
    author: BOB,
    files: { "src/app.ts": text(fixed) },
  });
  shas.revertUtil = repo.revert(shas.util, { at: day(4) });
  shas.page = repo.commit({
    message: "Add page",
    at: day(5),
    author: CURSOR_AGENT,
    files: { "web/page.ts": text(lines(12, "page")) },
  });
  shas.dropPage = repo.commit({
    message: "Drop page",
    at: day(6),
    files: { "web/page.ts": null },
  });
  shas.parser = repo.commit({
    message: "Add parser",
    at: day(7),
    files: { "pkg/old.ts": text(lines(8, "parse")) },
  });
  shas.rename = repo.commit({
    message: "Rename parser",
    at: day(8),
    rename: ["pkg/old.ts", "pkg/new.ts"],
  });
  shas.parserFix = repo.commit({
    message: "Fix parser",
    at: day(9),
    author: BOB,
    files: {
      "pkg/new.ts": text(
        lines(8, "parse").map((row) => (row === "parse 2" || row === "parse 3" ? `${row}!` : row)),
      ),
    },
  });

  repo.checkout("-b", "claude/search");
  shas.search = repo.commit({
    message: `Add search\n\n${claudeLink("01Search")}\n`,
    at: day(9, 3),
    files: { "src/search.ts": text(lines(6, "search")) },
  });
  shas.searchDocs = repo.commit({
    message: "Document search",
    at: day(9, 4),
    author: BOB,
    files: { "docs/search.md": text(lines(4, "doc")) },
  });
  repo.checkout("main");
  shas.merge = repo.merge("claude/search", {
    message: "Merge pull request #7 from acme/claude/search",
    at: day(10),
    committer: GITHUB,
  });
  repo.git("branch", "-D", "claude/search");

  shas.squashCodex = repo.commit({
    message: `Add export (#9)\n\n* Add export\n\n${codexLink("0456beef")}\n`,
    at: day(11),
    committer: GITHUB,
    files: { "src/export.ts": text(lines(5, "export")) },
  });
  shas.squashCopilot = repo.commit({
    message: "Add cache (#11)",
    at: day(12),
    committer: GITHUB,
    files: { "lib/cache.ts": text(lines(7, "cache")) },
  });
  shas.queue1 = repo.commit({
    message: `Add queue\n\n${claudeLink("01Queue")}\n`,
    at: day(12, 6),
    committer: GITHUB,
    committedAt: day(13),
    files: { "lib/queue.ts": text(lines(6, "queue")) },
  });
  shas.queue2 = repo.commit({
    message: `Tune queue\n\n${claudeLink("01Queue")}\n`,
    at: day(12, 7),
    committer: GITHUB,
    committedAt: day(13),
    files: {
      "lib/queue.ts": text(lines(6, "queue").map((row, i) => (i < 2 ? `${row} tuned` : row))),
    },
  });
  shas.late = repo.commit({
    message: "Touch a handler",
    at: day(20),
    author: BOB,
    files: {
      "src/app.ts": text(fixed.map((row) => (row === "agent 10" ? "agent ten" : row))),
    },
  });
  shas.lateDocs = repo.commit({
    message: `Add late notes\n\n${claudeLink("01Late")}\n`,
    at: day(36),
    files: { "docs/late.md": text(lines(3, "late")) },
  });

  return {
    repo,
    shas,
    runs: [
      {
        sha: (shas.parser as string).slice(0, 7),
        agent: { vendor: "goose", model: "gpt-5.5" },
        sessionId: "goose-1",
      },
    ],
  };
}

export { ALICE, BOB };
