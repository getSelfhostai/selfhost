import { describe, expect, it } from "vitest";
import { routeItem } from "../src/routing.js";
import { config } from "./helpers.js";

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
