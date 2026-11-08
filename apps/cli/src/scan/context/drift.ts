import { CONTEXT_READERS, type ContextKind, type ContextReader } from "@selfhost/agents";
import type { ContextDoc, McpServer } from "./files.js";

/**
 * Drift between context files: copies of the same text, files that disagree, and rules only one
 * agent sees. Every finding names the rule that fired and the file and line it came from, and
 * shows the matched words only, never the line itself.
 */

export interface ContextDuplicate {
  /** exact: the same lines once list markers, case and spacing are set aside. near: most of
   * the shorter file's lines are in the other one. */
  match: "exact" | "near";
  files: string[];
  /** Lines the files share, and that as a share of the shorter file's lines. */
  shared_lines: number;
  overlap: number;
  /** Agents that load more than one of the files and so pay for the same text twice. */
  loaded_twice_by: ContextReader[];
}

export type ConflictTopic =
  | "js_package_manager"
  | "python_package_manager"
  | "js_test_runner"
  | "python_test_runner"
  | "js_formatter"
  | "python_formatter"
  | "js_linter"
  | "python_linter"
  | "node_version"
  | "python_version"
  | "do_dont"
  | "mcp_server";

export interface ConflictSide {
  path: string;
  /** 1-based; null for an MCP server. */
  line: number | null;
  stance: "uses" | "avoids" | "version" | "starts";
  /** The tool, version or server the file names. */
  value: string;
  /** The words that matched, for example "npm test". */
  match: string;
}

export interface ContextConflict {
  topic: ConflictTopic;
  /** "Package manager", "Node version", "Do and don't: force push", "MCP server docs". */
  title: string;
  /** One sentence naming each side, for example "pnpm in CLAUDE.md:3; npm in AGENTS.md:7". */
  detail: string;
  /** The rule that fired. */
  rule: string;
  sides: ConflictSide[];
  /** Agents that load files on both sides, so get both instructions in one session. */
  same_agent: ContextReader[];
}

export interface SingleAgentRule {
  path: string;
  kind: ContextKind;
  reader: ContextReader;
  /** MCP configs: the server only this agent can start. */
  server: string | null;
}

export interface ContextDrift {
  duplicates: ContextDuplicate[];
  conflicts: ContextConflict[];
  single_agent: SingleAgentRule[];
  /** Agents with context files or sessions here; a rule only one of them sees is flagged. */
  agents_in_use: ContextReader[];
}

/** Shared lines over the shorter file's lines, at or above which two files are near copies. */
export const NEAR_DUPLICATE_OVERLAP = 0.8;
/** Files with fewer distinct lines are compared only for exact copies. */
export const NEAR_DUPLICATE_MIN_LINES = 3;

/** Kinds that hold instructions; home skills, subagents and commands are general purpose and
 * not checked for conflicts with a repository. */
const INSTRUCTION_KINDS: ReadonlySet<ContextKind> = new Set([
  "claude_md",
  "claude_local_md",
  "agents_md",
  "gemini_md",
  "instructions",
  "rule",
  "hints",
]);

const sorted = <T extends string>(items: Iterable<T>): T[] => [...new Set(items)].sort();

/** A line with list markers, headings, emphasis, case and spacing set aside. */
export function normalizeLine(line: string): string {
  return line
    .toLowerCase()
    .replace(/^\s*(?:[-*+]|\d+[.)]|#{1,6}|>)\s+/, "")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function lineSet(doc: ContextDoc): string[] {
  return doc.body
    .split(/\r?\n/)
    .map(normalizeLine)
    .filter((line) => line.length >= 3 && /[a-z]/.test(line));
}

const loadedByBoth = (docs: ContextDoc[]): ContextReader[] =>
  inReaderOrder(
    docs
      .flatMap((doc) => doc.file.readers)
      .filter((reader, _, all) => all.indexOf(reader) !== all.lastIndexOf(reader)),
  );

export function findDuplicates(docs: ContextDoc[]): ContextDuplicate[] {
  const candidates = docs
    .filter((doc) => doc.file.kind !== "mcp")
    .map((doc) => ({ doc, lines: lineSet(doc) }))
    .filter((entry) => entry.lines.length > 0);
  const out: ContextDuplicate[] = [];
  const exact = new Map<string, typeof candidates>();
  for (const entry of candidates) {
    const key = entry.lines.join("\n");
    exact.set(key, [...(exact.get(key) ?? []), entry]);
  }
  const grouped = new Set<ContextDoc>();
  for (const group of exact.values()) {
    if (group.length < 2) continue;
    for (const entry of group) grouped.add(entry.doc);
    out.push({
      match: "exact",
      files: group.map((entry) => entry.doc.display),
      shared_lines: new Set(group[0]?.lines).size,
      overlap: 1,
      loaded_twice_by: loadedByBoth(group.map((entry) => entry.doc)),
    });
  }
  const sets = candidates.map((entry) => ({ ...entry, set: new Set(entry.lines) }));
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const a = sets[i];
      const b = sets[j];
      if (!a || !b || (grouped.has(a.doc) && grouped.has(b.doc))) continue;
      if (a.lines.join("\n") === b.lines.join("\n")) continue;
      const smaller = Math.min(a.set.size, b.set.size);
      if (smaller < NEAR_DUPLICATE_MIN_LINES) continue;
      let shared = 0;
      for (const line of a.set) if (b.set.has(line)) shared++;
      const overlap = shared / smaller;
      if (overlap < NEAR_DUPLICATE_OVERLAP) continue;
      out.push({
        match: "near",
        files: [a.doc.display, b.doc.display],
        shared_lines: shared,
        overlap,
        loaded_twice_by: loadedByBoth([a.doc, b.doc]),
      });
    }
  }
  return out;
}

interface Claim {
  doc: ContextDoc;
  line: number;
  value: string;
  polarity: "use" | "avoid";
  match: string;
  /** Versions: the lowest version the file accepts; exact unless `atLeast`. */
  version?: number[];
  atLeast?: boolean;
}

interface Pattern {
  value: string;
  /** Matches that are the tool in use, or forbidden when the words before say so. */
  use: RegExp;
  /** The bare name: counts only when the words before forbid it ("not npm"), since "npm" alone
   * is often the registry. */
  mention?: RegExp;
}

interface ExclusiveTopic {
  id: Exclude<ConflictTopic, "node_version" | "python_version" | "do_dont" | "mcp_server">;
  title: string;
  patterns: Pattern[];
}

/**
 * The tools a project picks one of. A command (`pnpm install`, `vitest run`) or the bare tool
 * name counts as using it; npx and global installs (`npm install -g`) do not, since projects on
 * any package manager use them.
 */
export const EXCLUSIVE_TOPICS: ExclusiveTopic[] = [
  {
    id: "js_package_manager",
    title: "Package manager",
    patterns: [
      {
        value: "npm",
        use: /\bnpm\s+(?:install|i|ci|run|run-script|test|t|start|exec|add|uninstall|update)\b(?![^\n]*\s(?:-g|--global)\b)|\buse\s+npm\b/gi,
        mention: /\bnpm\b/gi,
      },
      { value: "pnpm", use: /\bpnpm\b|\bpnpx\b/gi },
      { value: "yarn", use: /\byarn\b/gi },
      { value: "bun", use: /\bbunx?\b(?!\s+test)/gi },
    ],
  },
  {
    id: "python_package_manager",
    title: "Python package manager",
    patterns: [
      { value: "pip", use: /(?<!\buv\s)\bpip3?\s+install\b/gi },
      { value: "uv", use: /\buv\s+(?:add|run|sync|pip|lock|venv|tool|init)\b/gi },
      { value: "poetry", use: /\bpoetry\b/gi },
      { value: "pipenv", use: /\bpipenv\b/gi },
      { value: "conda", use: /\bconda\s+(?:install|create|activate|env)\b/gi },
    ],
  },
  {
    id: "js_test_runner",
    title: "Test runner",
    patterns: [
      { value: "jest", use: /\bjest\b/gi },
      { value: "vitest", use: /\bvitest\b/gi },
      { value: "mocha", use: /\bmocha\b/gi },
      { value: "node:test", use: /\bnode\s+--test\b|\bnode:test\b/gi },
      { value: "bun test", use: /\bbun\s+test\b/gi },
    ],
  },
  {
    id: "python_test_runner",
    title: "Python test runner",
    patterns: [
      { value: "pytest", use: /\bpytest\b/gi },
      { value: "unittest", use: /\bunittest\b/gi },
    ],
  },
  {
    id: "js_formatter",
    title: "Formatter",
    patterns: [
      { value: "prettier", use: /\bprettier\b/gi },
      { value: "biome", use: /\bbiome\b(?!\s+lint\b)/gi },
      { value: "dprint", use: /\bdprint\b/gi },
    ],
  },
  {
    id: "python_formatter",
    title: "Python formatter",
    patterns: [
      { value: "black", use: /\bblack\s+(?:\.|--|\S+\.py\b)|`black`/gi },
      { value: "ruff format", use: /\bruff\s+format\b/gi },
      { value: "yapf", use: /\byapf\b/gi },
      { value: "autopep8", use: /\bautopep8\b/gi },
    ],
  },
  {
    id: "js_linter",
    title: "Linter",
    patterns: [
      { value: "eslint", use: /\beslint\b/gi },
      { value: "biome", use: /\bbiome\b(?!\s+format\b)/gi },
      { value: "oxlint", use: /\boxlint\b/gi },
    ],
  },
  {
    id: "python_linter",
    title: "Python linter",
    patterns: [
      { value: "ruff", use: /\bruff\b(?!\s+format\b)/gi },
      { value: "flake8", use: /\bflake8\b/gi },
      { value: "pylint", use: /\bpylint\b/gi },
    ],
  },
];

/** Practices a file can ask for or forbid. A file that forbids one conflicts with one that does it. */
export const DO_DONT_TERMS: Pattern[] = [
  {
    value: "force push",
    use: /\bforce[- ]push(?:es|ed|ing)?\b|\bgit\s+push\s+(?:-f|--force)(?!-)\b/gi,
  },
  { value: "rebase", use: /\brebas(?:e|es|ed|ing)\b/gi },
  { value: "squash merges", use: /\bsquash(?:es|ed|ing)?\b/gi },
  { value: "default exports", use: /\bdefault exports?\b|\bexport default\b/gi },
  { value: "semicolons", use: /\bsemicolons?\b/gi },
  { value: "Docker", use: /\bdocker\b/gi },
  { value: "mocks", use: /\bmock(?:s|ing)?\b/gi },
];

/**
 * A negation right before a match turns it into "avoid": never, don't, do not, avoid, not, no,
 * no longer, deprecated, migrated from, then at most a verb (use, run, add, install, ...) and an
 * article. "Never use npm" and "not npm" avoid npm; "never commit without running pnpm test"
 * does not avoid pnpm.
 */
const NEGATION =
  /\b(?:never|don'?t|do not|does not|doesn'?t|avoid(?:ing)?|not|no|no longer|deprecated|(?:migrated|moved|switched) (?:away )?from)(?:\s+(?:use|using|run|running|call|calling|add|adding|install|installing|write|writing|create|import|importing|rely on|with))?(?:\s+(?:the|a|an|any))?\s*$/i;

/** "Use X instead of Y": Y is avoided, X is not. */
const INSTEAD = /\b(?:instead of|rather than|over)\s*$/i;

/** Whether the words just before `index` forbid what follows. */
export function polarity(line: string, index: number): "use" | "avoid" {
  const before = line.slice(0, index).replace(/[`*_"']/g, "");
  if (INSTEAD.test(before.trimEnd())) return "avoid";
  const clause = before.split(/[.;:!?,(]|\bbut\b|\bthen\b/i).at(-1) ?? "";
  return NEGATION.test(clause) ? "avoid" : "use";
}

/** Lines of a file, with the line numbers of the file itself. */
function lines(doc: ContextDoc): [number, string][] {
  return doc.text.split(/\r?\n/).map((line, index) => [index + 1, line]);
}

function claims(docs: ContextDoc[], patterns: Pattern[]): Claim[] {
  const out: Claim[] = [];
  for (const doc of docs) {
    for (const [number, line] of lines(doc)) {
      for (const pattern of patterns) {
        const spans: [number, number][] = [];
        for (const match of line.matchAll(pattern.use)) {
          const index = match.index ?? 0;
          spans.push([index, index + match[0].length]);
          out.push({
            doc,
            line: number,
            value: pattern.value,
            polarity: polarity(line, index),
            match: match[0].replace(/`/g, "").trim(),
          });
        }
        for (const match of pattern.mention ? line.matchAll(pattern.mention) : []) {
          const index = match.index ?? 0;
          if (spans.some(([start, end]) => index >= start && index < end)) continue;
          if (polarity(line, index) !== "avoid") continue;
          out.push({ doc, line: number, value: pattern.value, polarity: "avoid", match: match[0] });
        }
      }
    }
  }
  return out;
}

function side(claim: Claim, stance: ConflictSide["stance"]): ConflictSide {
  return {
    path: claim.doc.display,
    line: claim.line,
    stance,
    value: claim.version ? versionText(claim) : claim.value,
    match: claim.match,
  };
}

const where = (claim: Claim) => `${claim.doc.display}:${claim.line}`;

/** "pnpm in CLAUDE.md:3, web/AGENTS.md:3; npm in AGENTS.md:5", in order of first mention. */
function groupedDetail(found: Claim[], label: (claim: Claim) => string): string {
  const groups = new Map<string, string[]>();
  for (const claim of found) {
    groups.set(label(claim), [...(groups.get(label(claim)) ?? []), where(claim)]);
  }
  return [...groups].map(([name, places]) => `${name} in ${places.join(", ")}`).join("; ");
}

/** Agents in the order CONTEXT_READERS lists them. */
export const inReaderOrder = (readers: Iterable<ContextReader>): ContextReader[] => {
  const set = new Set(readers);
  return CONTEXT_READERS.filter((reader) => set.has(reader));
};

/** First claim per file and value, so a file that says pnpm ten times is one side. */
function firstPerFile(found: Claim[]): Claim[] {
  const seen = new Set<string>();
  return found.filter((claim) => {
    const key = `${claim.doc.file.path}\n${claim.value}\n${claim.polarity}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sameAgent(pairs: [ContextDoc, ContextDoc][]): ContextReader[] {
  return inReaderOrder(
    pairs.flatMap(([a, b]) => a.file.readers.filter((reader) => b.file.readers.includes(reader))),
  );
}

/**
 * Exclusive topics. Two files conflict when the tools each uses have nothing in common (one
 * uses only pnpm, the other only npm), or when one says to avoid a tool the other uses.
 */
function exclusiveConflicts(docs: ContextDoc[]): ContextConflict[] {
  const out: ContextConflict[] = [];
  for (const topic of EXCLUSIVE_TOPICS) {
    const found = firstPerFile(claims(docs, topic.patterns));
    const byDoc = new Map<ContextDoc, { use: Claim[]; avoid: Claim[] }>();
    for (const claim of found) {
      const entry = byDoc.get(claim.doc) ?? { use: [], avoid: [] };
      entry[claim.polarity].push(claim);
      byDoc.set(claim.doc, entry);
    }
    const involved = new Set<Claim>();
    const pairs: [ContextDoc, ContextDoc][] = [];
    let different = false;
    let forbidden = false;
    const entries = [...byDoc];
    for (const [a, sa] of entries) {
      for (const [b, sb] of entries) {
        if (a === b) continue;
        const usedA = new Set(sa.use.map((claim) => claim.value));
        const usedB = new Set(sb.use.map((claim) => claim.value));
        const disjoint =
          a.file.path < b.file.path &&
          usedA.size > 0 &&
          usedB.size > 0 &&
          ![...usedA].some((value) => usedB.has(value));
        const avoided = sa.avoid.filter(
          (claim) => usedB.has(claim.value) && !usedA.has(claim.value),
        );
        if (disjoint) {
          different = true;
          for (const claim of [...sa.use, ...sb.use]) involved.add(claim);
          pairs.push([a, b]);
        }
        for (const claim of avoided) {
          forbidden = true;
          involved.add(claim);
          for (const used of sb.use.filter((entry) => entry.value === claim.value)) {
            involved.add(used);
          }
          pairs.push([a, b]);
        }
      }
    }
    if (involved.size === 0) continue;
    const ordered = found.filter((claim) => involved.has(claim));
    const sides = ordered.map((claim) => side(claim, claim.polarity === "use" ? "uses" : "avoids"));
    const values = sorted(ordered.filter((c) => c.polarity === "use").map((c) => c.value));
    out.push({
      topic: topic.id,
      title: topic.title,
      detail: groupedDetail(ordered, (claim) =>
        claim.polarity === "use" ? claim.value : `not ${claim.value}`,
      ),
      rule: [
        different
          ? `two files name ${topic.title.toLowerCase()}s with none in common (${values.join(", ")})`
          : "",
        forbidden ? "a file says not to use one that another file uses" : "",
      ]
        .filter(Boolean)
        .join("; "),
      sides,
      same_agent: sameAgent(pairs),
    });
  }
  return out;
}

const NODE_VERSION =
  /\bnode(?:\.js|js)?\s*(?:version\s*|v(?=\d)|(>=?)\s*v?|\^|~)?(\d{1,2})(?:\.\d+){0,2}(?:\.x)?(\+|\s+or\s+(?:later|newer|higher|above))?(?!\w|\.\w)/gi;
const PYTHON_VERSION =
  /\bpython\s*(?:version\s*)?(>=?\s*|~=\s*|\^)?(3\.\d{1,2})(?:\.\d+)?(\+|\s+or\s+(?:later|newer|higher|above))?(?!\w|\.\w)|\bpython(3\.\d{1,2})\b/gi;

function versionText(claim: Claim): string {
  const text = (claim.version ?? []).join(".");
  return claim.atLeast ? `>=${text}` : text;
}

function versionClaims(docs: ContextDoc[], pattern: RegExp, python: boolean): Claim[] {
  const out: Claim[] = [];
  for (const doc of docs) {
    for (const [number, line] of lines(doc)) {
      for (const match of line.matchAll(pattern)) {
        const raw = python ? (match[2] ?? match[4]) : match[2];
        if (!raw) continue;
        const atLeast = Boolean(match[1]?.trim() || match[3]);
        out.push({
          doc,
          line: number,
          value: raw,
          polarity: polarity(line, match.index ?? 0),
          match: match[0].trim(),
          version: raw.split(".").map(Number),
          atLeast,
        });
      }
    }
  }
  return firstPerFile(out.filter((claim) => claim.polarity === "use"));
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Two version claims agree when one range holds the other's version. */
function compatible(a: Claim, b: Claim): boolean {
  const va = a.version ?? [];
  const vb = b.version ?? [];
  if (a.atLeast && b.atLeast) return true;
  if (a.atLeast) return compare(vb, va) >= 0;
  if (b.atLeast) return compare(va, vb) >= 0;
  return compare(va, vb) === 0;
}

function versionConflicts(docs: ContextDoc[]): ContextConflict[] {
  const out: ContextConflict[] = [];
  const topics = [
    { id: "node_version" as const, title: "Node version", pattern: NODE_VERSION, python: false },
    {
      id: "python_version" as const,
      title: "Python version",
      pattern: PYTHON_VERSION,
      python: true,
    },
  ];
  for (const topic of topics) {
    const found = versionClaims(docs, topic.pattern, topic.python);
    const involved = new Set<Claim>();
    const pairs: [ContextDoc, ContextDoc][] = [];
    for (const a of found) {
      for (const b of found) {
        if (a.doc === b.doc || a.doc.file.path > b.doc.file.path || compatible(a, b)) continue;
        involved.add(a);
        involved.add(b);
        pairs.push([a.doc, b.doc]);
      }
    }
    if (involved.size === 0) continue;
    const ordered = found.filter((claim) => involved.has(claim));
    out.push({
      topic: topic.id,
      title: topic.title,
      detail: groupedDetail(ordered, versionText),
      rule: "files name versions that no single version satisfies (>= and + read as a minimum)",
      sides: ordered.map((claim) => side(claim, "version")),
      same_agent: sameAgent(pairs),
    });
  }
  return out;
}

/** One file forbids a practice another asks for: "never force push" and "git push --force". */
function doDontConflicts(docs: ContextDoc[]): ContextConflict[] {
  const out: ContextConflict[] = [];
  for (const term of DO_DONT_TERMS) {
    const found = firstPerFile(claims(docs, [term]));
    const avoid = found.filter((claim) => claim.polarity === "avoid");
    const use = found.filter((claim) => claim.polarity === "use");
    const involved = new Set<Claim>();
    const pairs: [ContextDoc, ContextDoc][] = [];
    for (const a of avoid) {
      for (const b of use) {
        // A file that says both is explaining when to do it, not contradicting another file.
        if (a.doc === b.doc || found.some((c) => c.doc === a.doc && c.polarity === "use")) {
          continue;
        }
        involved.add(a);
        involved.add(b);
        pairs.push([a.doc, b.doc]);
      }
    }
    if (involved.size === 0) continue;
    const ordered = found.filter((claim) => involved.has(claim));
    out.push({
      topic: "do_dont",
      title: `Do and don't: ${term.value}`,
      detail: groupedDetail(ordered, (claim) => (claim.polarity === "use" ? "do" : "don't")),
      rule: `one file says not to (never, don't, avoid, not) and another says to, or does it`,
      sides: ordered.map((claim) => side(claim, claim.polarity === "use" ? "uses" : "avoids")),
      same_agent: sameAgent(pairs),
    });
  }
  return out;
}

const SERVER_FIELDS: (keyof McpServer)[] = ["command", "args", "url", "env", "headers"];

/** Compared by value for command, args and url, by key names only for env and headers. */
function comparable(server: McpServer, field: keyof McpServer): unknown {
  if (field === "env" || field === "headers") return Object.keys(server[field]).sort();
  if (field === "args") return server.args ?? [];
  return server[field];
}

const sameField = (a: McpServer, b: McpServer, field: keyof McpServer) =>
  JSON.stringify(comparable(a, field)) === JSON.stringify(comparable(b, field));

/** The same MCP server name started differently by two configs. Values are never shown. */
function mcpConflicts(docs: ContextDoc[]): ContextConflict[] {
  const byName = new Map<string, { doc: ContextDoc; server: McpServer }[]>();
  for (const doc of docs) {
    for (const server of doc.servers) {
      byName.set(server.name, [...(byName.get(server.name) ?? []), { doc, server }]);
    }
  }
  const out: ContextConflict[] = [];
  for (const [name, entries] of [...byName].sort(([a], [b]) => a.localeCompare(b))) {
    const first = entries[0];
    if (!first) continue;
    const fields = sorted(
      entries.flatMap(({ server }) =>
        SERVER_FIELDS.filter((field) => !sameField(first.server, server, field)),
      ),
    );
    if (fields.length === 0) continue;
    out.push({
      topic: "mcp_server",
      title: `MCP server ${name}`,
      detail: `${entries.map(({ doc }) => doc.display).join(", ")} start it with different ${fields.join(", ")}`,
      rule: "the same server name has a different command, args, url, env names or header names",
      sides: entries.map(({ doc }) => ({
        path: doc.display,
        line: null,
        stance: "starts",
        value: name,
        match: fields.join(", "),
      })),
      same_agent: sameAgent(
        entries.slice(1).map(({ doc }) => [first.doc, doc] as [ContextDoc, ContextDoc]),
      ),
    });
  }
  return out;
}

/** Files checked for conflicts: instructions anywhere, and the repository's skills and commands. */
const conflictDocs = (docs: ContextDoc[]) =>
  docs.filter(
    (doc) =>
      doc.file.kind !== "mcp" &&
      doc.file.readers.length > 0 &&
      (INSTRUCTION_KINDS.has(doc.file.kind) || doc.file.scope === "repo"),
  );

export function findConflicts(docs: ContextDoc[]): ContextConflict[] {
  const checked = conflictDocs(docs);
  return [
    ...exclusiveConflicts(checked),
    ...versionConflicts(checked),
    ...doDontConflicts(checked),
    ...mcpConflicts(docs),
  ];
}

/**
 * Files, and MCP servers, only one agent reads, when more than one agent is in use here. A file
 * whose text another agent reads through a copy is not flagged.
 */
export function singleAgentRules(
  docs: ContextDoc[],
  duplicates: ContextDuplicate[],
  inUse: ContextReader[],
): SingleAgentRule[] {
  if (inUse.length < 2) return [];
  const byDisplay = new Map(docs.map((doc) => [doc.display, doc]));
  const copiedFor = (doc: ContextDoc) =>
    duplicates
      .filter((dup) => dup.files.includes(doc.display))
      .flatMap((dup) => dup.files.flatMap((path) => byDisplay.get(path)?.file.readers ?? []));
  const out: SingleAgentRule[] = [];
  const serverReaders = new Map<string, Set<ContextReader>>();
  for (const doc of docs) {
    for (const server of doc.servers) {
      const readers = serverReaders.get(server.name) ?? new Set();
      for (const reader of doc.file.readers) readers.add(reader);
      serverReaders.set(server.name, readers);
    }
  }
  for (const doc of docs) {
    const [reader, ...rest] = doc.file.readers;
    if (!reader || rest.length > 0) continue;
    if (doc.file.kind === "mcp") {
      for (const server of doc.servers) {
        if ((serverReaders.get(server.name)?.size ?? 0) > 1) continue;
        out.push({ path: doc.display, kind: doc.file.kind, reader, server: server.name });
      }
      continue;
    }
    if (copiedFor(doc).some((other) => other !== reader)) continue;
    out.push({ path: doc.display, kind: doc.file.kind, reader, server: null });
  }
  return out;
}

export function findDrift(docs: ContextDoc[], sessionAgents: ContextReader[]): ContextDrift {
  const duplicates = findDuplicates(docs);
  const inUse = inReaderOrder([
    ...sessionAgents,
    ...docs.flatMap((doc) => (doc.file.agent === "shared" ? [] : [doc.file.agent])),
  ]);
  return {
    duplicates,
    conflicts: findConflicts(docs),
    single_agent: singleAgentRules(docs, duplicates, inUse),
    agents_in_use: inUse,
  };
}
