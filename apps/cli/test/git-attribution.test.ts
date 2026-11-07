import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  gitAttribution,
  githubRepoFromRemote,
  sessionInRepo,
} from "../src/scan/git-attribution.js";

describe("githubRepoFromRemote", () => {
  it("reads https and ssh remotes", () => {
    expect(githubRepoFromRemote("https://github.com/acme/acme-api.git")).toBe("acme/acme-api");
    expect(githubRepoFromRemote("git@github.com:acme/acme-api.git")).toBe("acme/acme-api");
    expect(githubRepoFromRemote("https://gitlab.com/acme/acme-api.git")).toBeUndefined();
  });
});

describe("sessionInRepo", () => {
  const base = { sessionId: "s", vendor: "claude_code" as const, start: "", end: "" };

  it("keeps a session that edited repo files from a parent folder, with repo-relative paths", () => {
    const hint = sessionInRepo(
      { ...base, cwd: "/home/dev", files: ["/home/dev/acme-api/src/a.ts", "notes.txt"] },
      "/home/dev/acme-api",
    );
    expect(hint?.files).toEqual(["src/a.ts"]);
    expect(hint?.cwd).toBe("/home/dev/acme-api");
  });

  it("drops a session that never touched the repo", () => {
    expect(
      sessionInRepo({ ...base, cwd: "/home/dev/other", files: ["x.ts"] }, "/home/dev/acme-api"),
    ).toBeUndefined();
  });
});

describe("gitAttribution", () => {
  it("attributes a trailer commit and leaves a plain one unattributed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "selfhost-attr-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", dir, ...args], {
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: "2026-10-05T10:00:00Z",
          GIT_COMMITTER_DATE: "2026-10-05T10:00:00Z",
        },
      });
    git("init", "-q");
    git("config", "user.email", "dev@example.com");
    git("config", "user.name", "Dev");
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    git("add", ".");
    git("commit", "-q", "-m", "Add a\n\nCo-Authored-By: Claude <noreply@anthropic.com>");
    writeFileSync(join(dir, "b.ts"), "export const b = 2;\n");
    git("add", ".");
    git("commit", "-q", "-m", "Add b");

    const collect = gitAttribution({ github: false });
    const result = await collect(dir, [
      {
        sessionId: "s1",
        vendor: "claude_code",
        start: "2026-10-05T09:00:00Z",
        end: "2026-10-05T10:30:00Z",
        cwd: dir,
        files: ["a.ts"],
      },
    ]);
    expect(result?.repo).toBeUndefined();
    expect(result?.commits).toHaveLength(2);
    const claude = result?.stats.byAgent.find(
      (s) => s.agent !== "unattributed" && s.agent.vendor === "claude_code",
    );
    expect(claude?.commits).toBe(1);
    expect(result?.stats.byAgent.find((s) => s.agent === "unattributed")?.commits).toBe(1);
  });
});
