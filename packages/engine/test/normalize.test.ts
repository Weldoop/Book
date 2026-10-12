import { describe, expect, it } from "vitest";
import { ConfigSchema, type Config, type Module, type Op, type State, type TurnDraft } from "@book/schema";
import { applyDraft, coreModule, createInitialState, playerNotices, selectHighlights, settlePaidThreads, validateDraft } from "../src/index.ts";
import { driftStats } from "../src/drift.ts";
import { inferAt, normalizeDraft, resolveEntityId } from "../src/normalize.ts";

function config(): Config {
  return ConfigSchema.parse({
    id: "t",
    version: 1,
    meta: { title: "T", tone: "dry" },
    modules: ["core"],
    gm_style: { interludes: ["wobble"], rollback_note: "again" },
    presentation: { profile: "light", status_line: [] },
    time: { start: "2026-10-03T09:00" },
    stats: [
      { key: "cash", type: "currency", start: 45, display: "£" },
      { key: "energy", type: "bounded", min: 0, max: 100, start: 80, per_hour: -4, per_skip_hour: 12 },
    ],
    items: [
      { id: "milk", name: "Pint of milk", price: 1.3 },
      { id: "shears", name: "Garden shears", price: 9, keeps: true },
    ],
    seed: {
      entities: [
        { id: "player", type: "person", name: "You", location: "room" },
        { id: "1", type: "person", name: "Tomos Reed", location: "kitchen" },
        { id: "2", type: "person", name: "Aisha Khan", location: "shared-house" },
        { id: "shared-house", type: "place", name: "The house on the Uplands road", aliases: ["the house", "inside", "home"] },
        { id: "garden", type: "place", name: "The back garden", aliases: ["garden", "outside"] },
        { id: "room", type: "place", name: "Your room", location: "shared-house" },
        { id: "kitchen", type: "place", name: "The kitchen", location: "shared-house" },
        { id: "living-room", type: "place", name: "The living room", location: "shared-house" },
        { id: "pub", type: "place", name: "The pub" },
        { id: "bay-cafe", type: "place", name: "The bay cafe" },
        { id: "corner-shop", type: "place", name: "The corner shop" },
      ],
    },
  });
}

const statsModule: Module = {
  id: "stats",
  ops: ["stat.add", "stat.set"],
  initState: () => ({ values: { cash: 45, energy: 80 } }),
  validateOp: () => [],
  applyOp(op: Op, state: State): State {
    if (op.op !== "stat.add" && op.op !== "stat.set") return state;
    const next = structuredClone(state);
    const stats = (next.modules.stats as { values: Record<string, number> } | undefined) ?? { values: {} };
    next.modules.stats = stats;
    const current = stats.values[op.key] ?? 0;
    stats.values[op.key] = op.op === "stat.add" ? current + op.amount : op.value;
    return next;
  },
  promptFragment: () => "",
  focus: () => [],
  due: () => [],
  snapshot: () => [],
  render: () => ({}),
};

const modules = [coreModule, statsModule];

const draft = (over: Partial<TurnDraft> = {}): TurnDraft => ({
  narration: "You stay where you are.",
  delta: [],
  beat: "Nothing moves.",
  ...over,
});

function fresh(): State {
  return createInitialState(config(), modules, "s1");
}

describe("entity ids the model wrote for people already in the save", () => {
  it("resolves a name slug and a lone first name to the slot", () => {
    const state = fresh();
    expect(resolveEntityId(state, "tomos-reed")).toBe("1");
    expect(resolveEntityId(state, "tomos")).toBe("1");
    expect(resolveEntityId(state, "aisha_khan")).toBe("2");
    expect(resolveEntityId(state, "1")).toBe("1");
    expect(resolveEntityId(state, "danny")).toBeNull();
  });

  it("turns a duplicate entity.create into facts on the slot and follows the id through the delta", () => {
    const state = fresh();
    const d = draft({
      delta: [
        { op: "entity.create", id: "tomos-reed", type: "person", name: "Tomos Reed", location: "kitchen", facts: ["Works Saturdays at the supermarket."] },
        { op: "entity.fact.add", id: "tomos-reed", fact: "Asked you to the shops." },
        { op: "entity.move", id: "tomos-reed", location: "living-room" },
        { op: "thread.open", kind: "goal", text: "Help Tomos with the garden before Monday.", entities: ["tomos-reed", "player"], due: "2026-10-05T10:00" },
      ],
    });
    const res = validateDraft(state, config(), modules, d);
    expect(res.violations).toEqual([]);
    expect(d.delta.map((op) => (op as { op: string }).op)).toEqual(["entity.fact.add", "entity.move", "entity.fact.add", "entity.move", "thread.open"]);
    const next = applyDraft(state, config(), modules, d, { input: "chat", due: [] });
    expect(next.entities["tomos-reed"]).toBeUndefined();
    expect(next.entities["1"]?.location).toBe("living-room");
    expect(next.entities["1"]?.facts.map((f) => f.text)).toContain("Works Saturdays at the supermarket.");
    expect(next.threads[0]?.entities).toEqual(["1", "player"]);
  });

  it("leaves a genuinely new person alone", () => {
    const state = fresh();
    const d = draft({
      delta: [
        { op: "entity.create", id: "danny", type: "person", name: "Danny", location: "bay-cafe" },
        { op: "entity.fact.add", id: "danny", fact: "Runs the cafe." },
      ],
    });
    expect(validateDraft(state, config(), modules, d).violations).toEqual([]);
    expect(d.delta).toHaveLength(2);
  });

  it("creates a new person before the ops that refer to them", () => {
    const state = fresh();
    const d = draft({
      delta: [
        { op: "thread.open", kind: "goal", text: "Derek offered trial shifts, Mon to Wed evenings.", entities: ["derek-cornershop"] },
        { op: "entity.create", id: "derek-cornershop", type: "person", name: "Derek", location: "bay-cafe" },
      ],
    });
    expect(validateDraft(state, config(), modules, d).violations).toEqual([]);
    expect((d.delta[0] as { op: string }).op).toBe("entity.create");
  });
});

describe("threads the model wrote loosely", () => {
  it("reads kind potential as a goal that is an offer", () => {
    const d = draft({ delta: [{ op: "thread.open", kind: "potential", text: "Priya could put in a word at the cafe." }] });
    expect(validateDraft(fresh(), config(), modules, d).violations).toEqual([]);
    expect(d.delta[0]).toMatchObject({ kind: "goal", scale: "potential" });
  });

  it("turns a repeat of an open thread into contact with that thread", () => {
    const state = fresh();
    const opened = applyDraft(
      state,
      config(),
      modules,
      draft({ delta: [{ op: "thread.open", kind: "goal", text: "Meet Danny at the bay cafe on Tuesday afternoon to discuss barista work", scale: "minor", due: "2026-10-06T14:00" }] }),
      { input: "text priya", due: [] },
    );
    const d = draft({
      delta: [{ op: "thread.open", kind: "goal", text: "Prepare for and attend the barista interview with Danny at the bay cafe on Tuesday afternoon", due: "2026-10-06T14:00" }],
    });
    expect(validateDraft(opened, config(), modules, d).violations).toEqual([]);
    expect(d.delta).toEqual([{ op: "thread.adopt", id: "t1", scale: "minor" }]);
  });

  it("drops an adopt or resolve of a thread id that does not exist", () => {
    const d = draft({ delta: [{ op: "thread.adopt", id: "t63", scale: "minor" }, { op: "thread.resolve", id: "t9" }, { op: "clock.advance", minutes: 2 }] });
    expect(validateDraft(fresh(), config(), modules, d).violations).toEqual([]);
    expect(d.delta).toEqual([{ op: "clock.advance", minutes: 2 }]);
  });

  it("settles a thread when the player pays for the matter it is about", () => {
    const state = fresh();
    state.threads.push({
      id: "t1",
      kind: "commitment",
      text: "Mobile plan renews and the cheap introductory rate ends. Need to cancel or switch before it locks in.",
      status: "open",
      entities: ["player"],
      scale: "minor",
      was_major: false,
      warm: true,
      reminders: 0,
      last_shown_turn: 0,
      last_interacted_turn: 0,
      opened_turn: 0,
    });
    settlePaidThreads(state, config(), [{ op: "stat.add", key: "cash", amount: -8, reason: "Budget mobile plan switch" }], 3);
    expect(state.threads[0]?.status).toBe("resolved");
    const untouched = fresh();
    untouched.threads.push({ ...state.threads[0]!, status: "open" });
    settlePaidThreads(untouched, config(), [{ op: "stat.add", key: "cash", amount: -3, reason: "Chips" }], 3);
    expect(untouched.threads[0]?.status).toBe("open");
    const wages = fresh();
    wages.threads.push({ ...state.threads[0]!, status: "open", text: "Corner shop shift tomorrow at 16:00 for three hours. Derek will cash you out." });
    settlePaidThreads(wages, config(), [{ op: "stat.add", key: "cash", amount: 43, reason: "Corner shop shift, 3h 45m" }], 3);
    expect(wages.threads[0]?.status).toBe("resolved");
  });
});

describe("the place the sentence sits in", () => {
  it("fills at from one place the player is put in after in, to, or at", () => {
    const d = draft({ narration: "You head downstairs. You find Owen at the table in the kitchen, nursing a mug." });
    inferAt(fresh(), config(), d);
    expect(d.at).toBe("kitchen");
    const moved = draft({ narration: "You head downstairs to the kitchen. Tomos is still prowling in the living room." });
    inferAt(fresh(), config(), moved);
    expect(moved.at).toBe("kitchen");
  });

  it("leaves at alone when the sentence is not about the player, when the GM set it, or when a place is only talked about", () => {
    const scenery = draft({ narration: "You head downstairs. The house is quiet except for the kettle clicking off in the kitchen." });
    inferAt(fresh(), config(), scenery);
    expect(scenery.at).toBeUndefined();
    const listing = draft({ narration: "You open the job apps. There's a shift listed at the corner shop starting tomorrow at 16:00. You sip your tea." });
    inferAt(fresh(), config(), listing);
    expect(listing.at).toBeUndefined();
    const set = draft({ narration: "You walk into the kitchen.", at: "living-room" });
    inferAt(fresh(), config(), set);
    expect(set.at).toBe("living-room");
    const talk = draft({ narration: "You text Priya about the bay cafe and whether Danny is around." });
    inferAt(fresh(), config(), talk);
    expect(talk.at).toBeUndefined();
    const here = draft({ narration: "You sit in your room and read." });
    inferAt(fresh(), config(), here);
    expect(here.at).toBeUndefined();
    const recalled = draft({ narration: "Aisha glances up. 'You and me went to the kitchen on Saturday. That's about it.'" });
    inferAt(fresh(), config(), recalled);
    expect(recalled.at).toBeUndefined();
  });

  it("hears a bare alias after a verb of going, so inside and home are places the book names", () => {
    const state = fresh();
    state.entities.player!.location = "garden";
    const inside = draft({ narration: "You wipe the shears and head inside, scratched and tired." });
    inferAt(state, config(), inside);
    expect(inside.at).toBe("shared-house");
    const home = draft({ narration: "You finish the pint and walk home through the quiet streets." });
    const atPub = fresh();
    atPub.entities.player!.location = "pub";
    inferAt(atPub, config(), home);
    expect(home.at).toBe("shared-house");
    const already = draft({ narration: "You head inside to the kettle." });
    inferAt(fresh(), config(), already);
    expect(already.at).toBeUndefined();
  });

  it("moves the player when the inferred place passes through the turn", () => {
    const state = fresh();
    const d = draft({ narration: "You pad through to the kitchen and put the kettle on.", delta: [{ op: "clock.advance", minutes: 5 }] });
    expect(validateDraft(state, config(), modules, d).violations).toEqual([]);
    const next = applyDraft(state, config(), modules, d, { input: "make tea", due: [] });
    expect(next.entities.player?.location).toBe("kitchen");
  });
});

describe("stats that move with the clock", () => {
  const values = (state: State) => (state.modules.stats as { values: Record<string, number> }).values;

  it("drains energy over hours awake and restores it over a skip", () => {
    const awake = fresh();
    driftStats(awake, config(), { minutes: 120, skipped: 0, anchored: false, applied: [] });
    expect(values(awake).energy).toBe(72);
    const slept = fresh();
    driftStats(slept, config(), { minutes: 0, skipped: 480, anchored: false, applied: [] });
    expect(values(slept).energy).toBe(100);
  });

  it("does not drain a turn the GM already priced, or one set to an exact time", () => {
    const nap = fresh();
    driftStats(nap, config(), { minutes: 120, skipped: 0, anchored: false, applied: [{ op: "stat.add", key: "energy", amount: 30 }] });
    expect(values(nap).energy).toBe(80);
    const chores = fresh();
    driftStats(chores, config(), { minutes: 180, skipped: 0, anchored: false, applied: [{ op: "stat.add", key: "energy", amount: -20 }] });
    expect(values(chores).energy).toBe(80);
    const anchored = fresh();
    driftStats(anchored, config(), { minutes: 300, skipped: 0, anchored: true, applied: [] });
    expect(values(anchored).energy).toBe(80);
  });

  it("applies through applyDraft", () => {
    const next = applyDraft(fresh(), config(), modules, draft({ delta: [{ op: "clock.advance", minutes: 60 }] }), { input: "weed the garden", due: [] });
    expect(values(next).energy).toBe(76);
  });
});

describe("notices", () => {
  it("names an overdue thread in the player's words and drops one the turn resolved", () => {
    const state = fresh();
    state.threads.push(
      { id: "t1", kind: "commitment", text: "Shift at the corner shop at 16:00.", status: "resolved", entities: [], scale: "minor", was_major: false, warm: true, reminders: 0, last_shown_turn: 0, last_interacted_turn: 0, opened_turn: 0 },
      { id: "t2", kind: "commitment", text: "Return the mower by four.", status: "open", entities: [], scale: "minor", was_major: false, warm: true, reminders: 0, last_shown_turn: 0, last_interacted_turn: 0, opened_turn: 0 },
    );
    const due = [
      { id: "overdue:t1", kind: "scheduled" as const, text: "gm text one", entities: [] },
      { id: "overdue:t2", kind: "scheduled" as const, text: "gm text two", entities: [] },
      { id: "broke", kind: "conditional" as const, text: "You are nearly broke.", entities: [] },
    ];
    expect(playerNotices(due, state)).toEqual(['The deadline has passed on "Return the mower by four.".', "You are nearly broke."]);
  });
});

describe("highlights", () => {
  it("marks a new name and skips words that only open a quotation, a dash clause, or a sentence", () => {
    const narration =
      "'Alright,' Tomos says. '—I'm knackered.' You ask about work. 'Residential place out toward Sketty,' Aisha says. 'Three days a week.' Owen's mug is on the side. Priya replies within a minute.";
    const picked = selectHighlights(narration, ["Alright", "I'm", "Three", "Sketty", "Owen's", "Tomos", "Residential"], fresh(), config());
    expect(picked).toEqual(["Sketty", "Owen"]);
    expect(selectHighlights("Derek says the students come in Thursdays.", ["Thursdays"], fresh(), config())).toEqual([]);
  });

  it("keeps a listed name that opens a plain sentence", () => {
    const picked = selectHighlights("You pass Cerys. Seren waves from the door.", ["Seren", "Cerys", "and"], fresh(), config());
    expect(picked).toEqual(["Seren", "Cerys"]);
  });
});

describe("a long advance", () => {
  it("becomes a skip when it fits the night, and stays a jump when it does not", () => {
    const night = draft({
      narration: "You sleep.",
      delta: [{ op: "clock.advance", minutes: 540 }],
    });
    expect(validateDraft(fresh(), config(), [coreModule], night, "Sleep until morning").violations).toEqual([]);
    expect(night.delta[0]).toMatchObject({ op: "clock.skip", minutes: 540, reason: "elapsed" });

    const week = draft({ narration: "A week passes.", delta: [{ op: "clock.advance", minutes: 2000 }] });
    expect(validateDraft(fresh(), config(), [coreModule], week, "Wait").violations.map((v) => v.code)).toContain("time_jump");
    expect(week.delta[0]).toMatchObject({ op: "clock.advance", minutes: 2000 });
  });
});

describe("the whole pass", () => {
  it("runs every tidy-up before validation", () => {
    const state = fresh();
    const d = draft({
      narration: "You find Aisha in the kitchen and hand over the milk.",
      delta: [
        { op: "entity.fact.add", id: "aisha-khan", fact: "Took the milk." },
        { op: "thread.adopt", id: "t42", scale: "minor" },
      ],
    });
    normalizeDraft(state, config(), d);
    expect(d.delta).toEqual([{ op: "entity.fact.add", id: "2", fact: "Took the milk." }]);
    expect(d.at).toBe("kitchen");
  });
});
