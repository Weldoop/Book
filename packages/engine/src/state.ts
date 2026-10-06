import { EntitySchema, type Config, type Module, type State, STATE_VERSION } from "@book/schema";
import { hashString } from "./rng.ts";

export function createInitialState(config: Config, modules: Module[], saveId: string): State {
  const entities: State["entities"] = {};
  for (const seed of config.seed.entities) {
    entities[seed.id] = EntitySchema.parse({
      id: seed.id,
      type: seed.type,
      name: seed.name,
      aliases: seed.aliases,
      location: seed.location ?? null,
      facts: seed.facts.map((text) => ({ text, importance: 2, turn: 0 })),
      tags: seed.tags,
      last_touched: 0,
    });
  }
  if (!entities[config.player_id]) {
    entities[config.player_id] = EntitySchema.parse({
      id: config.player_id,
      type: "person",
      name: "You",
      aliases: ["me", "myself"],
    });
  }

  const moduleState: Record<string, unknown> = {};
  for (const m of modules) {
    if (m.id !== "core") moduleState[m.id] = m.initState(config);
  }

  return {
    version: STATE_VERSION,
    save_id: saveId,
    config_id: config.id,
    config_version: config.version,
    turn: 0,
    clock: { now: config.time.start },
    rng_seed: hashString(saveId),
    entities,
    threads: config.seed.threads.map((t, i) => ({
      id: `t${i + 1}`,
      kind: t.kind,
      text: t.text,
      ...(t.due ? { due: t.due } : {}),
      status: "open" as const,
      entities: t.entities,
      scale: t.scale,
      was_major: false,
      last_interacted_turn: 0,
      last_interacted_at: config.time.start,
      warm: true,
      reminders: 0,
      last_shown_turn: 0,
      ...(t.on_overdue ? { on_overdue: t.on_overdue } : {}),
      opened_turn: 0,
    })),
    beats: [],
    summaries: { chapters: [], story_so_far: "", last_compacted_turn: 0 },
    window: [],
    focus_next: [],
    scene: { index: 1, started_turn: 0, closed: false },
    notes: [],
    ending: null,
    endings_seen: [],
    modules: moduleState,
  };
}
