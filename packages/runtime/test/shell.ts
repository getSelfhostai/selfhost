/**
 * A tiny sh for tests: enough of the shell the adapters and the conformance suite send (echo,
 * printf, exit, pwd, sleep, cd, export, mkdir, cat, rm, base64, sh -c, ;, &&, |, >, >>, <, 1>&2)
 * over an in-memory file system. Sleeps return at once; one longer than the timeout times out.
 */

export interface Box {
  files: Map<string, Uint8Array>;
}

export interface ShellOptions {
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}

export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

type Token = { op: string } | { word: string };

function tokenize(input: string, vars: Record<string, string>): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let word: string | undefined;
  const push = () => {
    if (word !== undefined) tokens.push({ word });
    word = undefined;
  };
  const expand = (from: number): [string, number] => {
    if (input[from] === "?") return [vars["?"] ?? "0", from + 1];
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(input.slice(from));
    if (!match) return ["$", from];
    return [vars[match[0]] ?? "", from + match[0].length];
  };
  while (i < input.length) {
    const c = input[i] as string;
    if (c === " " || c === "\n" || c === "\t") {
      push();
      i++;
    } else if (input.startsWith("1>&2", i)) {
      push();
      tokens.push({ op: "1>&2" });
      i += 4;
    } else if (input.startsWith("&&", i)) {
      push();
      tokens.push({ op: "&&" });
      i += 2;
    } else if (input.startsWith(">>", i)) {
      push();
      tokens.push({ op: ">>" });
      i += 2;
    } else if (c === ";" || c === "|" || c === ">" || c === "<") {
      push();
      tokens.push({ op: c });
      i++;
    } else if (c === "'") {
      const end = input.indexOf("'", i + 1);
      word = (word ?? "") + input.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      i++;
      let text = "";
      while (i < input.length && input[i] !== '"') {
        if (input[i] === "$") {
          const [value, next] = expand(i + 1);
          text += value;
          i = next;
        } else if (input[i] === "\\" && i + 1 < input.length) {
          text += input[i + 1];
          i += 2;
        } else text += input[i++];
      }
      word = (word ?? "") + text;
      i++;
    } else if (c === "$") {
      const [value, next] = expand(i + 1);
      word = (word ?? "") + value;
      i = next;
    } else {
      word = (word ?? "") + c;
      i++;
    }
  }
  push();
  return tokens;
}

/** A script cut at unquoted ; and &&, so each command expands its variables when it runs. */
function split(text: string): { body: string; op: string }[] {
  const out: { body: string; op: string }[] = [];
  let quote: string | undefined;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === "\\" && quote === '"') i++;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === ";" || c === "\n") {
      out.push({ body: text.slice(start, i), op: ";" });
      start = i + 1;
    } else if (c === "&" && text[i + 1] === "&") {
      out.push({ body: text.slice(start, i), op: "&&" });
      start = i + 2;
      i++;
    }
  }
  out.push({ body: text.slice(start), op: ";" });
  return out;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

class Timeout extends Error {}

function resolvePath(cwd: string, path: string) {
  return path.startsWith("/") ? path : `${cwd.replace(/\/$/, "")}/${path}`;
}

function printf(format: string, args: string[]): string {
  let index = 0;
  return format.replace(/\\n/g, "\n").replace(/%s/g, () => args[index++] ?? "");
}

export function runShell(command: string, box: Box, options: ShellOptions = {}): ShellResult {
  const state = {
    cwd: options.cwd ?? "/home/user",
    vars: { ...options.env, "?": "0" } as Record<string, string>,
    stdout: "",
    stderr: "",
  };
  try {
    const code = script(command, state);
    return { exitCode: code, stdout: state.stdout, stderr: state.stderr, timedOut: false };
  } catch (error) {
    if (error instanceof Timeout) {
      return { exitCode: 124, stdout: state.stdout, stderr: state.stderr, timedOut: true };
    }
    if (error instanceof Exit) {
      return { exitCode: error.code, stdout: state.stdout, stderr: state.stderr, timedOut: false };
    }
    throw error;
  }

  function script(text: string, s: typeof state): number {
    let code = 0;
    let skip = false;
    for (const { body, op } of split(text)) {
      if (!skip && body.trim() !== "") {
        code = pipeline(tokenize(body, s.vars), s);
        s.vars["?"] = String(code);
      }
      skip = op === "&&" && code !== 0;
    }
    return code;
  }

  function pipeline(tokens: Token[], s: typeof state): number {
    const parts: Token[][] = [[]];
    for (const token of tokens) {
      if ("op" in token && token.op === "|") parts.push([]);
      else parts.at(-1)?.push(token);
    }
    let input = "";
    let code = 0;
    parts.forEach((part, index) => {
      const last = index === parts.length - 1;
      const result = simple(part, s, input, last);
      input = result.out;
      code = result.code;
    });
    return code;
  }

  function simple(tokens: Token[], s: typeof state, stdin: string, last: boolean) {
    const words: string[] = [];
    let stdinBytes: Uint8Array | undefined;
    let outFile: string | undefined;
    let append = false;
    let toStderr = false;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i] as Token;
      if ("op" in token) {
        const next = tokens[i + 1];
        if (token.op === ">" || token.op === ">>") {
          outFile = next && "word" in next ? next.word : undefined;
          append = token.op === ">>";
          i++;
        } else if (token.op === "<") {
          const path = next && "word" in next ? next.word : "";
          const file = box.files.get(resolvePath(s.cwd, path));
          if (!file) {
            s.stderr += `sh: ${path}: No such file or directory\n`;
            return { code: 1, out: "" };
          }
          stdin = dec.decode(file);
          stdinBytes = file;
          i++;
        } else if (token.op === "1>&2") toStderr = true;
      } else words.push(token.word);
    }
    let out = "";
    const code = builtin(words, s, stdinBytes ?? enc.encode(stdin), (text) => {
      out += text;
    });
    if (outFile !== undefined) {
      const path = resolvePath(s.cwd, outFile);
      const bytes = typeof out === "string" ? enc.encode(out) : out;
      const before = append ? (box.files.get(path) ?? new Uint8Array()) : new Uint8Array();
      const joined = new Uint8Array(before.length + bytes.length);
      joined.set(before);
      joined.set(bytes, before.length);
      box.files.set(path, binaryOut ?? joined);
      binaryOut = undefined;
      return { code, out: "" };
    }
    binaryOut = undefined;
    if (!last) return { code, out };
    if (toStderr) s.stderr += out;
    else s.stdout += out;
    return { code, out: "" };
  }

  function builtin(
    words: string[],
    s: typeof state,
    stdin: Uint8Array,
    write: (text: string) => void,
  ): number {
    const [name = "", ...args] = words;
    switch (name) {
      case "":
      case ":":
      case "true":
        return 0;
      case "false":
        return 1;
      case "echo":
        write(`${args.join(" ")}\n`);
        return 0;
      case "printf":
        write(printf(args[0] ?? "", args.slice(1)));
        return 0;
      case "pwd":
        write(`${s.cwd}\n`);
        return 0;
      case "cd":
        s.cwd = resolvePath(s.cwd, args[0] ?? "/");
        return 0;
      case "export": {
        for (const pair of args) {
          const at = pair.indexOf("=");
          s.vars[pair.slice(0, at)] = pair.slice(at + 1);
        }
        return 0;
      }
      case "exit":
        throw new Exit(Number(args[0] ?? "0"));
      case "sleep": {
        const ms = Number(args[0] ?? "0") * 1000;
        if (options.timeoutMs !== undefined && options.timeoutMs > 0 && ms > options.timeoutMs) {
          throw new Timeout();
        }
        return 0;
      }
      case "mkdir":
      case "rm":
        if (name === "rm") {
          for (const arg of args.filter((a) => !a.startsWith("-"))) {
            box.files.delete(resolvePath(s.cwd, arg));
          }
        }
        return 0;
      case "cat": {
        const file = box.files.get(resolvePath(s.cwd, args[0] ?? ""));
        if (!file) {
          s.stderr += `cat: ${args[0]}: No such file or directory\n`;
          return 1;
        }
        write(dec.decode(file));
        return 0;
      }
      case "base64": {
        const decode = args.includes("-d");
        const fileArg = args.find((a) => !a.startsWith("-"));
        let input: Uint8Array;
        if (fileArg) {
          const file = box.files.get(resolvePath(s.cwd, fileArg));
          if (!file) {
            s.stderr += `base64: ${fileArg}: No such file or directory\n`;
            return 1;
          }
          input = file;
        } else input = stdin;
        if (decode) {
          binaryOut = new Uint8Array(Buffer.from(dec.decode(input).replace(/\s+/g, ""), "base64"));
          write(dec.decode(binaryOut));
        } else write(`${Buffer.from(input).toString("base64")}\n`);
        return 0;
      }
      case "sh":
        if (args[0] !== "-c") return 127;
        try {
          return script(args[1] ?? "", s);
        } catch (error) {
          if (error instanceof Exit) return error.code;
          throw error;
        }
      default:
        s.stderr += `sh: ${name}: not found\n`;
        return 127;
    }
  }
}

/** Raw bytes base64 -d produced, written as they are when the output goes to a file. */
let binaryOut: Uint8Array | undefined;

class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}
