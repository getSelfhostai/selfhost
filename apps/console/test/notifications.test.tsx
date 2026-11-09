// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ADMIN, MEMBER, mockServer, renderConsole } from "./harness";

const SETTINGS = {
  person: "mia@example.com",
  targets: [
    {
      name: "phone",
      service: "tgram",
      masked: "tgram://****",
      created_at: "2026-11-01T00:00:00.000Z",
    },
  ],
  digest: "daily",
  digest_set: false,
  delivery: "apprise_api",
};

const TEAM = {
  "GET /v1/teams/web/people": { team: "web", people: [] },
  "GET /v1/teams/web/repos": { team: "web", repos: [] },
};

describe("your notifications", () => {
  it("lists targets masked, takes a URL in a hidden field, sends a test and sets the digest", async () => {
    const server = mockServer({
      ...TEAM,
      "GET /v1/notify": SETTINGS,
      "POST /v1/notify/targets": SETTINGS,
      "DELETE /v1/notify/targets/phone": { ...SETTINGS, targets: [] },
      "PUT /v1/notify/digest": { ...SETTINGS, digest: "weekly", digest_set: true },
      "POST /v1/notify/test": {
        sends: [{ at: "2026-11-08T12:00:00.000Z", target: "phone", kind: "test", ok: true }],
      },
    });
    renderConsole(MEMBER, "?screen=team");
    const target = await screen.findByTestId("notify-target");
    expect(within(target).getByText(/tgram:\/\/\*\*\*\*/)).toBeTruthy();

    const field = screen.getByLabelText("Apprise URL") as HTMLInputElement;
    expect(field.type).toBe("password");
    fireEvent.change(field, { target: { value: "ntfys://alerts" } });
    fireEvent.click(screen.getByRole("button", { name: "Add target" }));
    await waitFor(() =>
      expect(server.calls.find((c) => c.path === "/v1/notify/targets")?.body).toEqual({
        url: "ntfys://alerts",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Send a test" }));
    expect(await screen.findByText("phone: sent")).toBeTruthy();

    const digest = screen.getByRole("combobox", { name: "Digest" });
    fireEvent.pointerDown(digest, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("option", { name: "Weekly digest" }));
    await waitFor(() =>
      expect(server.calls.find((c) => c.method === "PUT")?.body).toEqual({ digest: "weekly" }),
    );

    fireEvent.click(within(target).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("phone removed.")).toBeTruthy();
  }, 20_000);

  it("is not shown to the admin token, nor by a server without notifications", async () => {
    const server = mockServer(TEAM);
    renderConsole(MEMBER, "?screen=team");
    await waitFor(() => expect(server.calls.some((c) => c.path === "/v1/notify")).toBe(true));
    expect(screen.queryByText("Your notifications")).toBeNull();

    const admin = mockServer(TEAM);
    renderConsole(ADMIN, "?screen=team&team=web");
    await screen.findAllByText("Team");
    expect(admin.calls.some((c) => c.path === "/v1/notify")).toBe(false);
  });
});
