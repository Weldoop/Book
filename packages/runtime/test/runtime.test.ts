import { readFileSync } from "node:fs";
import { MockProvider } from "@book/llm";
import { getActiveModules, statsOf } from "@book/modules";
import { ConfigSchema, type Config, type LLMProvider, type LLMRequest } from "@book/schema";
import { MemoryStore } from "@book/store";
import { describe, expect, it } from "vitest";
import { createRuntime, newGame, playTurn } from "../src/index.ts";

const config: Config = ConfigSchema.parse(JSON.parse(readFileSync(new URL("../../../configs/uk-life/config.json", import.meta.url), "utf8")));

async function setup(llm: LLMProvider, opts: { config?: Config; deltaFirst?: boolean } = {}) {
  const store = new MemoryStore();
  const rt = createRuntime({ config: opts.config ?? config, store, llm, ...(opts.deltaFirst ? { deltaFirst: true } : {}) });
  await newGame(rt, "s1");
  return { rt, store };
}

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

const draft = (delta: unknown[], narration = "Rain taps the window.") => JSON.stringify({ narration, delta, beat: "Something happened." });

describe("playTurn", () => {
  it("commits a valid turn and renders the status line in code", async () => {
    const { rt, store } = await setup(new MockProvider());
    const res = await playTurn(rt, "s1", "Look around");
    expect(res.outcome).toBe("ok");
    expect(res.turn).toBe(1);
    expect(res.status).toContain("£45.00");
    expect(res.record.usage).toHaveLength(1);
    const state = await store.loadSave("s1");
    expect(state.turn).toBe(1);
    expect(state.window).toHaveLength(1);
    expect(state.beats).toHaveLength(1);
  });

  it("repairs a fixable draft with a small delta call and never shows the interlude", async () => {
    const llm = scripted({
      turn: [draft([{ op: "clock.advance", minutes: "ten" }])],
      delta_repair: [JSON.stringify({ delta: [{ op: "clock.advance", minutes: 10 }], beat: "Fixed." })],
    });
    const { rt, store } = await setup(llm);
    const interludes: string[] = [];
    const res = await playTurn(rt, "s1", "Wait a bit", { onInterlude: (t) => interludes.push(t) });
    expect(res.outcome).toBe("repaired");
    expect(interludes).toEqual([]);
    expect(res.narration).toBe("Rain taps the window.");
    expect(llm.calls.map((c) => c.purpose)).toEqual(["turn", "delta_repair"]);
    expect((await store.loadSave("s1")).clock.now).toBe("2026-10-03T09:30");
  });

  it("rewrites a game-breaking draft behind a GM interlude and keeps the broken text out of history", async () => {
    const broken = draft([{ op: "stat.add", key: "money", amount: -500 }], "You buy a yacht.");
    const good = draft([{ op: "stat.add", key: "money", amount: -2 }], "You buy a bag of crisps.");
    const llm = scripted({ turn: [broken], rewrite_repair: [good] });
    const { rt, store } = await setup(llm);
    const interludes: string[] = [];
    const res = await playTurn(rt, "s1", "Buy a yacht", { onInterlude: (t) => interludes.push(t) });
    expect(res.outcome).toBe("rewritten");
    expect(interludes).toHaveLength(1);
    expect(config.gm_style.interludes).toContain(interludes[0]);
    expect(res.interlude).toBe(interludes[0]);
    expect(res.narration).toBe("You buy a bag of crisps.");

    const state = await store.loadSave("s1");
    expect(statsOf(state).values.money).toBe(43);
    expect(JSON.stringify(state)).not.toContain("You buy a yacht");
    expect(state.window[0]?.narration).toBe("You buy a bag of crisps.");
    const records = await store.readTurnRecords("s1");
    expect(records[0]?.attempts[0]?.violations[0]?.code).toBe("insufficient_funds");
    expect(JSON.stringify(records[0]?.attempts[0]?.draft)).toContain("yacht");
  });

  it("reformats unparseable output on the cheap tier with no GM interlude", async () => {
    const llm = scripted({ turn: ["<invoke>narration: Rain taps the window.</invoke>"], format_repair: [draft([])] });
    const { rt } = await setup(llm);
    const interludes: string[] = [];
    const res = await playTurn(rt, "s1", "Look around", { onInterlude: (t) => interludes.push(t) });
    expect(res.outcome).toBe("repaired");
    expect(interludes).toEqual([]);
    expect(res.interlude).toBeUndefined();
    expect(res.record.attempts[0]?.violations[0]?.code).toBe("unparseable");
    expect(res.record.attempts[1]?.kind).toBe("format_repair");
    expect(llm.calls.map((c) => [c.purpose, c.tier])).toEqual([["turn", "strong"], ["format_repair", "cheap"]]);
  });

  it("retries the original request when the model returned empty text", async () => {
    const llm = scripted({ turn: [""], format_repair: [draft([])] });
    const { rt } = await setup(llm);
    const interludes: string[] = [];
    const res = await playTurn(rt, "s1", "Look around", { onInterlude: (t) => interludes.push(t) });
    expect(res.outcome).toBe("repaired");
    expect(interludes).toEqual([]);
    expect(llm.calls.map((c) => [c.purpose, c.tier])).toEqual([["turn", "strong"], ["format_repair", "strong"]]);
  });

  it("rolls back with the GM note after two failed repairs and does not advance the turn", async () => {
    const bad = draft([{ op: "stat.add", key: "money", amount: -500 }], "Yacht.");
    const llm = scripted({ turn: [bad], rewrite_repair: [bad, bad] });
    const { rt, store } = await setup(llm);
    const res = await playTurn(rt, "s1", "Buy a yacht");
    expect(res.outcome).toBe("rolled_back");
    expect(res.narration).toBe(config.gm_style.rollback_note);
    expect(res.turn).toBe(0);
    const state = await store.loadSave("s1");
    expect(state.turn).toBe(0);
    expect(state.window).toEqual([]);
    expect(statsOf(state).values.money).toBe(45);
    expect(llm.calls.filter((c) => c.purpose === "rewrite_repair")).toHaveLength(2);
    const records = await store.readTurnRecords("s1");
    expect(records[0]?.outcome).toBe("rolled_back");
    expect(records[0]?.usage.length).toBe(3);
  });

  it("answers out-of-character questions without advancing the game", async () => {
    const llm = scripted({});
    const { rt, store } = await setup(llm);
    await playTurn(rt, "s1", "Look around");
    const res = await playTurn(rt, "s1", "OOC: what time is it?");
    expect(res.kind).toBe("ooc");
    expect(llm.calls.at(-1)?.purpose).toBe("ooc");
    expect(llm.calls.at(-1)?.tier).toBe("cheap");
    const state = await store.loadSave("s1");
    expect(state.turn).toBe(1);
    expect(state.window).toHaveLength(1);
  });

  it("treats '...' as a continue turn", async () => {
    const { rt } = await setup(new MockProvider());
    const res = await playTurn(rt, "s1", "...");
    expect(res.kind).toBe("continue");
    expect(res.outcome).toBe("ok");
  });

  it("is deterministic: the same inputs and model replies give identical state", async () => {
    const run = async () => {
      const { rt, store } = await setup(new MockProvider());
      for (const input of ["Look around", "...", "Go to the kitchen", "OOC: where am I?", "Make tea"]) await playTurn(rt, "s1", input);
      const state = await store.loadSave("s1");
      return state;
    };
    expect(await run()).toEqual(await run());
  });

  it("compacts memory every 20 beats and keeps the context flat", async () => {
    const { rt, store } = await setup(new MockProvider());
    const inputTokens: number[] = [];
    for (let i = 0; i < 45; i++) {
      const res = await playTurn(rt, "s1", `Do thing number ${i}`);
      const turnCall = res.record.usage.find((u) => u.purpose === "turn");
      inputTokens.push(turnCall?.input_tokens ?? 0);
    }
    const state = await store.loadSave("s1");
    expect(state.summaries.last_compacted_turn).toBeGreaterThanOrEqual(20);
    expect(state.summaries.chapters.length).toBeGreaterThanOrEqual(1);
    expect(state.window.length).toBeLessThanOrEqual(12);
    const early = inputTokens[10] ?? 0;
    const late = inputTokens[44] ?? 0;
    expect(late).toBeLessThan(early * 1.6);
  });

  it("injected faults never put unvalidated text in the transcript", async () => {
    const llm = new MockProvider({ faults: { every: 3, kind: "game_breaking" } });
    const { rt, store } = await setup(llm);
    const outcomes: string[] = [];
    for (let i = 0; i < 12; i++) outcomes.push((await playTurn(rt, "s1", `Action ${i}`)).outcome);
    expect(outcomes.filter((o) => o === "rewritten")).toHaveLength(4);
    const state = await store.loadSave("s1");
    expect(JSON.stringify(state)).not.toContain("mock fault");
    expect(statsOf(state).values.money).toBe(45);
  });

  it("supports a game with different modules (pirate config)", async () => {
    const pirate = ConfigSchema.parse(JSON.parse(readFileSync(new URL("../../../configs/pirate/config.json", import.meta.url), "utf8")));
    expect(() => getActiveModules(pirate)).not.toThrow();
    const { rt } = await setup(new MockProvider(), { config: pirate });
    const res = await playTurn(rt, "s1", "Check the rigging");
    expect(res.outcome).toBe("ok");
    expect(res.panel.length).toBeGreaterThan(0);
  });
});
