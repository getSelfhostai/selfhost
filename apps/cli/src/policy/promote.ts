// The promote edit lives in @selfhost/policy, so the console changes a rule's mode with the
// same line edit as `selfhost policy promote`.
export {
  type PromoteOptions,
  type PromoteResult,
  promoteRule,
  setGuardrailsMode,
} from "@selfhost/policy/promote";
