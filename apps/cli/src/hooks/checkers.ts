import { join } from "node:path";
import type { ToolCallChecker } from "@selfhost/policy/pretool";

/**
 * Package managers the package guard reads installs for. A command that names none of them
 * skips the guard without loading it, so most tool calls pay nothing for it.
 */
const PACKAGE_MANAGER =
  /(^|[^\w.-])(npm|npx|pnpm|yarn|bun|bunx|pip|pip3|python3?|uv|uvx|poetry|pipx|cargo|go)(\s|$)/;

/**
 * Milliseconds the package guard gives its registry lookups. It stays under the hook's shared
 * budget (DEFAULT_CHECK_BUDGET_MS), so a slow registry is reported as an unchecked install
 * instead of the whole checker timing out.
 */
export const PACKAGE_GUARD_BUDGET_MS = 1500;

export interface CheckerEnv {
  env: NodeJS.ProcessEnv;
  /** Lookups are cached in ~/.selfhost/cache/packages between hook runs. */
  home?: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

/**
 * The package guard as a pre-tool checker: every pip, npm, cargo and go install is checked
 * against its registry under the [packages] policy. It is loaded on the first command that
 * names a package manager, and keeps one cache for the life of the process.
 */
export function packageGuardChecker(context: CheckerEnv): ToolCallChecker {
  let checker: ReturnType<typeof import("@selfhost/package-guard").packageChecker> | undefined;
  return async function packageGuard(call, config) {
    if (call.command === undefined || config.packages.mode === "off") return [];
    if (!PACKAGE_MANAGER.test(call.command)) return [];
    if (!checker) {
      const { packageChecker } = await import("@selfhost/package-guard");
      checker = packageChecker({
        fetch: context.fetch ?? fetch,
        now: context.now ?? (() => new Date()),
        budgetMs: PACKAGE_GUARD_BUDGET_MS,
        env: context.env,
        ...(context.home ? { cacheDir: join(context.home, ".selfhost", "cache", "packages") } : {}),
      });
    }
    return checker(call, config);
  };
}

/**
 * Extra checks every pre-tool hook runs after the rules and the built-in guardrails, each an
 * async function that returns hits like a rule. They run in parallel and share a time budget
 * (DEFAULT_CHECK_BUDGET_MS); one that throws or runs out of time is skipped and recorded, and
 * the call goes ahead.
 */
export function extraCheckers(context: CheckerEnv): readonly ToolCallChecker[] {
  return [packageGuardChecker(context)];
}
