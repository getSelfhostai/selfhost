import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { macKeychain, redactLine, unifiedDiff } from "../src/index.js";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(() => ({ status: 44, error: undefined })),
}));

describe("unifiedDiff", () => {
  it("prints separate hunks with three lines of context and merges close ones", () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
    const after = before.map((line) => (line === "l3" ? "L3" : line === "l16" ? "L16" : line));
    expect(unifiedDiff("f.txt", `${before.join("\n")}\n`, `${after.join("\n")}\n`)).toBe(
      [
        "--- f.txt",
        "+++ f.txt",
        "@@ -1,6 +1,6 @@",
        " l1",
        " l2",
        "-l3",
        "+L3",
        " l4",
        " l5",
        " l6",
        "@@ -13,7 +13,7 @@",
        " l13",
        " l14",
        " l15",
        "-l16",
        "+L16",
        " l17",
        " l18",
        " l19",
        "",
      ].join("\n"),
    );
    const close = before.map((line) => (line === "l3" || line === "l9" ? `${line}!` : line));
    const merged = unifiedDiff("f.txt", `${before.join("\n")}\n`, `${close.join("\n")}\n`);
    expect(merged.match(/^@@/gm)).toHaveLength(1);
  });

  it("marks new files and is empty when nothing changed", () => {
    expect(unifiedDiff("n.json", null, "{}\n")).toBe(
      "--- /dev/null\n+++ n.json\n@@ -0,0 +1,1 @@\n+{}\n",
    );
    expect(unifiedDiff("same", "x\n", "x\n")).toBe("");
  });

  it("handles large files with scattered edits", () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
    const changed = lines.map((line, i) => (i % 1000 === 0 ? `${line}!` : line));
    const diff = unifiedDiff("big", `${lines.join("\n")}\n`, `${changed.join("\n")}\n`);
    expect(diff.split("\n").filter((line) => line.startsWith("+line"))).toHaveLength(5);
  });
});

describe("redactLine", () => {
  it("masks values of credential-looking keys and bearer tokens", () => {
    expect(redactLine('    "primaryApiKey": "sk-ant-123",')).toBe(
      '    "primaryApiKey": "<redacted>",',
    );
    expect(redactLine('headers = { Authorization = "Bearer abc" }')).toBe('headers = "<redacted>"');
    expect(redactLine("  OTEL_EXPORTER_OTLP_HEADERS: a=b")).toBe(
      '  OTEL_EXPORTER_OTLP_HEADERS: "<redacted>"',
    );
    expect(redactLine('"x": "Bearer abc.def"')).toBe('"x": "Bearer <redacted>"');
    expect(redactLine('  "model": "opus",')).toBe('  "model": "opus",');
    expect(redactLine('  "headers": {')).toBe('  "headers": {');
  });
});

describe("macKeychain", () => {
  it("asks for the item by service and account, never for the secret", () => {
    expect(macKeychain("Codex Auth", "cli|abc")).toBe(false);
    const args = vi.mocked(spawnSync).mock.calls[0]?.[1] ?? [];
    expect(args).toEqual(["find-generic-password", "-s", "Codex Auth", "-a", "cli|abc"]);
    expect(args).not.toContain("-w");
    expect(args).not.toContain("-g");
  });
});
