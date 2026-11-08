import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const DIR = join(import.meta.dirname, "..", "docker");
const read = (file: string) => readFileSync(join(DIR, file), "utf8");

interface Service {
  image?: string;
  build?: unknown;
  restart?: string;
  depends_on?: Record<string, { condition: string }>;
  environment?: Record<string, string>;
  ports?: string[];
  volumes?: string[];
  healthcheck?: { test: string[] };
}

const composeText = read("compose.yml");
const compose = parse(composeText) as {
  services: Record<string, Service>;
  volumes: Record<string, unknown>;
};
const services = compose.services;
const service = (name: string): Service => {
  const found = services[name];
  if (!found) throw new Error(`No service ${name} in compose.yml`);
  return found;
};

/** .env.example: values of the lines that are set, and every name it documents. */
function readEnvExample() {
  const values: Record<string, string> = {};
  const documented = new Set<string>();
  for (const line of read(".env.example").split("\n")) {
    const match = /^(#\s*)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match?.[2]) continue;
    documented.add(match[2]);
    if (!match[1]) values[match[2]] = match[3] ?? "";
  }
  return { values, documented };
}
const envExample = readEnvExample();

/** Compose variable interpolation: $$, ${VAR}, ${VAR:-default}, ${VAR-default}, ${VAR:?error}. */
function interpolate(text: string, env: Record<string, string>): string {
  return text.replace(
    /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?])([^}]*))?\}/g,
    (match, name: string, op: string | undefined, arg: string | undefined) => {
      if (match === "$$") return "$";
      const value = env[name];
      const missing = value === undefined || (op?.startsWith(":") === true && value === "");
      if (op?.endsWith("-")) return missing ? (arg ?? "") : (value ?? "");
      if (op?.endsWith("?") && missing) throw new Error(`${name} is required: ${arg}`);
      return value ?? "";
    },
  );
}

const EXACT_VERSION = /^v?\d+\.\d+(\.\d+)*([-_.][0-9A-Za-z.-]+)?$/;

/** Why an image reference is not pinned to an exact version, or undefined when it is. */
function unpinned(image: string): string | undefined {
  if (/@sha256:[0-9a-f]{64}$/.test(image)) return undefined;
  const name = image.slice(image.lastIndexOf("/") + 1);
  const at = name.indexOf(":");
  if (at < 0 || at === name.length - 1) return "has no tag";
  const tag = name.slice(at + 1);
  if (/latest/i.test(tag)) return "uses latest";
  if (!EXACT_VERSION.test(tag)) return `tag ${tag} is not an exact version`;
  return undefined;
}

describe("image pinning", () => {
  it.each([
    ["postgres", "has no tag"],
    ["postgres:", "has no tag"],
    ["postgres:latest", "uses latest"],
    ["otel/opentelemetry-collector-contrib:latest-arm64", "uses latest"],
    ["postgres:16", "tag 16 is not an exact version"],
    ["busybox:musl", "tag musl is not an exact version"],
    ["localhost:5000/postgres", "has no tag"],
  ])("flags %s", (image, reason) => {
    expect(unpinned(image)).toBe(reason);
  });

  it.each([
    "postgres:16.15",
    "busybox:1.37.0-musl",
    "localhost:5000/postgres:16.15",
    `postgres@sha256:${"a".repeat(64)}`,
  ])("accepts %s", (image) => {
    expect(unpinned(image)).toBeUndefined();
  });

  it("pins every image in compose.yml, resolved with .env.example", () => {
    const problems = Object.entries(services).flatMap(([name, svc]) => {
      if (!svc.image) return [`${name} has no image`];
      const why = unpinned(interpolate(svc.image, envExample.values));
      return why ? [`${name}: ${svc.image} ${why}`] : [];
    });
    expect(problems).toEqual([]);
  });

  it("writes third-party image versions in the file, where no setting can turn them into latest", () => {
    for (const [name, svc] of Object.entries(services)) {
      if (name !== "selfhost") expect(svc.image, name).not.toContain("$");
    }
  });

  it("refuses to start selfhost without SELFHOST_VERSION rather than fall back to a default", () => {
    expect(() => interpolate(service("selfhost").image ?? "", {})).toThrow(
      /^SELFHOST_VERSION is required/,
    );
  });

  it("pins the Dockerfile base images", () => {
    const dockerfile = read("Dockerfile");
    const args = Object.fromEntries(
      [...dockerfile.matchAll(/^ARG (\w+)=(\S+)$/gm)].map((m) => [m[1] ?? "", m[2] ?? ""]),
    );
    const froms = [...dockerfile.matchAll(/^FROM (\S+)/gm)].map((m) => m[1] ?? "");
    expect(froms.length).toBeGreaterThan(1);
    for (const from of froms) expect(unpinned(interpolate(from, args)), from).toBeUndefined();
  });
});

describe("compose.yml", () => {
  it("runs Postgres, the collector and the server", () => {
    expect(Object.keys(services).sort()).toEqual([
      "collector-probe",
      "otel-collector",
      "postgres",
      "selfhost",
    ]);
  });

  it("gives every long-running service a health check and a restart policy", () => {
    expect(service("postgres").healthcheck?.test).toContain("CMD-SHELL");
    expect(service("otel-collector").healthcheck?.test.join(" ")).toMatch(
      /^CMD \/probe\/busybox wget .*http:\/\/127\.0\.0\.1:13133\/$/,
    );
    // The server's check is the HEALTHCHECK in its image.
    expect(read("Dockerfile")).toMatch(/^HEALTHCHECK [^\n]*\\\n\s+CMD [^\n]*\/v1\/health/m);
    for (const name of ["postgres", "selfhost", "otel-collector"]) {
      expect(service(name).restart, name).toBe("unless-stopped");
    }
  });

  it("starts each service once what it needs is healthy", () => {
    expect(service("selfhost").depends_on).toEqual({
      postgres: { condition: "service_healthy" },
    });
    expect(service("otel-collector").depends_on).toEqual({
      "collector-probe": { condition: "service_completed_successfully" },
      selfhost: { condition: "service_healthy" },
    });
  });

  it("keeps Postgres data in a named volume, so upgrades and restarts keep events", () => {
    expect(service("postgres").volumes).toEqual(["postgres-data:/var/lib/postgresql/data"]);
    expect(Object.keys(compose.volumes)).toContain("postgres-data");
    expect(service("postgres").ports).toBeUndefined();
  });

  it("builds the server from this repository's Dockerfile", () => {
    expect(service("selfhost").build).toEqual({
      context: "../..",
      dockerfile: "deploy/docker/Dockerfile",
    });
  });
});

describe(".env.example", () => {
  const referenced = [...composeText.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:?[-?])?/g)];

  it("documents every variable compose.yml reads", () => {
    const names = [...new Set(referenced.map((m) => m[1] ?? ""))];
    expect(names.filter((name) => !envExample.documented.has(name))).toEqual([]);
  });

  it("lists every required variable as a line to fill in", () => {
    const required = new Set(referenced.filter((m) => m[2]?.endsWith("?")).map((m) => m[1]));
    expect([...required].sort()).toEqual([
      "POSTGRES_PASSWORD",
      "SELFHOST_OTLP_TOKEN",
      "SELFHOST_TOKEN",
      "SELFHOST_VERSION",
    ]);
    for (const name of required) expect(envExample.values, name).toHaveProperty(name as string);
  });

  it("commits no secrets", () => {
    const secrets = Object.entries(envExample.values).filter(([name]) =>
      /PASSWORD|TOKEN|SECRET|KEY/.test(name),
    );
    expect(secrets.length).toBe(6);
    for (const [name, value] of secrets) expect(value, name).toBe("");
  });
});

describe("otel-collector.yaml", () => {
  const config = parse(read("otel-collector.yaml")) as {
    extensions: Record<string, { endpoint?: string }>;
    receivers: {
      otlp: {
        protocols: Record<string, { endpoint: string; auth?: { authenticator: string } }>;
      };
    };
    exporters: Record<
      string,
      { endpoint?: string; encoding?: string; headers?: Record<string, string> }
    >;
    service: { extensions: string[]; pipelines: Record<string, { exporters: string[] }> };
  };
  const exporter = config.exporters["otlp_http/selfhost"];

  it("receives OTLP on the ports compose publishes, behind the agents' token", () => {
    const { grpc, http } = config.receivers.otlp.protocols;
    expect(grpc?.endpoint).toBe("0.0.0.0:4317");
    expect(http?.endpoint).toBe("0.0.0.0:4318");
    for (const protocol of [grpc, http]) {
      expect(protocol?.auth?.authenticator).toBe("bearertokenauth/agents");
    }
    const published = (service("otel-collector").ports ?? []).map((p) => p.split(":").at(-1));
    expect(published).toEqual(["4317", "4318"]);
  });

  it("sends logs and metrics to the server's OTLP route as JSON with the API token", () => {
    const port = /^\s+PORT=(\d+)/m.exec(read("Dockerfile"))?.[1];
    expect(exporter?.endpoint).toBe(`http://selfhost:${port}/v1/otlp`);
    expect(exporter?.encoding).toBe("json");
    expect(exporter?.headers).toEqual({ Authorization: `Bearer \${env:SELFHOST_TOKEN}` });
    expect(config.service.pipelines.logs?.exporters).toEqual(["otlp_http/selfhost"]);
    expect(config.service.pipelines.metrics?.exporters).toEqual(["otlp_http/selfhost"]);
  });

  it("gets every environment variable it reads from compose.yml", () => {
    const used = [...read("otel-collector.yaml").matchAll(/\$\{env:(\w+)\}/g)].map((m) => m[1]);
    const given = Object.keys(service("otel-collector").environment ?? {});
    expect([...new Set(used)].sort()).toEqual(given.sort());
  });

  it("serves its health check where the compose health check looks", () => {
    expect(config.extensions.health_check?.endpoint).toBe("127.0.0.1:13133");
    expect(config.service.extensions).toContain("health_check");
  });
});

describe("Dockerfile", () => {
  const dockerfile = read("Dockerfile");

  it("runs as a non-root user and listens on every interface", () => {
    const users = [...dockerfile.matchAll(/^USER (\S+)/gm)].map((m) => m[1]);
    expect(users.at(-1)).toBe("node");
    expect(dockerfile).toMatch(/^\s+HOST=0\.0\.0\.0 \\$/m);
  });
});

describe("backup, restore and install scripts", () => {
  const scripts = ["backup.sh", "restore.sh", "install.sh"];

  it.skipIf(process.platform === "win32")("gateway-config.sh is executable and parses", () => {
    expect(statSync(join(DIR, "gateway-config.sh")).mode & 0o111).toBe(0o111);
    expect(() => execFileSync("sh", ["-n", join(DIR, "gateway-config.sh")])).not.toThrow();
  });

  it.skipIf(process.platform === "win32").each(scripts)("%s is executable", (file) => {
    expect(statSync(join(DIR, file)).mode & 0o111).toBe(0o111);
  });

  it.skipIf(process.platform === "win32").each(scripts)("%s parses with sh -n", (file) => {
    expect(() => execFileSync("sh", ["-n", join(DIR, file)])).not.toThrow();
  });

  it.each(scripts)(
    "%s runs docker compose from its folder, so COMPOSE_FILE in .env applies",
    (file) => {
      const text = read(file);
      expect(text).not.toMatch(/docker compose -f/);
      if (file !== "install.sh") {
        expect(text).toContain('compose() { (cd "$here" && docker compose "$@"); }');
      }
    },
  );

  it("install.sh generates every secret .env.example leaves empty, and keeps the ones .env has", () => {
    const text = read("install.sh");
    const generated = /^SECRETS="([^"]+)"$/m.exec(text)?.[1]?.split(" ") ?? [];
    const empty = Object.entries(envExample.values)
      .filter(([, value]) => value === "")
      .map(([name]) => name);
    for (const name of empty) expect(generated, name).toContain(name);
    expect(generated).toContain("SELFHOST_SIGNIN_COOKIE_SECRET");
    expect(text).toContain('put "$key" "$old" .env.next');
  });
});

describe("install.sh installing Docker", () => {
  const text = read("install.sh");

  it("uses Docker's apt repository on Debian and Ubuntu, and get.docker.com only elsewhere", () => {
    const install = text.slice(
      text.indexOf("install_docker() {"),
      text.indexOf("\n}\n", text.indexOf("install_docker() {")),
    );
    expect(install).toMatch(/\n {4}debian \| ubuntu\)\n/);
    expect(install).toContain(
      'curl -fsSL "https://download.docker.com/linux/$os/gpg" -o /etc/apt/keyrings/docker.asc',
    );
    expect(install).toContain(
      "signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$os $codename stable",
    );
    expect(install).toContain(
      "apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin",
    );
    const fallback = install.slice(install.indexOf("\n    *)"));
    expect(fallback).toContain("curl -fsSL https://get.docker.com | sh");
    expect(install.indexOf("get.docker.com")).toBeGreaterThan(install.indexOf("debian | ubuntu)"));
    // Each path says which one it took.
    expect(install.match(/say "installing Docker/g)).toHaveLength(2);
  });
});

describe("HTTPS and sign-in overlays", () => {
  const overlay = (file: string) =>
    parse(read(file)) as { services: Record<string, Service>; volumes?: Record<string, unknown> };
  const tls = overlay("compose.tls.yml");
  const signin = overlay("compose.signin.yml");
  const caddy = tls.services.caddy;
  const proxy = signin.services["oauth2-proxy"];
  const caddyfile = read("Caddyfile");

  it("pins their images", () => {
    for (const [name, svc] of [
      ["caddy", caddy],
      ["oauth2-proxy", proxy],
    ] as const) {
      expect(svc?.image, name).toBeDefined();
      expect(unpinned(svc?.image ?? ""), name).toBeUndefined();
      expect(svc?.image, name).not.toContain("$");
    }
  });

  it("documents in .env.example every variable they read", () => {
    const names = ["compose.tls.yml", "compose.signin.yml", "compose.gateway.yml"].flatMap((file) =>
      [...read(file).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1] ?? ""),
    );
    expect(names.filter((name) => !envExample.documented.has(name))).toEqual([]);
    expect(envExample.documented).toContain("COMPOSE_FILE");
  });

  it("opens only 80 and 443 to the internet, and keeps the certificates in a volume", () => {
    expect(caddy?.ports).toEqual(["80:80", "443:443", "443:443/udp"]);
    expect(proxy?.ports).toBeUndefined();
    expect(caddy?.volumes).toContain("caddy-data:/data");
    expect(Object.keys(tls.volumes ?? {})).toContain("caddy-data");
    expect(caddy?.restart).toBe("unless-stopped");
    expect(proxy?.restart).toBe("unless-stopped");
  });

  it("starts Caddy once the server is healthy", () => {
    expect(caddy?.depends_on).toEqual({ selfhost: { condition: "service_healthy" } });
  });

  it("sends /v1 to the API and /otlp to the collector's OTLP HTTP port", () => {
    const port = /^\s+PORT=(\d+)/m.exec(read("Dockerfile"))?.[1];
    expect(caddyfile).toMatch(
      new RegExp(
        `handle /v1/\\* \\{\\n\\s+import api-\\{\\$SELFHOST_CONSOLE_ACCESS:token\\}\\n\\s+reverse_proxy selfhost:${port}\\n`,
      ),
    );
    expect(caddyfile).toMatch(/handle_path \/otlp\/\* \{\n\s+reverse_proxy otel-collector:4318\n/);
    const collector = service("otel-collector").ports ?? [];
    expect(collector.some((p) => p.endsWith(":4318"))).toBe(true);
  });

  it("puts the console behind sign-in only when compose.signin.yml is in use", () => {
    const env = (svc: Service | undefined) =>
      (svc?.environment as Record<string, string> | undefined) ?? {};
    expect(env(caddy).SELFHOST_CONSOLE_ACCESS).toBe("token");
    expect(env(signin.services.caddy).SELFHOST_CONSOLE_ACCESS).toBe("signin");
    expect(caddyfile).toContain("import console-{$SELFHOST_CONSOLE_ACCESS:token}");
    // Snippets are defined before the site block that imports them.
    const site = caddyfile.indexOf("{$SELFHOST_DOMAIN} {");
    for (const name of ["console-token", "console-signin", "api-token", "api-signin"]) {
      const at = caddyfile.indexOf(`(${name}) {`);
      expect(at, name).toBeGreaterThan(-1);
      expect(at, name).toBeLessThan(site);
    }
    expect(caddyfile).toMatch(/forward_auth oauth2-proxy:4180 \{\n\s+uri \/oauth2\/auth\n/);
    // The server serves the console; Caddy keeps no copy of it.
    expect(caddyfile).not.toContain("file_server");
    expect(caddy?.volumes?.some((volume) => volume.includes("console"))).toBe(false);
  });

  it("forwards the signed-in email only from oauth2-proxy, with the shared secret", () => {
    // Whatever a client sends is dropped before any route, so only forward_auth can set them.
    const site = caddyfile.slice(caddyfile.indexOf("{$SELFHOST_DOMAIN} {"));
    expect(site).toMatch(/^\s+request_header -X-Selfhost-Email$/m);
    expect(site).toMatch(/^\s+request_header -X-Selfhost-Proxy-Secret$/m);
    expect(caddyfile).toContain("copy_headers X-Auth-Request-Email>X-Selfhost-Email");
    expect(caddyfile).toContain(
      "request_header @browser X-Selfhost-Proxy-Secret {$SELFHOST_SIGNIN_PROXY_SECRET}",
    );
    const env = (svc: Service | undefined) =>
      (svc?.environment as Record<string, string> | undefined) ?? {};
    const secret =
      /^\$\{SELFHOST_SIGNIN_PROXY_SECRET:\?Set SELFHOST_SIGNIN_PROXY_SECRET in \.env\}$/;
    expect(env(signin.services.caddy).SELFHOST_SIGNIN_PROXY_SECRET).toMatch(secret);
    expect(env(signin.services.selfhost).SELFHOST_SIGNIN_PROXY_SECRET).toMatch(secret);
    expect(env(proxy).OAUTH2_PROXY_SET_XAUTHREQUEST).toBe("true");
  });

  it("asks oauth2-proxy for the callback on the served domain", () => {
    const env = proxy?.environment ?? {};
    expect(env.OAUTH2_PROXY_REDIRECT_URL).toMatch(
      /^https:\/\/\$\{SELFHOST_DOMAIN:\?Set SELFHOST_DOMAIN in \.env\}\/oauth2\/callback$/,
    );
    expect(env.OAUTH2_PROXY_HTTP_ADDRESS).toBe("0.0.0.0:4180");
    expect(proxy?.volumes).toEqual(["./signin-emails.txt:/etc/oauth2-proxy/emails.txt:ro"]);
  });
});

describe("AI gateway overlay", () => {
  const gateway = parse(read("compose.gateway.yml")) as {
    services: Record<string, Service & { command?: string[] }>;
    volumes?: Record<string, unknown>;
  };
  const bifrost = gateway.services.bifrost;
  const caddyfile = read("Caddyfile");
  const tmp = mkdtempSync(join(tmpdir(), "selfhost-gateway-"));
  const config = (env: string) => {
    const file = join(tmp, `${Math.random().toString(36).slice(2)}.env`);
    writeFileSync(file, env);
    return JSON.parse(
      execFileSync("sh", [join(DIR, "gateway-config.sh"), file], { encoding: "utf8" }),
    ) as {
      client: Record<string, unknown>;
      governance: { auth_config: Record<string, unknown> };
      config_store: { type: string; config: Record<string, string> };
      logs_store: { type: string; config: Record<string, string> };
      providers: Record<string, { keys: Record<string, unknown>[] }>;
    };
  };

  it("pins Bifrost and keeps it off the internet", () => {
    expect(bifrost?.image).toBe("maximhq/bifrost:v2.4.0");
    expect(unpinned(bifrost?.image ?? "")).toBeUndefined();
    expect(unpinned(gateway.services["gateway-db"]?.image ?? "")).toBeUndefined();
    expect(bifrost?.restart).toBe("unless-stopped");
    expect(bifrost?.ports).toEqual([`\${GATEWAY_BIND:-127.0.0.1}:\${GATEWAY_PORT:-8080}:8080`]);
    expect(bifrost?.depends_on).toEqual({
      "gateway-db": { condition: "service_completed_successfully" },
    });
    expect(bifrost?.volumes).toEqual([
      "bifrost-data:/app/data",
      "./bifrost.json:/app/data/config.json:ro",
    ]);
  });

  it("gives provider keys to Bifrost alone, and the admin key to the server too", () => {
    const selfhost = gateway.services.selfhost?.environment ?? {};
    expect(Object.keys(selfhost).sort()).toEqual([
      "SELFHOST_GATEWAY_ADMIN_KEY",
      "SELFHOST_GATEWAY_TOOL",
      "SELFHOST_GATEWAY_URL",
    ]);
    for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY"]) {
      expect(bifrost?.environment?.[name], name).toBe(`\${${name}:-}`);
      expect(selfhost[name], name).toBeUndefined();
    }
    expect(gateway.services.caddy?.environment).toEqual({ SELFHOST_GATEWAY: "on" });
  });

  it("serves only Bifrost's model routes and health at /llm/, and nothing without the overlay", () => {
    expect(caddyfile).toContain("import gateway-{$SELFHOST_GATEWAY:off}");
    expect(caddyfile).toMatch(/\(gateway-off\) \{\n\}/);
    const on = caddyfile.slice(caddyfile.indexOf("(gateway-on) {"));
    expect(on).toMatch(
      /handle_path \/llm\/\* \{\n\s+@model path \/anthropic\/\* \/openai\/\* \/v1\/\* \/health\n\s+handle @model \{\n\s+reverse_proxy bifrost:8080\n/,
    );
    expect(on).toMatch(/handle \{\n\s+respond 404\n/);
    // Its management API and web UI are never routed.
    expect(caddyfile).not.toMatch(/bifrost:8080[^\n]*\/api/);
  });

  it("creates the bifrost database only when it is missing", () => {
    const command = gateway.services["gateway-db"]?.command?.join(" ") ?? "";
    expect(command).toContain("SELECT 1 FROM pg_database WHERE datname = 'bifrost'");
    expect(command).toContain('|| psql -c "CREATE DATABASE bifrost"');
  });

  it("writes a Bifrost config with no secret, Postgres stores and governance on", () => {
    const written = config("POSTGRES_PASSWORD=pw\nSELFHOST_GATEWAY_ADMIN_KEY=admin\n");
    expect(written.client).toMatchObject({
      enforce_auth_on_inference: true,
      allow_direct_keys: false,
      disable_content_logging: true,
      logging_headers: ["user-agent"],
    });
    expect(written.governance.auth_config).toEqual({
      is_enabled: true,
      admin_username: "selfhost",
      admin_password: "env.SELFHOST_GATEWAY_ADMIN_KEY",
    });
    for (const store of [written.config_store, written.logs_store]) {
      expect(store.type).toBe("postgres");
      expect(store.config).toMatchObject({ host: "postgres", db_name: "bifrost" });
      expect(store.config.password).toBe("env.BIFROST_DB_PASSWORD");
    }
    expect(written.providers).toEqual({});
    const text = JSON.stringify(written);
    expect(text).not.toContain('admin"');
    expect(text).not.toContain("pw");
  });

  it("lists a provider only when its keys are set, by reference, with its region pinned", () => {
    const written = config(
      [
        "ANTHROPIC_API_KEY=sk-ant-real",
        "OPENAI_API_KEY=",
        "AWS_ACCESS_KEY_ID=AKIA",
        "AWS_SECRET_ACCESS_KEY=secret",
        "AWS_REGION=eu-central-1",
      ].join("\n"),
    );
    expect(Object.keys(written.providers)).toEqual(["anthropic", "bedrock"]);
    expect(written.providers.anthropic?.keys[0]).toMatchObject({ value: "env.ANTHROPIC_API_KEY" });
    expect(written.providers.bedrock?.keys[0]).toMatchObject({
      bedrock_key_config: {
        access_key: "env.AWS_ACCESS_KEY_ID",
        secret_key: "env.AWS_SECRET_ACCESS_KEY",
        region: "eu-central-1",
      },
    });
    expect(JSON.stringify(written)).not.toMatch(/sk-ant-real|AKIA|secret"/);
  });

  it("refuses a region that is not one", () => {
    expect(() =>
      config('AWS_ACCESS_KEY_ID=a\nAWS_SECRET_ACCESS_KEY=b\nAWS_REGION=us-east-1" }\n'),
    ).toThrow();
  });

  it("is written by install.sh, which waits for it when the overlay is on", () => {
    const text = read("install.sh");
    expect(text).toContain("sh ./gateway-config.sh .env >bifrost.json.tmp");
    expect(text).toContain("*:compose.gateway.yml:*) gateway=on ;;");
    expect(text).toContain("docker compose ps -q bifrost");
    expect(read(".gitignore")).toContain("bifrost.json");
  });
});
