/** Team or org id from a name: lower case words joined by dashes, at most 64 characters. */
export function teamId(name: string): string | undefined {
  const id = name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 64)
    .replace(/^-+|-+$/g, "");
  return id === "" ? undefined : id;
}
