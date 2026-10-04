import { describe, expect, it } from "vitest";
import { applyContinuation, continuationDue, endingById, inventoryOf, markEnding, pickEnding, statsOf } from "../src/index.ts";
import { testSetup } from "./helpers.ts";

const endings = [
  {
    id: "admitted",
    when: { kind: "stat", key: "health", op: "<=", value: 0 },
    title: "Admitted",
    text: "An ambulance takes you to Morriston.",
    continue: {
      label: "Come round on the ward",
      location: "kitchen",
      note: "The player wakes on a ward.",
      skip_minutes: 480,
      set_stats: { health: 35 },
      clear_inventory: true,
    },
  },
  {
    id: "broke",
    when: { kind: "stat", key: "money", op: "<=", value: 0 },
    title: "Skint",
    text: "The money is gone and so is the tenancy.",
  },
];

function setup() {
  return testSetup({ endings });
}

describe("endings", () => {
  it("fires nothing while every condition is false", () => {
    const { config, state } = setup();
    expect(pickEnding(state, config)).toBeNull();
  });

  it("picks the first ending whose condition holds", () => {
    const { config, state } = setup();
    const hurt = { ...state, modules: { ...state.modules, stats: { values: { money: 45, health: 0 } } } };
    expect(pickEnding(hurt, config)?.id).toBe("admitted");
  });

  it("never fires the same ending twice", () => {
    const { config, state } = setup();
    const hurt = { ...state, modules: { ...state.modules, stats: { values: { money: 45, health: 0 } } } };
    const marked = markEnding(hurt, pickEnding(hurt, config)!);
    expect(marked.ending).toEqual({ id: "admitted", turn: 0, continuable: true });
    expect(pickEnding({ ...marked, ending: null }, config)).toBeNull();
  });

  it("marks an ending with no continuation as final", () => {
    const { config, state } = setup();
    const skint = { ...state, modules: { ...state.modules, stats: { values: { money: 0, health: 100 } } } };
    const marked = markEnding(skint, pickEnding(skint, config)!);
    expect(marked.ending?.continuable).toBe(false);
  });

  it("carries the story on deterministically: time, place, stats and possessions", () => {
    const { config, state } = setup();
    const hurt = markEnding(
      { ...state, modules: { ...state.modules, stats: { values: { money: 45, health: 0 } } } },
      endingById(config, "admitted")!,
    );
    const next = applyContinuation(hurt, config, endingById(config, "admitted")!);

    expect(next.clock.now).toBe("2026-10-03T17:20");
    expect(next.entities.player?.location).toBe("kitchen");
    expect(statsOf(next).values.health).toBe(35);
    expect(statsOf(next).values.money).toBe(45);
    expect(inventoryOf(next).owners.player).toEqual({});
    expect(next.ending).toBeNull();
    expect(next.endings_seen).toEqual(["admitted"]);
  });

  it("hands the GM the opening situation as a due item", () => {
    const { config } = setup();
    const due = continuationDue(endingById(config, "admitted")!);
    expect(due.text).toBe("The player wakes on a ward.");
    expect(due.entities).toEqual(["kitchen"]);
  });
});
