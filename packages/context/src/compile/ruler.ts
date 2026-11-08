import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runRulerAgents } from "@selfhost/compile/ruler";
import { htmlHeader } from "./output.js";

/**
 * The rules files Ruler (https://github.com/intellectronica/ruler, MIT) writes, with the Ruler
 * agent that writes each one. Copilot and Gemini CLI get their own file through an output_path
 * in ruler.toml: by default Ruler writes AGENTS.md for both.
 */
export const RULES_FILES = {
  "CLAUDE.md": { agent: "claude" },
  "AGENTS.md": { agent: "codex" },
  "GEMINI.md": { agent: "gemini-cli", outputPath: "GEMINI.md" },
  ".goosehints": { agent: "goose" },
  ".github/copilot-instructions.md": {
    agent: "copilot",
    outputPath: ".github/copilot-instructions.md",
  },
} as const satisfies Record<string, { agent: string; outputPath?: string }>;

export type RulesFile = keyof typeof RULES_FILES;

/** One file's worth of rules text, and the repository file it comes from. */
export interface Section {
  source: string;
  text: string;
}

/**
 * Writes one rules file through Ruler. The sections go into a scratch project's .ruler/ folder
 * as numbered files, so Ruler keeps their order, and Ruler writes the agent's file there with
 * MCP off. Its `<!-- Source: -->` markers then name the real source files, and the file gets
 * selfhost's header on top.
 */
export async function rulesFileText(
  file: RulesFile,
  sections: readonly Section[],
): Promise<string> {
  const target = RULES_FILES[file];
  const root = mkdtempSync(join(tmpdir(), "selfhost-context-"));
  try {
    const staged = new Map<string, string>();
    mkdirSync(join(root, ".ruler"));
    sections.forEach((section, index) => {
      const name = `s${String(index + 1).padStart(4, "0")}.md`;
      staged.set(`.ruler/${name}`, section.source);
      writeFileSync(join(root, ".ruler", name), section.text);
    });
    if ("outputPath" in target) {
      writeFileSync(
        join(root, ".ruler", "ruler.toml"),
        `[agents.${target.agent}]\noutput_path = "${target.outputPath}"\n`,
      );
    }
    mkdirSync(dirname(join(root, file)), { recursive: true });
    await runRulerAgents(root, [target.agent], { gitignore: false, backup: false });
    const written = readFileSync(join(root, file), "utf8");
    const text = written.replace(
      /<!-- Source: (\.ruler\/s\d{4}\.md) -->/g,
      (_marker, name: string) => `<!-- Source: ${staged.get(name) ?? name} -->`,
    );
    const sources = [...new Set(sections.map((section) => section.source))];
    return `${htmlHeader(sources)}${text.endsWith("\n") ? text : `${text}\n`}`;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
