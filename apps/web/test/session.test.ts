import { describe, expect, it } from "vitest";
import { MockProvider } from "@book/llm";
import type { LLMProvider, LLMRequest } from "@book/schema";
import { MemoryPlayDb } from "../server/lib/memory-db.ts";
import { library, openGame, readSave, redoTurn, takeTurn } from "../server/lib/session.ts";
import { capMessage, debugFromRecord, PERSON_CAP_USD, richText } from "../shared/play.ts";

function scripted(): MockProvider {
  return new MockProvider({
    script: (req: LLMRequest) => {
      if (req.purpose !== "turn" && req.purpose !== "opening") return undefined;
      const raw = req.messages.at(-1)?.content ?? "";
      const marker = raw.includes("goodbye") ? "goodbye" : raw.includes("hello") ? "hello" : "open";
      return JSON.stringify({
        narration: `Marker ${marker}.`,
        delta: [{ op: "clock.advance", minutes: 5 }],
        beat: "A quiet minute.",
      });
    },
  });
}

describe("cap", () => {
  it("stops at five dollars and leaves the wording for the player", () => {
    expect(capMessage(4.99)).toBeNull();
    expect(capMessage(PERSON_CAP_USD)).toMatch(/\$5/);
    expect(capMessage(PERSON_CAP_USD)).toMatch(/intact/);
  });

  it("refuses a new book once the account has spent the cap", async () => {
    const db = new MemoryPlayDb();
    await db.charge("ada", null, 5);
    const result = await openGame(db, "ada", "uk-life", scripted());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(402);
    expect(await db.list("ada")).toEqual([]);
  });
});

describe("debug view", () => {
  it("keeps context size and violations, and drops draft text", () => {
    const view = debugFromRecord(1.25, {
      turn: 4,
      outcome: "repaired",
      usage: [
        { input_tokens: 5000, output_tokens: 200, cached_input_tokens: 2000, cost_usd: 0.01 },
        { input_tokens: 800, output_tokens: 40, cached_input_tokens: 0, cost_usd: 0.002 },
      ],
      context_parts: [{ name: "notes", tokens: 12, trimmed: false }],
      attempts: [
        {
          kind: "draft",
          violations: [{ severity: "fixable", code: "clock", message: "The clock jumped." }],
          draft: { notes: ["GM SECRET about the inspection"] },
          raw: "GM SECRET raw",
        },
      ],
    });
    const dumped = JSON.stringify(view);
    expect(dumped).not.toContain("GM SECRET");
    expect(view.parts).toEqual([{ name: "notes", tokens: 12, trimmed: false }]);
    expect(view.calls).toBe(2);
    expect(view.inputTokens).toBe(5800);
    expect(view.repairs[0]?.violations[0]?.code).toBe("clock");
    expect(view.spentUsd).toBe(1.25);
  });
});

describe("a played save", () => {
  it("opens a book, replaces the last line without refunding it, and hides notes", async () => {
    const db = new MemoryPlayDb();
    const opened = await openGame(db, "ada", "uk-life", scripted());
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.view.title).toMatch(/Uplands/);
    expect(opened.view.lines.some((line) => line.kind === "player")).toBe(false);
    expect(JSON.stringify(opened.view)).not.toContain("GM SECRET");

    const first = await takeTurn(db, "ada", opened.view.id, "hello there", scripted());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.view.lines.some((line) => line.kind === "player" && line.text === "hello there")).toBe(true);
    expect(first.view.lines.some((line) => line.text.includes("Marker hello"))).toBe(true);

    const replaced = await redoTurn(db, "ada", opened.view.id, "goodbye then", scripted());
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    const players = replaced.view.lines.filter((line) => line.kind === "player").map((line) => line.text);
    expect(players).toEqual(["goodbye then"]);
    expect(replaced.view.lines.some((line) => line.text.includes("Marker goodbye"))).toBe(true);
    expect(replaced.view.lines.some((line) => line.text.includes("Marker hello"))).toBe(false);
    expect(replaced.view.spentUsd).toBeGreaterThan(first.view.spentUsd);

    const again = await redoTurn(db, "ada", opened.view.id, "hello there", new MockProvider());
    expect(again.ok).toBe(true);

    const fresh = new MemoryPlayDb();
    const onlyOpen = await openGame(fresh, "ada", "uk-life", scripted());
    if (!onlyOpen.ok) throw new Error(onlyOpen.error);
    const noLine = await redoTurn(fresh, "ada", onlyOpen.view.id, "hello", scripted());
    expect(noLine.ok).toBe(false);
    if (!noLine.ok) expect(noLine.error).toMatch(/no line to edit/);

    const books = await library(fresh, "ada");
    expect(books.games.map((game) => game.id)).toEqual(["uk-life", "pirate"]);
  });

  it("keeps the last line when a redo fails", async () => {
    const db = new MemoryPlayDb();
    const opened = await openGame(db, "ada", "uk-life", scripted());
    if (!opened.ok) throw new Error(opened.error);
    const first = await takeTurn(db, "ada", opened.view.id, "hello there", scripted());
    if (!first.ok) throw new Error(first.error);
    const spent = first.view.spentUsd;
    const down: LLMProvider = {
      name: "down",
      complete() {
        return Promise.reject(new Error("provider down"));
      },
    };
    const failed = await redoTurn(db, "ada", opened.view.id, "goodbye then", down);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.status).toBe(500);
    const still = await readSave(db, "ada", opened.view.id);
    expect(still.ok).toBe(true);
    if (!still.ok) return;
    const players = still.view.lines.filter((line) => line.kind === "player").map((line) => line.text);
    expect(players).toEqual(["hello there"]);
    expect(still.view.spentUsd).toBe(spent);

    const stranger = await readSave(db, "bea", opened.view.id);
    expect(stranger.ok).toBe(false);
    if (!stranger.ok) expect(stranger.status).toBe(404);
  });

  it("rejects an unknown book", async () => {
    const result = await openGame(new MemoryPlayDb(), "ada", "nope", scripted());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });
});

describe("rich text", () => {
  it("splits bold names out of the narration", () => {
    expect(richText("You see **Tomos** wave.")).toEqual([
      { bold: false, text: "You see " },
      { bold: true, text: "Tomos" },
      { bold: false, text: " wave." },
    ]);
  });
});
