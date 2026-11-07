import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildArtifacts } from "./artifacts.js";

const root = join(import.meta.dirname, "..");

for (const artifact of buildArtifacts()) {
  const target = join(root, artifact.path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, artifact.content);
  console.log(`wrote ${artifact.path}`);
}
