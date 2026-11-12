// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { enforceability, weekText } from "../src/components/screens/rules";
import { COVERAGE, OBSERVED, POLICY, POLICY_TEXT } from "./fixtures";
import { ADMIN, MEMBER, mockServer, OWNER, renderConsole } from "./harness";

/** The first click loads the promote edit and the schemas, which takes a moment on a cold run. */
const LOADS_PROMOTE = { timeout: 10_000 };

const routes = (overrides: Record<string, unknown> = {}) => ({
  "GET /v1/policy": POLICY,
  "GET /v1/policy/coverage": COVERAGE,
  "GET /v1/policy/observed": OBSERVED,
  ...overrides,
});

const ruleCard = async (id: string) => {
  const name = await screen.findByText(id, { selector: "span" });
  return within(name.closest("[data-testid=rule]") as HTMLElement);
};

describe("rules and guardrails", () => {
  it("shows each rule's mode, what it did in the last 7 days and who can enforce it", async () => {
    mockServer(routes());
    renderConsole(OWNER, "?screen=rules");
    const push = await ruleCard("no-force-push");
    expect(push.getByText("Recording only")).toBeTruthy();
    expect(push.getByText("Would have blocked 4 in 3 sessions")).toBeTruthy();
    expect(push.getByText("(1 likely false positive)")).toBeTruthy();
    expect(push.getByText("Claude Code: Can block")).toBeTruthy();
    expect(push.getByText("Codex: Can block")).toBeTruthy();
    expect(push.getByText("Cursor: Cannot block")).toBeTruthy();
    expect(push.getByText("Copilot: Does not apply")).toBeTruthy();

    const migrations = await ruleCard("ask-migrations");
    expect(migrations.getByText("Asks a person")).toBeTruthy();
    expect(migrations.getByText("Asked about 2 in 2 sessions")).toBeTruthy();
    expect(migrations.queryByRole("button", { name: "Start blocking" })).toBeNull();

    const guard = await ruleCard("guard.force_push");
    expect(guard.getByText("Blocking")).toBeTruthy();
    expect(guard.getByText("Blocked 1 in 1 session")).toBeTruthy();
    expect((await ruleCard("guard.prod_sql")).getByText("Off")).toBeTruthy();
  });

  it("starts blocking a rule in one click, writing the team's file with only the mode changed", async () => {
    const server = mockServer(routes({ "PUT /v1/policy": POLICY }));
    renderConsole(OWNER, "?screen=rules");
    const push = await ruleCard("no-force-push");
    fireEvent.click(push.getByRole("button", { name: "Start blocking" }));
    // Nothing changes until the person confirms.
    expect(server.calls.some((c) => c.method === "PUT")).toBe(false);
    fireEvent.click(push.getByRole("button", { name: "Yes, start blocking" }));
    await screen.findByText(/no-force-push now blocks/, undefined, LOADS_PROMOTE);
    const put = server.calls.find((c) => c.method === "PUT");
    expect(put?.url.searchParams.get("team")).toBe("web");
    const text = (put?.body as { text?: string } | undefined)?.text;
    expect(text).toBe(POLICY_TEXT.replace('mode = "observe"', 'mode = "enforce"'));
    expect(text).toContain("# Agents push through pull requests.");
  });

  it("asks before starting an ask rule, and says it now asks a person", async () => {
    const text = POLICY_TEXT.replace(
      'id = "ask-migrations"\nmode = "enforce"',
      'id = "ask-migrations"\nmode = "observe"',
    );
    const config = POLICY.config as unknown as { rules: { id: string; mode: string }[] };
    const observing = {
      ...POLICY,
      text,
      config: {
        ...POLICY.config,
        rules: config.rules.map((rule) =>
          rule.id === "ask-migrations" ? { ...rule, mode: "observe" } : rule,
        ),
      },
    };
    const server = mockServer(routes({ "GET /v1/policy": observing, "PUT /v1/policy": observing }));
    renderConsole(OWNER, "?screen=rules");
    const card = await ruleCard("ask-migrations");
    fireEvent.click(card.getByRole("button", { name: "Start asking" }));
    expect(card.getByText(/waits for a person before a call ask-migrations matches/)).toBeTruthy();
    fireEvent.click(card.getByRole("button", { name: "Cancel" }));
    expect(card.queryByRole("button", { name: "Yes, start asking" })).toBeNull();
    fireEvent.click(card.getByRole("button", { name: "Start asking" }));
    fireEvent.click(card.getByRole("button", { name: "Yes, start asking" }));
    await screen.findByText(/ask-migrations now asks a person first/, undefined, LOADS_PROMOTE);
    expect(screen.queryByText(/ask-migrations now blocks/)).toBeNull();
    expect(server.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("records the promotion in the decision log with the admin token", async () => {
    const server = mockServer(
      routes({
        "PUT /v1/policy": POLICY,
        "POST /v1/decisions": { decision_event: {}, duplicate: false },
      }),
    );
    renderConsole(ADMIN, "?screen=rules&team=web");
    const card = await ruleCard("no-force-push");
    fireEvent.click(card.getByRole("button", { name: "Start blocking" }));
    fireEvent.click(card.getByRole("button", { name: "Yes, start blocking" }));
    await waitFor(
      () =>
        expect(server.calls.find((c) => c.path === "/v1/decisions")?.body).toMatchObject({
          verdict: "approve",
          by: "admin",
          rule_id: "no-force-push",
          surface: "rule_promotion",
        }),
      LOADS_PROMOTE,
    );
  });

  it("turns guardrails from recording to blocking with one switch", async () => {
    const observing = {
      ...POLICY,
      text: `${POLICY_TEXT}\n[guardrails]\nmode = "observe"\n`,
      config: { ...POLICY.config, guardrails: { mode: "observe" } },
    };
    const server = mockServer(routes({ "GET /v1/policy": observing, "PUT /v1/policy": observing }));
    renderConsole(OWNER, "?screen=rules");
    await screen.findByText("Guardrails");
    const buttons = await screen.findAllByRole("button", { name: "Start blocking" });
    fireEvent.click(buttons.at(-1) as HTMLElement);
    fireEvent.click(await screen.findByRole("button", { name: "Yes, start blocking" }));
    await screen.findByText(/Guardrails now blocks/, undefined, LOADS_PROMOTE);
    const put = server.calls.find((c) => c.method === "PUT");
    const text = (put?.body as { text?: string } | undefined)?.text ?? "";
    expect(text.endsWith('[guardrails]\nmode = "enforce"\n')).toBe(true);
  });

  it("lets members read the rules but not change them", async () => {
    mockServer(routes());
    renderConsole(MEMBER, "?screen=rules");
    await ruleCard("no-force-push");
    expect(screen.queryByRole("button", { name: "Start blocking" })).toBeNull();
    expect(screen.getByText(/You can read these rules/)).toBeTruthy();
  });

  it("does not edit a policy that sits on an org floor", async () => {
    const layered = {
      ...POLICY,
      layers: [
        { kind: "org", name: "default" },
        { kind: "team", name: "web" },
      ],
    };
    mockServer(routes({ "GET /v1/policy": layered }));
    renderConsole(OWNER, "?screen=rules");
    const button = (await ruleCard("no-force-push")).getByRole("button", {
      name: "Start blocking",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("says when the team has no rules, and when the server has no rule hits", async () => {
    mockServer({ "GET /v1/policy/coverage": COVERAGE });
    renderConsole(OWNER, "?screen=rules");
    await screen.findByText("This team has no rules yet");
  });

  it("reads coverage and hits in plain words", () => {
    expect(enforceability(undefined).label).toBe("Does not apply");
    expect(weekText(undefined)).toBe("Nothing in the last 7 days");
  });
});

describe("review routing settings", () => {
  it("lists the routes and auto-approve read only, in the order they are checked", async () => {
    const policy = {
      ...POLICY,
      config: {
        ...POLICY.config,
        review: {
          fallback: ["lead@example.com"],
          routes: [
            {
              id: "prod-db",
              kinds: ["pr", "approval"],
              paths: ["db/**"],
              to: ["dba@example.com", "role:admin"],
              escalate_after_minutes: 30,
            },
            { id: "everything", to: ["@acme/reviewers"] },
          ],
          auto_approve: { enabled: true, max_risk: 10, allowed_paths: ["docs/**"] },
        },
      },
    } as unknown as typeof POLICY;
    mockServer(routes({ "GET /v1/policy": policy }));
    renderConsole(MEMBER, "?screen=rules");
    const cards = await screen.findAllByTestId("route");
    expect(cards.map((card) => card.textContent)).toEqual([
      "1.prod-dbMatches kind pr or approval; files db/**Goes to dba@example.com, role:adminAfter 30 minutes, the next matching route",
      "2.everythingMatches every itemGoes to @acme/reviewers",
    ]);
    expect(screen.getByTestId("auto-approve").textContent).toBe(
      "Auto-approve: Dry run (records only): risk 10 or less, only docs/**, green checks, no guardrail hits.",
    );
    expect(screen.queryByRole("button", { name: /route/i })).toBeNull();
  });
});

describe("learned from reverts", () => {
  const learned = (state: string, ts: string, extra: Record<string, unknown> = {}) => ({
    id: `0193a000-0000-7000-8000-${ts.slice(8, 10)}${state === "proposed" ? "01" : "02"}00000000`,
    schema: "selfhost.event/v1",
    ts,
    source: "server",
    kind: "risk.learned",
    actor: { kind: "system", id: "selfhost-github-app" },
    agent: { vendor: "codex" },
    model: "gpt-5-codex",
    repo: "acme/api",
    data: {
      state,
      module: "apps/server",
      pulls: 8,
      reverted: 2,
      reworked: 1,
      rate: 0.375,
      threshold: 0.25,
      days: 14,
      evidence: [{}, {}, {}],
      ...extra,
    },
  });

  it("lists the newest signal per agent, model and module, and says approval happens in Review", async () => {
    const server = mockServer(
      routes({
        "GET /v1/events": {
          events: [
            learned("proposed", "2026-11-06T10:00:00.000Z"),
            learned("cleared", "2026-11-02T10:00:00.000Z"),
            learned("cleared", "2026-11-05T10:00:00.000Z", { module: "web" }),
          ],
        },
      }),
    );
    renderConsole(MEMBER, "?screen=rules");
    const cards = await screen.findAllByTestId("learned");
    expect(cards).toHaveLength(2);
    const first = within(cards[0] as HTMLElement);
    expect(first.getByText("Codex (gpt-5-codex) in acme/api apps/server")).toBeTruthy();
    expect(first.getByText("Above threshold")).toBeTruthy();
    expect(
      first.getByText(
        "3 of 8 merged pull requests reverted or reworked within 14 days (37.5%), threshold 25%.",
      ),
    ).toBeTruthy();
    expect(first.getByText(/Approve or deny it on the Review screen/)).toBeTruthy();
    expect(within(cards[1] as HTMLElement).getByText("Back under threshold")).toBeTruthy();
    const call = server.calls.find((c) => c.path === "/v1/events");
    expect(call?.url.searchParams.get("kind")).toBe("risk.learned");
    expect(call?.url.searchParams.get("team")).toBe("web");
  });
});
