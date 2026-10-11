import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { MockProvider } from "@book/llm";
import type { LLMProvider, PresentationProfile } from "@book/schema";
import type { TurnResult } from "@book/runtime";
import { findGame, handleTurn, listGames, newSaveId, presentTurn, readSettings, route, serve, tokenOk } from "../src/index.ts";

function throwing(): LLMProvider {
  return {
    name: "mock",
    complete: () => {
      throw new Error("the model should not have been called");
    },
  };
}

function result(over: Partial<TurnResult> = {}): TurnResult {
  return {
    turn: 1,
    kind: "act",
    narration: "The tide turns.",
    status: "4 gold",
    panel: ["Gold: 4"],
    outcome: "ok",
    notices: ["Low on powder."],
    suggestions: [" sail ", ""],
    highlights: ["tide"],
    record: {
      turn: 1,
      kind: "act",
      input: "go",
      narration: "The tide turns.",
      beat: null,
      delta: [],
      due: [],
      attempts: [],
      outcome: "ok",
      context_parts: [],
      usage: [
        {
          model: "mock",
          input_tokens: 10,
          output_tokens: 4,
          cached_input_tokens: 0,
          cost_usd: 0.01,
          latency_ms: 5,
          purpose: "turn",
        },
      ],
      at: "2026-01-01T00:00:00.000Z",
    },
    ...over,
  };
}

describe("presentTurn", () => {
  it("prints the roll, the story, the status and the usage, and offers stay out of the scrollback", () => {
    const shown = presentTurn(
      result({ roll: { value: 12, band: "Success", what: "the crossing" }, interlude: "The chart slips." }),
      { profile: "light", wallMs: 1200 },
    );
    const text = shown.lines.map((line) => line.text).join("\n");
    expect(text).toContain("Fate 12 - Success (the crossing)");
    expect(text).toContain("The chart slips.");
    expect(text).toContain("**tide**");
    expect(shown.lines.find((line) => line.kind === "status")?.text).toBe("4 gold");
    expect(text).not.toContain("Gold: 4");
    expect(text).toContain("Low on powder.");
    expect(text).toMatch(/\[in 10  out 4  cached 0  \$0\.0100  1\.2s  ok\]/);
    expect(shown.suggestions).toEqual(["sail"]);
    expect(text).not.toContain("[ sail ]");
    expect(shown.ended).toBe(false);
  });

  it("includes the tabletop panel and tells a closed story to use /new", () => {
    const panel = presentTurn(result(), { profile: "tabletop" as PresentationProfile, wallMs: 10 });
    expect(panel.lines.map((line) => line.text)).toContain("  Gold: 4");

    const closed = presentTurn(
      result({
        outcome: "ok",
        ending: { id: "rope", title: "The Rope", text: "The story closes." },
        record: { ...result().record, usage: [] },
      }),
      { profile: "light", wallMs: 1 },
    );
    const text = closed.lines.map((line) => line.text).join("\n");
    expect(text).toContain("--- The Rope ---");
    expect(text).toContain("This story is over. /new to leave it here.");
    expect(text).not.toContain("/quit");
    expect(text).not.toMatch(/\[in /);
    expect(closed.ended).toBe(true);
  });
});

describe("handleTurn", () => {
  it("opens a book and continues from the save the browser would send back", async () => {
    const started = await handleTurn({ game: "uk-life" }, { llm: new MockProvider(), maxCostUsd: 2, newSaveId: () => "phonetest" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.title).toBe("Uplands: A Student Life");
    expect(started.state.save_id).toBe("phonetest");
    expect(started.state.config_id).toBe("uk-life");
    expect(started.state.turn).toBeGreaterThanOrEqual(1);
    expect(started.lines.some((line) => line.kind === "story" && line.text.trim().length > 0)).toBe(true);
    expect(started.lines.some((line) => line.kind === "status")).toBe(true);
    expect(started.lines.map((line) => line.text).join("\n")).toContain("/new starts over");
    expect(started.spentUsd).toBeGreaterThan(0);

    const round = JSON.parse(JSON.stringify(started.state)) as typeof started.state;
    const next = await handleTurn(
      { game: "uk-life", state: round, input: "whistle softly", spentUsd: started.spentUsd },
      { llm: new MockProvider(), maxCostUsd: 2 },
    );
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.state.turn).toBeGreaterThan(started.state.turn);
    expect(next.lines.map((line) => line.text).join("\n")).toContain("whistle softly");
    expect(next.spentUsd).toBeGreaterThan(started.spentUsd);
  });

  it("opens the pirate book on the tabletop profile", async () => {
    const started = await handleTurn({ game: "pirate" }, { llm: new MockProvider(), maxCostUsd: 2, newSaveId: () => "phoneship" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.title).toBe("Black Water Reckoning");
    expect(started.lines.some((line) => line.kind === "note" && line.text.startsWith("  "))).toBe(true);
  });

  it("does not call the model for a bad game, a bad save, a long line, /new, or a spent cap", async () => {
    const llm = throwing();
    const unknown = await handleTurn({ game: "nope" }, { llm, maxCostUsd: 2 });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.error).toContain("uk-life");

    const corrupt = await handleTurn({ game: "uk-life", state: { turn: 1 } }, { llm, maxCostUsd: 2 });
    expect(corrupt.ok).toBe(false);

    const started = await handleTurn({ game: "uk-life" }, { llm: new MockProvider(), maxCostUsd: 2, newSaveId: () => "phonecap" });
    if (!started.ok) throw new Error("setup turn failed");

    const wrongGame = await handleTurn({ game: "pirate", state: started.state, input: "hello" }, { llm, maxCostUsd: 2 });
    expect(wrongGame.ok).toBe(false);
    if (!wrongGame.ok) expect(wrongGame.error).toContain("uk-life");

    const long = await handleTurn({ game: "uk-life", state: started.state, input: "a".repeat(2001) }, { llm, maxCostUsd: 2 });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.state?.turn).toBe(started.state.turn);

    const slash = await handleTurn({ game: "uk-life", state: started.state, input: "/new" }, { llm, maxCostUsd: 2 });
    expect(slash.ok).toBe(false);

    const capped = await handleTurn(
      { game: "uk-life", state: started.state, input: "hello", spentUsd: 2 },
      { llm, maxCostUsd: 2 },
    );
    expect(capped.ok).toBe(false);
    if (!capped.ok) {
      expect(capped.error).toContain("intact");
      expect(capped.state?.save_id).toBe("phonecap");
    }
  });

  it("treats a blank line as continue", async () => {
    const started = await handleTurn({ game: "uk-life" }, { llm: new MockProvider(), maxCostUsd: 2, newSaveId: () => "phoneblank" });
    if (!started.ok) throw new Error("setup turn failed");
    const next = await handleTurn(
      { game: "uk-life", state: started.state, input: "   " },
      { llm: new MockProvider(), maxCostUsd: 2 },
    );
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.state.turn).toBeGreaterThan(started.state.turn);
  });
});

describe("save ids and the game catalog", () => {
  it("mints a safe save id and clones configs", () => {
    expect(newSaveId(new Date("2026-01-02T03:04:05.000Z"))).toMatch(/^phone20260102030405[0-9a-f]{6}$/);
    const game = findGame("uk-life");
    expect(game?.meta.title).toBe("Uplands: A Student Life");
    if (!game) return;
    game.meta.title = "changed";
    expect(findGame("uk-life")?.meta.title).toBe("Uplands: A Student Life");
    expect(findGame("missing")).toBeUndefined();
  });
});

describe("console http", () => {
  it("lists the games and serves the page", async () => {
    expect(listGames().map((game) => game.id)).toEqual(["uk-life", "pirate"]);
    const info = await route({ method: "GET", url: "/api/turn", headers: {}, body: "", env: {} });
    expect(info.status).toBe(200);
    const body = JSON.parse(info.body) as { provider: string; maxCostUsd: number; needsToken: boolean; games: { title: string }[] };
    expect(body.provider).toBe("mock");
    expect(body.maxCostUsd).toBe(5);
    expect(body.needsToken).toBe(false);
    expect(body.games[0]?.title).toBe("Uplands: A Student Life");

    const page = await route({ method: "GET", url: "/", headers: {}, body: "", env: {} });
    expect(page.status).toBe(200);
    expect(page.contentType).toContain("text/html");
    expect(page.body).toContain("What you do");
    expect(page.body).toContain("/api/turn");

    const missing = await route({ method: "GET", url: "/nope", headers: {}, body: "", env: {} });
    expect(missing.status).toBe(404);
  });

  it("rejects a bad token, a huge body and a real provider with no key", async () => {
    expect(tokenOk(undefined, undefined)).toBe(true);
    expect(tokenOk("Bearer secret", "secret")).toBe(true);
    expect(tokenOk("Bearer no", "secret")).toBe(false);
    expect(tokenOk("secret", "secret")).toBe(false);
    expect(tokenOk("Bearer tiny", "much-longer-token")).toBe(false);

    const denied = await route({
      method: "POST",
      url: "/api/turn/",
      headers: { authorization: "Bearer no" },
      body: JSON.stringify({ game: "uk-life" }),
      env: { BOOK_CONSOLE_TOKEN: "secret", BOOK_PROVIDER: "mock" },
    });
    expect(denied.status).toBe(401);

    const huge = await route({
      method: "POST",
      url: "/api/turn",
      headers: {},
      body: JSON.stringify({ game: "uk-life" }),
      env: { BOOK_PROVIDER: "mock" },
      maxBodyBytes: 8,
    });
    expect(huge.status).toBe(413);

    const bad = await route({
      method: "POST",
      url: "/api/turn",
      headers: {},
      body: "{",
      env: { BOOK_PROVIDER: "mock" },
    });
    expect(bad.status).toBe(400);

    const key = await route({
      method: "POST",
      url: "/api/turn",
      headers: {},
      body: JSON.stringify({ game: "uk-life" }),
      env: { BOOK_PROVIDER: "anthropic" },
    });
    expect(key.status).toBe(500);
    expect(key.body).toContain("ANTHROPIC_API_KEY");
  });

  it("plays one mock turn through the HTTP route", async () => {
    const res = await route({
      method: "POST",
      url: "https://book.example/api/turn?x=1",
      headers: { authorization: "Bearer secret" },
      body: JSON.stringify({ game: "uk-life" }),
      env: { BOOK_PROVIDER: "mock", BOOK_CONSOLE_TOKEN: "secret", BOOK_MAX_COST_USD: "3" },
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; title: string; state: { turn: number } };
    expect(body.ok).toBe(true);
    expect(body.title).toBe("Uplands: A Student Life");
    expect(body.state.turn).toBeGreaterThanOrEqual(1);
  });

  it("serves the page and a turn on a real socket", async () => {
    const server = createServer((req, res) => {
      void serve(req, res, { env: { BOOK_PROVIDER: "mock" } });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    try {
      const page = await fetch(`http://127.0.0.1:${address.port}/`);
      expect(page.headers.get("cache-control")).toBe("no-store");
      expect(await page.text()).toContain("What you do");
      const turn = await fetch(`http://127.0.0.1:${address.port}/api/turn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ game: "uk-life" }),
      });
      const body = (await turn.json()) as { ok: boolean; state: { turn: number } };
      expect(turn.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.state.turn).toBeGreaterThanOrEqual(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it("reads provider and cap settings", () => {
    expect(readSettings({})).toEqual({ provider: "mock", maxCostUsd: 5 });
    expect(readSettings({ ANTHROPIC_API_KEY: "k" }).provider).toBe("anthropic");
    expect(readSettings({ ANTHROPIC_API_KEY: "k", BOOK_PROVIDER: "mock" }).provider).toBe("mock");
    expect(readSettings({ BOOK_MAX_COST_USD: "0.5", BOOK_CONSOLE_TOKEN: "  t  " })).toEqual({
      provider: "mock",
      maxCostUsd: 0.5,
      token: "t",
    });
    expect(() => readSettings({ BOOK_PROVIDER: "openai" })).toThrow(/mock or anthropic/);
    expect(() => readSettings({ BOOK_MAX_COST_USD: "-1" })).toThrow(/BOOK_MAX_COST_USD/);
  });
});
