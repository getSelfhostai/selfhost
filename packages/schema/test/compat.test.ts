import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMPAT_V1, CONTRACTS, listFiles, read } from "./contracts.js";

// Files in compat/v1 are frozen copies of v1 fixtures. They must keep validating for as long
// as the schemas say v1. Never edit or delete them: a change that breaks one is a breaking
// change and needs a v2 schema plus a migration.
describe("v1 compatibility", () => {
  it("has frozen files for every contract", () => {
    expect(readdirSync(COMPAT_V1).sort()).toEqual(Object.keys(CONTRACTS).sort());
  });

  describe.each(Object.entries(CONTRACTS))("%s", (name, contract) => {
    const files = listFiles(join(COMPAT_V1, name), contract.ext);

    it("is not empty", () => {
      expect(files.length).toBeGreaterThan(0);
    });

    it.each(files)("still accepts %s", (file) => {
      const result = contract.validate(read(COMPAT_V1, name, file));
      expect(result.ok ? [] : result.errors).toEqual([]);
    });
  });
});
