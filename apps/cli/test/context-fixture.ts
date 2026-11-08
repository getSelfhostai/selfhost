import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { tempDir } from "./run.js";

const fixtures = join(import.meta.dirname, "..", "..", "..", "fixtures");

/**
 * Copies fixtures/context/<name> into `dest`. The fixtures store `.claude` folders as `_claude`
 * and CLAUDE.md files as `CLAUDE.md.fixture`, since git here is told to skip those names; the
 * copy puts the real names back.
 */
export function copyContextFixture(name: "repo" | "home", dest: string): void {
  const from = join(fixtures, "context", name);
  for (const entry of readdirSync(from, { recursive: true, encoding: "utf8" })) {
    const source = join(from, entry);
    if (!statSync(source).isFile()) continue;
    const parts = entry
      .split(sep)
      .map((part) => (part === "_claude" ? ".claude" : part.replace(/\.fixture$/, "")));
    const target = join(dest, ...parts);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(source));
  }
}

/** Copies fixture logs, with the sessions' working folder moved to `repo`. */
export function copyLogs(from: string, to: string, repo: string): void {
  for (const name of readdirSync(from, { recursive: true, encoding: "utf8" })) {
    if (!name.endsWith(".jsonl")) continue;
    const target = join(to, name);
    mkdirSync(dirname(target), { recursive: true });
    const text = readFileSync(join(from, name), "utf8");
    writeFileSync(target, text.replaceAll("/home/dev/acme-api", repo));
  }
}

/**
 * The context fixture as a laptop: the repository (a git folder) and the home folder, with the
 * Claude Code and Codex session fixtures in the home folder, working in the repository.
 */
export function contextLaptop() {
  const home = tempDir("ctx-home");
  const repo = tempDir("ctx-repo");
  mkdirSync(repo.path(".git"));
  copyContextFixture("repo", repo.root);
  copyContextFixture("home", home.root);
  copyLogs(join(fixtures, "claude-code", "projects"), home.path(".claude", "projects"), repo.root);
  copyLogs(join(fixtures, "codex", "sessions"), home.path(".codex", "sessions"), repo.root);
  const env = { CLAUDE_CONFIG_DIR: home.path(".claude"), CODEX_HOME: home.path(".codex") };
  return { home, repo, env };
}
