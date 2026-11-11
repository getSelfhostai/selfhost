import { generateKeyPairSync } from "node:crypto";
import { createGitHubApp } from "@selfhost/github";
import { FakeGitHub } from "@selfhost/github/testing";
import { type Ledger, openLedger } from "@selfhost/ledger";
import { openReviewList, refreshReviewList } from "@selfhost/review";
import {
  type ApiError,
  type CreateTeamResponse,
  createValidator,
  EVENT_SCHEMA,
  type Handoff,
  HandoffSchema,
  type HandoffsResponse,
  type IngestEventsError,
  type JoinResponse,
  type LedgerEvent,
  type ReviewItemsPage,
  type RunResponse,
  RunResponseSchema,
  type RunShareResponse,
  type TailResponse,
  type TakeoverResponse,
} from "@selfhost/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { plantedValues, readPlanted } from "../../../fixtures/redaction/planted.js";
import { createApp } from "../src/app.js";
import { caller, TOKEN } from "./helpers.js";

const RUN = "5f0c2b1e-7d4a-4c8e-9a51-3e2d1c0b9a87";
const PUBLIC_URL = "https://selfhost.acme.example.com";
// Every event is dated against this clock, so nothing here depends on the day the tests run.
const NOW = new Date("2026-11-11T12:00:00Z");
const PR = "https://github.com/acme/api/pull/7";

const validHandoff = createValidator(HandoffSchema);
const validRun = createValidator(RunResponseSchema);

const secret = (kind: string) => plantedValues().find((p) => p.kind === kind)?.value ?? "";

let n = 0;
const event = (fields: Partial<LedgerEvent> & Pick<LedgerEvent, "kind" | "ts">): LedgerEvent => ({
  id: `01930c4e-2f1a-7b2c-9d3e-${(++n).toString(16).padStart(12, "0")}`,
  schema: EVENT_SCHEMA,
  source: "hook",
  actor: { kind: "person", id: "ana@example.com" },
  agent: { vendor: "claude_code", version: "2.1.0" },
  session_id: RUN,
  repo: "acme/api",
  ...fields,
});

const RUN_EVENTS = (): LedgerEvent[] => [
  event({ kind: "session.started", ts: "2026-11-11T09:00:00.000Z" }),
  event({ kind: "prompt.submitted", ts: "2026-11-11T09:00:05.000Z", data: { prompt: "x" } }),
  event({
    kind: "tool.called",
    ts: "2026-11-11T09:01:00.000Z",
    tool: { name: "Edit", input_summary: "src/limits.ts" },
    target: { type: "file", value: "src/limits.ts" },
  }),
  event({
    kind: "tool.called",
    ts: "2026-11-11T09:02:00.000Z",
    tool: {
      name: "Bash",
      input_summary: `curl -H 'X-Ticket: ACME-4521' -H 'Authorization: Bearer ${secret("github_token")}' https://api.example.com`,
    },
  }),
  event({
    kind: "cost.recorded",
    source: "otel",
    ts: "2026-11-11T09:03:00.000Z",
    model: "claude-sonnet-4-5",
    cost: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      usd: 0.42,
      estimated: false,
    },
  }),
  event({
    kind: "approval.requested",
    ts: "2026-11-11T11:50:00.000Z",
    data: { notification_type: "idle_prompt", message: "Which limit should anonymous calls get?" },
  }),
];

const POLICY = `version = 1

[[redaction]]
name = "ticket"
pattern = "ACME-\\\\d+"

[handoff]
share_transcript = true
turns = 5
`;

async function setup(github?: Parameters<typeof createApp>[0]["github"]) {
  const ledger = await openLedger({ dataDir: "memory://" });
  const app = createApp({
    version: "test",
    ledger,
    token: TOKEN,
    now: () => NOW,
    github: { publicUrl: PUBLIC_URL, ...github },
  });
  const admin = caller(app, TOKEN);
  const team = async (name: string) =>
    (await (await admin("/v1/teams", "POST", { name })).json()) as CreateTeamResponse;
  const join = async (invite: string, person: string) => {
    const res = await app.request("/v1/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invite, person }),
    });
    return caller(app, ((await res.json()) as JoinResponse).token);
  };
  const web = await team("Web");
  const data = await team("Data");
  const as = {
    admin,
    // The first person to join a team becomes its owner.
    olga: await join(web.invite, "olga@example.com"),
    ana: await join(web.invite, "ana@example.com"),
    ben: await join(web.invite, "ben@example.com"),
    mia: await join(web.invite, "mia@example.com"),
    dora: await join(data.invite, "dora@example.com"),
  };
  expect((await as.ana("/v1/events", "POST", { events: RUN_EVENTS() })).status).toBe(200);
  return { ledger, app, as };
}

const json = async <T>(res: Response) => ({ status: res.status, body: (await res.json()) as T });

describe("handing a run to a teammate", () => {
  let ledger: Ledger;
  let as: Awaited<ReturnType<typeof setup>>["as"];
  let handoff: Handoff;
  const transcript = readPlanted("events-with-secrets.jsonl");
  const refresh = () => refreshReviewList(ledger, openReviewList(ledger, { now: () => NOW }));

  beforeAll(async () => {
    ({ ledger, as } = await setup());
    await refresh();
  });

  afterAll(async () => {
    await ledger.close();
  });

  const handOff = (who: ReturnType<typeof caller>, body: unknown, run = RUN) =>
    who(`/v1/runs/${run}/handoffs`, "POST", body).then((res) => json<Handoff & ApiError>(res));

  it("refuses anyone but the run's owner or a team owner or admin", async () => {
    const member = await handOff(as.mia, { to: "ben@example.com" });
    expect(member.status).toBe(403);
    expect(member.body.error.message).toMatch(/needs to hold it \(it is ana@example.com's\)/);
    const outsider = await handOff(as.dora, { to: "dora@example.com" });
    expect(outsider.status).toBe(403);
    expect(outsider.body.error.message).toBe(`No run ${RUN} in a team you can read.`);
    expect((await handOff(as.dora, { to: "x" }, "no-such-run")).body.error.message).toBe(
      "No run no-such-run in a team you can read.",
    );
    expect((await handOff(as.admin, { to: "ben@example.com" }, "no-such-run")).status).toBe(404);
  });

  it("refuses a new owner outside the team, the owner themselves and a transcript the team does not share", async () => {
    const outside = await handOff(as.ana, { to: "dora@example.com" });
    expect(outside.status).toBe(400);
    expect(outside.body.error.message).toMatch(/dora@example.com is not in team web/);
    expect((await handOff(as.ana, { to: "ANA@example.com" })).body.error.message).toBe(
      "ana@example.com already holds this run.",
    );
    const shared = await handOff(as.ana, {
      to: "ben@example.com",
      transcript: { vendor: "claude_code", file_name: `${RUN}.jsonl`, text: "{}" },
    });
    expect(shared.status).toBe(400);
    expect(shared.body.error.code).toBe("transcript_not_shared");
    // Nothing was written for the refused ones.
    expect((await ledger.handoffs.list()).length).toBe(0);
  });

  it("lets a person token write no owner change of its own", async () => {
    const forged = event({
      kind: "run.handed_off",
      ts: "2026-11-11T11:55:00.000Z",
      data: {
        v: 1,
        handoff: "01930c4e-2f1a-7b2c-8d3e-4f5a6b7c8e20",
        owner: "mia@example.com",
        previous_owner: "ana@example.com",
      },
    });
    const res = await json<IngestEventsError>(
      await as.mia("/v1/events", "POST", { events: [forged] }),
    );
    expect(res.status).toBe(400);
    expect(res.body.errors[0]).toMatchObject({ index: 0, field: "kind" });
  });

  it("hands the run over with branch, files, open items, cost and redacted turns, note and transcript", async () => {
    expect((await as.olga("/v1/policy?team=web", "PUT", { text: POLICY })).status).toBe(200);
    const res = await handOff(as.ana, {
      to: "Ben@example.com",
      note: `Rate limits half done; staging key is ${secret("openai_api_key")} (ticket ACME-77)`,
      branch: "agent/rate-limits",
      commit: "4f2a9c1d7e3b5a8f0c6d2e9b1a7f3c5d8e0b2a4c",
      pushed: true,
      remote: { url: "https://ana:ghp_notreal@git.acme.example.com/acme/api.git", branch: "rl" },
      uncommitted: ["src/wip.ts"],
      transcript: { vendor: "claude_code", file_name: `${RUN}.jsonl`, text: transcript },
    });
    expect(res.status).toBe(201);
    handoff = res.body;
    expect(validHandoff.validate(handoff).ok).toBe(true);
    expect(handoff).toMatchObject({
      run_id: RUN,
      team: "web",
      repo: "acme/api",
      from: "ana@example.com",
      to: "ben@example.com",
      by: "ana@example.com",
      branch: "agent/rate-limits",
      pushed: true,
      // The user name and password a remote URL can carry never reach the new owner.
      remote: { url: "https://git.acme.example.com/acme/api.git", branch: "rl" },
      uncommitted: ["src/wip.ts"],
      files: ["src/limits.ts"],
      cost_usd: 0.42,
      state: "pending",
      transcript: { vendor: "claude_code", file_name: `${RUN}.jsonl`, redacted: true },
      run_url: `${PUBLIC_URL}/?screen=run&run=${RUN}`,
    });
    expect(handoff.open_items).toEqual([
      expect.objectContaining({ kind: "question", blocking: true }),
    ]);
    expect(handoff.note).toBe(
      "Rate limits half done; staging key is [redacted] (ticket [redacted:ticket])",
    );
    expect(handoff.turns.length).toBeLessThanOrEqual(5);
    const turns = JSON.stringify(handoff.turns);
    expect(turns).toContain("Edit: src/limits.ts");
    expect(turns).toContain("Prompt (text not logged)");
    expect(turns).not.toContain("ACME-4521");
    for (const { value } of plantedValues()) expect(JSON.stringify(handoff)).not.toContain(value);
  });

  it("shows the new owner and the handoff on the run, to the team only", async () => {
    const read = await json<RunResponse>(await as.mia(`/v1/runs/${RUN}`));
    expect(read.status).toBe(200);
    expect(validRun.validate(read.body).ok).toBe(true);
    expect(read.body.run).toMatchObject({ person: "ana@example.com", owner: "ben@example.com" });
    expect(read.body.handoffs).toEqual([
      expect.objectContaining({
        id: handoff.id,
        from: "ana@example.com",
        to: "ben@example.com",
        state: "pending",
        note: handoff.note,
      }),
    ]);
    const handed = read.body.events.find((e) => e.kind === "run.handed_off");
    expect(handed?.data).toMatchObject({
      owner: "ben@example.com",
      previous_owner: "ana@example.com",
    });
    const outsider = await as.dora(`/v1/runs/${RUN}`);
    expect(outsider.status).toBe(403);
    expect(JSON.stringify(await outsider.json())).not.toContain("ana@example.com");
  });

  it("routes the run's open items to the new owner", async () => {
    await refresh();
    const items = await json<ReviewItemsPage>(await as.ben("/v1/review-items?state=open"));
    const question = items.body.items.find((item) => item.session_id === RUN);
    expect(question?.owners).toEqual(["ben@example.com"]);
    expect(question?.route).toMatchObject({
      from: "the run's owner",
      why: "handed over from ana@example.com",
    });
  });

  it("gives the run's later agent events to the new owner in the tail", async () => {
    const later = event({
      kind: "tool.called",
      ts: "2026-11-11T12:00:00.000Z",
      actor: { kind: "agent", id: RUN },
      tool: { name: "Read", input_summary: "src/limits.ts" },
    });
    await ledger.append([later], { team: "web" });
    const tail = await json<TailResponse>(
      await as.mia(`/v1/events/tail?since=2026-11-11T00:00:00.000Z&session=${RUN}`),
    );
    expect(tail.body.people?.[later.id]).toBe("ben@example.com");
  });

  it("lists the handoff for its new owner and their team only", async () => {
    const mine = await json<HandoffsResponse>(await as.ben("/v1/handoffs?to=me&state=pending"));
    expect(mine.body.handoffs.map((h) => h.id)).toEqual([handoff.id]);
    expect((await json<HandoffsResponse>(await as.dora("/v1/handoffs"))).body.handoffs).toEqual([]);
    expect((await as.dora(`/v1/handoffs/${handoff.id}`)).status).toBe(403);
    expect((await as.mia(`/v1/handoffs/${handoff.id}`)).status).toBe(200);
    expect((await as.admin("/v1/handoffs?to=me")).status).toBe(400);
  });

  it("lets only the new owner take it over, once, with the transcript masked", async () => {
    const takeover = (who: ReturnType<typeof caller>) =>
      who(`/v1/handoffs/${handoff.id}/takeover`, "POST").then((res) =>
        json<TakeoverResponse & ApiError>(res),
      );
    expect((await takeover(as.mia)).body.error.message).toBe(
      "This run was handed to ben@example.com; only they can take it over.",
    );
    const admin = await takeover(as.admin);
    expect(admin.status).toBe(403);
    expect(admin.body.error.message).toMatch(/own login/);

    const taken = await takeover(as.ben);
    expect(taken.status).toBe(200);
    expect(taken.body.handoff).toMatchObject({ state: "taken", taken_at: NOW.toISOString() });
    const text = taken.body.transcript?.text ?? "";
    expect(text.split("\n").length).toBe(transcript.split("\n").length);
    for (const line of text.split("\n").filter(Boolean))
      expect(() => JSON.parse(line)).not.toThrow();
    for (const { value } of plantedValues()) expect(text).not.toContain(value);
    expect(text).toContain("[redacted]");

    const again = await takeover(as.ben);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("not_pending");
  });

  it("supersedes a pending handoff when a team owner hands the run on", async () => {
    const toMia = await handOff(as.ben, { to: "mia@example.com" });
    expect(toMia.status).toBe(201);
    expect(toMia.body.from).toBe("ben@example.com");
    // Ben no longer holds it, so he cannot hand it again; the team's owner can.
    expect((await handOff(as.ben, { to: "ana@example.com" })).status).toBe(403);
    // The files git says the work changed, masked like every path, in place of the tool calls'.
    const byOwner = await handOff(as.olga, {
      to: "ana@example.com",
      files: ["src/limits.ts", "scripts/ACME-77.sh"],
    });
    expect(byOwner.status).toBe(201);
    expect(byOwner.body).toMatchObject({ from: "mia@example.com", by: "olga@example.com" });
    expect(byOwner.body.files).toEqual(["src/limits.ts", "scripts/[redacted:ticket].sh"]);
    expect(toMia.body.files).toEqual(["src/limits.ts"]);
    const late = await json<ApiError>(
      await as.mia(`/v1/handoffs/${toMia.body.id}/takeover`, "POST"),
    );
    expect(late.status).toBe(409);
    expect(late.body.error.message).toMatch(/superseded/);
    const run = await json<RunResponse>(await as.ana(`/v1/runs/${RUN}`));
    expect(run.body.run.owner).toBe("ana@example.com");
    expect(run.body.handoffs.map((h) => h.state)).toEqual(["taken", "superseded", "pending"]);
  });

  it("shares the run's link, and says why nothing was posted without the App", async () => {
    const shared = await json<RunShareResponse>(await as.mia(`/v1/runs/${RUN}/share`, "POST", {}));
    expect(shared.body).toEqual({
      schema: "selfhost.run_share/v1",
      run_id: RUN,
      url: `${PUBLIC_URL}/?screen=run&run=${RUN}`,
      comments: [],
      skipped: "No GitHub App on this server, so the link was not posted on any pull request.",
    });
    expect((await as.dora(`/v1/runs/${RUN}/share`, "POST", {})).status).toBe(403);
  });
});

describe("the run link on the run's pull request", () => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const github = new FakeGitHub({
    appId: "123456",
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  });
  let ledger: Ledger;
  let as: Awaited<ReturnType<typeof setup>>["as"];

  beforeAll(async () => {
    github.addPull("acme/api", 7, { author: "selfhost-agent" });
    const app = createGitHubApp(
      {
        appId: "123456",
        privateKey: keys.privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
        webhookSecret: "secret",
      },
      { fetch: github.fetch, log: () => {} },
    );
    ({ ledger, as } = await setup({ app }));
    const pr = event({
      kind: "pr.opened",
      source: "github",
      ts: "2026-11-11T11:00:00.000Z",
      links: { pr_url: PR },
    });
    // pr.opened is the server's to write; a person token is refused it.
    await ledger.append([pr], { team: "web" });
  });

  afterAll(async () => {
    await ledger.close();
  });

  it("posts the link once and updates that comment on later shares", async () => {
    const share = () =>
      as.ana(`/v1/runs/${RUN}/share`, "POST", {}).then((res) => json<RunShareResponse>(res));
    const first = await share();
    expect(first.status).toBe(200);
    expect(first.body.comments).toEqual([expect.objectContaining({ pr: PR, action: "created" })]);
    const comments = github.pull("acme/api", 7).comments;
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain(`${PUBLIC_URL}/?screen=run&run=${RUN}`);
    expect(comments[0]?.body).not.toContain("@example.com");

    expect((await share()).body.comments[0]?.action).toBe("unchanged");
    const cost = event({
      kind: "cost.recorded",
      source: "otel",
      ts: "2026-11-11T11:30:00.000Z",
      cost: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        usd: 1,
        estimated: false,
      },
    });
    expect((await as.ana("/v1/events", "POST", { events: [cost] })).status).toBe(200);
    expect((await share()).body.comments[0]?.action).toBe("updated");
    expect(github.pull("acme/api", 7).comments).toHaveLength(1);
    expect(github.pull("acme/api", 7).comments[0]?.body).toContain("$1.42 so far");
  });

  it("posts nothing when asked not to", async () => {
    const quiet = await json<RunShareResponse>(
      await as.mia(`/v1/runs/${RUN}/share`, "POST", { comment: false }),
    );
    expect(quiet.body.skipped).toBe("Not asked to post on GitHub.");
  });
});
