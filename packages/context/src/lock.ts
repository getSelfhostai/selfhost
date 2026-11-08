import { createHash } from "node:crypto";
import { CONTEXT_AGENTS, COVERAGE_STATUSES, createValidator, StringEnum } from "@selfhost/schema";
import { type Static, Type } from "@sinclair/typebox";
import semver from "semver";
import type { CompileResult } from "./compile/index.js";
import type { Content, GeneratedFile } from "./compile/output.js";
import { CONTEXT_DIR, LOCK_PATH } from "./schema.js";
import type { ContextSource } from "./types.js";

const HEADERS = ["comment", "front_matter", "block", "lock"] as const;

export const ContextLockSchema = Type.Object(
  {
    schema: Type.Literal("selfhost.context_lock/v1"),
    agents: Type.Array(StringEnum(CONTEXT_AGENTS), {
      description: "Agents the repository's context compiles for; the next compile keeps them.",
    }),
    skills: Type.Record(
      Type.String(),
      Type.Object(
        {
          version: Type.String(),
          sha256: Type.String({ description: "Hash of the skill's source folder." }),
          agents: Type.Record(
            Type.String(),
            Type.Object(
              {
                status: StringEnum(COVERAGE_STATUSES),
                version: Type.Union([Type.String(), Type.Null()], {
                  description: "The version the agent received, or null when it got none.",
                }),
                files: Type.Array(Type.String()),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    files: Type.Record(
      Type.String(),
      Type.Object(
        {
          sources: Type.Array(Type.String()),
          header: StringEnum(HEADERS),
          sha256: Type.String({
            description: "Hash of the file, or of selfhost's key or block in a shared file.",
          }),
          key: Type.Optional(Type.Array(Type.String())),
        },
        { additionalProperties: false },
      ),
      { description: "Every file the compile wrote, with its sources." },
    ),
  },
  { additionalProperties: false, title: "ContextLock" },
);

export type ContextLock = Static<typeof ContextLockSchema>;

const validateLock = createValidator(ContextLockSchema);

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** The hash the lock keeps for a file: of the bytes selfhost owns in it. */
export function contentHash(content: Content): string {
  switch (content.kind) {
    case "text":
      return sha256(content.text);
    case "bytes":
      return sha256(content.bytes);
    case "json_key":
      return sha256(JSON.stringify(content.value));
    case "toml_block":
      return sha256(content.body);
  }
}

function skillHash(source: ContextSource, name: string): string {
  const skill = source.skills.find((candidate) => candidate.name === name);
  if (!skill) return "";
  const hash = createHash("sha256");
  hash.update(JSON.stringify(skill.frontMatter)).update("\0").update(skill.body);
  for (const file of skill.files)
    hash.update("\0").update(file.path).update("\0").update(file.content);
  return hash.digest("hex");
}

export function buildLock(source: ContextSource, result: CompileResult): ContextLock {
  return {
    schema: "selfhost.context_lock/v1",
    agents: result.agents,
    skills: Object.fromEntries(
      result.skills.map((skill) => [
        skill.name,
        {
          version: skill.version,
          sha256: skillHash(source, skill.name),
          agents: Object.fromEntries(
            Object.entries(skill.agents).map(([agent, entry]) => [
              agent,
              {
                status: entry.status,
                version:
                  entry.status === "compiled" || entry.status === "partial" ? skill.version : null,
                files: entry.files,
              },
            ]),
          ),
        },
      ]),
    ),
    files: Object.fromEntries(
      result.files.map((file) => [
        file.path,
        {
          sources: file.sources,
          header: file.header,
          sha256: contentHash(file.content),
          ...(file.content.kind === "json_key" ? { key: file.content.key } : {}),
        },
      ]),
    ),
  };
}

/** The lock as the file it is written to. */
export function lockFile(lock: ContextLock): GeneratedFile {
  return {
    path: LOCK_PATH,
    sources: [CONTEXT_DIR],
    header: "lock",
    content: { kind: "text", text: `${JSON.stringify(lock, null, 2)}\n` },
  };
}

/** A lock read back; undefined when the text is not a lock this version understands. */
export function parseLock(text: string): ContextLock | undefined {
  try {
    const result = validateLock.validate(JSON.parse(text));
    return result.ok ? result.value : undefined;
  } catch {
    return undefined;
  }
}

/** Skills whose source changed without a new version, or whose version went down. */
export function versionWarnings(previous: ContextLock | undefined, next: ContextLock): string[] {
  if (!previous) return [];
  const warnings: string[] = [];
  for (const [name, skill] of Object.entries(next.skills)) {
    const before = previous.skills[name];
    if (!before) continue;
    const order = semver.compare(skill.version, before.version);
    if (order < 0) {
      warnings.push(`Skill ${name} went from version ${before.version} down to ${skill.version}.`);
    } else if (order === 0 && skill.sha256 !== before.sha256) {
      warnings.push(
        `Skill ${name} changed but is still version ${skill.version}; raise version in ${CONTEXT_DIR}/skills/${name}/SKILL.md so agents and reviewers can tell the copies apart.`,
      );
    }
  }
  return warnings;
}
