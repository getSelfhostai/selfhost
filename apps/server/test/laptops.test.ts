import { type Ledger, openLedger } from "@selfhost/ledger";
import {
  createValidator,
  type JoinResponse,
  type LaptopHeartbeat,
  type LedgerEvent,
  type TeamLaptopsResponse,
  TeamLaptopsResponseSchema,
} from "@selfhost/schema";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { laptopRows } from "../src/laptops.js";
import { caller, TOKEN } from "./helpers.js";

const NOW = new Date("2026-11-08T12:00:00.000Z");
const POLICY =
  'version = 1\n\n[[rules]]\nid = "no-rm"\nmode = "enforce"\nmatch = { command = "rm -rf" }\naction = "block"\nmessage = "No."\n';

let ledger: Ledger;
let app: Hono;
let admin: ReturnType<typeof caller>;
let owner: ReturnType<typeof caller>;
let dan: ReturnType<typeof caller>;
let teamHash: string;
let next = 1;

const machine = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

function beat(overrides: Partial<LaptopHeartbeat> = {}): LaptopHeartbeat {
  return {
    schema: "selfhost.laptop_heartbeat/v1",
    machine: machine(1),
    hostname: "ada-mbp",
    platform: "darwin",
    selfhost_version: "0.4.0",
    policy_hash: null,
    managed: { state: "current", files: 5, pending: 0 },
    ...overrides,
  };
}

/** A heartbeat with no actor: the server fills in the person the token belongs to. */
function event(ts: string, heartbeat: unknown): Omit<LedgerEvent, "actor"> {
  const n = next++;
  return {
    id: `01930c4e-2f1a-7b2c-9d3e-${n.toString(16).padStart(12, "0")}`,
    schema: "selfhost.event/v1",
    ts,
    source: "cli",
    kind: "config.reported",
    data: { heartbeat },
  };
}

beforeAll(async () => {
  ledger = await openLedger({ dataDir: "memory://" });
  app = createApp({ version: "1.2.3", ledger, token: TOKEN, now: () => NOW });
  admin = caller(app, TOKEN);
  const join = async (invite: string, person: string) =>
    ((await (await admin("/v1/join", "POST", { invite, person })).json()) as JoinResponse).token;
  const web = (await (await admin("/v1/teams", "POST", { name: "Web" })).json()) as {
    invite: string;
  };
  owner = caller(app, await join(web.invite, "ada@example.com"));
  await join(web.invite, "mia@example.com");
  const set = await owner("/v1/policy", "PUT", { text: POLICY });
  teamHash = ((await set.json()) as { hash: string }).hash;
  const data = (await (await admin("/v1/teams", "POST", { name: "Data" })).json()) as {
    invite: string;
  };
  dan = caller(app, await join(data.invite, "dan@example.com"));

  const written = await owner("/v1/events", "POST", {
    events: [
      // An older heartbeat of the same laptop is superseded by the newer one.
      event("2026-11-01T09:00:00.000Z", beat({ policy_hash: null })),
      event("2026-11-08T09:00:00.000Z", beat({ policy_hash: teamHash })),
      // Another laptop of Ada's: on the old policy, its files pending.
      event(
        "2026-11-08T10:00:00.000Z",
        beat({
          machine: machine(2),
          hostname: "ada-linux",
          platform: "linux",
          policy_hash: "a".repeat(64),
          managed: { state: "pending", files: 5, pending: 2 },
        }),
      ),
      // Silent for ten days.
      event(
        "2026-10-29T10:00:00.000Z",
        beat({ machine: machine(3), hostname: "old-box", policy_hash: teamHash }),
      ),
      // Not a heartbeat this server reads.
      event("2026-11-08T11:00:00.000Z", {
        schema: "selfhost.laptop_heartbeat/v9",
        machine: machine(4),
      }),
    ],
  });
  expect(written.status, await written.clone().text()).toBe(200);
  // Dan's laptop belongs to another team.
  const other = await dan("/v1/events", "POST", {
    events: [event("2026-11-08T09:00:00.000Z", beat({ machine: machine(5) }))],
  });
  expect(other.status).toBe(200);
});

afterAll(async () => {
  await ledger.close();
});

const read = async (as: ReturnType<typeof caller>, path: string) => {
  const res = await as(path);
  expect(res.status, await res.clone().text()).toBe(200);
  const body = (await res.json()) as TeamLaptopsResponse;
  const valid = createValidator(TeamLaptopsResponseSchema).validate(body);
  expect(valid.ok ? [] : valid.errors).toEqual([]);
  return body;
};

describe("GET /v1/teams/{team}/laptops", () => {
  it("lists each laptop's newest heartbeat, flagged ones first", async () => {
    const body = await read(owner, "/v1/teams/web/laptops");
    expect(body).toMatchObject({ team: "web", policy_hash: teamHash, silent_days: 7 });
    expect(body.laptops.map((row) => [row.hostname, row.status, row.flags])).toEqual([
      ["old-box", "silent", ["silent"]],
      ["ada-linux", "behind", ["behind", "not_installed"]],
      ["ada-mbp", "current", []],
    ]);
    expect(body.laptops[2]).toMatchObject({
      machine: machine(1),
      person: "ada@example.com",
      platform: "darwin",
      selfhost_version: "0.4.0",
      last_heartbeat: "2026-11-08T09:00:00.000Z",
    });
    expect(body.people_without_heartbeat).toEqual(["mia@example.com"]);
  });

  it("takes the silent window from the query", async () => {
    const body = await read(admin, "/v1/teams/web/laptops?silent_days=30");
    expect(body.silent_days).toBe(30);
    expect(body.laptops.find((row) => row.hostname === "old-box")?.status).toBe("current");
    expect((await admin("/v1/teams/web/laptops?silent_days=0")).status).toBe(400);
    expect((await admin("/v1/teams/web/laptops?days=3")).status).toBe(400);
  });

  it("keeps each team's laptops to the people who can read it", async () => {
    expect((await read(dan, "/v1/teams/data/laptops")).laptops).toHaveLength(1);
    expect((await dan("/v1/teams/web/laptops")).status).toBe(403);
    expect((await admin("/v1/teams/nope/laptops")).status).toBe(404);
  });
});

describe("laptopRows", () => {
  it("does not flag behind when the team has no policy", () => {
    const rows = laptopRows(
      [
        {
          actor_id: "ada@example.com",
          ts: NOW,
          heartbeat: beat({ managed: { state: "off", files: 3, pending: 3 } }),
        },
      ],
      { policyHash: null, silentDays: 7, now: NOW },
    );
    expect(rows.map((row) => row.flags)).toEqual([["not_installed"]]);
  });
});
