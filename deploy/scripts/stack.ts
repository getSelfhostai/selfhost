import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const PACKAGE_ROOT = join(import.meta.dirname, "..");
export const DOCKER_DIR = join(PACKAGE_ROOT, "docker");
export const GENERATED_PATH = "src/stack.generated.ts";

/**
 * The files of docker/ that `selfhost up` puts on a server, plus .env.example for its defaults.
 * The Dockerfile and README stay behind: servers pull the image instead of building it.
 */
export const STACK_PATHS = [
  "compose.yml",
  "compose.tls.yml",
  "compose.signin.yml",
  "compose.gateway.yml",
  "compose.notify.yml",
  "otel-collector.yaml",
  "Caddyfile",
  "install.sh",
  "gateway-config.sh",
  "backup.sh",
  "restore.sh",
  "upgrade.sh",
  ".env.example",
] as const;

/**
 * Builds src/stack.generated.ts from docker/. The files there are the source; the generated module
 * embeds them so the bundled CLI and its compiled binaries carry the stack they deploy.
 */
export function buildStackModule(): string {
  const entries = STACK_PATHS.map((path) => {
    const file = join(DOCKER_DIR, path);
    const mode = statSync(file).mode & 0o111 ? "0o755" : "0o644";
    const content = readFileSync(file, "utf8");
    return `  {\n    path: ${JSON.stringify(path)},\n    mode: ${mode},\n    content: ${JSON.stringify(content)},\n  },`;
  });
  return [
    "// Generated from deploy/docker. Run `pnpm --filter @selfhost/deploy embed-stack` after changing it. Do not edit by hand.",
    "",
    "export interface StackFile {",
    "  /** Path relative to the stack folder, deploy/docker in the repository. */",
    "  path: string;",
    "  mode: number;",
    "  content: string;",
    "}",
    "",
    "export const STACK_FILES: readonly StackFile[] = [",
    ...entries,
    "];",
    "",
  ].join("\n");
}
