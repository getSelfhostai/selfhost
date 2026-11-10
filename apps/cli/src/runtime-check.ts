import { existsSync } from "node:fs";
import {
  CREDENTIAL_TARGETS,
  type CredentialTarget,
  type EnforcementReport,
  enforcementReport,
  isTarget,
} from "@selfhost/credentials";
import {
  formatConfigError,
  LOCAL_SANDBOXES,
  parseConfig,
  type ResolvedSelfhostConfig,
} from "@selfhost/schema";
import { findConfig, policyText } from "./find-config.js";

/**
 * `selfhost runtime check`: what each place an agent can run makes of [egress] and [secrets]:
 * the allow list and secrets written in its own controls, and every rule it cannot hold as
 * written. selfhost doctor prints the same for the configured runtime and the local sandboxes.
 */

export interface RuntimeCheckOptions {
  cwd: string;
  config?: string;
  configPath?: string;
  env: NodeJS.ProcessEnv;
  /** Targets to check. Default: the [runtime] default and the local sandboxes. */
  targets?: string[];
  team?: string;
  json?: boolean;
  write: (line: string) => void;
}

/** The targets checked when none are named: the team's runtime, then the local sandboxes. */
export function defaultTargets(config: ResolvedSelfhostConfig): CredentialTarget[] {
  const runtime = config.runtime?.default;
  return [...(runtime ? [runtime] : []), ...LOCAL_SANDBOXES];
}

/** Reports for the targets, or none when the policy has neither [egress] nor [secrets]. */
export function enforcementReports(
  config: ResolvedSelfhostConfig,
  targets: readonly CredentialTarget[],
  team?: string,
): EnforcementReport[] {
  if (!config.egress && !config.secrets) return [];
  return targets.map((target) => enforcementReport(config, target, team ? { team } : {}));
}

/** One line per target, then one indented line per gap. */
export function reportLines(reports: readonly EnforcementReport[]): string[] {
  const lines: string[] = [];
  for (const report of reports) {
    const egress =
      report.egress === "none"
        ? "no [egress]"
        : report.egress === "observe"
          ? "[egress] observe: hooks record, nothing written"
          : `[egress] ${report.allow.length} hosts`;
    const secrets = report.secrets.length > 0 ? `, ${report.secrets.length} secrets` : "";
    const verdict =
      report.gaps.length === 0 ? "holds every rule" : `${report.gaps.length} not held as written`;
    lines.push(`${report.target}: ${egress}${secrets}; ${verdict}`);
    for (const gap of report.gaps) {
      const entry = gap.entry ? ` ${gap.entry}` : "";
      lines.push(`  ${gap.effect} ${gap.rule}${entry}: ${gap.message}`);
    }
  }
  return lines;
}

/** Exit code 1 when a checked target leaves a rule unenforced or weaker than written. */
export function runtimeCheck(options: RuntimeCheckOptions): number {
  const unknown = (options.targets ?? []).filter((target) => !isTarget(target));
  if (unknown.length > 0) {
    options.write(
      `Unknown target ${unknown.join(", ")}: expected ${CREDENTIAL_TARGETS.join(", ")}`,
    );
    return 1;
  }
  const location = findConfig(options.cwd, options.config, options.env, options.configPath);
  if (!location || !existsSync(location.path)) {
    options.write("No selfhost.toml found: nothing to check.");
    return 1;
  }
  const parsed = parseConfig(policyText(location).text);
  if (!parsed.ok) {
    for (const error of parsed.errors) options.write(formatConfigError(error, location.path));
    return 1;
  }
  const targets = (options.targets as CredentialTarget[] | undefined)?.length
    ? (options.targets as CredentialTarget[])
    : defaultTargets(parsed.config);
  const reports = enforcementReports(parsed.config, targets, options.team);
  const failed = reports.some((report) =>
    report.gaps.some((gap) => gap.effect === "unenforced" || gap.effect === "weaker"),
  );
  if (options.json) {
    options.write(
      JSON.stringify(
        { schema: "selfhost.runtime_check/v1", config: location.path, reports },
        null,
        2,
      ),
    );
    return failed ? 1 : 0;
  }
  if (reports.length === 0) {
    options.write(`${location.path} has no [egress] or [secrets]: nothing to translate.`);
    return 0;
  }
  for (const line of reportLines(reports)) options.write(line);
  return failed ? 1 : 0;
}
