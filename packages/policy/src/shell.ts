import { isAbsolute, resolve } from "node:path";
import { type ControlOperator, type ParseEntry, parse } from "shell-quote";

/**
 * Shell commands as the guardrails see them. shell-quote tokenizes; this splits the tokens into
 * simple commands, looks through wrappers (sudo, env, nice, timeout, xargs and the like), parses
 * the text that `bash -c`, `sh -c`, `eval`, `$(...)` and backticks run, and follows `cd` so a
 * relative path can be placed. It reads the command as text and runs nothing, so what only
 * exists at run time (a variable set elsewhere, a script's contents, an alias) stays unknown.
 */

/** One simple command: the program, its words and where it runs. */
export interface ShellCommand {
  /**
   * The program and its arguments, after wrappers. Variable references stay as written
   * ($HOME/x), and a word with a command substitution keeps it ($(pwd)/x).
   */
  argv: string[];
  /** NAME=value words before the program, and the ones an env wrapper sets. */
  assignments: Record<string, string>;
  /** Files read through `<` and `<>` redirects. */
  inputs: string[];
  /** Folder the command runs in after any earlier `cd`; undefined when that cannot be known. */
  cwd: string | undefined;
  /** true when the command gets more arguments at run time, as under xargs or find -exec. */
  moreArgs: boolean;
  /** Variables known at this point: the environment, then NAME=value and export in the line. */
  vars: Readonly<Record<string, string | undefined>>;
}

export interface ShellOptions {
  /** Absolute folder the line starts in. */
  cwd?: string;
  /** The agent's environment, for $HOME and other variables a command names. */
  env?: Readonly<Record<string, string | undefined>>;
}

/** Nested shells deeper than this are not parsed. */
const MAX_DEPTH = 4;

const SEPARATORS = new Set(["||", "&&", ";;&", ";;", ";&", "|&", "&", ";", "|"]);
const OPENERS = new Set(["(", "<(", ">("]);
/** Redirects whose next word is a file the command reads. */
const READ_REDIRECTS = new Set(["<", "<>"]);
/** Redirects whose next word is not an argument: a file written, a descriptor or heredoc text. */
const OTHER_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>", ">&", "<&", "<<", "<<-", "<<<"]);

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish"]);

interface Wrapper {
  /** Options that take the next word as their value. */
  valued: ReadonlySet<string>;
  /** Words after the options to skip before the command, like timeout's duration. */
  positional?: number;
  /** The command gets more arguments at run time. */
  moreArgs?: boolean;
}

const wrapper = (valued: string[], extra: Omit<Wrapper, "valued"> = {}): Wrapper => ({
  valued: new Set(valued),
  ...extra,
});

/** Programs that run the rest of their arguments as a command. */
const WRAPPERS: Record<string, Wrapper> = {
  sudo: wrapper(["-u", "-g", "-C", "-p", "-D", "-r", "-t", "-U", "-T", "-h"]),
  doas: wrapper(["-u", "-C"]),
  env: wrapper(["-u", "-C", "-S", "-P"]),
  nice: wrapper(["-n"]),
  nohup: wrapper([]),
  time: wrapper(["-f", "-o"]),
  timeout: wrapper(["-s", "-k"], { positional: 1 }),
  command: wrapper([]),
  exec: wrapper(["-a"]),
  builtin: wrapper([]),
  xargs: wrapper(["-I", "-L", "-n", "-P", "-s", "-E", "-d", "-a"], { moreArgs: true }),
  stdbuf: wrapper(["-i", "-o", "-e"]),
  ionice: wrapper(["-c", "-n", "-p"]),
  caffeinate: wrapper(["-t", "-w"]),
  chronic: wrapper([]),
  unbuffer: wrapper([]),
};

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;
const VARIABLE = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g;

export function basename(word: string): string {
  const slash = word.lastIndexOf("/");
  return slash === -1 ? word : word.slice(slash + 1);
}

/** The text between `$(` at `start` and its closing parenthesis, or undefined when unbalanced. */
function substitutionAt(text: string, start: number): { inner: string; end: number } | undefined {
  let depth = 0;
  for (let i = start + 1; i < text.length; i++) {
    const char = text[i];
    if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return { inner: text.slice(start + 2, i), end: i };
  }
  return undefined;
}

/** Stands for an unquoted `$(...)`, whose commands are parsed where it appears. */
const SUBSTITUTION = "$(...)";

/** Commands run inside a word: `$(...)` and backticks, which shell-quote leaves in quoted text. */
function innerCommands(value: string): string[] {
  const word = value.replaceAll(SUBSTITUTION, "");
  const inner: string[] = [];
  for (let i = word.indexOf("$("); i !== -1; i = word.indexOf("$(", i + 2)) {
    const found = substitutionAt(word, i);
    if (found) inner.push(found.inner);
  }
  for (const match of word.matchAll(/`([^`]*)`/g)) inner.push(match[1] ?? "");
  return inner;
}

/** Newlines outside quotes end a command, as in a script; shell-quote treats them as spaces. */
function splitLines(text: string): string {
  let out = "";
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? "";
    if (char === "\\" && quote !== "'") {
      const next = text[i + 1];
      // A backslash before a newline joins the lines.
      if (next === "\n") {
        i++;
        continue;
      }
      out += char + (next ?? "");
      i++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "\n") {
      out += " ; ";
      continue;
    }
    out += char;
  }
  return out;
}

const isOp = (entry: ParseEntry | undefined): entry is ControlOperator =>
  typeof entry === "object" && entry !== null && "op" in entry && entry.op !== "glob";

function word(entry: ParseEntry): string | undefined {
  if (typeof entry === "string") return entry;
  if (typeof entry === "object" && "op" in entry && entry.op === "glob") {
    return (entry as { pattern: string }).pattern;
  }
  return undefined;
}

/** The variables set by a command made only of NAME=value words, or by export/declare. */
function setsVariables(argv: string[], assignments: Record<string, string>) {
  if (argv.length === 0) return assignments;
  if (!["export", "declare", "typeset", "local", "readonly"].includes(argv[0] ?? "")) return {};
  const set: Record<string, string> = {};
  for (const arg of argv.slice(1)) {
    const match = ASSIGNMENT.exec(arg);
    if (match?.[1]) set[match[1]] = match[2] ?? "";
  }
  return set;
}

/** Expands ~, $HOME and the other variables in `vars`; undefined when any part is unknown. */
export function expandWord(
  value: string,
  vars: Readonly<Record<string, string | undefined>>,
  depth = 0,
): string | undefined {
  if (value.includes("$(") || value.includes("`")) return undefined;
  let text = value;
  if (text === "~" || text.startsWith("~/")) {
    const home = vars.HOME;
    if (!home) return undefined;
    text = home + text.slice(1);
  } else if (text.startsWith("~")) {
    return undefined;
  }
  let unknown = false;
  text = text.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, name: string) => {
    const known = vars[name];
    if (known === undefined || depth > 2) {
      unknown = true;
      return "";
    }
    const expanded = expandWord(known, vars, depth + 1);
    if (expanded === undefined) unknown = true;
    return expanded ?? "";
  });
  if (unknown || text.includes("$")) return undefined;
  return text;
}

/** An absolute path for a word, or undefined when it holds something unknown. */
export function resolveWord(
  value: string,
  command: Pick<ShellCommand, "cwd" | "vars">,
): string | undefined {
  const expanded = expandWord(value, command.vars);
  if (expanded === undefined || expanded === "") return undefined;
  if (isAbsolute(expanded)) return resolve(expanded);
  return command.cwd === undefined ? undefined : resolve(command.cwd, expanded);
}

/** Names of the variables a word reads, as in $NAME or ${NAME}. */
export function variablesIn(value: string): string[] {
  return [...value.matchAll(VARIABLE)].map((match) => match[1] ?? "");
}

interface Raw {
  words: string[];
  inputs: string[];
}

interface State {
  cwd: string | undefined;
  vars: Record<string, string | undefined>;
  depth: number;
  out: ShellCommand[];
}

/** Folder after `cd` or `pushd` with these arguments. */
function changeDirectory(args: string[], state: State) {
  const target = args.find((arg) => !arg.startsWith("-") || arg === "-");
  if (target === undefined) {
    state.cwd = state.vars.HOME;
    return;
  }
  if (target === "-") {
    state.cwd = undefined;
    return;
  }
  state.cwd = resolveWord(target, state);
}

/** Splits the words after a wrapper into its own options and the command it runs. */
function unwrap(
  name: string,
  rest: string[],
  assignments: Record<string, string>,
): { argv: string[]; moreArgs: boolean; cwd?: string; script?: string } | undefined {
  const spec = WRAPPERS[name];
  if (!spec) return undefined;
  let i = 0;
  let cwd: string | undefined;
  let script: string | undefined;
  for (; i < rest.length; i++) {
    const arg = rest[i] ?? "";
    if (arg === "--") {
      i++;
      break;
    }
    if (name === "env" && ASSIGNMENT.test(arg)) {
      const match = ASSIGNMENT.exec(arg);
      if (match?.[1]) assignments[match[1]] = match[2] ?? "";
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") break;
    if (name === "command" && (arg === "-v" || arg === "-V")) return { argv: [], moreArgs: false };
    if (name === "nice" && /^-\d+$/.test(arg)) continue;
    if (spec.valued.has(arg)) {
      const value = rest[i + 1] ?? "";
      if (name === "env" && arg === "-C") cwd = value;
      if (name === "env" && arg === "-S") script = value;
      i++;
    }
  }
  i += spec.positional ?? 0;
  return { argv: rest.slice(i), moreArgs: spec.moreArgs ?? false, cwd, script };
}

/** The script a shell runs with -c, from `bash -c '...'`, `sh -lc '...'` and the like. */
function shellScript(args: string[]): string | undefined {
  let wantScript = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (wantScript && !arg.startsWith("-")) return arg;
    if (arg === "-o" || arg === "+o" || arg === "--rcfile" || arg === "--init-file") {
      i++;
    } else if (/^-[A-Za-z]*c[A-Za-z]*$/.test(arg)) {
      wantScript = true;
    } else if (!arg.startsWith("-") && !arg.startsWith("+")) {
      return undefined;
    }
  }
  return undefined;
}

/** The command after find's -exec, -execdir, -ok or -okdir, up to `;` or `+`. */
function findExec(args: string[]): string[] | undefined {
  const start = args.findIndex((arg) => /^-(exec|execdir|ok|okdir)$/.test(arg));
  if (start === -1) return undefined;
  const after = args.slice(start + 1);
  const end = after.findIndex((arg) => arg === ";" || arg === "+" || arg === "\\;");
  return end === -1 ? after : after.slice(0, end);
}

/** Records one simple command, looking through wrappers and into the scripts it runs. */
function emit(raw: Raw, state: State) {
  for (const value of raw.words) {
    for (const inner of innerCommands(value)) walkText(inner, state, true);
  }
  const assignments: Record<string, string> = {};
  let argv = [...raw.words];
  while (argv.length > 0 && ASSIGNMENT.test(argv[0] ?? "")) {
    const match = ASSIGNMENT.exec(argv.shift() ?? "");
    if (match?.[1]) assignments[match[1]] = match[2] ?? "";
  }
  let moreArgs = false;
  let cwd = state.cwd;
  for (let guard = 0; guard < 8; guard++) {
    const name = basename(argv[0] ?? "");
    const unwrapped = unwrap(name, argv.slice(1), assignments);
    if (!unwrapped) break;
    if (unwrapped.script !== undefined) walkText(unwrapped.script, state, true);
    // A wrapper with nothing to run is the command itself, as `env` alone prints the environment.
    if (unwrapped.argv.length === 0 && name !== "command" && unwrapped.script === undefined) break;
    if (unwrapped.cwd !== undefined) {
      cwd = resolveWord(unwrapped.cwd, { cwd, vars: { ...state.vars, ...assignments } });
    }
    argv = unwrapped.argv;
    moreArgs ||= unwrapped.moreArgs;
  }
  const vars = { ...state.vars, ...assignments };
  const command: ShellCommand = {
    argv,
    assignments,
    inputs: raw.inputs,
    cwd,
    moreArgs,
    vars,
  };
  state.out.push(command);

  const program = basename(argv[0] ?? "");
  const args = argv.slice(1);
  if (
    argv.length === 0 ||
    ["export", "declare", "typeset", "local", "readonly"].includes(program)
  ) {
    Object.assign(state.vars, setsVariables(argv, assignments));
  }
  if (program === "cd" || program === "pushd") changeDirectory(args, state);
  if (SHELLS.has(program)) {
    const script = shellScript(args);
    if (script !== undefined) walkText(script, { ...state, cwd }, true);
  }
  if (program === "eval" && args.length > 0) walkText(args.join(" "), { ...state, cwd }, true);
  if (program === "find") {
    const exec = findExec(args);
    if (exec && exec.length > 0) {
      state.out.push({ ...command, argv: exec, assignments: {}, inputs: [], moreArgs: true });
    }
  }
}

function walkEntries(entries: ParseEntry[], state: State) {
  let current: Raw = { words: [], inputs: [] };
  const flush = () => {
    if (current.words.length > 0 || current.inputs.length > 0) emit(current, state);
    current = { words: [], inputs: [] };
  };
  // Folders to go back to when a subshell or substitution closes.
  const saved: (string | undefined)[] = [];
  const frames: Raw[] = [];
  // A `$(...)` just closed: a word starting with / right after it is the rest of the same word,
  // as in $(pwd)/build. shell-quote drops the spacing that would tell.
  let afterSubstitution = false;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as ParseEntry;
    const closedSubstitution = afterSubstitution;
    afterSubstitution = false;
    if (isOp(entry)) {
      const op = entry.op;
      if (SEPARATORS.has(op)) {
        flush();
      } else if (OPENERS.has(op)) {
        const last = current.words.at(-1);
        // `$(` arrives as a word ending in $ followed by `(`: the word holds a substitution.
        if (op === "(" && last?.endsWith("$")) {
          current.words[current.words.length - 1] = `${last.slice(0, -1)}${SUBSTITUTION}`;
        }
        frames.push(current);
        saved.push(state.cwd);
        current = { words: [], inputs: [] };
      } else if (op === ")") {
        flush();
        state.cwd = saved.pop() ?? state.cwd;
        current = frames.pop() ?? { words: [], inputs: [] };
        afterSubstitution = current.words.at(-1)?.endsWith(SUBSTITUTION) ?? false;
      } else if (READ_REDIRECTS.has(op) || OTHER_REDIRECTS.has(op)) {
        // A descriptor number before the operator, as in 2>&1, is not an argument.
        if (/^\d+$/.test(current.words.at(-1) ?? "")) current.words.pop();
        const target = entries[i + 1];
        const value = target === undefined ? undefined : word(target);
        if (value !== undefined) {
          if (READ_REDIRECTS.has(op)) current.inputs.push(value);
          i++;
        }
      }
      continue;
    }
    const value = word(entry);
    if (value === undefined) continue;
    if (closedSubstitution && value.startsWith("/")) {
      current.words[current.words.length - 1] += value;
    } else {
      current.words.push(value);
    }
  }
  flush();
  while (frames.length > 0) {
    current = frames.pop() ?? { words: [], inputs: [] };
    flush();
  }
}

function walkText(text: string, state: State, nested: boolean) {
  if (nested && state.depth >= MAX_DEPTH) return;
  const inner: State = nested
    ? { ...state, vars: { ...state.vars }, depth: state.depth + 1 }
    : state;
  // Variable references stay as written, so guards can see which variables a command reads.
  const entries = parse(splitLines(text), (name) => `$${name}`);
  walkEntries(entries, inner);
}

/** The simple commands in a shell line, in order, nested ones after the command that runs them. */
export function shellCommands(text: string, options: ShellOptions = {}): ShellCommand[] {
  const state: State = {
    cwd: options.cwd,
    vars: { ...options.env },
    depth: 0,
    out: [],
  };
  walkText(text, state, false);
  return state.out;
}
