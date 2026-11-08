import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ReviewItem } from "@selfhost/schema";

/**
 * One-time exceptions: a person allows one blocked tool call, once. Everything the hook needs
 * lives in files under ~/.selfhost/exceptions, so it never opens the ledger:
 *
 * - `key`: 32 random bytes, made on the first block. It keys call fingerprints and signs grants,
 *   so a fingerprint says nothing about the command without it and a grant cannot be written by
 *   hand. guard.secret_read stops agents reading it.
 * - `requests/<id>.json`: written by the hook when it blocks a call. `id` is the review item a
 *   person approves; the file holds the call's fingerprint and rule ids, never the command.
 * - `grants/<id>.json`: written by the CLI once that item is approved: signed, with an expiry.
 * - `used/<id>.json`: a grant after the hook allowed the call with it. The move is the claim, so
 *   two hooks cannot both use one grant, and it stops the grant from being issued again.
 *
 * This module imports no workspace package at run time: `selfhost hook` loads it on blocks.
 */

export const REQUEST_SCHEMA = "selfhost.exception_request/v1";
export const GRANT_SCHEMA = "selfhost.exception_grant/v1";

/** What the hook writes when it blocks a call, and the review item it named. */
export interface ExceptionRequest {
  schema: typeof REQUEST_SCHEMA;
  /** The review item id: what the person approves. */
  id: string;
  /** Keyed hash of the call (see callFingerprint). */
  fingerprint: string;
  /** Rule ids of every enforce hit that stopped the call. */
  rules: string[];
  agent: string;
  requested_at: string;
  /** [review] exception_expiry_minutes of the policy that blocked the call. */
  expiry_minutes: number;
}

/** An approved exception: allows one call with the request's fingerprint until it expires. */
export interface ExceptionGrant {
  schema: typeof GRANT_SCHEMA;
  id: string;
  fingerprint: string;
  rules: string[];
  agent: string;
  approved_by: string;
  decision_event_id: string;
  approved_at: string;
  expires_at: string;
  /** HMAC-SHA256 of the fields above with the key, in hex. */
  signature: string;
}

/** The call as a fingerprint sees it: the tool call rules see, plus the agent. */
export interface CallIdentity {
  agent: string;
  tool: string;
  command?: string;
  path?: string;
  access?: string;
  url?: string;
  mcpServer?: string;
  root?: string;
}

/** Reads a review item, from the local list or the team server. */
export type LookupItem = (id: string) => Promise<ReviewItem | undefined>;

export interface GrantsReport {
  /** Grants written by this pass: the agent can now make each call once. */
  issued: ExceptionGrant[];
  /** Requests still waiting on a person, or on their item to reach the list. */
  waiting: number;
  /** Why the pass stopped early; the rest stay for the next pass. */
  error?: string;
}

const MINUTE_MS = 60_000;
/** A request whose item never shows up on the list is dropped after a day. */
const REQUEST_TTL_MS = 24 * 60 * MINUTE_MS;
/** used/ markers are kept this long past their expiry, so a grant is never issued twice. */
const USED_KEEP_MS = 7 * 24 * 60 * MINUTE_MS;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY_HEX = /^[0-9a-f]{64}$/;

const code = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;

/** ~/.selfhost/exceptions, from the folder that holds config.json and the spool. */
export const exceptionsDir = (selfhostDir: string) => join(selfhostDir, "exceptions");

const requestsDir = (dir: string) => join(dir, "requests");
const grantsDir = (dir: string) => join(dir, "grants");
const usedDir = (dir: string) => join(dir, "used");
const fileOf = (folder: string, id: string) => join(folder, `${id}.json`);

function readKey(path: string): Buffer {
  const hex = readFileSync(path, "utf8").trim();
  if (!KEY_HEX.test(hex)) throw new Error(`${path} is not a selfhost exception key`);
  return Buffer.from(hex, "hex");
}

/**
 * The key, or undefined when there is none and `create` is not set. It is made whole in a
 * temporary file and linked into place, so a hook running at the same moment reads either
 * nothing or the full key, and both end up with the same one.
 */
export function exceptionKey(dir: string, create: boolean): Buffer | undefined {
  const path = join(dir, "key");
  try {
    return readKey(path);
  } catch (error) {
    if (code(error) !== "ENOENT") throw error;
    if (!create) return undefined;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const key = randomBytes(32);
  writeFileSync(temporary, key.toString("hex"), { mode: 0o600 });
  try {
    linkSync(temporary, path);
    return key;
  } catch (error) {
    if (code(error) === "EEXIST") return readKey(path);
    throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * A keyed hash of one call: the agent, the tool, the command with runs of white space made one
 * space, the file (relative to the repository root inside it) and what is done with it, the URL,
 * the MCP server and the repository root. The same call in the same repository gives the same
 * fingerprint; without the key nothing about the call can be read back from it.
 */
export function callFingerprint(key: Buffer, call: CallIdentity): string {
  const parts = [
    call.agent,
    call.tool,
    call.command?.replace(/\s+/g, " ").trim() ?? null,
    call.path ?? null,
    call.access ?? null,
    call.url ?? null,
    call.mcpServer ?? null,
    call.root ?? null,
  ];
  return createHmac("sha256", key)
    .update(`call\n${JSON.stringify(parts)}`)
    .digest("hex");
}

/** A new UUIDv7 for a request: the review item id the hook names. */
export function requestId(now: Date): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Math.min(Math.max(now.getTime(), 0), 2 ** 48 - 1), 0, 6);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Written to a temporary file and renamed, so a reader never sees half of it. */
function writeAtomically(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** The ids of the `.json` files in a folder, oldest id first; none when it does not exist. */
function idsIn(folder: string): string[] {
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json") && ID.test(name.slice(0, -5)))
    .map((name) => name.slice(0, -5))
    .sort();
}

export function writeRequest(dir: string, request: ExceptionRequest): void {
  mkdirSync(requestsDir(dir), { recursive: true, mode: 0o700 });
  writeAtomically(fileOf(requestsDir(dir), request.id), request);
}

export function readRequests(dir: string): ExceptionRequest[] {
  return idsIn(requestsDir(dir)).flatMap((id) => {
    const request = readJson<ExceptionRequest>(fileOf(requestsDir(dir), id));
    return request?.schema === REQUEST_SCHEMA && request.id === id ? [request] : [];
  });
}

type Unsigned = Omit<ExceptionGrant, "signature">;

function signatureOf(key: Buffer, grant: Unsigned): string {
  const fields = [
    grant.id,
    grant.fingerprint,
    grant.rules,
    grant.agent,
    grant.approved_by,
    grant.decision_event_id,
    grant.approved_at,
    grant.expires_at,
  ];
  return createHmac("sha256", key)
    .update(`grant\n${JSON.stringify(fields)}`)
    .digest("hex");
}

function signed(key: Buffer, grant: ExceptionGrant): boolean {
  const { signature, ...rest } = grant;
  if (typeof signature !== "string" || !KEY_HEX.test(signature)) return false;
  return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(signatureOf(key, rest), "hex"));
}

/**
 * A grant for this call: signed with the key, not expired, for the same fingerprint, and covering
 * every rule that stops the call now. Expired grants found on the way are removed.
 */
export function findGrant(
  dir: string,
  key: Buffer,
  fingerprint: string,
  rules: readonly string[],
  now: Date,
): ExceptionGrant | undefined {
  for (const id of idsIn(grantsDir(dir))) {
    const path = fileOf(grantsDir(dir), id);
    const grant = readJson<ExceptionGrant>(path);
    if (grant?.schema !== GRANT_SCHEMA || grant.id !== id || !signed(key, grant)) continue;
    if (Date.parse(grant.expires_at) <= now.getTime()) {
      rmSync(path, { force: true });
      continue;
    }
    if (grant.fingerprint !== fingerprint) continue;
    if (rules.every((rule) => grant.rules.includes(rule))) return grant;
  }
  return undefined;
}

/**
 * Uses a grant up: moves it to used/. Only one process can move a file, so of two hooks making
 * the same call at once, one gets true and the other false (and blocks).
 */
export function claimGrant(dir: string, grant: ExceptionGrant): boolean {
  mkdirSync(usedDir(dir), { recursive: true, mode: 0o700 });
  try {
    renameSync(fileOf(grantsDir(dir), grant.id), fileOf(usedDir(dir), grant.id));
    return true;
  } catch (error) {
    if (code(error) === "ENOENT") return false;
    throw error;
  }
}

const APPROVALS = new Set(["approve", "override"]);

/** Removes expired grants and used/ markers well past their expiry. */
function prune(dir: string, now: Date): void {
  for (const [folder, keep] of [
    [grantsDir(dir), 0],
    [usedDir(dir), USED_KEEP_MS],
  ] as const) {
    for (const id of idsIn(folder)) {
      const grant = readJson<ExceptionGrant>(fileOf(folder, id));
      const expires = Date.parse(grant?.expires_at ?? "");
      if (Number.isFinite(expires) && expires + keep <= now.getTime()) {
        rmSync(fileOf(folder, id), { force: true });
      }
    }
  }
}

/**
 * Turns this machine's approved requests into grants. For each request the hook wrote, it reads
 * the review item: approved (approve or override) writes a signed grant that expires
 * `expiry_minutes` after the answer; denied, dismissed or expired drops the request; open, or not
 * on the list yet, keeps it (for a day at most). A request whose grant was already written or
 * used is dropped, so one approval gives one grant. A lookup that fails stops the pass, and the
 * rest wait for the next one. Requests are read from `dir`, so another person's approvals never
 * turn into grants here.
 */
export async function issueGrants(
  dir: string,
  lookup: LookupItem,
  now: Date,
): Promise<GrantsReport> {
  const report: GrantsReport = { issued: [], waiting: 0 };
  const requests = readRequests(dir);
  if (requests.length === 0) {
    if (existsSync(dir)) prune(dir, now);
    return report;
  }
  const key = exceptionKey(dir, false);
  if (!key)
    return { ...report, error: `${join(dir, "key")} is missing, so no grant can be signed` };
  mkdirSync(grantsDir(dir), { recursive: true, mode: 0o700 });
  const drop = (request: ExceptionRequest) =>
    rmSync(fileOf(requestsDir(dir), request.id), { force: true });
  for (const [index, request] of requests.entries()) {
    if (
      existsSync(fileOf(grantsDir(dir), request.id)) ||
      existsSync(fileOf(usedDir(dir), request.id))
    ) {
      drop(request);
      continue;
    }
    let item: ReviewItem | undefined;
    try {
      item = await lookup(request.id);
    } catch (error) {
      report.waiting += requests.length - index;
      report.error = error instanceof Error ? error.message : String(error);
      break;
    }
    if (item?.kind !== "exception") {
      if (now.getTime() - Date.parse(request.requested_at) > REQUEST_TTL_MS) drop(request);
      else report.waiting += 1;
      continue;
    }
    if (item.state === "open") {
      report.waiting += 1;
      continue;
    }
    const answer = item.answer;
    const expires = answer ? Date.parse(answer.at) + request.expiry_minutes * MINUTE_MS : 0;
    if (item.state === "answered" && answer && APPROVALS.has(answer.verdict) && expires > +now) {
      const unsigned: Unsigned = {
        schema: GRANT_SCHEMA,
        id: request.id,
        fingerprint: request.fingerprint,
        rules: request.rules,
        agent: request.agent,
        approved_by: answer.by,
        decision_event_id: answer.decision_event_id,
        approved_at: new Date(answer.at).toISOString(),
        expires_at: new Date(expires).toISOString(),
      };
      const grant: ExceptionGrant = { ...unsigned, signature: signatureOf(key, unsigned) };
      writeAtomically(fileOf(grantsDir(dir), grant.id), grant);
      report.issued.push(grant);
    }
    drop(request);
  }
  prune(dir, now);
  return report;
}

/** true when the hook wrote requests that wait on a person. */
export const hasRequests = (dir: string) => idsIn(requestsDir(dir)).length > 0;

/** true when this machine's hook asked for exception `id`: a request, a grant or a used grant. */
export const isOwnException = (dir: string, id: string) =>
  ID.test(id) &&
  [requestsDir(dir), grantsDir(dir), usedDir(dir)].some((folder) => existsSync(fileOf(folder, id)));

/** The unused grant for exception `id`, signed with the key and not expired. */
export function readGrant(dir: string, id: string, now: Date): ExceptionGrant | undefined {
  const key = exceptionKey(dir, false);
  const grant = ID.test(id) ? readJson<ExceptionGrant>(fileOf(grantsDir(dir), id)) : undefined;
  if (!key || grant?.schema !== GRANT_SCHEMA || grant.id !== id || !signed(key, grant)) {
    return undefined;
  }
  return Date.parse(grant.expires_at) > now.getTime() ? grant : undefined;
}
