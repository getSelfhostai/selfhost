/**
 * The one place the Apache-licensed server reaches into ee/, which is under the commercial
 * license in ee/LICENSE. Each package loads when it is first needed, never at startup, and lint
 * stops every other file outside ee/ from importing it. A build that leaves ee/ out gets
 * undefined: agent pull requests get no risk label, and POST /v1/receipts answers 404.
 */

/** The risk score, loaded when the first agent pull request is scored. */
export async function loadRisk(): Promise<typeof import("@selfhost/ee-risk") | undefined> {
  try {
    return await import("@selfhost/ee-risk");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") return undefined;
    throw error;
  }
}

/** The proof receipt's rendering, loaded when the first receipt arrives or a brief links one. */
export async function loadReceipt(): Promise<typeof import("@selfhost/ee-receipt") | undefined> {
  try {
    return await import("@selfhost/ee-receipt");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") return undefined;
    throw error;
  }
}
