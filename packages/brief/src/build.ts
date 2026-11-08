import { posix } from "node:path";
import { globMatches } from "@selfhost/policy";
import {
  type ChangedFile,
  compare,
  firstChangedLine,
  runGuardrails,
  type TestChangeKind,
  testChanges,
} from "@selfhost/pr";
import { type LedgerEvent, PACKAGE_RULE_IDS } from "@selfhost/schema";
import { oneSourcePerSession } from "@selfhost/spend";
import { tracerRunUrl } from "@selfhost/traces";
import { commandsRun, oneToolSourcePerSession } from "./commands.js";
import { lineUrl, traceCommand, traceUrl } from "./links.js";
import {
  BRIEF_SCHEMA,
  type Brief,
  type BriefBlock,
  type BriefCost,
  type BriefFile,
  type BriefInputs,
  type BriefPlan,
  type BriefSection,
  type BriefTask,
  type BriefTraceSession,
  type RiskyKind,
  type RiskyLine,
} from "./types.js";

/** Tools agents use to write down or update their plan. */
const PLAN_TOOLS: ReadonlySet<string> = new Set(["TodoWrite", "update_plan", "ExitPlanMode"]);

const MAX_TITLE = 300;
const MAX_DESCRIPTION = 500;
const MAX_PROMPT = 600;
const MAX_STEP = 200;

/** At most `max` characters, cut at the end with an ellipsis. */
export function clip(text: string, max: number): string {
  const value = text.trim();
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

/** The description's first paragraph that is not a heading, without HTML comments. */
function firstParagraph(body: string): string | undefined {
  const paragraphs = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "" && !/^#{1,6}\s/.test(paragraph));
  return paragraphs[0] === undefined ? undefined : clip(paragraphs[0], MAX_DESCRIPTION);
}

const PLAN_HEADING =
  /^\s{0,3}(?:#{1,6}\s*|\*\*|__)?\s*(?:the\s+)?plan\s*:?\s*(?:\*\*|__)?\s*:?\s*$/i;
const ANY_HEADING = /^\s{0,3}(?:#{1,6}\s|(?:\*\*|__)[^*_]+(?:\*\*|__)\s*:?\s*$)/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/;

/** List items under a "Plan" heading in the description, up to the next heading. */
function planSteps(body: string): string[] {
  const lines = body.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/);
  const start = lines.findIndex((line) => PLAN_HEADING.test(line));
  if (start === -1) return [];
  const steps: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (ANY_HEADING.test(line)) break;
    const item = LIST_ITEM.exec(line)?.[1];
    if (item) steps.push(clip(item, MAX_STEP));
  }
  return steps;
}

const normalized = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The added manifest line that names a new dependency. */
function dependencyLine(file: ChangedFile | undefined, name: string): number | undefined {
  if (!file?.hunks) return undefined;
  const manifest = posix.basename(file.path);
  const quoted = new RegExp(`"${escapeRegExp(name)}"\\s*:`);
  const goModule = new RegExp(`(?:^|\\s)${escapeRegExp(name)}\\s+v`);
  const cargo = new RegExp(
    `^\\s*(?:${escapeRegExp(name)}(?:\\.[\\w-]+)?\\s*=|\\[(?:.*\\.)?dependencies\\.${escapeRegExp(name)}\\])`,
  );
  const matches = (text: string) => {
    if (manifest === "package.json") return quoted.test(text);
    if (manifest === "go.mod") return goModule.test(text);
    if (manifest === "Cargo.toml") return cargo.test(text);
    const requirement = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(text)?.[1];
    return requirement !== undefined && normalized(requirement) === normalized(name);
  };
  for (const hunk of file.hunks) {
    const line = hunk.added.find((added) => matches(added.text));
    if (line) return line.line;
  }
  return undefined;
}

const RISKY_ORDER: Record<RiskyKind, number> = {
  protected_path: 0,
  new_dependency: 1,
  deleted_test_file: 2,
  deleted_test: 3,
  skipped_test: 4,
};

const TEST_SIDE: Record<TestChangeKind, "new" | "old"> = {
  deleted_test_file: "old",
  deleted_test: "old",
  skipped_test: "new",
};

function costOf(events: LedgerEvent[]): BriefCost | undefined {
  const costs = oneSourcePerSession(events).filter(
    (event) => event.kind === "cost.recorded" && event.cost,
  );
  if (costs.length === 0) return undefined;
  let usd = 0;
  let tokens = 0;
  let estimated = 0;
  for (const { cost } of costs) {
    if (!cost) continue;
    usd += cost.usd;
    tokens +=
      cost.input_tokens + cost.output_tokens + cost.cache_read_tokens + cost.cache_write_tokens;
    if (cost.estimated) estimated += 1;
  }
  const sessions = new Set(costs.map((event) => event.session_id ?? ""));
  const models = [...new Set(costs.flatMap((event) => (event.model ? [event.model] : [])))];
  return {
    usd: Math.round(usd * 1e6) / 1e6,
    estimated: estimated === 0 ? "none" : estimated === costs.length ? "all" : "some",
    requests: costs.length,
    tokens,
    sessions: sessions.size,
    models: models.sort(compare),
  };
}

/**
 * Block and ask verdicts, once per rule and action, oldest first, and the package installs the
 * package guard could not check. Those went ahead (it fails open), so they are not blocks.
 */
function blockedActions(events: LedgerEvent[]): { blocked: BriefBlock[]; unchecked: number } {
  // Newest first, so a hit recorded again after a policy change keeps its latest record.
  const hits = runGuardrails([...events].reverse());
  const seen = new Map<string, BriefBlock>();
  const unchecked = new Set<string>();
  for (const hit of hits) {
    const { event } = hit;
    if (hit.rule_id === PACKAGE_RULE_IDS.unchecked) {
      unchecked.add(event.target?.value ?? event.tool?.input_summary ?? event.id);
      continue;
    }
    const target = event.target?.value ?? event.tool?.input_summary;
    const tool = event.tool?.name;
    const key = [hit.rule_id, hit.verdict, hit.mode, tool ?? "", target ?? ""].join("\n");
    const block: BriefBlock = {
      rule_id: hit.rule_id,
      verdict: hit.verdict,
      mode: hit.mode,
      irreversible: hit.irreversible,
      ...(tool ? { tool } : {}),
      ...(target ? { target } : {}),
      ...(event.decision?.reason ? { reason: clip(event.decision.reason, MAX_STEP) } : {}),
      ...(event.session_id ? { session: event.session_id } : {}),
      ts: event.ts,
    };
    const earlier = seen.get(key);
    if (!earlier || block.ts < earlier.ts) seen.set(key, block);
  }
  return {
    blocked: [...seen.values()].sort(
      (a, b) => compare(a.ts, b.ts) || compare(a.rule_id, b.rule_id),
    ),
    unchecked: unchecked.size,
  };
}

/**
 * Builds the brief from what was read. Pure: the same inputs give the same brief, so it can be
 * snapshot-tested and rebuilt on every run to edit the comment in place.
 */
export function buildBrief(inputs: BriefInputs): Brief {
  const notes: Partial<Record<BriefSection, string[]>> = {};
  const note = (section: BriefSection, text: string) => {
    notes[section] ??= [];
    notes[section].push(text);
  };
  const { run, target } = inputs;
  const events = [...(run?.events ?? [])].sort(
    (a, b) => compare(a.ts, b.ts) || compare(a.id, b.id),
  );
  const noRun = "no agent run was found";
  const runMissing = inputs.runMissing ?? "no commit times to match sessions by";

  const task: BriefTask = {};
  if (inputs.pull) {
    task.title = clip(inputs.pull.title, MAX_TITLE);
    task.titleFrom = "pull_request";
    const description = inputs.pull.body ? firstParagraph(inputs.pull.body) : undefined;
    if (description) task.description = description;
  } else if (inputs.subjects?.[0]) {
    task.title = clip(inputs.subjects[0], MAX_TITLE);
    task.titleFrom = "commit";
  }
  const prompt = events.find(
    (event) =>
      event.kind === "prompt.submitted" &&
      typeof event.data?.prompt === "string" &&
      event.data.prompt.trim() !== "",
  )?.data?.prompt;
  if (typeof prompt === "string") task.prompt = clip(prompt, MAX_PROMPT);
  if (!task.title && !task.prompt) note("task", "No task recorded: no title and no stored prompt.");
  else if (run && !task.prompt) note("task", "The run's prompts were not stored.");

  const calls = oneToolSourcePerSession(events);
  const plan: BriefPlan = {
    steps: inputs.pull?.body ? planSteps(inputs.pull.body) : [],
    updates: calls
      .filter((event) => event.tool && PLAN_TOOLS.has(event.tool.name))
      .map((event) => ({
        tool: event.tool?.name ?? "",
        session: event.session_id ?? "",
        ts: event.ts,
        ...(event.tool?.input_summary ? { summary: clip(event.tool.input_summary, MAX_STEP) } : {}),
      })),
  };
  if (plan.steps.length === 0 && plan.updates.length === 0) {
    note(
      "plan",
      run
        ? "No plan recorded: the description has no Plan section and the run made no plan updates."
        : `No plan recorded: the description has no Plan section, and ${noRun}.`,
    );
  }

  const globFor = (file: ChangedFile) =>
    inputs.highRiskPaths.find(
      (glob) =>
        globMatches(glob, file.path) ||
        (file.previousPath !== undefined && globMatches(glob, file.previousPath)),
    );
  const sorted = [...inputs.files].sort((a, b) => compare(a.path, b.path));
  const files: BriefFile[] = sorted.map((file) => {
    const url = lineUrl(target, file.path, undefined, file.status === "removed" ? "old" : "new");
    return {
      path: file.path,
      ...(file.previousPath ? { previousPath: file.previousPath } : {}),
      status: file.status ?? "modified",
      additions: file.additions,
      deletions: file.deletions,
      protected: globFor(file) !== undefined,
      ...(url ? { url } : {}),
    };
  });
  if (files.length === 0) note("files", "No files changed.");

  const risky: RiskyLine[] = [];
  const add = (line: Omit<RiskyLine, "url">) => {
    const url = lineUrl(target, line.path, line.line, line.side);
    risky.push({ ...line, ...(url ? { url } : {}) });
  };
  const fileSide = (file: ChangedFile) => (file.status === "removed" ? "old" : "new");
  for (const file of sorted) {
    const glob = globFor(file);
    if (glob === undefined) continue;
    const first = file.hunks?.map(firstChangedLine).find((line) => line !== undefined);
    add({
      kind: "protected_path",
      path: file.path,
      ...(first ? { line: first.line.line } : {}),
      side: first?.side ?? fileSide(file),
      detail: glob,
    });
  }
  for (const dependency of inputs.dependencies ?? []) {
    const line = dependencyLine(
      inputs.files.find((file) => file.path === dependency.manifest),
      dependency.name,
    );
    add({
      kind: "new_dependency",
      path: dependency.manifest,
      ...(line !== undefined ? { line } : {}),
      side: "new",
      detail: dependency.name,
    });
  }
  for (const change of testChanges(sorted)) {
    add({
      kind: change.kind,
      path: change.path,
      ...(change.line !== undefined ? { line: change.line } : {}),
      side: TEST_SIDE[change.kind],
      detail: change.detail,
    });
  }
  risky.sort(
    (a, b) =>
      RISKY_ORDER[a.kind] - RISKY_ORDER[b.kind] ||
      compare(a.path, b.path) ||
      (a.line ?? 0) - (b.line ?? 0),
  );
  if (risky.length === 0) {
    note(
      "risky_lines",
      "Nothing flagged: no changes under protected paths, no new dependencies, and no deleted or skipped tests.",
    );
  }
  if (inputs.highRiskPaths.length === 0) {
    note(
      "risky_lines",
      "Protected paths not checked: selfhost.toml has no [review] high_risk_paths.",
    );
  }
  if (!inputs.dependencies) {
    note(
      "risky_lines",
      `New dependencies not checked: ${inputs.dependenciesMissing ?? "the manifests could not be read"}.`,
    );
  }

  const commands = commandsRun(events);
  const tests = commands.filter((command) => command.test);
  if (commands.length === 0) {
    note("commands", run ? "No commands ran in this run." : `No commands known: ${noRun}.`);
  }
  if (tests.length === 0) {
    note("tests", run ? "No tests ran in this run." : `No tests known: ${noRun}.`);
  }

  const { blocked, unchecked } = blockedActions(events);
  if (blocked.length === 0) {
    note("blocked", run ? "No actions were blocked." : `No blocked actions known: ${noRun}.`);
  }
  if (unchecked > 0) {
    note(
      "blocked",
      unchecked === 1
        ? "1 package install could not be checked against its registry in time and went ahead unchecked (packages.unchecked in the trace)."
        : `${unchecked} package installs could not be checked against their registries in time and went ahead unchecked (packages.unchecked in the trace).`,
    );
  }

  const cost = costOf(events);
  if (!cost) note("cost", run ? "No cost recorded for this run." : `No cost known: ${noRun}.`);

  const trace: BriefTraceSession[] = (run?.sessions ?? []).map((id): BriefTraceSession => {
    const own = events.filter((event) => event.session_id === id);
    const agent = own.find((event) => event.agent)?.agent?.vendor;
    const url = traceUrl(inputs.server, id);
    const tracerUrl = inputs.tracer ? tracerRunUrl(inputs.tracer.run_url, id) : undefined;
    return {
      id,
      ...(agent ? { agent } : {}),
      start: own[0]?.ts ?? "",
      end: own[own.length - 1]?.ts ?? "",
      events: own.length,
      ...(url ? { url } : { command: traceCommand(id) }),
      ...(tracerUrl && inputs.tracer ? { tracerUrl, tracer: inputs.tracer.tool } : {}),
    };
  });
  trace.sort((a, b) => compare(a.start, b.start) || compare(a.id, b.id));
  if (trace.length === 0) {
    note("trace", `No trace found: ${run ? "the run has no sessions" : runMissing}.`);
  }

  return {
    schema: BRIEF_SCHEMA,
    target,
    ...(inputs.agent ? { agent: inputs.agent } : {}),
    task,
    plan,
    risky,
    files,
    commands,
    tests,
    blocked,
    ...(cost ? { cost } : {}),
    trace,
    notes,
  };
}
