import { databaseOf } from "@selfhost/ledger";
import {
  type CreateTeamResponse,
  createValidator,
  type JoinResponse,
  type LedgerEvent,
  type TeamOverview,
  USAGE_METRICS,
  type UsageDimension,
  type UsageResponse,
  UsageResponseSchema,
  type UsageRow,
} from "@selfhost/schema";
import { COST_SOURCE_PREFERENCE } from "@selfhost/spend";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { BACKENDS, caller, TOKEN } from "./helpers.js";

/**
 * A seeded ledger for the usage views: org Acme with teams Web (repo acme/site) and Data (repo
 * acme/etl), spend from OpenTelemetry, local logs and the gateway, one session that two sources
 * report, a run whose repo moves it to another team, pull requests opened and merged, events
 * with no team written with the admin token, and one event outside the range. Every view is
 * checked against SQL written directly on the events table.
 */

const NOW = new Date("2026-11-20T12:00:00.000Z");
const FROM = "2026-11-01T00:00:00.000Z";
const TO = "2026-11-21T00:00:00.000Z";
const RANGE = `from=${FROM}&to=${TO}`;
const SITE = "https://github.com/acme/site/pull";

let n = 0;
const event = (overrides: Partial<LedgerEvent>): LedgerEvent => ({
  id: `01930c4e-2f1a-7b2c-9d3e-${(++n).toString(16).padStart(12, "0")}`,
  schema: "selfhost.event/v1",
  ts: "2026-11-10T09:00:00.000Z",
  source: "hook",
  kind: "session.started",
  actor: { kind: "person", id: "x@example.com" },
  ...overrides,
});

const person = (id: string) => ({ kind: "person" as const, id });

const cost = (
  who: string,
  usd: number,
  input: number,
  overrides: Partial<LedgerEvent> = {},
): LedgerEvent =>
  event({
    kind: "cost.recorded",
    source: "otel",
    actor: person(who),
    agent: { vendor: "claude_code" },
    model: "claude-opus-4",
    cost: {
      input_tokens: input,
      output_tokens: Math.round(input / 10),
      cache_read_tokens: input * 2,
      cache_write_tokens: 7,
      usd,
      estimated: true,
    },
    ...overrides,
  });

const pr = (
  kind: "pr.opened" | "pr.merged",
  who: string,
  url: string,
  ts: string,
  overrides: Partial<LedgerEvent> = {},
): LedgerEvent =>
  event({
    kind,
    source: "github",
    ts,
    actor: person(who),
    target: { type: "pr", value: url },
    links: { pr_url: url },
    ...overrides,
  });

const WENDY = "wendy@example.com";
const LEAD = "lead@example.com";
const DAN = "dan@example.com";
const DORA = "dora@example.com";

/** What each person writes with their own token. */
const WRITES: Record<string, LedgerEvent[]> = {
  [WENDY]: [
    // One Claude Code session reported by OpenTelemetry and by the local logs.
    event({
      actor: person(WENDY),
      agent: { vendor: "claude_code" },
      session_id: "s-w1",
      repo: "acme/site",
    }),
    cost(WENDY, 1.5, 1000, { session_id: "s-w1", ts: "2026-11-10T09:05:00.000Z" }),
    cost(WENDY, 0.25, 200, {
      session_id: "s-w1",
      ts: "2026-11-10T09:06:00.000Z",
      model: "claude-haiku-4",
    }),
    cost(WENDY, 1.4, 900, {
      session_id: "s-w1",
      ts: "2026-11-10T09:05:00.000Z",
      source: "local_log",
    }),
    // A Codex session with no repo: the team of the token that wrote it.
    event({
      actor: person(WENDY),
      agent: { vendor: "codex" },
      session_id: "s-w2",
      ts: "2026-11-11T09:59:00.000Z",
    }),
    cost(WENDY, 0.8, 500, {
      session_id: "s-w2",
      ts: "2026-11-11T10:00:00.000Z",
      source: "local_log",
      agent: { vendor: "codex" },
      model: "gpt-5-codex",
    }),
    // Before the range.
    cost(WENDY, 9.99, 9999, { session_id: "s-w0", ts: "2026-10-20T10:00:00.000Z" }),
    pr("pr.opened", WENDY, `${SITE}/2`, "2026-11-14T08:00:00.000Z", { repo: "acme/site" }),
  ],
  [LEAD]: [
    event({
      kind: "prompt.submitted",
      actor: person(LEAD),
      agent: { vendor: "claude_code" },
      session_id: "s-l1",
      repo: "acme/site",
      ts: "2026-11-12T10:00:00.000Z",
    }),
    cost(LEAD, 2, 1500, {
      session_id: "s-l1",
      ts: "2026-11-12T10:01:00.000Z",
      source: "local_log",
    }),
    // The same pull request from a scan and from the webhook: counted once.
    pr("pr.opened", LEAD, `${SITE}/1`, "2026-11-12T11:00:00.000Z", {
      repo: "acme/site",
      agent: { vendor: "claude_code" },
      model: "claude-opus-4",
    }),
    pr("pr.opened", LEAD, `${SITE}/1`, "2026-11-12T11:00:00.000Z", {
      repo: "acme/site",
      agent: { vendor: "claude_code" },
      model: "claude-opus-4",
    }),
    pr("pr.merged", LEAD, `${SITE}/1`, "2026-11-13T09:00:00.000Z", {
      repo: "acme/site",
      agent: { vendor: "claude_code" },
      model: "claude-opus-4",
    }),
  ],
  [DAN]: [
    // A session over midnight, in Data's repo.
    cost(DAN, 0.6, 400, {
      session_id: "s-d1",
      repo: "acme/etl",
      ts: "2026-11-12T23:30:00.000Z",
      model: "claude-sonnet-4",
    }),
    cost(DAN, 0.6, 400, {
      session_id: "s-d1",
      ts: "2026-11-13T00:30:00.000Z",
      model: "claude-sonnet-4",
    }),
    // Dan works in Web's repo: the run is Web's.
    cost(DAN, 0.3, 300, {
      session_id: "s-d2",
      repo: "acme/site",
      ts: "2026-11-14T10:00:00.000Z",
      agent: { vendor: "codex" },
      model: "gpt-5",
    }),
  ],
  [DORA]: [
    // Gateway spend has no session.
    cost(DORA, 0.1, 100, { source: "gateway", ts: "2026-11-15T10:00:00.000Z" }),
    pr("pr.opened", DORA, "https://github.com/acme/etl/pull/5", "2026-11-15T09:00:00.000Z", {
      repo: "acme/etl",
      agent: { vendor: "codex" },
    }),
    pr("pr.merged", DORA, "https://github.com/acme/etl/pull/5", "2026-11-16T09:00:00.000Z", {
      repo: "acme/etl",
      agent: { vendor: "codex" },
    }),
  ],
};

/** Written with the admin token, as a laptop or the OTLP receiver writes: no team. */
const ADMIN_WRITES: LedgerEvent[] = [
  cost("solo@example.com", 0.05, 50, { session_id: "s-x1", ts: "2026-11-16T10:00:00.000Z" }),
  cost("=HYPERLINK(1)", 0.01, 10, { source: "vendor_api", ts: "2026-11-16T11:00:00.000Z" }),
  cost("bot", 0.02, 20, {
    actor: { kind: "agent", id: "bot" },
    agent: { vendor: "codex" },
    session_id: "s-x2",
    ts: "2026-11-17T10:00:00.000Z",
    model: "gpt-5",
  }),
];

const TEAM_SQL = "coalesce(tr.team_id, e.team)";
const DIRECT_DIMENSION: Record<UsageDimension, string> = {
  team: `coalesce(${TEAM_SQL}, 'unknown')`,
  person: "CASE WHEN e.actor_kind = 'person' THEN e.actor_id ELSE 'unknown' END",
  agent: "coalesce(e.agent, 'unknown')",
  model: "coalesce(e.model, 'unknown')",
  day: "to_char(e.ts AT TIME ZONE 'UTC', 'YYYY-MM-DD')",
};
const RANK = (alias: string) =>
  `array_position(ARRAY[${COST_SOURCE_PREFERENCE.map((s) => `'${s}'`).join(",")}]::text[], ${alias}.source)`;
const FROM_EVENTS = `events e
  LEFT JOIN run_repos rr ON rr.session_id = e.session_id
  LEFT JOIN team_repos tr ON tr.org_id = 'acme'
    AND tr.repo = coalesce(lower(e.body->>'repo'), rr.repo)`;

interface Filters {
  team?: string;
  person?: string;
  agent?: string;
  model?: string;
  from?: string;
  to?: string;
}

/** The scope and filters of a query, as plain SQL conditions. */
function conditions(filters: Filters, teams: string[] | null): string {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const parts = [
    `e.ts >= ${quote(filters.from ?? FROM)}::timestamptz`,
    `e.ts < ${quote(filters.to ?? TO)}::timestamptz`,
    teams === null
      ? `(${TEAM_SQL} IS NULL OR ${TEAM_SQL} IN (SELECT id FROM teams WHERE org_id = 'acme'))`
      : `${TEAM_SQL} IN (${teams.map(quote).join(", ")})`,
  ];
  for (const name of ["team", "person", "agent", "model"] as const) {
    const value = filters[name];
    if (value !== undefined) parts.push(`${DIRECT_DIMENSION[name]} = ${quote(value)}`);
  }
  return parts.join(" AND ");
}

type Totals = Record<Exclude<(typeof USAGE_METRICS)[number], "cache_hit_rate">, number> & {
  cache_hit_rate: number | null;
};

/** The same view, from SQL on the events table: spend, sessions and pull requests per group. */
async function direct(
  db: ReturnType<typeof databaseOf>,
  groupBy: UsageDimension[],
  filters: Filters,
  teams: string[] | null,
): Promise<Map<string, Totals>> {
  const key = groupBy.length ? groupBy.map((d) => DIRECT_DIMENSION[d]).join(` || '|' || `) : "''";
  const where = conditions(filters, teams);
  const spend = await db.query<Record<string, string | number>>(
    `SELECT ${key} AS key,
       round(sum((e.body#>>'{cost,usd}')::numeric), 6)::float8 AS usd,
       sum((e.body#>>'{cost,input_tokens}')::int)::float8 AS input_tokens,
       sum((e.body#>>'{cost,output_tokens}')::int)::float8 AS output_tokens,
       sum((e.body#>>'{cost,cache_read_tokens}')::int)::float8 AS cache_read_tokens,
       sum((e.body#>>'{cost,cache_write_tokens}')::int)::float8 AS cache_write_tokens,
       count(*)::int AS requests
     FROM ${FROM_EVENTS}
     WHERE e.kind = 'cost.recorded' AND ${where}
       AND NOT EXISTS (
         SELECT 1 FROM events o
         WHERE o.kind = 'cost.recorded' AND o.session_id = e.session_id
           AND coalesce(o.agent, '') = coalesce(e.agent, '')
           AND o.ts >= ${`'${filters.from ?? FROM}'`}::timestamptz
           AND o.ts < ${`'${filters.to ?? TO}'`}::timestamptz
           AND ${RANK("o")} < ${RANK("e")}
       )
     GROUP BY 1`,
  );
  // Hook events name no model: they leave a session out of the unknown model when its other
  // events name one.
  const modelRule = `AND (e.model IS NOT NULL OR NOT EXISTS (
         SELECT 1 FROM events o WHERE o.session_id = e.session_id AND o.model IS NOT NULL
           AND o.kind IN ('session.started', 'session.ended', 'prompt.submitted', 'cost.recorded')
           AND o.ts >= ${`'${filters.from ?? FROM}'`}::timestamptz
           AND o.ts < ${`'${filters.to ?? TO}'`}::timestamptz))`;
  const sessions = await db.query<{ key: string; sessions: number }>(
    `SELECT ${key} AS key,
       count(DISTINCT coalesce(e.agent, '') || '/' || e.session_id)::int AS sessions
     FROM ${FROM_EVENTS}
     WHERE e.kind IN ('session.started', 'session.ended', 'prompt.submitted', 'cost.recorded')
       AND coalesce(e.session_id, '') <> '' AND ${where} ${modelRule}
     GROUP BY 1`,
  );
  const prs = await db.query<{ key: string; prs_opened: number; prs_merged: number }>(
    `SELECT ${key} AS key,
       count(DISTINCT e.body#>>'{links,pr_url}') FILTER (WHERE e.kind = 'pr.opened')::int
         AS prs_opened,
       count(DISTINCT e.body#>>'{links,pr_url}') FILTER (WHERE e.kind = 'pr.merged')::int
         AS prs_merged
     FROM ${FROM_EVENTS}
     WHERE e.kind IN ('pr.opened', 'pr.merged') AND ${where}
     GROUP BY 1`,
  );
  const out = new Map<string, Totals>();
  const at = (k: string) => {
    let totals = out.get(k);
    if (!totals) {
      totals = Object.fromEntries(USAGE_METRICS.map((m) => [m, 0])) as Totals;
      totals.cache_hit_rate = null;
      out.set(k, totals);
    }
    return totals;
  };
  for (const row of spend) {
    const totals = at(String(row.key));
    for (const metric of [
      "usd",
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "requests",
    ] as const) {
      totals[metric] = Number(row[metric]);
    }
    totals.tokens =
      totals.input_tokens +
      totals.output_tokens +
      totals.cache_read_tokens +
      totals.cache_write_tokens;
    // Every cost event here reports cache tokens, so every session's rate is known.
    const input = totals.cache_read_tokens + totals.input_tokens + totals.cache_write_tokens;
    totals.cache_hit_rate =
      input > 0 ? Math.round((totals.cache_read_tokens / input) * 1e6) / 1e6 : null;
  }
  for (const row of sessions) at(row.key).sessions = Number(row.sessions);
  for (const row of prs) {
    at(row.key).prs_opened = Number(row.prs_opened);
    at(row.key).prs_merged = Number(row.prs_merged);
  }
  return out;
}

const metricsOf = (row: UsageRow | Totals): Totals =>
  Object.fromEntries(USAGE_METRICS.map((m) => [m, row[m]])) as Totals;

const keyOf = (row: UsageRow, groupBy: UsageDimension[]) =>
  groupBy.map((d) => row.group[d]).join("|");

const valid = createValidator(UsageResponseSchema);

/** Parses the CSV this server writes: quoted fields with "" for a quote, CRLF lines. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\r" && text[i + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
    } else field += char;
  }
  return rows;
}

describe.each(BACKENDS)("usage views on a seeded ledger on $name", (backend) => {
  let store: Awaited<ReturnType<(typeof BACKENDS)[number]["open"]>>;
  let app: Hono;
  let admin: ReturnType<typeof caller>;
  const as = {} as Record<string, ReturnType<typeof caller>>;

  const join = async (invite: string, id: string) => {
    const res = await app.request("/v1/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invite, person: id }),
    });
    expect(res.status).toBe(200);
    as[id] = caller(app, ((await res.json()) as JoinResponse).token);
  };

  const usage = async (who: ReturnType<typeof caller>, query: string) => {
    const res = await who(`/v1/usage?${query}`);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as UsageResponse;
    const checked = valid.validate(body);
    expect(checked.ok ? [] : checked.errors).toEqual([]);
    return body;
  };

  beforeAll(async () => {
    if (backend.skip) return;
    store = await backend.open();
    app = createApp({ version: "test", ledger: store.ledger, token: TOKEN, now: () => NOW });
    admin = caller(app, TOKEN);
    expect((await admin("/v1/orgs", "POST", { name: "Acme" })).status).toBe(201);
    const team = async (name: string) =>
      (await (
        await admin("/v1/teams", "POST", { name, org: "acme" })
      ).json()) as CreateTeamResponse;
    const web = await team("Web");
    const data = await team("Data");
    await join(web.invite, LEAD);
    await join(web.invite, WENDY);
    await join(data.invite, DORA);
    await join(data.invite, DAN);
    const lead = as[LEAD];
    const dora = as[DORA];
    if (!lead || !dora) throw new Error("not joined");
    expect((await lead("/v1/teams/web/repos", "POST", { remote: "acme/site" })).status).toBe(201);
    expect((await dora("/v1/teams/data/repos", "POST", { remote: "acme/etl" })).status).toBe(201);
    // Pull requests come from the server (the GitHub App's webhook, background runs), which
    // writes with its own access; a person token cannot write them.
    const fromGitHub = (event: LedgerEvent) =>
      event.kind === "pr.merged" || event.kind === "pr.opened";
    for (const [id, events] of Object.entries(WRITES)) {
      const res = await (as[id] as ReturnType<typeof caller>)("/v1/events", "POST", {
        events: events.filter((event) => !fromGitHub(event)),
      });
      expect(res.status, await res.clone().text()).toBe(200);
    }
    const merges = Object.values(WRITES).flat().filter(fromGitHub);
    expect(
      (await admin("/v1/events", "POST", { events: [...ADMIN_WRITES, ...merges] })).status,
    ).toBe(200);
  });

  afterAll(async () => {
    await store?.close();
  });

  const GROUPINGS: UsageDimension[][] = [
    [],
    ["team"],
    ["person"],
    ["agent"],
    ["model"],
    ["day"],
    ["day", "model"],
    ["team", "person"],
  ];
  const FILTERS: Filters[] = [
    {},
    { team: "web" },
    { team: "unknown" },
    { person: WENDY },
    { agent: "codex" },
    { model: "claude-opus-4" },
    { model: "unknown" },
    { team: "web", agent: "claude_code" },
    { from: "2026-11-12T00:00:00.000Z", to: "2026-11-14T00:00:00.000Z" },
  ];

  const queryOf = (groupBy: UsageDimension[], filters: Filters) => {
    const params = new URLSearchParams({ from: FROM, to: TO, org: "acme" });
    for (const [name, value] of Object.entries(filters)) params.set(name, value);
    if (groupBy.length > 0) params.set("group_by", groupBy.join(","));
    return params.toString();
  };

  for (const groupBy of GROUPINGS) {
    it.skipIf(backend.skip)(
      `matches SQL on the events table grouped by ${groupBy.join(",") || "nothing"}, for every filter`,
      async () => {
        const db = databaseOf(store.ledger);
        for (const filters of FILTERS) {
          const body = await usage(admin, queryOf(groupBy, filters));
          const expected = await direct(db, groupBy, filters, null);
          const label = JSON.stringify(filters);
          if (groupBy.length === 0) {
            expect(metricsOf(body.total), label).toEqual(expected.get("") ?? metricsOf(body.total));
            continue;
          }
          const got = new Map(body.rows.map((row) => [keyOf(row, groupBy), metricsOf(row)]));
          expect(Object.fromEntries(got), label).toEqual(Object.fromEntries(expected));
          const total = (await direct(db, [], filters, null)).get("");
          if (total) expect(metricsOf(body.total), label).toEqual(total);
        }
      },
    );
  }

  it.skipIf(backend.skip)("counts each session's spend from one source", async () => {
    const body = await usage(admin, `${RANGE}&org=acme&person=${WENDY}&agent=claude_code`);
    // OpenTelemetry's 1.50 and 0.25, not the local log's 1.40 for the same session.
    expect(body.total).toMatchObject({ usd: 1.75, requests: 2, sessions: 1 });
  });

  it.skipIf(backend.skip)("puts a run in the team that owns its repo", async () => {
    const body = await usage(admin, `${RANGE}&org=acme&person=${DAN}&group_by=team`);
    expect(body.rows.map((row) => [row.group.team, row.usd])).toEqual([
      ["data", 1.2],
      ["web", 0.3],
    ]);
  });

  it.skipIf(backend.skip)("counts a pull request once however many events report it", async () => {
    const body = await usage(admin, `${RANGE}&org=acme&group_by=person`);
    const lead = body.rows.find((row) => row.group.person === LEAD);
    expect(lead).toMatchObject({ prs_opened: 1, prs_merged: 1 });
    expect(body.total).toMatchObject({ prs_opened: 3, prs_merged: 2 });
  });

  it.skipIf(backend.skip)("counts a session in every day it ran", async () => {
    const body = await usage(admin, `${RANGE}&org=acme&person=${DAN}&team=data&group_by=day`);
    expect(body.rows.map((row) => [row.group.day, row.sessions, row.usd])).toEqual([
      ["2026-11-12", 1, 0.6],
      ["2026-11-13", 1, 0.6],
    ]);
    expect(body.total.sessions).toBe(1);
  });

  it.skipIf(backend.skip)("leaves hook events out of the unknown model of a session", async () => {
    const body = await usage(admin, `${RANGE}&org=acme&person=${WENDY}&group_by=model`);
    const withSessions = body.rows.filter((row) => row.sessions > 0);
    expect(withSessions.map((row) => [row.group.model, row.sessions])).toEqual([
      ["claude-opus-4", 1],
      ["gpt-5-codex", 1],
      ["claude-haiku-4", 1],
    ]);
  });

  it.skipIf(backend.skip)("agrees with the team overview's spend", async () => {
    for (const team of ["web", "data"]) {
      const overview = (await (
        await admin(`/v1/teams/${team}/overview?${RANGE}`)
      ).json()) as TeamOverview;
      const total = (await usage(admin, `${RANGE}&org=acme&team=${team}`)).total;
      expect({ usd: total.usd, tokens: total.tokens, requests: total.requests }).toEqual(
        overview.spend,
      );
      for (const [dimension, list] of [
        ["person", overview.by_person],
        ["agent", overview.by_agent],
        ["model", overview.by_model],
      ] as const) {
        const rows = (await usage(admin, `${RANGE}&org=acme&team=${team}&group_by=${dimension}`))
          .rows;
        expect(
          rows
            .filter((row) => row.requests > 0)
            .map((row) => ({
              key: row.group[dimension],
              usd: row.usd,
              tokens: row.tokens,
              requests: row.requests,
            })),
        ).toEqual(list.filter((share) => share.requests > 0));
      }
    }
  });

  it.skipIf(backend.skip)("exports exactly the rows of the view as CSV", async () => {
    for (const groupBy of GROUPINGS) {
      for (const filters of FILTERS) {
        const query = queryOf(groupBy, filters);
        const body = await usage(admin, query);
        const res = await admin(`/v1/usage.csv?${query}`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
        expect(res.headers.get("content-disposition")).toMatch(
          /^attachment; filename="selfhost-usage-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv"$/,
        );
        const [header, ...lines] = parseCsv(await res.text());
        expect(header).toEqual([...groupBy, ...USAGE_METRICS]);
        expect(lines).toEqual(
          body.rows.map((row) => [
            ...groupBy.map((d) => {
              const value = row.group[d] ?? "";
              return /^[=+\-@]/.test(value) ? `'${value}` : value;
            }),
            ...USAGE_METRICS.map((m) => (row[m] === null ? "" : String(row[m]))),
          ]),
        );
      }
    }
  });

  it.skipIf(backend.skip)("keeps text a spreadsheet would run from being a formula", async () => {
    const res = await admin(`/v1/usage.csv?${RANGE}&org=acme&group_by=person&team=unknown`);
    const text = await res.text();
    expect(text).toContain("\r\n'=HYPERLINK(1),");
    expect(text).not.toMatch(/(^|\n)=/);
  });

  describe("roles", () => {
    it.skipIf(backend.skip)("show a member only the teams they are in", async () => {
      const wendy = as[WENDY] as ReturnType<typeof caller>;
      const body = await usage(wendy, `${RANGE}&group_by=team`);
      expect(body.teams).toEqual(["web"]);
      expect(body.org).toBe("acme");
      expect(body.rows.map((row) => row.group.team)).toEqual(["web"]);
      const expected = await direct(databaseOf(store.ledger), [], {}, ["web"]);
      expect(metricsOf(body.total)).toEqual(expected.get(""));
      // Everyone's usage in their team, as the team overview shows it.
      const people = await usage(wendy, `${RANGE}&group_by=person`);
      expect(people.rows.map((row) => row.group.person).sort()).toEqual([DAN, LEAD, WENDY]);
    });

    it.skipIf(backend.skip)("refuse a team the caller is not in, and another org", async () => {
      const dan = as[DAN] as ReturnType<typeof caller>;
      const refused = await dan(`/v1/usage?${RANGE}&team=web`);
      expect(refused.status).toBe(403);
      expect((await dan(`/v1/usage.csv?${RANGE}&team=web`)).status).toBe(403);
      expect((await dan(`/v1/usage?${RANGE}&org=default`)).status).toBe(403);
      // The run Dan did in Web's repo is Web's, so Dan does not see it.
      const own = await usage(dan, `${RANGE}&person=${DAN}`);
      expect(own.total.usd).toBe(1.2);
    });

    it.skipIf(backend.skip)("give a lead in both teams the cross-team view", async () => {
      const dora = as[DORA] as ReturnType<typeof caller>;
      expect(
        (await dora("/v1/teams/data/people", "POST", { person: LEAD, role: "admin" })).status,
      ).toBe(201);
      const lead = as[LEAD] as ReturnType<typeof caller>;
      const body = await usage(lead, `${RANGE}&group_by=team`);
      expect(body.teams).toEqual(["data", "web"]);
      expect(body.rows.map((row) => row.group.team).sort()).toEqual(["data", "web"]);
      const expected = await direct(databaseOf(store.ledger), [], {}, ["data", "web"]);
      expect(metricsOf(body.total)).toEqual(expected.get(""));
    });

    it.skipIf(backend.skip)("give the admin token events with no team too", async () => {
      const body = await usage(admin, `${RANGE}&org=acme&group_by=team`);
      expect(body.teams).toBeNull();
      expect(body.rows.map((row) => row.group.team).sort()).toEqual(["data", "unknown", "web"]);
      expect((await admin(`/v1/usage?${RANGE}&org=nope`)).status).toBe(404);
    });
  });

  it.skipIf(backend.skip)("refuses an invalid query", async () => {
    for (const query of [
      "group_by=repo",
      "group_by=day,team,person",
      "from=2026-11-10T00:00:00Z&to=2026-11-01T00:00:00Z",
      "from=yesterday",
      "colour=blue",
    ]) {
      const res = await admin(`/v1/usage?${query}`);
      expect(res.status, query).toBe(400);
    }
    expect((await app.request(`/v1/usage?${RANGE}`)).status).toBe(401);
  });

  it.skipIf(backend.skip)("defaults to the 30 days before now", async () => {
    const body = await usage(admin, "org=acme");
    expect(body.to).toBe(NOW.toISOString());
    expect(body.from).toBe("2026-10-21T12:00:00.000Z");
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]?.group).toEqual({});
  });
});
