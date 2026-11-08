import { describe, expect, it } from "vitest";
import { defaultRunCommand, expandVariables, receiptSettings } from "../src/settings.js";
import { config } from "./helpers.js";

describe("receiptSettings", () => {
  it("starts the default [runtime.run] command after [runtime] setup", () => {
    const settings = receiptSettings(
      config(`version = 1
[runtime]
setup = "pnpm install"
[runtime.run.api]
command = "pnpm api"
cwd = "services/api"
[runtime.run.web]
command = "pnpm dev --port $SELFHOST_PORT"
cwd = "web"
default = true
[runtime.env]
API_URL = "http://localhost:\${SELFHOST_PORT}"
`),
      { start: "npm start", setup: "npm ci" },
    );
    expect(settings).toMatchObject({
      setup: "pnpm install",
      start: { command: "pnpm dev --port $SELFHOST_PORT", cwd: "web", from: "runtime" },
      readyUrl: "http://127.0.0.1:$SELFHOST_PORT/",
      readyTimeoutMs: 120_000,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a [runtime.env] value, expanded later.
      env: { API_URL: "http://localhost:${SELFHOST_PORT}" },
      testGlobs: [],
      testTimeoutMs: 600_000,
      maxTests: 20,
      maxScreens: 10,
    });
    expect(settings.screens).toBeUndefined();
  });

  it("lets [receipt] override the start command and set the rest", () => {
    const settings = receiptSettings(
      config(`version = 1
[runtime.run.web]
command = "pnpm dev"
default = true
[receipt]
start = "pnpm preview"
port = 4173
ready_url = "http://127.0.0.1:4173/health"
ready_timeout_seconds = 30
test_command = "pnpm vitest run {file}"
tests = ["e2e/**/*.ts"]
max_tests = 5
max_screens = 3
[receipt.screens]
"src/pages/**" = "/"
"src/settings/**" = ["/settings", "/settings/team"]
[[redaction]]
name = "ticket"
pattern = "TICKET-[0-9]+"
`),
    );
    expect(settings).toMatchObject({
      start: { command: "pnpm preview", cwd: ".", from: "receipt" },
      port: 4173,
      readyUrl: "http://127.0.0.1:4173/health",
      readyTimeoutMs: 30_000,
      testCommand: "pnpm vitest run {file}",
      testGlobs: ["e2e/**/*.ts"],
      maxTests: 5,
      maxScreens: 3,
      screens: { "src/pages/**": ["/"], "src/settings/**": ["/settings", "/settings/team"] },
      redaction: [{ name: "ticket", pattern: "TICKET-[0-9]+" }],
    });
  });

  it("falls back to the given settings when selfhost.toml has none", () => {
    expect(
      receiptSettings(undefined, {
        setup: "npm ci",
        start: "npm start",
        readyUrl: "http://127.0.0.1:3000/",
        testCommand: "npm test -- {file}",
      }),
    ).toMatchObject({
      setup: "npm ci",
      start: { command: "npm start", cwd: ".", from: "fallback" },
      readyUrl: "http://127.0.0.1:3000/",
      testCommand: "npm test -- {file}",
    });
    expect(receiptSettings(undefined).start).toBeUndefined();
  });
});

describe("defaultRunCommand", () => {
  it("takes the only command when none is marked default", () => {
    expect(defaultRunCommand({ web: { command: "npm start" } })).toEqual({
      name: "web",
      command: "npm start",
    });
    expect(defaultRunCommand({ a: { command: "a" }, b: { command: "b" } })).toBeUndefined();
    expect(defaultRunCommand(undefined)).toBeUndefined();
  });
});

describe("expandVariables", () => {
  it("expands the given names and leaves the rest for the shell", () => {
    expect(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the ${NAME} form expandVariables reads.
      expandVariables("http://localhost:$SELFHOST_PORT/${SELFHOST_WORKSPACE_NAME}?h=$HOME", {
        SELFHOST_PORT: "4100",
        SELFHOST_WORKSPACE_NAME: "agent/fix",
      }),
    ).toBe("http://localhost:4100/agent/fix?h=$HOME");
  });
});
