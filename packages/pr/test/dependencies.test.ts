import { describe, expect, it } from "vitest";
import { newDependencies, parseNumstat } from "../src/index.js";

describe("newDependencies", () => {
  it("lists names a package.json gained in any dependency section, not version bumps", () => {
    const before = JSON.stringify({
      dependencies: { hono: "^4.13.0" },
      devDependencies: { vitest: "^4.0.0" },
    });
    const after = JSON.stringify({
      scripts: { build: "tsup" },
      dependencies: { hono: "^4.14.0", ioredis: "^5.4.0" },
      devDependencies: { vitest: "^4.1.0" },
      peerDependencies: { react: "^19" },
    });
    expect(newDependencies([{ path: "web/package.json", before, after }])).toEqual([
      { manifest: "web/package.json", name: "ioredis" },
      { manifest: "web/package.json", name: "react" },
    ]);
  });

  it("reads requirements, go.mod and Cargo.toml", () => {
    expect(
      newDependencies([
        {
          path: "requirements.txt",
          before: "requests==2.31.0\n# tools\nflask>=3\n",
          after:
            "requests==2.32.0\nFlask>=3\n-r dev.txt\nPyYAML==6.0 ; python_version > '3.8'\nboto3_stubs[s3]\n",
        },
        {
          path: "go.mod",
          before: "module x\n\nrequire (\n\tgithub.com/a/b v1.0.0\n)\n",
          after:
            "module x\n\nrequire (\n\tgithub.com/a/b v1.1.0\n\tgithub.com/c/d v0.2.0\n\tgolang.org/x/sys v0.1.0 // indirect\n)\nrequire github.com/e/f v1.0.0\n",
        },
        {
          path: "crates/core/Cargo.toml",
          before: '[package]\nname = "core"\n\n[dependencies]\nserde = "1"\n',
          after:
            '[package]\nname = "core"\nversion = "0.2.0"\n\n[dependencies]\nserde = "1"\ntokio = { version = "1", features = ["full"] }\n\n[dev-dependencies]\nproptest = "1"\n\n[target.\'cfg(unix)\'.dependencies]\nnix.workspace = true\n\n[dependencies.reqwest]\nversion = "0.12"\n',
        },
      ]),
    ).toEqual([
      { manifest: "crates/core/Cargo.toml", name: "nix" },
      { manifest: "crates/core/Cargo.toml", name: "proptest" },
      { manifest: "crates/core/Cargo.toml", name: "reqwest" },
      { manifest: "crates/core/Cargo.toml", name: "tokio" },
      { manifest: "go.mod", name: "github.com/c/d" },
      { manifest: "go.mod", name: "github.com/e/f" },
      { manifest: "requirements.txt", name: "boto3-stubs" },
      { manifest: "requirements.txt", name: "pyyaml" },
    ]);
  });

  it("counts every dependency of a new manifest and none of a deleted one", () => {
    expect(
      newDependencies([
        { path: "svc/package.json", after: '{"dependencies":{"zod":"^4"}}' },
        { path: "old/package.json", before: '{"dependencies":{"lodash":"^4"}}' },
        { path: "README.md", before: "", after: "x" },
      ]),
    ).toEqual([{ manifest: "svc/package.json", name: "zod" }]);
  });
});

describe("parseNumstat", () => {
  it("reads additions, deletions, renames and binary files", () => {
    const out = "3\t1\tsrc/a.ts\0-\t-\tlogo.png\x002\t0\t\0src/old.ts\0src/new.ts\0";
    expect(parseNumstat(out)).toEqual([
      { path: "src/a.ts", additions: 3, deletions: 1 },
      { path: "logo.png", additions: 0, deletions: 0 },
      { path: "src/new.ts", previousPath: "src/old.ts", additions: 2, deletions: 0 },
    ]);
  });
});
