#!/usr/bin/env node
// Prints the release notes of a version: its CHANGELOG.md section, then how to install and verify
// that release. GITHUB_REPOSITORY (owner/name) names the repository; the default is the owner in
// apps/cli/src/project.ts.
//
// Usage: node scripts/release/notes.mjs [version]   (default: the root package.json version)

import { changelogSection, githubOwner, sourceVersion } from "./version.mjs";

const version = process.argv[2] ?? sourceVersion();
const section = changelogSection(version);
if (section === undefined) {
  console.error(`CHANGELOG.md has no "## ${version}" section`);
  process.exit(1);
}
const repo = process.env.GITHUB_REPOSITORY || `${githubOwner()}/selfhost`;
const image = `ghcr.io/${repo.split("/")[0].toLowerCase()}/selfhost:${version}`;

process.stdout.write(`${section}

## Install

\`\`\`sh
npx selfhostai@${version} init         # a laptop
npm install -g selfhostai@${version}   # selfhost on PATH
docker pull ${image}
\`\`\`

The binaries below need neither Node nor Bun. \`selfhost-docker-${version}.tar.gz\` is the Docker
Compose install (deploy/docker) for this release.

## Verify

\`\`\`sh
sha256sum --check --ignore-missing SHA256SUMS
gh attestation verify selfhost-linux-x64 --repo ${repo}
gh attestation verify oci://${image} --repo ${repo}
\`\`\`
`);
