import { describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "@book/schema";
import { applyDraft, coreModule, createInitialState, factDecision, factsDisagree, keepWitnessed, placeWords } from "../src/index.ts";

function config(): Config {
  return ConfigSchema.parse({
    id: "t",
    version: 1,
    meta: { title: "T", tone: "dry" },
    modules: ["core"],
    gm_style: { interludes: ["wobble"], rollback_note: "again" },
    presentation: { profile: "light", status_line: [] },
    time: { start: "2026-10-03T09:00", max_per_turn: 480, max_skip_minutes: 20000 },
    seed: {
      entities: [
        { id: "player", type: "person", name: "You", location: "room" },
        { id: "room", type: "place", name: "Room" },
        { id: "glenys", type: "person", name: "Glenys", location: "room", facts: ["Keeps the spare key"] },
        { id: "kitchen", type: "place", name: "Kitchen" },
      ],
    },
  });
}

function draft(delta: unknown[]) {
  return { narration: "Time passes.", delta, beat: "Time passes." };
}

describe("person memories", () => {
  it("forgets a passing slight after a day and keeps a fight", () => {
    const cfg = config();
    const state = createInitialState(cfg, [coreModule], "s");
    const next = applyDraft(
      state,
      cfg,
      [coreModule],
      draft([
        { op: "entity.fact.add", id: "glenys", fact: "You were rude about the bins", importance: 1 },
        { op: "entity.fact.add", id: "glenys", fact: "You shoved her", importance: 3 },
        { op: "entity.fact.add", id: "kitchen", fact: "The tap drips", importance: 1 },
        { op: "clock.skip", minutes: 25 * 60, reason: "a day and a bit" },
      ]),
      { input: "wait", due: [] },
    );
    const remembered = next.entities.glenys?.facts.map((f) => f.text) ?? [];
    expect(remembered).toContain("Keeps the spare key");
    expect(remembered).toContain("You shoved her");
    expect(remembered).not.toContain("You were rude about the bins");
    expect(next.entities.glenys?.facts.find((f) => f.text === "You shoved her")?.expires).toBeUndefined();
    expect(next.entities.kitchen?.facts.map((f) => f.text)).toContain("The tap drips");
  });

  it("keeps an ordinary memory through a day and drops it after a week", () => {
    const cfg = config();
    const state = createInitialState(cfg, [coreModule], "s");
    const day = applyDraft(
      state,
      cfg,
      [coreModule],
      draft([
        { op: "entity.fact.add", id: "glenys", fact: "You borrowed a fiver", importance: 2 },
        { op: "clock.skip", minutes: 25 * 60, reason: "the next day" },
      ]),
      { input: "wait", due: [] },
    );
    expect(day.entities.glenys?.facts.map((f) => f.text)).toContain("You borrowed a fiver");

    const week = applyDraft(
      day,
      cfg,
      [coreModule],
      draft([{ op: "clock.skip", minutes: 7 * 24 * 60, reason: "a week away" }]),
      { input: "wait", due: [] },
    );
    expect(week.entities.glenys?.facts.map((f) => f.text)).not.toContain("You borrowed a fiver");
    expect(week.entities.glenys?.facts.map((f) => f.text)).toContain("Keeps the spare key");
  });

  it("keeps the witnessed place when a later line names another", () => {
    const cfg = config();
    const state = createInitialState(cfg, [coreModule], "s");
    const places = placeWords(state);
    expect(places).toContain("kitchen");
    expect(places).toContain("room");
    const witnessed = { text: "Sold the camera at the kitchen for £38", importance: 2 as const, turn: 1 };
    const lie = { text: "Sold the camera at the room for £38", importance: 2 as const, turn: 4 };
    expect(factsDisagree(witnessed.text, lie.text, places)).toBe(true);
    expect(factDecision([witnessed], lie, places)).toBe("drop");
    expect(factDecision([witnessed], { ...lie, importance: 3 }, places)).toBe("replace");
    expect(keepWitnessed([lie, witnessed], places).map((fact) => fact.text)).toEqual([witnessed.text]);

    const next = applyDraft(
      state,
      cfg,
      [coreModule],
      draft([
        { op: "entity.fact.add", id: "glenys", fact: witnessed.text, importance: 2 },
        { op: "entity.fact.add", id: "glenys", fact: lie.text, importance: 2 },
      ]),
      { input: "wait", due: [] },
    );
    const remembered = next.entities.glenys?.facts.map((fact) => fact.text) ?? [];
    expect(remembered).toContain(witnessed.text);
    expect(remembered).not.toContain(lie.text);

    const corrected = applyDraft(
      next,
      cfg,
      [coreModule],
      draft([{ op: "entity.fact.add", id: "glenys", fact: lie.text, importance: 3 }]),
      { input: "wait", due: [] },
    );
    const after = corrected.entities.glenys?.facts.map((fact) => fact.text) ?? [];
    expect(after).toContain(lie.text);
    expect(after).not.toContain(witnessed.text);
  });
});
