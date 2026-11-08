import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import type { HealthResponse } from "@selfhost/schema";
import type { Command } from "commander";
import { table } from "../format.js";
import { serverUrl } from "../team/client.js";
import { joinTeam, teamInit } from "../team/commands.js";
import { aws } from "./aws.js";
import { findPublicKey } from "./cloud-api.js";
import { digitalocean } from "./digitalocean.js";
import { hetzner } from "./hetzner.js";
import type { Deployed, ProviderDriver, UpIo, UpPlan } from "./plan.js";
import { saveDeployment } from "./record.js";
import { type CreatedResource, deleteCommands, Tracker, UpError } from "./resources.js";
import {
  launchDiskGb,
  PROVIDERS,
  type Provider,
  RETENTION_DAYS,
  recommendSize,
  type SizeRecommendation,
} from "./size.js";
import { finishOverSsh, parseSshTarget, ssh, sshDomain } from "./ssh.js";
import {
  bootstrapScript,
  DEFAULT_IMAGE,
  defaultVersion,
  finishScript,
  isHostname,
  type SigninProvider,
  type SigninSettings,
  STACK_DIR,
  type StackSettings,
} from "./stack.js";

export interface UpOptions {
  provider?: string;
  host?: string;
  port?: string;
  identity?: string;
  sshKey?: string;
  region?: string;
  size?: string;
  people?: string;
  eventsPerDay?: string;
  name?: string;
  domain?: string;
  image?: string;
  signin?: string;
  signinClientId?: string;
  signinClientSecret?: string;
  allowEmail?: string[];
  allowDomain?: string[];
  githubOrg?: string;
  backupTime?: string;
  backupKeepDays?: string;
  /** Run the bundled AI gateway (Bifrost) next to the server. */
  gateway?: boolean;
  /** Team to create on the new server; false with --no-team. */
  team?: string | false;
  join?: boolean;
  person?: string;
  wait?: string;
  dryRun?: boolean;
  json?: boolean;
}

/** `selfhost up --json`. */
export interface UpReport {
  schema: "selfhost.up/v1";
  dry_run: boolean;
  provider: Provider;
  name: string;
  /** https://<domain>; null in a dry run when the domain comes from the server's IP. */
  url: string | null;
  domain: string | null;
  domain_source: "flag" | "sslip.io" | "ssh_host";
  ip: string | null;
  region: string | null;
  size: string | null;
  recommendation: SizeRecommendation;
  ssh: string | null;
  stack_dir: string;
  healthy: boolean;
  signin: {
    provider: SigninProvider;
    callback_url: string | null;
    email_domains: string[];
    emails: string[];
    github_org: string | null;
  } | null;
  backups: { time_utc: string; keep_days: number; dir: string; restore: string };
  /** The bundled AI gateway, with --gateway: where agents reach it. */
  gateway: { base_url: string | null } | null;
  team: { id: string; name: string; invite_expires_at: string; join_command: string } | null;
  joined: boolean;
  /** For `selfhost agents configure`: agents' OpenTelemetry straight to the server. */
  otel: { endpoint: string; header: string } | null;
  /** Where the server and its admin token were saved. */
  config: string | null;
  resources: CreatedResource[];
  /** Dry run: what would happen, in order. */
  steps: string[];
  /** Dry run: the cloud-init user-data, or the script run over SSH. It holds no secret. */
  user_data: string | null;
  /**
   * Dry run: the script run over SSH once HTTPS answers. It turns on sign-in with the OAuth
   * client secret (a placeholder here) and reads back the tokens the server generated.
   */
  ssh_script: string | null;
  warnings: string[];
}

const DRIVERS: Record<Provider, ProviderDriver> = { hetzner, digitalocean, aws, ssh };
const DEFAULT_REGION: Record<Provider, string | null> = {
  hetzner: "fsn1",
  digitalocean: "nyc3",
  aws: null,
  ssh: null,
};
const PROVIDER_NAMES: Record<Provider, string> = {
  hetzner: "Hetzner Cloud",
  digitalocean: "DigitalOcean",
  aws: "AWS",
  ssh: "SSH",
};
const SIGNIN_NAMES: Record<SigninProvider, string> = { github: "GitHub", google: "Google" };
const HEALTH_INTERVAL_MS = 10_000;

const OAUTH_VALUE = /^[A-Za-z0-9._~+/=-]+$/;
const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

function whole(value: string | undefined, flag: string, fallback: number, min: number): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min) {
    throw new Error(`${flag}: expected a whole number, ${min} or more, got "${value}"`);
  }
  return number;
}

function imageRef(value: string | undefined): { image: string; version: string } {
  if (value === undefined) return { image: DEFAULT_IMAGE, version: defaultVersion() };
  const colon = value.lastIndexOf(":");
  const image = value.slice(0, colon);
  const version = value.slice(colon + 1);
  if (colon <= value.lastIndexOf("/") || !image || !/^[\w][\w.-]{0,127}$/.test(version)) {
    throw new Error(
      `--image: expected an image with a tag, like ghcr.io/me/selfhost:1.2.3, got "${value}"`,
    );
  }
  if (!/^[a-z0-9][a-z0-9._/:-]*$/.test(image)) {
    throw new Error(`--image: "${image}" is not an image name`);
  }
  if (/latest/i.test(version)) throw new Error("--image: name an exact version, not latest");
  return { image, version };
}

function signinSettings(options: UpOptions, env: NodeJS.ProcessEnv, dryRun: boolean) {
  const warnings: string[] = [];
  if (options.signin === undefined) {
    if (options.allowEmail?.length || options.allowDomain?.length || options.githubOrg) {
      throw new Error(
        "--allow-email, --allow-domain and --github-org need --signin github or google",
      );
    }
    return { signin: null, warnings };
  }
  const provider = options.signin.trim().toLowerCase();
  if (provider !== "github" && provider !== "google") {
    throw new Error(`--signin: expected github or google, got "${options.signin}"`);
  }
  const clientId = (options.signinClientId ?? env.SELFHOST_SIGNIN_CLIENT_ID ?? "").trim();
  const secret = (options.signinClientSecret ?? env.SELFHOST_SIGNIN_CLIENT_SECRET ?? "").trim();
  if (!clientId) {
    throw new Error(
      `--signin ${provider} needs the OAuth app's client id: --signin-client-id or SELFHOST_SIGNIN_CLIENT_ID`,
    );
  }
  if (!secret && !dryRun) {
    throw new Error(
      `--signin ${provider} needs the OAuth app's client secret: set SELFHOST_SIGNIN_CLIENT_SECRET (or --signin-client-secret)`,
    );
  }
  if (!secret) warnings.push("No OAuth client secret yet: set SELFHOST_SIGNIN_CLIENT_SECRET.");
  for (const [name, value] of [
    ["client id", clientId],
    ["client secret", secret],
  ] as const) {
    if (value && !OAUTH_VALUE.test(value)) {
      throw new Error(`The OAuth ${name} has characters an OAuth ${name} does not`);
    }
  }
  const emails = (options.allowEmail ?? []).map((email) => email.trim().toLowerCase());
  const domains = (options.allowDomain ?? []).map((domain) =>
    domain.trim().toLowerCase().replace(/^@/, ""),
  );
  for (const email of emails) {
    if (!EMAIL.test(email)) throw new Error(`--allow-email: "${email}" is not an email address`);
  }
  for (const domain of domains) {
    if (!isHostname(domain)) throw new Error(`--allow-domain: "${domain}" is not a domain`);
  }
  const org = options.githubOrg?.trim() || null;
  if (org && provider !== "github") throw new Error("--github-org works with --signin github only");
  if (org && !/^[A-Za-z0-9-]+$/.test(org)) {
    throw new Error(`--github-org: "${org}" is not a GitHub organization name`);
  }
  if (emails.length === 0 && domains.length === 0 && !org) {
    throw new Error(
      `--signin ${provider} needs to know who may sign in: --allow-email, --allow-domain${provider === "github" ? " or --github-org" : ""}`,
    );
  }
  const signin: SigninSettings = {
    provider,
    clientId,
    clientSecret: dryRun ? "<from SELFHOST_SIGNIN_CLIENT_SECRET>" : secret,
    emailDomains: domains,
    emails,
    githubOrg: org,
  };
  return { signin, warnings };
}

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

/** Everything decided from the flags and environment, before any request. */
function makePlan(options: UpOptions, io: UpIo) {
  const provider = options.provider?.trim().toLowerCase() as Provider | undefined;
  if (!provider || !PROVIDERS.includes(provider)) {
    throw new Error(
      `--provider: expected ${PROVIDERS.join(", ")}, got ${options.provider ? `"${options.provider}"` : "nothing"}`,
    );
  }
  const dryRun = options.dryRun ?? false;
  const random = io.randomHex ?? hex;
  const isSsh = provider === "ssh";
  if (isSsh && !options.host) throw new Error("--provider ssh needs --host <user@host>");
  if (!isSsh) {
    for (const [flag, value] of [
      ["--host", options.host],
      ["--port", options.port],
      ["--identity", options.identity],
    ] as const) {
      if (value !== undefined) throw new Error(`${flag} is for --provider ssh`);
    }
  } else {
    for (const [flag, value] of [
      ["--ssh-key", options.sshKey],
      ["--region", options.region],
      ["--size", options.size],
    ] as const) {
      if (value !== undefined)
        throw new Error(`${flag} is for cloud providers, not --provider ssh`);
    }
  }
  const name = options.name?.trim() ?? `selfhost-${random(2)}`;
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) {
    throw new Error(
      `--name: lowercase letters, digits and dashes, starting with a letter, got "${name}"`,
    );
  }
  const domain = options.domain?.trim().toLowerCase().replace(/\.$/, "") || null;
  if (domain && !isHostname(domain)) {
    throw new Error(
      `--domain: expected a DNS name like selfhost.example.com, got "${options.domain}"`,
    );
  }
  const backupTime = options.backupTime?.trim() ?? "03:00";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(backupTime)) {
    throw new Error(
      `--backup-time: expected HH:MM in UTC, like 03:00, got "${options.backupTime}"`,
    );
  }
  const backupKeepDays = whole(options.backupKeepDays, "--backup-keep-days", 14, 1);
  const people = whole(options.people, "--people", 5, 1);
  const eventsPerDay =
    options.eventsPerDay === undefined
      ? undefined
      : whole(options.eventsPerDay, "--events-per-day", 0, 0);
  const recommendation = recommendSize({ people, eventsPerDay, backupKeepDays });
  const { image, version } = imageRef(options.image);
  const { signin, warnings } = signinSettings(options, io.env, dryRun);
  const waitMinutes = whole(options.wait, "--wait", 15, 1);

  let publicKey: UpPlan["publicKey"] = null;
  if (!isSsh) {
    try {
      publicKey = findPublicKey(options.sshKey, io.env);
    } catch (error) {
      if (!dryRun) throw error;
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }
  const port = options.port === undefined ? null : whole(options.port, "--port", 22, 1);
  const settings: StackSettings = {
    image,
    version,
    backupTime,
    backupKeepDays,
    ...(options.gateway ? { gateway: true } : {}),
  };
  const plan: UpPlan = {
    provider,
    name,
    region: options.region?.trim() || DEFAULT_REGION[provider],
    sizes: isSsh
      ? []
      : options.size
        ? [options.size.trim()]
        : recommendation.types[provider].map((type) => type.name),
    recommendation,
    diskGb: launchDiskGb(recommendation),
    domain,
    settings,
    signin,
    publicKey,
    ssh: isSsh
      ? parseSshTarget(options.host as string, port, options.identity?.trim() || null)
      : null,
  };
  if (!isSsh && !options.size) {
    const chosen = recommendation.types[provider as Exclude<Provider, "ssh">][0];
    if (chosen && !chosen.fits_disk) {
      warnings.push(
        `The ${chosen.disk_gb} GB disk of ${chosen.name} is below the ${recommendation.disk.total_gb} GB estimate: keep fewer backups (--backup-keep-days) or pass a bigger --size.`,
      );
    }
  }
  // Fails now, before anything is created, when an SSH host gives no HTTPS name.
  const sshName = plan.ssh ? sshDomain(plan, plan.ssh) : null;
  if (!domain && (!sshName || sshName.endsWith(".sslip.io"))) {
    warnings.push(
      "The address is a sslip.io name, which depends on the sslip.io DNS service: for a server a team relies on, use --domain with a name you control.",
    );
  }
  warnings.push(...recommendation.notes);
  return { plan, warnings, waitMs: waitMinutes * 60_000 };
}

async function waitForHealth(
  url: string,
  io: UpIo,
  timeoutMs: number,
  log: (line: string) => void,
): Promise<boolean> {
  const attempts = Math.max(1, Math.ceil(timeoutMs / HEALTH_INTERVAL_MS));
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await io.fetch(`${url}/v1/health`, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(HEALTH_INTERVAL_MS),
      });
      if (response.ok && ((await response.json()) as HealthResponse).ok === true) return true;
    } catch {
      // Not up yet: no DNS, no certificate or no server behind Caddy.
    }
    if (attempt % 6 === 0) log(`  still waiting, ${attempt / 6} min so far`);
    if (attempt < attempts) await io.sleep(HEALTH_INTERVAL_MS);
  }
  return false;
}

const tilde = (path: string, env: NodeJS.ProcessEnv) => {
  const home = env.HOME || homedir();
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
};

/** Who may sign in: an email rule, an organization, or both, in which case both must hold. */
function signinWho(signin: SigninSettings): string {
  const emails = [
    ...(signin.emailDomains.length > 0 ? [`at ${signin.emailDomains.join(", ")}`] : []),
    ...(signin.emails.length > 0 ? [`one of ${signin.emails.join(", ")}`] : []),
  ];
  const rule = emails.length > 0 ? `whose email is ${emails.join(" or ")}` : "";
  return signin.githubOrg
    ? `members of the GitHub organization ${signin.githubOrg}${rule ? ` ${rule}` : ""}`
    : `people ${rule}`;
}

function restoreCommand(sshLogin: string | null, sudo: boolean): string {
  const command = `cd ${STACK_DIR} && ${sudo ? "sudo " : ""}./restore.sh --force backups/<file>.dump`;
  return sshLogin ? `${sshLogin} '${command}'` : command;
}

function baseReport(
  plan: UpPlan,
  deployed: Deployed | null,
  warnings: string[],
  dryRun: boolean,
): UpReport {
  const domain = deployed?.domain ?? plan.domain ?? (plan.ssh ? sshDomain(plan, plan.ssh) : null);
  const url = domain ? `https://${domain}` : null;
  const { settings, signin } = plan;
  return {
    schema: "selfhost.up/v1",
    dry_run: dryRun,
    provider: plan.provider,
    name: plan.name,
    url,
    domain,
    domain_source: plan.domain
      ? "flag"
      : domain && !domain.endsWith(".sslip.io")
        ? "ssh_host"
        : "sslip.io",
    ip: deployed?.ip ?? null,
    region: deployed?.region ?? plan.region,
    size: deployed?.size ?? plan.sizes[0] ?? null,
    recommendation: plan.recommendation,
    ssh: deployed?.ssh ?? null,
    stack_dir: STACK_DIR,
    healthy: false,
    signin: signin
      ? {
          provider: signin.provider,
          callback_url: url ? `${url}/oauth2/callback` : null,
          email_domains: signin.emailDomains,
          emails: signin.emails,
          github_org: signin.githubOrg,
        }
      : null,
    backups: {
      time_utc: settings.backupTime,
      keep_days: settings.backupKeepDays,
      dir: `${STACK_DIR}/backups`,
      restore: restoreCommand(deployed?.ssh ?? null, deployed?.sudo ?? false),
    },
    gateway: settings.gateway ? { base_url: url ? `${url}/llm` : null } : null,
    team: null,
    joined: false,
    otel: null,
    config: null,
    resources: [],
    steps: [],
    user_data: null,
    ssh_script: null,
    warnings,
  };
}

function sizeLine(report: UpReport): string {
  const r = report.recommendation;
  const events = `${r.events_estimated ? "about " : ""}${r.events_per_day.toLocaleString("en-US")} events a day`;
  return `${r.tier} (${r.vcpus} vCPU, ${r.memory_gb} GB), for ${r.people} people and ${events}`;
}

function printDryRun(report: UpReport, plan: UpPlan, note: string, write: (line: string) => void) {
  const r = report.recommendation;
  write("Dry run: nothing is created and no request is sent.");
  write("");
  const where =
    plan.provider === "ssh"
      ? `${plan.ssh?.user}@${plan.ssh?.host}`
      : `${PROVIDER_NAMES[plan.provider]}, ${plan.region ?? "the aws CLI's region"}`;
  const address = report.url
    ? report.url
    : "https://<server IP>.sslip.io: sslip.io resolves the name to the IP, so no DNS is needed (--domain for your own)";
  table(
    [
      ["  Server", where],
      [
        "  Size",
        plan.provider === "ssh"
          ? `the server as it is; recommended ${sizeLine(report)}`
          : `${plan.sizes.join(", else ")}: ${sizeLine(report)}`,
      ],
      [
        "  Disk",
        `about ${r.disk.total_gb} GB: database ${r.disk.database_gb} GB over ${RETENTION_DAYS} days, ${report.backups.keep_days} daily backups ${r.disk.backups_gb} GB, system ${r.disk.system_gb} GB`,
      ],
      ["  Address", address],
      ["  Sign-in", signinText(report, plan)],
      ["  Gateway", gatewayText(report)],
      [
        "  Backups",
        `daily at ${report.backups.time_utc} UTC into ${report.backups.dir}, kept ${report.backups.keep_days} days`,
      ],
    ],
    write,
  );
  write("");
  write("Steps");
  report.steps.forEach((step, index) => {
    write(`  ${index + 1}. ${step}`);
  });
  for (const warning of report.warnings) write(`Note: ${warning}`);
  write("");
  const label = plan.provider === "ssh" ? "Script run over SSH" : "cloud-init user-data";
  write(`${label} (${note}; no secret in it, install.sh generates them on the server):`);
  write(report.user_data ?? "");
  write("Then over SSH, once HTTPS answers (the OAuth client secret travels only here):");
  write(report.ssh_script ?? "");
}

function signinText(report: UpReport, plan: UpPlan): string {
  const { signin } = plan;
  if (!signin) {
    return "off: the console asks each person for their selfhost token; selfhost up --signin github or google adds sign-in. /v1 keeps its bearer tokens";
  }
  const callback = report.signin?.callback_url ?? "https://<domain>/oauth2/callback";
  return `${SIGNIN_NAMES[signin.provider]} through oauth2-proxy, for ${signinWho(signin)}. OAuth app callback URL: ${callback}`;
}

function gatewayText(report: UpReport): string {
  if (!report.gateway) {
    return "off: agents talk to their vendors directly; selfhost up --gateway adds Bifrost with per-person keys and hard budgets";
  }
  const at = report.gateway.base_url ?? "https://<domain>/llm";
  return `Bifrost at ${at}, behind virtual keys. Put provider keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...) in ${STACK_DIR}/.env on the server and run ./install.sh there; then each person runs selfhost gateway connect <agent>`;
}

function printDone(report: UpReport, plan: UpPlan, deployed: Deployed, io: UpIo) {
  const { write } = io;
  const tls =
    report.domain_source === "sslip.io"
      ? `certificate from Let's Encrypt through Caddy. ${report.domain} is a sslip.io name that resolves to the IP; pass --domain for your own`
      : `certificate for ${report.domain} from Let's Encrypt through Caddy`;
  write("");
  write(`selfhost is up at ${report.url}`);
  const server =
    plan.provider === "ssh"
      ? `${deployed.ssh}`
      : `${PROVIDER_NAMES[plan.provider]} ${deployed.size} in ${deployed.region}, ${deployed.ip} (${deployed.ssh})`;
  table(
    [
      ["  Server", server],
      ["  HTTPS", tls],
      [
        "  Open",
        plan.provider === "ssh"
          ? "Docker publishes 80 and 443 only; the API and the collector answer inside the server. The host's own firewall is as it was"
          : "ports 22, 80 and 443 only; the API and the collector answer inside the server",
      ],
      ["  Sign-in", signinText(report, plan)],
      ["  Gateway", gatewayText(report)],
      [
        "  Backups",
        `daily at ${report.backups.time_utc} UTC into ${report.backups.dir}, kept ${report.backups.keep_days} days, on the server's disk only: they are lost with the server, so copy them elsewhere`,
      ],
      ["", `Restore: ${report.backups.restore}`],
      [
        "  Admin",
        `token saved in ${tilde(io.configPath, io.env)} (mode 0600) for selfhost team commands; it stays in ${STACK_DIR}/.env on the server`,
      ],
      ...(deployed.existingInstall
        ? [
            [
              "",
              "The server already ran selfhost: it kept its database and tokens, and no team was created.",
            ],
          ]
        : []),
    ],
    write,
  );
  write("");
  if (report.team) {
    write(
      `Created team ${report.team.name} (${report.team.id}). Share this with each teammate; anyone holding it can join until ${report.team.invite_expires_at.replace("T", " ").replace(/:\d{2}\.\d{3}Z$/, " UTC")}:`,
    );
    write(`  ${report.team.join_command}`);
    write(
      report.joined
        ? "This laptop joined it: selfhost import now sends its usage there."
        : "Run it on this laptop too to send its usage there, or pass --join next time.",
    );
    write("");
  }
  if (report.otel) {
    write("Agents can also send OpenTelemetry straight to the server:");
    write(
      `  selfhost agents configure --otel-endpoint ${report.otel.endpoint} --otel-header "${report.otel.header}"`,
    );
    write("");
  }
  if (report.resources.length > 0) {
    write("To delete it all, in this order:");
    for (const command of deleteCommands(report.resources)) write(`  ${command}`);
  }
  for (const warning of report.warnings) write(`Note: ${warning}`);
}

function healthHints(plan: UpPlan, deployed: Deployed): string[] {
  const login = deployed.ssh;
  const sudo = deployed.sudo ? "sudo " : "";
  return [
    ...(plan.provider === "ssh"
      ? []
      : [`Install progress: ${login} ${sudo}tail -n 50 /var/log/cloud-init-output.log`]),
    ...(plan.domain && deployed.ip
      ? [
          `Check that ${plan.domain} has an A record for ${deployed.ip}; Caddy keeps asking for the certificate.`,
        ]
      : []),
    `Containers: ${login} 'cd ${STACK_DIR} && ${sudo}docker compose ps && ${sudo}docker compose logs --tail 30 caddy selfhost'`,
    `The admin token is SELFHOST_TOKEN in ${STACK_DIR}/.env on the server.`,
  ];
}

/**
 * `selfhost up`: sets up the selfhost team server (the ledger API, the review list and the
 * console) on a new Hetzner, DigitalOcean or AWS server, or on any Linux server over SSH, with
 * HTTPS, daily backups and optional GitHub or Google sign-in. Agents keep running where they
 * are; no model traffic goes through the server.
 */
export async function runUp(options: UpOptions, io: UpIo): Promise<UpReport> {
  const { plan, warnings, waitMs } = makePlan(options, io);
  const driver = DRIVERS[plan.provider];
  const dryRun = options.dryRun ?? false;
  const log = options.json ? () => {} : io.write;
  const userData = (domain: Parameters<typeof bootstrapScript>[1]) =>
    bootstrapScript(plan.settings, domain);

  if (dryRun) {
    const described = driver.describe(plan, userData);
    const report = baseReport(plan, null, warnings, true);
    const health = report.url ?? "https://<server IP>.sslip.io";
    report.steps = [
      ...described.steps,
      plan.provider === "ssh"
        ? `Wait for ${health}/v1/health (Caddy gets the certificate within a minute or two)`
        : `Wait for ${health}/v1/health, up to ${waitMs / 60_000} minutes (cloud-init installs Docker and starts the stack, usually in 3 to 6)`,
      plan.signin || plan.settings.gateway
        ? `Over SSH: ${[
            ...(plan.signin
              ? ["write the sign-in settings and the OAuth client secret to .env (mode 0600)"]
              : []),
            ...(plan.settings.gateway ? ["write the AI gateway's files and turn it on"] : []),
          ].join(", ")}, run install.sh again, and read back the tokens it generated`
        : "Over SSH: read back the tokens install.sh generated",
      `Save the server and its admin token in ${tilde(io.configPath, io.env)} (mode 0600)`,
      ...(options.team === false
        ? []
        : [`Create team ${options.team ?? "default"} and print the line teammates join with`]),
      ...(options.join ? ["Join this laptop to the team"] : []),
    ];
    report.user_data = described.userData;
    report.ssh_script = finishScript(plan.signin, plan.settings.gateway);
    if (options.json) io.write(JSON.stringify(report, null, 2));
    else printDryRun(report, plan, described.userDataNote, io.write);
    return report;
  }

  const tracker = new Tracker();
  let deployed: Deployed;
  try {
    deployed = await driver.deploy({ io, plan, tracker, log, userData });
  } catch (error) {
    if (error instanceof UpError) {
      throw new UpError(error.reason, [...tracker.resources], error.hints);
    }
    throw new UpError(error instanceof Error ? error.message : String(error), [
      ...tracker.resources,
    ]);
  }

  const report = baseReport(plan, deployed, warnings, false);
  const url = serverUrl(`https://${deployed.domain}`);
  report.resources = [...tracker.resources];
  const record = {
    server: url,
    provider: plan.provider,
    created_at: (io.now ?? new Date()).toISOString(),
    ip: deployed.ip,
    domain: deployed.domain,
    region: deployed.region,
    size: deployed.size,
    ssh: deployed.ssh,
    stack_dir: STACK_DIR,
    admin_token: null,
    resources: report.resources,
  };
  saveDeployment(io.configPath, record);
  report.config = io.configPath;

  if (plan.domain && deployed.ip && plan.provider !== "ssh") {
    log(
      `Point an A record for ${plan.domain} at ${deployed.ip} now; Caddy gets the certificate once it resolves.`,
    );
  }
  log(
    plan.provider === "ssh"
      ? `Waiting for ${url}/v1/health while Caddy gets the certificate`
      : `Waiting for ${url}/v1/health: cloud-init installs Docker and starts the stack, usually in 3 to 6 minutes`,
  );
  if (!(await waitForHealth(url, io, waitMs, log))) {
    throw new UpError(
      `${url}/v1/health did not answer within ${waitMs / 60_000} minutes.`,
      report.resources,
      healthHints(plan, deployed),
    );
  }

  let tokens: Awaited<ReturnType<typeof finishOverSsh>>;
  try {
    tokens = await finishOverSsh(deployed, plan.signin, io, log, plan.settings.gateway);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const sudo = deployed.sudo ? "sudo " : "";
    throw new UpError(
      `${url} is up, but selfhost up could not finish over SSH: ${message}`,
      report.resources,
      [
        `Read the admin token by hand: ${deployed.ssh} ${sudo}grep ^SELFHOST_TOKEN= ${STACK_DIR}/.env`,
        ...(plan.signin
          ? [
              `Sign-in is not on yet. Once ssh works without a prompt (ssh-agent, or the key next to ${plan.publicKey?.path ?? "the public key"}), run the same selfhost up with --provider ssh --host ${deployed.target.user}@${deployed.target.host}.`,
            ]
          : []),
      ],
    );
  }
  saveDeployment(io.configPath, { ...record, admin_token: tokens.SELFHOST_TOKEN });
  if (plan.signin && !(await waitForHealth(url, io, waitMs, log))) {
    throw new UpError(
      `${url}/v1/health stopped answering after sign-in was turned on.`,
      report.resources,
      healthHints(plan, deployed),
    );
  }
  report.healthy = true;
  report.otel = {
    endpoint: `${url}/otlp`,
    header: `Authorization=Bearer ${tokens.SELFHOST_OTLP_TOKEN}`,
  };

  const teamIo = { env: io.env, write: () => {}, configPath: io.configPath, fetch: io.fetch };
  if (options.team !== false && !deployed.existingInstall) {
    try {
      const created = await teamInit(
        { server: url, name: options.team ?? "default", token: tokens.SELFHOST_TOKEN, json: true },
        teamIo,
      );
      report.team = {
        id: created.team.id,
        name: created.team.name,
        invite_expires_at: created.invite_expires_at,
        join_command: created.join_command,
      };
      if (options.join) {
        await joinTeam(url, created.invite, { person: options.person, json: true }, teamIo);
        report.joined = true;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.warnings.push(
        report.team
          ? `Could not join this laptop: ${message}`
          : `Could not create the team: ${message}. Create it with: selfhost team init --server ${url}`,
      );
    }
  }
  if (options.json) io.write(JSON.stringify(report, null, 2));
  else printDone(report, plan, deployed, io);
  return report;
}

const collect = (value: string, previous: string[]) => [...previous, value];

export function registerUp(
  program: Command,
  io: () => UpIo,
  fail: (error: unknown, json: boolean | undefined) => void,
): void {
  program
    .command("up")
    .description(
      "set up the selfhost team server (ledger, review list, console) on Hetzner, DigitalOcean, AWS or any server over SSH, with HTTPS, daily backups and sign-in",
    )
    .option("--provider <name>", "hetzner, digitalocean, aws or ssh")
    .option("--host <user@host>", "ssh: the server to install on (user defaults to root)")
    .option("--port <port>", "ssh: port")
    .option("-i, --identity <file>", "ssh: private key (default: ssh-agent and ~/.ssh)")
    .option(
      "--ssh-key <file>",
      "cloud: public key for the new server (default: ~/.ssh/id_ed25519.pub, id_ecdsa.pub or id_rsa.pub)",
    )
    .option(
      "--region <region>",
      "cloud: Hetzner location (fsn1), DigitalOcean region (nyc3) or AWS region (AWS_REGION)",
    )
    .option("--size <type>", "cloud: server type, instead of the recommended one")
    .option("--people <n>", "team size, for the size recommendation", "5")
    .option("--events-per-day <n>", "expected agent events a day (default: 1500 a person)")
    .option("--name <name>", "name for the server and its firewall (default: selfhost-<random>)")
    .option("--domain <name>", "hostname for HTTPS (default: <server IP>.sslip.io)")
    .option("--image <ref>", "server image with its tag (default: the release this CLI ships with)")
    .option("--signin <provider>", "console sign-in: github or google")
    .option("--signin-client-id <id>", "OAuth app client id (default: SELFHOST_SIGNIN_CLIENT_ID)")
    .option(
      "--signin-client-secret <secret>",
      "OAuth app client secret (prefer SELFHOST_SIGNIN_CLIENT_SECRET, kept out of shell history)",
    )
    .option("--allow-email <email>", "may sign in, repeatable", collect, [])
    .option("--allow-domain <domain>", "emails at this domain may sign in, repeatable", collect, [])
    .option("--github-org <org>", "only members of this GitHub organization may sign in")
    .option(
      "--gateway",
      "also run the AI gateway (Bifrost): per-person virtual keys and hard budgets from selfhost.toml",
    )
    .option("--backup-time <HH:MM>", "daily backup time in UTC", "03:00")
    .option("--backup-keep-days <n>", "days of daily backups to keep on the server", "14")
    .option("--team <name>", "team to create on the new server", "default")
    .option("--no-team", "create no team")
    .option("--join", "join this laptop to the new team")
    .option("--person <id>", "with --join: who you are on the team (default: git email)")
    .option("--wait <minutes>", "how long to wait for HTTPS to answer", "15")
    .option("--dry-run", "print the plan and the cloud-init user-data; create nothing")
    .option("--json", "print one selfhost.up/v1 object")
    .action(async (options: UpOptions) => {
      const deps = io();
      try {
        await runUp(options, deps);
      } catch (error) {
        if (options.json && error instanceof UpError) {
          deps.write(
            JSON.stringify(
              { schema: "selfhost.error/v1", error: error.message, resources: error.resources },
              null,
              2,
            ),
          );
          deps.setExitCode(1);
          return;
        }
        fail(error, options.json);
      }
    });
}
