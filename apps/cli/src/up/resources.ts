import { spawn } from "node:child_process";
import type { Provider } from "./size.js";

/** Something `selfhost up` created in a cloud account, and how to delete it again. */
export interface CreatedResource {
  provider: Provider;
  kind: string;
  id: string;
  name: string | null;
  /** A command that deletes it. */
  delete: string;
}

/** Records what has been created so far, so a failure can say what is left behind. */
export class Tracker {
  readonly resources: CreatedResource[] = [];

  add(resource: CreatedResource): void {
    this.resources.push(resource);
  }
}

/** Deletion commands, newest first: a server goes before the firewall and key it uses. */
export function deleteCommands(resources: readonly CreatedResource[]): string[] {
  return [...resources].reverse().map((resource) => resource.delete);
}

function leftBehind(resources: readonly CreatedResource[]): string[] {
  if (resources.length === 0) return ["Nothing was created in a cloud account."];
  return [
    "Created before it stopped, and billed until deleted. Delete them in this order, each once the one before is gone:",
    ...[...resources]
      .reverse()
      .flatMap((resource) => [
        `  ${resource.provider} ${resource.kind} ${resource.id}${resource.name ? ` (${resource.name})` : ""}:`,
        `    ${resource.delete}`,
      ]),
  ];
}

/**
 * A failed `selfhost up`. The message ends with every resource created before the failure and
 * how to delete it, or says that nothing was created.
 */
export class UpError extends Error {
  override name = "UpError";

  constructor(
    readonly reason: string,
    readonly resources: readonly CreatedResource[] = [],
    readonly hints: readonly string[] = [],
  ) {
    super([reason, ...hints, ...leftBehind(resources)].join("\n"));
  }
}

export interface ExecResult {
  /** Exit code; 127 when the command is not on PATH. */
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  /** Written to the command's stdin. */
  input?: string;
  /** Called with each line of output as it arrives. */
  onLine?: (line: string) => void;
}

/** Runs a program without a shell. Tests pass a recorder instead. */
export type Exec = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

export const systemExec: Exec = (command, args, options = {}) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const lines = (append: (text: string) => void) => {
      let partial = "";
      return (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        append(text);
        if (!options.onLine) return;
        const parts = (partial + text).split("\n");
        partial = parts.pop() ?? "";
        for (const line of parts) options.onLine(line);
      };
    };
    child.stdout.on(
      "data",
      lines((text) => {
        stdout += text;
      }),
    );
    child.stderr.on(
      "data",
      lines((text) => {
        stderr += text;
      }),
    );
    child.on("error", (error: NodeJS.ErrnoException) =>
      done({ code: error.code === "ENOENT" ? 127 : 1, stdout, stderr: error.message }),
    );
    child.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
  });
