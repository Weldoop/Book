import {
  ConfigSchema,
  type Config,
  type DueItem,
  type Entity,
  type Module,
  type State,
  type Thread,
} from "@book/schema";

export function makeConfig(over: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({
    id: "test-game",
    version: 1,
    meta: { title: "Test Game", tone: "grounded, dry", premise: "A new start in a small town.", content_rating: "romance" },
    modules: ["core", "stats"],
    gm_style: {
      max_words: 90,
      person: "second",
      never_decide_for_player: true,
      extra_rules: ["End on a small hook."],
      interludes: ["The moment wobbles."],
      rollback_note: "Try again?",
    },
    presentation: { profile: "light", status_line: ["money"] },
    time: { start: "2026-10-03T09:20" },
    dice: { sides: 100 },
    ...over,
  });
}

export function makeEntity(over: Partial<Entity> & { id: string }): Entity {
  return {
    type: "person",
    name: over.id,
    aliases: [],
    location: null,
    facts: [],
    tags: [],
    last_touched: 0,
    ...over,
  };
}

export function makeState(over: Partial<State> = {}): State {
  const entities: Record<string, Entity> = {
    player: makeEntity({ id: "player", name: "You", location: "flat" }),
    flat: makeEntity({
      id: "flat",
      type: "place",
      name: "The Flat",
      facts: [{ text: "Damp bedsit above a chip shop", importance: 2, turn: 0 }],
    }),
    glenys: makeEntity({
      id: "glenys",
      name: "Glenys",
      aliases: ["Mrs Pugh"],
      location: "flat",
      facts: [
        { text: "Lent the mower; wants it back by 4pm", importance: 3, turn: 5 },
        { text: "Hums hymns while gardening", importance: 1, turn: 2 },
      ],
      last_touched: 5,
    }),
    cerys: makeEntity({
      id: "cerys",
      name: "Cerys",
      aliases: ["Cez"],
      location: "cafe",
      facts: [{ text: "Works at the cafe", importance: 2, turn: 1 }],
      last_touched: 3,
    }),
    cafe: makeEntity({ id: "cafe", type: "place", name: "Corner Cafe", facts: [] }),
    dai: makeEntity({
      id: "dai",
      name: "Dai",
      location: "pub",
      facts: [{ text: "Owes you a tenner", importance: 2, turn: 4 }],
      last_touched: 4,
    }),
  };
  return {
    version: 1,
    save_id: "save-1",
    config_id: "test-game",
    config_version: 1,
    turn: 6,
    clock: { now: "2026-10-03T09:20" },
    rng_seed: 1,
    entities,
    threads: [],
    beats: [],
    summaries: { chapters: [], story_so_far: "", last_compacted_turn: 0 },
    window: [],
    focus_next: [],
    modules: {},
    ...over,
  };
}

export function makeThread(over: Partial<Thread> & { id: string }): Thread {
  return {
    kind: "commitment",
    text: `thread ${over.id}`,
    status: "open",
    entities: [],
    warm: true,
    reminders: 0,
    last_shown_turn: 1,
    opened_turn: 1,
    ...over,
  };
}

export function makeModule(over: Partial<Module> & { id: string }): Module {
  return {
    initState: () => ({}),
    ops: [],
    validateOp: () => [],
    applyOp: (_op, state) => state,
    promptFragment: () => "",
    focus: () => [],
    due: () => [],
    snapshot: () => [],
    render: () => ({}),
    ...over,
  };
}

export const statsModule: Module = makeModule({
  id: "stats",
  ops: ["stat.add", "stat.set"],
  promptFragment: () => "STATS: money is in GBP. Use stat.add with a reason. Never let money go below zero.",
  snapshot: () => ["money: 45.00 GBP", "health: 80/100"],
});

export const inventoryModule: Module = makeModule({
  id: "inventory",
  ops: ["inventory.add", "inventory.remove"],
  promptFragment: () => "INVENTORY: items are owned by an entity. Remove items when used up.",
  snapshot: () => ["inventory: mower (player)"],
});

export const noDue: DueItem[] = [];

/** A long-running game: many entities, facts, beats and window turns. */
export function makeBigState(turn = 200): State {
  const entities: Record<string, Entity> = {
    player: makeEntity({ id: "player", name: "You", location: "loc0" }),
  };
  for (let p = 0; p < 6; p++) {
    entities[`loc${p}`] = makeEntity({
      id: `loc${p}`,
      type: "place",
      name: `Place ${p}`,
      facts: [{ text: `Place ${p} is known for its distinctive smell of old rope and tar`, importance: 2, turn: p }],
    });
  }
  for (let n = 0; n < 50; n++) {
    const facts = [];
    for (let f = 0; f < 12; f++) {
      facts.push({
        text: `Fact ${f} about person ${n}: remembers a detail of their long history with the player (${f * 7 + n})`,
        importance: ((f % 3) + 1) as 1 | 2 | 3,
        turn: f * 10 + (n % 10),
      });
    }
    entities[`npc${n}`] = makeEntity({
      id: `npc${n}`,
      name: `Person ${n}`,
      aliases: [`Nick${n}`],
      location: `loc${n % 6}`,
      facts,
      last_touched: turn - (n % 40),
    });
  }
  const threads: Thread[] = [];
  for (let t = 0; t < 30; t++) {
    threads.push(
      makeThread({
        id: `t${t}`,
        kind: t % 2 ? "callback" : "commitment",
        text: `Promise number ${t} to sort out a long-standing favour owed to somebody in town`,
        due: t % 3 === 0 ? `2026-10-${String(5 + t).padStart(2, "0")}T10:00` : undefined,
        entities: [`npc${t}`],
        opened_turn: t * 5,
      }),
    );
  }
  const beats = [];
  for (let b = 1; b <= turn; b++) {
    beats.push({ turn: b, text: `Turn ${b}: the player did something notable with person ${b % 50} near place ${b % 6}.` });
  }
  const windowTurns = [];
  for (let w = turn - 9; w <= turn; w++) {
    windowTurns.push({
      turn: w,
      input: `I do thing number ${w} and then talk to Person ${w % 50} about the plan`,
      narration:
        "You step forward and the scene shifts around you, the air thick with the smell of rope and rain. " +
        "Somebody calls your name from across the way, and a gull wheels overhead while the market stalls rattle awake. " +
        "A hand tugs your sleeve; it is only a child with a message, folded small and smelling of fish.",
      clock: "2026-10-03T09:20",
    });
  }
  return makeState({
    turn,
    entities,
    threads,
    beats,
    window: windowTurns,
    focus_next: ["npc3", "npc4"],
    summaries: {
      chapters: [],
      story_so_far: Array.from({ length: 40 }, (_, i) => `Sentence ${i} recounts a long ago adventure of some length.`).join(" "),
      last_compacted_turn: Math.max(0, turn - 25),
    },
  });
}
