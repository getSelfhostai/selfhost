import type { RuntimeCapabilities } from "@selfhost/runtime";
import { egressPolicyOf, type ResolvedSelfhostConfig } from "@selfhost/schema";
import { declaredSecrets, providerKeyGaps } from "./secrets.js";
import {
  type CredentialTarget,
  type EnforcementGap,
  egressFor,
  type NativeEgress,
  secretsFor,
} from "./translate.js";

/** What one target makes of a policy's [egress] and [secrets], for doctor and runtime check. */
export interface EnforcementReport {
  target: CredentialTarget;
  /** none: no [egress]; observe: hooks record, nothing native; enforce: written natively. */
  egress: "none" | "observe" | "enforce";
  /** Hosts in the allow list for the team. */
  allow: string[];
  /** [secrets.env] names. */
  secrets: string[];
  /**
   * The allow list in the target's own form, to paste or apply: srt settings, sbx commands, a
   * devcontainer's env, a provider's create options. Without the hosts a run adds.
   */
  native: NativeEgress | undefined;
  gaps: EnforcementGap[];
}

/**
 * The rules of a policy that `target` cannot hold as written, without reading any value: each
 * egress entry and each declared secret is run through the same translation a run uses.
 */
export function enforcementReport(
  config: ResolvedSelfhostConfig,
  target: CredentialTarget,
  options: { team?: string; capabilities?: Pick<RuntimeCapabilities, "egress" | "secrets"> } = {},
): EnforcementReport {
  const policy = egressPolicyOf(config, options.team);
  const secrets = declaredSecrets(config).filter(
    (secret) => secret.source !== "github-app" && secret.source !== "gateway",
  );
  const egress = egressFor(
    target,
    policy?.mode === "enforce" ? policy.allow : undefined,
    options.capabilities,
  );
  const plans = secrets.map(({ name, injectFor }) => ({
    name,
    ...(injectFor ? { injectFor } : {}),
  }));
  return {
    target,
    egress: policy === undefined ? "none" : policy.mode,
    allow: policy?.allow ?? [],
    secrets: secrets.map((secret) => secret.name),
    native: egress.native,
    gaps: [
      ...egress.gaps,
      ...secretsFor(target, plans, options.capabilities).gaps,
      ...(config.integrations?.router
        ? []
        : providerKeyGaps(
            target,
            secrets.map((secret) => secret.name),
          )),
    ],
  };
}
