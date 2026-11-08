import type { ToolCallChecker } from "@selfhost/policy/pretool";

/**
 * Extra checks every pre-tool hook runs after the rules and the built-in guardrails, each an
 * async function that returns hits like a rule. They run in parallel and share a time budget
 * (DEFAULT_CHECK_BUDGET_MS); one that throws or runs out of time is skipped and recorded, and
 * the call goes ahead. The package guard plugs in here.
 */
export const EXTRA_CHECKERS: readonly ToolCallChecker[] = [];
