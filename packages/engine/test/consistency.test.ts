import { describe, expect, it } from "vitest";
import { ConfigSchema, type Config, type Module, type Op, type State, type TurnDraft, type Violation } from "@book/schema";
import { applyDraft, coreModule, createInitialState, processOps, validateDraft, weekAheadLine } from "../src/index.ts";

function config(): Config {
  return ConfigSchema.parse({
    id: "t",
    version: 1,
    meta: { title: "T", tone: "dry" },
    modules: ["core"],
    gm_style: { interludes: ["wobble"], rollback_note: "again" },
    presentation: { profile: "light", status_line: [] },
    time: { start: "2026-10-03T09:00" },
    stats: [{ key: "money", type: "currency", start: 45, display: "£" }],
    items: [
      { id: "pint", name: "Pint of lager", price: 4.5 },
      { id: "milk", name: "Pint of milk", price: 1.3 },
      { id: "oat-milk", name: "Carton of oat milk", price: 1.75 },
      { id: "sausage-egg-cob", name: "Sausage and egg cob", price: 4.2 },
      { id: "business-textbook", name: "Business textbook", price: 28 },
      { id: "rum-cask", name: "Cask of rum", price: 12 },
    ],
    seed: {
      entities: [
        { id: "player", type: "person", name: "You", location: "room" },
        { id: "room", type: "place", name: "Box room" },
        { id: "kitchen", type: "place", name: "The kitchen" },
        { id: "shared-house", type: "place", name: "The house on the Uplands road" },
        { id: "pub", type: "place", name: "The pub" },
        { id: "seafront", type: "place", name: "The seafront" },
      ],
    },
  });
}

const draft = (over: Partial<TurnDraft> = {}): TurnDraft => ({
  narration: "You stay where you are.",
  delta: [],
  beat: "Nothing moves.",
  ...over,
});

function carrying(state: State): State {
  return {
    ...state,
    modules: { ...state.modules, inventory: { owners: { player: { "oat-milk": 1, "sausage-egg-cob": 1 } } } },
  };
}

function fresh(): State {
  return carrying(createInitialState(config(), [coreModule], "s1"));
}

const inventoryModule: Module = {
  id: "inventory",
  ops: ["inventory.add", "inventory.remove"],
  initState: () => ({ owners: {} }),
  validateOp(op: Op, index: number, state: State): Violation[] {
    if (op.op !== "inventory.remove") return [];
    const inv = state.modules.inventory as { owners?: Record<string, Record<string, number>> };
    const have = inv.owners?.[op.owner]?.[op.item] ?? 0;
    if (have < op.qty) {
      return [{ severity: "game_breaking", code: "item_not_owned", op_index: index, message: "missing" }];
    }
    return [];
  },
  applyOp(op: Op, state: State): State {
    if (op.op !== "inventory.add" && op.op !== "inventory.remove") return state;
    const next = structuredClone(state);
    const inv = (next.modules.inventory as { owners: Record<string, Record<string, number>> } | undefined) ?? {
      owners: {},
    };
    next.modules.inventory = inv;
    const bag = (inv.owners[op.owner] ??= {});
    const qty = (bag[op.item] ?? 0) + (op.op === "inventory.add" ? op.qty : -op.qty);
    if (qty <= 0) delete bag[op.item];
    else bag[op.item] = qty;
    return next;
  },
  promptFragment: () => "",
  focus: () => [],
  due: () => [],
  snapshot: () => [],
  render: () => ({}),
};

const statsModule: Module = {
  id: "stats",
  ops: ["stat.add", "stat.set"],
  initState: () => ({ values: { money: 45 } }),
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

const modules = [coreModule, inventoryModule, statsModule];

describe("travel and place", () => {
  it("rejects a move to an existing place that is not where the player asked to go", () => {
    const res = validateDraft(
      fresh(),
      config(),
      modules,
      draft({
        narration: "You sit on a bench by the water and watch the bay.",
        delta: [{ op: "entity.move", id: "player", location: "shared-house" }],
      }),
      "I walk down to the seafront",
    );
    expect(res.violations.map((v) => v.code)).toContain("arrived_elsewhere");
    expect(res.violations.find((v) => v.code === "arrived_elsewhere")?.severity).toBe("fixable");
  });

  it("allows the first refusal, and treats the next one as breaking the game", () => {
    const cfg = config();
    const stayed = draft({ narration: "You're still in the kitchen. The garden can wait." });
    expect(validateDraft(fresh(), cfg, modules, stayed, "Walk to the garden").violations).toEqual([]);

    const again = fresh();
    again.window = [
      {
        turn: 1,
        input: "Walk to the garden",
        narration: "You're still in the kitchen. It can wait.",
        clock: "2026-10-03T09:10",
      },
    ];
    const res = validateDraft(again, cfg, modules, stayed, "Walk to the garden again");
    expect(res.violations).toHaveLength(1);
    expect(res.violations[0]).toMatchObject({ code: "trip_insisted", severity: "game_breaking" });
  });

  it("accepts a new place created for a vague destination, and a move whose name matches", () => {
    const cfg = config();
    const created = validateDraft(
      fresh(),
      cfg,
      modules,
      draft({
        narration: "The nearest shop is a Sainsbury's, and the doors are open.",
        delta: [
          { op: "entity.create", id: "sainsburys-local", type: "place", name: "Sainsbury's Local" },
          { op: "entity.move", id: "player", location: "sainsburys-local" },
        ],
      }),
      "Walk to the nearest shop",
    );
    expect(created.violations).toEqual([]);

    const kitchen = validateDraft(
      fresh(),
      cfg,
      modules,
      draft({
        narration: "The kettle is on.",
        delta: [{ op: "entity.move", id: "player", location: "kitchen" }],
      }),
      "Go to the kitchen",
    );
    expect(kitchen.violations).toEqual([]);
  });

  it("does not treat a person or a vague direction as a trip, and still counts a place the book names", () => {
    const cfg = config();
    const state = fresh();
    const sample = state.entities.player;
    if (!sample) throw new Error("player missing");
    state.entities.connor = { ...sample, id: "connor", name: "Connor", aliases: [] };
    expect(
      validateDraft(state, cfg, modules, draft({ narration: "Connor is still by the fence." }), "Go back out to Connor").violations,
    ).toEqual([]);
    expect(validateDraft(state, cfg, modules, draft({ narration: "The high street is busy." }), "Walk into town").violations).toEqual([]);

    const named = fresh();
    named.entities.town = { ...sample, id: "town", type: "place", name: "Town", aliases: [], location: null };
    expect(
      validateDraft(named, cfg, modules, draft({ narration: "You stay in the room." }), "Walk into town").violations.map((v) => v.code),
    ).toContain("arrived_elsewhere");
  });

  it("treats going to bed as the bedroom, and only when the player is already there", () => {
    const cfg = config();
    const inBed = fresh();
    inBed.entities.room = { ...inBed.entities.room!, aliases: ["bedroom"] };
    expect(
      validateDraft(inBed, cfg, modules, draft({ narration: "The kettle clicks off." }), "Go up to bed").violations,
    ).toEqual([]);

    const elsewhere = validateDraft(
      fresh(),
      cfg,
      modules,
      draft({ narration: "The kettle clicks off." }),
      "Go up to bed",
    );
    expect(elsewhere.violations.map((v) => v.code)).toContain("arrived_elsewhere");
  });

  it("uses the last destination, and does not treat a suggestion as a trip", () => {
    const start = fresh();
    start.entities.player = { ...start.entities.player!, location: "pub" };
    const arrived = validateDraft(
      start,
      config(),
      modules,
      draft({
        narration: "The bay is grey.",
        delta: [{ op: "entity.move", id: "player", location: "seafront" }],
      }),
      "I leave the pub and walk to the seafront",
    );
    expect(arrived.violations).toEqual([]);

    const suggestion = validateDraft(
      fresh(),
      config(),
      modules,
      draft({ narration: "You mention the pub." }),
      "I suggest the pub",
    );
    expect(suggestion.violations).toEqual([]);
  });

  it("reads 'then walk home' as the end of a round trip, checked against the place the book calls home", () => {
    const cfg = config();
    const house = cfg.seed.entities.find((e) => e.id === "shared-house")!;
    house.aliases = ["home", "inside"];
    const kitchen = cfg.seed.entities.find((e) => e.id === "kitchen")!;
    kitchen.location = "shared-house";
    const start = createInitialState(cfg, modules, "s1");
    start.entities.player = { ...start.entities.player!, location: "kitchen" };

    const home = validateDraft(
      start,
      cfg,
      modules,
      draft({ narration: "You finish up and let yourself back into the house. The kitchen is quiet.", at: "kitchen" }),
      "Walk to the pub and buy a pint, then walk home",
    );
    expect(home.violations).toEqual([]);

    const stayed = validateDraft(
      start,
      cfg,
      modules,
      draft({ narration: "You stay at the bar.", delta: [{ op: "entity.move", id: "player", location: "pub" }] }),
      "Go to the pub, then head back inside",
    );
    expect(stayed.violations.map((v) => v.code)).toEqual(["arrived_elsewhere"]);
    expect(stayed.violations[0]?.message).toContain("come back inside");

    const outing = validateDraft(
      start,
      cfg,
      modules,
      draft({ narration: "You walk down to the seafront. The bay is grey." }),
      "Walk to the seafront and come back",
    );
    expect(outing.violations).toEqual([]);
  });

  it("stops a trip at the place and leaves the errand out of the destination", () => {
    const shop = validateDraft(
      fresh(),
      config(),
      modules,
      draft({ narration: "The bell over the door rings." }),
      "I walk to the corner shop for a sausage and egg cob",
    );
    const shopMessage = shop.violations.find((v) => v.code === "arrived_elsewhere")?.message ?? "";
    expect(shopMessage).toContain('go to "corner shop"');
    expect(shopMessage).not.toContain("sausage");

    const errand = validateDraft(fresh(), config(), modules, draft({ narration: "You head for the counter." }), "Walk to the shop to buy milk");
    const errandMessage = errand.violations.find((v) => v.code === "arrived_elsewhere")?.message ?? "";
    expect(errandMessage).toContain('go to "shop"');
    expect(errandMessage).not.toContain("milk");

    const pint = validateDraft(fresh(), config(), modules, draft({ narration: "You stay in." }), "Go for a pint");
    expect(pint.violations.map((v) => v.code)).not.toContain("arrived_elsewhere");
  });

  it("keeps checking a phone in the room, and cuts the clause after the place", () => {
    const cfg = config();
    const checking = validateDraft(
      fresh(),
      cfg,
      modules,
      draft({ narration: "You stay in the room and look at the screen." }),
      "Go in the house to check my phone",
    );
    expect(checking.violations).toEqual([]);

    const coop = validateDraft(
      fresh(),
      cfg,
      modules,
      draft({ narration: "You say sorry on the way out." }),
      "Polish it off and go to coop as I leave say to the lad sorry I didn't catch your name",
    );
    const coopMessage = coop.violations.find((v) => v.code === "arrived_elsewhere")?.message ?? "";
    expect(coopMessage).toContain('go to "coop"');
    expect(coopMessage).not.toContain("lad");

    const shower = validateDraft(fresh(), cfg, modules, draft({ narration: "You stay on the sofa." }), "Go to the shower and get changed");
    expect(shower.violations.find((v) => v.code === "arrived_elsewhere")?.message ?? "").toContain('go to "shower"');

    const garden = validateDraft(fresh(), cfg, modules, draft({ narration: "You stay put." }), "I leave to the garden");
    expect(garden.violations.find((v) => v.code === "arrived_elsewhere")?.message ?? "").toContain('go to "garden"');
  });

  it("treats a voyage as a trip only when the book lists those words", () => {
    const plain = config();
    const ignored = validateDraft(fresh(), plain, modules, draft({ narration: "The bay stays grey." }), "Sail to the kitchen");
    expect(ignored.violations).toEqual([]);

    const cfg: Config = {
      ...plain,
      travel: {
        ...plain.travel,
        journeys: ["sail", "set a course", "weigh anchor", "make port"],
        local: ["rail", "deck", "helm", "hold", "cabin"],
      },
    };
    const sail = validateDraft(fresh(), cfg, modules, draft({ narration: "The bay stays grey." }), "Sail to the kitchen");
    expect(sail.violations.map((v) => v.code)).toContain("arrived_elsewhere");
    const course = validateDraft(
      fresh(),
      cfg,
      modules,
      draft({ narration: "The bay stays grey." }),
      "Set a course for the seafront",
    );
    expect(course.violations.map((v) => v.code)).toContain("arrived_elsewhere");
    const supplies = validateDraft(
      fresh(),
      cfg,
      modules,
      draft({ narration: "The bay stays grey." }),
      "Sail for the harbour for water",
    );
    expect(supplies.violations.find((v) => v.code === "arrived_elsewhere")?.message ?? "").toContain('go to "harbour"');
    expect(supplies.violations.find((v) => v.code === "arrived_elsewhere")?.message ?? "").not.toContain("water");

    const rail = validateDraft(
      fresh(),
      cfg,
      modules,
      draft({ narration: "You watch the wake and do not change course." }),
      "I go to the rail and watch the wake. I do not change course.",
    );
    expect(rail.violations).toEqual([]);

    const stepped = validateDraft(
      fresh(),
      plain,
      modules,
      draft({ narration: "You watch the wake and do not change course." }),
      "I go to the rail and watch the wake.",
    );
    expect(stepped.violations.map((v) => v.code)).toContain("arrived_elsewhere");
  });

  it("moves the player when the draft sets at, and leaves a turn with no at where it is", () => {
    const cfg = config();
    const told = draft({ at: "kitchen" });
    expect(validateDraft(fresh(), cfg, modules, told, "Look around").violations).toEqual([]);
    const moved = applyDraft(fresh(), cfg, modules, told, { input: "Look around", due: [] });
    expect(moved.entities.player?.location).toBe("kitchen");

    const notAPlace = validateDraft(fresh(), cfg, modules, draft({ at: "player" }), "Look around");
    expect(notAPlace.violations.map((v) => v.code)).toEqual(["location_mismatch"]);

    expect(validateDraft(fresh(), cfg, modules, draft(), "Look around").violations).toEqual([]);
  });

  it("hears the kitchen after the house, and does not treat sleep as a place", () => {
    const cfg = config();
    const input = "I walk back to the house and go into the kitchen.";
    const narration = "The kitchen is empty, the fridge humming to itself.";
    const missed = validateDraft(fresh(), cfg, modules, draft({ narration }), input);
    const travel = missed.violations.find((v) => v.code === "arrived_elsewhere");
    expect(travel?.message).toContain('go to "kitchen"');
    expect(travel?.message).not.toContain('go to "house"');

    const arrived = validateDraft(
      fresh(),
      cfg,
      modules,
      draft({ narration, delta: [{ op: "entity.move", id: "player", location: "kitchen" }] }),
      input,
    );
    expect(arrived.violations).toEqual([]);

    const sleep = validateDraft(
      fresh(),
      cfg,
      modules,
      draft({ narration: "You pull the duvet up and sleep." }),
      "I go to sleep.",
    );
    expect(sleep.violations).toEqual([]);

    const wandered = validateDraft(
      fresh(),
      cfg,
      modules,
      draft({ narration: "You head into the kitchen and fill the kettle." }),
      "I look around.",
    );
    expect(wandered.violations.filter((v) => v.code === "arrived_elsewhere")).toEqual([]);

    const settled = draft({ narration: "You settle in the living room.", at: "living-room" });
    const settledCheck = validateDraft(fresh(), cfg, modules, settled, "I look around.");
    expect(settledCheck.violations).toEqual([]);
    const settledState = applyDraft(fresh(), cfg, modules, settled, { input: "I look around.", due: [] });
    expect(settledState.entities.player?.location).toBe("living-room");
    expect(settledState.entities["living-room"]?.name).toBe("Living Room");

    const followed = validateDraft(
      fresh(),
      cfg,
      modules,
      draft({
        narration: "You head into the kitchen and fill the kettle.",
        delta: [{ op: "entity.move", id: "player", location: "kitchen" }],
      }),
      "I look around.",
    );
    expect(followed.violations).toEqual([]);

    const someoneElse = validateDraft(
      fresh(),
      cfg,
      modules,
      draft({ narration: "Dai heads to the pub. You stay by the window." }),
      "I look around.",
    );
    expect(someoneElse.violations).toEqual([]);

    const library = validateDraft(
      fresh(),
      cfg,
      modules,
      draft({ narration: "You head into the library and take a desk." }),
      "I look around.",
    );
    expect(library.violations.filter((v) => v.code === "arrived_elsewhere")).toEqual([]);

    const onTime = validateDraft(
      fresh(),
      cfg,
      modules,
      draft({
        narration: "The clock reads 09:47.",
        delta: [{ op: "clock.advance", minutes: 47 }],
      }),
      "I look around.",
    );
    expect(onTime.violations).toEqual([]);

    const wrongTime = validateDraft(
      fresh(),
      cfg,
      modules,
      draft({
        narration: "The clock reads 09:47.",
        delta: [{ op: "clock.advance", minutes: 10 }],
      }),
      "I look around.",
    );
    expect(wrongTime.violations.find((v) => v.code === "clock_mismatch")?.message).toContain("47");

    const alarm = validateDraft(
      fresh(),
      cfg,
      modules,
      draft({
        narration: "You set an alarm for 08:00 and stay put.",
        delta: [{ op: "clock.advance", minutes: 1 }],
      }),
      "I set an alarm.",
    );
    expect(alarm.violations.filter((v) => v.code === "clock_mismatch")).toEqual([]);

    const earlier = validateDraft(
      fresh(),
      cfg,
      modules,
      draft({
        narration: "The clock reads 08:00.",
        delta: [{ op: "clock.set", now: "2026-10-03T08:00" }],
      }),
      "I look around.",
    );
    expect(earlier.violations).toEqual([]);
    const earlierState = applyDraft(
      fresh(),
      cfg,
      modules,
      draft({ narration: "The clock reads 08:00.", delta: [{ op: "clock.set", now: "2026-10-03T08:00" }] }),
      { input: "I look around.", due: [] },
    );
    expect(earlierState.clock.now).toBe("2026-10-03T08:00");

    const toldEarlier = validateDraft(
      fresh(),
      cfg,
      modules,
      draft({ narration: "The clock reads 08:00.", delta: [{ op: "clock.advance", minutes: 1 }] }),
      "I look around.",
    );
    expect(toldEarlier.violations.find((v) => v.code === "clock_mismatch")?.message).toContain("clock.set");

    const free = validateDraft(
      fresh(),
      cfg,
      modules,
      draft({
        narration: "The switch costs nothing.",
        delta: [{ op: "stat.add", key: "money", amount: -12.5, reason: "plan" }],
      }),
      "I look around.",
    );
    expect(free.violations.find((v) => v.code === "free_charge")?.message).toContain("money");

    const bedState = fresh();
    const room = bedState.entities.room;
    if (!room) throw new Error("room missing");
    bedState.entities.bed = { ...room, id: "bed", name: "Your bed", aliases: [] };
    const missedBed = validateDraft(bedState, cfg, modules, draft({ narration: "You stay in the room." }), "I go to bed");
    expect(missedBed.violations.find((v) => v.code === "arrived_elsewhere")?.message).toContain('go to "bed"');
    const inBed = validateDraft(
      bedState,
      cfg,
      modules,
      draft({
        narration: "You get into bed.",
        delta: [{ op: "entity.move", id: "player", location: "bed" }],
      }),
      "I go to bed",
    );
    expect(inBed.violations).toEqual([]);
  });

  it("reads the clock from the scene, not from a message stamp, an appointment, or quoted words", () => {
    const cfg = config();
    const clockOf = (narration: string, minutes = 10) =>
      validateDraft(fresh(), cfg, modules, draft({ narration, delta: [{ op: "clock.advance", minutes }] }), "I look.").violations.filter(
        (v) => v.code === "clock_mismatch",
      );
    expect(clockOf("A text from mum, sent at 08:47 this morning, asks if you are eating.")).toEqual([]);
    expect(clockOf("A notification from Priya sits at the top, timestamped 14:22 this afternoon.")).toEqual([]);
    expect(clockOf("Priya's message reads: 'Tuesday 14:30 work? The Waterfront Cafe. Let me know.' Tuesday, 2:30 PM. That's solid.")).toEqual([]);
    expect(clockOf("The interview is tomorrow at 14:00, so you lay out a shirt.")).toEqual([]);
    expect(clockOf("The inspection window opens at 10:00; you have time.")).toEqual([]);
    expect(clockOf("At 10:04, a sharp knock.")[0]?.message).toContain("10:04");
    expect(clockOf("By 12:15 you're filing out into the corridor with everyone else.")[0]?.message).toContain("12:15");
  });

  it("reads six o'clock, half seven, and quarter to nine as clock times", () => {
    const cfg = config();
    const mismatch = (narration: string, at = "2026-10-03T09:00") => {
      const state = fresh();
      state.clock.now = at;
      return validateDraft(state, cfg, modules, draft({ narration, delta: [{ op: "clock.advance", minutes: 10 }] }), "I read.").violations.find(
        (v) => v.code === "clock_mismatch",
      );
    };
    expect(mismatch("The pages turn steadily. By six o'clock your eyes are tired.", "2026-10-03T16:24")?.message).toContain("18:00");
    expect(mismatch("You surface at half seven, groggy.")?.message).toContain("07:30");
    expect(mismatch("It is quarter to nine when the kettle clicks.")?.message).toContain("08:45");
    expect(mismatch("Owen has two essays due by Thursday and three quid for chips.")).toBeUndefined();
    expect(mismatch("Tomos says the pub does a quiz at eight o'clock tonight.")).toBeUndefined();
  });

  it("stops the place name where the company, the time, or the errand starts, and lets a suggestion stay put", () => {
    const cfg = config();
    const home = validateDraft(
      fresh(),
      cfg,
      modules,
      draft({ narration: "You walk back with Tomos and talk about the inspection.", at: "shared-house" }),
      "Walk back to the house with Tomos and ask him about the inspection on Monday",
    );
    expect(home.violations).toEqual([]);
    const bedState = fresh();
    bedState.entities.room!.aliases = ["bedroom"];
    const bed = validateDraft(
      bedState,
      cfg,
      modules,
      draft({ narration: "The film ends and you head up.", at: "room" }),
      "Put on a comedy and watch it with them, then head up to bed around eleven",
    );
    expect(bed.violations).toEqual([]);
    const pub = validateDraft(
      fresh(),
      cfg,
      modules,
      draft({ narration: "Tomos shakes his head. 'Early one for me, mate.' Owen has an essay. You stay in the kitchen." }),
      "Suggest we go to the pub tonight to celebrate the garden, my shout for the first round",
    );
    expect(pub.violations).toEqual([]);
    const asked = validateDraft(
      fresh(),
      cfg,
      modules,
      draft({ narration: "Tomos shrugs. You stay in the kitchen." }),
      "Go to the pub tonight",
    );
    expect(asked.violations.map((v) => v.code)).toContain("arrived_elsewhere");
  });

  it("keeps the trip inside one action and reads an errand after to as the errand", () => {
    const cfg = config();
    const gift = validateDraft(
      fresh(),
      cfg,
      modules,
      draft({ narration: "You hand Aisha the notes in the living room. She counts them.", at: "shared-house" }),
      "Walk home and give Aisha forty quid cash towards my sixty for the bills",
    );
    expect(gift.violations).toEqual([]);
    const look = validateDraft(
      fresh(),
      cfg,
      modules,
      draft({ narration: "You rinse the mug and step out. The garden sprawls untidy.", at: "back-garden", delta: [] }),
      "Wash up my mug and plate, then go out the back to have a look at the garden",
    );
    expect(look.violations.filter((v) => v.code === "arrived_elsewhere")).toEqual([]);
  });

  it("lets the narration name the time the turn began", () => {
    const res = validateDraft(
      fresh(),
      config(),
      modules,
      draft({ narration: "Your phone shows 09:00 when you wake. You shower and dress.", delta: [{ op: "clock.advance", minutes: 45 }] }),
      "Get up and shower",
    );
    expect(res.violations.filter((v) => v.code === "clock_mismatch")).toEqual([]);
  });

  it("does not treat a person still at a table as a refused trip", () => {
    const cfg = config();
    const narration = "You step back inside. Cerys is still at the table, tea cooling in front of her.";
    const input = "I go back into the kitchen and ask Cerys what the inspection checks";
    const missed = validateDraft(fresh(), cfg, modules, draft({ narration }), input);
    expect(missed.violations.map((v) => v.code)).toContain("arrived_elsewhere");

    const arrived = validateDraft(
      fresh(),
      cfg,
      modules,
      draft({ narration, delta: [{ op: "entity.move", id: "player", location: "kitchen" }] }),
      input,
    );
    expect(arrived.violations).toEqual([]);
  });
});

describe("catalog items", () => {
  it("requires a payment and an inventory add when the narration orders a pint", () => {
    const res = validateDraft(
      fresh(),
      config(),
      modules,
      draft({ narration: "You order two pints and sit down." }),
      "I'll have two pints",
    );
    expect(res.violations.map((v) => v.code)).toEqual(["unpaid_item"]);
    expect(res.violations[0]?.message).toContain("(pint)");
  });

  it("prices one lager as the pint, and leaves the milk and the four-pack out of the till", () => {
    const cfg: Config = {
      ...config(),
      items: [...config().items, { id: "lager-4-pack", name: "Lager 4-pack", price: 5 }],
    };
    const paid = validateDraft(
      fresh(),
      cfg,
      modules,
      draft({
        narration: "The barman pours one pint of lager.",
        delta: [
          { op: "stat.add", key: "money", amount: -4.5, reason: "Bought one pint of lager" },
          { op: "inventory.add", owner: "player", item: "pint", qty: 1 },
        ],
      }),
      "Order one lager and pay cash",
    );
    expect(paid.violations).toEqual([]);
  });

  it("does not buy an item the player already carries, and still buys another", () => {
    const cfg: Config = {
      ...config(),
      items: [...config().items, { id: "garden-gloves", name: "Garden gloves", price: 4 }],
    };
    const state = fresh();
    const inv = state.modules.inventory as { owners: Record<string, Record<string, number>> };
    inv.owners.player = { ...inv.owners.player, "garden-gloves": 1 };

    const restated = validateDraft(
      state,
      cfg,
      modules,
      draft({
        narration: "The gloves are already in the rucksack.",
        delta: [
          { op: "stat.add", key: "money", amount: -4, reason: "Paid for the gloves" },
          { op: "inventory.add", owner: "player", item: "garden-gloves", qty: 1 },
        ],
      }),
      "The gloves are already paid",
    );
    expect(restated.violations.map((v) => v.code)).toEqual(["already_owned"]);

    const repaid = validateDraft(
      state,
      cfg,
      modules,
      draft({
        narration: "You transfer the four pounds to Aisha for the gloves she lent you the money for.",
        delta: [{ op: "stat.add", key: "money", amount: -4, reason: "Paid Aisha back for the garden gloves" }],
      }),
      "Pay Aisha back for the gloves",
    );
    expect(repaid.violations).toEqual([]);

    const quiet = validateDraft(
      state,
      cfg,
      modules,
      draft({ narration: "You paid for the gloves earlier. You leave the strimmer on the counter." }),
      "The gloves are already paid",
    );
    expect(quiet.violations).toEqual([]);

    const another = validateDraft(
      state,
      cfg,
      modules,
      draft({
        narration: "You buy another pair of garden gloves.",
        delta: [
          { op: "stat.add", key: "money", amount: -4, reason: "another pair of garden gloves" },
          { op: "inventory.add", owner: "player", item: "garden-gloves", qty: 1 },
        ],
      }),
      "Buy another pair of gloves",
    );
    expect(another.violations).toEqual([]);
  });

  it("does not buy the phone, the wallet, or a coffee table, and a price is not a quantity", () => {
    const cfg: Config = {
      ...config(),
      items: [
        ...config().items,
        { id: "phone", name: "Phone (cracked corner)", keeps: true },
        { id: "wallet", name: "Wallet", price: 12, keeps: true },
        { id: "coffee", name: "Takeaway coffee", price: 2.6 },
        { id: "chicken-lettuce-sandwich", name: "Chicken and lettuce sandwich", price: 2.5 },
      ],
    };
    const state = fresh();
    const inv = state.modules.inventory as { owners: Record<string, Record<string, number>> };
    inv.owners.player = { ...inv.owners.player, phone: 1, wallet: 1 };
    delete inv.owners.player["sausage-egg-cob"];

    const lunch = validateDraft(
      state,
      cfg,
      modules,
      draft({
        narration:
          "You grab a chicken and lettuce sandwich for £2.50, pay from your wallet, and find a quiet corner with a coffee table.",
        delta: [
          { op: "stat.add", key: "money", amount: -2.5, reason: "Chicken and lettuce sandwich" },
          { op: "inventory.add", owner: "player", item: "chicken-lettuce-sandwich", qty: 1 },
        ],
      }),
      "Buy a sandwich",
    );
    expect(lunch.violations).toEqual([]);

    const menu = validateDraft(
      state,
      cfg,
      modules,
      draft({
        narration: "A board lists a sandwich, crisps, drink for £5.99. You grab a sausage and egg cob.",
        delta: [
          { op: "stat.add", key: "money", amount: -4.2, reason: "Sausage and egg cob" },
          { op: "inventory.add", owner: "player", item: "sausage-egg-cob", qty: 1 },
        ],
      }),
      "Buy a cob",
    );
    expect(menu.violations).toEqual([]);

    const pint = validateDraft(
      fresh(),
      cfg,
      modules,
      draft({
        narration: "You pay £4.50 for a pint of lager.",
        delta: [
          { op: "stat.add", key: "money", amount: -4.5, reason: "Pint of lager" },
          { op: "inventory.add", owner: "player", item: "pint", qty: 1 },
        ],
      }),
      "Buy a pint",
    );
    expect(pint.violations).toEqual([]);
  });

  it("treats setting a cob down as letting a good go, and leaves gear that is only set down", () => {
    const down = validateDraft(
      fresh(),
      config(),
      modules,
      draft({ narration: "You set down the cob and wipe your fingers." }),
      "Finish the cob",
    );
    expect(down.violations.map((v) => v.code)).toEqual(["item_still_held"]);

    const cfg: Config = { ...config(), items: [...config().items, { id: "shears", name: "Garden shears", keeps: true }] };
    const state = fresh();
    const inv = state.modules.inventory as { owners: Record<string, Record<string, number>> };
    inv.owners.player = { ...inv.owners.player, shears: 1 };
    expect(
      validateDraft(state, cfg, modules, draft({ narration: "You set down the shears." }), "Set the shears down").violations,
    ).toEqual([]);
  });

  it("requires a remove when the narration puts down something the player still holds", () => {
    const held = validateDraft(
      fresh(),
      config(),
      modules,
      draft({ narration: "You put the oat milk in the fridge." }),
      "Put the oat milk away",
    );
    expect(held.violations.map((v) => v.code)).toEqual(["item_still_held"]);

    const eaten = validateDraft(
      fresh(),
      config(),
      modules,
      draft({
        narration: "You ate the sausage and egg cob.",
        delta: [{ op: "inventory.remove", owner: "player", item: "sausage-egg-cob" }],
      }),
      "Eat the cob",
    );
    expect(eaten.violations).toEqual([]);
  });

  it("keeps a phone that is charging or sitting on the side, and still notices one left at the shop", () => {
    const cfg: Config = { ...config(), items: [...config().items, { id: "phone", name: "Phone" }] };
    const state = fresh();
    const inv = state.modules.inventory as { owners: Record<string, Record<string, number>> };
    inv.owners.player = { ...inv.owners.player, phone: 1, "business-textbook": 1 };

    expect(
      validateDraft(state, cfg, modules, draft({ narration: "You put the phone on charge." }), "Put my phone on charge").violations,
    ).toEqual([]);
    expect(
      validateDraft(state, cfg, modules, draft({ narration: "You left the phone on the side." }), "Left my phone on the side").violations,
    ).toEqual([]);
    expect(
      validateDraft(state, cfg, modules, draft({ narration: "You left the business textbook at the shop." }), "Look").violations.map(
        (v) => v.code,
      ),
    ).toEqual(["item_still_held"]);
    expect(
      validateDraft(state, cfg, modules, draft({ narration: "You hand her the oat milk." }), "Hand it over").violations.map((v) => v.code),
    ).toEqual(["item_still_held"]);
  });

  it("ignores a pint that can wait, a book left on the shelf, and a purchase the player cannot make", () => {
    const cfg = config();
    const state = fresh();
    expect(validateDraft(state, cfg, modules, draft({ narration: "The pint can wait." }), "Look").violations).toEqual([]);
    expect(
      validateDraft(state, cfg, modules, draft({ narration: "The textbook stays on the shelf." }), "Look").violations,
    ).toEqual([]);
    expect(
      validateDraft(state, cfg, modules, draft({ narration: "You can't buy a pint with what you have." }), "Look").violations,
    ).toEqual([]);
  });

  it("rejects a partial payment that does not put the item in the player's hands", () => {
    const cfg = config();
    const short = validateDraft(
      fresh(),
      cfg,
      modules,
      draft({
        narration: "You buy forty casks of rum and slap down what you have.",
        delta: [{ op: "stat.add", key: "money", amount: -6, reason: "attempted rum purchase with insufficient funds" }],
      }),
      "Buy forty casks of rum",
    );
    expect(short.violations.map((v) => v.code)).toEqual(["underpaid_item"]);
    expect(short.violations[0]?.message).toContain("rum-cask");
    expect(short.violations[0]?.message).toContain("due 480");

    const paid = validateDraft(
      fresh(),
      cfg,
      modules,
      draft({
        narration: "You buy a cask of rum.",
        delta: [
          { op: "stat.add", key: "money", amount: -12, reason: "rum" },
          { op: "inventory.add", owner: "player", item: "rum-cask", qty: 1 },
        ],
      }),
      "Buy a cask of rum",
    );
    expect(paid.violations).toEqual([]);

    const elsewhere = validateDraft(
      fresh(),
      cfg,
      modules,
      draft({
        narration: "You buy a cask of rum.",
        delta: [
          { op: "stat.add", key: "money", amount: -12, reason: "rum" },
          { op: "inventory.add", owner: "grace", item: "rum-cask", qty: 1 },
        ],
      }),
      "Buy a cask of rum",
    );
    expect(elsewhere.violations.map((v) => v.code)).toEqual(["unpaid_item"]);
  });
});

describe("charges the narration never stated", () => {
  it("rejects a charge for a catalog item the narration only uses", () => {
    const res = validateDraft(
      fresh(),
      config(),
      modules,
      draft({
        narration: "The milk pours pale into a mug, Owen's pint, as promised. You sit with Leah.",
        delta: [
          { op: "inventory.add", owner: "player", item: "milk", qty: 1 },
          { op: "stat.add", key: "money", amount: -1.3, reason: "Pint of milk" },
        ],
      }),
      "Make toast and a tea with Owen's milk",
    );
    expect(res.violations.map((v) => v.code)).toEqual(["unstated_charge"]);
    const bought = validateDraft(
      fresh(),
      config(),
      modules,
      draft({
        narration: "You pay for a pint of milk at the till and head back.",
        delta: [
          { op: "inventory.add", owner: "player", item: "milk", qty: 1 },
          { op: "stat.add", key: "money", amount: -1.3, reason: "Pint of milk" },
        ],
      }),
      "Nip to the shop for milk",
    );
    expect(bought.violations).toEqual([]);
  });
});

describe("duplicate threads", () => {
  function withThread(text: string, due?: string, status: "open" | "resolved" = "open", resolvedAt?: string): State {
    const state = fresh();
    state.threads = [
      {
        id: "t8",
        kind: "commitment",
        text,
        ...(due ? { due } : {}),
        status,
        entities: [],
        scale: "minor",
        was_major: false,
        last_interacted_turn: 0,
        warm: true,
        reminders: 0,
        last_shown_turn: 0,
        opened_turn: 0,
        ...(resolvedAt ? { resolved_at: resolvedAt } : {}),
      },
    ];
    return state;
  }

  it("rejects a thread.open that repeats an open one", () => {
    const state = withThread("Sort the mobile plan before the renewal deadline");
    const res = processOps(state, config(), [coreModule], [
      {
        op: "thread.open",
        kind: "commitment",
        text: "The mobile plan renewal deadline is still sitting there",
      },
    ]);
    expect(res.violations[0]).toMatchObject({ code: "duplicate_thread", severity: "fixable" });
    expect(res.violations[0]?.message).toContain("t8");
  });

  it("rejects the same deadline with a shorter overlap, and allows a resolved thread to be said again", () => {
    const due = "2026-10-05T23:59";
    const sameMinute = processOps(withThread("Pay the mobile bill", due), config(), [coreModule], [
      { op: "thread.open", kind: "commitment", text: "The mobile bill is late", due },
    ]);
    expect(sameMinute.violations[0]?.code).toBe("duplicate_thread");

    const different = processOps(withThread("Pay the mobile bill"), config(), [coreModule], [
      { op: "thread.open", kind: "commitment", text: "The mobile bill is late" },
    ]);
    expect(different.violations).toEqual([]);

    const resolved = processOps(
      withThread("Sort the mobile plan before the renewal deadline", undefined, "resolved"),
      config(),
      [coreModule],
      [{ op: "thread.open", kind: "commitment", text: "The mobile plan renewal deadline is still sitting there" }],
    );
    expect(resolved.violations).toEqual([]);

    const recent = processOps(
      withThread("Sort the mobile plan before the Monday deadline", undefined, "resolved", "2026-10-03T08:00"),
      config(),
      [coreModule],
      [{ op: "thread.open", kind: "commitment", text: "The mobile plan Monday deadline is still sitting there", due: "2026-10-05T09:00" }],
    );
    expect(recent.violations[0]?.code).toBe("duplicate_thread");
    expect(recent.violations[0]?.message).toContain("48 hours");

    const later = processOps(
      withThread("Sort the mobile plan before the Monday deadline", undefined, "resolved", "2026-10-01T08:00"),
      config(),
      [coreModule],
      [{ op: "thread.open", kind: "commitment", text: "The mobile plan Monday deadline is still sitting there", due: "2026-10-05T09:00" }],
    );
    expect(later.violations.filter((v) => v.code === "duplicate_thread")).toEqual([]);
  });

  it("requires a named weekday to fall on that weekday", () => {
    const wednesday = processOps(fresh(), config(), [coreModule], [
      { op: "thread.open", kind: "commitment", text: "The inspection is on Monday morning", due: "2026-10-07T10:00" },
    ]);
    expect(wednesday.violations[0]?.code).toBe("weekday_mismatch");
    expect(wednesday.violations[0]?.message).toContain("Monday");
    expect(wednesday.violations[0]?.message).toContain("Wednesday");
    expect(wednesday.violations[0]?.message).toContain("2026-10-05");

    const monday = processOps(fresh(), config(), [coreModule], [
      { op: "thread.open", kind: "commitment", text: "The inspection is on Monday morning", due: "2026-10-05T10:00" },
    ]);
    expect(monday.violations).toEqual([]);
  });

  it("moves a named weekday onto its date before validation, and leaves two weekdays to the repair", () => {
    const d = draft({
      delta: [{ op: "thread.open", kind: "commitment", text: "The inspection is on Monday morning", due: "2026-10-07T10:00" }],
    });
    expect(validateDraft(fresh(), config(), [coreModule], d).violations).toEqual([]);
    expect((d.delta[0] as { due: string }).due).toBe("2026-10-05T10:00");
    const two = draft({
      delta: [{ op: "thread.open", kind: "commitment", text: "Shifts Monday and Wednesday", due: "2026-10-09T17:00" }],
    });
    expect(validateDraft(fresh(), config(), [coreModule], two).violations.map((v) => v.code)).toEqual(["weekday_mismatch"]);
    expect(weekAheadLine("2026-10-03T09:21")).toBe(
      "Dates: today 2026-10-03, tomorrow 2026-10-04, Monday 2026-10-05, Tuesday 2026-10-06, Wednesday 2026-10-07, Thursday 2026-10-08, Friday 2026-10-09.",
    );
  });

  it("does not inject a due-event thread that repeats an open one", () => {
    const cfg = config();
    const state = withThread("Sort the mobile plan before the renewal deadline");
    const skipped = applyDraft(state, cfg, [coreModule], draft(), {
      input: "look",
      due: [
        {
          id: "mobile",
          kind: "scheduled",
          text: "The plan runs out tonight.",
          entities: [],
          thread: { kind: "commitment", text: "The mobile plan renewal deadline is still sitting there" },
        },
      ],
    });
    expect(skipped.threads.map((t) => t.id)).toEqual(["t8"]);

    const added = applyDraft(fresh(), cfg, [coreModule], draft(), {
      input: "look",
      due: [
        {
          id: "cat",
          kind: "scheduled",
          text: "The cat is hungry.",
          entities: [],
          thread: { kind: "commitment", text: "Feed the cat before dark" },
        },
      ],
    });
    expect(added.threads.map((t) => t.text)).toEqual(["Feed the cat before dark"]);
  });
});
