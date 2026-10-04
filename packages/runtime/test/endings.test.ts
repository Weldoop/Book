import { readFileSync } from "node:fs";
import { MockProvider } from "@book/llm";
import { inventoryOf, statsOf } from "@book/modules";
import { ConfigSchema, type Config, type LLMProvider, type LLMRequest } from "@book/schema";
import { MemoryStore } from "@book/store";
import { describe, expect, it } from "vitest";
import { createRuntime, newGame, playTurn } from "../src/index.ts";

const config: Config = ConfigSchema.parse(
  JSON.parse(readFileSync(new URL("../../../configs/uk-life/config.json", import.meta.url), "utf8")),
);

/** uk-life with the arrest ending made final, so there is no way on from it. */
const finalConfig: Config = ConfigSchema.parse({
  ...config,
  endings: config.endings.map((e) => (e.id === "charged" ? { ...e, continue: undefined } : e)),
});

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

const draft = (delta: unknown[], narration = "Boots on the stairs.") =>
  JSON.stringify({ narration, delta, beat: "It went badly." });

async function setup(llm: LLMProvider, cfg: Config = config) {
  const store = new MemoryStore();
  const rt = createRuntime({ config: cfg, store, llm });
  await newGame(rt, "s1");
  return { rt, store };
}

/** Pushes legal jeopardy to its ceiling, which is what the `charged` ending watches. */
const commitACrime = draft([{ op: "stat.add", key: "jeopardy", amount: 100, reason: "weapon" }]);

describe("endings", () => {
  it("ends the story when a condition is met and offers the way on", async () => {
    const { rt, store } = await setup(scripted({ turn: [commitACrime] }));
    const res = await playTurn(rt, "s1", "Swing the shears at Dai");

    expect(res.outcome).toBe("ok");
    expect(res.narration).toBe("Boots on the stairs.");
    expect(res.ending?.id).toBe("charged");
    expect(res.ending?.title).toBe("Charged");
    expect(res.ending?.continuation).toContain("cell");

    const state = await store.loadSave("s1");
    expect(state.ending).toEqual({ id: "charged", turn: 1, continuable: true });
    expect(state.endings_seen).toEqual(["charged"]);
  });

  it("carries the story on from the next input, with the engine moving the player", async () => {
    const llm = scripted({ turn: [commitACrime, draft([])] });
    const { rt, store } = await setup(llm);
    await playTurn(rt, "s1", "Swing the shears at Dai");

    const res = await playTurn(rt, "s1", "Ask for the solicitor");
    expect(res.outcome).toBe("ok");
    expect(res.ending).toBeUndefined();

    const state = await store.loadSave("s1");
    expect(state.ending).toBeNull();
    expect(state.entities.player?.location).toBe("custody-suite");
    expect(statsOf(state).values.jeopardy).toBe(45);
    expect(inventoryOf(state).owners.player).toEqual({});
    // 600 minutes of continuation skip, then whatever the turn itself spent.
    expect(state.clock.now.startsWith("2026-10-03T19:")).toBe(true);
  });

  it("tells the GM where the new scene opens instead of making it guess", async () => {
    const llm = scripted({ turn: [commitACrime, draft([])] });
    const { rt } = await setup(llm);
    await playTurn(rt, "s1", "Swing the shears at Dai");
    await playTurn(rt, "s1", "Ask for the solicitor");

    const second = llm.calls.filter((c) => c.purpose === "turn")[1];
    const prompt = JSON.stringify(second?.messages);
    expect(prompt).toContain("Morning in the cells");
  });

  it("refuses to play on past a final ending and spends nothing doing it", async () => {
    const llm = scripted({ turn: [commitACrime] });
    const { rt, store } = await setup(llm, finalConfig);
    const ended = await playTurn(rt, "s1", "Swing the shears at Dai");
    expect(ended.ending?.continuation).toBeUndefined();

    const after = await playTurn(rt, "s1", "Get up and walk out");
    expect(after.outcome).toBe("ended");
    expect(after.narration).toContain("custody suite");
    expect(after.record.usage).toEqual([]);
    expect(llm.calls.filter((c) => c.purpose === "turn")).toHaveLength(1);

    const state = await store.loadSave("s1");
    expect(state.turn).toBe(1);
    expect(state.ending?.continuable).toBe(false);
  });

  it("leaves an ordinary turn untouched when no ending is configured", async () => {
    const plain = ConfigSchema.parse({ ...config, endings: [] });
    const { rt } = await setup(scripted({ turn: [commitACrime] }), plain);
    const res = await playTurn(rt, "s1", "Swing the shears at Dai");
    expect(res.ending).toBeUndefined();
    expect(res.outcome).toBe("ok");
  });
});
