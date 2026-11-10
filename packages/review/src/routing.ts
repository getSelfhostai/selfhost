import { globMatches, normalizePath } from "@selfhost/policy";
import {
  CODEOWNERS_TARGET,
  type PersonRole,
  type ResolvedSelfhostConfig,
  type ReviewItemKind,
  type ReviewRoute,
  type ReviewRouteRule,
} from "@selfhost/schema";
import { type CodeOwners, codeOwnersOf } from "./codeowners.js";

const MINUTE_MS = 60_000;

export interface RouteInput {
  /** Files the item is about, relative to the repository root. */
  paths: readonly string[];
  /** The person whose session raised the item, when there is one. */
  person?: string;
  /** Team name from the signal, matched against [teams] in selfhost.toml. */
  team?: string;
  kind?: ReviewItemKind;
  /** owner/name. */
  repo?: string;
  /** The item's risk score, after [review] high_risk_paths. */
  risk?: number;
  /** The rule that raised the item. */
  ruleId?: string;
  /** The tool an approval or exception waits on. */
  tool?: string;
}

/** What routing knows besides selfhost.toml, which depends on where it runs. */
export interface RouteContext {
  /**
   * The team's people by role, on a team server. Without it (on a laptop) `role:` targets name
   * nobody.
   */
  roles?: Partial<Record<PersonRole, readonly string[]>>;
  /** The CODEOWNERS of the item's repository, when it can be read here. */
  codeowners?: CodeOwners;
  /**
   * Why the `codeowners` target names nobody when codeowners is absent, such as "No CODEOWNERS
   * file in the repository". Default: it cannot be read here.
   */
  codeownersNote?: string;
  /** Only these people may get the item, such as the team's approvers for an exception. */
  eligible?: (person: string) => boolean;
  /** When the route is picked: escalates_at counts from here. Default: no escalates_at. */
  now?: Date;
}

export interface Routing {
  owners: string[];
  route: ReviewRoute;
}

/** One route as `explainRoutes` saw it. */
export interface RouteCheck {
  id: string;
  matched: boolean;
  /** What it matched on, or the first thing that did not match. */
  why: string;
  owners: string[];
  github: { users: string[]; teams: string[] };
  /** Why a route that matched still names nobody, such as an unreadable CODEOWNERS. */
  empty?: string;
  escalate_after_minutes?: number;
}

export interface RouteExplanation {
  /** Every [[review.routes]] entry, in the order they are checked. */
  routes: RouteCheck[];
  /** Who gets the item. */
  routing: Routing;
  /**
   * Where it goes when nobody answers: the route ids it would escalate to in turn, ending with
   * "[review] fallback" when that names someone.
   */
  escalation: string[];
}

const unique = (people: Iterable<string>) => [...new Set(people)];
const lower = (text: string) => text.toLowerCase();

/** The person id `[review] github_logins` maps a GitHub login to, compared ignoring case. */
function personOfLogin(config: ResolvedSelfhostConfig, login: string): string | undefined {
  const wanted = lower(login);
  return Object.entries(config.review.github_logins).find(([, l]) => lower(l) === wanted)?.[0];
}

/** What a route matched on, or the first field that did not match. */
function matchRoute(
  route: ReviewRouteRule,
  input: RouteInput,
): { matched: true; why: string } | { matched: false; why: string } {
  const on: string[] = [];
  if (route.kinds) {
    if (!input.kind || !route.kinds.includes(input.kind)) {
      return {
        matched: false,
        why: `kind ${input.kind ?? "unknown"} is not ${route.kinds.join(" or ")}`,
      };
    }
    on.push(`kind ${input.kind}`);
  }
  if (route.repos) {
    const repo = input.repo;
    if (!repo || !route.repos.some((glob) => globMatches(lower(glob), lower(repo)))) {
      return {
        matched: false,
        why: repo ? `repo ${repo} is not in repos` : "the item names no repo",
      };
    }
    on.push(`repo ${repo}`);
  }
  if (route.paths) {
    const paths = input.paths.map(normalizePath);
    const hit = paths.find((path) => route.paths?.some((glob) => globMatches(glob, path)));
    if (hit === undefined) {
      return {
        matched: false,
        why:
          paths.length > 0 ? `no file under ${route.paths.join(", ")}` : "the item names no files",
      };
    }
    on.push(`path ${hit}`);
  }
  if (route.min_risk !== undefined) {
    if (input.risk === undefined || input.risk < route.min_risk) {
      return { matched: false, why: `risk ${input.risk ?? "unknown"} is below ${route.min_risk}` };
    }
    on.push(`risk ${input.risk} at or above ${route.min_risk}`);
  }
  if (route.rule_ids) {
    const rule = input.ruleId;
    if (!rule || !route.rule_ids.some((glob) => globMatches(glob, rule))) {
      return {
        matched: false,
        why: rule ? `rule ${rule} is not in rule_ids` : "no rule raised the item",
      };
    }
    on.push(`rule ${rule}`);
  }
  if (route.tools) {
    const tool = input.tool;
    if (!tool || !route.tools.some((glob) => globMatches(glob, tool))) {
      return {
        matched: false,
        why: tool ? `tool ${tool} is not in tools` : "the item names no tool",
      };
    }
    on.push(`tool ${tool}`);
  }
  return { matched: true, why: on.length > 0 ? on.join(", ") : "every item" };
}

/** The people and GitHub accounts a route's `to` names for this item. */
function resolveTargets(
  config: ResolvedSelfhostConfig,
  route: ReviewRouteRule,
  input: RouteInput,
  ctx: RouteContext,
): { owners: string[]; users: string[]; teams: string[]; notes: string[] } {
  const owners: string[] = [];
  const users: string[] = [];
  const teams: string[] = [];
  const notes: string[] = [];
  const login = (name: string) => {
    users.push(name);
    const person = personOfLogin(config, name);
    if (person) owners.push(person);
  };
  for (const target of route.to) {
    if (target.startsWith("role:")) {
      const role = target.slice("role:".length) as PersonRole;
      if (ctx.roles) owners.push(...(ctx.roles[role] ?? []));
      else notes.push(`${target} needs a team server, which knows each person's role`);
    } else if (target.startsWith("team:")) {
      const name = target.slice("team:".length);
      owners.push(...(config.teams[name]?.members ?? []));
    } else if (target.startsWith("@") && target.includes("/")) {
      teams.push(target.slice(target.indexOf("/") + 1));
    } else if (target.startsWith("@")) {
      login(target.slice(1));
    } else if (target === CODEOWNERS_TARGET) {
      if (!ctx.codeowners) {
        notes.push(ctx.codeownersNote ?? "CODEOWNERS cannot be read here");
        continue;
      }
      const found = codeOwnersOf(ctx.codeowners, input.paths);
      for (const user of found.users) login(user);
      teams.push(...found.teams);
      owners.push(...found.emails);
    } else owners.push(target);
  }
  const eligible = ctx.eligible;
  const kept = eligible ? owners.filter((person) => eligible(person)) : owners;
  if (kept.length < owners.length) notes.push("some of its people may not answer this item");
  return { owners: unique(kept), users: unique(users), teams: unique(teams), notes };
}

/** GitHub accounts only count for pull requests: nobody answers other items on GitHub. */
const namesAnyone = (
  kind: RouteInput["kind"],
  r: { owners: string[]; users: string[]; teams: string[] },
) => r.owners.length > 0 || (kind === "pr" && r.users.length + r.teams.length > 0);

function checkRoute(
  config: ResolvedSelfhostConfig,
  route: ReviewRouteRule,
  input: RouteInput,
  ctx: RouteContext,
): RouteCheck {
  const match = matchRoute(route, input);
  const base = {
    id: route.id,
    ...(route.escalate_after_minutes !== undefined
      ? { escalate_after_minutes: route.escalate_after_minutes }
      : {}),
  };
  if (!match.matched) {
    return {
      ...base,
      matched: false,
      why: match.why,
      owners: [],
      github: { users: [], teams: [] },
    };
  }
  const resolved = resolveTargets(config, route, input, ctx);
  const check: RouteCheck = {
    ...base,
    matched: true,
    why: match.why,
    owners: resolved.owners,
    github: { users: resolved.users, teams: resolved.teams },
  };
  if (!namesAnyone(input.kind, resolved)) {
    check.empty = resolved.notes.length > 0 ? resolved.notes.join("; ") : "its targets name nobody";
  }
  return check;
}

function escalatesAt(minutes: number | undefined, ctx: RouteContext): string | undefined {
  if (minutes === undefined || !ctx.now) return undefined;
  return new Date(ctx.now.getTime() + minutes * MINUTE_MS).toISOString();
}

function routingOf(check: RouteCheck, ctx: RouteContext): Routing {
  const at = escalatesAt(check.escalate_after_minutes, ctx);
  const github = check.github.users.length + check.github.teams.length > 0;
  return {
    owners: check.owners,
    route: {
      step: "route",
      from: `[[review.routes]] ${JSON.stringify(check.id)}`,
      id: check.id,
      why: check.why,
      ...(github ? { github: check.github } : {}),
      ...(at ? { escalates_at: at } : {}),
    },
  };
}

/** Every route checked in order, from `start`. */
function checks(
  config: ResolvedSelfhostConfig,
  input: RouteInput,
  ctx: RouteContext,
  start = 0,
): RouteCheck[] {
  return config.review.routes.slice(start).map((route) => checkRoute(config, route, input, ctx));
}

/**
 * The first `[[review.routes]]` entry, in file order, that matches the item and names anyone.
 * Undefined when none does.
 */
export function routeByRules(
  config: ResolvedSelfhostConfig,
  input: RouteInput,
  ctx: RouteContext = {},
): Routing | undefined {
  const winner = checks(config, input, ctx).find((check) => check.matched && !check.empty);
  return winner ? routingOf(winner, ctx) : undefined;
}

/**
 * The default steps, when no route takes the item; the first that names anyone wins:
 *
 * 1. Owner: the people of every `[review.owners]` glob that matches one of the item's files, in
 *    file order; else the person whose session raised it.
 * 2. Team: the members of the item's team in `[teams]`.
 * 3. Fallback: `[review] fallback`.
 */
export function routeByDefaults(config: ResolvedSelfhostConfig, input: RouteInput): Routing {
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

/**
 * Who gets an item, from selfhost.toml: the first `[[review.routes]]` entry that matches it and
 * names anyone, else the default steps (see routeByDefaults). When nobody is named the item has
 * no owners and every reader of the list sees it.
 */
export function routeItem(
  config: ResolvedSelfhostConfig,
  input: RouteInput,
  ctx: RouteContext = {},
): Routing {
  return routeByRules(config, input, ctx) ?? routeByDefaults(config, input);
}

/**
 * Moves an item nobody answered on its route to the next one: the next `[[review.routes]]`
 * entry after it that matches the item and names anyone, else `[review] fallback`. The new
 * route's people come first and the earlier owners stay. With nowhere left to go the item
 * keeps its route and owners, and no longer escalates. Items no route took do not escalate.
 */
export function escalateRoute(
  config: ResolvedSelfhostConfig,
  input: RouteInput,
  current: Routing,
  ctx: RouteContext = {},
): { routing: Routing; escalated: boolean } {
  const { escalates_at: _due, ...route } = current.route;
  const settled = { routing: { owners: current.owners, route }, escalated: false };
  const index = config.review.routes.findIndex((r) => r.id === current.route.id);
  if (current.route.step !== "route" || current.route.id === undefined || index === -1) {
    return settled;
  }
  const from = [...(current.route.escalated_from ?? []), current.route.id];
  const next = checks(config, input, ctx, index + 1).find((check) => check.matched && !check.empty);
  if (next) {
    const routing = routingOf(next, ctx);
    const github = {
      users: unique([...(next.github.users ?? []), ...(current.route.github?.users ?? [])]),
      teams: unique([...(next.github.teams ?? []), ...(current.route.github?.teams ?? [])]),
    };
    return {
      escalated: true,
      routing: {
        owners: unique([...routing.owners, ...current.owners]),
        route: {
          ...routing.route,
          ...(github.users.length + github.teams.length > 0 ? { github } : {}),
          escalated_from: from,
        },
      },
    };
  }
  const fallback = config.review.fallback.filter((person) => ctx.eligible?.(person) ?? true);
  if (fallback.some((person) => !current.owners.includes(person))) {
    return {
      escalated: true,
      routing: {
        owners: unique([...fallback, ...current.owners]),
        route: {
          step: "fallback",
          from: "[review] fallback",
          why: `nobody answered on [[review.routes]] ${JSON.stringify(current.route.id)}`,
          ...(current.route.github ? { github: current.route.github } : {}),
          escalated_from: from,
        },
      },
    };
  }
  return settled;
}

/**
 * Every route checked against the item, who gets it and where it would escalate, for
 * `selfhost review routes`.
 */
export function explainRoutes(
  config: ResolvedSelfhostConfig,
  input: RouteInput,
  ctx: RouteContext = {},
): RouteExplanation {
  const routes = checks(config, input, ctx);
  const routing = routeItem(config, input, ctx);
  const escalation: string[] = [];
  let current = routing;
  for (let hops = 0; hops <= config.review.routes.length; hops++) {
    const id = current.route.id;
    const route = config.review.routes.find((r) => r.id === id);
    if (current.route.step !== "route" || route?.escalate_after_minutes === undefined) break;
    const next = escalateRoute(config, input, current, ctx);
    if (!next.escalated) break;
    escalation.push(next.routing.route.id ?? "[review] fallback");
    current = next.routing;
  }
  return { routes, routing, escalation };
}
