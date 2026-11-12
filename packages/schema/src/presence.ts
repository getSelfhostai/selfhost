import { type Static, Type } from "@sinclair/typebox";
import { FINAL_RUN_STATES, type Schedule } from "./background.js";
import { DateTime, NonEmpty, RepoSlug, StringEnum } from "./common.js";
import { type NamedAgent, PRESENCE_IDLE_MINUTES_DEFAULT, type PresenceConfig } from "./config.js";
import { type Actor, ActorSchema, AgentRefSchema, type LedgerEvent } from "./event.js";
import { currentOwner } from "./handoff.js";
import { createValidator, type ValidationResult } from "./validate.js";

/**
 * Run ownership (F50) and presence (F53): who owns each run, and which people and agents are
 * working on which repos, branches and files right now. Both are derived from the ledger's
 * events; nothing new is captured for them beyond the branch a hook saw.
 */

export const PRESENCE_SCHEMA = "selfhost.presence/v1";

/** actor.id of an event a named agent ([agents.<name>]) wrote: agent:<name>. */
export const NAMED_AGENT_ACTOR_PREFIX = "agent:";

/**
 * data.alert of the alert.raised event the team server writes for each owner of runs that edit
 * the same file: the review list turns it into an overlap item for that owner.
 */
export const EDIT_OVERLAP_ALERT = "edit_overlap";

/** The variable a named agent's hooks run with, holding its name. */
export const NAMED_AGENT_ENV = "SELFHOST_AGENT_NAME";

/** The actor of a named agent's events. */
export const namedAgentActor = (name: string): Actor => ({
  kind: "agent",
  id: `${NAMED_AGENT_ACTOR_PREFIX}${name}`,
  name,
});

/** The named agent an actor is, or undefined for a person, system or unnamed agent. */
export function namedAgentOf(actor: Pick<Actor, "kind" | "id">): string | undefined {
  if (actor.kind !== "agent" || !actor.id.startsWith(NAMED_AGENT_ACTOR_PREFIX)) return undefined;
  const name = actor.id.slice(NAMED_AGENT_ACTOR_PREFIX.length);
  return name === "" ? undefined : name;
}

/** Where a run's owner came from, in the order they are tried. */
export const RUN_OWNER_SOURCES = [
  "handoff",
  "named_agent",
  "person",
  "trigger",
  "schedule",
  "fallback",
] as const;
export type RunOwnerSource = (typeof RUN_OWNER_SOURCES)[number];

/** What ownership reads from selfhost.toml. */
export interface OwnershipConfig {
  agents?: Record<string, NamedAgent>;
  background?: { schedules?: readonly Pick<Schedule, "name" | "owner">[] };
  review?: { fallback?: readonly string[] };
}

export interface RunOwnership {
  /** The one human who answers for the run, or null when selfhost.toml names nobody for it. */
  owner: string | null;
  via: RunOwnerSource | null;
  /** The named agent behind the run, when one wrote its events. */
  named_agent: string | null;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);

/**
 * The run's human owner. The new owner of its newest handoff; else the owner of the named agent
 * that wrote it ([agents.<name>] owner); else the first person who acted in it; else the person
 * whose trigger started it, or for a schedule the schedule's owner; else the first person in
 * [review] fallback. A background run started by a person has them as its events' actor.
 */
export function runOwnership(
  events: readonly LedgerEvent[],
  config?: OwnershipConfig,
): RunOwnership {
  const sorted = [...events].sort(
    (a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a.id.localeCompare(b.id),
  );
  const named = sorted.map((e) => namedAgentOf(e.actor)).find((name) => name !== undefined);
  const result = (owner: string | null, via: RunOwnerSource | null): RunOwnership => ({
    owner,
    via: owner === null ? null : via,
    named_agent: named ?? null,
  });
  const handedTo = currentOwner(sorted, null);
  if (handedTo) return result(handedTo, "handoff");
  const agentOwner = named ? config?.agents?.[named]?.owner : undefined;
  if (agentOwner) return result(agentOwner, "named_agent");
  const person = sorted.find((e) => e.actor.kind === "person")?.actor.id;
  if (person) return result(person, "person");
  for (const event of sorted) {
    if (event.kind !== "run.triggered") continue;
    const trigger = isObject(event.data?.trigger) ? event.data.trigger : {};
    const triggeredBy = text(trigger.person);
    if (triggeredBy) return result(triggeredBy, "trigger");
    if (trigger.source === "schedule") {
      const schedule = config?.background?.schedules?.find((s) => s.name === trigger.sender);
      if (schedule?.owner) return result(schedule.owner, "schedule");
    }
  }
  const fallback = config?.review?.fallback?.[0];
  return result(fallback ?? null, "fallback");
}

/** Tools that write or patch files, across the agents selfhost maps. */
export const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "apply_patch",
  "Delete",
  "create",
  "edit",
  "write",
  "patch",
]);

/** The files a tool.called event edits: its file target, or each file of a Codex patch. */
export function editedFiles(event: LedgerEvent): string[] {
  if (event.kind !== "tool.called" || !event.tool || !EDIT_TOOLS.has(event.tool.name)) return [];
  if (event.target?.type === "file") return [event.target.value];
  const summary = event.tool.input_summary;
  if (!summary || event.tool.name !== "apply_patch") return [];
  return summary
    .split(", ")
    .map((part) => /^[AMD] (.+)$/.exec(part)?.[1]?.trim())
    .filter((path): path is string => path !== undefined && path !== "" && !path.endsWith("..."));
}

/** The git branch an event names: a hook's data.branch, a background run's or a handoff's. */
export function branchOf(event: LedgerEvent): string | undefined {
  const data = event.data ?? {};
  const run = isObject(data.background_run) ? data.background_run : {};
  return text(data.branch) ?? text(run.branch) ?? text(data.git_branch);
}

/** [presence] idle_minutes with its default. */
export const presenceIdleMinutes = (config?: { presence?: PresenceConfig }) =>
  config?.presence?.idle_minutes ?? PRESENCE_IDLE_MINUTES_DEFAULT;

/** Most edited files listed for one run, newest first. */
export const PRESENCE_FILES_MAX = 20;

const NullableText = (description: string) =>
  Type.Union([Type.String(), Type.Null()], { description });

export const PresenceQuerySchema = Type.Object(
  {
    team: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Only this team. Default: every team you can read.",
      }),
    ),
    repo: Type.Optional(RepoSlug({ description: "Only runs in this repository, as owner/name." })),
    idle_minutes: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 1440,
        description:
          "A run with no event for this long no longer counts as active. Default: the team's [presence] idle_minutes, else 30.",
      }),
    ),
  },
  { additionalProperties: false, title: "PresenceQuery" },
);

export const PresenceRunSchema = Type.Object(
  {
    id: NonEmpty({
      description: "The run: the agent's session id, or the background run's id.",
    }),
    kind: StringEnum(["session", "background"] as const, {
      description: "session for an agent session, background for a background run.",
    }),
    actor: ActorSchema,
    person: NullableText("The person working in the run, or null for an agent alone."),
    named_agent: NullableText("The [agents.<name>] that wrote the run, or null."),
    owner: NullableText(
      "The one human who answers for the run (see owner_via), or null when selfhost.toml names nobody.",
    ),
    owner_via: Type.Union([StringEnum(RUN_OWNER_SOURCES), Type.Null()], {
      description:
        "Where the owner came from: handoff, named_agent ([agents.<name>] owner), person (who acted in it), trigger (who started a background run), schedule (the schedule's owner) or fallback ([review] fallback).",
    }),
    agent: Type.Union([AgentRefSchema, Type.Null()], { description: "The coding agent, or null." }),
    model: NullableText("The newest model the run used, or null."),
    team: NullableText("The team the run belongs to, or null on a laptop."),
    repo: NullableText("Repository as owner/name, or null when not known."),
    branch: NullableText("The git branch the run is on, or null when not known."),
    files: Type.Array(Type.String(), {
      description: `Files the run edited while active, newest first, at most ${PRESENCE_FILES_MAX}.`,
    }),
    edits: Type.Integer({ minimum: 0, description: "Edit calls the run made while active." }),
    pr_url: NullableText("The pull request the run opened or pushed to, or null."),
    started_at: DateTime({ description: "The run's first event." }),
    last_event_at: DateTime({ description: "The run's newest event." }),
  },
  { additionalProperties: false, title: "PresenceRun" },
);

export const PresenceOverlapSchema = Type.Object(
  {
    repo: RepoSlug({ description: "Repository as owner/name." }),
    file: NonEmpty({ description: "The file more than one active run edited." }),
    runs: Type.Array(NonEmpty(), {
      minItems: 2,
      description: "The runs that edited it, the first to edit it first.",
    }),
    owners: Type.Array(NonEmpty(), { description: "The owners of those runs, each once." }),
    since: DateTime({ description: "When a second run first edited it." }),
  },
  { additionalProperties: false, title: "PresenceOverlap" },
);

export const PresenceResponseSchema = Type.Object(
  {
    schema: Type.Literal(PRESENCE_SCHEMA),
    at: DateTime({ description: "When the answer was worked out." }),
    idle_minutes: Type.Integer({
      minimum: 1,
      description: "The idle window: a run with no event for this long is not listed.",
    }),
    runs: Type.Array(PresenceRunSchema, {
      description:
        "Runs active right now, by repo, then branch, then newest event first. Only teams the caller can read are included.",
    }),
    overlaps: Type.Array(PresenceOverlapSchema, {
      description:
        "Files that two or more active runs in the same repo have edited, oldest first. Each run's owner is warned.",
    }),
  },
  { additionalProperties: false, title: "PresenceResponse" },
);

export type PresenceQuery = Static<typeof PresenceQuerySchema>;
export type PresenceRun = Static<typeof PresenceRunSchema>;
export type PresenceOverlap = Static<typeof PresenceOverlapSchema>;
export type PresenceResponse = Static<typeof PresenceResponseSchema>;

const presenceValidator = createValidator(PresenceResponseSchema);

export function validatePresenceResponse(value: unknown): ValidationResult<PresenceResponse> {
  return presenceValidator.validate(value);
}

/** One candidate run for presence, as the ledger read it. */
export interface PresenceInput {
  id: string;
  kind: PresenceRun["kind"];
  /** Its events inside the idle window. */
  events: readonly LedgerEvent[];
  /** Its handoffs and run.triggered events from any time, for the owner. */
  history?: readonly LedgerEvent[];
  /** Its first event, from any time. Default: its oldest event in `events`. */
  started_at?: string;
  team: string | null;
  config?: OwnershipConfig;
}

const byTime = (a: LedgerEvent, b: LedgerEvent) =>
  Date.parse(a.ts) - Date.parse(b.ts) || a.id.localeCompare(b.id);

/** Whether the run is over: its session ended, or its background run reached a final state. */
function ended(input: PresenceInput, sorted: readonly LedgerEvent[]): boolean {
  if (input.kind === "session") return sorted.some((e) => e.kind === "session.ended");
  const updates = sorted.filter((e) => e.kind === "run.updated");
  const state = updates.at(-1)?.data?.background_run;
  return (
    isObject(state) &&
    (FINAL_RUN_STATES as readonly unknown[]).includes((state as Record<string, unknown>).state)
  );
}

/**
 * A run as presence lists it, or undefined when it is not active: it ended, or its newest event
 * is `idleMs` or more before `now`.
 */
export function presenceRun(
  input: PresenceInput,
  now: Date,
  idleMs: number,
): PresenceRun | undefined {
  const sorted = [...input.events].sort(byTime);
  const last = sorted.at(-1);
  if (!last || Date.parse(last.ts) <= now.getTime() - idleMs || ended(input, sorted)) {
    return undefined;
  }
  const ownership = runOwnership([...(input.history ?? []), ...sorted], input.config);
  const newest = <T>(pick: (e: LedgerEvent) => T | undefined): T | undefined => {
    for (let i = sorted.length - 1; i >= 0; i--) {
      const value = pick(sorted[i] as LedgerEvent);
      if (value !== undefined) return value;
    }
    return undefined;
  };
  const files: string[] = [];
  let edits = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const edited = editedFiles(sorted[i] as LedgerEvent);
    if (edited.length > 0) edits += 1;
    for (const file of edited) if (!files.includes(file)) files.push(file);
  }
  const person = sorted.find((e) => e.actor.kind === "person")?.actor.id ?? null;
  const named = ownership.named_agent;
  const worker =
    sorted.find((e) => namedAgentOf(e.actor) !== undefined)?.actor ??
    sorted.find((e) => e.actor.kind === "person")?.actor ??
    sorted.find((e) => e.actor.kind === "agent")?.actor ??
    last.actor;
  const agent =
    sorted.find((e) => e.agent && e.agent.vendor !== "other")?.agent ??
    sorted.find((e) => e.agent)?.agent;
  const firstAt = sorted[0]?.ts ?? last.ts;
  return {
    id: input.id,
    kind: input.kind,
    actor: { ...worker },
    person: named ? null : person,
    named_agent: named,
    owner: ownership.owner,
    owner_via: ownership.via,
    agent: agent ? { ...agent } : null,
    model: newest((e) => e.model) ?? null,
    team: input.team,
    repo: newest((e) => e.repo) ?? null,
    branch: newest(branchOf) ?? null,
    files: files.slice(0, PRESENCE_FILES_MAX),
    edits,
    pr_url: newest((e) => e.links?.pr_url) ?? null,
    started_at:
      input.started_at && Date.parse(input.started_at) < Date.parse(firstAt)
        ? new Date(Date.parse(input.started_at)).toISOString()
        : new Date(Date.parse(firstAt)).toISOString(),
    last_event_at: new Date(Date.parse(last.ts)).toISOString(),
  };
}

/**
 * Files two or more active runs in the same repo edited, with when a second run first touched
 * each. Paths are compared as the runs recorded them, relative to the repository root.
 */
export function presenceOverlaps(
  runs: readonly PresenceRun[],
  inputs: readonly Pick<PresenceInput, "id" | "events">[],
): PresenceOverlap[] {
  const active = new Map(runs.map((run) => [run.id, run]));
  // repo, then file, then run id to the first time that run edited it.
  const touched = new Map<string, Map<string, Map<string, number>>>();
  for (const input of inputs) {
    const run = active.get(input.id);
    if (!run?.repo) continue;
    const files = touched.get(run.repo) ?? new Map<string, Map<string, number>>();
    touched.set(run.repo, files);
    for (const event of input.events) {
      for (const file of editedFiles(event)) {
        const byRun = files.get(file) ?? new Map<string, number>();
        files.set(file, byRun);
        const at = Date.parse(event.ts);
        if (!byRun.has(run.id) || at < (byRun.get(run.id) ?? at)) byRun.set(run.id, at);
      }
    }
  }
  const overlaps: PresenceOverlap[] = [];
  for (const [repo, files] of touched) {
    for (const [file, byRun] of files) {
      if (byRun.size < 2) continue;
      const order = [...byRun].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
      const owners = [
        ...new Set(
          order.flatMap(([id]) => (active.get(id)?.owner ? [active.get(id)?.owner as string] : [])),
        ),
      ];
      overlaps.push({
        repo,
        file,
        runs: order.map(([id]) => id),
        owners,
        since: new Date(order[1]?.[1] ?? 0).toISOString(),
      });
    }
  }
  return overlaps.sort(
    (a, b) =>
      Date.parse(a.since) - Date.parse(b.since) ||
      a.repo.localeCompare(b.repo) ||
      a.file.localeCompare(b.file),
  );
}

/** Active runs by repo (unknown last), then branch, then newest event first. */
export function sortPresenceRuns(runs: readonly PresenceRun[]): PresenceRun[] {
  const key = (value: string | null) => value ?? "￿";
  return [...runs].sort(
    (a, b) =>
      key(a.repo).localeCompare(key(b.repo)) ||
      key(a.branch).localeCompare(key(b.branch)) ||
      Date.parse(b.last_event_at) - Date.parse(a.last_event_at) ||
      a.id.localeCompare(b.id),
  );
}

/** Presence from candidate runs: the active ones, sorted, and where they overlap. */
export function derivePresence(
  inputs: readonly PresenceInput[],
  options: { now: Date; idleMinutes: number },
): PresenceResponse {
  const idleMs = options.idleMinutes * 60_000;
  const runs = sortPresenceRuns(
    inputs.flatMap((input) => {
      const run = presenceRun(input, options.now, idleMs);
      return run ? [run] : [];
    }),
  );
  return {
    schema: PRESENCE_SCHEMA,
    at: options.now.toISOString(),
    idle_minutes: options.idleMinutes,
    runs,
    overlaps: presenceOverlaps(runs, inputs),
  };
}
