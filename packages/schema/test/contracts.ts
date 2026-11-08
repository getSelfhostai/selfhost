import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type FieldError,
  parseConfig,
  validateClaudeCodeHook,
  validateCodexHook,
  validateCodexNotify,
  validateEvent,
  validateReceipt,
  validateReviewItem,
} from "../src/index.js";

export const PACKAGE_ROOT = join(import.meta.dirname, "..");
export const FIXTURES = join(PACKAGE_ROOT, "fixtures");
export const COMPAT_V1 = join(PACKAGE_ROOT, "compat", "v1");

type Outcome = { ok: true } | { ok: false; errors: FieldError[] };

export interface Contract {
  ext: ".json" | ".toml";
  /** Exported JSON Schema file for the contract. */
  jsonSchema: string;
  validate(text: string): Outcome;
}

const json = (jsonSchema: string, validate: (value: unknown) => Outcome): Contract => ({
  ext: ".json",
  jsonSchema,
  validate: (text) => validate(JSON.parse(text)),
});

export const CONTRACTS: Record<string, Contract> = {
  event: json("event.schema.json", validateEvent),
  config: { ext: ".toml", jsonSchema: "config.schema.json", validate: parseConfig },
  "review-item": json("review-item.schema.json", validateReviewItem),
  receipt: json("receipt.schema.json", validateReceipt),
  "claude-code-hook": json("claude-code-hook.schema.json", validateClaudeCodeHook),
  "codex-hook": json("codex-hook.schema.json", validateCodexHook),
  "codex-notify": json("codex-notify.schema.json", validateCodexNotify),
};

export function listFiles(dir: string, ext: string): string[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(ext) && file !== "expected.json")
    .sort();
}

export function read(...parts: string[]): string {
  return readFileSync(join(...parts), "utf8");
}

export interface Expected {
  field: string;
  line?: number;
}

export function readExpected(contract: string): Record<string, Expected> {
  return JSON.parse(read(FIXTURES, contract, "invalid", "expected.json"));
}
