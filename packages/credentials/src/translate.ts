import { RUNTIME_KINDS, type RuntimeCapabilities, type RuntimeKind } from "@selfhost/runtime";
import {
  EGRESS_ALLOW_RULE_ID,
  type ExecutionLocation,
  ipRange,
  LOCAL_SANDBOXES,
  LOCATION_ENV,
  type LocalSandbox,
  SECRET_FORMAT_PLACEHOLDER,
} from "@selfhost/schema";

/**
 * One policy, each place's own controls. selfhost builds no proxy and no vault: for each runtime
 * and each local sandbox it writes the allow list and the secrets in that tool's native form,
 * and says which rules the tool cannot hold. Everything here is data; the runtime adapters and
 * `selfhost policy compile` apply it.
 */

/** Everywhere an agent can run: a laptop with no sandbox, a local sandbox, or a runtime. */
export const CREDENTIAL_TARGETS = ["laptop", ...LOCAL_SANDBOXES, ...RUNTIME_KINDS] as const;
export type CredentialTarget = "laptop" | LocalSandbox | RuntimeKind;

export function isTarget(value: string): value is CredentialTarget {
  return (CREDENTIAL_TARGETS as readonly string[]).includes(value);
}

export function isRuntime(target: CredentialTarget): target is RuntimeKind {
  return (RUNTIME_KINDS as readonly string[]).includes(target);
}

/** The location ledger events record for a target. */
export function locationOf(target: CredentialTarget): ExecutionLocation {
  if (target === "laptop") return "laptop";
  return isRuntime(target) ? `runtime:${target}` : `local:${target}`;
}

/** A secret to inject, by name. `value` is absent when only the shape is checked (doctor). */
export interface SecretPlan {
  name: string;
  value?: string;
  /** Inject at the sandbox's egress into requests to `host`, keeping the value out of the box. */
  injectFor?: { host: string; header: string; format: string };
}

/** A rule a target cannot hold as written. */
export interface EnforcementGap {
  target: CredentialTarget;
  /** `egress.allow`, or `secrets.env.<NAME>`. */
  rule: string;
  /** The allow list entry or secret the gap is about, when it is one. */
  entry?: string;
  /**
   * unenforced: nothing on the target holds it (the hooks still check tool calls). weaker: held,
   * but looser than written. stricter: held tighter than written, so runs that need it fail.
   */
  effect: "unenforced" | "weaker" | "stricter";
  message: string;
}

const ALL_TRAFFIC = "0.0.0.0/0";

const isRange = (entry: string) => ipRange(entry) !== undefined;
const isName = (entry: string) => !isRange(entry);

/** What each target's own controls can hold, from its docs (checked 2026-11-09). */
interface NativeSupport {
  /** Allow host names. */
  names: boolean;
  /** Allow `*.domain`. */
  wildcards: boolean;
  /** Allow IPv4 addresses and ranges. */
  ranges: boolean;
  /** Names and ranges in one list. */
  mixed: boolean;
  /** Secrets as environment variables of the sandbox. */
  env: boolean;
  /** Secrets injected into outbound requests, never entering the sandbox. */
  inject: boolean;
}

const SUPPORT: Record<CredentialTarget, NativeSupport | undefined> = {
  laptop: undefined,
  // github.com/anthropic-experimental/sandbox-runtime (network.allowedDomains) and Claude Code
  // settings sandbox.network.allowedDomains (code.claude.com/docs/en/settings-reference).
  "sandbox-runtime": {
    names: true,
    wildcards: true,
    ranges: false,
    mixed: false,
    env: false,
    inject: false,
  },
  // https://docs.docker.com/ai/sandboxes: sbx policy allow network, sbx secret set-custom --host.
  "docker-sandboxes": {
    names: true,
    wildcards: true,
    ranges: false,
    mixed: false,
    env: false,
    inject: true,
  },
  devcontainer: {
    names: false,
    wildcards: false,
    ranges: false,
    mixed: false,
    env: true,
    inject: false,
  },
  // https://docs.e2b.dev/network/internet-access and /secrets/inject.
  e2b: { names: true, wildcards: true, ranges: true, mixed: true, env: true, inject: true },
  // https://www.daytona.io/docs/en/network-limits: domainAllowList xor networkAllowList.
  daytona: { names: true, wildcards: true, ranges: true, mixed: false, env: true, inject: false },
  // libmodal SandboxCreateParams: blockNetwork, cidrAllowlist; secrets from objects.
  modal: { names: false, wildcards: false, ranges: true, mixed: false, env: true, inject: false },
  // Coder Agent Firewall (docs/ai-coder/agent-firewall): allowlist of domain=..., workspace env.
  coder: { names: true, wildcards: true, ranges: false, mixed: false, env: true, inject: false },
  // OpenSandbox networkPolicy egress rules and the Credential Vault on the egress sidecar.
  opensandbox: { names: true, wildcards: true, ranges: true, mixed: true, env: true, inject: true },
};

/** Each target's own form of an egress allow list. Absent fields mean no limit. */
export type NativeEgress =
  | { target: "laptop" }
  | {
      target: "sandbox-runtime";
      /** ~/.srt-settings.json for `srt`, and the same list for Claude Code's sandbox settings. */
      srtSettings: { network: { allowedDomains: string[]; deniedDomains: string[] } };
      claudeSettings: {
        sandbox: { enabled: true; network: { allowedDomains: string[] } };
        env: Record<string, string>;
      };
    }
  | { target: "docker-sandboxes"; commands: string[][] }
  | {
      target: "devcontainer";
      devcontainer: { containerEnv: Record<string, string> };
    }
  | {
      target: "e2b";
      create:
        | { allowInternetAccess: false }
        | { network: { allowOut: string[]; denyOut: string[] } };
    }
  | {
      target: "daytona";
      create:
        | { networkBlockAll: true }
        | { domainAllowList: string }
        | { networkAllowList: string };
    }
  | { target: "modal"; create: { blockNetwork: true } | { cidrAllowlist: string[] } }
  | { target: "coder"; agentFirewall: { allowlist: string[] } }
  | {
      target: "opensandbox";
      create: {
        networkPolicy: {
          defaultAction: "deny";
          egress: { action: "allow"; target: string }[];
        };
      };
    };

/** The variable selfhost reads in a local sandbox it configured, to record where a call ran. */
const locationEnv = (target: CredentialTarget) => ({ [LOCATION_ENV]: locationOf(target) });

/**
 * The target's own egress config for `allow` (undefined: no limit), and the entries it cannot
 * hold as written. Fails closed: an entry a target cannot express is left out, so the run is
 * stricter than the policy rather than looser, except where noted as weaker.
 */
export function egressFor(
  target: CredentialTarget,
  allow: readonly string[] | undefined,
  capabilities?: Pick<RuntimeCapabilities, "egress">,
): { native: NativeEgress | undefined; gaps: EnforcementGap[] } {
  if (allow === undefined) return { native: undefined, gaps: [] };
  const gaps: EnforcementGap[] = [];
  const gap = (effect: EnforcementGap["effect"], message: string, entry?: string) =>
    gaps.push({
      target,
      rule: EGRESS_ALLOW_RULE_ID,
      ...(entry !== undefined ? { entry } : {}),
      effect,
      message,
    });
  const support = SUPPORT[target];
  if (target === "devcontainer") {
    gap(
      "unenforced",
      "A devcontainer has no network allow list of its own: run Claude Code's sandbox inside it, or a firewall script that reads SELFHOST_EGRESS_ALLOW (as Claude Code's reference devcontainer does).",
    );
    return {
      native: {
        target,
        devcontainer: {
          containerEnv: { ...locationEnv(target), SELFHOST_EGRESS_ALLOW: allow.join(",") },
        },
      },
      gaps,
    };
  }
  if (!support || capabilities?.egress === false) {
    gap(
      "unenforced",
      target === "laptop"
        ? "A laptop with no sandbox has no network allow list: the hooks check URLs in tool calls, and nothing stops a program a command starts. Run the agent in a local sandbox to hold it."
        : `${target} declares no egress control, so the allow list is not applied there: only the hooks check tool calls.`,
    );
    return { native: target === "laptop" ? { target } : undefined, gaps };
  }
  const names = allow.filter(isName);
  const ranges = allow.filter(isRange);
  let keptNames = support.names ? names : [];
  let keptRanges = support.ranges ? ranges : [];
  if (!support.names) {
    for (const entry of names) {
      gap(
        "stricter",
        `${target} allows addresses and ranges only, so the host name is blocked.`,
        entry,
      );
    }
  }
  if (!support.ranges) {
    for (const entry of ranges) {
      gap("stricter", `${target} allows host names only, so the range is blocked.`, entry);
    }
  }
  if (!support.mixed && keptNames.length > 0 && keptRanges.length > 0) {
    for (const entry of keptRanges) {
      gap(
        "stricter",
        `${target} takes host names or ranges in one sandbox, not both, so the range is blocked.`,
        entry,
      );
    }
    keptRanges = [];
  }
  if (!support.wildcards) {
    for (const entry of keptNames.filter((name) => name.startsWith("*."))) {
      gap("stricter", `${target} has no wildcard hosts, so the entry is blocked.`, entry);
    }
    keptNames = keptNames.filter((name) => !name.startsWith("*."));
  }
  switch (target) {
    case "sandbox-runtime":
      return {
        native: {
          target,
          srtSettings: { network: { allowedDomains: keptNames, deniedDomains: [] } },
          claudeSettings: {
            sandbox: { enabled: true, network: { allowedDomains: keptNames } },
            env: locationEnv(target),
          },
        },
        gaps,
      };
    case "docker-sandboxes":
      gap(
        "weaker",
        "Docker Sandboxes' Balanced policy also allows common development services; use the Locked Down policy so the list is the only way out.",
      );
      return {
        native: {
          target,
          commands:
            keptNames.length > 0
              ? [["sbx", "policy", "allow", "network", keptNames.join(",")]]
              : [],
        },
        gaps,
      };
    case "e2b": {
      const allowOut = [...keptNames, ...keptRanges];
      return {
        native: {
          target,
          create:
            allowOut.length === 0
              ? { allowInternetAccess: false }
              : { network: { allowOut, denyOut: [ALL_TRAFFIC] } },
        },
        gaps,
      };
    }
    case "daytona":
      return {
        native: {
          target,
          create:
            keptNames.length > 0
              ? { domainAllowList: keptNames.join(",") }
              : keptRanges.length > 0
                ? { networkAllowList: keptRanges.join(",") }
                : { networkBlockAll: true },
        },
        gaps,
      };
    case "modal":
      return {
        native: {
          target,
          create: keptRanges.length > 0 ? { cidrAllowlist: keptRanges } : { blockNetwork: true },
        },
        gaps,
      };
    case "coder":
      for (const entry of keptNames.filter((name) => !name.startsWith("*."))) {
        gap(
          "weaker",
          "Coder's Agent Firewall lets domain=<host> reach the host's subdomains too.",
          entry,
        );
      }
      return {
        native: { target, agentFirewall: { allowlist: keptNames.map((name) => `domain=${name}`) } },
        gaps,
      };
    case "opensandbox":
      return {
        native: {
          target,
          create: {
            networkPolicy: {
              defaultAction: "deny",
              egress: [...keptNames, ...keptRanges].map((entry) => ({
                action: "allow" as const,
                target: entry,
              })),
            },
          },
        },
        gaps,
      };
    default:
      return { native: { target: "laptop" }, gaps };
  }
}

/** A secret injected at the sandbox's egress, in the target's own terms. */
export interface NativeInjection {
  name: string;
  host: string;
  header: string;
  format: string;
}

/** Each target's own form of the run's secrets. Values appear only here and in `env`. */
export interface NativeSecrets {
  target: CredentialTarget;
  /** Variables set in the sandbox: real values, or a placeholder for an injected secret. */
  env: Record<string, string>;
  /** Secrets the target's egress puts into requests, keeping the value out of the sandbox. */
  inject: (NativeInjection & { value?: string })[];
  /** OpenSandbox's Credential Vault, for the injected secrets. */
  credentialVault?: {
    credentials: { name: string; source: { value: string } }[];
    bindings: {
      name: string;
      match: { schemes: ["https"]; hosts: string[] };
      auth: { type: "apiKey"; name: string; credential: string };
    }[];
  };
  /** `sbx secret set-custom` commands; sbx reads each value itself. */
  commands?: string[][];
  /** devcontainer.json remoteEnv entries that read each value from the host's environment. */
  remoteEnv?: Record<string, string>;
}

/** The variable's value inside the sandbox when the real one is injected at egress. */
export const placeholderOf = (name: string) => `selfhost-injected-${name.toLowerCase()}`;

/**
 * The target's own form of the run's secrets, and what it cannot hold: a secret meant to be
 * injected at egress on a target that cannot do that goes into the sandbox's environment
 * instead (weaker), and a target with no secret injection at all gets nothing (unenforced).
 */
export function secretsFor(
  target: CredentialTarget,
  secrets: readonly SecretPlan[],
  capabilities?: Pick<RuntimeCapabilities, "secrets">,
): { native: NativeSecrets; gaps: EnforcementGap[] } {
  const gaps: EnforcementGap[] = [];
  const native: NativeSecrets = { target, env: {}, inject: [] };
  const support = SUPPORT[target];
  const rule = (name: string) => `secrets.env.${name}`;
  for (const secret of secrets) {
    const value = secret.value ?? "";
    if (target === "devcontainer") {
      native.remoteEnv ??= {};
      native.remoteEnv[secret.name] = `\${localEnv:${secret.name}}`;
      if (secret.injectFor) {
        gaps.push({
          target,
          rule: rule(secret.name),
          entry: secret.name,
          effect: "weaker",
          message: "A devcontainer cannot inject at egress, so the value is in the container.",
        });
      }
      continue;
    }
    const canInject =
      support?.inject === true && capabilities?.secrets !== false && secret.injectFor !== undefined;
    if (canInject && secret.injectFor) {
      const injection = { name: secret.name, ...secret.injectFor };
      if (target === "opensandbox" && !simpleFormat(injection.format)) {
        gaps.push({
          target,
          rule: rule(secret.name),
          entry: secret.name,
          effect: "weaker",
          message: `OpenSandbox's Credential Vault sets a header to the value or a bearer token, not "${injection.format}", so the value is in the sandbox.`,
        });
        native.env[secret.name] = value;
        continue;
      }
      native.env[secret.name] = placeholderOf(secret.name);
      native.inject.push(secret.value === undefined ? injection : { ...injection, value });
      continue;
    }
    if (!support || capabilities?.secrets === false || !support.env) {
      if (target !== "laptop" && target !== "sandbox-runtime") {
        gaps.push({
          target,
          rule: rule(secret.name),
          entry: secret.name,
          effect: "unenforced",
          message: `${target} takes no secrets from selfhost, so the run does not get it.`,
        });
      }
      continue;
    }
    if (secret.injectFor) {
      gaps.push({
        target,
        rule: rule(secret.name),
        entry: secret.name,
        effect: "weaker",
        message: `${target} cannot inject a secret at egress, so the value is in the sandbox's environment.`,
      });
    }
    native.env[secret.name] = value;
  }
  if (target === "opensandbox" && native.inject.length > 0) {
    native.credentialVault = {
      credentials: native.inject.map((i) => ({ name: i.name, source: { value: i.value ?? "" } })),
      bindings: native.inject.map((i) => ({
        name: i.name,
        match: { schemes: ["https"], hosts: [i.host] },
        auth: { type: "apiKey", name: i.header, credential: i.name },
      })),
    };
  }
  if (target === "docker-sandboxes") {
    native.commands = native.inject.map((i) => [
      "sbx",
      "secret",
      "set-custom",
      "--host",
      i.host,
      "--env",
      i.name,
    ]);
  }
  return { native, gaps };
}

/** A format the Credential Vault's apiKey binding writes as is: the bare value. */
function simpleFormat(format: string): boolean {
  return format === SECRET_FORMAT_PLACEHOLDER;
}
