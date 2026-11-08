import assert from "node:assert/strict";
import { test } from "node:test";
import { greet } from "./greet.mjs";

test("greets by name", () => {
  assert.equal(greet("receipt"), "Hello, receipt");
});
