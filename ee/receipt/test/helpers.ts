import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig, type Receipt, type ResolvedSelfhostConfig } from "@selfhost/schema";

export const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
export const SAMPLE_APP = join(REPO_ROOT, "fixtures", "receipt-app");
const RECEIPT_FIXTURES = join(REPO_ROOT, "packages", "schema", "fixtures", "receipt", "valid");

export function config(text: string): ResolvedSelfhostConfig {
  const result = parseConfig(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.config;
}

export function receiptFixture(name: "passed-with-preview" | "app-failed"): Receipt {
  return JSON.parse(readFileSync(join(RECEIPT_FIXTURES, `${name}.json`), "utf8"));
}
