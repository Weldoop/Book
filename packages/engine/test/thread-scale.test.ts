import { describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "@book/schema";
import { applyDraft, coreModule, createInitialState, overdueThreads, processOps } from "../src/index.ts";

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
        { id: "glenys", type: "person", name: "Glenys", location: "room" },
      ],
    },
  });
}

function draft(delta: unknown[]) {
  return { narration: "The offer sits on the table.", delta, beat: "An offer." };
}

describe("thread scale", () => {
  it("lets two majors run, refuses a third, and adopts a minor into a free slot", () => {
    const cfg = config();
    const state = createInitialState(cfg, [coreModule], "s");
    const opened = processOps(state, cfg, [coreModule], [
      { op: "thread.open", kind: "goal", text: "Get through the inspection", scale: "major", entities: ["glenys"] },
      { op: "thread.open", kind: "debt", text: "The phone bill", scale: "major", entities: ["glenys"] },
      { op: "thread.open", kind: "commitment", text: "Sort the garden", scale: "major", entities: ["glenys"] },
    ]);
    expect(opened.violations.map((v) => v.code)).toEqual(["too_many_majors"]);
    expect(opened.state.threads.filter((t) => t.scale === "major")).toHaveLength(2);

    const withMinor = processOps(opened.state, cfg, [coreModule], [
      { op: "thread.open", kind: "commitment", text: "Photograph the damp", scale: "minor", parent: "t1", entities: ["glenys"] },
    ]);
    expect(withMinor.violations).toEqual([]);
    const promoted = processOps(withMinor.state, cfg, [coreModule], [{ op: "thread.adopt", id: "t3", scale: "major" }]);
    expect(promoted.violations.map((v) => v.code)).toEqual(["too_many_majors"]);
    expect(promoted.state.threads.find((t) => t.id === "t3")?.scale).toBe("minor");

    const resolved = processOps(withMinor.state, cfg, [coreModule], [
      { op: "thread.resolve", id: "t1" },
      { op: "thread.adopt", id: "t3", scale: "major" },
    ]);
    expect(resolved.violations).toEqual([]);
    expect(resolved.state.threads.find((t) => t.id === "t1")?.status).toBe("resolved");
    expect(resolved.state.threads.find((t) => t.id === "t3")).toMatchObject({ scale: "major", status: "open" });
    expect(resolved.state.threads.find((t) => t.id === "t2")?.status).toBe("open");
  });

  it("lapses an offer that nobody took, and keeps one the player took up", () => {
    const cfg = config();
    const state = createInitialState(cfg, [coreModule], "s");
    const opened = applyDraft(
      state,
      cfg,
      [coreModule],
      draft([
        { op: "thread.open", kind: "mystery", text: "The neighbour's spare key", scale: "potential", entities: ["glenys"] },
        { op: "thread.open", kind: "commitment", text: "Walk the dog", scale: "potential", entities: ["glenys"] },
      ]),
      { input: "look", due: [] },
    );
    const taken = applyDraft(
      opened,
      cfg,
      [coreModule],
      draft([{ op: "thread.adopt", id: "t2", scale: "minor" }]),
      { input: "I'll walk the dog", due: [] },
    );
    expect(taken.threads.find((t) => t.id === "t2")).toMatchObject({ scale: "minor", status: "open" });
    expect(taken.threads.find((t) => t.id === "t2")?.expires).toBeUndefined();

    const later = applyDraft(
      taken,
      cfg,
      [coreModule],
      draft([{ op: "clock.skip", minutes: 49 * 60, reason: "two days pass" }]),
      { input: "wait", due: [] },
    );
    expect(later.threads.find((t) => t.id === "t1")?.status).toBe("failed");
    expect(later.threads.find((t) => t.id === "t2")?.status).toBe("open");
    expect(overdueThreads(later, cfg)).toEqual([]);
  });

  it("does not demote a major", () => {
    const cfg = config();
    const state = createInitialState(cfg, [coreModule], "s");
    const opened = processOps(state, cfg, [coreModule], [
      { op: "thread.open", kind: "goal", text: "The inspection", scale: "major" },
    ]);
    const demoted = processOps(opened.state, cfg, [coreModule], [{ op: "thread.adopt", id: "t1", scale: "minor" }]);
    expect(demoted.violations.map((v) => v.code)).toEqual(["cannot_demote"]);
    expect(demoted.state.threads[0]?.scale).toBe("major");
  });
});
