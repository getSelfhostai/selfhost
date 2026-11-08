import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DeployContext, Deployed, ProviderDriver, SshTarget, UpIo, UpPlan } from "./plan.js";
import { UpError } from "./resources.js";
import {
  finishScript,
  isHostname,
  isIPv4,
  parseReadBack,
  type SigninSettings,
  sslipName,
} from "./stack.js";

/** `user@host`, user root when not given. */
export function parseSshTarget(
  value: string,
  port: number | null,
  identity: string | null,
): SshTarget {
  const at = value.lastIndexOf("@");
  const user = at > 0 ? value.slice(0, at) : "root";
  const host = (at >= 0 ? value.slice(at + 1) : value).trim();
  if (!/^[a-z_][a-z0-9_.-]*$/i.test(user) || !/^[a-z0-9.-]+$/i.test(host)) {
    throw new Error(`--host: expected user@host or host, got "${value}"`);
  }
  return { user, host, port, identity, hostKeyAlias: null, knownHosts: null };
}

/**
 * A new cloud server: the private key next to the public one selfhost up installed (else
 * ssh-agent), and its host key kept in ~/.selfhost/known_hosts under the server's name.
 */
export function cloudTarget(plan: UpPlan, io: UpIo, user: string, ip: string): SshTarget {
  const privateKey = plan.publicKey?.path.replace(/\.pub$/, "");
  return {
    user,
    host: ip,
    port: null,
    identity: privateKey && existsSync(privateKey) ? privateKey : null,
    hostKeyAlias: plan.name,
    knownHosts: join(dirname(io.configPath), "known_hosts"),
  };
}

/** --domain, else a sslip.io name for an IP host, else the host name itself. */
export function sshDomain(plan: Pick<UpPlan, "domain">, target: SshTarget): string {
  if (plan.domain) return plan.domain;
  if (isIPv4(target.host)) return sslipName(target.host);
  if (isHostname(target.host.toLowerCase())) return target.host.toLowerCase();
  throw new Error(
    `--host ${target.host} is neither an IPv4 address nor a DNS name: pass --domain <name> for HTTPS`,
  );
}

/** ssh with no prompts: it fails fast instead of waiting for a password or a host key answer. */
export function sshArgs(target: SshTarget): string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ServerAliveInterval=15",
    ...(target.knownHosts ? ["-o", `UserKnownHostsFile=${target.knownHosts}`] : []),
    ...(target.hostKeyAlias ? ["-o", `HostKeyAlias=${target.hostKeyAlias}`] : []),
    ...(target.port ? ["-p", String(target.port)] : []),
    ...(target.identity ? ["-i", target.identity] : []),
    `${target.user}@${target.host}`,
  ];
}

export const sshLogin = (target: SshTarget) =>
  [
    "ssh",
    ...(target.port ? ["-p", String(target.port)] : []),
    `${target.user}@${target.host}`,
  ].join(" ");

/** The remote command that runs a script from stdin as root. */
export const rootShell = (sudo: boolean) => (sudo ? "sudo -n sh -s" : "sh -s");
const runner = (target: SshTarget) => rootShell(target.user !== "root");

/** What install.sh prints when it finds an earlier install's .env. */
const EXISTING_INSTALL = "selfhost: kept the secrets already in .env";

export const ssh: ProviderDriver = {
  describe(plan, userData) {
    const target = plan.ssh as SshTarget;
    const script = userData({ domain: sshDomain(plan, target) });
    const login = `${target.user}@${target.host}`;
    return {
      steps: [
        `Connect to ${login} with ssh (no password prompts) and check it is Linux`,
        `Run the script below there as root (${runner(target)})`,
      ],
      userData: script,
      userDataNote: "sent over SSH on stdin",
    };
  },

  async deploy({ io, plan, log, userData }: DeployContext): Promise<Deployed> {
    const target = plan.ssh as SshTarget;
    const login = `${target.user}@${target.host}`;
    const domain = sshDomain(plan, target);
    const base = sshArgs(target);

    log(`Connecting to ${login}`);
    const check = await io.exec("ssh", [...base, "uname -s; id -u"]);
    if (check.code === 127) throw new UpError("ssh is not on PATH: install OpenSSH.");
    if (check.code !== 0) {
      throw new UpError(
        `Could not connect over SSH to ${login}: ${check.stderr.trim() || `ssh exited with ${check.code}`}`,
        [],
        [
          "selfhost up uses ssh with BatchMode, so the key must work without a password prompt: load it into ssh-agent or pass -i <key>.",
          `Try it by hand: ${sshLogin(target)} true`,
        ],
      );
    }
    const [system = "", uid = ""] = check.stdout.trim().split("\n");
    if (system.trim() !== "Linux") {
      throw new UpError(`${login} runs ${system.trim() || "an unknown system"}, not Linux.`);
    }

    log(`Installing on ${login}; this takes a few minutes the first time`);
    const output: string[] = [];
    const result = await io.exec("ssh", [...base, rootShell(uid.trim() !== "0")], {
      input: userData({ domain }),
      onLine: (line) => {
        output.push(line);
        if (line.startsWith("selfhost: ")) log(`  ${line.slice("selfhost: ".length)}`);
      },
    });
    if (result.code !== 0) {
      const tail = (output.length > 0 ? output : `${result.stdout}\n${result.stderr}`.split("\n"))
        .filter((line) => line.trim() !== "")
        .slice(-15);
      throw new UpError(
        `The install on ${login} failed (exit ${result.code}). Its last lines:\n${tail.map((line) => `  | ${line}`).join("\n")}`,
        [],
        /sudo: .*password/i.test(result.stderr)
          ? [`${target.user} needs sudo without a password, or connect as root.`]
          : ["Run it again once fixed: the install keeps the secrets of an earlier run."],
      );
    }
    return {
      target,
      ip: isIPv4(target.host) ? target.host : null,
      domain,
      region: null,
      size: null,
      ssh: sshLogin(target),
      sudo: uid.trim() !== "0",
      existingInstall: result.stdout.includes(EXISTING_INSTALL),
    };
  },
};

/**
 * Once the server answers over HTTPS: turns on sign-in with the OAuth client secret when asked,
 * then reads back the tokens install.sh generated. Secrets only ever travel over SSH.
 */
export async function finishOverSsh(
  deployed: Deployed,
  signin: SigninSettings | null,
  io: UpIo,
  log: (line: string) => void,
  gateway = false,
): Promise<ReturnType<typeof parseReadBack>> {
  const login = `${deployed.target.user}@${deployed.target.host}`;
  log(
    signin || gateway
      ? `Turning on ${[signin ? "sign-in" : "", gateway ? "the AI gateway" : ""].filter(Boolean).join(" and ")} over SSH on ${login}, and reading the tokens it generated`
      : `Reading the tokens the server generated, over SSH on ${login}`,
  );
  const result = await io.exec("ssh", [...sshArgs(deployed.target), rootShell(deployed.sudo)], {
    input: finishScript(signin, gateway),
    onLine: (line) => {
      if (line.startsWith("selfhost: ")) log(`  ${line.slice("selfhost: ".length)}`);
    },
  });
  if (result.code === 127) throw new Error("ssh is not on PATH: install OpenSSH.");
  if (result.code !== 0) {
    const tail = result.stderr
      .split("\n")
      .filter((line) => line.trim() !== "")
      .slice(-10);
    throw new Error(
      `ssh to ${login} failed (exit ${result.code})${tail.length > 0 ? `:\n${tail.map((line) => `  | ${line}`).join("\n")}` : ""}`,
    );
  }
  return parseReadBack(result.stdout);
}
