import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { STACK_FILES } from "@selfhost/deploy/stack";
import { type Ledger, openLedger } from "@selfhost/ledger";
import { createApp } from "@selfhost/server/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AWS_IMAGE } from "../src/up/aws.js";
import { md5Fingerprint } from "../src/up/cloud-api.js";
import { runUp, type UpReport } from "../src/up/commands.js";
import { DIGITALOCEAN_METADATA } from "../src/up/digitalocean.js";
import { HETZNER_METADATA } from "../src/up/hetzner.js";
import type { UpIo } from "../src/up/plan.js";
import { imageLocation, registryImageCheck } from "../src/up/registry.js";
import type { ExecOptions, ExecResult } from "../src/up/resources.js";
import { EXISTING_INSTALL } from "../src/up/ssh.js";
import {
  BOOTSTRAP_FILES,
  bootstrapScript,
  caddyInternalName,
  DEFAULT_IMAGE,
  envFile,
  finishScript,
  parseReadBack,
  SERVER_FILES,
  SERVER_SECRETS,
  STACK_DIR,
  type StackSettings,
  signinEnvFile,
} from "../src/up/stack.js";
import { blockNetwork } from "./network.js";
import { run, tempDir } from "./run.js";

const fixtures = join(import.meta.dirname, "..", "..", "..", "fixtures", "cloud");
const fixture = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(fixtures, path), "utf8"));

/** The tokens install.sh generates on the server; the tests' server reads them back over SSH. */
const ADMIN = "1".repeat(64);
const OTLP = "2".repeat(64);
const HETZNER = "https://api.hetzner.cloud/v1";
const DO = "https://api.digitalocean.com/v2";

/** A well formed ed25519 public key; only its fingerprint matters here. */
function publicKey(): string {
  const u32 = (n: number) => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(n);
    return buffer;
  };
  const blob = Buffer.concat([u32(11), Buffer.from("ssh-ed25519"), u32(32), Buffer.alloc(32, 7)]);
  return `ssh-ed25519 ${blob.toString("base64")} dev@example.com`;
}
const KEY = publicKey();
const FINGERPRINT = md5Fingerprint(KEY);

function home() {
  const dir = tempDir("up-home");
  dir.write(".ssh/id_ed25519.pub", `${KEY}\n`);
  // Stands in for the private key: selfhost up only passes its path to ssh -i.
  dir.write(".ssh/id_ed25519", "placeholder\n", 0o600);
  return dir;
}

interface Route {
  method: string;
  url: string;
  status?: number;
  body: unknown;
}

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
  authorization: string | undefined;
}

/**
 * Answers cloud API calls from `routes`, each once and in the order listed, and passes requests
 * for `origin` to an in-process selfhost server, or answers its health check when there is none.
 */
function cloud(routes: Route[], origin: string, server?: ReturnType<typeof createApp>) {
  const queue = [...routes];
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    if (url.startsWith(origin)) {
      if (server) return server.request(url, init);
      return Response.json({ ok: true, version: "test" });
    }
    const method = init.method ?? "GET";
    const headers = init.headers as Record<string, string>;
    calls.push({
      method,
      url,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      authorization: headers.authorization,
    });
    const at = queue.findIndex((route) => route.method === method && route.url === url);
    if (at < 0) throw new Error(`unexpected ${method} ${url}`);
    const [route] = queue.splice(at, 1);
    return Response.json(route?.body, { status: route?.status ?? 200 });
  };
  return { fetch, calls, left: () => queue };
}

interface ExecCall {
  command: string;
  args: string[];
  input: string | undefined;
}

function recorder(answer: (args: string[], options?: ExecOptions) => ExecResult) {
  const calls: ExecCall[] = [];
  const exec = async (command: string, args: string[], options?: ExecOptions) => {
    calls.push({ command, args, input: options?.input });
    return answer([command, ...args], options);
  };
  return { exec, calls };
}
const ok = (stdout: unknown = ""): ExecResult => ({
  code: 0,
  stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout),
  stderr: "",
});

/** What the finish script prints on a server: the tokens install.sh generated there. */
const TOKENS = ok(`SELFHOST_TOKEN=${ADMIN}\nSELFHOST_OTLP_TOKEN=${OTLP}\n`);
const isFinish = (input: string | undefined) =>
  input?.startsWith(finishScript(null).split("\nset -eu")[0] ?? "") ?? false;

/** A server reached over ssh: the Linux check, the install script, then the finish script. */
function sshServer(
  answers: { uid?: string; install?: ExecResult; finish?: ExecResult; connect?: ExecResult } = {},
) {
  return recorder(([command, ...args], options) => {
    if (command !== "ssh") throw new Error(`unexpected ${command} ${args.join(" ")}`);
    const remote = args.at(-1);
    if (remote === "uname -s; id -u")
      return answers.connect ?? ok(`Linux\n${answers.uid ?? "0"}\n`);
    if (remote === "sh -s" || remote === "sudo -n sh -s") {
      return isFinish(options?.input)
        ? (answers.finish ?? TOKENS)
        : (answers.install ?? ok("selfhost: ready\n"));
    }
    throw new Error(`unexpected ssh ${args.join(" ")}`);
  });
}

/** The user-data holds no secret: no value for any secret setting, and none of these values. */
function expectNoSecrets(userData: string, values: string[]) {
  for (const value of values) expect(userData).not.toContain(value);
  for (const key of [...SERVER_SECRETS, "SELFHOST_SIGNIN_CLIENT_SECRET"]) {
    expect(userData).not.toMatch(new RegExp(`^${key}=.+$`, "m"));
  }
}

const ledgers: Ledger[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const ledger of ledgers.splice(0)) await ledger.close();
});

async function selfhostServer() {
  const ledger = await openLedger({ dataDir: "memory://" });
  ledgers.push(ledger);
  return createApp({ version: "test", ledger, token: ADMIN });
}

function io(
  dir: ReturnType<typeof home>,
  env: NodeJS.ProcessEnv,
  parts: Partial<UpIo>,
): UpIo & { out: string[] } {
  const out: string[] = [];
  return {
    env: { HOME: dir.root, ...env },
    write: (line) => out.push(line),
    setExitCode: () => {},
    configPath: dir.path(".selfhost", "config.json"),
    fetch: async () => {
      throw new Error("no network in this test");
    },
    exec: async () => {
      throw new Error("no programs in this test");
    },
    sleep: async () => {},
    // The image is published; its own tests below check the registry question.
    imageExists: async () => true,
    now: new Date("2026-11-08T10:00:00Z"),
    // The server name.
    randomHex: () => "ab12",
    ...parts,
    out,
  };
}

const settings = (over: Partial<StackSettings> = {}): StackSettings => ({
  image: DEFAULT_IMAGE,
  version: "0.1.0",
  backupTime: "03:00",
  backupKeepDays: 14,
  ...over,
});

const githubSignin = {
  provider: "github" as const,
  clientId: "Iv1.0123456789abcdef",
  clientSecret: "0123456789abcdef0123456789abcdef01234567",
  emailDomains: ["example.com"],
  emails: ["dev@example.com", "ops@example.com"],
  githubOrg: null,
};

const config = (path: string) => JSON.parse(readFileSync(path, "utf8"));

/** ssh options for a server selfhost up created, its host key kept under its name. */
const cloudSsh = (dir: ReturnType<typeof home>, login: string) => [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=15",
  "-o",
  "StrictHostKeyChecking=accept-new",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  `UserKnownHostsFile=${dir.path(".selfhost", "known_hosts")}`,
  "-o",
  "HostKeyAlias=selfhost-ab12",
  "-i",
  dir.path(".ssh", "id_ed25519"),
  login,
];

describe("the bootstrap script", () => {
  const stub = [
    { path: "compose.yml", mode: 0o644, content: "services: {}\n" },
    { path: "console/index.html", mode: 0o644, content: "<p>console</p>" },
    { path: "install.sh", mode: 0o755, content: "#!/bin/sh\necho installed\n" },
  ];

  it("writes the stack and a .env with no secret, then runs install.sh", async () => {
    const script = bootstrapScript(settings(), { domain: "selfhost.example.com" }, stub);
    await expect(script).toMatchFileSnapshot("__snapshots__/up-bootstrap.sh");
  });

  it("finds a sslip.io name from the metadata service when no domain is given", () => {
    const script = bootstrapScript(
      settings(),
      { metadataUrl: HETZNER_METADATA, from: "Hetzner" },
      stub,
    );
    expect(script).toContain(
      `ip=$(curl -fsS --retry 10 --retry-delay 3 --retry-connrefused ${HETZNER_METADATA})`,
    );
    expect(script).toContain('domain="$(echo "$ip" | tr . -).sslip.io"');
  });

  it.skipIf(process.platform === "win32")(
    "puts every server file on disk byte for byte, with the settings and the metadata name",
    () => {
      const dir = tempDir("up-bootstrap");
      // Stand-ins: the stack goes into a temp folder, curl answers as the metadata service would,
      // and install.sh is not run.
      dir.write("bin/curl", "#!/bin/sh\necho 5.6.7.8\n", 0o755);
      const script = bootstrapScript(settings(), {
        metadataUrl: DIGITALOCEAN_METADATA,
        from: "DigitalOcean",
      })
        .replaceAll(STACK_DIR, dir.path("stack"))
        .replace("exec sh ./install.sh </dev/null", "exit 0");
      execFileSync("sh", ["-c", script], {
        env: { PATH: `${dir.path("bin")}:${process.env.PATH}` },
      });
      for (const file of BOOTSTRAP_FILES) {
        const path = dir.path("stack", file.path);
        expect(readFileSync(path, "utf8"), file.path).toBe(file.content);
        expect(statSync(path).mode & 0o111, file.path).toBe(file.mode & 0o111 ? 0o111 : 0);
      }
      expect(existsSync(dir.path("stack", ".env.example"))).toBe(false);
      // The gateway's files go over SSH, only with --gateway; notifications are opt-in.
      expect(existsSync(dir.path("stack", "compose.gateway.yml"))).toBe(false);
      expect(existsSync(dir.path("stack", "compose.notify.yml"))).toBe(false);
      const env = dir.path("stack", ".env.next");
      expect(readFileSync(env, "utf8")).toBe(
        `${envFile(settings())}SELFHOST_DOMAIN=5-6-7-8.sslip.io\nSELFHOST_PUBLIC_URL=https://5-6-7-8.sslip.io\n`,
      );
      expect(statSync(env).mode & 0o777).toBe(0o600);
    },
  );

  it("ships every file of the stack but .env.example", () => {
    expect(SERVER_FILES.map((file) => file.path).sort()).toEqual(
      STACK_FILES.map((file) => file.path)
        .filter((path) => path !== ".env.example")
        .sort(),
    );
  });

  it("refuses a file that would end its here-document early", () => {
    const bad = [{ path: "x.sh", mode: 0o644, content: "a\nSELFHOST_EOF\nb\n" }];
    expect(() => bootstrapScript(settings(), { domain: "a.example.com" }, bad)).toThrow(
      /x\.sh has a line SELFHOST_EOF/,
    );
  });
});

describe("the .env selfhost up writes", () => {
  it("holds no secret, keeps the API and the collector off the internet, and adds HTTPS", () => {
    const env = envFile(settings());
    expect(env).toContain("COMPOSE_FILE=compose.yml:compose.tls.yml\n");
    expect(env).toContain("SELFHOST_BIND=127.0.0.1\nOTLP_BIND=127.0.0.1\n");
    // Empty, so install.sh generates them on the server, and keeps them on a rerun.
    for (const key of SERVER_SECRETS) expect(env).toContain(`\n${key}=\n`);
    expect(env).not.toContain("SIGNIN_PROVIDER");
  });

  it("adds the AI gateway over SSH with --gateway, with or without sign-in", () => {
    // Not in user-data, which Hetzner caps at 32 KB.
    const bootstrap = bootstrapScript(settings({ gateway: true }), { domain: "a.example.com" });
    expect(bootstrap).not.toContain("cat >compose.gateway.yml");
    expect(envFile(settings({ gateway: true }))).toContain(
      "COMPOSE_FILE=compose.yml:compose.tls.yml\n",
    );
    const alone = finishScript(null, true);
    expect(alone).toContain("cat >compose.gateway.yml <<'SELFHOST_EOF'");
    expect(alone).toContain("chmod 755 gateway-config.sh");
    expect(alone).toContain("COMPOSE_FILE=compose.yml:compose.tls.yml:compose.gateway.yml\n");
    expect(alone).toContain("sh ./install.sh");
    expect(finishScript(null)).not.toContain("install.sh");
    expect(signinEnvFile(githubSignin, true)).toContain(
      "COMPOSE_FILE=compose.yml:compose.tls.yml:compose.signin.yml:compose.gateway.yml\n",
    );
    expect(finishScript(githubSignin, true)).toContain("compose.signin.yml:compose.gateway.yml");
    // The gateway's admin key and encryption key are generated on the server, like the others.
    expect(SERVER_SECRETS).toContain("SELFHOST_GATEWAY_ADMIN_KEY");
    expect(SERVER_SECRETS).toContain("SELFHOST_GATEWAY_ENCRYPTION_KEY");
  });

  it("turns on sign-in over SSH, and lets a GitHub organization alone decide who signs in", () => {
    const env = signinEnvFile({ ...githubSignin, emailDomains: [], emails: [], githubOrg: "acme" });
    expect(env).toContain("COMPOSE_FILE=compose.yml:compose.tls.yml:compose.signin.yml\n");
    expect(env).toContain("SELFHOST_SIGNIN_EMAIL_DOMAINS=*\nSELFHOST_SIGNIN_GITHUB_ORG=acme\n");
    expect(signinEnvFile(githubSignin)).toContain(
      `SELFHOST_SIGNIN_CLIENT_SECRET=${githubSignin.clientSecret}\nSELFHOST_SIGNIN_EMAIL_DOMAINS=example.com\n`,
    );
  });
});

describe("the finish script", () => {
  it.skipIf(process.platform === "win32")(
    "writes sign-in to .env.next with mode 0600, runs install.sh, then prints only the tokens",
    () => {
      const dir = tempDir("up-finish");
      dir.write(
        "stack/.env",
        `POSTGRES_PASSWORD=p\nSELFHOST_TOKEN=${ADMIN}\nSELFHOST_OTLP_TOKEN=${OTLP}\n`,
      );
      dir.write("stack/install.sh", "echo 'selfhost: ready'\n");
      const script = finishScript(githubSignin).replaceAll(STACK_DIR, dir.path("stack"));
      const stdout = execFileSync("sh", ["-c", script], { stdio: ["ignore", "pipe", "ignore"] });
      expect(parseReadBack(stdout.toString())).toEqual({
        SELFHOST_TOKEN: ADMIN,
        SELFHOST_OTLP_TOKEN: OTLP,
      });
      expect(stdout.toString()).toBe(`SELFHOST_TOKEN=${ADMIN}\nSELFHOST_OTLP_TOKEN=${OTLP}\n`);
      const next = dir.path("stack", ".env.next");
      expect(readFileSync(next, "utf8")).toBe(signinEnvFile(githubSignin));
      expect(statSync(next).mode & 0o777).toBe(0o600);
      expect(readFileSync(dir.path("stack", "signin-emails.txt"), "utf8")).toBe(
        "dev@example.com\nops@example.com\n",
      );
    },
  );

  it("only reads the tokens when sign-in is off", () => {
    const script = finishScript(null);
    expect(script).not.toContain("install.sh");
    expect(script).toContain("grep -E '^(SELFHOST_TOKEN|SELFHOST_OTLP_TOKEN)=' .env");
  });

  it("refuses output without both tokens", () => {
    expect(() => parseReadBack(`SELFHOST_TOKEN=${ADMIN}\n`)).toThrow(
      ".env on the server has no SELFHOST_OTLP_TOKEN",
    );
  });
});

describe("selfhost up --provider hetzner", () => {
  const origin = "https://1-2-3-4.sslip.io";
  const keysUrl = `${HETZNER}/ssh_keys?fingerprint=${encodeURIComponent(FINGERPRINT)}`;
  const noKeys = { ...fixture("hetzner/ssh_keys-list.json"), ssh_keys: [] };
  const unavailable = { status: 422, body: fixture("hetzner/error-resource_unavailable.json") };
  const created = (body: unknown) => ({ status: 201, body });
  const servers = () => [
    { method: "GET", url: keysUrl, body: fixture("hetzner/ssh_keys-list.json") },
    {
      method: "POST",
      url: `${HETZNER}/firewalls`,
      ...created(fixture("hetzner/firewalls-create.json")),
    },
    {
      method: "POST",
      url: `${HETZNER}/servers`,
      ...created(fixture("hetzner/servers-create.json")),
    },
  ];

  it("adds the key, a firewall and a server, reads the tokens over SSH, and creates the team", async () => {
    const dir = home();
    const api = cloud(
      [
        { method: "GET", url: keysUrl, body: noKeys },
        {
          method: "POST",
          url: `${HETZNER}/ssh_keys`,
          ...created(fixture("hetzner/ssh_keys-create.json")),
        },
        {
          method: "POST",
          url: `${HETZNER}/firewalls`,
          ...created(fixture("hetzner/firewalls-create.json")),
        },
        { method: "POST", url: `${HETZNER}/servers`, ...unavailable },
        {
          method: "POST",
          url: `${HETZNER}/servers`,
          ...created(fixture("hetzner/servers-create.json")),
        },
      ],
      origin,
      await selfhostServer(),
    );
    const ssh = sshServer();
    const deps = io(
      dir,
      { HCLOUD_TOKEN: "hcloud-test-token" },
      { fetch: api.fetch, exec: ssh.exec },
    );
    const report = await runUp({ provider: "hetzner", json: true }, deps);

    expect(api.left()).toEqual([]);
    expect(api.calls.map((call) => `${call.method} ${call.url.replace(HETZNER, "")}`)).toEqual([
      `GET /ssh_keys?fingerprint=${encodeURIComponent(FINGERPRINT)}`,
      "POST /ssh_keys",
      "POST /firewalls",
      "POST /servers",
      "POST /servers",
    ]);
    for (const call of api.calls) expect(call.authorization).toBe("Bearer hcloud-test-token");
    const [, key, firewall, first, second] = api.calls;
    expect(key?.body).toEqual({
      name: "selfhost-ab12",
      public_key: KEY,
      labels: { "managed-by": "selfhost" },
    });
    const rules = firewall?.body?.rules as { protocol: string; port: string }[];
    expect(rules.map((rule) => `${rule.protocol}/${rule.port}`)).toEqual([
      "tcp/22",
      "tcp/80",
      "tcp/443",
      "udp/443",
    ]);
    expect(first?.body?.server_type).toBe("cx23");
    expect(second?.body).toMatchObject({
      name: "selfhost-ab12",
      server_type: "cpx22",
      image: "ubuntu-24.04",
      location: "fsn1",
      ssh_keys: [42],
      firewalls: [{ firewall: 42 }],
      labels: { "managed-by": "selfhost" },
    });
    const userData = second?.body?.user_data as string;
    expect(userData).toBe(
      bootstrapScript(settings(), { metadataUrl: HETZNER_METADATA, from: "Hetzner" }),
    );
    expectNoSecrets(userData, [ADMIN, OTLP]);

    // Once HTTPS answers: one ssh, as root, with the host key kept under the server's name.
    expect(ssh.calls).toEqual([
      {
        command: "ssh",
        args: [...cloudSsh(dir, "root@1.2.3.4"), "sh -s"],
        input: finishScript(null),
      },
    ]);

    expect(report).toMatchObject({
      schema: "selfhost.up/v1",
      dry_run: false,
      provider: "hetzner",
      url: origin,
      domain: "1-2-3-4.sslip.io",
      domain_source: "sslip.io",
      ip: "1.2.3.4",
      size: "cpx22",
      region: "fsn1",
      healthy: true,
      ssh: "ssh root@1.2.3.4",
      signin: null,
      otel: { endpoint: `${origin}/otlp`, header: `Authorization=Bearer ${OTLP}` },
      backups: {
        time_utc: "03:00",
        keep_days: 14,
        dir: `${STACK_DIR}/backups`,
        restore: `ssh root@1.2.3.4 'cd ${STACK_DIR} && ./restore.sh --force backups/<file>.dump'`,
      },
      joined: false,
    });
    expect(report.team?.join_command).toMatch(
      new RegExp(`^selfhost join ${origin} selfhost_inv_\\S+$`),
    );
    expect(report.resources).toEqual([
      {
        provider: "hetzner",
        kind: "ssh key",
        id: "42",
        name: "my-resource",
        delete: `curl -fsS -X DELETE -H "Authorization: Bearer $HCLOUD_TOKEN" ${HETZNER}/ssh_keys/42`,
      },
      expect.objectContaining({ kind: "firewall", id: "42" }),
      expect.objectContaining({ kind: "server", id: "42", name: "my-server" }),
    ]);

    const saved = config(deps.configPath);
    expect(saved.deployments).toEqual([
      expect.objectContaining({
        server: origin,
        provider: "hetzner",
        ip: "1.2.3.4",
        admin_token: ADMIN,
        stack_dir: STACK_DIR,
        created_at: "2026-11-08T10:00:00.000Z",
      }),
    ]);
    expect(statSync(deps.configPath).mode & 0o777).toBe(0o600);

    // The team commands find the admin token selfhost up saved.
    const invite = await run(
      ["team", "invite", "--server", origin, "--team", report.team?.id ?? "", "--json"],
      { configPath: deps.configPath, fetch: api.fetch },
    );
    expect(invite.code).toBe(0);
    expect(JSON.parse(invite.out).join_command).toMatch(/^selfhost join https:\/\/1-2-3-4/);
  });

  it("sends the OAuth client secret over SSH only, and prints the URL, backups and sign-in", async () => {
    const dir = home();
    const api = cloud(servers(), origin, await selfhostServer());
    const ssh = sshServer();
    const deps = io(
      dir,
      { HCLOUD_TOKEN: "t", SELFHOST_SIGNIN_CLIENT_SECRET: githubSignin.clientSecret },
      { fetch: api.fetch, exec: ssh.exec },
    );
    const report = await runUp(
      {
        provider: "hetzner",
        signin: "github",
        signinClientId: githubSignin.clientId,
        githubOrg: "acme",
        backupTime: "02:30",
        backupKeepDays: "7",
      },
      deps,
    );
    const userData = api.calls.find((call) => call.url.endsWith("/servers"))?.body
      ?.user_data as string;
    expectNoSecrets(userData, [githubSignin.clientSecret, ADMIN, OTLP]);
    expect(userData).toContain("SELFHOST_BACKUP_TIME=02:30\nSELFHOST_BACKUP_KEEP_DAYS=7\n");
    // Sign-in is turned on later, over SSH, once the secret can go there.
    expect(userData).toContain("\nCOMPOSE_FILE=compose.yml:compose.tls.yml\n");
    const signin = { ...githubSignin, emailDomains: [], emails: [], githubOrg: "acme" };
    expect(ssh.calls.map((call) => call.input)).toEqual([finishScript(signin)]);
    expect(ssh.calls[0]?.input).toContain(
      `SELFHOST_SIGNIN_CLIENT_SECRET=${githubSignin.clientSecret}\n`,
    );

    const text = deps.out.join("\n");
    expect(text).not.toContain(githubSignin.clientSecret);
    expect(text).not.toContain(ADMIN);
    expect(text).toContain(`selfhost is up at ${origin}`);
    expect(text).toContain("Using SSH key my-resource already in the Hetzner project");
    expect(text).toContain("Turning on sign-in over SSH on root@1.2.3.4");
    expect(text).toMatch(/Server +Hetzner Cloud cpx22 in fsn1, 1\.2\.3\.4 \(ssh root@1\.2\.3\.4\)/);
    expect(text).toMatch(
      /Sign-in +GitHub through oauth2-proxy, for members of the GitHub organization acme\. OAuth app callback URL: https:\/\/1-2-3-4\.sslip\.io\/oauth2\/callback/,
    );
    expect(text).toMatch(
      /Backups +daily at 02:30 UTC into \/opt\/selfhost\/deploy\/docker\/backups, kept 7 days, on the server's disk only/,
    );
    expect(text).toContain("Admin    token saved in ~/.selfhost/config.json (mode 0600)");
    expect(text).toContain(`  ${report.team?.join_command}`);
    expect(text).toContain("To delete it all, in this order:");
    expect(text).toContain(
      `curl -fsS -X DELETE -H "Authorization: Bearer $HCLOUD_TOKEN" ${HETZNER}/servers/42`,
    );
    // The key was there already, so it is not deleted.
    expect(text).not.toContain("/ssh_keys/42");
    expect(text).toContain(
      "Note: The address is a sslip.io name, which depends on the sslip.io DNS service: for a server a team relies on, use --domain with a name you control.",
    );
  });

  it("stops before any request without HCLOUD_TOKEN", async () => {
    const dir = home();
    const fetch = vi.fn();
    const result = await run(["up", "--provider", "hetzner", "--json"], {
      env: { HOME: dir.root },
      fetch,
      configPath: dir.path("config.json"),
    });
    expect(result.code).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    const error = JSON.parse(result.out);
    expect(error).toEqual({
      schema: "selfhost.error/v1",
      error: expect.stringContaining("HCLOUD_TOKEN is not set."),
      resources: [],
    });
    expect(error.error).toContain("Nothing was created in a cloud account.");
  });

  it("lists what it created, newest first, when the provider refuses the server", async () => {
    const dir = home();
    const api = cloud(
      [
        { method: "GET", url: keysUrl, body: noKeys },
        {
          method: "POST",
          url: `${HETZNER}/ssh_keys`,
          ...created(fixture("hetzner/ssh_keys-create.json")),
        },
        {
          method: "POST",
          url: `${HETZNER}/firewalls`,
          ...created(fixture("hetzner/firewalls-create.json")),
        },
        {
          method: "POST",
          url: `${HETZNER}/servers`,
          status: 403,
          body: {
            error: {
              code: "resource_limit_exceeded",
              message: "server limit exceeded",
              details: {},
            },
          },
        },
      ],
      origin,
    );
    const result = await run(["up", "--provider", "hetzner"], {
      env: { HOME: dir.root, HCLOUD_TOKEN: "t" },
      fetch: api.fetch,
      sleep: async () => {},
      configPath: dir.path("config.json"),
    });
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      [
        "Hetzner API POST /servers answered 403 resource_limit_exceeded: server limit exceeded",
        "Created before it stopped, and billed until deleted. Delete them in this order, each once the one before is gone:",
        "  hetzner firewall 42 (new-name):",
        `    curl -fsS -X DELETE -H "Authorization: Bearer $HCLOUD_TOKEN" ${HETZNER}/firewalls/42`,
        "  hetzner ssh key 42 (my-resource):",
        `    curl -fsS -X DELETE -H "Authorization: Bearer $HCLOUD_TOKEN" ${HETZNER}/ssh_keys/42`,
      ].join("\n"),
    );
    // Nothing is saved for a server that does not exist.
    expect(existsSync(dir.path("config.json"))).toBe(false);
  });

  it("says where to look when HTTPS never answers, having sent nothing over SSH", async () => {
    const dir = home();
    const api = cloud(servers(), "https://never.example.com");
    const fetch = async (url: string, init: RequestInit) => {
      if (url.startsWith(origin)) throw new Error("certificate not ready");
      return api.fetch(url, init);
    };
    const sleeps: number[] = [];
    const ssh = sshServer();
    const deps = io(
      dir,
      { HCLOUD_TOKEN: "t" },
      {
        fetch,
        exec: ssh.exec,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    const failed = runUp({ provider: "hetzner", wait: "1", team: false }, deps);
    await expect(failed).rejects.toThrow(
      new RegExp(
        [
          `^${origin}/v1/health did not answer within 1 minutes\\.`,
          "Install progress: ssh root@1\\.2\\.3\\.4 tail -n 50 /var/log/cloud-init-output\\.log",
          "Containers: ssh root@1\\.2\\.3\\.4 'cd /opt/selfhost/deploy/docker && docker compose ps",
        ].join("\n"),
      ),
    );
    await expect(failed).rejects.toMatchObject({
      resources: [
        expect.objectContaining({ kind: "firewall" }),
        expect.objectContaining({ kind: "server" }),
      ],
    });
    // Six checks, ten seconds apart.
    expect(sleeps).toEqual([10_000, 10_000, 10_000, 10_000, 10_000]);
    expect(ssh.calls).toEqual([]);
    expect(config(deps.configPath).deployments[0]).toMatchObject({
      server: origin,
      admin_token: null,
    });
  });

  it("says the server is up and how to read the token when ssh fails afterwards", async () => {
    const dir = home();
    const api = cloud(servers(), origin);
    const ssh = sshServer({
      finish: { code: 255, stdout: "", stderr: "root@1.2.3.4: Permission denied (publickey).\n" },
    });
    const deps = io(dir, { HCLOUD_TOKEN: "t" }, { fetch: api.fetch, exec: ssh.exec });
    const failed = runUp({ provider: "hetzner", team: false }, deps);
    await expect(failed).rejects.toThrow(
      [
        `${origin} is up, but selfhost up could not finish over SSH: ssh to root@1.2.3.4 failed (exit 255):`,
        "  | root@1.2.3.4: Permission denied (publickey).",
        `Read the admin token by hand: ssh root@1.2.3.4 grep ^SELFHOST_TOKEN= ${STACK_DIR}/.env`,
        "Created before it stopped, and billed until deleted.",
      ].join("\n"),
    );
    expect(config(deps.configPath).deployments[0].admin_token).toBeNull();
  });
});

describe("selfhost up --provider digitalocean", () => {
  const origin = "https://192-241-165-154.sslip.io";

  it("adds the key, creates the droplet, waits for its IP, then the firewall", async () => {
    const dir = home();
    const api = cloud(
      [
        {
          method: "GET",
          url: `${DO}/account/keys/${encodeURIComponent(FINGERPRINT)}`,
          status: 404,
          body: fixture("digitalocean/error-not-found.json"),
        },
        {
          method: "POST",
          url: `${DO}/account/keys`,
          status: 201,
          body: fixture("digitalocean/account-keys-create.json"),
        },
        {
          method: "POST",
          url: `${DO}/droplets`,
          status: 202,
          body: fixture("digitalocean/droplets-create.json"),
        },
        {
          method: "GET",
          url: `${DO}/droplets/3164444`,
          body: fixture("digitalocean/droplets-get.json"),
        },
        {
          method: "POST",
          url: `${DO}/firewalls`,
          status: 202,
          body: fixture("digitalocean/firewalls-create.json"),
        },
      ],
      origin,
    );
    const ssh = sshServer();
    const deps = io(
      dir,
      { DIGITALOCEAN_ACCESS_TOKEN: "do-test-token" },
      { fetch: api.fetch, exec: ssh.exec },
    );
    const report = await runUp({ provider: "digitalocean", team: false, json: true }, deps);

    expect(api.left()).toEqual([]);
    for (const call of api.calls) expect(call.authorization).toBe("Bearer do-test-token");
    const droplet = api.calls.find((call) => call.url === `${DO}/droplets`)?.body;
    expect(droplet).toMatchObject({
      name: "selfhost-ab12",
      region: "nyc3",
      size: "s-2vcpu-4gb",
      image: "ubuntu-24-04-x64",
      ssh_keys: [FINGERPRINT],
      tags: ["selfhost"],
    });
    const userData = droplet?.user_data as string;
    expect(userData).toBe(
      bootstrapScript(settings(), { metadataUrl: DIGITALOCEAN_METADATA, from: "DigitalOcean" }),
    );
    expectNoSecrets(userData, [ADMIN, OTLP]);
    const firewall = api.calls.find((call) => call.url === `${DO}/firewalls`)?.body;
    expect(firewall?.droplet_ids).toEqual([3164444]);
    const ports = (rules: unknown) =>
      (rules as { protocol: string; ports: string }[]).map(
        (rule) => `${rule.protocol}/${rule.ports}`,
      );
    expect(ports(firewall?.inbound_rules)).toEqual(["tcp/22", "tcp/80", "tcp/443", "udp/443"]);
    expect(ports(firewall?.outbound_rules)).toEqual(["tcp/0", "udp/0", "icmp/0"]);
    expect(ssh.calls.map((call) => call.args.at(-2))).toEqual(["root@192.241.165.154"]);

    expect(report).toMatchObject({
      url: origin,
      ip: "192.241.165.154",
      size: "s-1vcpu-1gb",
      healthy: true,
      team: null,
      otel: { header: `Authorization=Bearer ${OTLP}` },
    });
    expect(report.resources.map((resource) => `${resource.kind} ${resource.id}`)).toEqual([
      "ssh key 512189",
      "droplet 3164444",
      "firewall bb4b2611-3d72-467b-8602-280330ecd65c",
    ]);
    expect(report.resources[1]?.delete).toBe(
      `curl -fsS -X DELETE -H "Authorization: Bearer $DIGITALOCEAN_TOKEN" ${DO}/droplets/3164444`,
    );
  });

  it("stops before any request without a token", async () => {
    const dir = home();
    const fetch = vi.fn();
    const result = await run(["up", "--provider", "digitalocean"], {
      env: { HOME: dir.root },
      fetch,
      configPath: dir.path("config.json"),
    });
    expect(result.code).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(result.err).toMatch(/^DIGITALOCEAN_TOKEN is not set\./);
    expect(result.err).toContain("Nothing was created in a cloud account.");
  });

  it("names the account's refusal when the token is wrong", async () => {
    const dir = home();
    const api = cloud(
      [
        {
          method: "GET",
          url: `${DO}/account/keys/${encodeURIComponent(FINGERPRINT)}`,
          status: 401,
          body: fixture("digitalocean/error-unauthorized.json"),
        },
      ],
      origin,
    );
    const result = await run(["up", "--provider", "digitalocean"], {
      env: { HOME: dir.root, DIGITALOCEAN_TOKEN: "wrong" },
      fetch: api.fetch,
      configPath: dir.path("config.json"),
    });
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      `DigitalOcean API GET /account/keys/${encodeURIComponent(FINGERPRINT)} answered 401 unauthorized: Unable to authenticate you.\nNothing was created in a cloud account.`,
    );
  });
});

describe("selfhost up --provider aws", () => {
  const origin = "https://203-0-113-25.sslip.io";

  function awsCli(fail?: string) {
    let userData: Buffer | undefined;
    const rec = recorder(([command, ...args], options) => {
      if (command === "ssh") return isFinish(options?.input) ? TOKENS : ok();
      const op = args.slice(0, 2).join(" ");
      if (op === fail) {
        return {
          code: 254,
          stdout: "",
          stderr: `An error occurred (${fail}) when calling the operation`,
        };
      }
      switch (op) {
        case "--version":
          return ok("aws-cli/2.31.0 Python/3.13.7 Linux/6.8.0 exe/x86_64.ubuntu.24\n");
        case "sts get-caller-identity":
          return ok({
            UserId: "AIDAEXAMPLE",
            Account: "123456789012",
            Arn: "arn:aws:iam::123456789012:user/dev",
          });
        case "ec2 allocate-address":
          return ok({
            PublicIp: "203.0.113.25",
            AllocationId: "eipalloc-0123456789abcdef0",
            Domain: "vpc",
          });
        case "ec2 import-key-pair":
          return ok({
            KeyFingerprint: FINGERPRINT,
            KeyName: "selfhost-ab12",
            KeyPairId: "key-0123456789abcdef0",
          });
        case "ec2 create-security-group":
          return ok({ GroupId: "sg-0123456789abcdef0" });
        case "ec2 authorize-security-group-ingress":
          return ok({ Return: true });
        case "ec2 run-instances": {
          const file = args[args.indexOf("--user-data") + 1]?.replace("fileb://", "") ?? "";
          userData = readFileSync(file);
          return ok({ Instances: [{ InstanceId: "i-0123456789abcdef0" }] });
        }
        case "ec2 wait":
          return ok();
        case "ec2 associate-address":
          return ok({ AssociationId: "eipassoc-0123456789abcdef0" });
        default:
          throw new Error(`unexpected aws ${args.join(" ")}`);
      }
    });
    return { ...rec, userData: () => userData };
  }

  it("goes through the aws CLI: Elastic IP, key pair, security group, instance", async () => {
    const dir = home();
    const cli = awsCli();
    const api = cloud([], origin);
    const deps = io(dir, { AWS_REGION: "eu-west-1" }, { fetch: api.fetch, exec: cli.exec });
    const report = await runUp({ provider: "aws", team: false, json: true }, deps);

    const aws = cli.calls.filter((call) => call.command === "aws");
    expect(aws.map((call) => [call.command, ...call.args.slice(0, 2)].join(" "))).toEqual([
      "aws --version",
      "aws sts get-caller-identity",
      "aws ec2 allocate-address",
      "aws ec2 import-key-pair",
      "aws ec2 create-security-group",
      "aws ec2 authorize-security-group-ingress",
      "aws ec2 run-instances",
      "aws ec2 wait",
      "aws ec2 associate-address",
    ]);
    for (const call of aws.slice(1)) {
      expect(call.args.slice(-4)).toEqual(["--region", "eu-west-1", "--output", "json"]);
    }
    const launch = aws.find((call) => call.args[1] === "run-instances")?.args ?? [];
    const flag = (name: string) => launch[launch.indexOf(name) + 1];
    expect(flag("--image-id")).toBe(AWS_IMAGE);
    expect(flag("--instance-type")).toBe("t3.medium");
    expect(flag("--metadata-options")).toBe(
      "HttpTokens=required,HttpPutResponseHopLimit=1,HttpEndpoint=enabled",
    );
    expect(JSON.parse(flag("--block-device-mappings") ?? "")).toEqual([
      {
        DeviceName: "/dev/sda1",
        Ebs: { VolumeSize: 40, VolumeType: "gp3", DeleteOnTermination: true, Encrypted: true },
      },
    ]);
    const ingress = aws.find((call) => call.args[1] === "authorize-security-group-ingress")?.args;
    const permissions = JSON.parse(ingress?.[ingress.indexOf("--ip-permissions") + 1] ?? "[]") as {
      IpProtocol: string;
      FromPort: number;
    }[];
    expect(permissions.map((rule) => `${rule.IpProtocol}/${rule.FromPort}`)).toEqual([
      "tcp/22",
      "tcp/80",
      "tcp/443",
      "udp/443",
    ]);
    // The user-data goes gzip compressed, under the 16 KB EC2 takes, with the Elastic IP's name
    // and no secret.
    const zipped = cli.userData() as Buffer;
    expect(zipped.length).toBeLessThan(16 * 1024);
    const script = gunzipSync(zipped).toString("utf8");
    expect(script).toBe(bootstrapScript(settings(), { domain: "203-0-113-25.sslip.io" }));
    expectNoSecrets(script, [ADMIN, OTLP]);
    // The tokens come back over SSH as ubuntu, through sudo.
    const ssh = cli.calls.filter((call) => call.command === "ssh");
    expect(ssh.map((call) => call.args.slice(-2))).toEqual([
      ["ubuntu@203.0.113.25", "sudo -n sh -s"],
    ]);

    expect(report).toMatchObject({
      url: origin,
      ip: "203.0.113.25",
      region: "eu-west-1",
      size: "t3.medium",
      ssh: "ssh ubuntu@203.0.113.25",
      healthy: true,
    });
    expect(report.backups.restore).toBe(
      `ssh ubuntu@203.0.113.25 'cd ${STACK_DIR} && sudo ./restore.sh --force backups/<file>.dump'`,
    );
    expect(report.resources.map((resource) => resource.delete)).toEqual([
      "aws ec2 release-address --region eu-west-1 --allocation-id eipalloc-0123456789abcdef0",
      "aws ec2 delete-key-pair --region eu-west-1 --key-pair-id key-0123456789abcdef0",
      "aws ec2 delete-security-group --region eu-west-1 --group-id sg-0123456789abcdef0",
      "aws ec2 terminate-instances --region eu-west-1 --instance-ids i-0123456789abcdef0 && aws ec2 wait instance-terminated --region eu-west-1 --instance-ids i-0123456789abcdef0",
    ]);
  });

  it("asks for the aws CLI when it is not installed, having created nothing", async () => {
    const dir = home();
    const cli = recorder(() => ({ code: 127, stdout: "", stderr: "spawn aws ENOENT" }));
    const result = await run(["up", "--provider", "aws", "--region", "us-east-1"], {
      env: { HOME: dir.root },
      exec: cli.exec,
      configPath: dir.path("config.json"),
    });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(
      /^AWS needs the aws CLI v2 on PATH: https:\/\/docs\.aws\.amazon\.com/,
    );
    expect(result.err).toContain("Nothing was created in a cloud account.");
    expect(cli.calls).toHaveLength(1);
  });

  it("says to sign in when the aws CLI has no credentials", async () => {
    const dir = home();
    const cli = awsCli("sts get-caller-identity");
    const result = await run(["up", "--provider", "aws", "--region", "us-east-1"], {
      env: { HOME: dir.root },
      exec: cli.exec,
      configPath: dir.path("config.json"),
    });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/^The aws CLI is not signed in: aws sts get-caller-identity failed/);
    expect(result.err).toContain("Sign in with aws configure or aws sso login");
    expect(result.err).toContain("Nothing was created in a cloud account.");
  });

  it("lists the Elastic IP, key pair and security group when the launch fails", async () => {
    const dir = home();
    const cli = awsCli("ec2 run-instances");
    const result = await run(["up", "--provider", "aws", "--region", "us-east-1"], {
      env: { HOME: dir.root },
      exec: cli.exec,
      configPath: dir.path("config.json"),
    });
    expect(result.code).toBe(1);
    const lines = result.err.split("\n");
    expect(lines[0]).toMatch(/^aws ec2 run-instances failed: An error occurred/);
    expect(lines.filter((line) => line.startsWith("    "))).toEqual([
      "    aws ec2 delete-security-group --region us-east-1 --group-id sg-0123456789abcdef0",
      "    aws ec2 delete-key-pair --region us-east-1 --key-pair-id key-0123456789abcdef0",
      "    aws ec2 release-address --region us-east-1 --allocation-id eipalloc-0123456789abcdef0",
    ]);
  });
});

describe("selfhost up --provider ssh", () => {
  const origin = "https://203-0-113-10.sslip.io";

  it("installs as root over ssh, waits for HTTPS, reads the tokens and joins this laptop", async () => {
    const dir = home();
    const ssh = sshServer({
      uid: "1000",
      install: ok("selfhost: starting the containers\nselfhost: ready\n"),
    });
    const api = cloud([], origin, await selfhostServer());
    const deps = io(dir, {}, { fetch: api.fetch, exec: ssh.exec });
    const report = await runUp(
      {
        provider: "ssh",
        host: "ubuntu@203.0.113.10",
        port: "2222",
        identity: "/keys/selfhost",
        join: true,
        person: "dev@example.com",
        json: true,
      },
      deps,
    );
    const base = [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ServerAliveInterval=15",
      "-p",
      "2222",
      "-i",
      "/keys/selfhost",
      "ubuntu@203.0.113.10",
    ];
    const script = bootstrapScript(settings(), { domain: "203-0-113-10.sslip.io" });
    expect(ssh.calls).toEqual([
      { command: "ssh", args: [...base, "uname -s; id -u"], input: undefined },
      { command: "ssh", args: [...base, "sudo -n sh -s"], input: script },
      { command: "ssh", args: [...base, "sudo -n sh -s"], input: finishScript(null) },
    ]);
    expectNoSecrets(script, [ADMIN, OTLP]);
    expect(report).toMatchObject({
      url: origin,
      domain_source: "sslip.io",
      ip: "203.0.113.10",
      ssh: "ssh -p 2222 ubuntu@203.0.113.10",
      healthy: true,
      joined: true,
      resources: [],
    });
    const saved = config(deps.configPath);
    expect(saved).toMatchObject({
      server: origin,
      person: "dev@example.com",
      team: report.team?.id,
      deployments: [
        expect.objectContaining({ server: origin, provider: "ssh", admin_token: ADMIN }),
      ],
    });
  });

  it("uses a host name as the HTTPS name", async () => {
    const dir = home();
    const ssh = sshServer();
    const api = cloud([], "https://selfhost.example.com");
    const deps = io(dir, {}, { fetch: api.fetch, exec: ssh.exec });
    const report = await runUp(
      { provider: "ssh", host: "selfhost.example.com", team: false, json: true },
      deps,
    );
    expect(report).toMatchObject({
      url: "https://selfhost.example.com",
      domain_source: "ssh_host",
      ip: null,
      warnings: [],
    });
    expect(ssh.calls[1]?.input).toContain("\ndomain=selfhost.example.com\n");
  });

  it("on a server that ran selfhost before, keeps its secrets, saves its token and creates no team", async () => {
    const dir = home();
    const ssh = sshServer({
      install: ok(
        "selfhost: kept the secrets already in .env\nselfhost: found the database of an earlier install\n",
      ),
    });
    const api = cloud([], origin);
    const deps = io(dir, {}, { fetch: api.fetch, exec: ssh.exec });
    const report = await runUp({ provider: "ssh", host: "203.0.113.10" }, deps);
    expect(report.team).toBeNull();
    expect(report.otel?.header).toBe(`Authorization=Bearer ${OTLP}`);
    expect(config(deps.configPath).deployments[0].admin_token).toBe(ADMIN);
    expect(deps.out.join("\n")).toContain(
      "The server already ran selfhost: it kept its database and tokens, and no team was created. selfhost team init creates one.",
    );
  });

  it("creates the team on a rerun after an install that failed before Postgres started", async () => {
    // The first install generated the secrets, then could not pull the image: .env holds them,
    // but there is no database, so install.sh keeps them and finds no earlier database.
    const dir = home();
    const ssh = sshServer({
      install: ok("selfhost: kept the secrets already in .env\nselfhost: ready\n"),
    });
    const api = cloud([], origin, await selfhostServer());
    const deps = io(dir, {}, { fetch: api.fetch, exec: ssh.exec });
    const report = await runUp({ provider: "ssh", host: "203.0.113.10" }, deps);
    expect(report.team).toMatchObject({ id: "default", name: "default" });
    const text = deps.out.join("\n");
    expect(text).not.toContain("The server already ran selfhost");
    expect(text).toContain("Created team default (default).");
  });

  it("matches the line the embedded install.sh prints when it finds an earlier database", () => {
    const install = STACK_FILES.find((file) => file.path === "install.sh")?.content ?? "";
    expect(EXISTING_INSTALL.startsWith("selfhost: ")).toBe(true);
    expect(install).toContain(`say "${EXISTING_INSTALL.slice("selfhost: ".length)}"`);
    // Only behind the check that the Postgres volume holds a cluster, never for kept secrets.
    const check = install.indexOf("-name PG_VERSION");
    expect(check).toBeGreaterThan(-1);
    expect(install.indexOf(EXISTING_INSTALL.slice("selfhost: ".length))).toBeGreaterThan(check);
  });

  it("names the CA that signs the certificate: Caddy's own for a .local name", async () => {
    expect(caddyInternalName("selfhost-test.orb.local")).toBe(true);
    expect(caddyInternalName("box.internal")).toBe(true);
    expect(caddyInternalName("a.home.arpa")).toBe(true);
    expect(caddyInternalName("selfhost.example.com")).toBe(false);
    expect(caddyInternalName("1-2-3-4.sslip.io")).toBe(false);
    expect(caddyInternalName("localization.example.com")).toBe(false);

    const dir = home();
    const ssh = sshServer();
    const local = "https://selfhost-test.orb.local";
    const api = cloud([], local);
    const deps = io(dir, {}, { fetch: api.fetch, exec: ssh.exec });
    await runUp({ provider: "ssh", host: "selfhost-test.orb.local", team: false }, deps);
    const https = deps.out.find((line) => line.startsWith("  HTTPS")) ?? "";
    expect(https).toContain("certificate for selfhost-test.orb.local from Caddy's own local CA");
    expect(https).not.toContain("Let's Encrypt");

    const publicDir = home();
    const named = io(
      publicDir,
      {},
      { fetch: cloud([], "https://selfhost.example.com").fetch, exec: sshServer().exec },
    );
    await runUp({ provider: "ssh", host: "selfhost.example.com", team: false }, named);
    expect(named.out.find((line) => line.startsWith("  HTTPS"))).toMatch(
      /certificate for selfhost\.example\.com from Let's Encrypt through Caddy$/,
    );
  });

  it("stops with a clear error when ssh cannot connect", async () => {
    const dir = home();
    const ssh = sshServer({
      connect: {
        code: 255,
        stdout: "",
        stderr: "ssh: connect to host 203.0.113.10 port 22: Connection refused\n",
      },
    });
    const result = await run(["up", "--provider", "ssh", "--host", "203.0.113.10", "--json"], {
      env: { HOME: dir.root },
      exec: ssh.exec,
      configPath: dir.path("config.json"),
    });
    expect(result.code).toBe(1);
    const error = JSON.parse(result.out);
    expect(error.resources).toEqual([]);
    expect(error.error.split("\n")).toEqual([
      "Could not connect over SSH to root@203.0.113.10: ssh: connect to host 203.0.113.10 port 22: Connection refused",
      "selfhost up uses ssh with BatchMode, so the key must work without a password prompt: load it into ssh-agent or pass -i <key>.",
      "Try it by hand: ssh root@203.0.113.10 true",
      "Nothing was created in a cloud account.",
    ]);
    expect(ssh.calls).toHaveLength(1);
  });

  it("shows the install's last lines and the sudo hint when it fails", async () => {
    const dir = home();
    const ssh = sshServer({
      uid: "1000",
      install: { code: 1, stdout: "", stderr: "sudo: a password is required\n" },
    });
    const result = await run(["up", "--provider", "ssh", "--host", "ubuntu@203.0.113.10"], {
      env: { HOME: dir.root },
      exec: ssh.exec,
      configPath: dir.path("config.json"),
    });
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      [
        "The install on ubuntu@203.0.113.10 failed (exit 1). Its last lines:",
        "  | sudo: a password is required",
        "ubuntu needs sudo without a password, or connect as root.",
        "Nothing was created in a cloud account.",
      ].join("\n"),
    );
  });
});

describe("selfhost up --dry-run", () => {
  it("prints the plan, the user-data and the SSH step, and sends nothing anywhere", async () => {
    const dir = home();
    const attempts = blockNetwork();
    const exec = vi.fn();
    const result = await run(
      [
        "up",
        "--provider",
        "hetzner",
        "--dry-run",
        "--json",
        "--people",
        "20",
        "--signin",
        "github",
        "--signin-client-id",
        githubSignin.clientId,
        "--github-org",
        "acme",
      ],
      {
        env: {
          HOME: dir.root,
          HCLOUD_TOKEN: "t",
          SELFHOST_SIGNIN_CLIENT_SECRET: githubSignin.clientSecret,
        },
        exec,
        configPath: dir.path("config.json"),
      },
    );
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(attempts).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
    expect(existsSync(dir.path("config.json"))).toBe(false);
    const report = JSON.parse(result.out) as UpReport;
    expect(report).toMatchObject({
      dry_run: true,
      provider: "hetzner",
      url: null,
      size: "cx33",
      recommendation: { tier: "medium", people: 20 },
      resources: [],
    });
    expect(report.steps).toEqual([
      expect.stringMatching(
        /^Find .*id_ed25519\.pub in the Hetzner project by fingerprint, or add it$/,
      ),
      expect.stringMatching(
        /^Create firewall selfhost-[0-9a-f]{4}: inbound TCP 22, 80 and 443 and UDP 443 only$/,
      ),
      expect.stringMatching(
        /^Create server selfhost-[0-9a-f]{4} \(cx33, else cpx32; ubuntu-24\.04; fsn1\)/,
      ),
      expect.stringMatching(
        /^Wait for https:\/\/<server IP>\.sslip\.io\/v1\/health, up to 15 minutes/,
      ),
      "Over SSH: write the sign-in settings and the OAuth client secret to .env (mode 0600), run install.sh again, and read back the tokens it generated",
      "Save the server and its admin token in ~/config.json (mode 0600)",
      "Create team default and print the line teammates join with",
    ]);
    expectNoSecrets(report.user_data ?? "", [githubSignin.clientSecret]);
    expect(report.ssh_script).toContain(
      "SELFHOST_SIGNIN_CLIENT_SECRET=<from SELFHOST_SIGNIN_CLIENT_SECRET>\n",
    );
    expect(result.out).not.toContain(githubSignin.clientSecret);
  });

  it("prints the script it would run over ssh without connecting", async () => {
    const dir = home();
    const exec = vi.fn();
    const result = await run(
      [
        "up",
        "--provider",
        "ssh",
        "--host",
        "203.0.113.10",
        "--domain",
        "selfhost.example.com",
        "--dry-run",
      ],
      { env: { HOME: dir.root }, exec, configPath: dir.path("config.json") },
    );
    expect(result.code).toBe(0);
    expect(exec).not.toHaveBeenCalled();
    expect(result.out).toContain("Dry run: nothing is created and no request is sent.");
    expect(result.out).toContain("  Address  https://selfhost.example.com");
    expect(result.out).toContain("  2. Run the script below there as root (sh -s)");
    expect(result.out).toContain(
      "Script run over SSH (sent over SSH on stdin; no secret in it, install.sh generates them on the server):\n#!/bin/sh",
    );
    expect(result.out).toContain("\ndomain=selfhost.example.com\n");
    expect(result.out).toContain(
      "Then over SSH, once HTTPS answers (the OAuth client secret travels only here):\n#!/bin/sh",
    );
    expect(result.out).not.toContain("sslip.io DNS service");
  });
});

describe("selfhost up flags", () => {
  it.each([
    [["--provider", "gcp"], '--provider: expected hetzner, digitalocean, aws, ssh, got "gcp"'],
    [["--provider", "ssh"], "--provider ssh needs --host <user@host>"],
    [["--provider", "hetzner", "--host", "x"], "--host is for --provider ssh"],
    [
      ["--provider", "ssh", "--host", "1.2.3.4", "--size", "cx23"],
      "--size is for cloud providers, not --provider ssh",
    ],
    [
      ["--provider", "ssh", "--host", "myserver"],
      "--host myserver is neither an IPv4 address nor a DNS name: pass --domain <name> for HTTPS",
    ],
    [
      ["--provider", "hetzner", "--domain", "not a name"],
      '--domain: expected a DNS name like selfhost.example.com, got "not a name"',
    ],
    [
      ["--provider", "hetzner", "--image", "ghcr.io/me/selfhost:latest"],
      "--image: name an exact version, not latest",
    ],
    [
      ["--provider", "hetzner", "--image", "ghcr.io/me/selfhost"],
      '--image: expected an image with a tag, like ghcr.io/me/selfhost:1.2.3, got "ghcr.io/me/selfhost"',
    ],
    [
      ["--provider", "hetzner", "--backup-time", "3am"],
      '--backup-time: expected HH:MM in UTC, like 03:00, got "3am"',
    ],
    [
      ["--provider", "hetzner", "--people", "0"],
      '--people: expected a whole number, 1 or more, got "0"',
    ],
    [
      ["--provider", "hetzner", "--signin", "gitlab"],
      '--signin: expected github or google, got "gitlab"',
    ],
    [
      ["--provider", "hetzner", "--signin", "github"],
      "--signin github needs the OAuth app's client id: --signin-client-id or SELFHOST_SIGNIN_CLIENT_ID",
    ],
    [
      [
        "--provider",
        "hetzner",
        "--signin",
        "google",
        "--signin-client-id",
        "x.apps.googleusercontent.com",
        "--signin-client-secret",
        "s",
      ],
      "--signin google needs to know who may sign in: --allow-email, --allow-domain",
    ],
    [
      [
        "--provider",
        "hetzner",
        "--signin",
        "google",
        "--signin-client-id",
        "x",
        "--signin-client-secret",
        "s",
        "--github-org",
        "acme",
      ],
      "--github-org works with --signin github only",
    ],
    [
      ["--provider", "hetzner", "--allow-email", "dev@example.com"],
      "--allow-email, --allow-domain and --github-org need --signin github or google",
    ],
  ])("up %j", async (args, message) => {
    const dir = home();
    const result = await run(["up", ...args, "--dry-run"], {
      env: { HOME: dir.root },
      configPath: dir.path("config.json"),
    });
    expect(result.code).toBe(1);
    expect(result.err).toBe(message);
  });

  it("needs the OAuth client secret for a real run, from the environment or the flag", async () => {
    const dir = home();
    const result = await run(
      [
        "up",
        "--provider",
        "hetzner",
        "--signin",
        "github",
        "--signin-client-id",
        "Iv1.abc",
        "--github-org",
        "acme",
      ],
      { env: { HOME: dir.root, HCLOUD_TOKEN: "t" }, configPath: dir.path("config.json") },
    );
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      "--signin github needs the OAuth app's client secret: set SELFHOST_SIGNIN_CLIENT_SECRET (or --signin-client-secret)",
    );
  });

  it("needs an SSH public key for a cloud server", async () => {
    const dir = tempDir("up-nokey");
    const result = await run(["up", "--provider", "hetzner"], {
      env: { HOME: dir.root, HCLOUD_TOKEN: "t" },
      configPath: dir.path("config.json"),
    });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/^No SSH public key in ~\/\.ssh/);
    chmodSync(dir.root, 0o755);
    writeFileSync(dir.path("other.pub"), "not a key\n");
    const bad = await run(["up", "--provider", "hetzner", "--ssh-key", dir.path("other.pub")], {
      env: { HOME: dir.root, HCLOUD_TOKEN: "t" },
      configPath: dir.path("config.json"),
    });
    expect(bad.err).toMatch(/other\.pub is not an OpenSSH public key/);
  });
});

describe("the image check before anything is created", () => {
  it("asks the registry anonymously, following its token challenge", async () => {
    const calls: string[] = [];
    const registry = async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${url}`);
      const auth = (init.headers as Record<string, string>).authorization;
      if (url.startsWith("https://ghcr.io/token")) {
        return new Response(JSON.stringify({ token: "anon" }), { status: 200 });
      }
      if (auth !== "Bearer anon") {
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:getselfhostai/selfhost:pull"',
          },
        });
      }
      return new Response(null, { status: url.endsWith("/manifests/0.1.0") ? 200 : 404 });
    };
    const check = registryImageCheck(registry);
    expect(await check("ghcr.io/getselfhostai/selfhost", "0.1.0")).toBe(true);
    expect(calls).toEqual([
      "HEAD https://ghcr.io/v2/getselfhostai/selfhost/manifests/0.1.0",
      "GET https://ghcr.io/token?service=ghcr.io&scope=repository%3Agetselfhostai%2Fselfhost%3Apull",
      "HEAD https://ghcr.io/v2/getselfhostai/selfhost/manifests/0.1.0",
    ]);
    expect(await check("ghcr.io/getselfhostai/selfhost", "0.0.0")).toBe(false);
    const down = registryImageCheck(async () => {
      throw new Error("offline");
    });
    expect(await down("ghcr.io/getselfhostai/selfhost", "0.1.0")).toBeUndefined();
    expect(imageLocation("postgres")).toEqual({
      host: "registry-1.docker.io",
      repository: "library/postgres",
    });
  });

  it("stops before any cloud call when the tag is not published, unless told not to check", async () => {
    const dir = home();
    const api = vi.fn(async () => {
      throw new Error("no cloud call expected");
    });
    const missing = await run(
      ["up", "--provider", "hetzner", "--image", "ghcr.io/me/selfhost:9.9.9"],
      {
        env: { HOME: dir.root, HCLOUD_TOKEN: "t" },
        configPath: dir.path("config.json"),
        fetch: api,
        imageExists: async () => false,
      },
    );
    expect(missing.code).toBe(1);
    expect(missing.err).toMatch(
      /^The server image ghcr\.io\/me\/selfhost:9\.9\.9 is not in its registry, so nothing was created\. Check the tag in --image\./,
    );
    expect(api).not.toHaveBeenCalled();
    const unknown = await run(["up", "--provider", "hetzner"], {
      env: { HOME: dir.root, HCLOUD_TOKEN: "t" },
      configPath: dir.path("config.json"),
      fetch: api,
      imageExists: async () => undefined,
    });
    expect(unknown.err).toContain("Could not check that the server image");
    expect(unknown.err).toContain("--skip-image-check");
    expect(api).not.toHaveBeenCalled();
  });
});
