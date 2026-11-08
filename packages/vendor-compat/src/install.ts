import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { run, tail } from "./exec.js";
import type { Vendor, VendorId, VendorRun } from "./types.js";

const PLATFORMS: Partial<Record<NodeJS.Platform, string>> = { linux: "linux", darwin: "darwin" };
const ARCHES: Partial<Record<string, string>> = { x64: "x64", arm64: "arm64" };

/** The os-arch suffix vendor platform packages use, such as linux-x64. */
export function platformSuffix(platform = process.platform, arch = process.arch): string {
  const os = PLATFORMS[platform];
  const cpu = ARCHES[arch];
  if (!os || !cpu) throw new Error(`No vendor CLI builds are checked for ${platform}-${arch}`);
  return `${os}-${cpu}`;
}

/**
 * Where each CLI's executable sits once its npm package is installed with --ignore-scripts:
 * every vendor ships the binary in a platform package named with the os and arch.
 */
function npmBinary(id: VendorId, nodeModules: string, suffix: string): string | undefined {
  switch (id) {
    case "claude_code":
      return join(nodeModules, "@anthropic-ai", `claude-code-${suffix}`, "claude");
    case "codex": {
      const vendorDir = join(nodeModules, "@openai", `codex-${suffix}`, "vendor");
      const [triple] = existsSync(vendorDir) ? readdirSync(vendorDir) : [];
      return triple ? join(vendorDir, triple, "bin", "codex") : undefined;
    }
    case "opencode":
      return join(nodeModules, `opencode-${suffix}`, "bin", "opencode");
    default:
      return undefined;
  }
}

async function download(url: string, file: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

/**
 * Installs one CLI version under root/<vendor> without running its install scripts, and finds
 * its executable. Nothing is installed globally. Cursor's CLI is not on npm: its package is
 * downloaded from the URL its installer script uses and unpacked, without running the script.
 */
export async function installVendor(
  vendor: Vendor,
  version: string,
  root: string,
): Promise<VendorRun> {
  const dir = join(root, vendor.id);
  mkdirSync(dir, { recursive: true });
  const result: VendorRun = { vendor: vendor.id, version, dir, checks: [] };
  const fail = (detail: string) => {
    result.checks.push({ id: "install", status: "fail", detail });
    return result;
  };
  const suffix = platformSuffix();
  let bin: string | undefined;
  if (vendor.npm) {
    const out = run(
      "npm",
      [
        "install",
        "--prefix",
        dir,
        "--no-save",
        "--no-fund",
        "--no-audit",
        "--ignore-scripts",
        "--loglevel=error",
        `${vendor.npm}@${version}`,
      ],
      { timeoutMs: 600_000 },
    );
    if (out.status !== 0) return fail(`npm install ${vendor.npm}@${version} failed:\n${tail(out)}`);
    bin = npmBinary(vendor.id, join(dir, "node_modules"), suffix);
  } else {
    const archive = join(dir, "agent-cli-package.tar.gz");
    const url = `https://downloads.cursor.com/lab/${version}/${suffix.replace("-", "/")}/agent-cli-package.tar.gz`;
    try {
      await download(url, archive);
    } catch (error) {
      return fail(`Download failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const out = run("tar", ["-xzf", archive, "-C", dir]);
    if (out.status !== 0) return fail(`Could not unpack ${url}:\n${tail(out)}`);
    bin = join(dir, "dist-package", "cursor-agent");
  }
  if (!bin || !existsSync(bin)) {
    const where = bin ? relative(dir, bin) : "its platform package";
    return fail(`Installed, but found no ${suffix} executable at ${where}`);
  }
  result.bin = bin;
  const source = vendor.npm ? `${vendor.npm}@${version}` : `${vendor.installer} (${version})`;
  result.checks.push({ id: "install", status: "pass", detail: `Installed ${source}, ${suffix}` });
  return result;
}

/** The files to search for hook names: the executable, or Cursor's bundled scripts. */
export function searchFiles(installed: VendorRun): string[] {
  if (!installed.bin) return [];
  if (installed.vendor !== "cursor") return [installed.bin];
  const dist = join(installed.dir ?? "", "dist-package");
  return readdirSync(dist)
    .filter((name) => name.endsWith(".js"))
    .map((name) => join(dist, name));
}
