import type { ApiError } from "@selfhost/schema";

/**
 * Why a tool call failed, as the ApiError codes the HTTP API uses: forbidden for a team, repo or
 * item outside the caller's permissions (no data comes with it), not_found, invalid_request,
 * not_open for an item someone already answered, unavailable when the ledger cannot be opened.
 */
export type McpErrorCode =
  | "forbidden"
  | "not_found"
  | "invalid_request"
  | "not_open"
  | "unavailable"
  | "internal";

export class McpToolError extends Error {
  constructor(
    readonly code: McpErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "McpToolError";
  }

  toJSON(): ApiError {
    return { error: { code: this.code, message: this.message } };
  }
}

/** The error a team the caller is not in gets, whether or not the team exists. */
export const notInTeam = (team: string) =>
  new McpToolError("forbidden", `You are not in team ${team}.`);

/** The error an item outside the caller's teams gets, whether or not it exists. */
export const itemOutOfReach = (id: string) =>
  new McpToolError("forbidden", `Review item ${id} is not in any team you are in.`);
