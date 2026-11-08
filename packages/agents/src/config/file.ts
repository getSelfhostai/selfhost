import type { FilePlan } from "./tree.js";
import type { FileTarget, ManifestFile } from "./types.js";

/**
 * Plans a file selfhost owns whole, such as an OpenCode plugin. A file selfhost did not write is
 * never replaced: a different file at the path is a conflict, and the same content is left
 * unowned, so removal keeps it. Removal deletes the file selfhost wrote.
 */
export function planFile(
  target: FileTarget,
  before: string | null,
  previous: ManifestFile | undefined,
): FilePlan {
  const owned = previous?.owned.find((entry) => entry.kind === "file");
  const want = target.items[0];
  if (!want) {
    if (!owned) return { items: [], after: before, manifest: undefined };
    return {
      items: [{ item: owned.item, status: "remove", path: target.path, message: null }],
      after: null,
      manifest: undefined,
    };
  }
  const manifest: ManifestFile = {
    format: "text",
    created: previous?.created ?? before === null,
    owned: [{ kind: "file", item: want.item }],
  };
  const item = (status: "create" | "update" | "unchanged", message: string | null) => ({
    item: want.item,
    status,
    path: target.path,
    message: message ?? want.note ?? null,
  });
  if (before === null) return { items: [item("create", null)], after: want.content, manifest };
  if (before === want.content) {
    return owned
      ? { items: [item("unchanged", null)], after: before, manifest }
      : { items: [item("unchanged", "already set")], after: before, manifest: undefined };
  }
  if (owned) return { items: [item("update", null)], after: want.content, manifest };
  return {
    items: [
      {
        item: want.item,
        status: "conflict",
        path: target.path,
        message: "left as is: a file selfhost did not write is already there",
      },
    ],
    after: before,
    manifest: undefined,
  };
}
