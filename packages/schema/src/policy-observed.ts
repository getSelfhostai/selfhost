import { type Static, Type } from "@sinclair/typebox";
import { DateTime, StringEnum } from "./common.js";
import { RULE_MODES } from "./config.js";

/**
 * What each rule and guardrail of a team did in a window: the body of GET /v1/policy/observed.
 * Observe-mode hits say what a rule would have blocked or sent to a person; enforce-mode
 * verdicts say what it did. Both come from the policy.evaluated events in the ledger.
 */

export const POLICY_OBSERVED_SCHEMA = "selfhost.policy_observed/v1";

/** Default window of the report, back from to. */
export const POLICY_OBSERVED_DEFAULT_DAYS = 7;

const Count = (description: string) => Type.Integer({ minimum: 0, description });

export const PolicyObservedQuerySchema = Type.Object(
  {
    team: Type.Optional(
      Type.String({
        description:
          "Team id on a team server. Needed with the admin token; a person token reads its own team by default, or another team it is in.",
      }),
    ),
    from: Type.Optional(
      DateTime({
        description: `Verdicts at or after this time. Default: ${POLICY_OBSERVED_DEFAULT_DAYS} days before to.`,
      }),
    ),
    to: Type.Optional(DateTime({ description: "Verdicts before this time. Default: now." })),
  },
  { additionalProperties: false, title: "PolicyObservedQuery" },
);

export const PolicyObservedExampleSchema = Type.Object(
  {
    tool: Type.String({ description: "Tool name, or (unknown tool)." }),
    input: Type.Union([Type.String(), Type.Null()], {
      description:
        "tool.input_summary, else target.value, as stored: redacted values stay redacted. null when none was recorded.",
    }),
    hits: Count("Observe-mode hits on this call."),
    likely_false_positive: Type.Union([Type.String(), Type.Null()], {
      description: "Why this call looks like a false positive, or null.",
    }),
  },
  { additionalProperties: false, title: "PolicyObservedExample" },
);

export const PolicyObservedRuleSchema = Type.Object(
  {
    rule_id: Type.String({
      description: "Rule id from selfhost.toml, a guardrail (guard.*), mcp.allow or models.allow.",
    }),
    mode: Type.Union([StringEnum(RULE_MODES), Type.Null()], {
      description:
        "Mode in the team's policy now, after the team's overrides. null when the rule is not in it or the team has no policy.",
    }),
    would_block: Count("Observe-mode block hits, one per tool call."),
    would_ask: Count("Observe-mode ask hits, one per tool call."),
    blocked: Count("Enforce-mode block verdicts."),
    asked: Count("Enforce-mode ask verdicts: calls sent to a person."),
    sessions: Count("Agent sessions with any of these hits or verdicts."),
    likely_false_positives: Count("Observe-mode hits that look like false positives."),
    examples: Type.Array(PolicyObservedExampleSchema, {
      maxItems: 3,
      description: "The most frequent distinct observe-mode calls, most hits first.",
    }),
    more_examples: Count("Distinct observe-mode calls left out of examples."),
  },
  { additionalProperties: false, title: "PolicyObservedRule" },
);

const Totals = Type.Object(
  {
    would_block: Count("Observe-mode block hits."),
    would_ask: Count("Observe-mode ask hits."),
    blocked: Count("Enforce-mode blocks."),
    asked: Count("Enforce-mode asks."),
  },
  { additionalProperties: false, description: "The rules' counts added up." },
);

export const PolicyObservedResponseSchema = Type.Object(
  {
    schema: Type.Literal(POLICY_OBSERVED_SCHEMA),
    team: Type.String({ description: "Team id." }),
    from: DateTime(),
    to: DateTime(),
    rules: Type.Array(PolicyObservedRuleSchema, {
      description:
        "Every rule with a verdict in the window, most hits and verdicts first, then by rule id.",
    }),
    totals: Totals,
  },
  {
    additionalProperties: false,
    title: "PolicyObservedResponse",
    description:
      "What each rule and guardrail of a team would have blocked or asked in observe mode, and blocked or asked in enforce mode, in a window.",
  },
);

export type PolicyObservedQuery = Static<typeof PolicyObservedQuerySchema>;
export type PolicyObservedExample = Static<typeof PolicyObservedExampleSchema>;
export type PolicyObservedRule = Static<typeof PolicyObservedRuleSchema>;
export type PolicyObservedResponse = Static<typeof PolicyObservedResponseSchema>;
