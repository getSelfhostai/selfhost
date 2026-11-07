import { isMap, parseDocument, type Document as YamlDocument } from "yaml";

export type Plain = Record<string, unknown>;

export function isPlainObject(value: unknown): value is Plain {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]))
    );
  }
  return false;
}

export function getPath(root: unknown, path: string[]): unknown {
  let node = root;
  for (const key of path) {
    if (!isPlainObject(node) || !Object.hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

export function isEmptyValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  return isPlainObject(value) && Object.keys(value).length === 0;
}

/** A settings file as a tree of keys, edited in place and written back in its own style. */
export interface TreeDoc {
  get(path: string[]): unknown;
  has(path: string[]): boolean;
  set(path: string[], value: unknown): void;
  delete(path: string[]): void;
  toJS(): Plain;
  toString(): string;
}

export type OpenResult = { ok: true; doc: TreeDoc } | { ok: false; error: string };

class JsonDoc implements TreeDoc {
  constructor(
    private root: Plain,
    private indent: string,
    private finalNewline: boolean,
  ) {}

  get(path: string[]) {
    return getPath(this.root, path);
  }

  has(path: string[]) {
    const parent = getPath(this.root, path.slice(0, -1));
    const key = path[path.length - 1];
    return key !== undefined && isPlainObject(parent) && Object.hasOwn(parent, key);
  }

  set(path: string[], value: unknown) {
    let node = this.root;
    for (const key of path.slice(0, -1)) {
      const next = node[key];
      if (isPlainObject(next)) {
        node = next;
      } else {
        const created: Plain = {};
        node[key] = created;
        node = created;
      }
    }
    const last = path[path.length - 1];
    if (last !== undefined) node[last] = structuredClone(value);
  }

  delete(path: string[]) {
    const parent = getPath(this.root, path.slice(0, -1));
    const key = path[path.length - 1];
    if (key !== undefined && isPlainObject(parent)) delete parent[key];
  }

  toJS() {
    return this.root;
  }

  toString() {
    return JSON.stringify(this.root, null, this.indent) + (this.finalNewline ? "\n" : "");
  }
}

class YamlDoc implements TreeDoc {
  constructor(private doc: YamlDocument) {}

  get(path: string[]) {
    return getPath(this.toJS(), path);
  }

  has(path: string[]) {
    return this.doc.hasIn(path);
  }

  set(path: string[], value: unknown) {
    this.doc.setIn(path, this.doc.createNode(structuredClone(value)));
  }

  delete(path: string[]) {
    this.doc.deleteIn(path);
  }

  toJS() {
    const value: unknown = this.doc.toJS();
    return isPlainObject(value) ? value : {};
  }

  toString() {
    return String(this.doc);
  }
}

function openJson(text: string | null, path: string): OpenResult {
  if (text === null || text.trim() === "") {
    return { ok: true, doc: new JsonDoc({}, "  ", true) };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `${path} is not plain JSON (${reason}); selfhost only rewrites files without comments`,
    };
  }
  if (!isPlainObject(value)) return { ok: false, error: `${path} does not hold a JSON object` };
  const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? "  ";
  return { ok: true, doc: new JsonDoc(value, indent, text.endsWith("\n")) };
}

function openYaml(text: string | null, path: string): OpenResult {
  const doc = parseDocument(text ?? "");
  const [first] = doc.errors;
  if (first) return { ok: false, error: `${path} is not valid YAML: ${first.message}` };
  if (doc.contents !== null && !isMap(doc.contents)) {
    return { ok: false, error: `${path} does not hold a YAML mapping` };
  }
  return { ok: true, doc: new YamlDoc(doc) };
}

export function openDoc(format: "json" | "yaml", text: string | null, path: string): OpenResult {
  return format === "json" ? openJson(text, path) : openYaml(text, path);
}

export function parseTree(format: "json" | "yaml", text: string): unknown {
  const opened = openDoc(format, text, "");
  return opened.ok ? opened.doc.toJS() : undefined;
}
