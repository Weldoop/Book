import { describe, expect, it } from "vitest";
import { ConfigSchema, type Config, type Module, type Op, type State, type TurnDraft, type Violation } from "@book/schema";
import { applyDraft, coreModule, createInitialState, processOps, validateDraft } from "../src/index.ts";

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

  it("treats a voyage as a trip and a step to the rail as the same deck", () => {
    const cfg = config();
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

    const rail = validateDraft(
      fresh(),
      cfg,
      modules,
      draft({ narration: "You watch the wake and do not change course." }),
      "I go to the rail and watch the wake. I do not change course.",
    );
    expect(rail.violations).toEqual([]);
  });

  it("checks at only when the draft sets it", () => {
    const cfg = config();
    const wrong = validateDraft(fresh(), cfg, modules, draft({ at: "kitchen" }), "Look around");
    expect(wrong.violations.map((v) => v.code)).toEqual(["location_mismatch"]);

    const right = validateDraft(
      fresh(),
      cfg,
      modules,
      draft({
        at: "kitchen",
        delta: [{ op: "entity.move", id: "player", location: "kitchen" }],
      }),
      "Look around",
    );
    expect(right.violations).toEqual([]);

    expect(validateDraft(fresh(), cfg, modules, draft(), "Look around").violations).toEqual([]);
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

describe("duplicate threads", () => {
  function withThread(text: string, due?: string, status: "open" | "resolved" = "open"): State {
    const state = fresh();
    state.threads = [
      {
        id: "t8",
        kind: "commitment",
        text,
        ...(due ? { due } : {}),
        status,
        entities: [],
        warm: true,
        reminders: 0,
        last_shown_turn: 0,
        opened_turn: 0,
      },
    ];
    return state;
  }

  it("rejects a thread.open that repeats an open one", () => {
    const state = withThread("Sort the mobile plan before the Monday deadline");
    const res = processOps(state, config(), [coreModule], [
      {
        op: "thread.open",
        kind: "commitment",
        text: "The mobile plan Monday deadline is still sitting there",
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
      withThread("Sort the mobile plan before the Monday deadline", undefined, "resolved"),
      config(),
      [coreModule],
      [{ op: "thread.open", kind: "commitment", text: "The mobile plan Monday deadline is still sitting there" }],
    );
    expect(resolved.violations).toEqual([]);
  });

  it("does not inject a due-event thread that repeats an open one", () => {
    const cfg = config();
    const state = withThread("Sort the mobile plan before the Monday deadline");
    const skipped = applyDraft(state, cfg, [coreModule], draft(), {
      input: "look",
      due: [
        {
          id: "mobile",
          kind: "scheduled",
          text: "The plan runs out tonight.",
          entities: [],
          thread: { kind: "commitment", text: "The mobile plan Monday deadline is still sitting there" },
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
