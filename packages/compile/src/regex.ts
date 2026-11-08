import regjsparser, { type RootNode } from "regjsparser";

/**
 * What follows the literal text of a form: open (anything, the regex stops there), word (a
 * space or the end of the command, as `(\s|$)` writes it), exact (`$`, the end of the command)
 * or boundary (`\b`).
 */
export type CommandEnd = "open" | "word" | "exact" | "boundary";

/** One literal command a rule's `command` regular expression reduces to. */
export interface CommandForm {
  /** The literal text. A whitespace class between words is written as one space. */
  text: string;
  /** `^` at the start: the command starts with the text. Otherwise it can appear anywhere. */
  start: boolean;
  end: CommandEnd;
  /** A whitespace class (`\s`, `\s+`, ` +`) between words was written as one space. */
  collapsed: boolean;
}

export type CommandReduction = { ok: true; forms: CommandForm[] } | { ok: false; reason: string };

/** More alternatives than this is not a literal any vendor list should carry. */
const MAX_FORMS = 32;

type Piece =
  | { kind: "start" }
  | { kind: "end" }
  | { kind: "boundary" }
  | { kind: "char"; ch: string }
  /** Whitespace: `class` when written as \s or with a quantifier, not as one literal space. */
  | { kind: "space"; class: boolean };

type Expansion = Piece[][] | string;

function nodesOf(node: RootNode): RootNode[] {
  return node.type === "alternative" ? node.body : [node];
}

function concat(nodes: RootNode[]): Expansion {
  let sequences: Piece[][] = [[]];
  for (const node of nodes) {
    const next = expand(node);
    if (typeof next === "string") return next;
    const product: Piece[][] = [];
    for (const left of sequences) for (const right of next) product.push([...left, ...right]);
    if (product.length > MAX_FORMS) return `more than ${MAX_FORMS} alternatives`;
    sequences = product;
  }
  return sequences;
}

function isWhitespace(node: RootNode): boolean {
  return (
    (node.type === "characterClassEscape" && node.value === "s") ||
    (node.type === "value" && node.codePoint === 0x20)
  );
}

function expand(node: RootNode): Expansion {
  switch (node.type) {
    case "value":
      return [[{ kind: "char", ch: String.fromCodePoint(node.codePoint) }]];
    case "anchor":
      if (node.kind === "not-boundary") return "\\B";
      return [
        [
          node.kind === "start"
            ? { kind: "start" }
            : node.kind === "end"
              ? { kind: "end" }
              : { kind: "boundary" },
        ],
      ];
    case "characterClassEscape":
      return node.value === "s" ? [[{ kind: "space", class: true }]] : `\\${node.value}`;
    case "characterClass": {
      const [only, ...rest] = node.body;
      if (!node.negative && only?.type === "value" && rest.length === 0) {
        return [[{ kind: "char", ch: String.fromCodePoint(only.codePoint) }]];
      }
      return `character class ${node.raw}`;
    }
    case "quantifier": {
      const [body] = node.body;
      if (node.min === 1 && node.max === 1) return expand(body);
      if (node.min === 1 && node.max === undefined && isWhitespace(body)) {
        return [[{ kind: "space", class: true }]];
      }
      if (node.min === 0 && node.max === 1) {
        const inner = expand(body);
        return typeof inner === "string" ? inner : [[], ...inner];
      }
      return `quantifier ${node.raw}`;
    }
    case "alternative":
      return concat(node.body);
    case "group":
      if (node.behavior !== "normal" && node.behavior !== "ignore") return `lookaround ${node.raw}`;
      return concat(node.body);
    case "disjunction": {
      const out: Piece[][] = [];
      for (const alternative of node.body) {
        const next = concat(nodesOf(alternative));
        if (typeof next === "string") return next;
        out.push(...next);
        if (out.length > MAX_FORMS) return `more than ${MAX_FORMS} alternatives`;
      }
      return out;
    }
    case "dot":
      return "the wildcard .";
    case "reference":
      return `back reference ${node.raw}`;
  }
}

function toForm(pieces: Piece[]): CommandForm | string {
  const rest = [...pieces];
  const start = rest[0]?.kind === "start";
  if (start) rest.shift();
  let end: CommandEnd = "open";
  const last = rest[rest.length - 1];
  if (last?.kind === "end") {
    end = "exact";
    rest.pop();
  } else if (last?.kind === "boundary") {
    end = "boundary";
    rest.pop();
  }
  let text = "";
  let collapsed = false;
  for (const [index, piece] of rest.entries()) {
    if (piece.kind === "start") return "^ after the start";
    if (piece.kind === "end") return "$ before the end";
    if (piece.kind === "boundary") return "\\b before the end";
    if (piece.kind === "char") {
      text += piece.ch;
      continue;
    }
    text += " ";
    // A class right before an open end is a word boundary, not spacing between words.
    if (piece.class && !(index === rest.length - 1 && end === "open")) collapsed = true;
  }
  if (text === "") return "no literal text";
  return { text, start, end, collapsed };
}

/** `T ` open plus `T` exact, as `T(\s|$)` gives, is one word form. */
function mergeWordEnds(forms: CommandForm[]): CommandForm[] {
  const key = (form: CommandForm) => `${form.start}\u0000${form.end}\u0000${form.text}`;
  const keys = new Set(forms.map(key));
  const out: CommandForm[] = [];
  const seen = new Set<string>();
  for (const form of forms) {
    let merged = form;
    if (form.end === "open" && form.text.endsWith(" ")) {
      const bare = { ...form, text: form.text.slice(0, -1), end: "exact" as const };
      if (keys.has(key(bare))) merged = { ...bare, end: "word" };
    } else if (
      form.end === "exact" &&
      keys.has(key({ ...form, text: `${form.text} `, end: "open" }))
    ) {
      merged = { ...form, end: "word" };
    }
    if (seen.has(key(merged))) continue;
    seen.add(key(merged));
    out.push(merged);
  }
  return out;
}

/**
 * Reduces a rule's `command` regular expression to the literal commands it matches, when it is
 * made only of literal characters, `^`, `$`, a trailing `\b` or `(\s|$)`, whitespace classes
 * between words, alternation and `?`. Anything else (`.`, classes, lookarounds, other
 * quantifiers) does not reduce: no vendor matches commands by regular expression.
 */
export function reduceCommand(pattern: string): CommandReduction {
  let ast: RootNode;
  try {
    ast = regjsparser.parse(pattern, "");
  } catch (error) {
    return { ok: false, reason: `unreadable regular expression: ${(error as Error).message}` };
  }
  const sequences = expand(ast);
  if (typeof sequences === "string") return { ok: false, reason: `uses ${sequences}` };
  const forms: CommandForm[] = [];
  for (const pieces of sequences) {
    const form = toForm(pieces);
    if (typeof form === "string") return { ok: false, reason: `uses ${form}` };
    forms.push(form);
  }
  return { ok: true, forms: mergeWordEnds(forms) };
}

/** Wrappers Claude Code strips before matching, so a rule can't start with one. */
const WRAPPERS = new Set([
  "timeout",
  "time",
  "nice",
  "nohup",
  "stdbuf",
  "command",
  "builtin",
  "noglob",
  "xargs",
  "sudo",
  "env",
]);

/** Characters a native command pattern can carry literally in every vendor's syntax. */
const PLAIN = /^[A-Za-z0-9 _\-./:=,@%+]+$/;

/**
 * Why a form's text can't be written as a native command pattern, or undefined when it can:
 * plain words, single spaces, and a first word that is neither a wrapper nor a VAR=value.
 */
export function unplainReason(text: string): string | undefined {
  if (!PLAIN.test(text)) {
    const bad = [...text].find((ch) => !PLAIN.test(ch)) ?? "";
    const shown = bad === "\n" ? "a newline" : bad === "\t" ? "a tab" : `"${bad}"`;
    return `${shown} in the command has a meaning in shell or in the vendor's pattern syntax`;
  }
  if (text.startsWith(" ")) return "the command starts with a space";
  if (text.includes("  ")) return "the command has two spaces in a row";
  const first = text.split(" ")[0] ?? "";
  if (first.includes("=")) return `the command starts with the assignment ${first}`;
  if (WRAPPERS.has(first)) {
    return `the command starts with ${first}, which vendors look through to the command it runs`;
  }
  return undefined;
}
