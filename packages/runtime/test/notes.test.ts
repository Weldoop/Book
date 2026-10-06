import { readFileSync } from "node:fs";
import { MockProvider } from "@book/llm";
import { ConfigSchema, type Config, type LLMProvider, type LLMRequest } from "@book/schema";
import { MemoryStore } from "@book/store";
import { describe, expect, it } from "vitest";
import { createRuntime, liftHiddenNotes, newGame, playTurn } from "../src/index.ts";

const config: Config = ConfigSchema.parse(
  JSON.parse(readFileSync(new URL("../../../configs/uk-life/config.json", import.meta.url), "utf8")),
);

function scripted(responses: Record<string, string[]>): LLMProvider & { calls: LLMRequest[] } {
  const inner = new MockProvider();
  const counters: Record<string, number> = {};
  const calls: LLMRequest[] = [];
  return {
    name: "scripted",
    calls,
    async complete(req) {
      calls.push(req);
      const list = responses[req.purpose];
      const i = counters[req.purpose] ?? 0;
      counters[req.purpose] = i + 1;
      const text = list?.[Math.min(i, list.length - 1)];
      const base = await inner.complete(req);
      return text === undefined ? base : { ...base, text };
    },
  };
}

async function setup(llm: LLMProvider, cfg: Config = config) {
  const store = new MemoryStore();
  const rt = createRuntime({ config: cfg, store, llm });
  await newGame(rt, "s1");
  return { rt, store };
}

const turnText = (over: Record<string, unknown>) =>
  JSON.stringify({ narration: "The kettle clicks off.", delta: [], beat: "Made tea.", ...over });

describe("liftHiddenNotes", () => {
  const draft = { narration: "", delta: [], beat: "b" };

  it("leaves an ordinary narration untouched", () => {
    const d = { ...draft, narration: "The kettle clicks off." };
    expect(liftHiddenNotes(d)).toBe(d);
  });

  it("pulls an inline hidden note out of the narration and into notes", () => {
    const out = liftHiddenNotes({ ...draft, narration: "Dai looks away. [HIDDEN: Dai broke the window]" });
    expect(out.narration).toBe("Dai looks away.");
    expect(out.notes).toEqual(["Dai broke the window"]);
  });

  it("handles several notes and keeps any the model also sent properly", () => {
    const out = liftHiddenNotes({
      ...draft,
      narration: "[hidden: one] Rain starts. [HIDDEN : two]",
      notes: ["already here"],
    });
    expect(out.narration).toBe("Rain starts.");
    expect(out.notes).toEqual(["already here", "one", "two"]);
  });
});

describe("private notes through a turn", () => {
  it("keeps the GM's notes in state and never puts them in the transcript", async () => {
    const llm = scripted({ turn: [turnText({ notes: ["Mrs Pugh is watching the garden"] })] });
    const { rt, store } = await setup(llm);
    const res = await playTurn(rt, "s1", "Put the kettle on");

    expect(res.narration).toBe("The kettle clicks off.");
    const state = await store.loadSave("s1");
    expect(state.notes).toEqual([{ turn: 1, text: "Mrs Pugh is watching the garden" }]);
    expect(JSON.stringify(state.window)).not.toContain("Mrs Pugh is watching");
    expect(JSON.stringify(state.beats)).not.toContain("Mrs Pugh is watching");
  });

  it("shows them back to the GM privately on the next turn", async () => {
    const llm = scripted({ turn: [turnText({ notes: ["Mrs Pugh is watching the garden"] }), turnText({})] });
    const { rt } = await setup(llm);
    await playTurn(rt, "s1", "Put the kettle on");
    await playTurn(rt, "s1", "Look out of the window");

    const second = llm.calls.filter((c) => c.purpose === "turn")[1];
    expect(JSON.stringify(second?.messages)).toContain("Mrs Pugh is watching the garden");
  });

  it("rescues a note the model wrote inline, so it cannot reach the player", async () => {
    const llm = scripted({
      turn: [JSON.stringify({ narration: "Dai shrugs. [HIDDEN: he took the tenner]", delta: [], beat: "Dai shrugged." })],
    });
    const { rt, store } = await setup(llm);
    const res = await playTurn(rt, "s1", "Ask Dai about the money");

    expect(res.narration).toBe("Dai shrugs.");
    expect(res.narration).not.toContain("HIDDEN");
    expect((await store.loadSave("s1")).notes[0]?.text).toBe("he took the tenner");
  });

  it("stores nothing when the game has notes switched off", async () => {
    const off = ConfigSchema.parse({ ...config, notes: { enabled: false } });
    const llm = scripted({ turn: [turnText({ notes: ["a secret"] })] });
    const { rt, store } = await setup(llm, off);
    await playTurn(rt, "s1", "Put the kettle on");
    expect((await store.loadSave("s1")).notes).toEqual([]);
  });
});

describe("scene boundaries through a turn", () => {
  it("records a close, reports it once, and opens the next scene on the next input", async () => {
    const llm = scripted({ turn: [turnText({ scene_ended: true }), turnText({})] });
    const { rt, store } = await setup(llm);

    const closing = await playTurn(rt, "s1", "Go up to bed");
    expect(closing.scene_ended).toBe(true);
    expect((await store.loadSave("s1")).scene).toEqual({ index: 1, started_turn: 0, closed: true, title: "Made tea" });

    const next = await playTurn(rt, "s1", "Get up and make tea");
    expect(next.scene_ended).toBeUndefined();
    expect((await store.loadSave("s1")).scene).toEqual({ index: 2, started_turn: 1, closed: false });
  });

  it("tells the GM which scene it is in and how long it has run", async () => {
    const llm = scripted({ turn: [turnText({ scene_ended: true }), turnText({}), turnText({})] });
    const { rt } = await setup(llm);
    await playTurn(rt, "s1", "Go up to bed");
    await playTurn(rt, "s1", "Get up");
    await playTurn(rt, "s1", "Make tea");

    const third = llm.calls.filter((c) => c.purpose === "turn")[2];
    expect(JSON.stringify(third?.messages)).toContain("Scene 2, running 1 turn");
  });

  it("compacts on a scene close instead of waiting for the beat ceiling", async () => {
    const eager = ConfigSchema.parse({ ...config, scenes: { min_beats: 2, max_beats: 50 } });
    const llm = scripted({
      turn: [turnText({}), turnText({ scene_ended: true }), turnText({})],
      compaction: [JSON.stringify({ chapter_summary: "Tea was made.", story_so_far: "You made tea.", facts: [], resolve_threads: [] })],
    });
    const { rt, store } = await setup(llm, eager);

    await playTurn(rt, "s1", "Put the kettle on");
    expect(llm.calls.some((c) => c.purpose === "compaction")).toBe(false);

    await playTurn(rt, "s1", "Go up to bed");
    expect(llm.calls.some((c) => c.purpose === "compaction")).toBe(true);
    expect((await store.loadSave("s1")).summaries.chapters).toEqual(["Tea was made."]);
  });
});
