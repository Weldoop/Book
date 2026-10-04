import type { Violation } from "@book/schema";
import { describe, expect, it } from "vitest";
import { buildOocContext, buildRepairContext, buildTurnContext } from "../src/index.ts";
import { inventoryModule, makeBigState, makeConfig, makeState, makeThread, statsModule } from "./fixtures.ts";

const config = makeConfig();
const modules = [statsModule, inventoryModule];
const REJECTED_MARK = "REJECTED-NARRATION-MARKER-xyzzy";

const violations: Violation[] = [
  { severity: "game_breaking", code: "insufficient_funds", message: "Player has 45 GBP but the draft spends 80.", op_index: 1 },
  { severity: "fixable", code: "unknown_entity", message: "Entity 'glenis' does not exist.", op_index: 2 },
];

const draftObj = {
  narration: `You hand over cash. ${REJECTED_MARK}`,
  delta: [
    { op: "clock.advance", minutes: 10 },
    { op: "stat.add", key: "money", amount: -80 },
    { op: "entity.fact.add", id: "glenis", fact: "Happy" },
  ],
  beat: "Paid too much.",
};
const draftText = JSON.stringify(draftObj);

describe("delta_repair", () => {
  const ctx = buildRepairContext({
    kind: "delta_repair",
    config,
    state: makeState(),
    modules,
    input: "I pay Glenys for the mower",
    draftText,
    violations,
    narration: draftObj.narration,
  });
  const text = ctx.messages[0]?.content ?? "";

  it("has a small system prompt with op signatures and the return-only instruction", () => {
    expect(ctx.system).toHaveLength(1);
    const sys = ctx.system[0]?.text ?? "";
    expect(sys).toContain('Return ONLY a JSON object {"delta":[...],"beat":"..."}');
    expect(sys).toContain("Do not change the narration");
    expect(sys).toContain("stat.add{");
    expect(sys).toContain("clock.advance{");
    expect(sys).toContain("MUST appear in delta".replace("MUST", "must"));
  });

  it("includes narration, rejected ops, violations and a state slice", () => {
    expect(text).toContain("## NARRATION");
    expect(text).toContain(REJECTED_MARK);
    expect(text).toContain("## REJECTED OPS");
    expect(text).toContain('"id":"glenis"');
    expect(text).toContain("## VIOLATIONS");
    expect(text).toContain("Player has 45 GBP but the draft spends 80.");
    expect(text).toContain("delta[2]");
    expect(text).toContain("## SCENE");
    expect(text).toContain("money: 45.00 GBP");
    expect(text).toContain("## FOCUS ENTITIES");
    expect(text).toContain("Glenys [glenys]");
    expect(text).toContain("I pay Glenys for the mower");
  });

  it("does not duplicate the narration inside the rejected ops", () => {
    expect(text.split(REJECTED_MARK)).toHaveLength(2);
  });

  it("stays small even on a big state", () => {
    const big = buildRepairContext({
      kind: "delta_repair",
      config,
      state: makeBigState(200),
      modules,
      input: "I pay Person 3",
      draftText,
      violations,
      narration: draftObj.narration,
    });
    const slice = big.parts.filter((p) => ["scene", "state_snapshot", "entities_in_focus"].includes(p.name));
    expect(slice.reduce((n, p) => n + p.tokens, 0)).toBeLessThan(1300);
    expect(big.total_tokens).toBeLessThan(2500);
  });

  it("falls back to raw draft text when it is not JSON and still reports violations", () => {
    const c = buildRepairContext({
      kind: "delta_repair",
      config,
      state: makeState(),
      modules,
      input: "x",
      draftText: "not json at all [stat.add",
      violations,
    });
    const t = c.messages[0]?.content ?? "";
    expect(t).toContain("not json at all [stat.add");
    expect(t).toContain("insufficient_funds");
    expect(t).not.toContain("## NARRATION");
  });

  it("pulls entities referenced by the rejected ops into focus", () => {
    const c = buildRepairContext({
      kind: "delta_repair",
      config,
      state: makeState(),
      modules,
      input: "x",
      draftText: JSON.stringify({ delta: [{ op: "entity.fact.add", id: "dai", fact: "y" }], beat: "b" }),
      violations: [violations[1] as Violation],
    });
    expect(c.focus).toContain("dai");
  });
});

describe("rewrite_repair", () => {
  const state = makeState({
    threads: [makeThread({ id: "t1", text: "Return the mower", due: "2026-10-03T16:00", entities: ["glenys"] })],
    beats: [{ turn: 5, text: "Borrowed the mower" }],
    window: [{ turn: 5, input: "hi", narration: "Glenys waves.", clock: "2026-10-03T09:00" }],
  });
  const due = [{ id: "bin-day", kind: "scheduled" as const, text: "Bins collected", entities: [] }];
  const turnArgs = { config, state, modules, input: "I pay Glenys for the mower", kind: "act" as const, due, fate: 61 };
  const normal = buildTurnContext(turnArgs);
  const ctx = buildRepairContext({
    kind: "rewrite_repair",
    config,
    state,
    modules,
    input: turnArgs.input,
    draftText,
    violations,
    due,
    fate: 61,
  });
  const text = ctx.messages[0]?.content ?? "";

  it("reuses the exact cacheable system blocks and appends the rewrite rule", () => {
    expect(ctx.system.slice(0, 2)).toEqual(normal.system);
    expect(ctx.system).toHaveLength(3);
    expect(ctx.system[2]?.text).toContain("Your previous draft broke the rules; write a new one that respects them");
    expect(ctx.system[2]?.cache).toBeUndefined();
  });

  it("contains the normal turn context plus rejected draft and violations", () => {
    const normalText = normal.messages[0]?.content ?? "";
    const base = normalText.slice(0, normalText.indexOf("## PLAYER INPUT"));
    expect(text.startsWith(base)).toBe(true);
    expect(text).toContain("FATE DIE: 61");
    expect(text).toContain("Bins collected");
    expect(text).toContain("## PLAYER INPUT\nI pay Glenys for the mower");
    expect(text).toContain("## REJECTED DRAFT");
    expect(text).toContain(REJECTED_MARK);
    expect(text).toContain("## RULE VIOLATIONS");
    expect(text).toContain("Player has 45 GBP but the draft spends 80.");
    expect(text).toContain("Keep the player's intent");
    expect(text).toContain("full JSON object (narration, delta, beat)");
  });

  it("reports extra parts in the total", () => {
    const names = ctx.parts.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(["contract", "module_fragments", "input", "rejected_draft", "violations"]));
    expect(ctx.total_tokens).toBe(ctx.parts.reduce((n, p) => n + p.tokens, 0));
    expect(ctx.total_tokens).toBeGreaterThan(normal.total_tokens);
  });

  it("infers a continue turn from '...' and honours delta_first", () => {
    const c = buildRepairContext({
      kind: "rewrite_repair",
      config,
      state,
      modules,
      input: "...",
      draftText,
      violations,
      outputOrder: "delta_first",
    });
    expect(c.messages[0]?.content).toContain("(continue: advance the scene)");
    expect(c.system[0]?.text).toContain("delta, beat, narration");
  });

  it("truncates an enormous rejected draft", () => {
    const c = buildRepairContext({
      kind: "rewrite_repair",
      config,
      state,
      modules,
      input: "x",
      draftText: "z".repeat(50_000),
      violations,
    });
    expect(c.parts.find((p) => p.name === "rejected_draft")?.trimmed).toBe(true);
    expect(c.total_tokens).toBeLessThan(6000);
  });
});

describe("rejected drafts never leak into normal contexts", () => {
  it("turn, OOC and window-based contexts do not contain the rejected text", () => {
    const state = makeState({
      window: [{ turn: 5, input: "hi", narration: "Approved narration only.", clock: "2026-10-03T09:00" }],
    });
    const turn = buildTurnContext({ config, state, modules, input: "go", kind: "act", due: [] });
    const ooc = buildOocContext({ config, state, modules, input: "OOC: what do I owe?" });
    for (const c of [turn, ooc]) {
      const all = JSON.stringify(c);
      expect(all).not.toContain(REJECTED_MARK);
      expect(all).not.toContain("REJECTED");
    }
  });
});

describe("buildOocContext", () => {
  const state = makeState({
    threads: [makeThread({ id: "t1", text: "Return the mower", due: "2026-10-03T16:00" })],
    summaries: { chapters: [], story_so_far: "You moved to town.", last_compacted_turn: 0 },
    beats: [{ turn: 1, text: "BEAT-SHOULD-NOT-APPEAR" }],
    window: [{ turn: 1, input: "hi", narration: "WINDOW-SHOULD-NOT-APPEAR", clock: "2026-10-03T09:00" }],
  });
  const ctx = buildOocContext({ config, state, modules, input: "OOC: what do I owe Glenys?" });
  const text = ctx.messages[0]?.content ?? "";

  it("is a short plain-text request with the right sections", () => {
    expect(ctx.system).toHaveLength(1);
    const sys = ctx.system[0]?.text ?? "";
    expect(sys).toContain("square brackets");
    expect(sys).toContain("Never change the story");
    expect(sys).toContain("only from the provided state");
    expect(sys).not.toContain("JSON object only");
    for (const h of ["## SCENE", "## STATE", "## OPEN THREADS", "## STORY SO FAR", "## QUESTION"]) {
      expect(text).toContain(h);
    }
    expect(text).toContain("what do I owe Glenys?");
    expect(text).not.toContain("OOC:");
    expect(text).not.toContain("BEAT-SHOULD-NOT-APPEAR");
    expect(text).not.toContain("WINDOW-SHOULD-NOT-APPEAR");
    expect(ctx.total_tokens).toBe(ctx.parts.reduce((n, p) => n + p.tokens, 0));
  });
});
