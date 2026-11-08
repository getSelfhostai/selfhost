import { mkdirSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { importAll } from "@selfhost/importers";
import { openLedger } from "@selfhost/ledger";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run, tempDir } from "./run.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures");

interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

let received: Received[];
let server: ReturnType<typeof createServer>;
let endpoint: string;

beforeEach(async () => {
  received = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(200, { "content-type": "application/x-protobuf" }).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/** A laptop ledger with the fixture Claude Code and Codex sessions, prompts included. */
async function seeded() {
  const data = tempDir("traces").path("data");
  const ledger = await openLedger({ dataDir: data, redaction: { logPrompts: true, patterns: [] } });
  try {
    await importAll(ledger, {
      claudeDir: join(FIXTURES, "claude-code"),
      codexDir: join(FIXTURES, "codex"),
      since: new Date("2026-10-01T00:00:00Z"),
      actorId: "dev@example.com",
      logPrompts: true,
    });
    const prompts = await ledger.query({ kind: "prompt.submitted", limit: 1 });
    const prompt = String(prompts.events[0]?.data?.prompt ?? "");
    const repo = tempDir("traces-repo");
    mkdirSync(repo.path(".git"));
    return { data, repo, prompt };
  } finally {
    await ledger.close();
  }
}

const tracerToml = (url: string) =>
  [
    "version = 1",
    "[integrations.tracer]",
    'tool = "phoenix"',
    `endpoint = "${url}"`,
    'headers_env = { authorization = "PHOENIX_AUTH" }',
    "",
  ].join("\n");

describe("selfhost traces export", () => {
  it("previews the spans with --dry-run, without prompt text and without sending", async () => {
    const { data, repo, prompt } = await seeded();
    expect(prompt.length).toBeGreaterThan(10);
    repo.write("selfhost.toml", tracerToml(endpoint));
    const result = await run(["traces", "export", "--dry-run", "--json", "--data-dir", data], {
      cwd: repo.root,
    });
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out);
    expect(report).toMatchObject({
      schema: "selfhost.traces_export/v1",
      dry_run: true,
      tracer: { tool: "phoenix", endpoint },
      failed: [],
    });
    expect(report.sent.length).toBeGreaterThanOrEqual(6);
    const spans = report.sent.flatMap((r: { spans: { name: string }[] }) => r.spans);
    expect(spans.some((s: { name: string }) => s.name.startsWith("invoke_agent "))).toBe(true);
    expect(result.out).not.toContain(prompt);
    expect(received).toEqual([]);
  });

  it("sends each run once over OTLP with the header from the environment", async () => {
    const { data, repo, prompt } = await seeded();
    repo.write("selfhost.toml", tracerToml(endpoint));
    const env = { PHOENIX_AUTH: "Bearer test-phoenix-key" };
    const first = await run(["traces", "export", "--json", "--data-dir", data], {
      cwd: repo.root,
      env,
    });
    expect(first.err).toBe("");
    const report = JSON.parse(first.out);
    expect(report.failed).toEqual([]);
    expect(received.length).toBe(report.sent.length);
    for (const request of received) {
      expect(request.path).toBe("/v1/traces");
      expect(request.headers["content-type"]).toBe("application/x-protobuf");
      expect(request.headers.authorization).toBe("Bearer test-phoenix-key");
      expect(request.body.toString("utf8")).not.toContain(prompt);
      expect(request.body.toString("utf8")).toContain("openinference.span.kind");
    }
    // The key never reaches the output.
    expect(first.out).not.toContain("test-phoenix-key");

    const again = await run(["traces", "export", "--data-dir", data], { cwd: repo.root, env });
    expect(again.out).toContain("Sent 0 spans from 0 runs");
    expect(received.length).toBe(report.sent.length);
  });

  it("sends the prompt text only with [ledger] log_prompts on", async () => {
    const { data, repo, prompt } = await seeded();
    repo.write("selfhost.toml", `${tracerToml(endpoint)}[ledger]\nlog_prompts = true\n`);
    await run(["traces", "export", "--data-dir", data], {
      cwd: repo.root,
      env: { PHOENIX_AUTH: "Bearer x" },
    });
    expect(received.map((r) => r.body.toString("utf8")).join("")).toContain(prompt);
  });

  it("says what is missing without a tracer or its header variable", async () => {
    const { data, repo } = await seeded();
    repo.write("selfhost.toml", "version = 1\n");
    const none = await run(["traces", "export", "--data-dir", data], { cwd: repo.root });
    expect(none.code).toBe(1);
    expect(none.err).toContain("No [integrations.tracer] in selfhost.toml");

    repo.write("selfhost.toml", tracerToml(endpoint));
    const unset = await run(["traces", "export", "--json", "--data-dir", data], { cwd: repo.root });
    expect(unset.code).toBe(1);
    expect(JSON.parse(unset.out).failed[0].error).toContain("PHOENIX_AUTH (header authorization)");
    expect(received).toEqual([]);

    const since = await run(["traces", "export", "--since", "soon", "--data-dir", data], {
      cwd: repo.root,
    });
    expect(since.err).toContain("--since");
  });
});
