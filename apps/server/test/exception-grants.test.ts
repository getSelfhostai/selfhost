import { createPublicKey, verify } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Ledger, openLedger } from "@selfhost/ledger";
import { openReviewList, refreshReviewList } from "@selfhost/review";
import {
  createValidator,
  type ExceptionGrant,
  type ExceptionGrantStatus,
  ExceptionGrantStatusSchema,
  type ExceptionKeysResponse,
  ExceptionKeysResponseSchema,
  exceptionGrantPayload,
  type JoinResponse,
  type LedgerEvent,
} from "@selfhost/schema";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadExceptionKeys } from "../src/exception-keys.js";
import { TOKEN } from "./helpers.js";

const NOW = "2026-11-10T10:00:00.000Z";
const minutes = (n: number) => new Date(Date.parse(NOW) + n * 60_000).toISOString();
const FINGERPRINT = "ab".repeat(32);

const ledgers: Ledger[] = [];
afterEach(async () => {
  for (const ledger of ledgers.splice(0)) await ledger.close();
});

function matches<T>(schema: Parameters<typeof createValidator>[0], value: T): T {
  const result = createValidator(schema).validate(value);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return value;
}

const verifies = (grant: ExceptionGrant, keys: ExceptionKeysResponse) => {
  const { signature, ...rest } = grant;
  const key = keys.keys.find((k) => k.id === grant.key_id);
  if (!key) return false;
  const publicKey = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: key.public_key },
    format: "jwk",
  });
  return verify(null, exceptionGrantPayload(rest), publicKey, Buffer.from(signature, "base64url"));
};

async function setup() {
  const ledger = await openLedger({ dataDir: "memory://" });
  ledgers.push(ledger);
  let clock = new Date(NOW);
  const now = () => clock;
  const app = createApp({ version: "1.2.3", ledger, token: TOKEN, now });
  const cli = openReviewList(ledger, { now });
  const send = (path: string, init: RequestInit = {}, token = TOKEN) =>
    Promise.resolve(
      app.request(path, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(init.headers as Record<string, string>),
        },
      }),
    );
  const post = (path: string, body: unknown, token = TOKEN) =>
    send(path, { method: "POST", body: JSON.stringify(body) }, token);
  const created = (await (await post("/v1/teams", { name: "Red" })).json()) as { invite: string };
  const join = async (person: string) =>
    ((await (await post("/v1/join", { invite: created.invite, person })).json()) as JoinResponse)
      .token;
  const lead = await join("lead@example.com");
  const dev = await join("dev@example.com");
  const dev2 = await join("dev2@example.com");
  let n = 0;
  /** A force push dev's hook blocked, with the exception it asked for, as the sync sends it. */
  const blocked = async (token = dev) => {
    n += 1;
    const id = `019a7000-0000-7000-8000-${String(n).padStart(12, "0")}`;
    const event: LedgerEvent = {
      id: `019a7000-0000-7000-9000-${String(n).padStart(12, "0")}`,
      schema: "selfhost.event/v1",
      ts: NOW,
      source: "hook",
      kind: "policy.evaluated",
      actor: { kind: "system", id: "selfhost-policy" },
      agent: { vendor: "claude_code" },
      session_id: "sess-1",
      repo: "acme/web",
      tool: { name: "Bash", input_summary: "git push -f" },
      decision: {
        verdict: "block",
        by: "selfhost-policy",
        rule_id: "guard.force_push",
        mode: "enforce",
      },
      data: { exception: { id, fingerprint: FINGERPRINT, rules: ["guard.force_push"] } },
    };
    expect((await post("/v1/events", { events: [event] }, token)).status).toBe(200);
    await refreshReviewList(ledger, cli);
    return id;
  };
  const fetchGrant = async (id: string, token = dev) => {
    const res = await send(`/v1/exception-grants/${id}`, {}, token);
    return { status: res.status, body: (await res.json()) as ExceptionGrantStatus };
  };
  return {
    ledger,
    cli,
    send,
    post,
    lead,
    dev,
    dev2,
    blocked,
    fetchGrant,
    setNow(time: string) {
      clock = new Date(time);
    },
  };
}

describe("the exception signing keys", () => {
  it("are made once, kept 0600 next to the token, and reloaded on the next start", () => {
    const dataDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "selfhost-keys-"));
    const first = loadExceptionKeys(dataDir, {});
    expect(first.created).toBe(true);
    expect(first.path).toBe(join(dataDir, "exception-keys.json"));
    expect(statSync(first.path ?? "").mode & 0o777).toBe(0o600);
    const again = loadExceptionKeys(dataDir, {});
    expect(again.created).toBe(false);
    expect(again.publicKeys()).toEqual(first.publicKeys());
    matches(ExceptionKeysResponseSchema, first.publicKeys());
    // The listing has public keys only.
    expect(JSON.stringify(first.publicKeys())).not.toContain("private");
  });

  it("rotate by key id: the new key signs, the old one stays listed for the grants it signed", () => {
    const dataDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "selfhost-keys-"));
    const ring = loadExceptionKeys(dataDir, {});
    const old = ring.publicKeys().active;
    const fresh = ring.rotate(new Date(NOW));
    expect(fresh).not.toBe(old);
    const listed = loadExceptionKeys(dataDir, {}).publicKeys();
    expect(listed.active).toBe(fresh);
    expect(listed.keys.map((key) => key.id)).toEqual([old, fresh]);
  });

  it("can live in a file several servers share", () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "selfhost-keys-"));
    const file = join(dir, "shared.json");
    const a = loadExceptionKeys("memory://", { SELFHOST_EXCEPTION_KEYS_FILE: file });
    const b = loadExceptionKeys(join(dir, "other"), { SELFHOST_EXCEPTION_KEYS_FILE: file });
    expect(b.publicKeys()).toEqual(a.publicKeys());
    expect(JSON.parse(readFileSync(file, "utf8")).schema).toBe("selfhost.exception_keyring/v1");
  });

  it("are listed to either token, and rotated with the admin token only", async () => {
    const { send, post, dev } = await setup();
    const listed = (await (
      await send("/v1/exception-keys", {}, dev)
    ).json()) as ExceptionKeysResponse;
    matches(ExceptionKeysResponseSchema, listed);
    expect((await post("/v1/exception-keys/rotate", {}, dev)).status).toBe(403);
    const rotated = (await (
      await post("/v1/exception-keys/rotate", {})
    ).json()) as ExceptionKeysResponse;
    expect(rotated.keys).toHaveLength(2);
    expect(rotated.active).not.toBe(listed.active);
  });
});

describe("a server-signed grant", () => {
  it("is signed once an owner approves, binds the call, and is handed out until used", async () => {
    const { send, post, lead, dev, dev2, blocked, fetchGrant } = await setup();
    const keys = (await (
      await send("/v1/exception-keys", {}, dev)
    ).json()) as ExceptionKeysResponse;
    const id = await blocked();
    expect((await fetchGrant(id)).body).toMatchObject({ state: "waiting" });
    expect(
      (await post(`/v1/review-items/${id}/decision`, { verdict: "approve" }, lead)).status,
    ).toBe(200);

    const { status, body } = await fetchGrant(id);
    expect(status).toBe(200);
    matches(ExceptionGrantStatusSchema, body);
    const grant = body.grant as ExceptionGrant;
    expect(grant).toMatchObject({
      schema: "selfhost.exception_grant/v2",
      id,
      fingerprint: FINGERPRINT,
      rules: ["guard.force_push"],
      agent: "claude_code",
      session_id: "sess-1",
      repo: "acme/web",
      requested_by: "dev@example.com",
      approved_by: "lead@example.com",
      team: "red",
      key_id: keys.active,
    });
    // 30 minutes after the approval, the default [review] exception_expiry_minutes.
    expect(Date.parse(grant.expires_at) - Date.parse(grant.approved_at)).toBe(30 * 60_000);
    expect(verifies(grant, keys)).toBe(true);
    // A changed field no longer verifies.
    expect(verifies({ ...grant, session_id: "sess-2" }, keys)).toBe(false);
    expect(verifies({ ...grant, fingerprint: "cd".repeat(32) }, keys)).toBe(false);
    expect(verifies({ ...grant, expires_at: minutes(600) }, keys)).toBe(false);

    // The same grant on every fetch, and only to the person whose agent asked.
    expect((await fetchGrant(id)).body.grant).toEqual(grant);
    expect((await fetchGrant(id, dev2)).status).toBe(403);
    expect((await fetchGrant(id, lead)).status).toBe(403);
    expect((await fetchGrant(id, TOKEN)).status).toBe(403);

    // A laptop reports the use with the grant's nonce; then it is handed out no more.
    const use = (nonce: string, token = dev) =>
      post(`/v1/exception-grants/${id}/use`, { nonce, machine: "laptop-a" }, token);
    expect((await use("0".repeat(32))).status).toBe(409);
    expect((await use(grant.nonce, dev2)).status).toBe(403);
    expect((await use(grant.nonce)).status).toBe(200);
    expect((await fetchGrant(id)).body).toEqual({
      schema: "selfhost.exception_grant_status/v1",
      id,
      state: "used",
    });
  });

  it("is refused for a denied exception, and expires with the approval", async () => {
    const { post, lead, blocked, fetchGrant, setNow } = await setup();
    const denied = await blocked();
    await post(`/v1/review-items/${denied}/decision`, { verdict: "deny" }, lead);
    expect((await fetchGrant(denied)).body).toMatchObject({ state: "refused" });

    const late = await blocked();
    await post(`/v1/review-items/${late}/decision`, { verdict: "approve" }, lead);
    setNow(minutes(31));
    expect((await fetchGrant(late)).body).toMatchObject({ state: "expired" });
  });

  it("is never signed for an approval authorize.ts would refuse, however it was recorded", async () => {
    const { cli, blocked, fetchGrant } = await setup();
    // Answers written straight into the list, past the routes that check them.
    const byMember = await blocked();
    await cli.decide(byMember, { verdict: "approve", by: "dev2@example.com", surface: "api" });
    expect((await fetchGrant(byMember)).body).toMatchObject({
      state: "refused",
      reason: expect.stringMatching(/needs the owner or admin role/),
    });
    const ownApproval = await blocked();
    await cli.decide(ownApproval, { verdict: "approve", by: "dev@example.com", surface: "api" });
    expect((await fetchGrant(ownApproval)).body).toMatchObject({
      state: "refused",
      reason: expect.stringMatching(/cannot approve an exception your own agent asked for/),
    });
  });

  it("is not signed for an exception another person's laptop reported", async () => {
    const { post, lead, dev2, blocked, fetchGrant } = await setup();
    // dev2 sends an event naming an exception; only dev2 may fetch it, never dev.
    const id = await blocked(dev2);
    await post(`/v1/review-items/${id}/decision`, { verdict: "approve" }, lead);
    expect((await fetchGrant(id)).status).toBe(403);
    expect((await fetchGrant(id, dev2)).body).toMatchObject({ state: "granted" });
  });
});
