import { describe, expect, it } from "vitest";
import { ConfigSchema, type Config, type State, type TurnDraft } from "@book/schema";
import { coreModule, collectNotes, createInitialState, openScene } from "../src/index.ts";

function config(over: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({
    id: "t",
    version: 1,
    meta: { title: "T", tone: "dry" },
    modules: ["core"],
    gm_style: { interludes: ["wobble"], rollback_note: "again" },
    presentation: { profile: "light", status_line: [] },
    time: { start: "2026-10-03T09:00" },
    ...over,
  });
}

const draft = (over: Partial<TurnDraft> = {}): TurnDraft => ({
  narration: "n",
  delta: [],
  beat: "b",
  ...over,
});

function state(over: Partial<State> = {}): State {
  return { ...createInitialState(config(), [coreModule], "s1"), ...over };
}

describe("openScene", () => {
  it("leaves a running scene alone", () => {
    const s = state({ turn: 5 });
    expect(openScene(s)).toBe(s);
  });

  it("opens the next scene once the GM has closed the last one", () => {
    const s = state({ turn: 5, scene: { index: 2, started_turn: 1, closed: true } });
    expect(openScene(s).scene).toEqual({ index: 3, started_turn: 5, closed: false });
  });

  it("is idempotent, so a replay cannot inflate the scene count", () => {
    const once = openScene(state({ turn: 5, scene: { index: 2, started_turn: 1, closed: true } }));
    expect(openScene(once)).toBe(once);
  });
});

describe("collectNotes", () => {
  it("keeps what the GM wrote, stamped with the turn", () => {
    const notes = collectNotes(state(), config(), draft({ notes: ["Dai is lying about the bins"] }), 3);
    expect(notes).toEqual([{ turn: 3, text: "Dai is lying about the bins" }]);
  });

  it("drops notes once they have aged past ttl_turns", () => {
    const s = state({
      notes: [
        { turn: 1, text: "stale" },
        { turn: 5, text: "fresh" },
      ],
    });
    const notes = collectNotes(s, config({ notes: { ttl_turns: 3 } }), draft(), 6);
    expect(notes.map((n) => n.text)).toEqual(["fresh"]);
  });

  it("ignores blank notes and truncates ones that grew into prose", () => {
    const long = "x".repeat(400);
    const notes = collectNotes(state(), config({ notes: { max_chars: 50 } }), draft({ notes: ["  ", long] }), 1);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toHaveLength(50);
  });

  it("keeps nothing at all when notes are switched off for the game", () => {
    const s = state({ notes: [{ turn: 1, text: "old" }] });
    expect(collectNotes(s, config({ notes: { enabled: false } }), draft({ notes: ["new"] }), 2)).toEqual([]);
  });
});
