import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createProvider } from "@book/llm";
import type { LLMProvider } from "@book/schema";
import { listGames } from "./games.ts";
import { readLatestSession, sessionLogFromEnv } from "./log.ts";
import { handleTurn } from "./turn.ts";
import type { TurnBody } from "./turn.ts";

export const MAX_BODY_BYTES = 1_500_000;

export interface ConsoleSettings {
  provider: "mock" | "anthropic";
  maxCostUsd: number;
  token?: string;
}

export interface RouteRequest {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  body: string;
  env: Record<string, string | undefined>;
  page?: string;
  llm?: LLMProvider;
  maxBodyBytes?: number;
}

export interface RouteResult {
  status: number;
  contentType: string;
  body: string;
}

const JSON_TYPE = "application/json; charset=utf-8";

/** Sync never calls the model. This stands in when the route was not given one. */
function idleLlm(): LLMProvider {
  return {
    name: "mock",
    complete: () => {
      throw new Error("sync does not call the storyteller");
    },
  };
}

export function readSettings(env: Record<string, string | undefined>): ConsoleSettings {
  const rawProvider = env.BOOK_PROVIDER?.trim();
  const key = env.ANTHROPIC_API_KEY?.trim();
  let provider: ConsoleSettings["provider"];
  if (rawProvider === undefined || rawProvider === "") provider = key ? "anthropic" : "mock";
  else if (rawProvider === "mock" || rawProvider === "anthropic") provider = rawProvider;
  else throw new Error(`Unknown BOOK_PROVIDER "${rawProvider}". Use mock or anthropic.`);

  const capRaw = env.BOOK_MAX_COST_USD?.trim();
  const maxCostUsd = capRaw === undefined || capRaw === "" ? 5 : Number(capRaw);
  if (!Number.isFinite(maxCostUsd) || maxCostUsd < 0) {
    throw new Error("BOOK_MAX_COST_USD must be a number >= 0.");
  }
  const token = env.BOOK_CONSOLE_TOKEN?.trim();
  return { provider, maxCostUsd, ...(token ? { token } : {}) };
}

export function tokenOk(authorization: string | undefined, expected: string | undefined): boolean {
  if (!expected) return true;
  const match = /^Bearer\s+(\S+)\s*$/.exec(authorization ?? "");
  const got = match?.[1] ?? "";
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function pathOf(url: string): string {
  try {
    const parsed = url.startsWith("http") ? new URL(url) : new URL(url, "http://localhost");
    const path = parsed.pathname;
    return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  } catch {
    return "/";
  }
}

function json(status: number, body: unknown): RouteResult {
  return { status, contentType: JSON_TYPE, body: JSON.stringify(body) };
}

function pageHtml(override?: string): string {
  return override ?? readFileSync(new URL("./page.html", import.meta.url), "utf8");
}

export async function route(req: RouteRequest): Promise<RouteResult> {
  const method = req.method.toUpperCase();
  const path = pathOf(req.url);
  if ((method === "GET" || method === "HEAD") && (path === "/" || path === "/index.html")) {
    const html = pageHtml(req.page);
    return { status: 200, contentType: "text/html; charset=utf-8", body: method === "HEAD" ? "" : html };
  }
  if (path === "/api/resume" && (method === "GET" || method === "HEAD")) {
    let settings: ConsoleSettings;
    try {
      settings = readSettings(req.env);
    } catch (err) {
      return json(500, { ok: false, error: err instanceof Error ? err.message : "The console is not configured." });
    }
    if (!tokenOk(req.headers.authorization, settings.token)) return json(401, { ok: false, error: "Wrong token." });
    const root = req.env.BOOK_CONSOLE_LOG?.trim();
    const session = root ? await readLatestSession(root) : null;
    return { status: 200, contentType: JSON_TYPE, body: method === "HEAD" ? "" : JSON.stringify({ ok: true, session }) };
  }
  if (path !== "/api/turn") return { status: 404, contentType: "text/plain; charset=utf-8", body: "Not found\n" };

  let settings: ConsoleSettings;
  try {
    settings = readSettings(req.env);
  } catch (err) {
    return json(500, { ok: false, error: err instanceof Error ? err.message : "The console is not configured." });
  }

  if (method === "GET" || method === "HEAD") {
    return json(200, {
      ok: true,
      games: listGames(),
      needsToken: Boolean(settings.token),
      provider: settings.provider,
      maxCostUsd: settings.maxCostUsd,
    });
  }
  if (method !== "POST") return json(405, { ok: false, error: "Send a line with POST." });
  if (!tokenOk(req.headers.authorization, settings.token)) return json(401, { ok: false, error: "Wrong token." });

  const maxBody = req.maxBodyBytes ?? MAX_BODY_BYTES;
  if (Buffer.byteLength(req.body) > maxBody) {
    return json(413, { ok: false, error: "That request is too large. /new starts again." });
  }

  let body: TurnBody;
  try {
    const parsed = req.body.trim() === "" ? {} : JSON.parse(req.body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return json(400, { ok: false, error: "Send a JSON object." });
    }
    body = parsed as TurnBody;
  } catch {
    return json(400, { ok: false, error: "That was not JSON." });
  }

  try {
    const log = sessionLogFromEnv(req.env);
    const llm =
      body.sync === true ? (req.llm ?? idleLlm()) : (req.llm ?? createProvider(settings.provider, req.env));
    const result = await handleTurn(body, { llm, maxCostUsd: settings.maxCostUsd, ...(log ? { log } : {}) });
    return json(200, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "The storyteller is unavailable right now.";
    return json(500, { ok: false, error: message });
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

class BodyTooLarge extends Error {
  constructor() {
    super("too large");
    this.name = "BodyTooLarge";
  }
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > maxBytes) {
        reject(new BodyTooLarge());
        req.resume();
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function serve(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { env: Record<string, string | undefined>; llm?: LLMProvider; page?: string },
): Promise<void> {
  try {
    const body = await readBody(req, MAX_BODY_BYTES);
    const result = await route({
      method: req.method ?? "GET",
      url: req.url ?? "/",
      headers: { authorization: header(req, "authorization") },
      body,
      env: opts.env,
      ...(opts.page !== undefined ? { page: opts.page } : {}),
      ...(opts.llm ? { llm: opts.llm } : {}),
    });
    res.statusCode = result.status;
    res.setHeader("content-type", result.contentType);
    res.setHeader("cache-control", "no-store");
    res.end(result.body);
  } catch (err) {
    const tooLarge = err instanceof BodyTooLarge;
    res.statusCode = tooLarge ? 413 : 500;
    res.setHeader("content-type", JSON_TYPE);
    res.setHeader("cache-control", "no-store");
    const message = tooLarge
      ? "That request is too large. /new starts again."
      : "The storyteller is unavailable right now.";
    res.end(JSON.stringify({ ok: false, error: message }));
  }
}
