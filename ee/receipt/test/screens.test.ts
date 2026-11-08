import { describe, expect, it } from "vitest";
import { mapScreens, screenUrl, shotFile } from "../src/screens.js";
import type { ChangedFile } from "../src/select.js";

const changed = (...paths: string[]): ChangedFile[] =>
  paths.map((path) => ({ path, status: "modified" }));

describe("mapScreens", () => {
  const screens = {
    "src/pages/settings/**": ["/settings", "settings/billing"],
    "src/components/Nav.tsx": ["/", "/settings"],
  };

  it("maps changed files to the screens that show them, each screen once", () => {
    const plan = mapScreens(
      changed("src/components/Nav.tsx", "src/pages/settings/Billing.tsx", "README.md"),
      screens,
      10,
    );
    expect(plan).toEqual({
      shots: [
        {
          path: "/settings",
          files: ["src/pages/settings/Billing.tsx", "src/components/Nav.tsx"],
        },
        { path: "/settings/billing", files: ["src/pages/settings/Billing.tsx"] },
        { path: "/", files: ["src/components/Nav.tsx"] },
      ],
      notes: [],
    });
  });

  it("matches the old path of a renamed file", () => {
    const plan = mapScreens(
      [
        {
          path: "src/views/Billing.tsx",
          status: "renamed",
          previousPath: "src/pages/settings/Billing.tsx",
        },
      ],
      screens,
      10,
    );
    expect(plan.shots.map((shot) => shot.path)).toEqual(["/settings", "/settings/billing"]);
  });

  it("captures the home page when there is no map", () => {
    expect(mapScreens(changed("src/a.ts"), undefined, 10)).toEqual({
      shots: [{ path: "/", files: [] }],
      notes: ["selfhost.toml has no [receipt.screens], so the receipt captured the home page."],
    });
  });

  it("says so when no changed file is mapped, or there are more screens than max_screens", () => {
    expect(mapScreens(changed("README.md"), screens, 10).notes).toEqual([
      "No changed file matches [receipt.screens], so no screens were captured.",
    ]);
    const capped = mapScreens(changed("src/pages/settings/a.tsx"), screens, 1);
    expect(capped.shots).toHaveLength(1);
    expect(capped.notes[0]).toContain("1 more mapped screens were not captured");
  });
});

describe("shotFile", () => {
  it("names each screenshot after its path, uniquely", () => {
    const taken = new Set<string>();
    expect(shotFile("/", taken)).toBe("screens/home.png");
    expect(shotFile("/settings/billing?tab=1", taken)).toBe("screens/settings-billing.png");
    expect(shotFile("/settings-billing", taken)).toBe("screens/settings-billing-2.png");
  });
});

describe("screenUrl", () => {
  it("joins under the base URL's own path and keeps the query", () => {
    expect(screenUrl("http://127.0.0.1:4000", "/about")).toBe("http://127.0.0.1:4000/about");
    expect(screenUrl("https://pr-1.example.dev/app/", "/settings?tab=2")).toBe(
      "https://pr-1.example.dev/app/settings?tab=2",
    );
    expect(screenUrl("https://pr-1.example.dev", "/")).toBe("https://pr-1.example.dev/");
  });
});
