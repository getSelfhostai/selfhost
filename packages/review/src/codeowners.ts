import { normalizePath } from "@selfhost/policy";

/** Where GitHub looks for CODEOWNERS, in the order it looks. The first one found is used. */
export const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"] as const;

/** One line of a CODEOWNERS file: a pattern and the owners of the files it matches. */
export interface CodeOwnersRule {
  pattern: string;
  /** As written: @login, @org/team or an email. Empty when the line takes owners away. */
  owners: string[];
  /** 1-based line in the file. */
  line: number;
  regex: RegExp;
}

export interface CodeOwners {
  rules: CodeOwnersRule[];
}

/** Owners of a set of files, split the way routing uses them. */
export interface CodeOwnersMatch {
  /** @login entries, without the @. */
  users: string[];
  /** Team slugs of @org/team entries. */
  teams: string[];
  /** Email entries, which are person ids as they are. */
  emails: string[];
}

function escapeRegex(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/**
 * A CODEOWNERS pattern as a regular expression over paths relative to the repository root, with
 * the gitignore rules GitHub uses: a pattern with a slash at the start or in the middle is
 * anchored at the root, one without matches at any depth; a trailing slash, or a pattern that
 * names a folder, also matches everything under it, but `docs/*` matches only the files right in
 * docs; `*` stays in one segment and `**` spans any.
 */
export function codeOwnersRegex(pattern: string): RegExp {
  let body = pattern;
  const trailingSlash = body.endsWith("/");
  if (trailingSlash) body = body.slice(0, -1);
  const anchored = body.startsWith("/") || body.includes("/");
  if (body.startsWith("/")) body = body.slice(1);
  let source = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] as string;
    if (ch === "*" && body[i + 1] === "*") {
      const slash = body[i + 2] === "/";
      source += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (ch === "*") source += "[^/]*";
    else if (ch === "?") source += "[^/]";
    else if (ch === "\\" && i + 1 < body.length) {
      source += escapeRegex(body[i + 1] as string);
      i += 1;
    } else source += escapeRegex(ch);
  }
  const prefix = anchored ? "^" : "^(?:.*/)?";
  // A match on a folder covers what is in it, and a trailing slash matches only folders. A last
  // segment with a wildcard, as in docs/*, matches files at that depth only.
  const last = body.slice(body.lastIndexOf("/") + 1);
  const suffix = trailingSlash ? "/.*" : last.includes("*") ? "" : "(?:/.*)?";
  return new RegExp(`${prefix}${source}${suffix}$`);
}

/** Parses a CODEOWNERS file. Lines that cannot be read are skipped, as GitHub skips them. */
export function parseCodeOwners(text: string): CodeOwners {
  const rules: CodeOwnersRule[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (line === "") return;
    const [pattern, ...owners] = line.split(/\s+/);
    if (!pattern || pattern.startsWith("!") || pattern.includes("[")) return;
    rules.push({ pattern, owners, line: index + 1, regex: codeOwnersRegex(pattern) });
  });
  return { rules };
}

/** The rule that owns one file: the last one whose pattern matches it. */
export function codeOwnersRuleFor(
  codeowners: CodeOwners,
  path: string,
): CodeOwnersRule | undefined {
  const file = normalizePath(path);
  for (let i = codeowners.rules.length - 1; i >= 0; i--) {
    const rule = codeowners.rules[i] as CodeOwnersRule;
    if (rule.regex.test(file)) return rule;
  }
  return undefined;
}

/** The owners of every file, in file order, each once. */
export function codeOwnersOf(codeowners: CodeOwners, paths: readonly string[]): CodeOwnersMatch {
  const users = new Set<string>();
  const teams = new Set<string>();
  const emails = new Set<string>();
  for (const path of paths) {
    for (const owner of codeOwnersRuleFor(codeowners, path)?.owners ?? []) {
      if (owner.startsWith("@") && owner.includes("/")) {
        teams.add(owner.slice(owner.indexOf("/") + 1));
      } else if (owner.startsWith("@")) users.add(owner.slice(1));
      else if (owner.includes("@")) emails.add(owner);
    }
  }
  return { users: [...users], teams: [...teams], emails: [...emails] };
}
