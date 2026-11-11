// Sends a run to the selfhost server's signed webhook, POST /v1/background-runs/webhook. The
// time, a new delivery id and the body are signed with SELFHOST_WEBHOOK_SECRET (the value of the
// variable [background] webhook_secret_env names on the server), so the server knows it came
// from this bridge, now, and takes it once. The sender must be on [background] webhook_senders.
import { createHmac, randomUUID } from "node:crypto";

export async function forwardRun({ server, secret, team, repo, task, sender, ref, agent }) {
  const body = JSON.stringify({
    task,
    repo,
    sender,
    ...(team ? { team } : {}),
    ...(ref ? { ref } : {}),
    ...(agent ? { agent } : {}),
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const delivery = randomUUID();
  const signed = `${timestamp}.${delivery}.${body}`;
  const signature = `sha256=${createHmac("sha256", secret).update(signed).digest("hex")}`;
  const response = await fetch(`${server.replace(/\/+$/, "")}/v1/background-runs/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-selfhost-signature-256": signature,
      "x-selfhost-timestamp": timestamp,
      "x-selfhost-delivery": delivery,
    },
    body,
  });
  const answer = await response.json().catch(() => ({}));
  if (response.ok) return `Started run ${answer.id} on branch ${answer.branch}.`;
  return `No run: ${answer.error?.message ?? `the server answered ${response.status}`}`;
}

/** `owner/name task...`, with an optional `--agent codex` first. */
export function parseCommand(text) {
  const words = text.trim().split(/\s+/);
  let agent;
  if (words[0] === "--agent") {
    agent = words[1];
    words.splice(0, 2);
  }
  const [repo, ...task] = words;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || task.length === 0) return undefined;
  return { repo, task: task.join(" "), ...(agent ? { agent } : {}) };
}

/** People by chat user id, from a JSON object in an environment variable. */
export function peopleFrom(json) {
  try {
    return JSON.parse(json ?? "{}");
  } catch {
    return {};
  }
}
