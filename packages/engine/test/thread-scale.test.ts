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
  it("sets the major the player left alone back to a minor when a third one opens", () => {
    const cfg = config();
    const state = createInitialState(cfg, [coreModule], "s");
    const opened = processOps(state, cfg, [coreModule], [
      {
        op: "thread.open",
        kind: "goal",
        text: "Get through the inspection",
        scale: "major",
        due: "2026-10-06T09:00",
        entities: ["glenys"],
      },
      { op: "thread.open", kind: "debt", text: "The phone bill", scale: "major", entities: ["glenys"] },
    ]);
    expect(opened.violations).toEqual([]);
    const inspection = opened.state.threads.find((t) => t.id === "t1");
    const phone = opened.state.threads.find((t) => t.id === "t2");
    if (!inspection || !phone) throw new Error("missing thread");
    inspection.last_interacted_turn = 2;
    inspection.on_overdue = "The landlord walks the flat and the inspection is lost.";
    phone.last_interacted_turn = 8;

    const third = processOps(opened.state, cfg, [coreModule], [
      { op: "thread.open", kind: "commitment", text: "Sort the garden", scale: "major", entities: ["glenys"] },
    ]);
    expect(third.violations).toEqual([]);
    expect(third.state.threads.filter((t) => t.status === "open" && t.scale === "major").map((t) => t.id)).toEqual(["t2", "t3"]);
    expect(third.state.threads.find((t) => t.id === "t1")).toMatchObject({
      scale: "minor",
      was_major: true,
      set_aside_scene: 1,
      status: "open",
      warm: true,
      reminders: 0,
      due: "2026-10-06T09:00",
      on_overdue: "The landlord walks the flat and the inspection is lost.",
      last_interacted_turn: 2,
    });
    expect(third.state.threads.find((t) => t.id === "t2")).toMatchObject({ scale: "major", was_major: false });
    expect(third.state.threads.find((t) => t.id === "t3")).toMatchObject({ scale: "major", was_major: false });

    const later = { ...third.state, clock: { now: "2026-10-06T09:00" } };
    expect(overdueThreads(later, cfg).map((d) => d.text)).toEqual([
      "The landlord walks the flat and the inspection is lost.",
    ]);
  });

  it("protects the major the player just named, and demotes the other one", () => {
    const cfg = config();
    const state = createInitialState(cfg, [coreModule], "s");
    const opened = processOps(state, cfg, [coreModule], [
      { op: "thread.open", kind: "goal", text: "Get through the inspection", scale: "major", entities: ["glenys"] },
      { op: "thread.open", kind: "debt", text: "The phone bill", scale: "major" },
    ]);
    opened.state.turn = 4;
    const next = applyDraft(
      opened.state,
      cfg,
      [coreModule],
      draft([{ op: "thread.open", kind: "goal", text: "Finish the essay", scale: "major", entities: ["glenys"] }]),
      { input: "I tell Glenys the essay comes first", due: [] },
    );
    expect(next.threads.find((t) => t.id === "t1")?.scale).toBe("major");
    expect(next.threads.find((t) => t.id === "t2")).toMatchObject({ scale: "minor", was_major: true, status: "open" });
    expect(next.threads.find((t) => t.id === "t3")?.scale).toBe("major");
    expect(next.threads.find((t) => t.id === "t1")?.last_interacted_turn).toBe(next.turn);
  });

  it("adopts a minor into the lead by setting the quiet major aside, and uses a free slot when one exists", () => {
    const cfg = config();
    const state = createInitialState(cfg, [coreModule], "s");
    const opened = processOps(state, cfg, [coreModule], [
      { op: "thread.open", kind: "goal", text: "Get through the inspection", scale: "major", entities: ["glenys"] },
      { op: "thread.open", kind: "debt", text: "The phone bill", scale: "major", entities: ["glenys"] },
      { op: "thread.open", kind: "commitment", text: "Photograph the damp", scale: "minor", parent: "t1", entities: ["glenys"] },
    ]);
    const inspection = opened.state.threads.find((t) => t.id === "t1");
    const phone = opened.state.threads.find((t) => t.id === "t2");
    if (!inspection || !phone) throw new Error("missing thread");
    inspection.last_interacted_turn = 1;
    phone.last_interacted_turn = 6;

    const promoted = processOps(opened.state, cfg, [coreModule], [{ op: "thread.adopt", id: "t3", scale: "major" }]);
    expect(promoted.violations).toEqual([]);
    expect(promoted.state.threads.find((t) => t.id === "t1")).toMatchObject({ scale: "minor", was_major: true });
    expect(promoted.state.threads.find((t) => t.id === "t2")?.scale).toBe("major");
    expect(promoted.state.threads.find((t) => t.id === "t3")?.scale).toBe("major");

    const freed = processOps(opened.state, cfg, [coreModule], [
      { op: "thread.resolve", id: "t2" },
      { op: "thread.adopt", id: "t3", scale: "major" },
    ]);
    expect(freed.violations).toEqual([]);
    expect(freed.state.threads.find((t) => t.id === "t1")).toMatchObject({ scale: "major", was_major: false, status: "open" });
    expect(freed.state.threads.find((t) => t.id === "t2")?.status).toBe("resolved");
    expect(freed.state.threads.find((t) => t.id === "t3")).toMatchObject({ scale: "major", status: "open" });
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

  it("sets a major back to a minor on purpose and keeps the deadline", () => {
    const cfg = config();
    const state = createInitialState(cfg, [coreModule], "s");
    const opened = processOps(state, cfg, [coreModule], [
      { op: "thread.open", kind: "goal", text: "The inspection", scale: "major", due: "2026-10-06T09:00" },
    ]);
    const demoted = processOps(opened.state, cfg, [coreModule], [{ op: "thread.adopt", id: "t1", scale: "minor" }]);
    expect(demoted.violations).toEqual([]);
    expect(demoted.state.threads[0]).toMatchObject({
      scale: "minor",
      was_major: true,
      status: "open",
      due: "2026-10-06T09:00",
      warm: true,
    });
  });

  it("counts a named person or place, and ignores standing in the room or someone merely there", () => {
    const cfg = config();
    cfg.seed.entities.push({ id: "garden", type: "place", name: "Garden", aliases: ["garden"], facts: [], tags: [] });
    const state = createInitialState(cfg, [coreModule], "s");
    const opened = applyDraft(
      state,
      cfg,
      [coreModule],
      draft([
        { op: "thread.open", kind: "goal", text: "Get through the inspection", scale: "major", entities: ["glenys"] },
        { op: "thread.open", kind: "commitment", text: "Sort the garden", scale: "minor", entities: ["garden"] },
      ]),
      { input: "look around", due: [] },
    );
    expect(opened.threads.find((t) => t.id === "t1")?.last_interacted_turn).toBe(1);
    expect(opened.threads.find((t) => t.id === "t2")?.last_interacted_turn).toBe(1);

    const present = applyDraft(opened, cfg, [coreModule], draft([]), { input: "make tea", due: [] });
    expect(present.threads.find((t) => t.id === "t1")?.last_interacted_turn).toBe(1);
    expect(present.threads.find((t) => t.id === "t2")?.last_interacted_turn).toBe(1);

    const named = applyDraft(present, cfg, [coreModule], draft([]), { input: "ask Glenys if Monday still stands", due: [] });
    expect(named.threads.find((t) => t.id === "t1")?.last_interacted_turn).toBe(3);
    expect(named.threads.find((t) => t.id === "t2")?.last_interacted_turn).toBe(1);

    const moved = applyDraft(
      named,
      cfg,
      [coreModule],
      draft([{ op: "entity.move", id: "player", location: "garden" }]),
      { input: "step outside", due: [] },
    );
    expect(moved.threads.find((t) => t.id === "t2")?.last_interacted_turn).toBe(1);
    const weeding = applyDraft(moved, cfg, [coreModule], draft([]), { input: "pull a weed", due: [] });
    expect(weeding.threads.find((t) => t.id === "t2")?.last_interacted_turn).toBe(1);
    expect(weeding.threads.find((t) => t.id === "t1")?.last_interacted_turn).toBe(3);
    const namedGarden = applyDraft(weeding, cfg, [coreModule], draft([]), { input: "look at the garden", due: [] });
    expect(namedGarden.threads.find((t) => t.id === "t2")?.last_interacted_turn).toBe(6);
  });
});
