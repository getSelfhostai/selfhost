// The HTTP API client lands once the server implements the v1 API. What it sends is fixed here.
import { EVENT_SCHEMA } from "@selfhost/schema";

/** Event schema versions this SDK can send, newest first. */
export const EVENT_SCHEMAS: readonly string[] = [EVENT_SCHEMA];

/** What a server that predates schema versioning accepts. It lists no event_schemas. */
const UNVERSIONED_SERVER: readonly string[] = ["selfhost.event/v1"];

/**
 * The newest version both this SDK and a server speak, from the event_schemas the server lists
 * on GET /v1/health, or undefined when they share none and the SDK or server needs upgrading.
 */
export function pickEventSchema(accepted: readonly string[] | undefined): string | undefined {
  const theirs = accepted ?? UNVERSIONED_SERVER;
  return EVENT_SCHEMAS.find((tag) => theirs.includes(tag));
}
