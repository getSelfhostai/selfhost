// @vitest-environment jsdom
import {
  REVIEWER_TOOLS,
  ROLE_PERMISSIONS,
  ROUTER_TOOLS,
  RUNTIME_TOOLS,
  TRACER_TOOLS,
} from "@selfhost/schema";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { can, ROLE_ACTIONS } from "../src/lib/access";
import { INTEGRATION_TOOLS } from "../src/lib/labels";
import { ADMIN, MEMBER, mockServer, OWNER, renderConsole } from "./harness";

const PEOPLE = {
  team: "web",
  people: [
    {
      id: "ada@example.com",
      name: "Ada",
      team: "web",
      role: "owner",
      created_at: "2026-10-01T00:00:00.000Z",
    },
    { id: "mia@example.com", team: "web", role: "member", created_at: "2026-10-02T00:00:00.000Z" },
  ],
};

const INVITE = {
  id: "b".repeat(64),
  team: "web",
  email: "bob@example.com",
  created_at: "2026-11-07T00:00:00.000Z",
  expires_at: "2026-11-14T00:00:00.000Z",
};

const REPOS = {
  team: "web",
  repos: [
    {
      repo: "acme/api",
      remote: "github.com/acme/api",
      team: "web",
      org: "default",
      has_policy: true,
      created_at: "2026-10-01T00:00:00.000Z",
    },
  ],
};

const routes = (overrides: Record<string, unknown> = {}) => ({
  "GET /v1/teams/web/people": PEOPLE,
  "GET /v1/teams/web/invites": { team: "web", invites: [INVITE] },
  "GET /v1/teams/web/repos": REPOS,
  ...overrides,
});

describe("the team screen", () => {
  it("lets an owner change roles, manage invites and map repos", async () => {
    const server = mockServer(
      routes({
        "PUT /v1/teams/web/people/mia%40example.com/role": PEOPLE.people[1],
        "POST /v1/teams/web/invites": {
          invite: "selfhost_inv_secret",
          id: "c".repeat(64),
          team: "web",
          expires_at: "2026-11-15T12:00:00.000Z",
        },
        [`DELETE /v1/invites/${INVITE.id}`]: INVITE,
        "POST /v1/teams/web/repos": REPOS.repos[0],
        "DELETE /v1/teams/web/repos/acme/api": { team: "web", repos: [] },
      }),
    );
    renderConsole(OWNER, "?screen=team");
    const role = await screen.findByRole("combobox", { name: "Role of mia@example.com" });
    fireEvent.pointerDown(role, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("option", { name: "Admin" }));
    await waitFor(() =>
      expect(server.calls.find((c) => c.method === "PUT")?.body).toEqual({ role: "admin" }),
    );

    const invite = await screen.findByTestId("invite");
    expect(within(invite).getByText("bob@example.com")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create invite" }));
    // The whole join line, with this server's address, not a command that does not exist.
    expect(
      await screen.findByText(`selfhost join ${window.location.origin} selfhost_inv_secret`),
    ).toBeTruthy();
    expect(screen.queryByText(/selfhost team join/)).toBeNull();
    expect(
      server.calls.find((c) => c.path === "/v1/teams/web/invites" && c.method === "POST")?.body,
    ).toEqual({
      ttl_seconds: 604_800,
    });
    fireEvent.click(within(invite).getByRole("button", { name: "Revoke" }));
    await screen.findByText(/Invite revoked/);

    fireEvent.change(screen.getByLabelText("Repo remote"), {
      target: { value: "https://github.com/acme/web.git" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add repo" }));
    await waitFor(() =>
      expect(
        server.calls.find((c) => c.path === "/v1/teams/web/repos" && c.method === "POST")?.body,
      ).toEqual({
        remote: "https://github.com/acme/web.git",
      }),
    );
    fireEvent.click(within(screen.getByTestId("repo")).getByRole("button", { name: "Remove" }));
    await screen.findByText(/acme\/api is no longer this team's/);
  }, 20_000);

  it("shows a member the people and repos, read-only, and no invites", async () => {
    const server = mockServer(routes());
    renderConsole(MEMBER, "?screen=team");
    await screen.findAllByTestId("person");
    expect(screen.queryByRole("combobox", { name: /Role of/ })).toBeNull();
    expect(screen.getByText("Owner")).toBeTruthy();
    expect(screen.queryByText("Invites")).toBeNull();
    expect(screen.queryByRole("button", { name: /Add repo|Remove/ })).toBeNull();
    expect(server.calls.some((c) => c.path.endsWith("/invites"))).toBe(false);
  });
});

describe("navigation and roles", () => {
  it("offers every screen and marks the current one", async () => {
    mockServer(routes());
    renderConsole(MEMBER, "?screen=team");
    const nav = screen.getByRole("navigation", { name: "Console" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual([
      "Overview",
      "Review list",
      "Rules",
      "Spend",
      "Code",
      "Integrations",
      "Team",
    ]);
    expect(within(nav).getByRole("link", { name: "Team" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(within(nav).getByRole("link", { name: "Rules" }).getAttribute("href")).toBe(
      "?screen=rules",
    );
    await screen.findAllByTestId("person");
  });

  it("lists every team of the org for the admin token", async () => {
    mockServer({
      ...routes(),
      "GET /v1/orgs/default/overview": {
        teams: [{ team: { id: "web" } }, { team: { id: "data" } }],
      },
    });
    const { go } = renderConsole(ADMIN, "?screen=team&team=web");
    const picker = await screen.findByRole("combobox", { name: "Team" });
    fireEvent.pointerDown(picker, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("option", { name: "data" }));
    expect(go).toHaveBeenCalledWith(expect.objectContaining({ filters: { team: "data" } }));
  });

  it("mirrors the server's permission table", () => {
    expect(ROLE_ACTIONS).toEqual(ROLE_PERMISSIONS);
    expect(can(MEMBER, "web", "policy.write")).toBe(false);
    expect(can(MEMBER, "web", "work")).toBe(true);
    expect(can(OWNER, "web", "roles")).toBe(true);
    expect(can(OWNER, "data", "read")).toBe(false);
    expect(can(ADMIN, "anything", "roles")).toBe(true);
    const twoTeams = {
      ...MEMBER,
      memberships: [...(MEMBER.memberships ?? []), { team: "data", role: "admin" as const }],
    };
    expect(can(twoTeams, "data", "policy.write")).toBe(true);
  });

  it("offers the same tools per job as [integrations]", () => {
    expect(INTEGRATION_TOOLS).toEqual({
      router: ROUTER_TOOLS,
      tracer: TRACER_TOOLS,
      runtime: RUNTIME_TOOLS,
      reviewer: REVIEWER_TOOLS,
    });
  });
});
