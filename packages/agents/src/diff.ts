type Op = { op: " " | "-" | "+"; line: string };

/** Beyond this many edits the middle of the file is shown as one replacement. */
const MAX_EDITS = 1000;

function splitLines(text: string | null): string[] {
  if (text === null || text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Myers' O(ND) diff on lines, keeping each step's frontier to walk the path back. */
function myers(a: string[], b: string[]): Op[] | undefined {
  const n = a.length;
  const m = b.length;
  const maxD = Math.min(n + m, MAX_EDITS);
  const off = maxD + 1;
  const v = new Int32Array(2 * maxD + 3);
  const trace: Int32Array[] = [];
  const at = (k: number) => v[off + k] ?? 0;
  for (let d = 0; d <= maxD; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? at(k + 1) : at(k - 1) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        trace.push(v.slice(off - d, off + d + 1));
        return backtrack(trace, a, b);
      }
    }
    trace.push(v.slice(off - d, off + d + 1));
  }
  return undefined;
}

function backtrack(trace: Int32Array[], a: string[], b: string[]): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d - 1] ?? new Int32Array(0);
    const get = (k: number) => prev[k + d - 1] ?? 0;
    const k = x - y;
    const prevK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
    const prevX = get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ op: " ", line: a[--x] ?? "" });
      y--;
    }
    if (x === prevX) ops.push({ op: "+", line: b[--y] ?? "" });
    else ops.push({ op: "-", line: a[--x] ?? "" });
  }
  while (x > 0 && y > 0) {
    ops.push({ op: " ", line: a[--x] ?? "" });
    y--;
  }
  return ops.reverse();
}

export function diffLines(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const middle = myers(midA, midB) ?? [
    ...midA.map((line): Op => ({ op: "-", line })),
    ...midB.map((line): Op => ({ op: "+", line })),
  ];
  const same = (line: string): Op => ({ op: " ", line });
  return [...a.slice(0, start).map(same), ...middle, ...a.slice(endA).map(same)];
}

const SECRET_KEY =
  /(api[_-]?key|token|secret|passw(or)?d|credential|authorization|private[_-]?key|otlp_headers|^headers$|^http_headers$)/i;
const KEY_VALUE = /^(\s*(?:-\s+)?)(["']?)([\w.-]+)\2(\s*[:=]\s*)(.+?)(,?)$/;

/**
 * Masks values that look like credentials in a config line: values of keys such as
 * `apiKey`, `token`, `Authorization` or `headers`, and bearer tokens anywhere.
 */
export function redactLine(line: string): string {
  const masked = line.replace(/(Bearer\s+)[^\s"',}]+/gi, "$1<redacted>");
  const match = KEY_VALUE.exec(masked);
  if (!match) return masked;
  const [, indent, quote, key = "", separator, value = "", comma] = match;
  if (!SECRET_KEY.test(key) || value === "{" || value === "[") return masked;
  return `${indent}${quote}${key}${quote}${separator}"<redacted>"${comma}`;
}

/**
 * A unified diff with three lines of context. Values that look like credentials are masked
 * unless `redact` is false.
 */
export function unifiedDiff(
  path: string,
  before: string | null,
  after: string | null,
  { context = 3, redact = true }: { context?: number; redact?: boolean } = {},
): string {
  const ops = diffLines(splitLines(before), splitLines(after));
  if (ops.every((op) => op.op === " ")) return "";
  const aIndex: number[] = [];
  const bIndex: number[] = [];
  let a = 0;
  let b = 0;
  for (const op of ops) {
    aIndex.push(a);
    bIndex.push(b);
    if (op.op !== "+") a++;
    if (op.op !== "-") b++;
  }
  aIndex.push(a);
  bIndex.push(b);

  const out = [
    `--- ${before === null ? "/dev/null" : path}`,
    `+++ ${after === null ? "/dev/null" : path}`,
  ];
  let i = 0;
  while (i < ops.length) {
    if (ops[i]?.op === " ") {
      i++;
      continue;
    }
    const start = Math.max(0, i - context);
    let end = i;
    let j = i;
    while (j < ops.length) {
      if (ops[j]?.op !== " ") {
        end = j++;
        continue;
      }
      let next = j;
      while (next < ops.length && ops[next]?.op === " ") next++;
      if (next < ops.length && next - j <= 2 * context) j = next;
      else break;
    }
    const stop = Math.min(ops.length, end + 1 + context);
    const hunk = ops.slice(start, stop);
    const aCount = hunk.filter((op) => op.op !== "+").length;
    const bCount = hunk.filter((op) => op.op !== "-").length;
    const aStart = (aIndex[start] ?? 0) + (aCount > 0 ? 1 : 0);
    const bStart = (bIndex[start] ?? 0) + (bCount > 0 ? 1 : 0);
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const op of hunk) out.push(op.op + (redact ? redactLine(op.line) : op.line));
    i = stop;
  }
  return `${out.join("\n")}\n`;
}
