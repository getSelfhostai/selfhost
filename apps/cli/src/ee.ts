/**
 * The one place the Apache-licensed CLI reaches into ee/, which is under the commercial license
 * in ee/LICENSE. A commercial command loads its package here when it runs, never at startup,
 * and lint stops every other file outside ee/ from importing it.
 */
export async function loadRisk(): Promise<typeof import("@selfhost/ee-risk")> {
  try {
    return await import("@selfhost/ee-risk");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") {
      throw new Error(
        "selfhost review risk is part of the commercial edition (ee/), which this build leaves out",
      );
    }
    throw error;
  }
}
