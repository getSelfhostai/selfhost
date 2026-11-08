import { readFileSync } from "node:fs";
import { join } from "node:path";

export const FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures");
export const readFixture = (...parts: string[]) =>
  JSON.parse(readFileSync(join(FIXTURES, ...parts), "utf8")) as unknown;

export { fakeBifrost, fakeLiteLLM } from "../src/testing.js";
