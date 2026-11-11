const SHORT = 8;

/**
 * The shortest tail, at least 8 characters, that tells each id apart from the others. Review
 * item and handoff ids are UUIDv7: their first characters are a timestamp, so ids made the same
 * minute share them, while the tail is random. The CLI accepts the start or the end of an id.
 */
export function shortIds(ids: readonly string[]): Map<string, string> {
  const short = new Map<string, string>();
  for (const id of ids) {
    let length = SHORT;
    const taken = (n: number) => ids.some((other) => other !== id && other.endsWith(id.slice(-n)));
    while (length < id.length && (taken(length) || id.at(-length) === "-")) length++;
    short.set(id, id.slice(-length));
  }
  return short;
}

/** The short form of one id, as a line about a single item or handoff shows it. */
export const shortId = (id: string): string => (id.length > SHORT ? id.slice(-SHORT) : id);
