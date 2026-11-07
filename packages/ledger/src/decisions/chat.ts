import type { CreateDecisionRequest, PersonVerdict } from "@selfhost/schema";

/**
 * A decision button pressed in Slack or Telegram, after the bot has checked the request
 * signature, parsed the platform's callback and mapped the chat account to a person. The
 * Slack and Telegram apps are not built yet; when they are, each turns its callback into one
 * of these and passes chatDecision's result to recordDecision (or POST /v1/decisions).
 */
export interface ChatButtonPress {
  surface: "slack" | "telegram";
  /**
   * The platform's id for this press, the same on every retry: Slack's action_ts with the
   * user id, or Telegram's callback query id.
   */
  actionId: string;
  /** When the person pressed the button, ISO 8601 with an offset. */
  at: string;
  /** The person's selfhost id, such as their git email. */
  person: string;
  name?: string;
  verdict: PersonVerdict;
  /** Review item the message was about. */
  itemId?: string;
  runId?: string;
  /** The message text the buttons were under. */
  question?: string;
  /** The optional reason typed after the press. Kept to one line. */
  reason?: string;
}

const oneLine = (text: string | undefined) => text?.replace(/\s+/g, " ").trim() || undefined;

/** The decision for one button press. A retried press maps to the same event. */
export function chatDecision(press: ChatButtonPress): CreateDecisionRequest {
  const reason = oneLine(press.reason);
  const question = oneLine(press.question);
  return {
    verdict: press.verdict,
    by: press.person,
    ...(press.name ? { name: press.name } : {}),
    ...(reason ? { reason } : {}),
    ...(question ? { question } : {}),
    ...(press.itemId ? { item_id: press.itemId } : {}),
    ...(press.runId ? { run_id: press.runId } : {}),
    surface: press.surface,
    key: press.actionId,
    ts: press.at,
  };
}
