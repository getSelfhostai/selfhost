// A Slack slash command bridge: `/selfhost acme/web fix the flaky login test`. It checks Slack's
// request signature, maps the Slack user to a selfhost person, and forwards the run to the
// server's signed webhook. The server then checks that person against [background] allowed.
//
//   SLACK_SIGNING_SECRET=... SELFHOST_SERVER=https://selfhost.example.com \
//   SELFHOST_WEBHOOK_SECRET=... SELFHOST_TEAM=web \
//   SLACK_PEOPLE='{"U012ABC": "alice@example.com"}' node slack.mjs
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { forwardRun, parseCommand, peopleFrom } from "./forward.mjs";

const people = peopleFrom(process.env.SLACK_PEOPLE);

function signedBySlack(headers, body) {
  const ts = headers["x-slack-request-timestamp"];
  const given = headers["x-slack-signature"];
  if (!ts || !given || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const secret = process.env.SLACK_SIGNING_SECRET ?? "";
  const expected = `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;
  return (
    expected.length === given.length && timingSafeEqual(Buffer.from(expected), Buffer.from(given))
  );
}

createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const reply = (text) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ response_type: "ephemeral", text }));
  };
  if (!signedBySlack(req.headers, body)) {
    res.writeHead(401);
    res.end();
    return;
  }
  const form = new URLSearchParams(body);
  const person = people[form.get("user_id") ?? ""];
  if (!person) return reply("You are not mapped to a selfhost person; ask an admin to add you.");
  const command = parseCommand(form.get("text") ?? "");
  if (!command) return reply("Usage: /selfhost [--agent codex] owner/name what to do");
  reply(
    await forwardRun({
      server: process.env.SELFHOST_SERVER ?? "",
      secret: process.env.SELFHOST_WEBHOOK_SECRET ?? "",
      team: process.env.SELFHOST_TEAM,
      sender: person,
      ref: `slack:${form.get("team_id")}/${form.get("channel_id")}`,
      ...command,
    }),
  );
}).listen(Number(process.env.PORT ?? 3010));
