import { maskSecrets, type ReceiptLog, type RedactionPattern } from "@selfhost/schema";

/** Lines and characters of a log the receipt itself carries; the whole log is in the artifact. */
export const LOG_TAIL_LINES = 60;
export const LOG_TAIL_CHARS = 6_000;

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences start with ESC.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

export interface OutputBufferOptions {
  /** [[redaction]] patterns, masked on top of the built-in secret and email patterns. */
  patterns?: readonly RedactionPattern[];
  /** Gets every line once it is complete, masked, for the whole log file. */
  sink?: (line: string) => void;
}

/**
 * A command's output, one masked line at a time: every line goes to the sink (the log file in
 * the artifact) and the last ones are kept for the receipt. Lines are masked whole, so a
 * secret split across two chunks of output is still caught.
 */
export class OutputBuffer {
  private readonly lines: string[] = [];
  private partial = "";
  private count = 0;
  private readonly keep = LOG_TAIL_LINES * 2;

  constructor(private readonly options: OutputBufferOptions = {}) {}

  write(chunk: string): void {
    const parts = (this.partial + chunk.replace(/\r\n/g, "\n")).split("\n");
    this.partial = parts.pop() ?? "";
    for (const line of parts) this.push(line);
  }

  /** Writes a last line that has no newline. */
  end(): void {
    if (this.partial === "") return;
    const line = this.partial;
    this.partial = "";
    this.push(line);
  }

  private push(raw: string): void {
    const line = maskSecrets(raw.replace(ANSI, ""), this.options.patterns).text;
    this.count += 1;
    this.lines.push(line);
    if (this.lines.length > this.keep) this.lines.splice(0, this.lines.length - this.keep);
    this.options.sink?.(line);
  }

  get lineCount(): number {
    return this.count;
  }

  /** The last `lines` lines, at most `chars` characters. */
  tail(lines = LOG_TAIL_LINES, chars = LOG_TAIL_CHARS): string {
    let text = this.lines.slice(-lines).join("\n").trimEnd();
    if (text.length > chars) text = text.slice(text.length - chars).replace(/^[^\n]*\n/, "");
    return text;
  }

  /** The log as the receipt carries it. Call end() first. */
  toLog(file?: string): ReceiptLog {
    return { tail: this.tail(), lines: this.count, ...(file ? { file } : {}) };
  }
}
