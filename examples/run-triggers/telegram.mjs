// A Telegram bot bridge: `/run acme/web fix the flaky login test` in a chat with the bot. Telegram
// calls this webhook with the secret token set by setWebhook; the sender's Telegram user id is
// mapped to a selfhost person and the run is forwarded to the server's signed webhook.
//
//   TELEGRAM_BOT_TOKEN=... TELEGRAM_SECRET_TOKEN=... SELFHOST_SERVER=https://selfhost.example.com \
//   SELFHOST_WEBHOOK_SECRET=... SELFHOST_TEAM=web \
//   TELEGRAM_PEOPLE='{"123456789": "alice@example.com"}' node telegram.mjs
import { createServer } from "node:http";
import { forwardRun, parseCommand, peopleFrom } from "./forward.mjs";

const people = peopleFrom(process.env.TELEGRAM_PEOPLE);

async function say(chat, text) {
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text }),
  });
}

createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (req.headers["x-telegram-bot-api-secret-token"] !== process.env.TELEGRAM_SECRET_TOKEN) {
    res.writeHead(401);
    res.end();
    return;
  }
  res.writeHead(200);
  res.end();
  const message = JSON.parse(body || "{}").message;
  const text = message?.text ?? "";
  if (!text.startsWith("/run")) return;
  const chat = message.chat.id;
  const person = people[String(message.from?.id)];
  if (!person)
    return say(chat, "You are not mapped to a selfhost person; ask an admin to add you.");
  const command = parseCommand(text.slice(4));
  if (!command) return say(chat, "Usage: /run [--agent codex] owner/name what to do");
  await say(
    chat,
    await forwardRun({
      server: process.env.SELFHOST_SERVER ?? "",
      secret: process.env.SELFHOST_WEBHOOK_SECRET ?? "",
      team: process.env.SELFHOST_TEAM,
      sender: person,
      ref: `telegram:${chat}/${message.message_id}`,
      ...command,
    }),
  );
}).listen(Number(process.env.PORT ?? 3011));
