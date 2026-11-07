/**
 * The one place the Apache-licensed server reaches into ee/, which is under the commercial
 * license in ee/LICENSE. The risk score loads when the first agent pull request is scored,
 * never at startup, and lint stops every other file outside ee/ from importing it. A build
 * that leaves ee/ out gets undefined, and agent pull requests get no risk label.
 */
export async function loadRisk(): Promise<typeof import("@selfhost/ee-risk") | undefined> {
  try {
    return await import("@selfhost/ee-risk");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") return undefined;
    throw error;
  }
}
