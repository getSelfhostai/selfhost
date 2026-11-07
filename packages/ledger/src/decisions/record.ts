import { randomUUID } from "node:crypto";
import {
  type CreateDecisionRequest,
  CreateDecisionRequestSchema,
  createValidator,
  type Decision,
  type DecisionSurface,
  EVENT_SCHEMA,
  type EventSource,
  type FieldError,
  type LedgerEvent,
} from "@selfhost/schema";
import type { Ledger } from "../ledger.js";
import { stableEventId } from "../sources/common.js";
import { normalizeDecisionPath } from "./store.js";

/** What recordDecision needs: the ledger's append (and its redaction) and a decision lookup. */
export type DecisionWriter = Pick<Ledger, "append" | "decisions">;

export interface RecordDecisionOptions {
  /** Ingest path on the event. Default: github for the GitHub surfaces, else server. */
  source?: EventSource;
  /** Time of the decision when the input has no ts. Default: the current time. */
  now?: Date;
}

export interface RecordedDecision {
  /** The decision.recorded event as the ledger stored it. */
  event: LedgerEvent;
  /** true when this action was already recorded, so nothing new was written. */
  duplicate: boolean;
}

/** Thrown when a decision is invalid. Nothing was written. */
export class DecisionInputError extends Error {
  override name = "DecisionInputError";
  readonly errors: FieldError[];

  constructor(errors: FieldError[]) {
    const first = errors[0];
    super(first ? `${first.field}: ${first.message}` : "Invalid decision");
    this.errors = errors;
  }
}

const inputValidator = createValidator(CreateDecisionRequestSchema);

const GITHUB_SURFACES: ReadonlySet<DecisionSurface> = new Set(["github_review", "github_comment"]);

/** Files and folders a decision or rule verdict is about: its file target and data.paths. */
export function decisionPaths(event: LedgerEvent): string[] {
  const paths = event.target?.type === "file" ? [event.target.value] : [];
  const listed = event.data?.paths;
  if (Array.isArray(listed)) {
    for (const path of listed) if (typeof path === "string") paths.push(path);
  }
  return [...new Set(paths)];
}

const question = (event: LedgerEvent) =>
  typeof event.data?.question === "string" ? event.data.question : undefined;

const nonBlank = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/** The subject fields a correction carries over from the decision it replaces. */
function inherit(input: CreateDecisionRequest, replaced: LedgerEvent | undefined) {
  return {
    item_id: input.item_id ?? replaced?.decision?.item_id ?? replaced?.links?.item_id,
    run_id: input.run_id ?? replaced?.run_id,
    rule_id: input.rule_id ?? replaced?.decision?.rule_id,
    repo: input.repo ?? replaced?.repo,
    question: nonBlank(input.question) ?? (replaced ? question(replaced) : undefined),
    paths: input.paths ?? (replaced ? decisionPaths(replaced) : []),
    pr_url: input.pr_url ?? replaced?.links?.pr_url,
    run_url: input.run_url ?? replaced?.links?.run_url,
    commit_sha: input.commit_sha ?? replaced?.links?.commit_sha,
  };
}

function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Records one human decision as a decision.recorded event: who decided, the item, run, rule or
 * pull request it answers, the verdict, the reason in their own words, the question it
 * answered, the files it is about and links. Every surface calls this, directly or through
 * POST /v1/decisions, so one human action makes exactly one event.
 *
 * Events are never edited. A correction or overturn is a new decision with replaces_event_id;
 * fields it leaves out are carried over from the decision it replaces, so path and topic
 * searches find both. The event goes through ledger.append, so the ledger's retention and
 * redaction apply, and the returned event is read back as stored.
 *
 * With `key`, the id is derived from the surface, the key and `ts`, so the same action sent
 * again (a webhook redelivery, a retried request) stores nothing new and returns the stored
 * decision with duplicate true. Without a key every call records a new decision.
 */
export async function recordDecision(
  writer: DecisionWriter,
  input: CreateDecisionRequest,
  options: RecordDecisionOptions = {},
): Promise<RecordedDecision> {
  const checked = inputValidator.validate(input);
  if (!checked.ok) throw new DecisionInputError(checked.errors);
  const by = input.by.trim();
  const errors: FieldError[] = [];
  if (by === "") errors.push({ field: "by", message: "Expected the person who decided" });
  if (input.key !== undefined && input.ts === undefined) {
    errors.push({
      field: "ts",
      message: "Required with key, so a retry of the same action maps to the same event",
    });
  }
  const paths = (input.paths ?? []).map(normalizeDecisionPath);
  const badPath = paths.findIndex((path) => path === "" || path === ".");
  if (badPath >= 0) {
    errors.push({ field: `paths[${badPath}]`, message: "Expected a file or folder path" });
  }
  if (errors.length > 0) throw new DecisionInputError(errors);

  const replaced = input.replaces_event_id
    ? await writer.decisions.get(input.replaces_event_id)
    : undefined;
  if (input.replaces_event_id && !replaced) {
    throw new DecisionInputError([
      { field: "replaces_event_id", message: "No decision or rule verdict with this id" },
    ]);
  }
  const subject = inherit({ ...input, paths: input.paths && paths }, replaced);
  if (!subject.item_id && !subject.run_id && !subject.rule_id && !subject.pr_url) {
    throw new DecisionInputError([
      {
        field: "item_id",
        message: "Expected item_id, run_id, rule_id or pr_url: what the decision answers",
      },
    ]);
  }

  const surface = input.surface ?? "api";
  const ts = input.ts ?? (options.now ?? new Date()).toISOString();
  const key = input.key === undefined ? randomUUID() : `${surface}\n${input.key}`;
  const id = stableEventId(ts, `decision.recorded\n${key}`);
  const files = [...new Set(subject.paths)].sort();
  const reason = nonBlank(input.reason);
  const name = nonBlank(input.name);
  const decision: Decision = compact({
    verdict: input.verdict,
    by,
    reason,
    rule_id: subject.rule_id,
    item_id: subject.item_id,
    replaces_event_id: input.replaces_event_id,
  }) as Decision;
  const links = compact({
    pr_url: subject.pr_url,
    commit_sha: subject.commit_sha,
    run_url: subject.run_url,
    item_id: subject.item_id,
  });
  const target =
    files.length === 1 && files[0]
      ? { type: "file" as const, value: files[0] }
      : subject.pr_url
        ? { type: "pr" as const, value: subject.pr_url }
        : undefined;
  const event: LedgerEvent = {
    id,
    schema: EVENT_SCHEMA,
    ts,
    source: options.source ?? (GITHUB_SURFACES.has(surface) ? "github" : "server"),
    kind: "decision.recorded",
    actor: { kind: "person", id: by, ...(name ? { name } : {}) },
    ...compact({ repo: subject.repo, run_id: subject.run_id }),
    ...(target ? { target } : {}),
    decision,
    ...(Object.keys(links).length > 0 ? { links } : {}),
    data: compact({
      surface,
      question: subject.question,
      paths: files.length > 1 ? files : undefined,
    }),
  };

  const { accepted } = await writer.append([event]);
  const stored = await writer.decisions.get(id);
  if (!stored) throw new Error(`Decision ${id} was written but cannot be read back`);
  return { event: stored, duplicate: !accepted.includes(id) };
}
