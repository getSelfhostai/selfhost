import { EVENT_SCHEMA, type LedgerEvent } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import { commandsRun, isTestCommand } from "../src/index.js";

describe("isTestCommand", () => {
  it.each([
    "vitest run",
    "npx vitest run src/limiter.test.ts",
    "./node_modules/.bin/jest --ci",
    "pnpm test",
    "pnpm -r test",
    "pnpm --filter @acme/api test -- limiter",
    "pnpm vitest",
    "pnpm exec jest",
    "npm test",
    "npm t",
    "npm run test:unit",
    "yarn test",
    "yarn workspace api run test-e2e",
    "bun test",
    "pytest -q tests/test_limits.py",
    "python -m pytest",
    "python3 -m unittest discover",
    "uv run pytest",
    "poetry run pytest -x",
    "python manage.py test accounts",
    "go test ./...",
    "cargo test --workspace",
    "cargo nextest run",
    "deno test",
    "dotnet test",
    "bundle exec rspec spec/models",
    "rake test",
    "mvn -q test",
    "./gradlew clean test",
    "make -C api test",
    "npx playwright test",
    "turbo run test",
    "CI=1 pnpm test",
    "cd packages/api && pnpm test 2>&1 | tail -20",
    "time go test -race ./...",
  ])("counts %s", (command) => {
    expect(isTestCommand(command)).toBe(true);
  });

  it.each([
    "pnpm install",
    "pnpm add -D vitest",
    "npm run build",
    "pnpm --filter test-utils build",
    "go build ./...",
    "go vet ./...",
    "cargo build",
    "python manage.py migrate",
    "python scripts/test_data.py",
    "git commit -m 'run pytest in CI'",
    "cat test/limits.test.ts",
    "make build",
    "",
  ])("leaves %s alone", (command) => {
    expect(isTestCommand(command)).toBe(false);
  });
});

let counter = 0;

function event(
  kind: LedgerEvent["kind"],
  ts: string,
  source: LedgerEvent["source"],
  command: string,
  data?: Record<string, unknown>,
): LedgerEvent {
  counter += 1;
  return {
    id: `0199d7a0-0000-7000-8000-${String(counter).padStart(12, "0")}`,
    schema: EVENT_SCHEMA,
    ts,
    source,
    kind,
    actor: { kind: "agent", id: "codex:session:s1" },
    agent: { vendor: "codex" },
    session_id: "s1",
    tool: { name: "exec_command", input_summary: command },
    target: { type: "command", value: command },
    ...(data ? { data } : {}),
  };
}

describe("commandsRun", () => {
  it("matches results to calls by call id, then by tool and input in order", () => {
    const events = [
      event("tool.called", "2026-10-12T09:00:00Z", "hook", "pnpm test", { tool_use_id: "c1" }),
      event("tool.called", "2026-10-12T09:01:00Z", "hook", "pnpm test", { tool_use_id: "c2" }),
      event("tool.result", "2026-10-12T09:01:30Z", "hook", "pnpm test", { tool_use_id: "c2" }),
      // OpenTelemetry carries no call id: it goes to the earliest call it follows.
      event("tool.result", "2026-10-12T09:00:40Z", "otel", "pnpm test", {
        success: false,
        error: "1 failed",
      }),
      event("tool.result", "2026-10-12T09:01:40Z", "otel", "pnpm test", { success: true }),
      event("tool.result", "2026-10-12T09:02:00Z", "hook", "go test ./...", { exit_code: 1 }),
    ];
    expect(
      commandsRun(events).map(({ command, result, error }) => ({ command, result, error })),
    ).toEqual([
      { command: "pnpm test", result: "failed", error: "1 failed" },
      { command: "pnpm test", result: "passed", error: undefined },
      { command: "go test ./...", result: "failed", error: undefined },
    ]);
  });

  it("counts a call two sources recorded once, and keeps calls with no result", () => {
    const events = [
      event("tool.called", "2026-10-12T09:00:00Z", "local_log", "pnpm build"),
      event("tool.called", "2026-10-12T09:00:00Z", "hook", "pnpm build", { tool_use_id: "c1" }),
    ];
    expect(commandsRun(events)).toEqual([
      {
        command: "pnpm build",
        tool: "exec_command",
        session: "s1",
        ts: "2026-10-12T09:00:00Z",
        result: "no_result",
        test: false,
      },
    ]);
  });
});
