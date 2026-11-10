import type { ContextRule, ContextSource } from "./types.js";

/**
 * Choices where two rules naming different options contradict each other: an agent told both
 * "Use npm" and "Use pnpm" follows one at random. Each option is matched after a verb that
 * makes it an instruction, so "npm and pnpm both work" is not a hit.
 */
const CHOICES: { what: string; options: Record<string, RegExp> }[] = [
  {
    what: "the package manager",
    options: Object.fromEntries(
      ["npm", "pnpm", "yarn", "bun"].map((tool) => [
        tool,
        new RegExp(
          `\\b(?:use|using|run with|prefer|always use|only use|install with)\\s+\`?${tool}\\b`,
          "i",
        ),
      ]),
    ),
  },
  {
    what: "indentation",
    options: {
      tabs: /\b(?:indent with|use)\s+tabs\b/i,
      spaces: /\b(?:indent with|use)\s+(?:\d+\s+)?spaces\b/i,
    },
  },
];

const label = (rule: ContextRule) => `${rule.path}`;

/**
 * Lint notes for rules that contradict each other once merged: the same choice (the package
 * manager, tabs or spaces) made two ways. Notes only: the compile goes on.
 */
export function contradictions(source: Pick<ContextSource, "rules">): string[] {
  const notes: string[] = [];
  for (const { what, options } of CHOICES) {
    const said = new Map<string, string[]>();
    for (const rule of source.rules) {
      for (const [option, pattern] of Object.entries(options)) {
        if (!pattern.test(rule.body)) continue;
        const rules = said.get(option) ?? [];
        rules.push(label(rule));
        said.set(option, rules);
      }
    }
    if (said.size < 2) continue;
    const parts = [...said].map(([option, rules]) => `${option} (${rules.join(", ")})`);
    notes.push(
      `Rules disagree on ${what}: ${parts.join(" against ")}. Agents get every one of them; keep one, or narrow each with globs.`,
    );
  }
  return notes;
}
