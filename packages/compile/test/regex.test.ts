import { describe, expect, it } from "vitest";
import { unplainGlob, urlHost } from "../src/glob.js";
import { reduceCommand, unplainReason } from "../src/regex.js";

const forms = (pattern: string) => {
  const result = reduceCommand(pattern);
  if (!result.ok) throw new Error(result.reason);
  return result.forms;
};

describe("reduceCommand", () => {
  it("reads a literal prefix", () => {
    expect(forms("^git push --force")).toEqual([
      { text: "git push --force", start: true, end: "open", collapsed: false },
    ]);
  });

  it("reads $ as an exact end and (\\s|$) as a word end", () => {
    expect(forms("^npm publish$")).toEqual([
      { text: "npm publish", start: true, end: "exact", collapsed: false },
    ]);
    expect(forms("^git push (--force|-f)(\\s|$)")).toEqual([
      { text: "git push --force", start: true, end: "word", collapsed: false },
      { text: "git push -f", start: true, end: "word", collapsed: false },
    ]);
    expect(forms("^terraform destroy(?:\\s+|$)")[0]?.end).toBe("word");
  });

  it("expands alternation, groups and ? into each literal", () => {
    expect(forms("^git (push|reset) x|^rm -r?f").map((form) => form.text)).toEqual([
      "git push x",
      "git reset x",
      "rm -f",
      "rm -rf",
    ]);
  });

  it("marks unanchored text, a trailing \\b and whitespace classes between words", () => {
    expect(forms("rm -rf")[0]).toMatchObject({ start: false, end: "open" });
    expect(forms("^rm\\b")[0]).toMatchObject({ text: "rm", end: "boundary" });
    expect(forms("^git\\s+push")[0]).toMatchObject({ text: "git push", collapsed: true });
    expect(forms("^git push ")[0]).toMatchObject({ text: "git push ", collapsed: false });
  });

  it("reads escapes and one-character classes as the character", () => {
    expect(forms("^make \\.env")[0]?.text).toBe("make .env");
    expect(forms("^make [.]env")[0]?.text).toBe("make .env");
  });

  it.each([
    ["curl .*\\| *sh", "quantifier .*"],
    ["^git push.+", "quantifier .+"],
    ["^rm [rf]", "character class [rf]"],
    ["^(?=git)", "lookaround"],
    ["a^b", "^ after the start"],
    ["^a$b", "$ before the end"],
    ["\\bgit\\b", "\\b before the end"],
    ["^\\d", "\\d"],
    ["^(a)\\1", "back reference"],
    ["(a|b)(c|d)(e|f)(g|h)(i|j)(k|l)", "more than 32 alternatives"],
    ["", "no literal text"],
  ])("does not reduce %s", (pattern, reason) => {
    const result = reduceCommand(pattern);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(reason);
  });
});

describe("unplainReason", () => {
  it("accepts plain words", () => {
    expect(unplainReason("git push --force")).toBeUndefined();
    expect(unplainReason("kubectl delete ns/prod")).toBeUndefined();
  });

  it.each([
    ["a | b", '"|"'],
    ["echo $HOME", '"$"'],
    ["rm *", '"*"'],
    ["rm 'x'", `"'"`],
    ["a\nb", "a newline"],
    [" rm", "starts with a space"],
    ["git  push", "two spaces"],
    ["FOO=1 rm", "assignment FOO=1"],
    ["timeout 5 rm", "starts with timeout"],
    ["sudo rm", "starts with sudo"],
  ])("refuses %j", (text, reason) => {
    expect(unplainReason(text)).toContain(reason);
  });
});

describe("unplainGlob", () => {
  it("accepts gitignore-style globs", () => {
    for (const glob of ["**/.env*", "infra/**", "src/*.ts", "a?.ts", "src/[ab].ts"]) {
      expect(unplainGlob(glob)).toBeUndefined();
    }
  });

  it.each([
    ["!src/**", "negates"],
    ["src/{a,b}/*.ts", "braces"],
    ["+(a|b)/*.ts", "extglob"],
    ["/etc/passwd", "starts with /"],
    ["a\\*b", "backslash"],
    ["#x", "starts with #"],
  ])("refuses %s", (glob, reason) => {
    expect(unplainGlob(glob)).toContain(reason);
  });
});

describe("urlHost", () => {
  it("reads whole-site globs", () => {
    expect(urlHost("https://evil.example/**")).toEqual({ host: "evil.example", match: "host" });
    expect(urlHost("*://*.paste.example/**")).toEqual({
      host: "paste.example",
      match: "subdomains",
    });
    expect(urlHost("http*://*/**")).toEqual({ host: "*", match: "all" });
  });

  it("refuses globs that name a path, a port or a partial host", () => {
    expect(urlHost("https://github.com/acme/**")).toContain("names more than a whole site");
    expect(urlHost("https://example.com/*")).toContain("names more than a whole site");
    expect(urlHost("https://example.com:8443/**")).toContain("not a domain name");
    expect(urlHost("https://ex*.com/**")).toContain("not a domain name");
  });
});
