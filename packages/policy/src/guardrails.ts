import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  GUARDRAIL_IDS,
  type GuardrailId,
  type ResolvedSelfhostConfig,
  type RuleAction,
  SELFHOST_DECISION_RULE_ID,
} from "@selfhost/schema";
import picomatch from "picomatch/posix.js";
import type { PolicyCheck, PolicyHit } from "./evaluate.js";
import {
  basename,
  expandWord,
  resolveWord,
  type ShellCommand,
  shellCommands,
  variablesIn,
} from "./shell.js";
import type { ToolCall } from "./tool-call.js";

/**
 * The built-in guardrails: checks that pre-tool hooks apply to every call on top of the rules in
 * selfhost.toml. Each has a stable rule id and gives PolicyHits like a rule does, in the mode
 * set by [guardrails] mode. They read shell commands with shellCommands, so wrappers, nested
 * shells, `cd` and command substitutions are looked through; what a command only decides at run
 * time is not seen (see the README's list of known bypasses).
 */

export interface GuardContext {
  /** The agent's environment, for $HOME, $TMPDIR and the variables a command names. */
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * The canonical path of an existing file or folder, following symlinks; undefined when it does
   * not exist. Without it paths are compared as written.
   */
  realpath?: (path: string) => string | undefined;
  /** Folders outside the workspace where recursive rm is fine. Default: /tmp and $TMPDIR. */
  tempDirs?: readonly string[];
}

interface Guardrail {
  /** Why the call is stopped, in plain language. */
  message: string;
  /** What the agent can do instead. */
  alternative: string;
  irreversible: boolean;
}

/** Each guardrail's default message and alternative, and whether what it stops can be undone. */
export const GUARDRAILS: Record<GuardrailId, Guardrail> = {
  "guard.force_push": {
    message: "Force pushes rewrite shared history and can drop commits other people pushed.",
    alternative:
      "Push your commits to a new branch and open a pull request. If this branch really has to be rewritten, ask the user first; git push --force-with-lease is the safer form.",
    irreversible: true,
  },
  "guard.reset_hard": {
    message: "git reset --hard throws away uncommitted work.",
    alternative:
      "Commit or stash the changes first (git stash), or discard only the files you mean to with git restore <file>.",
    irreversible: true,
  },
  "guard.rm_outside_workspace": {
    message: "Recursive rm outside the workspace is blocked.",
    alternative:
      "Delete only inside the workspace or a temp folder. If something outside has to go, tell the user the exact path and why, and let them delete it.",
    irreversible: true,
  },
  "guard.secret_read": {
    message: ".env files, private keys and credential files are not read by agents.",
    alternative:
      "Read .env.example (or another template) for the variable names, or ask the user for the one value you need. Never print a secret.",
    irreversible: false,
  },
  "guard.prod_sql": {
    message: "DROP and TRUNCATE on a production database are blocked.",
    alternative:
      "Run it against a local or staging database, or write a migration and let a person apply it to production.",
    irreversible: true,
  },
  "guard.prod_credentials": {
    message: "Production credentials are not used by agents.",
    alternative:
      "Use development or staging credentials, or ask the user to run the production step themselves.",
    irreversible: false,
  },
};

type Finding = { verdict: RuleAction; message: string; alternative?: string } | undefined;

const block = (message: string, alternative?: string): Finding => ({
  verdict: "block",
  message,
  ...(alternative ? { alternative } : {}),
});
const ask = (message: string, alternative?: string): Finding => ({
  verdict: "ask",
  message,
  ...(alternative ? { alternative } : {}),
});

/** Every guardrail with its mode, in the order hits are reported. */
export function guardrailChecks(config: ResolvedSelfhostConfig): PolicyCheck[] {
  const { mode, disable } = config.guardrails;
  return GUARDRAIL_IDS.map((id) => ({
    id,
    mode: disable.includes(id) ? "off" : mode,
    agents: ["all"],
    action: "block",
    message: GUARDRAILS[id].message,
    alternative: GUARDRAILS[id].alternative,
    irreversible: GUARDRAILS[id].irreversible,
  }));
}

const short = (text: string, max = 80) =>
  text.length > max ? `${text.slice(0, max - 3)}...` : text;

/** Options and operands of a command, with `--` ending the options. */
function operands(args: string[]): string[] {
  const out: string[] = [];
  let ended = false;
  for (const arg of args) {
    if (!ended && arg === "--") ended = true;
    else if (ended || !arg.startsWith("-") || arg === "-") out.push(arg);
  }
  return out;
}

/** git's subcommand and its arguments, past global options such as -C and -c. */
function gitCommand(argv: string[]): { sub: string; args: string[] } | undefined {
  if (basename(argv[0] ?? "") !== "git") return undefined;
  const valued = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (valued.has(arg)) i++;
    else if (!arg.startsWith("-")) return { sub: arg, args: argv.slice(i + 1) };
  }
  return undefined;
}

/**
 * Whether `git push` with these arguments forces. In a cluster of short options, -o takes the
 * rest of the cluster as its value.
 */
function pushForces(args: string[]): Finding {
  const forced = block(GUARDRAILS["guard.force_push"].message);
  let lease = false;
  let positional = 0;
  for (const arg of args) {
    if (arg === "--force" || arg === "--mirror") return forced;
    if (arg === "--force-with-lease" || arg.startsWith("--force-with-lease=")) {
      lease = true;
    } else if (/^-[A-Za-z0-9]+$/.test(arg)) {
      if ((arg.slice(1).split("o")[0] ?? "").includes("f")) return forced;
    } else if (!arg.startsWith("-")) {
      positional++;
      // After the remote, a refspec starting with + forces that ref.
      if (positional > 1 && arg.startsWith("+")) return forced;
    }
  }
  return lease
    ? ask(
        "git push --force-with-lease still rewrites the remote branch; a person has to confirm it.",
        "Push your commits to a new branch and open a pull request, or ask the user to confirm the rewrite.",
      )
    : undefined;
}

function forcePush(commands: ShellCommand[]): Finding {
  for (const command of commands) {
    const git = gitCommand(command.argv);
    if (git?.sub === "push") {
      const found = pushForces(git.args);
      if (found) return found;
    }
  }
  return undefined;
}

function resetHard(commands: ShellCommand[]): Finding {
  for (const command of commands) {
    const git = gitCommand(command.argv);
    if (git?.sub === "reset" && git.args.includes("--hard")) {
      return block(GUARDRAILS["guard.reset_hard"].message);
    }
  }
  return undefined;
}

/** true when `path` is strictly inside `root`. */
function within(root: string, path: string): boolean {
  const base = root.endsWith(sep) ? root : `${root}${sep}`;
  return path.startsWith(base);
}

/**
 * The path with symlinks resolved as far as it exists. With `keepLast` the last part stays as
 * written, since rm removes a symlink itself rather than what it points at.
 */
function canonical(path: string, context: GuardContext, keepLast = false): string {
  const realpath = context.realpath;
  if (!realpath) return path;
  const rest: string[] = keepLast ? [basename(path)] : [];
  let dir = keepLast ? dirname(path) : path;
  for (let i = 0; i < 64; i++) {
    const real = realpath(dir);
    if (real !== undefined) return join(real, ...rest.reverse());
    const parent = dirname(dir);
    if (parent === dir) break;
    rest.push(basename(dir));
    dir = parent;
  }
  return path;
}

function tempDirs(command: ShellCommand, context: GuardContext): string[] {
  const dirs = context.tempDirs ?? ["/tmp", "/private/tmp", "/var/tmp", command.vars.TMPDIR ?? ""];
  return dirs.filter((dir) => dir !== "" && isAbsolute(dir)).map((dir) => resolve(dir));
}

function recursiveRm(args: string[]): boolean {
  for (const arg of args) {
    if (arg === "--") return false;
    if (arg === "--recursive") return true;
    if (/^-[A-Za-z]+$/.test(arg) && /[rR]/.test(arg)) return true;
  }
  return false;
}

/**
 * Recursive rm of a path outside the workspace and the temp folders, or of the workspace or home
 * folder itself, blocks; of a path that cannot be resolved before it runs, asks. A temp folder
 * stays fine when the workspace is in it, but the workspace and the folders that hold it do not.
 */
function rmOutsideWorkspace(
  commands: ShellCommand[],
  roots: string[],
  context: GuardContext,
): Finding {
  let unknown: string | undefined;
  for (const command of commands) {
    if (basename(command.argv[0] ?? "") !== "rm") continue;
    const args = command.argv.slice(1);
    if (!recursiveRm(args)) continue;
    const allowed = [...roots, ...tempDirs(command, context)];
    const allowedReal = allowed.map((dir) => canonical(dir, context));
    // The workspace, the home folder and the folders that hold them are never fine, even
    // inside a temp folder.
    const home = command.vars.HOME;
    const kept = [...roots, ...(home && isAbsolute(home) ? [resolve(home)] : [])];
    const targets = operands(args);
    if (command.moreArgs) unknown ??= "the paths it gets at run time";
    for (const target of targets) {
      const path = resolveWord(target.replace(/\/+$/, "") || "/", command);
      if (path === undefined) {
        unknown ??= short(target, 60);
        continue;
      }
      // With a trailing slash rm follows a symlink and removes what it points at.
      const real = canonical(path, context, !target.endsWith("/"));
      const holds = kept.find((dir) => {
        const realDir = canonical(dir, context);
        return dir === path || within(path, dir) || realDir === real || within(real, realDir);
      });
      if (holds !== undefined) {
        const what = roots.includes(holds) ? "the workspace" : "the home folder";
        return block(
          `rm -rf on ${short(path, 120)} would delete ${what}.`,
          "Remove the specific files or folders you mean, inside the workspace, by their own paths.",
        );
      }
      const inside =
        allowed.some((dir) => within(dir, path)) && allowedReal.some((dir) => within(dir, real));
      if (!inside) {
        const where = roots.length > 0 ? ` (workspace ${roots[0]})` : "";
        return block(`rm -rf on ${short(path, 120)} is outside the workspace${where}.`);
      }
    }
  }
  return unknown === undefined
    ? undefined
    : ask(
        `rm -rf on ${unknown}, which cannot be resolved before it runs; a person has to confirm it.`,
        "Spell the path out in the command so it can be checked before it runs, or ask the user.",
      );
}

const ENV_TEMPLATE = /\.(example|sample|template|dist)$/i;

/** File names that hold secrets wherever they are. */
const SECRET_NAMES = [
  ".env",
  ".env.*",
  "*.env",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_ecdsa_sk",
  "id_ed25519_sk",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.p8",
  "*.jks",
  "*.keystore",
  "*.ppk",
  "*.kdbx",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "_netrc",
  ".git-credentials",
  ".pgpass",
  ".my.cnf",
  ".htpasswd",
  ".boto",
  ".s3cfg",
  ".vault-token",
  ".credentials.json",
  "credentials.json",
  "secrets.json",
  "secrets.yml",
  "secrets.yaml",
];

/** Credential files and folders by where they live, matched against the absolute path. */
const SECRET_PATHS = [
  "**/.ssh",
  "**/.ssh/!(*.pub|known_hosts*|config|authorized_keys*)",
  "**/.gnupg",
  "**/.gnupg/**",
  "**/.aws/credentials",
  "**/.aws/sso/cache/**",
  "**/.aws/cli/cache/**",
  "**/.docker/config.json",
  "**/.kube/config",
  "**/.config/gcloud/**",
  "**/.config/gh/hosts.yml",
  "**/.azure/accessTokens.json",
  "**/.azure/msal_token_cache.*",
  "**/.terraform.d/credentials.tfrc.json",
  "**/.codex/auth.json",
  "**/.cursor/auth.json",
  "**/.config/cursor/auth.json",
  "**/opencode/auth.json",
  "**/.config/goose/secrets.yaml",
  "**/.selfhost/config.json",
  "**/.selfhost/exceptions",
  "**/.selfhost/exceptions/**",
];

const nameMatcher = picomatch(SECRET_NAMES, { dot: true, nocase: true });
const pathMatcher = picomatch(SECRET_PATHS, { dot: true });

/** true when the file is a secret file: a .env file, a private key or a credential file. */
export function isSecretPath(path: string): boolean {
  const normalized = path.split(sep).join("/").replace(/\/+$/, "");
  const name = basename(normalized);
  if (/\.env/i.test(name) && ENV_TEMPLATE.test(name)) return false;
  return nameMatcher(name) || pathMatcher(normalized);
}

/** Programs whose file operands are read and can be printed or copied. */
const READERS = new Set([
  "cat",
  "tac",
  "less",
  "more",
  "most",
  "head",
  "tail",
  "bat",
  "batcat",
  "nl",
  "od",
  "xxd",
  "hexdump",
  "hd",
  "strings",
  "base64",
  "base32",
  "basenc",
  "uuencode",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "ack",
  "awk",
  "gawk",
  "mawk",
  "sed",
  "cut",
  "sort",
  "uniq",
  "diff",
  "cmp",
  "comm",
  "paste",
  "join",
  "fold",
  "fmt",
  "column",
  "jq",
  "yq",
  "iconv",
  "tar",
  "zip",
  "7z",
  "gpg",
]);

/** Programs that copy: every operand but the last is read. */
const COPIERS = new Set(["cp", "scp", "rsync", "install"]);

/** Options whose value is a file the program reads. */
const READ_OPTIONS: Record<string, string[]> = {
  openssl: ["-in", "-inkey", "-key"],
  "ssh-keygen": ["-f"],
  ssh: ["-i"],
  curl: ["-T", "--upload-file", "--cert", "--key"],
  wget: ["--post-file", "--body-file"],
  grep: ["-f"],
  xargs: ["-a"],
};

/** The files a shell command reads, as words. */
function readsOf(command: ShellCommand): string[] {
  const program = basename(command.argv[0] ?? "");
  const args = command.argv.slice(1);
  const read = [...command.inputs];
  if (READERS.has(program)) read.push(...operands(args));
  if (COPIERS.has(program)) {
    const files = operands(args);
    const targetFlag = args.some((arg) => arg === "-t" || arg.startsWith("--target-directory"));
    read.push(...(targetFlag ? files : files.slice(0, -1)));
  }
  // ssh-keygen -f names the key it writes when it makes a new one; only -y, -l, -p, -e, -c and -B
  // read an existing key.
  const options =
    program === "ssh-keygen" && !args.some((arg) => /^-[a-zA-Z]*[ylpecB]/.test(arg))
      ? []
      : (READ_OPTIONS[program] ?? []);
  for (const option of options) {
    args.forEach((arg, i) => {
      if (arg === option && args[i + 1] !== undefined) read.push(args[i + 1] ?? "");
      else if (arg.startsWith(`${option}=`)) read.push(arg.slice(option.length + 1));
    });
  }
  if (program === "dd") {
    for (const arg of args) if (arg.startsWith("if=")) read.push(arg.slice(3));
  }
  if (program === "curl" || program === "wget") {
    for (const arg of args) {
      // curl -d @file, --data-binary @file, -F name=@file; file:// URLs.
      const at = /(?:^|=)@([^;]+)/.exec(arg);
      if (at?.[1]) read.push(at[1]);
      if (arg.startsWith("file://")) read.push(arg.slice("file://".length));
    }
  }
  if (program === "git") {
    const git = gitCommand(command.argv);
    if (git && ["show", "cat-file"].includes(git.sub)) {
      // <rev>:<path> names a file as committed.
      for (const arg of git.args) {
        const colon = arg.indexOf(":");
        if (colon !== -1 && !arg.startsWith("-")) read.push(arg.slice(colon + 1));
      }
    }
  }
  return read;
}

/** The absolute path for a word, or the word itself when it cannot be resolved. */
function pathOf(value: string, command: Pick<ShellCommand, "cwd" | "vars">): string {
  return resolveWord(value, command) ?? value;
}

function fileOf(call: ToolCall): string | undefined {
  if (call.path === undefined) return undefined;
  if (isAbsolute(call.path)) return call.path;
  const base = call.root ?? call.cwd;
  return base === undefined ? call.path : join(base, call.path);
}

/**
 * selfhost's own files: the team token and pinned keys in config.json, and the exception files
 * (the local key, requests and grants). Blocking reads of them is defense in depth, not the
 * boundary: in team mode the team server signs grants with a key no laptop holds.
 */
const SELFHOST_FILES = [
  "**/.selfhost/config.json",
  "**/.selfhost/exceptions",
  "**/.selfhost/exceptions/**",
];
const selfhostFile = picomatch(SELFHOST_FILES, { dot: true });

/** Files under HOME a glob in a read could reach: selfhost's own, by their usual paths. */
const SELFHOST_TARGETS = [
  ".selfhost/config.json",
  ".selfhost/exceptions",
  ".selfhost/exceptions/key",
  ".selfhost/exceptions/grants",
  ".selfhost/exceptions/requests",
];

const GLOB = /[*?[{]/;

/**
 * The selfhost file a glob such as ~/.sel?host/exceptions/ke? would match under HOME, if any.
 * Only selfhost's own files by their usual paths: the shell expands the glob, so the word as
 * written never names them.
 */
function globReachesSelfhost(pattern: string, home: string | undefined): string | undefined {
  if (!GLOB.test(pattern) || home === undefined || home === "") return undefined;
  let matches: (path: string) => boolean;
  try {
    matches = picomatch(pattern.split(sep).join("/"), { dot: true });
  } catch {
    return undefined;
  }
  const base = home.split(sep).join("/").replace(/\/+$/, "");
  return SELFHOST_TARGETS.map((target) => `${base}/${target}`).find((path) => matches(path));
}

/** Inline code (python -c, node -e, ...) that names selfhost's config or exception files. */
function inlineReadsSelfhost(command: ShellCommand): boolean {
  const [path = "", ...args] = command.argv;
  const flags = INLINE_CODE[basename(path)];
  if (!flags) return false;
  return args.some((arg, i) => {
    if (!flags.includes(args[i - 1] ?? "")) return false;
    return /\.selfhost\b/.test(arg) && /config\.json|exceptions/.test(arg);
  });
}

const SELFHOST_FILE_ALTERNATIVE =
  "Nothing in it is needed for the task. To get a blocked call allowed, call request_exception on the selfhost MCP server with the exception id from the block, or ask the user.";

/** The block for reading a secret file; selfhost's own files get their own message. */
function secretBlock(path: string): Finding {
  const normalized = path.split(sep).join("/");
  if (selfhostFile(normalized)) {
    return block(
      `selfhost's own files (its team token and the exception key) are not read by agents (${short(basename(path), 60)})`,
      SELFHOST_FILE_ALTERNATIVE,
    );
  }
  return block(`${GUARDRAILS["guard.secret_read"].message} (${short(basename(path), 60)})`);
}

function secretRead(call: ToolCall, commands: ShellCommand[]): Finding {
  const file = fileOf(call);
  if (file !== undefined && call.access === "read" && isSecretPath(file)) return secretBlock(file);
  for (const command of commands) {
    for (const value of readsOf(command)) {
      const path = pathOf(value, command);
      if (isSecretPath(path)) return secretBlock(path);
      const reached = globReachesSelfhost(path, command.vars.HOME);
      if (reached) return secretBlock(reached);
    }
    if (inlineReadsSelfhost(command)) return secretBlock(".selfhost/exceptions");
  }
  return undefined;
}

const DESTRUCTIVE_SQL =
  /\b(drop\s+(table|database|schema|view|materialized\s+view|index|sequence|function|procedure|trigger|type|extension|role|user|owned)\b|truncate\b)/i;

/** Programs and subcommands that drop a database without SQL. */
function dropsDatabase(command: ShellCommand): boolean {
  const program = basename(command.argv[0] ?? "");
  const args = command.argv.slice(1);
  if (program === "dropdb") return true;
  if (program === "mysqladmin" && args.includes("drop")) return true;
  if (["rails", "rake", "bin/rails"].includes(program) && args.includes("db:drop")) return true;
  return false;
}

function matcher(globs: readonly string[]): (value: string) => boolean {
  return globs.length === 0 ? () => false : picomatch([...globs], { dot: true, nocase: true });
}

/** What a word could name as a database: itself, a URL's host and database, a key=value's parts. */
function connectionNames(value: string): string[] {
  const names = [value, ...variablesIn(value)];
  for (const part of value.split(/\s+/)) {
    const pair = /^-{0,2}([A-Za-z_][\w.-]*)=(.*)$/.exec(part);
    if (pair) names.push(pair[1] ?? "", pair[2] ?? "");
    if (part.includes("://")) {
      try {
        const url = new URL(part);
        names.push(url.hostname, url.host, url.pathname.replace(/^\/+/, ""));
      } catch {
        // Not a URL after all; the word itself is still compared.
      }
    }
  }
  return names.filter((name) => name !== "");
}

function prodSql(
  call: ToolCall,
  commands: ShellCommand[],
  config: ResolvedSelfhostConfig,
): Finding {
  const markers = config.guardrails.prod_connections;
  if (markers.length === 0 || call.command === undefined) return undefined;
  const destructive =
    DESTRUCTIVE_SQL.test(call.command) || commands.some((command) => dropsDatabase(command));
  if (!destructive) return undefined;
  const isProd = matcher(markers);
  for (const command of commands) {
    const words = [...command.argv, ...Object.entries(command.assignments).flat()];
    for (const value of words) {
      const name = connectionNames(value).find(isProd);
      if (name !== undefined) {
        return block(`DROP or TRUNCATE on a production database (${short(name, 60)}) is blocked.`);
      }
    }
  }
  return undefined;
}

/** Flags that pick an account, profile or cluster to act as. */
const SELECTOR_FLAGS = new Set([
  "--profile",
  "--context",
  "--kube-context",
  "--project",
  "--account",
  "--subscription",
  "--org",
]);

/** Flags and variables whose value is a credential file. */
const CREDENTIAL_FILE_FLAGS = new Set(["--kubeconfig", "--key-file", "--credential-file"]);
const CREDENTIAL_FILE_VARS = new Set([
  "GOOGLE_APPLICATION_CREDENTIALS",
  "KUBECONFIG",
  "AWS_SHARED_CREDENTIALS_FILE",
]);

/** Commands that print every environment variable. */
function dumpsEnvironment(command: ShellCommand): boolean {
  const program = basename(command.argv[0] ?? "");
  const args = command.argv.slice(1);
  if (program === "env" || program === "printenv") return args.length === 0;
  if (program === "export" || program === "set") {
    return args.length === 0 || (args.length === 1 && args[0] === "-p");
  }
  if (program === "declare" || program === "typeset") {
    return args.length === 1 && (args[0] === "-x" || args[0] === "-p");
  }
  return false;
}

function prodCredentials(
  call: ToolCall,
  commands: ShellCommand[],
  config: ResolvedSelfhostConfig,
  context: GuardContext,
): Finding {
  const markers = config.guardrails.prod_credentials;
  if (markers.length === 0) return undefined;
  const home = context.env?.HOME;
  const expand = (glob: string) =>
    (glob === "~" || glob.startsWith("~/")) && home ? home + glob.slice(1) : glob;
  const pathMarkers = markers.filter((glob) => glob.startsWith("/") || glob.startsWith("~"));
  const nameMarkers = markers.filter((glob) => !pathMarkers.includes(glob));
  const isProdName = matcher(nameMarkers);
  const isProdPath = matcher(pathMarkers.map(expand));
  const found = (what: string) =>
    block(`${GUARDRAILS["guard.prod_credentials"].message} (${short(what, 60)})`);

  const file = fileOf(call);
  if (file !== undefined && isProdPath(file)) return found(basename(file));
  for (const command of commands) {
    if (dumpsEnvironment(command)) {
      const names = Object.keys(command.vars).filter(isProdName);
      if (names.length > 0) return found(`prints ${names[0]}`);
    }
    const names = new Set<string>(Object.keys(command.assignments));
    const args = command.argv.slice(1);
    for (const [i, arg] of command.argv.entries()) {
      for (const name of variablesIn(arg)) names.add(name);
      const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(arg);
      if (assignment?.[1] && i > 0) names.add(assignment[1]);
    }
    for (const name of names) if (isProdName(name)) return found(name);
    const values: string[] = [];
    const paths: string[] = [];
    args.forEach((arg, i) => {
      const [flag, inline] = arg.includes("=") ? arg.split(/=(.*)/s) : [arg, undefined];
      const value = inline ?? args[i + 1];
      if (value === undefined || flag === undefined) return;
      if (SELECTOR_FLAGS.has(flag)) values.push(value);
      if (CREDENTIAL_FILE_FLAGS.has(flag)) paths.push(value);
    });
    for (const [name, value] of Object.entries(command.assignments)) {
      if (/PROFILE|CONTEXT|PROJECT/.test(name)) values.push(value);
      if (CREDENTIAL_FILE_VARS.has(name)) paths.push(value);
    }
    if (basename(command.argv[0] ?? "") === "kubectl" && args[0] === "config") {
      if (args[1] === "use-context" && args[2]) values.push(args[2]);
    }
    for (const value of values) {
      const expanded = expandWord(value, command.vars) ?? value;
      if (isProdName(expanded)) return found(expanded);
    }
    for (const value of [...paths, ...readsOf(command)]) {
      const path = pathOf(value, command);
      if (isProdPath(path)) return found(basename(path));
    }
  }
  return undefined;
}

/** Programs that run a package's command line or a script, which selfhost can hide behind. */
const RUNNERS = new Set([
  "node",
  "nodejs",
  "bun",
  "bunx",
  "deno",
  "tsx",
  "ts-node",
  "npx",
  "pnpx",
  "pnpm",
  "yarn",
  "npm",
]);

/**
 * selfhost commands that answer for a person or loosen what is enforced, as the words that name
 * them, and the flag that makes the command one when it needs one.
 */
const DECISION_COMMANDS: readonly { words: readonly string[]; flag?: string }[] = [
  { words: ["inbox", "approve"] },
  { words: ["inbox", "deny"] },
  { words: ["review", "approve"] },
  { words: ["review", "deny"] },
  { words: ["decide"] },
  { words: ["policy", "promote"] },
  { words: ["team", "policy", "push"] },
  { words: ["team", "role"] },
  { words: ["team", "revoke"] },
  { words: ["team", "leave"] },
  { words: ["guard", "uninstall"] },
  { words: ["agents", "configure"], flag: "--remove" },
  { words: ["init"], flag: "--undo" },
  { words: ["notify", "add"] },
  { words: ["notify", "remove"] },
  // Which key, and so which budget, an agent's model traffic goes through (--rotate and --undo
  // included): an agent that took itself off the gateway would leave its budget behind.
  { words: ["gateway", "connect"] },
  { words: ["gateway", "disconnect"] },
  // Who holds a run, and so whose login its next step runs under: an agent never hands its own
  // run to someone, nor takes over one handed to its person.
  { words: ["handoff"] },
  { words: ["takeover"] },
];

/** The selfhost decision command these words name, after the program, if they name one. */
function decisionWords(argv: readonly string[]): string | undefined {
  const words = argv.slice(1).filter((word) => !word.startsWith("-"));
  for (const command of DECISION_COMMANDS) {
    if (command.flag !== undefined && !argv.includes(command.flag)) continue;
    const at = words.findIndex((_, i) =>
      command.words.every((word, j) => words[i + j]?.toLowerCase() === word),
    );
    if (at !== -1) return [...command.words, ...(command.flag ? [command.flag] : [])].join(" ");
  }
  return undefined;
}

/** The words of a selfhost decision command a shell command runs, if it runs one. */
export function selfhostDecisionCommand(argv: readonly string[]): string | undefined {
  const program = basename(argv[0] ?? "");
  if (!RUNNERS.has(program) && !argv.some((word) => /selfhost/i.test(word))) return undefined;
  return decisionWords(argv);
}

/**
 * The decision command a parsed command runs, reading variables the line set (`s=selfhost; $s
 * inbox approve`). A program that cannot be known before it runs (`$(which selfhost)`, a variable
 * from elsewhere) counts as selfhost when the words after it name a decision command.
 */
function decisionCommandOf(command: ShellCommand): string | undefined {
  const argv = command.argv.map((word) => expandWord(word, command.vars) ?? word);
  const found = selfhostDecisionCommand(argv);
  if (found !== undefined) return found;
  const program = argv[0] ?? "";
  return /[$`]/.test(program) ? decisionWords(argv) : undefined;
}

/** Shells and interpreters that run code they read from stdin when given no script. */
const STDIN_RUNNERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "python",
  "python3",
  "node",
  "perl",
  "ruby",
]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

/** base64 -d, openssl base64 -d, xxd -r, uudecode and the like: text that was hidden. */
function decodes(command: ShellCommand): boolean {
  const [program = "", ...args] = command.argv.map(basename);
  const has = (...flags: string[]) => args.some((arg) => flags.includes(arg));
  if (program === "base64" || program === "basenc") return has("-d", "-D", "--decode");
  if (program === "openssl") return has("base64", "enc") && has("-d");
  if (program === "xxd") return has("-r", "-revert");
  return program === "uudecode";
}

/** Runs code it gets at run time: from stdin, or from a command substitution. */
function runsHiddenCode(command: ShellCommand): boolean {
  const [path = "", ...args] = command.argv;
  const program = basename(path);
  if (program === "eval" || program === "source" || program === ".") return true;
  if (!STDIN_RUNNERS.has(program)) return false;
  const operands = args.filter((arg) => !arg.startsWith("-"));
  if (operands.length === 0 || args.includes("-s") || operands.includes("-")) return true;
  if (!SHELLS.has(program) || !args.includes("-c")) return false;
  return args.some((arg) => arg.includes("$(") || arg.includes("`"));
}

/** Inline code flags: python -c, node -e, perl -e, ruby -e. */
const INLINE_CODE: Readonly<Record<string, readonly string[]>> = {
  python: ["-c"],
  python3: ["-c"],
  node: ["-e", "--eval", "-p", "--print"],
  perl: ["-e", "-E"],
  ruby: ["-e"],
};

/** What starts a process in that code: subprocess, os.system, child_process, backticks. */
const SPAWNS =
  /subprocess|os\.(?:system|exec|spawn|popen)|pty\.spawn|child_process|exec(?:Sync|File)?\s*\(|spawn(?:Sync)?\s*\(|system\s*\(|`|%x/;

/** Inline interpreter code that names selfhost and starts a process. */
function scriptsSelfhost(command: ShellCommand): boolean {
  const [path = "", ...args] = command.argv;
  const flags = INLINE_CODE[basename(path)];
  if (!flags) return false;
  return args.some((arg, i) => {
    const code = flags.includes(args[i - 1] ?? "") ? arg : undefined;
    return code !== undefined && /selfhost/i.test(code) && SPAWNS.test(code);
  });
}

const PERSON_DECIDES =
  "Tell the user what you need and why, and let them decide in their own terminal or in the console.";

/**
 * The hit for a call that runs one of selfhost's own decision commands. A person decides those,
 * in their own terminal or the console, so it always enforces, whatever [guardrails] says. A
 * line that hides what it runs (decoded text piped to a shell, inline code that starts selfhost
 * in a subprocess) is put to the person. This is not the security boundary: the team server
 * checks every answer it is sent, whoever sends it.
 */
function selfhostDecision(commands: ShellCommand[]): PolicyHit | undefined {
  for (const command of commands) {
    const found = decisionCommandOf(command);
    if (found === undefined) continue;
    return {
      rule_id: SELFHOST_DECISION_RULE_ID,
      mode: "enforce",
      verdict: "block",
      message: `selfhost ${found} is a person's decision, so agents do not run it.`,
      alternative: PERSON_DECIDES,
      irreversible: false,
    };
  }
  const hidden = commands.some(decodes) && commands.some(runsHiddenCode);
  if (hidden || commands.some(scriptsSelfhost)) {
    return {
      rule_id: SELFHOST_DECISION_RULE_ID,
      mode: "enforce",
      verdict: "ask",
      message: hidden
        ? "This runs decoded text as code, which can hide anything, selfhost's own decisions included, so a person checks it."
        : "This runs selfhost from inline code, where a person's decision command can hide, so a person checks it.",
      alternative: PERSON_DECIDES,
      irreversible: false,
    };
  }
  return undefined;
}

/** The workspace folders a call may change: its root, else the folder it runs in. */
function rootsOf(call: ToolCall): string[] {
  const roots = call.root ?? call.cwd;
  return roots === undefined ? [] : [resolve(roots)];
}

/**
 * The guardrails that fire on one tool call, in GUARDRAIL_IDS order, in the mode [guardrails]
 * sets. Guardrails in `disable` and every guardrail when the mode is off never fire. Then the
 * selfhost decision check, which always enforces. Pure apart from `context.realpath`.
 */
export function guardrailHits(
  config: ResolvedSelfhostConfig,
  call: ToolCall,
  context: GuardContext = {},
): PolicyHit[] {
  const checks = guardrailChecks(config).filter((check) => check.mode !== "off");
  const commands =
    call.command === undefined
      ? []
      : shellCommands(call.command, { cwd: call.cwd ?? call.root, env: context.env });
  const roots = rootsOf(call);
  const findings: Record<GuardrailId, () => Finding> = {
    "guard.force_push": () => forcePush(commands),
    "guard.reset_hard": () => resetHard(commands),
    "guard.rm_outside_workspace": () => rmOutsideWorkspace(commands, roots, context),
    "guard.secret_read": () => secretRead(call, commands),
    "guard.prod_sql": () => prodSql(call, commands, config),
    "guard.prod_credentials": () => prodCredentials(call, commands, config, context),
  };
  const hits: PolicyHit[] = [];
  for (const check of checks) {
    const finding = findings[check.id as GuardrailId]();
    if (!finding) continue;
    const alternative = finding.alternative ?? check.alternative;
    hits.push({
      rule_id: check.id,
      mode: check.mode === "enforce" ? "enforce" : "observe",
      verdict: finding.verdict,
      message: finding.message,
      ...(alternative ? { alternative } : {}),
      irreversible: check.irreversible,
    });
  }
  const decision = selfhostDecision(commands);
  if (decision) hits.push(decision);
  return hits;
}
