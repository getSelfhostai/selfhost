import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PolicyCompileReport } from "../src/policy/compile.js";
import { describeManaged, systemPath, vendorsHere } from "../src/policy/managed.js";
import type { MdmBundle } from "../src/policy/mdm.js";
import { run, tempDir } from "./run.js";

// Every system path here sits under a temporary --root: nothing is written to the real ones.

const POLICY = readFileSync(
  join(import.meta.dirname, "..", "..", "..", "fixtures", "compile", "selfhost.toml"),
  "utf8",
);

function repo() {
  const dir = tempDir("managed");
  mkdirSync(dir.path(".git"));
  dir.write("selfhost.toml", POLICY);
  return dir;
}

const compiled = (out: string) => JSON.parse(out) as PolicyCompileReport;

/** Root ignores file modes, so the permission tests only mean something for other users. */
const asRoot = process.getuid?.() === 0;

describe("systemPath", () => {
  it("is the path itself without a root, and the same path under one with it", () => {
    expect(systemPath("/etc/codex/requirements.toml", undefined)).toBe(
      "/etc/codex/requirements.toml",
    );
    expect(systemPath("/etc/codex/requirements.toml", "/tmp/r")).toBe(
      join("/tmp/r", "etc", "codex", "requirements.toml"),
    );
    expect(
      systemPath("C:\\Program Files\\ClaudeCode\\managed-settings.d\\selfhost.json", "/tmp/r"),
    ).toBe(
      join("/tmp/r", "C", "Program Files", "ClaudeCode", "managed-settings.d", "selfhost.json"),
    );
  });
});

describe("describeManaged", () => {
  it("says file needs for one and files need for more", () => {
    const pending = (n: number) =>
      describeManaged({
        state: "pending",
        platform: "linux",
        files: Array.from({ length: n }, (_, i) => ({
          vendor: "codex" as const,
          target: `/etc/codex/${i}`,
          path: `/etc/codex/${i}`,
          status: "needs_admin" as const,
        })),
        commands: Array.from({ length: n }, (_, i) => `sudo install ${i}`),
      });
    expect(pending(1)).toContain("1 file needs an admin. Run (selfhost never runs sudo itself):");
    expect(pending(2)).toContain("2 files need an admin. Run (selfhost never runs sudo itself):");
  });
});

describe("vendorsHere", () => {
  it("finds an agent by its folder, its command on PATH or its macOS app, nothing else", () => {
    const home = tempDir("agents-home");
    const root = tempDir("agents-root");
    const scope = { home: home.root, env: {}, platform: "linux", root: root.root };
    expect([...vendorsHere(scope)]).toEqual([]);
    home.write(".claude/settings.json", "{}");
    root.write("Applications/Cursor.app/Contents/Info.plist", "");
    expect([...vendorsHere(scope)]).toEqual(["claude_code"]);
    expect([...vendorsHere({ ...scope, platform: "darwin" })]).toEqual(["claude_code", "cursor"]);
    const which = (name: string) => (name === "codex" ? "/usr/local/bin/codex" : undefined);
    expect([...vendorsHere({ ...scope, which })]).toEqual(["claude_code", "codex"]);
    const codexHome = tempDir("codex-home");
    expect([...vendorsHere({ ...scope, env: { CODEX_HOME: codexHome.root } })]).toEqual([
      "claude_code",
      "codex",
    ]);
  });
});

describe("selfhost policy compile --managed", () => {
  it("installs each vendor's file at the Linux paths, then finds them current", async () => {
    const dir = repo();
    const root = tempDir("root");
    const args = ["policy", "compile", "--managed", "--root", root.root, "--json"];
    const first = compiled((await run(args, { cwd: dir.root, platform: "linux" })).out);
    expect(first.managed?.state).toBe("current");
    expect(first.managed?.commands).toEqual([]);
    expect(first.managed?.files.map((file) => [file.vendor, file.target, file.status])).toEqual([
      ["claude_code", "/etc/claude-code/managed-settings.d/selfhost.json", "written"],
      ["codex", "/etc/codex/requirements.toml", "written"],
      ["codex", "/etc/codex/hooks/selfhost-hook", "written"],
      ["cursor", "/etc/cursor/hooks.json", "written"],
      ["copilot", "/etc/github-copilot/managed-settings.json", "written"],
    ]);
    const settings = root.path("etc", "claude-code", "managed-settings.d", "selfhost.json");
    expect(readFileSync(settings, "utf8")).toBe(
      readFileSync(join(first.out, "claude_code", "managed-settings.d", "selfhost.json"), "utf8"),
    );
    expect(readFileSync(root.path("etc", "codex", "requirements.toml"), "utf8")).toContain(
      "prefix_rules",
    );
    if (process.platform !== "win32") {
      expect(statSync(settings).mode & 0o777).toBe(0o644);
      expect(statSync(root.path("etc", "codex", "hooks", "selfhost-hook")).mode & 0o777).toBe(
        0o755,
      );
    }

    const again = compiled((await run(args, { cwd: dir.root, platform: "linux" })).out);
    expect(again.managed?.files.every((file) => file.status === "current")).toBe(true);
  });

  it("uses the macOS and Windows paths each vendor reads", async () => {
    const dir = repo();
    const mac = tempDir("mac");
    const macReport = compiled(
      (
        await run(["policy", "compile", "--managed", "--root", mac.root, "--json"], {
          cwd: dir.root,
          platform: "darwin",
        })
      ).out,
    );
    expect(macReport.managed?.files.map((file) => file.target)).toEqual([
      "/Library/Application Support/ClaudeCode/managed-settings.d/selfhost.json",
      "/etc/codex/requirements.toml",
      "/etc/codex/hooks/selfhost-hook",
      "/Library/Application Support/Cursor/hooks.json",
      "/Library/Application Support/GitHubCopilot/managed-settings.json",
    ]);
    expect(
      existsSync(
        mac.path(
          "Library",
          "Application Support",
          "ClaudeCode",
          "managed-settings.d",
          "selfhost.json",
        ),
      ),
    ).toBe(true);

    const win = tempDir("win");
    const winReport = compiled(
      (
        await run(["policy", "compile", "--managed", "--root", win.root, "--json"], {
          cwd: dir.root,
          platform: "win32",
        })
      ).out,
    );
    expect(winReport.managed?.files.map((file) => file.target)).toEqual([
      "C:\\Program Files\\ClaudeCode\\managed-settings.d\\selfhost.json",
      "C:\\ProgramData\\OpenAI\\Codex\\requirements.toml",
      "C:\\ProgramData\\Cursor\\hooks.json",
      "C:\\Program Files\\GitHubCopilot\\managed-settings.json",
    ]);
    expect(existsSync(win.path("C", "ProgramData", "OpenAI", "Codex", "requirements.toml"))).toBe(
      true,
    );
  });

  it.skipIf(asRoot || process.platform === "win32")(
    "prints the sudo command for what this user may not write, and never runs it",
    async () => {
      const dir = repo();
      const root = tempDir("locked");
      mkdirSync(root.path("etc", "codex"), { recursive: true });
      chmodSync(root.path("etc", "codex"), 0o555);
      try {
        const result = await run(
          ["policy", "compile", "--managed", "--root", root.root, "--out", dir.path("out")],
          { cwd: dir.root, platform: "linux" },
        );
        expect(result.code).toBe(0);
        const target = root.path("etc", "codex", "requirements.toml");
        expect(existsSync(target)).toBe(false);
        expect(result.out).toContain(
          "2 files need an admin. Run (selfhost never runs sudo itself):",
        );
        expect(result.out).toContain(
          `  sudo mkdir -p '${root.path("etc", "codex")}' && sudo install -o root -m 0644 '${dir.path("out", "codex", "requirements.toml")}' '${target}'`,
        );
        expect(result.out).toContain(
          `sudo install -o root -m 0755 '${dir.path("out", "codex", "hooks", "selfhost-hook")}'`,
        );
        // The writable paths were still installed.
        expect(existsSync(root.path("etc", "cursor", "hooks.json"))).toBe(true);

        const json = compiled(
          (
            await run(
              [
                "policy",
                "compile",
                "--managed",
                "--root",
                root.root,
                "--out",
                dir.path("out"),
                "--json",
              ],
              { cwd: dir.root, platform: "linux" },
            )
          ).out,
        );
        expect(json.managed?.state).toBe("pending");
        expect(json.managed?.files.filter((f) => f.status === "needs_admin")).toHaveLength(2);
      } finally {
        chmodSync(root.path("etc", "codex"), 0o755);
      }
    },
  );

  it("leaves a file selfhost did not write alone unless --force", async () => {
    const dir = repo();
    const root = tempDir("theirs");
    const theirs = root.write("etc/github-copilot/managed-settings.json", '{"theirs":true}\n');
    const args = ["policy", "compile", "--managed", "--root", root.root, "--json"];
    // One config folder across runs: it keeps the record of the files selfhost wrote.
    const deps = {
      cwd: dir.root,
      platform: "linux" as const,
      configPath: tempDir("config").path("config.json"),
    };
    const report = compiled((await run(args, deps)).out);
    const copilot = report.managed?.files.find((file) => file.vendor === "copilot");
    expect(copilot?.status).toBe("conflict");
    expect(report.managed?.state).toBe("pending");
    expect(report.managed?.commands).toHaveLength(1);
    expect(readFileSync(theirs, "utf8")).toBe('{"theirs":true}\n');

    // A file selfhost wrote earlier is replaced when the policy changes.
    const observe = 'id = "no-force-push"\nmode = "observe"';
    dir.write("selfhost.toml", POLICY.replace('id = "no-force-push"\nmode = "enforce"', observe));
    const changed = compiled((await run(args, deps)).out);
    expect(changed.managed?.files.find((file) => file.vendor === "claude_code")?.status).toBe(
      "written",
    );

    const forced = compiled((await run([...args, "--force"], deps)).out);
    expect(forced.managed?.state).toBe("current");
    expect(readFileSync(theirs, "utf8")).not.toContain("theirs");
  });

  it("prints PowerShell for Windows", async () => {
    const dir = repo();
    const root = tempDir("winlocked");
    root.write("C/ProgramData/OpenAI/Codex/requirements.toml", "# ours, by hand\n");
    const report = compiled(
      (
        await run(["policy", "compile", "--managed", "--root", root.root, "--json"], {
          cwd: dir.root,
          platform: "win32",
        })
      ).out,
    );
    expect(report.managed?.commands).toEqual([
      `New-Item -ItemType Directory -Force -Path '${root.path("C", "ProgramData", "OpenAI", "Codex")}' | Out-Null; Copy-Item -Force '${join(report.out, "codex", "requirements.toml")}' '${root.path("C", "ProgramData", "OpenAI", "Codex", "requirements.toml")}'`,
    ]);
  });
});

const bundle = (out: string) => JSON.parse(out) as MdmBundle;

/** The base64 payload a script carries for a target, decoded. */
function payload(script: string, target: string): string | undefined {
  const line = script.split(/\r?\n/).find((l) => l.includes(`'${target}'`));
  const encoded = line?.match(/'([A-Za-z0-9+/=]{40,})'/)?.[1];
  return encoded === undefined ? undefined : Buffer.from(encoded, "base64").toString("utf8");
}

describe("selfhost policy package --mdm", () => {
  it("says which [teams.<name>] table --team looked for, and lists the ones there are", async () => {
    const dir = tempDir("managed-teams");
    mkdirSync(dir.path(".git"));
    dir.write("selfhost.toml", `${POLICY}\n[teams.web]\nmembers = ["dev@example.com"]\n`);
    const result = await run(["policy", "package", "--mdm", "jamf", "--team", "platform"], {
      cwd: dir.root,
    });
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      `--team: looked for a [teams.platform] table in ${dir.path("selfhost.toml")} and there is none. --team names a [teams.<name>] table of the policy, not a team on the server. Tables there: [teams.web].`,
    );
  });

  it("bundles a Jamf script that carries every macOS file, an extension attribute and a README", async () => {
    const dir = repo();
    const result = await run(["policy", "package", "--mdm", "jamf", "--json"], { cwd: dir.root });
    expect(result.code).toBe(0);
    const body = bundle(result.out);
    expect(body.out).toBe(dir.path(".selfhost", "mdm", "jamf"));
    expect(body.scripts).toEqual(["install.sh", "extension-attribute.sh"]);
    expect(body.policy_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.files.map((file) => [file.platform, file.scope, file.target])).toEqual([
      [
        "darwin",
        "system",
        "/Library/Application Support/ClaudeCode/managed-settings.d/selfhost.json",
      ],
      ["darwin", "system", "/etc/codex/requirements.toml"],
      ["darwin", "system", "/etc/codex/hooks/selfhost-hook"],
      ["darwin", "system", "/Library/Application Support/Cursor/hooks.json"],
      ["darwin", "system", "/Library/Application Support/GitHubCopilot/managed-settings.json"],
      ["darwin", "user", ".cursor/permissions.json"],
    ]);

    const install = readFileSync(join(body.out, "install.sh"), "utf8");
    if (process.platform !== "win32") {
      expect(statSync(join(body.out, "install.sh")).mode & 0o111).not.toBe(0);
    }
    for (const file of body.files.filter((f) => f.scope === "system")) {
      const plain = readFileSync(join(body.out, file.file), "utf8");
      expect(payload(install, file.target)).toBe(plain);
      expect(install).toContain(file.sha256);
    }
    expect(install).toContain("for home in /Users/*; do");
    expect(install).toContain(`put "$home"/'.cursor/permissions.json' 0644 "$user"`);
    expect(install).not.toMatch(/sudo/);

    const attribute = readFileSync(join(body.out, "extension-attribute.sh"), "utf8");
    expect(attribute).toContain(`<result>current ${body.policy_hash.slice(0, 12)}</result>`);
    const manifest = JSON.parse(readFileSync(join(body.out, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ schema: "selfhost.mdm_bundle/v1", mdm: "jamf" });
    const readme = readFileSync(join(body.out, "README.txt"), "utf8");
    expect(readme).toContain("Recurring Check-in");
    expect(readme).toContain("managedSourcesBehavior");

    // The scripts parse as sh; they are never run here, since they write system paths.
    if (process.platform !== "win32") {
      for (const script of ["install.sh", "extension-attribute.sh"]) {
        execFileSync("sh", ["-n", join(body.out, script)]);
      }
    }
  });

  it("bundles a Kandji audit and remediation pair", async () => {
    const dir = repo();
    const body = bundle(
      (await run(["policy", "package", "--mdm", "kandji", "--json"], { cwd: dir.root })).out,
    );
    expect(body.scripts).toEqual(["audit.sh", "remediation.sh"]);
    const audit = readFileSync(join(body.out, "audit.sh"), "utf8");
    expect(audit).toContain("exit 1");
    expect(audit).not.toContain("base64");
    expect(readFileSync(join(body.out, "README.txt"), "utf8")).toContain("Custom Script");
    if (process.platform !== "win32") {
      for (const script of body.scripts) execFileSync("sh", ["-n", join(body.out, script)]);
    }
  });

  it("bundles Intune scripts for macOS and Windows", async () => {
    const dir = repo();
    const out = dir.path("intune-out");
    const body = bundle(
      (
        await run(["policy", "package", "--mdm", "Intune", "--out", out, "--json"], {
          cwd: dir.root,
        })
      ).out,
    );
    expect(body.out).toBe(out);
    expect(body.scripts).toEqual(["install.sh", "install.ps1", "detect.ps1"]);
    const windows = body.files.filter((file) => file.platform === "win32");
    expect(windows.map((file) => file.target)).toEqual([
      "C:\\Program Files\\ClaudeCode\\managed-settings.d\\selfhost.json",
      "C:\\ProgramData\\OpenAI\\Codex\\requirements.toml",
      "C:\\ProgramData\\Cursor\\hooks.json",
      "C:\\Program Files\\GitHubCopilot\\managed-settings.json",
      ".cursor/permissions.json",
    ]);
    const install = readFileSync(join(out, "install.ps1"), "utf8");
    for (const file of windows.filter((f) => f.scope === "system")) {
      expect(payload(install, file.target)).toBe(readFileSync(join(out, file.file), "utf8"));
    }
    expect(install).toContain("Join-Path $_.FullName '.cursor\\permissions.json'");
    const detect = readFileSync(join(out, "detect.ps1"), "utf8");
    expect(detect).toContain("@('C:\\ProgramData\\OpenAI\\Codex\\requirements.toml', '");
    expect(readFileSync(join(out, "README.txt"), "utf8")).toContain("Remediations");
  });

  it("refuses an unknown tool and prints what it wrote", async () => {
    const dir = repo();
    const refused = await run(["policy", "package", "--mdm", "workspace-one"], { cwd: dir.root });
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('--mdm: expected jamf, kandji or intune, got "workspace-one"');

    const text = await run(["policy", "package", "--mdm", "kandji"], { cwd: dir.root });
    expect(text.out).toMatch(
      /^Packaged 6 managed settings files for Kandji into \.selfhost\/mdm\/kandji/,
    );
    expect(text.out).toContain(
      "Give Kandji audit.sh, remediation.sh; README.txt says where each goes.",
    );
  });
});
