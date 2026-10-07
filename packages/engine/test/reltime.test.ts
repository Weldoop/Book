import { describe, expect, it } from "vitest";
import { ConfigSchema, type State, type Thread, type TurnDraft } from "@book/schema";
import { coreModule, createInitialState } from "../src/index.ts";
import { clockAfter, correctRelativeTimes } from "../src/reltime.ts";

const config = ConfigSchema.parse({
  id: "t",
  version: 1,
  meta: { title: "T", tone: "dry" },
  modules: ["core"],
  gm_style: { interludes: ["wobble"], rollback_note: "again" },
  presentation: { profile: "light", status_line: [] },
  time: { start: "2026-10-06T07:15" },
  stats: [],
  items: [],
  seed: { entities: [{ id: "player", type: "person", name: "You", location: "room" }, { id: "room", type: "place", name: "Your room" }] },
});

function thread(text: string, due: string, status: Thread["status"] = "open"): Thread {
  return {
    id: `t${text.length}`,
    kind: "commitment",
    text,
    due,
    status,
    entities: [],
    scale: "minor",
    was_major: false,
    last_interacted_turn: 0,
    warm: true,
    reminders: 0,
    last_shown_turn: 0,
    opened_turn: 0,
  };
}

function state(...threads: Thread[]): State {
  const s = createInitialState(config, [coreModule], "s1");
  s.threads = threads;
  return s;
}

const draft = (narration: string, delta: TurnDraft["delta"] = []): TurnDraft => ({ narration, delta, beat: "b" });

describe("relative times against dated threads", () => {
  const shift = thread("Trial shift at the corner shop with Derek, 17:00 to 21:00", "2026-10-06T17:00");
  const inspection = thread("The letting agent's inspection of the house and garden", "2026-10-05T10:00");

  it("corrects a count of hours that the clock says is wrong", () => {
    const d = draft("You check your phone. The shift at Derek's corner shop is still five hours away. Nia is up.");
    const notes = correctRelativeTimes(state(shift), d);
    expect(d.narration).toContain("is still about ten hours away");
    expect(notes).toEqual(['"five hours" -> "about ten hours"']);
  });

  it("measures from the clock the delta lands on", () => {
    const d = draft("The shift at Derek's corner shop is two hours away.", [{ op: "clock.advance", minutes: 480 }]);
    correctRelativeTimes(state(shift), d);
    expect(d.narration).toBe("The shift at Derek's corner shop is two hours away.");
    expect(clockAfter(state(), d)).toBe("2026-10-06T15:15");
  });

  it("leaves a count that is near enough, a sentence about no thread, and quoted speech alone", () => {
    const near = draft("The corner shop shift with Derek is about nine hours away.");
    expect(correctRelativeTimes(state(shift), near)).toEqual([]);
    const unrelated = draft("The bus is five hours away, Nia says, which seems unlikely.");
    expect(correctRelativeTimes(state(shift), unrelated)).toEqual([]);
    const quoted = draft("'The corner shop shift with Derek is five hours away,' Nia says, wrongly.");
    expect(correctRelativeTimes(state(shift), quoted)).toEqual([]);
  });

  it("moves 'in a few hours' to the day the thread is due", () => {
    const s = state(inspection);
    s.clock.now = "2026-10-04T10:00";
    const d = draft("The letting agent's inspection of the garden is in a few hours. You pick up the shears.");
    correctRelativeTimes(s, d);
    expect(d.narration).toBe("The letting agent's inspection of the garden is tomorrow. You pick up the shears.");
  });

  it("corrects a day word, and names the weekday when it is further off", () => {
    const s = state(inspection);
    s.clock.now = "2026-10-03T09:00";
    const d = draft("The letting agent's inspection of the house is this afternoon, so the garden matters.");
    correctRelativeTimes(s, d);
    expect(d.narration).toBe("The letting agent's inspection of the house is on Monday, so the garden matters.");
    const soon = draft("The letting agent's inspection of the house is tomorrow.");
    const sunday = state(inspection);
    sunday.clock.now = "2026-10-04T20:00";
    expect(correctRelativeTimes(sunday, soon)).toEqual([]);
  });

  it("does not touch a passed deadline or an ambiguous sentence", () => {
    const passed = state(inspection);
    passed.clock.now = "2026-10-05T12:00";
    const d = draft("The letting agent's inspection of the house is in a few hours.");
    expect(correctRelativeTimes(passed, d)).toEqual([]);
    const two = state(shift, thread("Another corner shop shift with Derek on Wednesday", "2026-10-07T17:00"));
    const amb = draft("The corner shop shift with Derek is still five hours away.");
    expect(correctRelativeTimes(two, amb)).toEqual([]);
  });
});
