// The policy_report builder lives in @selfhost/review, which files last week's report in the
// review list on its own; `selfhost policy report` builds one for any window and prints it.
export {
  buildPolicyReport,
  falsePositiveReason,
  inertCharacters,
  matchesOnlyInertText,
  type ObservedExample,
  type ObservedRule,
  type ObservedVerdict,
  observedRules,
  type PolicyReportOptions,
  reportWindow,
} from "@selfhost/review";
