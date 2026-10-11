import type { State, TurnRecord } from "@book/schema";

export function makeState(saveId = "s1", turn = 0): State {
  return {
    version: 1,
    save_id: saveId,
    config_id: "uk-life",
    config_version: 1,
    turn,
    clock: { now: "2026-10-03T09:00" },
    rng_seed: 42,
    entities: {},
    threads: [],
    beats: [],
    summaries: { chapters: [], story_so_far: "", last_compacted_turn: 0 },
    window: [],
    focus_next: [],
    scene: { index: 1, started_turn: 0, closed: false },
    notes: [],
    ending: null,
    endings_seen: [],
    ledger: [],
    modules: {},
  };
}

export function makeRecord(turn: number, outcome: TurnRecord["outcome"] = "ok"): TurnRecord {
  return {
    turn,
    kind: "act",
    input: `input ${turn}`,
    narration: outcome === "rolled_back" ? null : `narration ${turn}`,
    beat: outcome === "rolled_back" ? null : `beat ${turn}`,
    delta: [],
    due: [],
    attempts: [],
    outcome,
    context_parts: [],
    usage: [],
    at: "2026-10-03T09:00:00.000Z",
  };
}
