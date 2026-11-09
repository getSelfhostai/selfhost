/**
 * The line a reviewer that writes free text (the Claude Code GitHub Action) is told to end its
 * summary comment with, so its verdict can be read back:
 * `<!-- selfhost:second-opinion tool=claude-code-action verdict=changes findings=2 severity=high -->`.
 */
export const SECOND_OPINION_MARKER = "selfhost:second-opinion";

/** The selfhost brief comment's marker, as @selfhost/brief writes it (BRIEF_MARKER). */
export const BRIEF_MARKER = "<!-- selfhost:brief v1 -->";
