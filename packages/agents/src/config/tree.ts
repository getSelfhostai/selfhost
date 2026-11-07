import {
  deepEqual,
  isEmptyValue,
  isPlainObject,
  openDoc,
  parseTree,
  type TreeDoc,
} from "./docs.js";
import type {
  DesiredItem,
  Edit,
  HookStyle,
  ManifestFile,
  Owned,
  PlanItem,
  TreeTarget,
} from "./types.js";

export interface FilePlan {
  items: PlanItem[];
  /** New content; null deletes the file. Equal to `before` when nothing changes. */
  after: string | null;
  /** What selfhost owns in the file afterwards; undefined when it owns nothing. */
  manifest: ManifestFile | undefined;
}

type HookList = unknown[];

function hookCommands(entry: unknown, style: HookStyle): string[] {
  if (!isPlainObject(entry)) return [];
  if (style === "cursor") return typeof entry.command === "string" ? [entry.command] : [];
  const handlers = Array.isArray(entry.hooks) ? entry.hooks : [];
  return handlers.flatMap((handler) =>
    isPlainObject(handler) && typeof handler.command === "string" ? [handler.command] : [],
  );
}

function hasHook(list: HookList, style: HookStyle, command: string): boolean {
  return list.some((entry) => hookCommands(entry, style).includes(command));
}

function withHook(list: HookList, style: HookStyle, command: string): HookList {
  const entry = style === "cursor" ? { command } : { hooks: [{ type: "command", command }] };
  return [...list, entry];
}

function withoutHook(list: HookList, style: HookStyle, command: string): HookList {
  if (style === "cursor") {
    return list.filter((entry) => !hookCommands(entry, style).includes(command));
  }
  return list.flatMap((entry) => {
    if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) return [entry];
    const handlers = entry.hooks.filter(
      (handler) => !(isPlainObject(handler) && handler.command === command),
    );
    if (handlers.length === entry.hooks.length) return [entry];
    return handlers.length === 0 ? [] : [{ ...entry, hooks: handlers }];
  });
}

/** Takes out everything selfhost owned, leaving the user's own settings. */
function strip(doc: TreeDoc, owned: Owned[]) {
  for (const entry of [...owned].reverse()) {
    if (entry.kind === "key") {
      doc.delete(entry.path);
    } else if (entry.kind === "hook") {
      const list = doc.get(entry.path);
      if (!Array.isArray(list)) continue;
      const next = withoutHook(list, entry.style, entry.command);
      if (!deepEqual(next, list)) doc.set(entry.path, next);
    }
  }
  const containers = owned
    .filter((entry) => entry.kind === "container")
    .sort((a, b) => b.path.length - a.path.length);
  for (const { path } of containers) {
    if (doc.has(path) && isEmptyValue(doc.get(path))) doc.delete(path);
  }
}

/** Why an edit can't be made on top of the user's settings, if it can't. */
function editConflict(doc: TreeDoc, edit: Edit): string | undefined {
  for (let i = 1; i < edit.path.length; i++) {
    const prefix = edit.path.slice(0, i);
    if (doc.has(prefix) && !isPlainObject(doc.get(prefix))) {
      return `${prefix.join(".")} is not an object`;
    }
  }
  const current = doc.get(edit.path);
  if (edit.kind === "hook") {
    return current === undefined || Array.isArray(current)
      ? undefined
      : `${edit.path.join(".")} is not a list`;
  }
  if (doc.has(edit.path) && !deepEqual(current, edit.value)) {
    return `${edit.path.join(".")} is already set to another value`;
  }
  return undefined;
}

function isPresent(doc: TreeDoc, edit: Edit): boolean {
  if (edit.kind === "key") return doc.has(edit.path) && deepEqual(doc.get(edit.path), edit.value);
  const list = doc.get(edit.path);
  return Array.isArray(list) && hasHook(list, edit.style, edit.command);
}

function claimContainers(doc: TreeDoc, path: string[], owned: Owned[]) {
  for (let i = 1; i < path.length; i++) {
    const prefix = path.slice(0, i);
    if (!doc.has(prefix)) owned.push({ kind: "container", path: prefix });
  }
}

function applyEdit(doc: TreeDoc, item: string, edit: Edit, owned: Owned[]) {
  if (isPresent(doc, edit)) return;
  if (edit.kind === "key") {
    claimContainers(doc, edit.path, owned);
    doc.set(edit.path, edit.value);
    owned.push({ kind: "key", item, path: edit.path });
    return;
  }
  const list = doc.get(edit.path);
  if (list === undefined) {
    claimContainers(doc, edit.path, owned);
    owned.push({ kind: "container", path: edit.path });
  }
  doc.set(edit.path, withHook(Array.isArray(list) ? list : [], edit.style, edit.command));
  owned.push({ kind: "hook", item, path: edit.path, style: edit.style, command: edit.command });
}

/** A comparable record of an item's owned values, to tell create, update and unchanged apart. */
function signature(doc: TreeDoc, owned: Owned[], item: string): string {
  const parts = owned.flatMap((entry) => {
    if (entry.kind === "container" || entry.item !== item) return [];
    return entry.kind === "key"
      ? [JSON.stringify(["key", entry.path, doc.get(entry.path) ?? null])]
      : [JSON.stringify(["hook", entry.path, entry.command])];
  });
  return parts.sort().join("\n");
}

function ownedItems(owned: Owned[]): string[] {
  const items = new Set<string>();
  for (const entry of owned) if (entry.kind !== "container") items.add(entry.item);
  return [...items];
}

const errorItems = (items: DesiredItem[], path: string, message: string): PlanItem[] =>
  items.map(({ item }) => ({ item, status: "error", path, message }));

/**
 * Plans one JSON or YAML file: removes what selfhost owned last time, then adds each wanted
 * item on top of the user's own settings. A key the user already set to another value is a
 * conflict and is left alone, so removing selfhost's settings restores the user's exactly.
 */
export function planTree(
  target: TreeTarget,
  before: string | null,
  previous: ManifestFile | undefined,
): FilePlan {
  const opened = openDoc(target.format, before, target.path);
  if (!opened.ok) {
    return {
      items: errorItems(target.items, target.path, opened.error),
      after: before,
      manifest: previous,
    };
  }
  const { doc } = opened;
  const previousOwned = previous?.owned ?? [];
  const oldSignatures = new Map(
    ownedItems(previousOwned).map((item) => [item, signature(doc, previousOwned, item)]),
  );
  strip(doc, previousOwned);

  const owned: Owned[] = [];
  const items: PlanItem[] = [];
  for (const want of target.items) {
    const conflicts = want.edits.flatMap((edit) => editConflict(doc, edit) ?? []);
    if (conflicts.length > 0) {
      items.push({
        item: want.item,
        status: "conflict",
        path: target.path,
        message: `left as is: ${conflicts.join("; ")}`,
      });
      continue;
    }
    for (const edit of want.edits) applyEdit(doc, want.item, edit, owned);
    const now = signature(doc, owned, want.item);
    const old = oldSignatures.get(want.item);
    const status =
      now === ""
        ? "unchanged"
        : old === undefined
          ? "create"
          : old === now
            ? "unchanged"
            : "update";
    items.push({
      item: want.item,
      status,
      path: target.path,
      message: now === "" ? "already set" : (want.note ?? null),
    });
  }
  const wanted = new Set(target.items.map(({ item }) => item));
  for (const item of oldSignatures.keys()) {
    if (!wanted.has(item)) items.push({ item, status: "remove", path: target.path, message: null });
  }

  const created = previous?.created ?? before === null;
  const manifest = owned.length > 0 ? { format: target.format, created, owned } : undefined;
  let after: string | null = doc.toString();
  if (created && owned.length === 0 && isEmptyValue(doc.toJS())) after = null;
  // Same settings in another key order or layout: keep the file as it is.
  if (
    before !== null &&
    after !== null &&
    deepEqual(parseTree(target.format, before), doc.toJS())
  ) {
    after = before;
  }
  return { items, after, manifest };
}
