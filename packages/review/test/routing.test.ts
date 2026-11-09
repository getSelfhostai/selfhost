import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type PersonRole, parseConfig, type ReviewItemKind } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import {
  codeOwnersOf,
  codeOwnersRegex,
  codeOwnersRuleFor,
  parseCodeOwners,
} from "../src/codeowners.js";
import { escalateRoute, explainRoutes, routeItem } from "../src/routing.js";
import { config, FIXTURES } from "./helpers.js";

const routed = config(`
[review]
fallback = ["lead@example.com"]

[review.owners]
"db/**" = ["dba@example.com"]
"infra/**" = ["ops@example.com", "dba@example.com"]

[teams.platform]
members = ["pat@example.com", "sam@example.com"]

[teams.empty]
members = []
`);

describe("routeItem", () => {
  it("1. owner: the people of every [review.owners] glob the files match, in file order", () => {
    const result = routeItem(routed, {
      paths: ["./infra/main.tf", "db/migrations/0042.sql"],
      person: "dev@example.com",
      team: "platform",
    });
    expect(result).toEqual({
      owners: ["dba@example.com", "ops@example.com"],
      route: { step: "owner", from: '[review.owners] "db/**", [review.owners] "infra/**"' },
    });
  });

  it("1. owner: the session's person when no glob matches", () => {
    const result = routeItem(routed, {
      paths: ["src/app.ts"],
      person: "dev@example.com",
      team: "platform",
    });
    expect(result).toEqual({
      owners: ["dev@example.com"],
      route: { step: "owner", from: "the session's person" },
    });
  });

  it("2. team: the members of the item's team when there is no owner", () => {
    const result = routeItem(routed, { paths: [], team: "platform" });
    expect(result).toEqual({
      owners: ["pat@example.com", "sam@example.com"],
      route: { step: "team", from: "[teams.platform]" },
    });
  });

  it("3. fallback: [review] fallback when there is no owner and no team with members", () => {
    for (const team of [undefined, "unknown", "empty"]) {
      expect(routeItem(routed, { paths: ["src/app.ts"], team })).toEqual({
        owners: ["lead@example.com"],
        route: { step: "fallback", from: "[review] fallback" },
      });
    }
  });

  it("names nobody when selfhost.toml has no owner, team or fallback for the item", () => {
    expect(routeItem(config(), { paths: ["db/x.sql"] })).toEqual({
      owners: [],
      route: { step: "none", from: "selfhost.toml names no owner, team or fallback for it" },
    });
  });
});

const ROUTING = join(FIXTURES, "routing");
const matrix = JSON.parse(readFileSync(join(ROUTING, "cases.json"), "utf8")) as {
  roles: Record<PersonRole, string[]>;
  cases: {
    id: string;
    input: {
      kind: ReviewItemKind;
      repo?: string;
      paths: string[];
      risk?: number;
      rule_id?: string;
      tool?: string;
      person?: string;
      team?: string;
    };
    roles?: boolean;
    codeowners?: boolean;
    step: string;
    route?: string;
    owners: string[];
    github?: { users: string[]; teams: string[] };
    why?: string;
  }[];
};
const routes = (() => {
  const parsed = parseConfig(readFileSync(join(ROUTING, "selfhost.toml"), "utf8"));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.config;
})();
const codeowners = parseCodeOwners(readFileSync(join(ROUTING, "CODEOWNERS"), "utf8"));

describe("routeItem with [[review.routes]]: the routing matrix in fixtures/routing", () => {
  it.each(matrix.cases)("$id", (c) => {
    const { rule_id, ...rest } = c.input;
    const result = routeItem(
      routes,
      { ...rest, ...(rule_id ? { ruleId: rule_id } : {}) },
      {
        ...(c.roles ? { roles: matrix.roles } : {}),
        ...(c.codeowners ? { codeowners } : {}),
      },
    );
    expect(result.owners).toEqual(c.owners);
    expect(result.route.step).toBe(c.step);
    expect(result.route.id).toBe(c.route);
    expect(result.route.github).toEqual(c.github);
    if (c.why) expect(result.route.why).toBe(c.why);
  });
});

describe("routeByRules", () => {
  it("sets escalates_at from the route's escalate_after_minutes and the given time", () => {
    const now = new Date("2026-11-10T10:00:00.000Z");
    const result = routeItem(routes, { kind: "pr", paths: ["db/a.sql"] }, { now });
    expect(result.route).toEqual({
      step: "route",
      from: '[[review.routes]] "prod-db"',
      id: "prod-db",
      why: "kind pr, path db/a.sql",
      escalates_at: "2026-11-10T10:30:00.000Z",
    });
  });

  it("keeps only eligible people, and skips a route that leaves nobody", () => {
    const eligible = (person: string) => person !== "dba@example.com";
    const result = routeItem(
      routes,
      { kind: "exception", paths: ["db/a.sql"] },
      { roles: matrix.roles, eligible },
    );
    expect(result.route.id).toBe("db-admins");
    expect(result.owners).toEqual(["adam@example.com", "olga@example.com"]);
  });
});

describe("escalateRoute", () => {
  const now = new Date("2026-11-10T11:00:00.000Z");
  const input = { kind: "pr" as const, paths: ["db/a.sql"] };

  it("moves to the next route that matches, keeping the earlier owners after the new ones", () => {
    const first = routeItem(routes, input, { roles: matrix.roles });
    const { routing, escalated } = escalateRoute(routes, input, first, {
      roles: matrix.roles,
      now,
    });
    expect(escalated).toBe(true);
    expect(routing.owners).toEqual(["adam@example.com", "olga@example.com", "dba@example.com"]);
    expect(routing.route).toMatchObject({
      step: "route",
      id: "db-admins",
      escalated_from: ["prod-db"],
      escalates_at: "2026-11-10T12:00:00.000Z",
    });
  });

  it("ends at [review] fallback, then stays put", () => {
    const start = routeItem(routes, input, { roles: matrix.roles });
    const second = escalateRoute(routes, input, start, { roles: matrix.roles, now }).routing;
    const third = escalateRoute(routes, input, second, { roles: matrix.roles, now });
    expect(third.escalated).toBe(true);
    expect(third.routing.route).toEqual({
      step: "fallback",
      from: "[review] fallback",
      why: 'nobody answered on [[review.routes]] "db-admins"',
      escalated_from: ["prod-db", "db-admins"],
    });
    expect(third.routing.owners[0]).toBe("lead@example.com");
    const fourth = escalateRoute(routes, input, third.routing, { now });
    expect(fourth).toEqual({ routing: third.routing, escalated: false });
  });

  it("skips a next route that names nobody here, such as role targets on a laptop", () => {
    const first = routeItem(routes, input);
    const { routing } = escalateRoute(routes, input, first, { now });
    expect(routing.route.step).toBe("fallback");
    expect(routing.owners).toEqual(["lead@example.com", "dba@example.com"]);
  });

  it("explains every route, the winner and the escalation chain", () => {
    const explained = explainRoutes(routes, input, { roles: matrix.roles });
    expect(explained.routes.map((r) => [r.id, r.matched])).toEqual([
      ["prod-db", true],
      ["db-admins", true],
      ["guardrails", false],
      ["payments-high", false],
      ["deploys", false],
      ["docs", false],
    ]);
    expect(explained.routes[2]?.why).toBe("no rule raised the item");
    expect(explained.routing.route.id).toBe("prod-db");
    expect(explained.escalation).toEqual(["db-admins", "[review] fallback"]);
  });
});

describe("CODEOWNERS", () => {
  it.each([
    ["*", "a/b/c.ts", true],
    ["*.js", "src/deep/x.js", true],
    ["*.js", "src/deep/x.ts", false],
    ["/build/logs/", "build/logs/today.log", true],
    ["/build/logs/", "src/build/logs/today.log", false],
    ["docs/*", "docs/getting-started.md", true],
    ["docs/*", "docs/build-app/troubleshooting.md", false],
    ["apps/", "web/apps/github.ts", true],
    ["**/logs", "deeply/nested/logs/x.txt", true],
    ["/scripts/**", "scripts/a/b.sh", true],
    ["src/ledger", "src/ledger/post.ts", true],
  ])("%s matches %s: %s", (pattern, path, expected) => {
    expect(codeOwnersRegex(pattern).test(path)).toBe(expected);
  });

  it("takes the last matching line, and a line with no owners takes them away", () => {
    expect(codeOwnersRuleFor(codeowners, "src/ledger/post.ts")?.owners).toEqual([
      "@bob",
      "carol@example.com",
    ]);
    expect(codeOwnersRuleFor(codeowners, "src/ledger/vendor/x.ts")?.owners).toEqual([]);
    expect(codeOwnersOf(codeowners, ["src/ledger/vendor/x.ts", "docs/a.md"])).toEqual({
      users: [],
      teams: ["docs"],
      emails: [],
    });
  });
});
