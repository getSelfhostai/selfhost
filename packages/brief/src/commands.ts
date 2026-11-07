import { compare } from "@selfhost/pr";
import type { EventSource, LedgerEvent } from "@selfhost/schema";
import type { BriefCommand, CommandResult } from "./types.js";

/** Test runners called directly: `vitest run`, `pytest -q`, `./node_modules/.bin/jest`. */
const RUNNERS: ReadonlySet<string> = new Set([
  "vitest",
  "jest",
  "mocha",
  "ava",
  "jasmine",
  "karma",
  "uvu",
  "pytest",
  "py.test",
  "tox",
  "nox",
  "nosetests",
  "unittest",
  "rspec",
  "phpunit",
  "pest",
  "ctest",
]);

/** Tools whose first word after the flags must name tests: `go test`, `cargo nextest`. */
const SUBCOMMANDS: Record<string, RegExp> = {
  go: /^test$/,
  cargo: /^(?:test|nextest)$/,
  deno: /^test$/,
  dotnet: /^test$/,
  swift: /^test$/,
  mix: /^test$/,
  playwright: /^test$/,
  cypress: /^run$/,
  bazel: /^test$/,
};

/** Tools that take several targets in any order: `make -C api test`, `turbo run test`. */
const TARGETS: Record<string, RegExp> = {
  turbo: /^test$/,
  nx: /^test$/,
  make: /^(?:test|tests|check)$/,
  rake: /^(?:test|spec)$/,
  mvn: /^(?:test|verify|integration-test)$/,
  mvnw: /^(?:test|verify|integration-test)$/,
  gradle: /^(?:test|check|\w+Test)$/,
  gradlew: /^(?:test|check|\w+Test)$/,
};

const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "bun"]);

/** Wrappers that run the command after them: `npx vitest`, `time go test`, `env CI=1 jest`. */
const WRAPPERS: ReadonlySet<string> = new Set([
  "npx",
  "pnpx",
  "bunx",
  "exec",
  "time",
  "env",
  "nice",
  "sudo",
  "command",
]);

/** Wrappers with a run subcommand: `uv run pytest`, `bundle exec rspec`. */
const RUN_WRAPPERS: Record<string, string> = {
  uv: "run",
  poetry: "run",
  pipenv: "run",
  hatch: "run",
  pdm: "run",
  rye: "run",
  bundle: "exec",
};

const base = (token: string) => token.slice(token.lastIndexOf("/") + 1);
const isFlag = (token: string) => token.startsWith("-");
const isAssignment = (token: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);

function runsTests(tokens: string[]): boolean {
  let i = 0;
  for (;;) {
    while (i < tokens.length && (isAssignment(tokens[i] ?? "") || isFlag(tokens[i] ?? ""))) i++;
    const name = base(tokens[i] ?? "");
    if (WRAPPERS.has(name)) {
      i++;
    } else if (RUN_WRAPPERS[name] !== undefined && tokens[i + 1] === RUN_WRAPPERS[name]) {
      i += 2;
    } else if (/^python(?:3(?:\.\d+)?)?$/.test(name)) {
      const module = tokens.indexOf("-m", i);
      if (module !== -1) {
        i = module + 1;
        continue;
      }
      // Django: python manage.py test
      const words = tokens.slice(i + 1).filter((token) => !isFlag(token));
      return base(words[0] ?? "") === "manage.py" && words[1] === "test";
    } else {
      break;
    }
  }
  const name = base(tokens[i] ?? "");
  const rest = tokens.slice(i + 1);
  const words = rest.filter((token) => !isFlag(token));
  if (RUNNERS.has(name)) return true;
  if (PACKAGE_MANAGERS.has(name)) {
    const [first] = words;
    if (first === "exec" || first === "dlx" || first === "x") {
      return runsTests(rest.slice(rest.indexOf(first) + 1));
    }
    if (first !== undefined && RUNNERS.has(first)) return true;
    return rest.some(
      (token, j) =>
        token === "test" ||
        (name === "npm" && token === "t") ||
        ((rest[j - 1] === "run" || rest[j - 1] === "run-script") && /^test(?:$|[:_-])/.test(token)),
    );
  }
  const subcommand = SUBCOMMANDS[name];
  if (subcommand) return words[0] !== undefined && subcommand.test(words[0]);
  const target = TARGETS[name];
  return target !== undefined && words.some((word) => target.test(word));
}

/** true when a shell command runs tests with one of the common runners. */
export function isTestCommand(command: string): boolean {
  return command
    .split(/&&|\|\||[;|&]/)
    .map((segment) => segment.trim().replace(/^\(+/, "").replace(/\)+$/, "").split(/\s+/))
    .some((tokens) => tokens.length > 0 && tokens[0] !== "" && runsTests(tokens));
}

/**
 * Sources of tool calls in order of preference when more than one recorded a session: hooks
 * first, as their results carry the call's id.
 */
const TOOL_SOURCE_PREFERENCE: readonly EventSource[] = [
  "hook",
  "local_log",
  "otel",
  "sdk",
  "gateway",
  "vendor_api",
];

const rank = (source: string) => {
  const index = (TOOL_SOURCE_PREFERENCE as readonly string[]).indexOf(source);
  return index === -1 ? TOOL_SOURCE_PREFERENCE.length : index;
};

/** tool.called events of one source per session, so a call two sources recorded counts once. */
export function oneToolSourcePerSession(events: LedgerEvent[]): LedgerEvent[] {
  const chosen = new Map<string, string>();
  const calls = events.filter((event) => event.kind === "tool.called");
  for (const event of calls) {
    const session = event.session_id ?? "";
    const current = chosen.get(session);
    if (
      current === undefined ||
      rank(event.source) < rank(current) ||
      (rank(event.source) === rank(current) && event.source < current)
    ) {
      chosen.set(session, event.source);
    }
  }
  return calls.filter((event) => chosen.get(event.session_id ?? "") === event.source);
}

const OUTCOME_ORDER: Record<CommandResult, number> = {
  failed: 3,
  passed: 2,
  unknown: 1,
  no_result: 0,
};

/** What a tool.result says: exit code, success flag or error, else unknown. */
function outcome(event: LedgerEvent): { result: CommandResult; error?: string } {
  const data = event.data ?? {};
  const error = typeof data.error === "string" && data.error !== "" ? data.error : undefined;
  if (typeof data.exit_code === "number") {
    return data.exit_code === 0
      ? { result: "passed" }
      : { result: "failed", ...(error ? { error } : {}) };
  }
  if (data.success === true && !error) return { result: "passed" };
  if (data.success === false || error) return { result: "failed", ...(error ? { error } : {}) };
  return { result: "unknown" };
}

const summaryOf = (event: LedgerEvent) => event.tool?.input_summary ?? event.target?.value ?? "";
const toolUseId = (event: LedgerEvent) =>
  typeof event.data?.tool_use_id === "string" ? event.data.tool_use_id : undefined;

interface Entry {
  event: LedgerEvent;
  results: LedgerEvent[];
}

/**
 * The shell commands a run made, oldest first, each with its recorded result. A tool.result is
 * matched to its call by the call id when both carry it, else to the earliest call in the same
 * session with the same tool and input that it does not follow from that source yet. A result
 * no call matches (OpenTelemetry records results only) stands for its own call.
 */
export function commandsRun(events: LedgerEvent[]): BriefCommand[] {
  const entries: Entry[] = oneToolSourcePerSession(events).map((event) => ({
    event,
    results: [],
  }));
  const byId = new Map<string, Entry>();
  for (const entry of entries) {
    const id = toolUseId(entry.event);
    if (id !== undefined) byId.set(`${entry.event.session_id ?? ""}\n${id}`, entry);
  }
  const standalone: Entry[] = [];
  const results = events
    .filter((event) => event.kind === "tool.result")
    .sort((a, b) => compare(a.ts, b.ts) || compare(a.id, b.id));
  for (const result of results) {
    const id = toolUseId(result);
    let entry = id === undefined ? undefined : byId.get(`${result.session_id ?? ""}\n${id}`);
    entry ??= entries.find(
      (candidate) =>
        candidate.event.session_id === result.session_id &&
        candidate.event.tool?.name === result.tool?.name &&
        summaryOf(candidate.event) === summaryOf(result) &&
        candidate.event.ts <= result.ts &&
        !candidate.results.some((r) => r.source === result.source),
    );
    if (entry) entry.results.push(result);
    else standalone.push({ event: result, results: [result] });
  }
  return [...entries, ...standalone]
    .filter((entry) => entry.event.target?.type === "command")
    .sort((a, b) => compare(a.event.ts, b.event.ts) || compare(a.event.id, b.event.id))
    .map(({ event, results: recorded }) => {
      let best: { result: CommandResult; error?: string } = { result: "no_result" };
      for (const result of recorded) {
        const next = outcome(result);
        if (OUTCOME_ORDER[next.result] > OUTCOME_ORDER[best.result]) best = next;
      }
      const command = event.target?.value ?? "";
      return {
        command,
        tool: event.tool?.name ?? "",
        session: event.session_id ?? "",
        ts: event.ts,
        result: best.result,
        ...(best.error ? { error: best.error } : {}),
        test: isTestCommand(command),
      };
    });
}
