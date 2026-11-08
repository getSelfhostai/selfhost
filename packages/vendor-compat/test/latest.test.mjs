import { describe, expect, it } from "vitest";
import { cursorVersion, latestVersion, plan, VENDORS } from "../scripts/latest.mjs";

const page = {
  vendors: [
    { id: "claude_code", versions: [{ version: "2.1.319", status: "passing" }] },
    { id: "codex", versions: [{ version: "0.167.0", status: "broken" }] },
  ],
};

describe("latest.mjs", () => {
  it("lists every vendor with a source", () => {
    expect(VENDORS.map((v) => v.id)).toEqual(["claude_code", "codex", "cursor", "opencode"]);
    for (const vendor of VENDORS) expect(vendor.npm ?? vendor.installer).toBeTruthy();
  });

  it("reads the version from the Cursor installer's download URL", () => {
    const script =
      'DOWNLOAD_URL="https://downloads.cursor.com/lab/2026.11.05-86047df/$OS/$ARCH/agent-cli-package.tar.gz"';
    expect(cursorVersion(script)).toBe("2026.11.05-86047df");
    expect(cursorVersion("echo nothing")).toBeUndefined();
  });

  it("asks npm for /latest and the installer for its URL", async () => {
    const asked = [];
    const get = async (url) => {
      asked.push(url);
      return url.endsWith("/latest")
        ? JSON.stringify({ version: "2.1.320" })
        : "https://downloads.cursor.com/lab/2026.11.06-1a2b3c4/linux/x64/agent-cli-package.tar.gz";
    };
    const [claude, , cursor] = VENDORS;
    expect(await latestVersion(claude, get)).toBe("2.1.320");
    expect(await latestVersion(cursor, get)).toBe("2026.11.06-1a2b3c4");
    expect(asked).toEqual([
      "https://registry.npmjs.org/@anthropic-ai/claude-code/latest",
      "https://cursor.com/install",
    ]);
  });

  it("runs for an untested or broken newest release, and not otherwise", () => {
    expect(plan({ claude_code: { version: "2.1.319" } }, page, false).run).toBe(false);
    expect(plan({ claude_code: { version: "2.1.320" } }, page, false)).toEqual({
      run: true,
      versions: { claude_code: "2.1.320" },
      reasons: ["claude_code 2.1.320 is not tested yet"],
    });
    expect(plan({ codex: { version: "0.167.0" } }, page, false).reasons).toEqual([
      "codex 0.167.0 is broken, retesting",
    ]);
    expect(plan({ claude_code: { version: "2.1.319" } }, page, true).run).toBe(true);
    expect(plan({ claude_code: { version: "2.1.320" } }, undefined, false).run).toBe(true);
  });

  it("leaves a vendor whose lookup failed out of the run", () => {
    const result = plan(
      {
        claude_code: { version: "2.1.319" },
        cursor: { error: "https://cursor.com/install answered 503" },
      },
      page,
      true,
    );
    expect(result.versions).toEqual({ claude_code: "2.1.319" });
    expect(result.reasons).toContain(
      "cursor: https://cursor.com/install answered 503, left out of this run",
    );
    expect(plan({ cursor: { error: "down" } }, page, true).run).toBe(false);
  });
});
