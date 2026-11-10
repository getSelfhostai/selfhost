/**
 * The CLI needs Node 20 (node:readline/promises, fetch, import.meta.dirname). An older Node
 * fails while loading the rest of the CLI with an error that names a module, not the version,
 * so main.ts checks first and imports nothing that needs Node 20 before it. This file imports
 * nothing. The standalone binaries run on Bun, which is checked at build time instead.
 */
export const MIN_NODE_MAJOR = 20;

/** Why this runtime cannot run the CLI, or undefined when it can. */
export function nodeVersionProblem(
  versions: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (versions.bun !== undefined) return undefined;
  const version = versions.node ?? "";
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (Number.isFinite(major) && major >= MIN_NODE_MAJOR) return undefined;
  return `selfhost needs Node ${MIN_NODE_MAJOR} or newer; you have ${version ? `Node ${version}` : "an unknown version"}. Install a newer Node (nodejs.org, or nvm install ${MIN_NODE_MAJOR}) and run it again.`;
}
