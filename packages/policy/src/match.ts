import picomatch from "picomatch/posix.js";

type Matcher = (input: string) => boolean;

// Compiled once per pattern. Neither cache changes a result: a RegExp without the g or y flag
// keeps no state between calls.
const regexes = new Map<string, RegExp>();
const globs = new Map<string, Matcher>();

/** Tests a rule's `command` pattern anywhere in the input. parseConfig has checked the syntax. */
export function regexMatches(pattern: string, input: string): boolean {
  let regex = regexes.get(pattern);
  if (!regex) {
    regex = new RegExp(pattern);
    regexes.set(pattern, regex);
  }
  return regex.test(input);
}

/**
 * Tests a glob the same way on every platform: `/` separates segments, `*` stays inside one,
 * `**` spans any number, and both match names that start with a dot, so `infra/**` covers
 * `infra/.terraform`.
 */
export function globMatches(glob: string, input: string): boolean {
  let matcher = globs.get(glob);
  if (!matcher) {
    matcher = picomatch(glob, { dot: true });
    globs.set(glob, matcher);
  }
  return matcher(input);
}

export function anyGlobMatches(globList: readonly string[], input: string): boolean {
  return globList.some((glob) => globMatches(glob, input));
}
