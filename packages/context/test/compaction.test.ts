import { estimateTokens, type State } from "@book/schema";
import { describe, expect, it } from "vitest";
import {
  applyCompaction,
  buildCompactionRequest,
  parseCompactionResult,
  shouldCompact,
  type CompactionResult,
} from "../src/index.ts";
import { makeBigState, makeConfig, makeEntity, makeState, makeThread, statsModule } from "./fixtures.ts";

const config = makeConfig();

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

const good: CompactionResult = {
  chapter_summary: "You settled in and borrowed a mower.",
  story_so_far: "You moved to town. You borrowed a mower from Glenys.",
  facts: [],
  resolve_threads: [],
};

describe("shouldCompact", () => {
  const beats = (n: number, from = 1) => Array.from({ length: n }, (_, i) => ({ turn: from + i, text: "b" }));
  const closed = { index: 1, started_turn: 0, closed: true };

  it("holds off mid-scene until the backstop, so a chapter is never cut in half", () => {
    expect(shouldCompact(makeState({ beats: beats(19) }), config)).toBe(false);
    expect(shouldCompact(makeState({ beats: beats(20) }), config)).toBe(true);
  });

  it("compacts as soon as the GM closes a scene, once there is enough to compact", () => {
    expect(shouldCompact(makeState({ beats: beats(7), scene: closed }), config)).toBe(false);
    expect(shouldCompact(makeState({ beats: beats(8), scene: closed }), config)).toBe(true);
  });

  it("takes the thresholds from the config", () => {
    const eager = makeConfig({ scenes: { min_beats: 2, max_beats: 5, keep_scene_turns: 12 } });
    expect(shouldCompact(makeState({ beats: beats(2), scene: closed }), eager)).toBe(true);
    expect(shouldCompact(makeState({ beats: beats(5) }), eager)).toBe(true);
  });

  it("ignores beats already compacted", () => {
    const s = makeState({ beats: beats(30), summaries: { chapters: [], story_so_far: "", last_compacted_turn: 15 } });
    expect(shouldCompact(s, config)).toBe(false);
  });

  it("skips the beat-ceiling retry after a failed chapter write, but still compacts a scene the GM closed", () => {
    const summaries = { chapters: [], story_so_far: "", last_compacted_turn: 0, compaction_hold_until: 15 };
    const held = makeState({ turn: 10, beats: beats(20), summaries });
    expect(shouldCompact(held, config)).toBe(false);
    expect(shouldCompact(makeState({ turn: 15, beats: beats(20), summaries }), config)).toBe(true);
    expect(shouldCompact(makeState({ turn: 10, beats: beats(20), summaries, scene: closed }), config)).toBe(true);
  });
});

describe("buildCompactionRequest", () => {
  it("is cheap-tier input with story, beats, threads and touched entity facts", () => {
    const state = makeState({
      turn: 30,
      summaries: { chapters: [], story_so_far: "Old story.", last_compacted_turn: 10 },
      beats: [
        { turn: 5, text: "OLD-BEAT" },
        { turn: 12, text: "NEW-BEAT" },
      ],
      threads: [makeThread({ id: "t7", text: "Return the mower" })],
    });
    state.entities.glenys = makeEntity({
      ...(state.entities.glenys as ReturnType<typeof makeEntity>),
      last_touched: 12,
    });
    const req = buildCompactionRequest({ config, state, modules: [statsModule] });
    const text = req.messages[0]?.content ?? "";
    expect(text).toContain("Old story.");
    expect(text).toContain("NEW-BEAT");
    expect(text).not.toContain("OLD-BEAT");
    expect(text).toContain("t7");
    expect(text).toContain("Glenys [glenys]");
    expect(text).not.toContain("Dai [dai]");
    const sys = req.system[0]?.text ?? "";
    for (const k of ["chapter_summary", "story_so_far", "facts", "resolve_threads", "80 words", "160 words", "running jokes", "favours owed", "promises", "nicknames"]) {
      expect(sys).toContain(k);
    }
    expect(req.total_tokens).toBe(req.parts.reduce((n, p) => n + p.tokens, 0));
  });

  it("shows the live balances and forbids copying them or an unused nickname", () => {
    const req = buildCompactionRequest({ config, state: makeState(), modules: [statsModule] });
    const text = req.messages[0]?.content ?? "";
    expect(text).toContain("45.00");
    expect(text).toContain("Do not copy these balances");
    expect(text).toContain("The Flat");
    const sys = req.system[0]?.text ?? "";
    expect(sys).toContain("stale balance");
    expect(sys).toContain("Never write live money");
    expect(sys).toContain("Keep nicknames only when a beat uses them");
  });

  it("stays bounded on a big state and never lists half an entity", () => {
    const state = makeBigState(200);
    for (const e of Object.values(state.entities)) e.last_touched = 190;
    const req = buildCompactionRequest({ config, state, modules: [] });
    expect(req.total_tokens).toBeLessThan(5000);
    const lines = (req.messages[0]?.content ?? "").split("\n").filter((l) => l.startsWith("- Person "));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l.split(": ").slice(1).join(": ").split("; ")).toHaveLength(12);
  });
});

describe("parseCompactionResult", () => {
  it("parses plain JSON", () => {
    const r = parseCompactionResult(JSON.stringify(good));
    expect(r).toEqual({ ok: true, value: good });
  });

  it("tolerates code fences and surrounding prose", () => {
    const text = `Here you go:\n\`\`\`json\n${JSON.stringify({ ...good, facts: [{ id: "glenys", fact: "Wants mower back", importance: 3 }] })}\n\`\`\`\nHope that helps {not json}`;
    const r = parseCompactionResult(text);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.facts).toEqual([{ id: "glenys", fact: "Wants mower back", importance: 3 }]);
    const prose = parseCompactionResult(`Sure! ${JSON.stringify(good)} Done.`);
    expect(prose.ok).toBe(true);
  });

  it("handles braces inside strings", () => {
    const r = parseCompactionResult(`x ${JSON.stringify({ ...good, story_so_far: "He said } and { twice." })} y`);
    expect(r.ok).toBe(true);
  });

  it("defaults missing optional arrays, clamps importance and drops malformed facts", () => {
    const r = parseCompactionResult(
      JSON.stringify({
        chapter_summary: "c",
        story_so_far: "s",
        facts: [{ id: "a", fact: "x", importance: 9 }, { id: "a" }, { fact: "no id" }, { id: "b", fact: "y" }],
      }),
    );
    expect(r).toEqual({
      ok: true,
      value: {
        chapter_summary: "c",
        story_so_far: "s",
        facts: [
          { id: "a", fact: "x", importance: 3 },
          { id: "b", fact: "y", importance: 2 },
        ],
        resolve_threads: [],
      },
    });
  });

  it("reports errors for bad input", () => {
    for (const bad of ["", "no json here", "{broken: json", "[1,2,3]", "{}", JSON.stringify({ ...good, story_so_far: "" }), JSON.stringify({ ...good, facts: "no" })]) {
      const r = parseCompactionResult(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    }
  });
});

describe("applyCompaction", () => {
  function baseState(): State {
    const s = makeState({
      turn: 40,
      beats: [
        { turn: 21, text: "a" },
        { turn: 40, text: "b" },
      ],
      window: Array.from({ length: 9 }, (_, i) => ({ turn: 32 + i, input: `i${i}`, narration: `n${i}`, clock: "2026-10-03T09:00" })),
      summaries: { chapters: ["Ch1"], story_so_far: "Old.", last_compacted_turn: 20 },
      threads: [makeThread({ id: "t1" }), makeThread({ id: "t2" })],
    });
    s.entities.glenys = makeEntity({
      id: "glenys",
      name: "Glenys",
      facts: [
        { text: "keep me", importance: 2, turn: 7 },
        { text: "drop me", importance: 1, turn: 8 },
      ],
    });
    return s;
  }

  it("updates summaries, beats, window and last_compacted_turn without mutating input", () => {
    const state = deepFreeze({ ...baseState(), scene: { index: 4, started_turn: 38, closed: true } });
    const out = applyCompaction(state, good, config);
    expect(out.summaries.chapters).toEqual(["Ch1", good.chapter_summary]);
    expect(out.summaries.story_so_far).toBe(good.story_so_far);
    expect(out.summaries.last_compacted_turn).toBe(40);
    expect(out.beats).toEqual([]);
    expect(out.window).toHaveLength(6);
    expect(out.window[5]?.turn).toBe(40);
    expect(out.window[0]?.turn).toBe(35);
    expect(state.window).toHaveLength(9);
    expect(state.beats).toHaveLength(2);
    expect(out).not.toBe(state);
  });

  it("keeps the live scene verbatim when a forced compaction lands mid-scene", () => {
    const state = { ...baseState(), scene: { index: 4, started_turn: 32, closed: false } };
    const out = applyCompaction(state, good, config);
    // The scene opened after turn 32, so turns 33-40 are still live and the usual six would cut it.
    expect(out.window).toHaveLength(8);
    expect(out.window[0]?.turn).toBe(33);
  });

  it("never keeps more of a runaway scene than keep_scene_turns", () => {
    const tight = makeConfig({ scenes: { min_beats: 8, max_beats: 20, keep_scene_turns: 7 } });
    const state = { ...baseState(), scene: { index: 4, started_turn: 0, closed: false } };
    const out = applyCompaction(state, good, tight);
    expect(out.window).toHaveLength(7);
  });

  it("caps story_so_far at ~500 tokens by dropping the oldest sentences", () => {
    const sentences = Array.from({ length: 120 }, (_, i) => `Sentence number ${i} of the long story.`);
    const out = applyCompaction(baseState(), { ...good, story_so_far: sentences.join(" ") }, config);
    expect(estimateTokens(out.summaries.story_so_far)).toBeLessThanOrEqual(500);
    expect(out.summaries.story_so_far).toContain("Sentence number 119 of the long story.");
    expect(out.summaries.story_so_far).not.toContain("Sentence number 0 of");
  });

  it("keeps the old story when the new one is empty", () => {
    const out = applyCompaction(baseState(), { ...good, story_so_far: "  " }, config);
    expect(out.summaries.story_so_far).toBe("Old.");
  });

  it("replaces facts per listed entity, preserves turns of kept facts, caps at 8 by importance then newest", () => {
    const facts = [
      { id: "glenys", fact: "keep me", importance: 3 as const },
      ...Array.from({ length: 10 }, (_, i) => ({ id: "glenys", fact: `new ${i}`, importance: (i < 2 ? 1 : 2) as 1 | 2 })),
      { id: "ghost", fact: "ignored", importance: 3 as const },
      { id: "glenys", fact: "keep me", importance: 1 as const },
    ];
    const state = deepFreeze(baseState());
    const out = applyCompaction(state, { ...good, facts }, config);
    const g = out.entities.glenys?.facts ?? [];
    expect(g).toHaveLength(8);
    expect(g.map((f) => f.text)).not.toContain("drop me");
    expect(g.map((f) => f.text)).not.toContain("new 0");
    expect(g.map((f) => f.text)).not.toContain("new 1");
    expect(g.find((f) => f.text === "keep me")).toEqual({ text: "keep me", importance: 3, turn: 7 });
    expect(g.find((f) => f.text === "new 5")?.turn).toBe(40);
    expect(out.entities.ghost).toBeUndefined();
    expect(out.entities.cerys).toBe(state.entities.cerys);
  });

  it("resolves listed open threads and ignores unknown ids", () => {
    const state = deepFreeze(baseState());
    const out = applyCompaction(state, { ...good, resolve_threads: ["t1", "nope"] }, config);
    expect(out.threads.find((t) => t.id === "t1")).toMatchObject({ status: "resolved", resolved_turn: 40 });
    expect(out.threads.find((t) => t.id === "t2")?.status).toBe("open");
    expect(out.threads).toHaveLength(2);
    expect(state.threads[0]?.status).toBe("open");
  });

  it("caps the chapter summary", () => {
    const long = Array.from({ length: 200 }, (_, i) => `Chapter sentence ${i} is here.`).join(" ");
    const out = applyCompaction(baseState(), { ...good, chapter_summary: long }, config);
    expect(estimateTokens(out.summaries.chapters.at(-1) ?? "")).toBeLessThanOrEqual(250);
  });

  it("round-trips: compaction then shouldCompact is false", () => {
    const state = makeState({
      turn: 25,
      beats: Array.from({ length: 25 }, (_, i) => ({ turn: i + 1, text: "b" })),
    });
    expect(shouldCompact(state, config)).toBe(true);
    expect(shouldCompact(applyCompaction(state, good, config), config)).toBe(false);
  });
});
