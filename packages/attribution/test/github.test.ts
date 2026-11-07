import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type GitHubPull, ghCliSource, readPulls } from "../src/index.js";
import { GITHUB_FIXTURES, LOCAL_COMMITS, REPO, recordedGh, SINCE } from "./helpers.js";

let cacheDir: string;
beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "selfhost-gh-cache-"));
});
afterEach(() => rmSync(cacheDir, { recursive: true, force: true }));

const listPath = "repos/acme/acme-api/pulls";
const recordedList = (): GitHubPull[] =>
  JSON.parse(readFileSync(join(GITHUB_FIXTURES, `${listPath}.json`), "utf8"));

function stubPull(number: number, updated: string): GitHubPull {
  return {
    number,
    html_url: `https://github.com/acme/acme-api/pull/${number}`,
    state: "open",
    created_at: updated,
    updated_at: updated,
    closed_at: null,
    merged_at: null,
    user: { login: "alice", type: "User" },
    head: { ref: "main" },
    body: null,
  };
}

describe("ghCliSource", () => {
  it("calls gh api with the REST headers", async () => {
    const seen: string[][] = [];
    const source = ghCliSource({
      cacheDir,
      run: async (args) => {
        seen.push(args);
        return "[]";
      },
    });
    await source.pulls(REPO, SINCE);
    expect(seen).toEqual([
      [
        "api",
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        "X-GitHub-Api-Version: 2022-11-28",
        `${listPath}?state=all&sort=updated&direction=desc&per_page=100&page=1`,
      ],
    ]);
  });

  it("pages the list until it reaches pull requests older than since", async () => {
    const pages: Record<string, GitHubPull[]> = {
      "1": Array.from({ length: 100 }, (_, i) => stubPull(500 - i, "2026-10-20T00:00:00Z")),
      "2": [
        ...Array.from({ length: 98 }, (_, i) => stubPull(400 - i, "2026-10-10T00:00:00Z")),
        stubPull(2, "2026-09-30T00:00:00Z"),
        stubPull(1, "2026-09-29T00:00:00Z"),
      ],
    };
    const requested: string[] = [];
    const source = ghCliSource({
      cacheDir,
      run: async (args) => {
        const page = new URLSearchParams(args.at(-1)?.split("?")[1]).get("page") ?? "";
        requested.push(page);
        const body = pages[page];
        if (!body) throw new Error(`page ${page} should not be requested`);
        return JSON.stringify(body);
      },
    });
    const pulls = await source.pulls(REPO, SINCE);
    expect(requested).toEqual(["1", "2"]);
    expect(pulls).toHaveLength(198);
    expect(pulls.every((p) => p.updated_at >= "2026-10-01")).toBe(true);
  });

  it("serves unchanged pull requests from the cache and refetches changed ones", async () => {
    const first = recordedGh();
    const before = await readPulls(REPO, {
      since: SINCE,
      commits: LOCAL_COMMITS,
      source: ghCliSource({ run: first.run, cacheDir }),
    });
    expect(first.calls.filter((c) => c.startsWith(`${listPath}/`)).length).toBe(40);

    // Only the list is reachable now, and 101 has a newer updated_at.
    const list = recordedList().map((p) =>
      p.number === 101 ? { ...p, updated_at: "2026-10-21T00:00:00Z" } : p,
    );
    const offline: string[] = [];
    const recorded = recordedGh();
    const after = await readPulls(REPO, {
      since: SINCE,
      commits: LOCAL_COMMITS,
      source: ghCliSource({
        cacheDir,
        run: async (args) => {
          const endpoint = args.at(-1) ?? "";
          offline.push(endpoint);
          if (endpoint.startsWith(`${listPath}?`)) return JSON.stringify(list);
          if (endpoint.startsWith(`${listPath}/101`)) return recorded.run(args);
          throw new Error(`not cached: ${endpoint}`);
        },
      }),
    });
    expect(after).toEqual(before);
    expect(offline.filter((c) => c.startsWith(`${listPath}/`)).sort()).toEqual([
      `${listPath}/101`,
      `${listPath}/101/comments?per_page=100&page=1`,
      `${listPath}/101/commits?per_page=100&page=1`,
      `${listPath}/101/reviews?per_page=100&page=1`,
    ]);
  });

  it("reports gh failures and bad output", async () => {
    const failing = ghCliSource({
      cacheDir,
      run: async () => {
        throw new Error("gh: HTTP 404: Not Found");
      },
    });
    await expect(failing.pulls(REPO, SINCE)).rejects.toThrow(/404/);
    const garbled = ghCliSource({ cacheDir, run: async () => "<html>" });
    await expect(garbled.pulls(REPO, SINCE)).rejects.toThrow(/did not return JSON/);
    const object = ghCliSource({ cacheDir, run: async () => "{}" });
    await expect(object.pulls(REPO, SINCE)).rejects.toThrow(/did not return a list/);
    await expect(object.pulls("not-a-repo", SINCE)).rejects.toThrow(/owner\/name/);
  });
});
