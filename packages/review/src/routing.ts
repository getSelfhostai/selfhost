import { globMatches, normalizePath } from "@selfhost/policy";
import type { ResolvedSelfhostConfig, ReviewRoute } from "@selfhost/schema";

export interface RouteInput {
  /** Files the item is about, relative to the repository root. */
  paths: readonly string[];
  /** The person whose session raised the item, when there is one. */
  person?: string;
  /** Team name from the signal, matched against [teams] in selfhost.toml. */
  team?: string;
}

export interface Routing {
  owners: string[];
  route: ReviewRoute;
}

const unique = (people: Iterable<string>) => [...new Set(people)];

/**
 * Who gets an item, from selfhost.toml, in three steps; the first that names anyone wins:
 *
 * 1. Owner: the people of every `[review.owners]` glob that matches one of the item's files, in
 *    file order; else the person whose session raised it.
 * 2. Team: the members of the item's team in `[teams]`.
 * 3. Fallback: `[review] fallback`.
 *
 * When none of them names anyone the item has no owners and every reader of the list sees it.
 */
export function routeItem(config: ResolvedSelfhostConfig, input: RouteInput): Routing {
  const paths = input.paths.map(normalizePath);
  const globs = Object.entries(config.review.owners).filter(([glob]) =>
    paths.some((path) => globMatches(glob, path)),
  );
  if (globs.length > 0) {
    return {
      owners: unique(globs.flatMap(([, people]) => people)),
      route: {
        step: "owner",
        from: globs.map(([glob]) => `[review.owners] ${JSON.stringify(glob)}`).join(", "),
      },
    };
  }
  if (input.person) {
    return { owners: [input.person], route: { step: "owner", from: "the session's person" } };
  }
  const members = input.team ? (config.teams[input.team]?.members ?? []) : [];
  if (members.length > 0) {
    return { owners: unique(members), route: { step: "team", from: `[teams.${input.team}]` } };
  }
  if (config.review.fallback.length > 0) {
    return {
      owners: unique(config.review.fallback),
      route: { step: "fallback", from: "[review] fallback" },
    };
  }
  return {
    owners: [],
    route: { step: "none", from: "selfhost.toml names no owner, team or fallback for it" },
  };
}
