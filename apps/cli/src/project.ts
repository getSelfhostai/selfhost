import pkg from "../package.json" with { type: "json" };

/** This release, set by `pnpm release:version`. */
export const VERSION: string = pkg.version;
/** The npm package at this release: what a hook falls back to with npx, pinned. */
export const NPM_PACKAGE = `selfhostai@${VERSION}`;

/**
 * The GitHub owner the repository and the server image are published under. To move them, change
 * this line and run `pnpm release:version`, which rewrites the image and repository defaults in
 * deploy/docker and the READMEs to match and embeds the stack again.
 */
export const GITHUB_OWNER = "getselfhostai";

export const REPO_URL = `https://github.com/${GITHUB_OWNER}/selfhost`;
/** Links to a file on the main branch, for docs a message points at. */
export const DOCS_URL = `${REPO_URL}/blob/main`;
/** The server image `selfhost up` deploys, tagged with SELFHOST_VERSION. */
export const DEFAULT_IMAGE = `ghcr.io/${GITHUB_OWNER}/selfhost`;
