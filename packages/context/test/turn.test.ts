import { describe, expect, it } from "vitest";
import { buildTurnContext, DEFAULT_BUDGET } from "../src/index.ts";
import { inventoryModule, makeBigState, makeConfig, makeState, makeThread, statsModule } from "./fixtures.ts";

const config = makeConfig();
const modules = [statsModule, inventoryModule];

function build(over: Record<string, unknown> = {}, state = makeState()) {
  return buildTurnContext({
    config,
    state,
    modules,
    input: "I ask Glenys about the mower",
    kind: "act",
    due: [],
    ...over,
  });
}

const part = (ctx: ReturnType<typeof build>, name: string) => {
  const p = ctx.parts.find((x) => x.name === name);
  if (!p) throw new Error(`missing part ${name}`);
  return p;
};

describe("buildTurnContext structure", () => {
  it("builds two cacheable system blocks with contract and module fragments", () => {
    const ctx = build();
    expect(ctx.system).toHaveLength(2);
    expect(ctx.system.every((b) => b.cache === true)).toBe(true);
    const [contract, frags] = ctx.system;
    expect(contract?.text).toContain("never write state");
    expect(contract?.text).toContain("MUST appear in delta");
    expect(contract?.text).toContain("clock.advance");
    expect(contract?.text).toContain("entity.create");
    expect(contract?.text).toContain("FATE DIE");
    expect(contract?.text).toContain("At most 90 words");
    expect(contract?.text).toContain("second person");
    expect(contract?.text).toContain("End on a small hook.");
    expect(contract?.text).toContain("Never decide the player's");
    expect(contract?.text).toContain("Tone: grounded, dry");
    expect(contract?.text).toContain("fades to black");
    expect(contract?.text).toContain("involving minors");
    expect(contract?.text).toContain("single JSON object");
    expect(contract?.text).toContain("stat.add{");
    expect(contract?.text).toContain("inventory.remove{");
    expect(frags?.text).toContain("STATS: money is in GBP");
    expect(frags?.text).toContain("INVENTORY:");
  });

  it("states the numbers rule differently for tabletop and varies content-rating text", () => {
    const tabletop = makeConfig({ presentation: { profile: "tabletop", status_line: [] } });
    const t = buildTurnContext({ config: tabletop, state: makeState(), modules, input: "x", kind: "act", due: [] });
    expect(t.system[0]?.text).toContain("tabletop profile");
    expect(t.system[0]?.text).not.toContain("Never write the status line");
    const clean = makeConfig({ meta: { title: "T", tone: "t", content_rating: "clean" } });
    const c = buildTurnContext({ config: clean, state: makeState(), modules, input: "x", kind: "act", due: [] });
    expect(c.system[0]?.text).toContain("No sexual content");
    const mature = makeConfig({ meta: { title: "T", tone: "t", content_rating: "mature" } });
    const m = buildTurnContext({ config: mature, state: makeState(), modules, input: "x", kind: "act", due: [] });
    expect(m.system[0]?.text).toContain("usage policy");
    expect(m.system[0]?.text).toContain("involving minors");
  });

  it("orders message sections and puts the player input last; omits empty sections", () => {
    const state = makeState({
      threads: [makeThread({ id: "t1", text: "Return the mower", due: "2026-10-03T16:00", entities: ["glenys"] })],
      beats: [{ turn: 3, text: "Met Glenys" }],
      summaries: { chapters: [], story_so_far: "You moved to town.", last_compacted_turn: 0 },
      window: [{ turn: 5, input: "hello", narration: "Hi there.", clock: "2026-10-03T09:00" }],
    });
    const ctx = build({ due: [{ id: "bin-day", kind: "scheduled", text: "Bins collected", entities: [] }], fate: 37 }, state);
    const text = ctx.messages[0]?.content ?? "";
    const order = [
      "## SCENE",
      "## STATE",
      "## DUE EVENTS",
      "FATE DIE: 37 (d100)",
      "## OPEN THREADS",
      "## FOCUS ENTITIES",
      "## STORY SO FAR",
      "## RECENT BEATS",
      "## LAST TURNS",
      "## PLAYER INPUT",
    ].map((h) => text.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text.trimEnd().endsWith("I ask Glenys about the mower")).toBe(true);
    expect(text).toContain("Present: Glenys [glenys]");
    expect(text).toContain("Player: hello\nGM: Hi there.");
    expect(text).toContain("money: 45.00 GBP");

    const bare = build({}, makeState());
    const bareText = bare.messages[0]?.content ?? "";
    for (const h of ["## DUE EVENTS", "## FATE DIE", "## OPEN THREADS", "## STORY SO FAR", "## RECENT BEATS", "## LAST TURNS"]) {
      expect(bareText).not.toContain(h);
    }
    expect(bare.messages).toHaveLength(1);
  });

  it("shows only a fate die section when there are no due events", () => {
    const text = build({ fate: 12 }).messages[0]?.content ?? "";
    expect(text).toContain("## FATE DIE");
    expect(text).toContain("FATE DIE: 12");
    expect(text).not.toContain("## DUE EVENTS");
  });

  it("lists dated threads soonest first, then warm threads", () => {
    const state = makeState({
      threads: [
        makeThread({ id: "late", text: "later one", due: "2026-10-09T10:00" }),
        makeThread({ id: "warm", text: "running joke", kind: "callback", opened_turn: 2 }),
        makeThread({ id: "soon", text: "sooner one", due: "2026-10-04T10:00" }),
        makeThread({ id: "done", text: "finished", status: "resolved" }),
      ],
    });
    const text = build({}, state).messages[0]?.content ?? "";
    expect(text.indexOf("soon [")).toBeGreaterThan(-1);
    expect(text.indexOf("- soon")).toBeLessThan(text.indexOf("- late"));
    expect(text.indexOf("- late")).toBeLessThan(text.indexOf("- warm"));
    expect(text).not.toContain("finished");
  });

  it("only includes beats since the last compaction (max 20)", () => {
    const beats = Array.from({ length: 30 }, (_, i) => ({ turn: i + 1, text: `beat-${i + 1}-x` }));
    const state = makeState({
      turn: 30,
      beats,
      summaries: { chapters: [], story_so_far: "", last_compacted_turn: 5 },
    });
    const text = build({}, state).messages[0]?.content ?? "";
    expect(text).not.toContain("beat-5-x");
    expect(text).not.toContain("beat-10-x");
    expect(text).toContain("beat-30-x");
    expect(text).toContain("beat-11-x");
    expect(build({}, state).parts.find((p) => p.name === "beats")?.trimmed).toBe(true);
  });

  it("uses the last 6 window turns and delta_first / narration_first ordering text", () => {
    const window = Array.from({ length: 9 }, (_, i) => ({
      turn: i + 1,
      input: `in-${i + 1}`,
      narration: `out-${i + 1}`,
      clock: "2026-10-03T09:00",
    }));
    const text = build({}, makeState({ window })).messages[0]?.content ?? "";
    expect(text).not.toContain("in-3\n");
    expect(text).toContain("in-4");
    expect(text).toContain("out-9");

    const nf = build().system[0]?.text ?? "";
    const df = build({ outputOrder: "delta_first" }).system[0]?.text ?? "";
    expect(nf).toContain("narration, delta, beat");
    expect(nf).not.toContain("delta, beat, narration");
    expect(df).toContain("delta, beat, narration");
    expect(df).not.toContain("narration, delta, beat");
  });

  it("marks continue turns", () => {
    const text = build({ kind: "continue", input: "..." }).messages[0]?.content ?? "";
    expect(text).toContain("## PLAYER INPUT\n...");
    expect(text).toContain("continue");
  });

  it("lists every part and total equals the sum", () => {
    const ctx = build();
    expect(ctx.parts.map((p) => p.name)).toEqual([
      "contract",
      "module_fragments",
      "scene",
      "state_snapshot",
      "due_events",
      "threads",
      "notes",
      "entities_in_focus",
      "story_so_far",
      "beats",
      "window",
      "input",
    ]);
    expect(ctx.total_tokens).toBe(ctx.parts.reduce((n, p) => n + p.tokens, 0));
    expect(ctx.focus).toContain("glenys");
  });
});

describe("private notes and the scene header", () => {
  const notes = [
    { turn: 3, text: "oldest" },
    { turn: 4, text: "middle" },
    { turn: 5, text: "newest" },
    { turn: 6, text: "newer still" },
  ];

  it("adds nothing when the GM has written no notes", () => {
    expect(part(build(), "notes").tokens).toBe(0);
  });

  it("shows the newest notes only, capped by max_in_context", () => {
    const ctx = build({}, makeState({ notes }));
    const text = JSON.stringify(ctx.messages);
    expect(text).toContain("YOUR PRIVATE NOTES");
    expect(text).toContain("newer still");
    expect(text).toContain("newest");
    expect(text).toContain("middle");
    expect(text).not.toContain("oldest");
  });

  it("omits the section entirely when the game has notes switched off", () => {
    const off = makeConfig({ notes: { enabled: false } });
    const ctx = buildTurnContext({ config: off, state: makeState({ notes }), modules, input: "hi", kind: "act", due: [] });
    expect(JSON.stringify(ctx.messages)).not.toContain("PRIVATE NOTES");
  });

  it("tells the GM which scene it is in and how long it has run", () => {
    const ctx = build({}, makeState({ turn: 9, scene: { index: 3, started_turn: 4, closed: false } }));
    expect(JSON.stringify(ctx.messages)).toContain("Scene 3, running 5 turns");
  });
});

describe("static blocks are cache-stable", () => {
  it("system blocks are byte-identical across different turns", () => {
    const a = build({}, makeState());
    const b = buildTurnContext({
      config,
      state: makeBigState(150),
      modules: [inventoryModule, statsModule],
      input: "something else entirely",
      kind: "act",
      due: [{ id: "x", kind: "random", text: "rain", entities: [] }],
      fate: 88,
    });
    expect(b.system).toEqual(a.system);
    expect(JSON.stringify(b.system)).toBe(JSON.stringify(a.system));
  });

  it("only active modules appear in the second block", () => {
    const ctx = build({ modules: [statsModule] });
    expect(ctx.system[1]?.text).toContain("STATS");
    expect(ctx.system[1]?.text).not.toContain("INVENTORY");
    expect(ctx.system[0]?.text).not.toContain("inventory.add");
  });
});

describe("budget", () => {
  it("keeps a turn-200 context bounded and flags trimmed parts", () => {
    const ctx = buildTurnContext({
      config,
      state: makeBigState(200),
      modules,
      input: "I ask Person 3 about the plan",
      kind: "act",
      due: [{ id: "d1", kind: "scheduled", text: "Church bells ring", entities: ["npc9"] }],
      fate: 41,
    });
    expect(ctx.total_tokens).toBeLessThan(5500);
    for (const name of ["state_snapshot", "due_events", "threads", "entities_in_focus", "window", "beats", "story_so_far"] as const) {
      const p = ctx.parts.find((x) => x.name === name);
      expect(p?.tokens ?? 0).toBeLessThanOrEqual(DEFAULT_BUDGET[name]);
    }
    for (const name of ["threads", "entities_in_focus", "beats", "story_so_far"]) {
      expect(ctx.parts.find((x) => x.name === name)?.trimmed).toBe(true);
    }
    expect(ctx.parts.find((x) => x.name === "input")?.trimmed).toBe(false);
  });

  it("honours custom budgets", () => {
    const ctx = buildTurnContext({
      config,
      state: makeBigState(200),
      modules,
      input: "hi",
      kind: "act",
      due: [],
      budget: { beats: 50, window: 100, story_so_far: 60, threads: 40 },
    });
    expect(part(ctx, "beats").tokens).toBeLessThanOrEqual(50);
    expect(part(ctx, "window").tokens).toBeLessThanOrEqual(100);
    expect(part(ctx, "story_so_far").tokens).toBeLessThanOrEqual(60);
    expect(part(ctx, "threads").tokens).toBeLessThanOrEqual(40);
    expect(ctx.messages[0]?.content).toContain("## LAST TURNS");
  });

  it("keeps the newest beats and newest window turns when trimming", () => {
    const ctx = build({ budget: { beats: 40 } }, makeBigState(200));
    const text = ctx.messages[0]?.content ?? "";
    expect(text).toContain("Turn 200:");
    expect(text).not.toContain("Turn 176:");
  });

  it("never trims the player input, even when huge, and never trims the roster", () => {
    const huge = `I say ${"blah ".repeat(2000)}end-marker`;
    const ctx = buildTurnContext({
      config,
      state: makeBigState(200),
      modules,
      input: huge,
      kind: "act",
      due: [],
      budget: { input: 10 },
    });
    expect(ctx.messages[0]?.content).toContain(huge);
    expect(part(ctx, "input").trimmed).toBe(false);
    expect(part(ctx, "input").tokens).toBeGreaterThan(2000);
    const text = ctx.messages[0]?.content ?? "";
    const present = text.split("\n").find((l) => l.startsWith("Present:")) ?? "";
    for (let n = 0; n < 50; n += 6) expect(present).toContain(`[npc${n}]`);
  });

  it("truncates a single oversize window turn instead of dropping the whole window", () => {
    const state = makeState({
      window: [{ turn: 1, input: "go", narration: `${"long ".repeat(1000)}THE-END`, clock: "2026-10-03T09:00" }],
    });
    const ctx = build({ budget: { window: 100 } }, state);
    expect(part(ctx, "window").tokens).toBeLessThanOrEqual(100);
    expect(part(ctx, "window").trimmed).toBe(true);
    expect(ctx.messages[0]?.content).toContain("THE-END");
  });

  it("drops fragments from the end when module fragments exceed their cap", () => {
    const ctx = build({ budget: { module_fragments: 20 } });
    expect(part(ctx, "module_fragments").trimmed).toBe(true);
    expect(part(ctx, "module_fragments").tokens).toBeLessThanOrEqual(20);
  });
});
