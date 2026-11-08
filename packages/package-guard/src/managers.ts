import type { Ecosystem, Install } from "./parse.js";
import { addSpec, cargoSpec, goSpec, hostOf, npmSpec, pypiSpec, type Spec } from "./specs.js";

/** `/usr/bin/pip3.exe` is pip3. */
export function toolName(word: string): string {
  const base = word.slice(Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\")) + 1);
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, "");
}

interface Option {
  /** As written, without `=value`: `--registry`, `-i`, `-tags`. */
  name: string;
  value?: string;
}

interface Scanned {
  options: Option[];
  args: string[];
  /** With stopAtArg, the words after the first positional: the run command's own arguments. */
  rest: string[];
}

interface ScanSpec {
  values: ReadonlySet<string>;
  stopAtArg?: boolean;
  /** Go flags: one or two dashes, never clustered. */
  go?: boolean;
}

/** Splits words into options and positionals, with `--name=value`, `-n value` and `-abc`. */
function scan(words: string[], spec: ScanSpec): Scanned {
  const options: Option[] = [];
  const args: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] ?? "";
    if (word === "--") {
      const after = words.slice(i + 1);
      if (!spec.stopAtArg) return { options, args: [...args, ...after], rest: [] };
      return { options, args: after.slice(0, 1), rest: after.slice(1) };
    }
    if (word.startsWith("--") || (spec.go && word.startsWith("-") && word.length > 1)) {
      const eq = word.indexOf("=");
      const name = spec.go ? `-${word.replace(/^--?/, "").split("=")[0]}` : word.split("=")[0];
      if (eq !== -1) options.push({ name: name ?? word, value: word.slice(eq + 1) });
      else if (spec.values.has(name ?? word) && i + 1 < words.length) {
        options.push({ name: name ?? word, value: words[i + 1] });
        i += 1;
      } else options.push({ name: name ?? word });
      continue;
    }
    if (word.startsWith("-") && word.length > 1) {
      for (let j = 1; j < word.length; j += 1) {
        const name = `-${word[j]}`;
        if (!spec.values.has(name)) {
          options.push({ name });
          continue;
        }
        const attached = word.slice(j + 1);
        if (attached !== "") options.push({ name, value: attached.replace(/^=/, "") });
        else if (i + 1 < words.length) {
          options.push({ name, value: words[i + 1] });
          i += 1;
        } else options.push({ name });
        break;
      }
      continue;
    }
    if (spec.stopAtArg) return { options, args: [word], rest: words.slice(i + 1) };
    args.push(word);
  }
  return { options, args, rest: [] };
}

/** The first positional and the words around it, skipping options and their values. */
function subcommand(
  words: string[],
  values: ReadonlySet<string>,
): { before: string[]; sub?: string; after: string[] } {
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] ?? "";
    if (word === "--") break;
    if (word.startsWith("-")) {
      if (!word.includes("=") && values.has(word)) i += 1;
      continue;
    }
    return { before: words.slice(0, i), sub: word, after: words.slice(i + 1) };
  }
  return { before: words, after: [] };
}

const set = (...items: string[]) => new Set(items);
const values = (option: Option[], ...names: string[]) =>
  option.filter((o) => names.includes(o.name) && o.value !== undefined).map((o) => o.value ?? "");

function emptyInstall(ecosystem: Ecosystem, words: string[]): Install {
  return {
    ecosystem,
    manager: toolName(words[0] ?? ""),
    command: words.join(" "),
    packages: [],
    skipped: [],
    registries: [],
    privatePatterns: [],
  };
}

/** Registry variables in the environment, matched without regard to case. */
function envRegistries(env: Record<string, string>, names: string[], split = false): string[] {
  const found: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!names.includes(key.toLowerCase()) || value.trim() === "") continue;
    found.push(...(split ? value.trim().split(/\s+/) : [value.trim()]));
  }
  return found;
}

// npm, pnpm, yarn and bun.

const NPM_INSTALL = set(
  "install",
  "i",
  "in",
  "ins",
  "inst",
  "insta",
  "instal",
  "isnt",
  "isnta",
  "isntal",
  "isntall",
  "add",
  "install-test",
  "it",
);
const NPM_VALUES = [
  "--registry",
  "--prefix",
  "--tag",
  "--cache",
  "--userconfig",
  "--globalconfig",
  "--loglevel",
  "--omit",
  "--include",
  "--install-strategy",
  "--save-prefix",
  "--before",
  "--otp",
  "--scope",
  "--cpu",
  "--os",
  "--libc",
  "--node-options",
  "--script-shell",
];
const NODE_VALUES: Record<string, string[]> = {
  npm: [...NPM_VALUES, "-w", "--workspace"],
  pnpm: [
    ...NPM_VALUES,
    "--filter",
    "-F",
    "-C",
    "--dir",
    "--reporter",
    "--store-dir",
    "--virtual-store-dir",
    "--modules-dir",
    "--lockfile-dir",
    "--allow-build",
  ],
  yarn: [
    ...NPM_VALUES,
    "--cwd",
    "--cache-folder",
    "--modules-folder",
    "--global-folder",
    "--mutex",
    "--network-timeout",
    "--network-concurrency",
  ],
  bun: [
    ...NPM_VALUES,
    "--cwd",
    "-c",
    "--config",
    "--cache-dir",
    "--backend",
    "--concurrent-scripts",
    "--network-concurrency",
    "--linker",
    "--filter",
  ],
};
/** Run-a-package commands take the package to run as an option too. */
const EXEC_VALUES = ["-p", "--package", "-c", "--call"];
const NPM_REGISTRY_ENV = [
  "npm_config_registry",
  "yarn_registry",
  "yarn_npm_registry_server",
  "bun_config_registry",
];

type NodeMode = "add" | "exec" | "create";

/** `npm init vite` runs create-vite; `npm init @scope/x` runs @scope/create-x. */
function createSpec(arg: string): Spec {
  const spec = npmSpec(arg);
  if ("skip" in spec) return spec;
  const [scope, rest] = spec.name.startsWith("@") ? spec.name.split("/") : [undefined, spec.name];
  const name =
    scope === undefined ? `create-${rest}` : rest ? `${scope}/create-${rest}` : `${scope}/create`;
  return spec.spec ? { name, spec: spec.spec } : { name };
}

function nodeInstall(
  family: string,
  mode: NodeMode,
  words: string[],
  env: Record<string, string>,
): Install {
  const install = emptyInstall("npm", words);
  const exec = mode === "exec";
  const valueFlags = new Set([
    ...(NODE_VALUES[family] ?? NPM_VALUES),
    ...(exec ? EXEC_VALUES : []),
  ]);
  const { options, args } = scan(words.slice(1), {
    values: valueFlags,
    stopAtArg: mode !== "add",
  });
  install.registries.push(
    ...options.filter((o) => /^--(@[^:]+:)?registry$/.test(o.name)).map((o) => o.value ?? ""),
    ...envRegistries(env, NPM_REGISTRY_ENV),
  );
  const named = exec ? values(options, "-p", "--package") : [];
  for (const arg of named) addSpec("npm", arg, npmSpec(arg), install);
  if (mode === "add") for (const arg of args) addSpec("npm", arg, npmSpec(arg), install);
  // With --package, the first positional is the command to run, not a package.
  else if (args[0] !== undefined && named.length === 0) {
    addSpec("npm", args[0], mode === "create" ? createSpec(args[0]) : npmSpec(args[0]), install);
  }
  return install;
}

/** The subcommand of a node package manager, after global options and `yarn workspace x`. */
function nodeCommand(
  family: string,
  words: string[],
  env: Record<string, string>,
): Install | undefined {
  const flags = new Set(NODE_VALUES[family] ?? NPM_VALUES);
  let { before, sub, after } = subcommand(words.slice(1), flags);
  // yarn workspace <name> add x, yarn global add x
  while (family === "yarn" && (sub === "workspace" || sub === "global")) {
    const next = subcommand(sub === "workspace" ? after.slice(1) : after, flags);
    before = [...before, ...next.before];
    ({ sub, after } = next);
  }
  if (sub === undefined) return undefined;
  const rebuilt = [words[0] ?? family, ...before, ...after];
  const isAdd =
    (family === "npm" && NPM_INSTALL.has(sub)) ||
    (family === "pnpm" && ["add", "install", "i"].includes(sub)) ||
    (family === "yarn" && sub === "add") ||
    (family === "bun" && ["add", "a", "install", "i"].includes(sub));
  if (isAdd) return nodeInstall(family, "add", rebuilt, env);
  const isExec =
    (family === "npm" && (sub === "exec" || sub === "x")) ||
    (family !== "npm" && sub === "dlx") ||
    (family === "bun" && sub === "x");
  if (isExec) return nodeInstall(family, "exec", rebuilt, env);
  // npm init <initializer> and every manager's create run create-<initializer>.
  if (sub === "create" || (family === "npm" && (sub === "init" || sub === "innit"))) {
    return nodeInstall(family, "create", rebuilt, env);
  }
  return undefined;
}

// pip, uv, poetry and pipx.

const PIP_VALUES = set(
  "-r",
  "--requirement",
  "--requirements",
  "-c",
  "--constraint",
  "--constraints",
  "-e",
  "--editable",
  "-i",
  "--index-url",
  "--extra-index-url",
  "-f",
  "--find-links",
  "--index",
  "--default-index",
  "--trusted-host",
  "-t",
  "--target",
  "--prefix",
  "--root",
  "--src",
  "--upgrade-strategy",
  "--platform",
  "--python-version",
  "--implementation",
  "--abi",
  "--no-binary",
  "--only-binary",
  "--progress-bar",
  "--log",
  "--log-file",
  "--proxy",
  "--retries",
  "--timeout",
  "--exists-action",
  "--cert",
  "--client-cert",
  "--cache-dir",
  "-C",
  "--config-settings",
  "--config-setting",
  "--global-option",
  "--report",
  "--python",
  "-p",
  "--group",
  "--keyring-provider",
  "--use-feature",
  "--use-deprecated",
  "--root-user-action",
  "--resume-retries",
  "--index-strategy",
  "--extra",
  "--overrides",
  "--build-constraints",
  "--build-constraint",
  "--resolution",
  "--prerelease",
  "--exclude-newer",
  "--link-mode",
  "--reinstall-package",
  "--upgrade-package",
  "-P",
  "--no-build-package",
  "--no-binary-package",
  "--python-platform",
  "--torch-backend",
  "--directory",
  "--project",
  "--color",
  "--config-file",
  "--allow-insecure-host",
  "--refresh-package",
  "--optional",
  "--package",
  "--script",
  "--rev",
  "--tag",
  "--branch",
  "-m",
  "--marker",
  "--bounds",
  "--from",
  "--with",
  "--with-editable",
  "--with-requirements",
  "--env-file",
  "-G",
  "-E",
  "--extras",
  "--markers",
  "--source",
  "--pip-args",
  "--suffix",
  "--spec",
  "--preinstall",
  "--backend",
  "--fetch-python",
);
const PIP_REGISTRIES = [
  "-i",
  "--index-url",
  "--extra-index-url",
  "-f",
  "--find-links",
  "--index",
  "--default-index",
  "--source",
];
const PIP_REGISTRY_ENV = [
  "pip_index_url",
  "pip_extra_index_url",
  "pip_find_links",
  "uv_index_url",
  "uv_extra_index_url",
  "uv_index",
  "uv_default_index",
  "uv_find_links",
];

type PythonMode = "add" | "exec" | "inject" | "with-only";

interface PythonCall {
  /** Requirements use the `name@version` form (poetry, uvx). */
  at?: boolean;
  mode: PythonMode;
}

function pythonInstall(words: string[], env: Record<string, string>, call: PythonCall): Install {
  const install = emptyInstall("pypi", words);
  const exec = call.mode === "exec" || call.mode === "with-only";
  const { options, args } = scan(words.slice(1), { values: PIP_VALUES, stopAtArg: exec });
  const pipArgs = values(options, "--pip-args").flatMap((value) => value.split(/\s+/));
  const nested = scan(pipArgs, { values: PIP_VALUES }).options;
  install.registries.push(
    ...[...options, ...nested]
      .filter((o) => PIP_REGISTRIES.includes(o.name) && o.value !== undefined)
      .map((o) => (o.value ?? "").replace(/^[\w-]+=(?=\w+:\/\/)/, "")),
    ...envRegistries(env, PIP_REGISTRY_ENV, true).map((v) => v.replace(/^[\w-]+=(?=\w+:\/\/)/, "")),
  );
  for (const file of values(
    options,
    "-r",
    "--requirement",
    "--requirements",
    "--with-requirements",
  )) {
    install.skipped.push({
      arg: file,
      reason: "lists packages in a file, which the guard does not read",
    });
  }
  for (const target of values(options, "-e", "--editable", "--with-editable")) {
    const host = hostOf(target.replace(/^(git|hg|svn|bzr)\+/, ""));
    install.skipped.push({
      arg: target,
      reason: "is an editable install of a local folder or repository",
      ...(host ? { host } : {}),
    });
  }
  const add = (arg: string) => addSpec("pypi", arg, pypiSpec(arg, { at: call.at }), install);
  for (const arg of values(options, "--with", "--preinstall")) add(arg);
  const from = values(options, "--from", "--spec");
  for (const arg of from) add(arg);
  if (call.mode === "add") for (const arg of args) add(arg);
  if (call.mode === "inject") for (const arg of args.slice(1)) add(arg);
  // uvx ruff, pipx run black; with --from or --spec the positional is the command instead.
  if (call.mode === "exec" && from.length === 0 && args[0] !== undefined) add(args[0]);
  return install;
}

const PYTHON = /^(python(\d+(\.\d+)*)?|py)$/;
const PIP = /^pip(\d+(\.\d+)*)?$/;
const PYTHON_VALUES = set("-W", "-X", "-Q");

/** `python -I -m pip install x` is `pip install x`. */
function pythonModule(words: string[]): string[] | undefined {
  for (let i = 1; i < words.length; i += 1) {
    const word = words[i] ?? "";
    if (word === "-m") return words.slice(i + 1);
    if (word.startsWith("-m") && word.length > 2) return [word.slice(2), ...words.slice(i + 1)];
    if (word === "-c" || !word.startsWith("-")) return undefined;
    if (PYTHON_VALUES.has(word)) i += 1;
  }
  return undefined;
}

const UV_GLOBAL = set(
  "--directory",
  "--project",
  "--cache-dir",
  "--config-file",
  "--color",
  "--python-preference",
  "--allow-insecure-host",
);

function pipCommand(words: string[], env: Record<string, string>): Install | undefined {
  const { sub, before, after } = subcommand(words.slice(1), PIP_VALUES);
  if (sub !== "install") return undefined;
  return pythonInstall([words[0] ?? "pip", ...before, ...after], env, { mode: "add" });
}

function uvCommand(words: string[], env: Record<string, string>): Install | undefined {
  const top = subcommand(words.slice(1), UV_GLOBAL);
  const tool = words[0] ?? "uv";
  if (top.sub === "pip") return pipCommand([tool, ...top.before, ...top.after], env);
  if (top.sub === "add") {
    return pythonInstall([tool, ...top.before, ...top.after], env, { mode: "add" });
  }
  if (top.sub === "run") {
    return pythonInstall([tool, ...top.before, ...top.after], env, { mode: "with-only" });
  }
  if (top.sub === "tool") {
    const next = subcommand(top.after, UV_GLOBAL);
    const rebuilt = [tool, ...top.before, ...next.before, ...next.after];
    if (next.sub === "install") return pythonInstall(rebuilt, env, { mode: "add", at: true });
    if (next.sub === "run") return pythonInstall(rebuilt, env, { mode: "exec", at: true });
  }
  return undefined;
}

function poetryCommand(words: string[], env: Record<string, string>): Install | undefined {
  const { sub, before, after } = subcommand(words.slice(1), PIP_VALUES);
  if (sub !== "add") return undefined;
  return pythonInstall([words[0] ?? "poetry", ...before, ...after], env, { mode: "add", at: true });
}

function pipxCommand(words: string[], env: Record<string, string>): Install | undefined {
  const { sub, before, after } = subcommand(words.slice(1), PIP_VALUES);
  const rebuilt = [words[0] ?? "pipx", ...before, ...after];
  if (sub === "install") return pythonInstall(rebuilt, env, { mode: "add" });
  if (sub === "run") return pythonInstall(rebuilt, env, { mode: "exec" });
  if (sub === "inject") return pythonInstall(rebuilt, env, { mode: "inject" });
  return undefined;
}

// cargo

const CARGO_VALUES = set(
  "-F",
  "--features",
  "--rename",
  "-p",
  "--package",
  "--manifest-path",
  "--registry",
  "--index",
  "--target",
  "--target-dir",
  "--git",
  "--branch",
  "--tag",
  "--rev",
  "--path",
  "--root",
  "--version",
  "--vers",
  "--bin",
  "--example",
  "--profile",
  "-j",
  "--jobs",
  "--config",
  "-Z",
  "--color",
  "--message-format",
  "--lockfile-path",
  "--base",
);

function cargoCommand(words: string[], env: Record<string, string>): Install | undefined {
  const rest = words.slice(1).filter((word, i) => !(i === 0 && word.startsWith("+")));
  const { sub, before, after } = subcommand(rest, CARGO_VALUES);
  if (sub !== "add" && sub !== "install") return undefined;
  const install = emptyInstall("cargo", words);
  const { options, args } = scan([...before, ...after], { values: CARGO_VALUES });
  install.registries.push(
    ...values(options, "--registry", "--index"),
    ...envRegistries(env, ["cargo_registry_default"]),
  );
  const git = values(options, "--git")[0];
  const path = values(options, "--path")[0];
  const version = values(options, "--version", "--vers")[0];
  if (git !== undefined || path !== undefined) {
    const host = git === undefined ? undefined : hostOf(git);
    const reason =
      git === undefined ? "installs a local path" : "installs from a git repository, not crates.io";
    for (const arg of args.length > 0 ? args : [git ?? path ?? ""]) {
      install.skipped.push({ arg, reason, ...(host ? { host } : {}) });
    }
    return install;
  }
  for (const arg of args) {
    const spec = cargoSpec(arg);
    if ("skip" in spec) {
      addSpec("cargo", arg, spec, install);
      continue;
    }
    let requirement = spec.spec ?? version;
    // cargo install reads a bare 1.2.3 as exactly that version; cargo add reads it as ^1.2.3.
    if (sub === "install" && requirement !== undefined && /^\d+\.\d+\.\d+/.test(requirement)) {
      requirement = `=${requirement}`;
    }
    addSpec(
      "cargo",
      arg,
      requirement === undefined ? spec : { ...spec, spec: requirement },
      install,
    );
  }
  return install;
}

// go

const GO_VALUES = set(
  "-C",
  "-modfile",
  "-mod",
  "-tags",
  "-ldflags",
  "-gcflags",
  "-asmflags",
  "-buildmode",
  "-compiler",
  "-gccgoflags",
  "-installsuffix",
  "-overlay",
  "-pgo",
  "-pkgdir",
  "-toolexec",
  "-p",
  "-covermode",
  "-coverpkg",
  "-o",
  "-exec",
);

function goCommand(words: string[], env: Record<string, string>): Install | undefined {
  const { sub, before, after } = subcommand(words.slice(1), GO_VALUES);
  if (sub !== "get" && sub !== "install" && sub !== "run") return undefined;
  const install = emptyInstall("go", words);
  if (env.GOPROXY) install.registries.push(...env.GOPROXY.split(/[,|]/).filter((e) => e !== ""));
  for (const key of ["GOPRIVATE", "GONOPROXY"]) {
    const value = env[key];
    if (value) install.privatePatterns.push(...value.split(",").filter((p) => p !== ""));
  }
  const { args } = scan([...before, ...after], {
    values: GO_VALUES,
    go: true,
    stopAtArg: sub === "run",
  });
  for (const arg of args) {
    const spec = goSpec(arg);
    if (spec && !("skip" in spec) && spec.spec === undefined && sub !== "get") {
      // go install and go run without a version build what go.mod already requires.
      if (sub === "install") {
        install.skipped.push({
          arg,
          reason: "has no @version, so it builds the version go.mod requires",
        });
      }
      continue;
    }
    addSpec("go", arg, spec, install);
  }
  return install;
}

/** The install a simple command makes, if its tool is a package manager. */
export function managerOf(words: string[], env: Record<string, string>): Install | undefined {
  const install = dispatch(words, env);
  if (install) {
    install.manager = toolName(words[0] ?? "");
    install.command = words.join(" ");
  }
  return install;
}

function dispatch(words: string[], env: Record<string, string>): Install | undefined {
  const tool = toolName(words[0] ?? "");
  switch (tool) {
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
      return nodeCommand(tool, words, env);
    case "npx":
    case "bunx":
      return nodeInstall(tool === "npx" ? "npm" : "bun", "exec", words, env);
    case "pnpx":
      return nodeInstall("pnpm", "exec", words, env);
    case "uv":
      return uvCommand(words, env);
    case "uvx":
      return pythonInstall(words, env, { mode: "exec", at: true });
    case "poetry":
      return poetryCommand(words, env);
    case "pipx":
      return pipxCommand(words, env);
    case "cargo":
      return cargoCommand(words, env);
    case "go":
      return goCommand(words, env);
  }
  if (PIP.test(tool)) return pipCommand(words, env);
  if (PYTHON.test(tool)) {
    const module = pythonModule(words);
    if (module?.[0] === "pip") return pipCommand([words[0] ?? "python", ...module.slice(1)], env);
  }
  return undefined;
}
