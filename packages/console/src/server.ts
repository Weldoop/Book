import { createServer } from "node:http";
import { serve } from "./http.ts";

const port = Number(process.env.PORT ?? 3000);
const host = "0.0.0.0";

const server = createServer((req, res) => {
  serve(req, res, { env: process.env }).catch(() => {
    if (res.headersSent) return;
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "The storyteller is unavailable right now." }));
  });
});

server.listen(port, host, () => {
  process.stdout.write(`book console at http://localhost:${port}\n`);
});
