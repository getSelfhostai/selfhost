import { createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
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
import {
  EXCEPTION_GRANT_SCHEMA,
  type ExceptionGrantStatus,
  exceptionGrantPayload,
  type ReviewItem,
  type ExceptionGrant as ServerGrant,
} from "@selfhost/schema";
import type { TrustedKey } from "./trust.js";

export type { ServerGrant };

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
 * Who signs a grant depends on the mode (trust.ts):
 *
 * - Solo mode: the CLI signs it with `key` once the item is approved on the local list. Anyone
 *   who can read `key` can sign one, an agent running as the person included, so a solo
 *   exception holds against agents that follow the rules, not against one set on forging it.
 * - Team mode: the team server signs it with its Ed25519 key, which never leaves the server
 *   (selfhost.exception_grant/v2). The laptop fetches it, and the hook accepts it only when the
 *   signature verifies with a pinned public key and the grant names this call's fingerprint,
 *   session, repository and person. Grants signed with the local key are set aside unused.
 *   `nonces/<nonce>.json` records each nonce used, so a grant copied back is refused; the use is
 *   reported to the server on the next sync, which then hands the grant out no more.
 *
 * Of the workspace packages this module uses only @selfhost/schema, which the hook loads anyway.
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
  /** The agent session that was blocked: a grant is for that session only. */
  session?: string;
}

/** Reads a review item, from the local list or the team server. */
export type LookupItem = (id: string) => Promise<ReviewItem | undefined>;

/** A grant of either mode: signed with the local key (solo) or by the team server. */
export type AnyGrant = ExceptionGrant | ServerGrant;

export interface GrantsReport {
  /** Grants written by this pass: the agent can now make each call once. */
  issued: AnyGrant[];
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
const NONCE = /^[0-9a-f]{32}$/;
const NONCE_FILE = /^[0-9a-f]{32}\.json$/;

const code = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;

/** ~/.selfhost/exceptions, from the folder that holds config.json and the spool. */
export const exceptionsDir = (selfhostDir: string) => join(selfhostDir, "exceptions");

const requestsDir = (dir: string) => join(dir, "requests");
const grantsDir = (dir: string) => join(dir, "grants");
const usedDir = (dir: string) => join(dir, "used");
const noncesDir = (dir: string) => join(dir, "nonces");
const ignoredDir = (dir: string) => join(dir, "ignored");
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
 * the MCP server, the repository root and the agent session. The same call in the same session
 * and repository gives the same fingerprint, so an exception approved for one session is never
 * used by another; without the key nothing about the call can be read back from it.
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
    call.session ?? null,
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

/** The names in a folder that match `pattern`, sorted; none when it does not exist. */
function namesIn(folder: string, pattern: RegExp): string[] {
  try {
    return readdirSync(folder)
      .filter((name) => pattern.test(name))
      .sort();
  } catch {
    return [];
  }
}

/** The ids of the `.json` files in a folder, oldest id first; none when it does not exist. */
function idsIn(folder: string): string[] {
  return namesIn(folder, /\.json$/)
    .map((name) => name.slice(0, -5))
    .filter((id) => ID.test(id));
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

/** Removes expired grants, and used/ and nonce markers well past their expiry. */
function prune(dir: string, now: Date): void {
  for (const [folder, keep] of [
    [grantsDir(dir), 0],
    [usedDir(dir), USED_KEEP_MS],
  ] as const) {
    for (const id of idsIn(folder)) {
      const grant = readJson<AnyGrant>(fileOf(folder, id));
      const expires = Date.parse(grant?.expires_at ?? "");
      if (Number.isFinite(expires) && expires + keep <= now.getTime()) {
        rmSync(fileOf(folder, id), { force: true });
      }
    }
  }
  for (const name of namesIn(noncesDir(dir), NONCE_FILE)) {
    const marker = readJson<{ expires_at?: string }>(join(noncesDir(dir), name));
    const expires = Date.parse(marker?.expires_at ?? "");
    if (Number.isFinite(expires) && expires + USED_KEEP_MS <= now.getTime()) {
      rmSync(join(noncesDir(dir), name), { force: true });
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

/**
 * The unused grant for exception `id`, not expired: in team mode (`keys` given) one the server
 * signed with a pinned key whose nonce was not used; in solo mode one signed with the local key.
 */
export function readGrant(
  dir: string,
  id: string,
  now: Date,
  keys?: readonly TrustedKey[],
): AnyGrant | undefined {
  if (keys) {
    const grant = ID.test(id) ? readJson<unknown>(fileOf(grantsDir(dir), id)) : undefined;
    if (!verifyServerGrant(grant, keys) || grant.id !== id || nonceUsed(dir, grant.nonce)) {
      return undefined;
    }
    return Date.parse(grant.expires_at) > now.getTime() ? grant : undefined;
  }
  const key = exceptionKey(dir, false);
  const grant = ID.test(id) ? readJson<ExceptionGrant>(fileOf(grantsDir(dir), id)) : undefined;
  if (!key || grant?.schema !== GRANT_SCHEMA || grant.id !== id || !signed(key, grant)) {
    return undefined;
  }
  return Date.parse(grant.expires_at) > now.getTime() ? grant : undefined;
}

/**
 * true when `grant` is a server grant signed by one of `keys`: the key it names is pinned, and
 * the Ed25519 signature over every other field verifies with it.
 */
export function verifyServerGrant(
  grant: unknown,
  keys: readonly TrustedKey[],
): grant is ServerGrant {
  if (typeof grant !== "object" || grant === null) return false;
  const { signature, ...rest } = grant as ServerGrant;
  if (rest.schema !== EXCEPTION_GRANT_SCHEMA || typeof signature !== "string") return false;
  if (!Array.isArray(rest.rules) || typeof rest.expires_at !== "string") return false;
  if (typeof rest.nonce !== "string" || !NONCE.test(rest.nonce)) return false;
  const key = keys.find((candidate) => candidate.id === rest.key_id);
  if (!key) return false;
  try {
    const publicKey = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: key.public_key },
      format: "jwk",
    });
    return verify(
      null,
      exceptionGrantPayload(rest),
      publicKey,
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

const nonceFile = (dir: string, nonce: string) => join(noncesDir(dir), `${nonce}.json`);

/** true when a hook on this machine already allowed a call with this nonce. */
const nonceUsed = (dir: string, nonce: string) => existsSync(nonceFile(dir, nonce));

/** The call a server grant must name, as the hook sees it. */
export interface GrantedCall {
  fingerprint: string;
  rules: readonly string[];
  session?: string;
  /** owner/name of the call's repository, read only for a grant that names one. */
  repo: () => string | undefined;
  /** The team membership's person on this laptop, when known. */
  person?: string;
}

/**
 * A server grant for this call: signed with a pinned key, not expired, its nonce not used here,
 * for the same fingerprint, session, repository and person, and covering every rule that stops
 * the call now. Expired grants found on the way are removed.
 */
export function findServerGrant(
  dir: string,
  keys: readonly TrustedKey[],
  call: GrantedCall,
  now: Date,
): ServerGrant | undefined {
  let repo: { value: string | undefined } | undefined;
  for (const id of idsIn(grantsDir(dir))) {
    const path = fileOf(grantsDir(dir), id);
    const grant = readJson<unknown>(path);
    if (!verifyServerGrant(grant, keys) || grant.id !== id) continue;
    if (Date.parse(grant.expires_at) <= now.getTime()) {
      rmSync(path, { force: true });
      continue;
    }
    if (grant.fingerprint !== call.fingerprint) continue;
    if (grant.session_id !== null && grant.session_id !== call.session) continue;
    if (!call.rules.every((rule) => grant.rules.includes(rule))) continue;
    if (call.person !== undefined && grant.requested_by.toLowerCase() !== call.person.toLowerCase())
      continue;
    if (nonceUsed(dir, grant.nonce)) continue;
    if (grant.repo !== null) {
      repo ??= { value: call.repo() };
      if (grant.repo !== repo.value) continue;
    }
    return grant;
  }
  return undefined;
}

/**
 * Uses a server grant up: records its nonce (the claim: of two hooks at once, only one creates
 * the file) and moves the grant to used/, where the next sync finds it to report the use.
 */
export function claimServerGrant(dir: string, grant: ServerGrant): boolean {
  mkdirSync(noncesDir(dir), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(
      nonceFile(dir, grant.nonce),
      `${JSON.stringify({ id: grant.id, expires_at: grant.expires_at })}\n`,
      { mode: 0o600, flag: "wx" },
    );
  } catch (error) {
    if (code(error) === "EEXIST") return false;
    throw error;
  }
  mkdirSync(usedDir(dir), { recursive: true, mode: 0o700 });
  try {
    renameSync(fileOf(grantsDir(dir), grant.id), fileOf(usedDir(dir), grant.id));
  } catch (error) {
    if (code(error) !== "ENOENT") throw error;
  }
  return true;
}

/**
 * In team mode: moves grants signed with the local key to ignored/, where nothing reads them,
 * and returns how many. Grants written before this laptop was in team mode, or by anyone who can
 * read the local key, are not accepted there.
 */
export function setAsideLaptopGrants(dir: string): number {
  let moved = 0;
  for (const id of idsIn(grantsDir(dir))) {
    const grant = readJson<{ schema?: unknown }>(fileOf(grantsDir(dir), id));
    if (grant?.schema === EXCEPTION_GRANT_SCHEMA) continue;
    mkdirSync(ignoredDir(dir), { recursive: true, mode: 0o700 });
    try {
      renameSync(fileOf(grantsDir(dir), id), fileOf(ignoredDir(dir), id));
      moved += 1;
    } catch (error) {
      if (code(error) !== "ENOENT") throw error;
    }
  }
  return moved;
}

/** The one-line note for grants set aside in team mode. */
export const setAsideNote = (count: number) =>
  `ignored ${count} one-time exception grant${count === 1 ? "" : "s"} signed on this laptop: in team mode only the team server signs grants. Ask for the exception again.`;

/** The team server's side of the grants, in team mode. */
export interface ServerGrants {
  /** The server's answer about one exception; undefined while the item is not on its list. */
  grant(id: string): Promise<ExceptionGrantStatus | undefined>;
  /** Tells the server a grant was used, so it hands it out no more. */
  used(id: string, nonce: string): Promise<void>;
}

/**
 * Team mode's issueGrants: for each request the hook wrote, asks the server. A grant it signed
 * with a key this laptop pinned is written to grants/; one it refused, that expired or was used
 * drops the request; one still waiting keeps it (a request whose item never reaches the list is
 * dropped after a day). A grant signed with a key this laptop has not pinned keeps the request,
 * with an error that says to pin it. Then it reports the grants hooks used since the last pass.
 */
export async function pullServerGrants(
  dir: string,
  server: ServerGrants,
  keys: readonly TrustedKey[],
  now: Date,
): Promise<GrantsReport> {
  const report: GrantsReport = { issued: [], waiting: 0 };
  const requests = readRequests(dir);
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
    let answer: ExceptionGrantStatus | undefined;
    try {
      answer = await server.grant(request.id);
    } catch (error) {
      report.waiting += requests.length - index;
      report.error = error instanceof Error ? error.message : String(error);
      break;
    }
    if (!answer) {
      if (now.getTime() - Date.parse(request.requested_at) > REQUEST_TTL_MS) drop(request);
      else report.waiting += 1;
      continue;
    }
    if (answer.state === "waiting") {
      report.waiting += 1;
      continue;
    }
    const grant = answer.grant;
    if (answer.state === "granted" && grant) {
      if (!verifyServerGrant(grant, keys) || grant.id !== request.id) {
        report.waiting += 1;
        report.error = `the server's grant for ${request.id} is signed with key ${grant.key_id}, which this laptop has not pinned. Run selfhost import to pin the server's keys${keys.length > 0 ? ", and the admin command for the managed settings if they pin them" : ""}.`;
        continue;
      }
      if (grant.fingerprint === request.fingerprint) {
        mkdirSync(grantsDir(dir), { recursive: true, mode: 0o700 });
        writeAtomically(fileOf(grantsDir(dir), grant.id), grant);
        report.issued.push(grant);
      }
    }
    drop(request);
  }
  await reportUses(dir, server, report);
  prune(dir, now);
  return report;
}

/** Tells the server about the server grants hooks used that it has not heard of yet. */
async function reportUses(dir: string, server: ServerGrants, report: GrantsReport) {
  for (const id of idsIn(usedDir(dir))) {
    const path = fileOf(usedDir(dir), id);
    const used = readJson<ServerGrant & { reported_at?: string }>(path);
    if (used?.schema !== EXCEPTION_GRANT_SCHEMA || used.reported_at !== undefined) continue;
    try {
      await server.used(id, used.nonce);
    } catch (error) {
      report.error ??= error instanceof Error ? error.message : String(error);
      return;
    }
    writeAtomically(path, { ...used, reported_at: new Date().toISOString() });
  }
}

/** true when grants used here wait to be reported to the server. */
export const hasUnreportedUses = (dir: string) =>
  idsIn(usedDir(dir)).some((id) => {
    const used = readJson<{ schema?: unknown; reported_at?: unknown }>(fileOf(usedDir(dir), id));
    return used?.schema === EXCEPTION_GRANT_SCHEMA && used.reported_at === undefined;
  });
