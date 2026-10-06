import { readFileSync } from "node:fs";
import { MockProvider } from "@book/llm";
import { getActiveModules, statsOf } from "@book/modules";
import { ConfigSchema, type Config, type LLMProvider, type LLMRequest } from "@book/schema";
import { MemoryStore } from "@book/store";
import { describe, expect, it } from "vitest";
import { createRuntime, newGame, openBook, playTurn } from "../src/index.ts";

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
    expect(res.status).toContain("Cash: £15.00");
    expect(res.status).toContain("Bank: £30.00");
    expect(res.record.usage).toHaveLength(1);
    const state = await store.loadSave("s1");
    expect(state.turn).toBe(1);
    expect(state.window).toHaveLength(1);
    expect(state.beats).toHaveLength(1);
    expect(res.suggestions).toBeUndefined();
  });

  it("fills a missing beat from the narration and drops a focus sentence", async () => {
    const llm = scripted({
      turn: [
        JSON.stringify({
          narration: "Rain taps the window. The kettle clicks.",
          delta: [],
          focus_next: "Monday morning the agent comes",
        }),
      ],
    });
    const { rt, store } = await setup(llm);
    const res = await playTurn(rt, "s1", "Look around");
    expect(res.outcome).toBe("ok");
    expect(llm.calls.map((c) => c.purpose)).toEqual(["turn"]);
    const state = await store.loadSave("s1");
    expect(state.beats[0]?.text).toBe("Rain taps the window.");
    expect(state.focus_next).toEqual([]);
  });

  it("drops a charge a repair adds when the narration never stated it", async () => {
    const llm = scripted({
      turn: [draft([{ op: "clock.advance", minutes: "ten" }], "You head into the kitchen.")],
      delta_repair: [
        JSON.stringify({
          delta: [
            { op: "entity.move", id: "player", location: "kitchen" },
            { op: "stat.add", key: "cash", amount: -1.3, reason: "milk" },
            { op: "clock.advance", minutes: 5 },
          ],
          beat: "Into the kitchen.",
        }),
      ],
    });
    const { rt, store } = await setup(llm);
    const res = await playTurn(rt, "s1", "I look around");
    expect(res.outcome).toBe("repaired");
    const state = await store.loadSave("s1");
    expect(statsOf(state).values.cash).toBe(15);
    expect(state.entities.player?.location).toBe("kitchen");
  });

  it("drops a charge when the narration says it cost nothing", async () => {
    const llm = scripted({
      turn: [draft([{ op: "stat.add", key: "cash", amount: -12.5, reason: "plan" }, { op: "clock.advance", minutes: 1 }], "The switch costs nothing.")],
      delta_repair: [
        JSON.stringify({
          delta: [
            { op: "stat.add", key: "cash", amount: -12.5, reason: "plan" },
            { op: "clock.advance", minutes: 1 },
          ],
          beat: "The switch costs nothing.",
        }),
      ],
    });
    const { rt, store } = await setup(llm);
    const res = await playTurn(rt, "s1", "I look around");
    expect(res.outcome).toBe("repaired");
    expect(statsOf(await store.loadSave("s1")).values.cash).toBe(15);
  });

  it("marks a new name in bold for the next turn and leaves a known name plain", async () => {
    const llm = scripted({
      turn: [
        JSON.stringify({
          narration: "You pass Cerys. Seren waves from the door.",
          delta: [],
          beat: "Someone new.",
          highlights: ["Seren", "Cerys", "and"],
        }),
        JSON.stringify({ narration: "Rain taps the window.", delta: [], beat: "Rain." }),
      ],
    });
    const { rt, store } = await setup(llm);
    const first = await playTurn(rt, "s1", "Look around");
    expect(first.highlights).toEqual(["Seren"]);
    expect((await store.loadSave("s1")).window[0]?.highlights).toEqual(["Seren"]);
    await playTurn(rt, "s1", "Say hello");
    const second = llm.calls.filter((call) => call.purpose === "turn")[1];
    expect(JSON.stringify(second?.messages)).toContain("**Seren**");
    expect(JSON.stringify(second?.messages)).not.toContain("**Cerys**");
  });

  it("names the chapter when the scene closes", async () => {
    const llm = scripted({
      turn: [JSON.stringify({ narration: "You climb the stairs and sleep.", delta: [], beat: "The inspection passes.", scene_ended: true })],
    });
    const { rt, store } = await setup(llm);
    const res = await playTurn(rt, "s1", "Go up to bed");
    expect(res.scene_ended).toBe(true);
    expect(res.chapter_title).toBe("The inspection passes");
    expect(res.chapter_index).toBe(1);
    expect((await store.loadSave("s1")).scene.title).toBe("The inspection passes");
  });

  it("returns three suggested actions and drops a fourth", async () => {
    const llm = scripted({
      turn: [
        JSON.stringify({
          narration: "Rain taps the window.",
          delta: [],
          beat: "Rain.",
          suggested_actions: ["Look around", "Make tea", "Go to the kitchen", "extra"],
        }),
      ],
    });
    const { rt } = await setup(llm);
    const res = await playTurn(rt, "s1", "Look around");
    expect(res.outcome).toBe("ok");
    expect(res.suggestions).toEqual(["Look around", "Make tea", "Go to the kitchen"]);
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

  it("asks again with the place JSON when a delta repair is not readable", async () => {
    const llm = scripted({
      turn: [draft([{ op: "clock.advance", minutes: "ten" }])],
      delta_repair: ["not json at all", JSON.stringify({ delta: [{ op: "clock.advance", minutes: 10 }], beat: "Fixed." })],
    });
    const { rt, store } = await setup(llm);
    const res = await playTurn(rt, "s1", "Wait a bit");
    expect(res.outcome).toBe("repaired");
    expect(llm.calls.map((c) => c.purpose)).toEqual(["turn", "delta_repair", "delta_repair"]);
    const reminder = llm.calls[2]?.messages.at(-1)?.content ?? "";
    expect(reminder).toContain("entity.create");
    expect(reminder).toContain("entity.move");
    expect(reminder).toContain('"at"');
    expect((await store.loadSave("s1")).clock.now).toBe("2026-10-03T09:30");
  });

  it("rewrites a game-breaking draft behind a GM interlude and keeps the broken text out of history", async () => {
    const broken = draft([{ op: "stat.add", key: "bank", amount: -500 }], "You buy a yacht.");
    const good = draft([{ op: "stat.add", key: "bank", amount: -2 }], "You buy a bag of crisps.");
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
    expect(statsOf(state).values.bank).toBe(28);
    expect(statsOf(state).values.cash).toBe(15);
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
    const bad = draft([{ op: "stat.add", key: "bank", amount: -500 }], "Yacht.");
    const llm = scripted({ turn: [bad], rewrite_repair: [bad, bad] });
    const { rt, store } = await setup(llm);
    const res = await playTurn(rt, "s1", "Buy a yacht");
    expect(res.outcome).toBe("rolled_back");
    expect(res.narration).toBe(config.gm_style.rollback_note);
    expect(res.turn).toBe(0);
    const state = await store.loadSave("s1");
    expect(state.turn).toBe(0);
    expect(state.window).toEqual([]);
    expect(statsOf(state).values.cash).toBe(15);
    expect(statsOf(state).values.bank).toBe(30);
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
    expect(statsOf(state).values.cash).toBe(15);
    expect(statsOf(state).values.bank).toBe(30);
  });

  it("shows the roll when the config puts the dice on screen, and names what was at stake", async () => {
    const tabletop: Config = { ...config, dice: { ...config.dice!, visible: true } };
    const llm = scripted({ turn: [JSON.stringify({ narration: "The drawer sticks, then gives.", delta: [], beat: "Opened the drawer.", check: { what: "forcing the swollen drawer", stat: "health" } })] });
    const { rt } = await setup(llm, { config: tabletop });
    const res = await playTurn(rt, "s1", "Force the drawer");
    expect(res.roll).toMatchObject({ what: "forcing the swollen drawer", stat: "health" });
    expect(res.roll?.value).toBe(res.record.fate);
    expect(config.dice?.labels).toContain(res.roll?.band);
    expect(res.record.check).toEqual({ what: "forcing the swollen drawer", stat: "health" });
  });

  it("keeps the roll off screen when the config hides the dice, but still logs the check", async () => {
    const llm = scripted({ turn: [JSON.stringify({ narration: "The drawer gives.", delta: [], beat: "Opened it.", check: { what: "forcing the drawer" } })] });
    const { rt } = await setup(llm);
    const res = await playTurn(rt, "s1", "Force the drawer");
    expect(res.roll).toBeUndefined();
    expect(res.record.check).toEqual({ what: "forcing the drawer" });
  });

  it("keeps a thread warm while the player keeps naming it", async () => {
    const { rt, store } = await setup(new MockProvider());
    for (let i = 0; i < 4; i++) await playTurn(rt, "s1", "Stare at the garden");
    const state = await store.loadSave("s1");
    const garden = state.threads.find((t) => t.text.includes("garden"));
    expect(garden?.warm).toBe(true);
    expect(garden?.reminders).toBe(0);
    const records = await store.readTurnRecords("s1");
    expect(records[0]?.threads_shown).toContain(garden?.id);
  });

  it("makes a missed deadline bite, once, on the turn after it passes", async () => {
    const skip = JSON.stringify({ narration: "Time passes.", delta: [{ op: "clock.skip", minutes: 840, reason: "slept" }], beat: "Slept." });
    const llm = scripted({ turn: [skip, skip, skip, draft([])] });
    const { rt, store } = await setup(llm);

    // Three long sleeps, never touching the garden, whose deadline was Sunday evening.
    const records = [];
    for (let i = 0; i < 4; i++) records.push(await playTurn(rt, "s1", "sleep"));

    const state = await store.loadSave("s1");
    const garden = state.threads.find((t) => t.kind === "goal" && t.text.includes("overgrown"))!;
    // Nothing fires while the deadline is still ahead.
    expect(records.slice(0, 3).flatMap((r) => r.record.due)).not.toContain(`overdue:${garden.id}`);
    expect(records.at(-1)?.record.due).toContain(`overdue:${garden.id}`);
    expect(garden.status).toBe("failed");

    // Having had its consequence, it does not ask for another one.
    const after = await playTurn(rt, "s1", "look around");
    expect(after.record.due).not.toContain(`overdue:${garden.id}`);
  });

  it("refuses a skip longer than the world allows and rolls the turn back", async () => {
    const tooLong = JSON.stringify({ narration: "You sleep for a week.", delta: [{ op: "clock.skip", minutes: 10080, reason: "a week" }], beat: "Slept." });
    const llm = scripted({ turn: [tooLong], rewrite_repair: [tooLong, tooLong] });
    const { rt, store } = await setup(llm);
    const res = await playTurn(rt, "s1", "sleep for a week");
    expect(res.outcome).toBe("rolled_back");
    expect(res.record.attempts[0]?.violations[0]?.code).toBe("skip_too_long");
    expect((await store.loadSave("s1")).clock.now).toBe(config.time.start);
  });

  it("keeps raw model replies out of the log unless logging is asked for", async () => {
    const llm = scripted({ turn: [draft([])] });
    const plain = await setup(llm);
    const a = await playTurn(plain.rt, "s1", "Look around");
    expect(a.record.attempts[0]?.raw).toBeUndefined();

    const store = new MemoryStore();
    const rt = createRuntime({ config, store, llm, logRaw: true });
    await newGame(rt, "s2");
    const b = await playTurn(rt, "s2", "Look around");
    expect(b.record.attempts[0]?.raw).toBe(draft([]));
  });

  it("supports a game with different modules (pirate config)", async () => {
    const pirate = ConfigSchema.parse(JSON.parse(readFileSync(new URL("../../../configs/pirate/config.json", import.meta.url), "utf8")));
    expect(() => getActiveModules(pirate)).not.toThrow();
    const { rt } = await setup(new MockProvider(), { config: pirate });
    const res = await playTurn(rt, "s1", "Check the rigging");
    expect(res.outcome).toBe("ok");
    expect(res.panel.length).toBeGreaterThan(0);
  });

  it("releases the validated turn before the archivist, and holds a failed chapter write", async () => {
    const llm = scripted({ compaction: ["not json at all"] });
    const { rt, store } = await setup(llm);
    let releasedBeforeCompaction = 0;
    for (let i = 0; i < 20; i++) {
      const res = await playTurn(rt, "s1", `Do thing ${i}`, {
        onReleased(r) {
          if (!r.record.usage.some((u) => u.purpose === "compaction")) releasedBeforeCompaction++;
        },
      });
      expect(res.notices).toEqual([]);
      if (i === 19) expect(res.record.usage.some((u) => u.purpose === "compaction")).toBe(true);
    }
    expect(releasedBeforeCompaction).toBe(20);
    const state = await store.loadSave("s1");
    expect(state.turn).toBe(20);
    expect(state.summaries.story_so_far).toBe("");
    expect(state.summaries.compaction_hold_until).toBe(25);
  });
});

describe("openBook", () => {
  it("deals a cast and a thread into the save and does not name unmet people", async () => {
    const { rt, store } = await setup(new MockProvider());
    const opened = await openBook(rt, "s1");
    expect(opened?.narration).not.toMatch(/Rowan|Okonkwo|Priya/);
    const state = await store.loadSave("s1");
    expect(state.turn).toBe(1);
    expect(state.entities.cerys).toBeUndefined();
    expect(state.entities["1"]?.id).toBe("1");
    expect(state.entities["3"]?.id).toBe("3");
    expect(state.entities["1"]?.name).not.toBe("Dai");
    expect(state.entities["3"]?.name).not.toBe("Cerys");
    expect(state.entities["rowan-hale"]?.tags).toContain("unmet");
    expect(state.entities["sam-okonkwo"]).toBeTruthy();
    expect(state.entities["priya-shah"]).toBeTruthy();
    expect(state.threads.some((t) => t.text.includes("Rowan Hale") && t.due)).toBe(true);
    expect(state.window[0]?.narration).not.toMatch(/Rowan/);
    expect(state.entities.kitchen?.type).toBe("place");
    expect(state.entities.player?.type).toBe("person");
  });

  it("deals a different cast when the chapter cannot be read", async () => {
    const names = ["Nia Davies", "Tomos Reed", "Aisha Khan", "Owen Price", "Leah Morgan", "Harri Jones", "Sian Berg", "Jake Okoye"];
    const llm = scripted({ opening: ["nope"], rewrite_repair: ["still nope"] });
    const { rt, store } = await setup(llm);
    const opened = await openBook(rt, "s1");
    expect(opened?.narration).toBeTruthy();
    expect(opened?.narration).not.toMatch(/Type your first action/);
    const state = await store.loadSave("s1");
    expect(state.turn).toBe(1);
    expect(state.entities.cerys).toBeUndefined();
    expect(state.entities["1"]?.location).toBe("player-room");
    expect(state.threads.some((thread) => thread.entities.includes("1"))).toBe(true);
    const named = names.filter((name) => opened?.narration.includes(name));
    expect(named).toHaveLength(1);
    expect(named[0]).toBe(state.entities["1"]?.name);
    const others = Object.values(state.entities).filter((entity) => entity.type === "person" && entity.id !== "1" && entity.id !== "player");
    for (const person of others) expect(opened?.narration).not.toContain(person.name);

    await newGame(rt, "other-house");
    const other = await openBook(rt, "other-house");
    const otherNamed = names.filter((name) => other?.narration.includes(name));
    expect(otherNamed).toHaveLength(1);
    expect(otherNamed[0]).not.toBe(named[0]);
  });

  it("keeps a pinned character and still deals someone new", async () => {
    const pinned = ConfigSchema.parse({ ...config, opening: { ...config.opening, pinned: ["3"] } });
    const llm = scripted({ opening: ["nope"], rewrite_repair: ["still nope"] });
    const { rt, store } = await setup(llm, { config: pinned });
    const opened = await openBook(rt, "s1");
    const state = await store.loadSave("s1");
    expect(state.entities["3"]?.name).toBe("Cerys");
    expect(state.entities["1"]?.name).not.toBe("Dai");
    expect(opened?.narration).not.toContain("Dai");
    expect(opened?.narration).not.toContain("Cerys");
    expect(Object.values(state.entities).some((entity) => entity.id !== "3" && entity.id !== "player" && entity.type === "person")).toBe(true);
  });

  it("refuses an opening that names someone the player has not met, and still starts the chapter", async () => {
    const leaked = JSON.stringify({
      narration: "Rowan Hale is already in the doorway.",
      delta: [
        { op: "entity.create", id: "rowan-hale", type: "person", name: "Rowan Hale", tags: ["unmet"] },
        { op: "clock.advance", minutes: 1 },
      ],
      beat: "Someone is named too soon.",
    });
    const llm = scripted({ opening: [leaked], rewrite_repair: [leaked] });
    const { rt, store } = await setup(llm);
    const opened = await openBook(rt, "s1");
    expect(opened?.narration).not.toContain("Rowan");
    expect((await store.loadSave("s1")).entities["3"]?.name).not.toBe("Cerys");
    expect((await store.loadSave("s1")).turn).toBe(1);
  });

  it("does nothing when the book does not deal an opening", async () => {
    const { opening: _opening, ...rest } = config;
    const { rt, store } = await setup(new MockProvider(), { config: rest });
    expect(await openBook(rt, "s1")).toBeNull();
    expect((await store.loadSave("s1")).turn).toBe(0);
    expect((await store.loadSave("s1")).entities["3"]?.name).toBe("Cerys");
  });
});
