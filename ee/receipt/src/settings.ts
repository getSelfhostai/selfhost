import type { RedactionPattern, ResolvedSelfhostConfig } from "@selfhost/schema";

/** What the receipt step falls back to when selfhost.toml does not say, such as action inputs. */
export interface ReceiptFallbacks {
  setup?: string;
  start?: string;
  readyUrl?: string;
  testCommand?: string;
}

/** Everything the receipt run needs from selfhost.toml, with the defaults applied. */
export interface ReceiptSettings {
  /** The setup script, from [runtime] setup. */
  setup?: string;
  /** The start command, from [receipt] start, else the default [runtime.run] command. */
  start?: { command: string; cwd: string; from: "receipt" | "runtime" | "fallback" };
  port?: number;
  /** With $SELFHOST_PORT unexpanded. */
  readyUrl: string;
  readyTimeoutMs: number;
  /** [runtime.env], with $NAME references to the SELFHOST_ variables unexpanded. */
  env: Record<string, string>;
  testCommand?: string;
  testGlobs: string[];
  testTimeoutMs: number;
  maxTests: number;
  /** Glob to URL paths. Undefined when selfhost.toml has no [receipt.screens]. */
  screens?: Record<string, string[]>;
  maxScreens: number;
  /** [[redaction]] patterns, masked in every log tail on top of the built-in ones. */
  redaction: RedactionPattern[];
}

export const RECEIPT_DEFAULTS = {
  readyUrl: "http://127.0.0.1:$SELFHOST_PORT/",
  readyTimeoutSeconds: 120,
  testTimeoutSeconds: 600,
  maxTests: 20,
  maxScreens: 10,
} as const;

type RunCommands = NonNullable<NonNullable<ResolvedSelfhostConfig["runtime"]>["run"]>;

/** The run command started when none is named: the one marked default, else the only one. */
export function defaultRunCommand(
  run: RunCommands | undefined,
): { name: string; command: string; cwd?: string } | undefined {
  const entries = Object.entries(run ?? {});
  const found =
    entries.find(([, command]) => command.default === true) ??
    (entries.length === 1 ? entries[0] : undefined);
  if (!found) return undefined;
  const [name, entry] = found;
  return { name, command: entry.command, ...(entry.cwd ? { cwd: entry.cwd } : {}) };
}

/**
 * The receipt settings: [receipt] first, then [runtime] (its setup, default run command and
 * env), then the fallbacks for anything neither sets.
 */
export function receiptSettings(
  config: ResolvedSelfhostConfig | undefined,
  fallbacks: ReceiptFallbacks = {},
): ReceiptSettings {
  const receipt = config?.receipt ?? {};
  const runtime = config?.runtime ?? {};
  const run = defaultRunCommand(runtime.run);
  const start = receipt.start
    ? { command: receipt.start, cwd: receipt.cwd ?? ".", from: "receipt" as const }
    : run
      ? { command: run.command, cwd: receipt.cwd ?? run.cwd ?? ".", from: "runtime" as const }
      : fallbacks.start
        ? { command: fallbacks.start, cwd: receipt.cwd ?? ".", from: "fallback" as const }
        : undefined;
  const setup = runtime.setup ?? fallbacks.setup;
  const testCommand = receipt.test_command ?? fallbacks.testCommand;
  const screens = receipt.screens
    ? Object.fromEntries(
        Object.entries(receipt.screens).map(([glob, paths]) => [
          glob,
          typeof paths === "string" ? [paths] : paths,
        ]),
      )
    : undefined;
  return {
    ...(setup ? { setup } : {}),
    ...(start ? { start } : {}),
    ...(receipt.port ? { port: receipt.port } : {}),
    readyUrl: receipt.ready_url ?? fallbacks.readyUrl ?? RECEIPT_DEFAULTS.readyUrl,
    readyTimeoutMs: (receipt.ready_timeout_seconds ?? RECEIPT_DEFAULTS.readyTimeoutSeconds) * 1000,
    env: { ...(runtime.env ?? {}) },
    ...(testCommand ? { testCommand } : {}),
    testGlobs: receipt.tests ?? [],
    testTimeoutMs: (receipt.test_timeout_seconds ?? RECEIPT_DEFAULTS.testTimeoutSeconds) * 1000,
    maxTests: receipt.max_tests ?? RECEIPT_DEFAULTS.maxTests,
    ...(screens ? { screens } : {}),
    maxScreens: receipt.max_screens ?? RECEIPT_DEFAULTS.maxScreens,
    redaction: config?.redaction ?? [],
  };
}

/**
 * Expands $NAME and ${NAME} from `variables`, as [runtime.env] values may refer to the
 * SELFHOST_ variables. A name that is not in `variables` is left as written, for the shell.
 */
export function expandVariables(value: string, variables: Record<string, string>): string {
  return value.replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (match, braced: string | undefined, bare: string | undefined) => {
      const name = braced ?? bare ?? "";
      return Object.hasOwn(variables, name) ? (variables[name] ?? "") : match;
    },
  );
}
