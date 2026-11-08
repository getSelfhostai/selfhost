import { describe, expect, it } from "vitest";
import { LOG_TAIL_LINES, OutputBuffer } from "../src/log.js";

describe("OutputBuffer", () => {
  it("masks whole lines, even a secret split across chunks, and strips terminal colors", () => {
    const lines: string[] = [];
    const buffer = new OutputBuffer({
      sink: (line) => lines.push(line),
      patterns: [{ name: "ticket", pattern: "TICKET-[0-9]+" }],
    });
    const token = ["ghp", "_", "a".repeat(36)].join("");
    buffer.write(`\u001b[31mstarting\u001b[0m\nauth ${token.slice(0, 10)}`);
    buffer.write(`${token.slice(10)} ok\nsee TICKET-123 by dev@example.com\nlast`);
    buffer.end();
    expect(lines).toEqual([
      "starting",
      "auth [redacted] ok",
      "see [redacted:ticket] by [redacted]",
      "last",
    ]);
    expect(buffer.toLog("logs/app.log")).toEqual({
      tail: lines.join("\n"),
      lines: 4,
      file: "logs/app.log",
    });
  });

  it("keeps the last lines for the receipt and counts them all", () => {
    const buffer = new OutputBuffer();
    for (let i = 1; i <= 500; i += 1) buffer.write(`line ${i}\n`);
    const log = buffer.toLog();
    expect(log.lines).toBe(500);
    expect(log.tail.split("\n")).toHaveLength(LOG_TAIL_LINES);
    expect(log.tail.endsWith("line 500")).toBe(true);
    expect(buffer.tail(3, 12)).toBe("line 500");
  });
});
