import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests never touch the real home folder: ~/.selfhost/config.json and the default ledger in
// ~/.selfhost/data resolve through os.homedir(), which follows HOME. Each test file gets a fresh
// one; tests that need a particular home still pass their own.
process.env.HOME = mkdtempSync(join(tmpdir(), "selfhost-test-home-"));
process.env.USERPROFILE = process.env.HOME;
