// The sample web app the proof receipt is tested on: static pages on PORT, and /health.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { greet } from "./src/greet.mjs";

const pages = { "/": "pages/index.html", "/about": "pages/about.html" };

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (path === "/health") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  const page = pages[path];
  if (!page) {
    res.writeHead(404, { "content-type": "text/html" }).end("<h1>Not found</h1>");
    return;
  }
  const html = await readFile(new URL(page, import.meta.url), "utf8");
  res.writeHead(200, { "content-type": "text/html" }).end(html.replace("{{greeting}}", greet("receipt")));
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, "127.0.0.1", () => console.log(`sample app listening on ${server.address().port}`));
