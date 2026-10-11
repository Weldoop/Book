import { describe, expect, it } from "vitest";
import { mapAttention } from "../src/index.ts";
import { makeConfig, makeEntity, makeModule, makeState, makeThread, statsModule } from "./fixtures.ts";

const config = makeConfig();

function entityState() {
  const base = makeState();
  return makeState({
    entities: {
      ...base.entities,
      mara: makeEntity({
        id: "mara",
        name: "Mara Venn",
        aliases: ["the Fixer"],
        location: "market",
        facts: [{ text: "Knows every smuggler", importance: 3, turn: 2 }],
        last_touched: 1,
      }),
      tomos: makeEntity({
        id: "tomos",
        name: "Tomos",
        location: "market",
        facts: [{ text: "Sells eels", importance: 1, turn: 1 }],
        last_touched: 1,
      }),
      bell: makeEntity({
        id: "bell",
        name: "Bell",
        location: "chapel",
        facts: [{ text: "Cracked", importance: 1, turn: 1 }],
        last_touched: 0,
      }),
      sam: makeEntity({
        id: "sam",
        name: "Sam",
        location: "chapel",
        facts: [{ text: "Quiet", importance: 1, turn: 1 }],
        last_touched: 0,
      }),
    },
  });
}

const attend = (over: Record<string, unknown> = {}, state = entityState()) =>
  mapAttention({ config, state, modules: [], input: "look around", due: [], ...over });

describe("mapAttention", () => {
  it("pulls someone whose stored fact shares the player's line, even from another room", () => {
    const ids = attend({ input: "who owes the tenner" });
    expect(ids.slice(0, 3)).toEqual(["flat", "dai", "glenys"]);
  });

  it("puts the location and the entities there first, excluding the player", () => {
    const ids = attend();
    expect(ids.slice(0, 2)).toEqual(["flat", "glenys"]);
    expect(ids).not.toContain("player");
  });

  it("matches names and aliases case-insensitively, whole word only", () => {
    expect(attend({ input: "i ask the FIXER for help" }).slice(1, 2)).toEqual(["mara"]);
    expect(attend({ input: "Mara Venn waves" })).toContain("mara");
    const partial = attend({ input: "sammy and Tomosz", limit: 3 });
    expect(partial).toEqual(["flat", "glenys", "mara"]);
    expect(attend({ input: "talk to Tomos, please", limit: 3 })[1]).toBe("tomos");
    expect(attend({ input: "SAM, are you there?", limit: 3 })[1]).toBe("sam");
    const ids = attend({ input: "cez said hi" });
    expect(ids.indexOf("cerys")).toBeGreaterThan(-1);
    expect(ids.indexOf("cerys")).toBeLessThan(ids.indexOf("dai"));
  });

  it("keeps mentioned entities even when the location is crowded", () => {
    const state = entityState();
    for (let i = 0; i < 20; i++) {
      state.entities[`crowd${i}`] = makeEntity({
        id: `crowd${i}`,
        name: `Crowd ${i}`,
        location: "flat",
        facts: [{ text: "x", importance: 3, turn: 6 }],
        last_touched: 6,
      });
    }
    const ids = attend({ input: "I wave to Tomos" }, state);
    expect(ids.slice(0, 2)).toEqual(["flat", "tomos"]);
  });

  it("adds entities of the soonest-due threads before unrelated ones", () => {
    const state = entityState();
    state.threads = [
      makeThread({ id: "t2", due: "2026-10-09T10:00", entities: ["bell"] }),
      makeThread({ id: "t1", due: "2026-10-04T10:00", entities: ["sam"] }),
    ];
    const ids = attend({}, state);
    expect(ids.indexOf("sam")).toBeLessThan(ids.indexOf("bell"));
    expect(ids.indexOf("sam")).toBeLessThan(ids.indexOf("mara"));
  });

  it("adds due event entities, focus_next, and module focus in that order", () => {
    const state = entityState();
    state.focus_next = ["bell"];
    const mod = makeModule({ id: "m", focus: () => ["tomos"] });
    const ids = mapAttention({
      config,
      state,
      modules: [mod],
      input: "look",
      due: [{ id: "d", kind: "scheduled", text: "x", entities: ["sam"] }],
    });
    expect(ids.slice(1, 5)).toEqual(["sam", "glenys", "bell", "tomos"]);
  });

  it("uses module focus hints and filters unknown ids", () => {
    const mod = makeModule({ id: "m", focus: (_s, input) => (input.includes("pay") ? ["dai", "ghost"] : []) });
    const ids = mapAttention({ config, state: entityState(), modules: [mod, statsModule], input: "pay up", due: [] });
    expect(ids).toContain("dai");
    expect(ids).not.toContain("ghost");
  });

  it("excludes place entities with no facts and deduplicates", () => {
    const state = entityState();
    state.focus_next = ["cafe", "glenys", "glenys"];
    const ids = attend({ input: "Glenys at the Corner Cafe" }, state);
    expect(ids).not.toContain("cafe");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("orders the remainder by importance and recency, ties by id, and respects limit", () => {
    const ids = attend({ limit: 50 });
    const tail = ids.slice(2);
    expect(tail.indexOf("mara")).toBeLessThan(tail.indexOf("bell"));
    expect(tail.indexOf("bell")).toBeLessThan(tail.indexOf("sam"));
    expect(attend({ limit: 3 })).toHaveLength(3);
    expect(attend({ limit: 50 })).toEqual(ids);
  });

  it("hides an unmet person unless the player names them", () => {
    const state = entityState();
    state.entities.glenys = { ...state.entities.glenys!, tags: ["unmet"] };
    expect(attend({}, state)).not.toContain("glenys");
    expect(attend({ input: "I look for Glenys" }, state)).toContain("glenys");
  });

  it("returns an empty list when there is nothing to show", () => {
    const state = makeState({ entities: { player: makeEntity({ id: "player", location: null }) } });
    expect(attend({}, state)).toEqual([]);
  });
});
