import { createHash } from "node:crypto";
import { compilePolicy } from "@selfhost/compile";
import type { EffectivePolicy, Ledger } from "@selfhost/ledger";
import { effectiveRules } from "@selfhost/policy";
import {
  type AgentVendor,
  type CompileVendor,
  checkLayer,
  composePolicy,
  createValidator,
  type FloorConflict,
  type InvalidPolicyError,
  type OrgPolicyResponse,
  PolicyCoverageQuerySchema,
  type PolicyCoverageResponse,
  PolicyQuerySchema,
  type PolicyResponse,
  parseConfig,
  SetPolicyRequestSchema,
} from "@selfhost/schema";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { apiError, authorize, type Caller, orgOf, type Router } from "./access.js";
import { invalidQuery, readBody } from "./http.js";

export interface RuleScope {
  /** Team id on the server. Overrides in [teams.<id>] apply to everyone in it. */
  team: string;
  /** Overrides of every [teams.<name>] that lists this person as a member apply too. */
  person?: string;
  /** Only rules for this agent. */
  agent?: AgentVendor;
}

const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");

/** selfhost.toml text is capped at 1,000,000 characters; JSON escaping can grow it. */
const POLICY_BODY_BYTES = 8 * 1024 * 1024;

const policyQuery = createValidator(PolicyQuerySchema);
const coverageQuery = createValidator(PolicyCoverageQuerySchema);
const setPolicyBody = createValidator(SetPolicyRequestSchema);

const policyLimit = bodyLimit({
  maxSize: POLICY_BODY_BYTES,
  onError: (c) =>
    c.json(apiError("payload_too_large", `Request body over ${POLICY_BODY_BYTES} bytes`), 413),
});

export function policyResponse(policy: EffectivePolicy, scope: RuleScope): PolicyResponse {
  return {
    hash: policy.hash,
    team: policy.team,
    ...(policy.repo !== undefined ? { repo: policy.repo } : {}),
    layers: policy.layers.map(({ kind, name }) => ({ kind, name })),
    text: policy.text,
    loaded_at: policy.updatedAt,
    config: policy.config,
    effective_rules: effectiveRules(policy.config, scope),
  };
}

/**
 * What `selfhost policy compile` would cover of the team's policy, per rule and vendor, with the
 * team's overrides applied. The dashboard shows each gap from this.
 */
export function policyCoverageResponse(
  policy: EffectivePolicy,
  vendor?: CompileVendor,
): PolicyCoverageResponse {
  const { coverage } = compilePolicy(policy.config, {
    team: policy.team,
    ...(vendor ? { vendors: [vendor] } : {}),
  });
  return { hash: policy.hash, team: policy.team, coverage };
}

export function invalidPolicy(c: Context, errors: InvalidPolicyError["errors"], relaxes: boolean) {
  const body: InvalidPolicyError = {
    error: {
      code: "invalid_policy",
      message: relaxes
        ? "selfhost.toml relaxes the org floor, nothing was stored"
        : "selfhost.toml is invalid, nothing was stored",
    },
    errors,
  };
  return c.json(body, 400);
}

/** Every stored team and repo policy of the org that relaxes this org floor. */
async function conflictsWith(ledger: Ledger, org: string, text: string): Promise<FloorConflict[]> {
  const conflicts: FloorConflict[] = [];
  for (const layer of await ledger.orgs.storedLayers(org)) {
    const { conflicts: found } = composePolicy([
      { kind: "org", name: org, text },
      { kind: layer.repo ? "repo" : "team", name: layer.repo ?? layer.team, text: layer.text },
    ]);
    for (const { field, message, org_rule } of found) {
      conflicts.push({
        team: layer.team,
        ...(layer.repo ? { repo: layer.repo } : {}),
        field,
        message,
        org_rule,
      });
    }
  }
  return conflicts;
}

/**
 * GET and PUT /v1/policy, GET /v1/policy/coverage and GET and PUT /v1/orgs/{org}/policy, for
 * both kinds of token. A person token reads the policy of any team it is in and changes it
 * when its role there has policy.write; the admin token names the team.
 */
export function policyRoutes(router: Router, ledger: Ledger): void {
  const { teams, orgs } = ledger;

  /** The team a query is about: the one named, else the person token's own. */
  const teamOf = (c: Context, caller: Caller, team: string | undefined) => {
    if (team !== undefined) return team;
    if (caller.kind === "person") return caller.person.team;
    return c.json(apiError("invalid_query", "team: Required with the admin token"), 400);
  };

  async function effective(c: Context, team: string, repo: string | undefined) {
    const info = await teams.getTeam(team);
    if (!info) return c.json(apiError("not_found", `No team ${team}`), 404);
    if (repo !== undefined) {
      const owner = await orgs.repoOwner(info.org ?? "", repo.toLowerCase());
      if (owner?.team !== team) {
        return c.json(apiError("not_found", `Team ${team} does not own repo ${repo}`), 404);
      }
    }
    const policy = await orgs.effectivePolicy(team, repo?.toLowerCase());
    if (!policy) {
      return c.json(
        apiError(
          "no_policy",
          `Team ${team} has no selfhost.toml yet, and its org has none. Set one with PUT /v1/policy.`,
        ),
        404,
      );
    }
    return policy;
  }

  router.on("GET", "/v1/policy", async (c, caller) => {
    const query = policyQuery.validate(c.req.query());
    if (!query.ok) return invalidQuery(c, query.errors);
    const team = teamOf(c, caller, query.value.team);
    if (team instanceof Response) return team;
    const refused = await authorize(c, caller, team, "read");
    if (refused) return refused;
    const policy = await effective(c, team, query.value.repo);
    if (policy instanceof Response) return policy;
    const who = query.value.person ?? (caller.kind === "person" ? caller.person.id : undefined);
    return c.json(policyResponse(policy, { team, person: who, agent: query.value.agent }));
  });

  router.on("GET", "/v1/policy/coverage", async (c, caller) => {
    const query = coverageQuery.validate(c.req.query());
    if (!query.ok) return invalidQuery(c, query.errors);
    const team = teamOf(c, caller, query.value.team);
    if (team instanceof Response) return team;
    const refused = await authorize(c, caller, team, "read");
    if (refused) return refused;
    const policy = await effective(c, team, undefined);
    if (policy instanceof Response) return policy;
    return c.json(policyCoverageResponse(policy, query.value.vendor));
  });

  router.on(
    "PUT",
    "/v1/policy",
    async (c, caller) => {
      const unexpected = Object.keys(c.req.query()).find((key) => key !== "team" && key !== "repo");
      if (unexpected) {
        return c.json(apiError("invalid_query", `${unexpected}: Unknown query parameter`), 400);
      }
      const team = teamOf(c, caller, c.req.query("team"));
      if (team instanceof Response) return team;
      const refused = await authorize(c, caller, team, "policy.write");
      if (refused) return refused;
      const body = await readBody(c, setPolicyBody);
      if (body instanceof Response) return body;
      const info = await teams.getTeam(team);
      if (!info) return c.json(apiError("not_found", `No team ${team}`), 404);
      const org = info.org ?? "";
      const repo = c.req.query("repo")?.toLowerCase();
      if (repo !== undefined && (await orgs.repoOwner(org, repo))?.team !== team) {
        return c.json(apiError("not_found", `Team ${team} does not own repo ${repo}`), 404);
      }
      const floor = await orgs.getOrgPolicy(org);
      const checked = checkLayer(floor?.text, body.text);
      if (!checked.ok) {
        return invalidPolicy(
          c,
          checked.errors,
          checked.errors.some((e) => e.org_rule),
        );
      }
      if (repo !== undefined) await orgs.setRepoPolicy(org, repo, body.text);
      else await teams.setPolicy(team, body.text);
      const policy = await orgs.effectivePolicy(team, repo);
      if (!policy) throw new Error(`team ${team} has no policy right after it was set`);
      return c.json(policyResponse(policy, { team }));
    },
    policyLimit,
  );

  /** The org a request is about, which a person token must belong to. */
  const orgFor = async (c: Context, caller: Caller) => {
    const org = c.req.param("org") ?? "";
    const own = await orgOf(caller);
    if (own !== undefined && own !== org) {
      return c.json(apiError("forbidden", `You are not in org ${org}.`), 403);
    }
    if (!(await orgs.getOrg(org))) return c.json(apiError("not_found", `No org ${org}`), 404);
    return org;
  };

  router.on("GET", "/v1/orgs/:org/policy", async (c, caller) => {
    const org = await orgFor(c, caller);
    if (org instanceof Response) return org;
    const policy = await orgs.getOrgPolicy(org);
    if (!policy) {
      return c.json(apiError("no_policy", `Org ${org} has no selfhost.toml yet`), 404);
    }
    return c.json(await orgPolicyResponse(org, policy.text, policy.updatedAt));
  });

  router.on(
    "PUT",
    "/v1/orgs/:org/policy",
    async (c, caller) => {
      if (caller.kind !== "admin") {
        return c.json(
          apiError("forbidden", "Only the server's admin token sets the org's selfhost.toml."),
          403,
        );
      }
      const org = await orgFor(c, caller);
      if (org instanceof Response) return org;
      const body = await readBody(c, setPolicyBody);
      if (body instanceof Response) return body;
      const parsed = parseConfig(body.text);
      if (!parsed.ok) return invalidPolicy(c, parsed.errors, false);
      const stored = await orgs.setOrgPolicy(org, body.text);
      return c.json(await orgPolicyResponse(org, stored.text, stored.updatedAt));
    },
    policyLimit,
  );

  async function orgPolicyResponse(
    org: string,
    text: string,
    updatedAt: string,
  ): Promise<OrgPolicyResponse> {
    const parsed = parseConfig(text);
    // PUT stores only text that parses, so this means the schema changed under it.
    if (!parsed.ok) throw new Error(`The stored selfhost.toml of org ${org} is invalid`);
    return {
      org,
      hash: hashOf(text),
      text,
      loaded_at: updatedAt,
      config: parsed.config,
      conflicts: await conflictsWith(ledger, org, text),
    };
  }
}
