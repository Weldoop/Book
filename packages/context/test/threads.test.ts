import { describe, expect, it } from "vitest";
import { selectThreads } from "../src/attention.ts";
import { contractText } from "../src/contract.ts";
import { threadsSection } from "../src/sections.ts";
import { makeConfig, makeEntity, makeState, makeThread } from "./fixtures.ts";

const NOW = "2026-10-03T12:00";

function withThreads(threads: Parameters<typeof makeThread>[0][], over: Record<string, unknown> = {}) {
  const config = makeConfig(over);
  const state = makeState({
    clock: { now: NOW },
    threads: threads.map((t) => makeThread(t)),
    entities: {
      player: makeEntity({ id: "player", name: "You", location: "room" }),
      room: makeEntity({ id: "room", type: "place", name: "Room" }),
      dai: makeEntity({ id: "dai", name: "Dai", location: "room" }),
    },
  });
  return { config, state };
}

/** Puts Dai on the thread so a warm thread counts as in the scene. */
function involve(state: ReturnType<typeof withThreads>["state"], ids: string[]): void {
  for (const id of ids) {
    const thread = state.threads.find((t) => t.id === id);
    if (thread) thread.entities = ["dai"];
  }
}

describe("selectThreads", () => {
  it("caps the prompt at max_in_context while the pool stays whole", () => {
    const { config, state } = withThreads(
      [1, 2, 3, 4, 5, 6].map((n) => ({ id: `t${n}`, opened_turn: n })),
      { threads: { max_in_context: 4, max_reminders: 2, rewarm_hours: 12 } },
    );
    involve(state, ["t1", "t2", "t3", "t4", "t5", "t6"]);
    expect(selectThreads(state, config)).toHaveLength(4);
    expect(state.threads).toHaveLength(6);
  });

  it("drops a cold thread even when its person is in the room", () => {
    const { config, state } = withThreads([
      { id: "warm" },
      { id: "cold", warm: false },
    ]);
    involve(state, ["warm", "cold"]);
    expect(selectThreads(state, config, "make tea").map((t) => t.id)).toEqual(["warm"]);
  });

  it("brings a cold thread back when its deadline is in view", () => {
    const { config, state } = withThreads([{ id: "cold", warm: false, due: "2026-10-03T18:00" }]);
    expect(selectThreads(state, config).map((t) => t.id)).toEqual(["cold"]);
  });

  it("does not treat naming the player as a reason to keep a thread alive", () => {
    const { config, state } = withThreads([{ id: "cold", warm: false, entities: ["player"] }]);
    expect(selectThreads(state, config, "I look around")).toEqual([]);
  });

  it("brings a cold thread back when someone it involves is on screen", () => {
    const { config, state } = withThreads([{ id: "cold", warm: false, entities: ["dai"] }]);
    expect(selectThreads(state, config, "where is Dai").map((t) => t.id)).toEqual(["cold"]);
    expect(selectThreads(state, config, "stare at the wall")).toEqual([]);
  });

  it("puts a near deadline ahead of an on-screen thread, and both ahead of the rest", () => {
    const { config, state } = withThreads([
      { id: "later", opened_turn: 9 },
      { id: "onscreen", entities: ["dai"] },
      { id: "deadline", due: "2026-10-03T16:00" },
    ]);
    expect(selectThreads(state, config, "talk to Dai").map((t) => t.id)).toEqual(["deadline", "onscreen"]);
  });

  it("reserves slots for two majors and leaves an unclaimed offer out", () => {
    const { config, state } = withThreads([
      { id: "offer", scale: "potential" },
      { id: "major-a", scale: "major", opened_turn: 2 },
      { id: "major-b", scale: "major", opened_turn: 3 },
      { id: "major-c", scale: "major", opened_turn: 4 },
      { id: "minor-a", opened_turn: 5 },
      { id: "minor-b", opened_turn: 6 },
      { id: "minor-c", opened_turn: 7 },
    ]);
    involve(state, ["offer", "major-a", "major-b", "major-c", "minor-a", "minor-b", "minor-c"]);
    expect(selectThreads(state, config).map((t) => t.id)).toEqual(["major-c", "major-b", "minor-c", "minor-b"]);
  });

  it("pulls a warm thread when the player is in its place", () => {
    const { config, state } = withThreads([{ id: "kitchen-job", entities: ["kitchen"] }]);
    state.entities.kitchen = makeEntity({ id: "kitchen", type: "place", name: "Kitchen" });
    state.entities.player = makeEntity({ id: "player", name: "You", location: "kitchen" });
    expect(selectThreads(state, config, "sit down").map((t) => t.id)).toEqual(["kitchen-job"]);
    state.entities.player = makeEntity({ id: "player", name: "You", location: "room" });
    expect(selectThreads(state, config, "sit down")).toEqual([]);
  });

  it("orders competing deadlines soonest first", () => {
    const { config, state } = withThreads([
      { id: "late", due: "2026-10-03T22:00" },
      { id: "soon", due: "2026-10-03T14:00" },
    ]);
    expect(selectThreads(state, config).map((t) => t.id)).toEqual(["soon", "late"]);
  });

  it("offers a warm set-aside thread even when its people are elsewhere", () => {
    const { config, state } = withThreads([
      { id: "aside", scale: "minor", was_major: true, entities: ["glenys"] },
      { id: "ordinary", entities: ["dai"] },
    ]);
    state.entities.glenys = makeEntity({ id: "glenys", name: "Glenys", location: "elsewhere" });
    state.entities.elsewhere = makeEntity({ id: "elsewhere", type: "place", name: "Elsewhere" });
    expect(selectThreads(state, config, "make tea").map((t) => t.id)).toEqual(["aside", "ordinary"]);
  });

  it("lets a cold set-aside thread stay quiet until it is named or due", () => {
    const { config, state } = withThreads([{ id: "aside", scale: "minor", was_major: true, warm: false, entities: ["glenys"] }]);
    state.entities.glenys = makeEntity({ id: "glenys", name: "Glenys", location: "elsewhere" });
    expect(selectThreads(state, config, "make tea")).toEqual([]);
    expect(selectThreads(state, config, "what about Glenys").map((t) => t.id)).toEqual(["aside"]);
  });

  it("gives a set-aside minor a slot ahead of an ordinary one", () => {
    const { config, state } = withThreads(
      [
        { id: "major-a", scale: "major", opened_turn: 2 },
        { id: "major-b", scale: "major", opened_turn: 3 },
        { id: "ordinary-a", opened_turn: 8 },
        { id: "ordinary-b", opened_turn: 9 },
        { id: "aside", scale: "minor", was_major: true, opened_turn: 1 },
      ],
      { threads: { max_in_context: 4, max_majors: 2, max_reminders: 2, rewarm_hours: 12 } },
    );
    involve(state, ["major-a", "major-b", "ordinary-a", "ordinary-b"]);
    expect(selectThreads(state, config).map((t) => t.id)).toEqual(["major-b", "major-a", "aside", "ordinary-b"]);
  });

  it("ignores resolved and failed threads", () => {
    const { config, state } = withThreads([
      { id: "done", status: "resolved" },
      { id: "missed", status: "failed" },
      { id: "live" },
    ]);
    involve(state, ["live"]);
    expect(selectThreads(state, config).map((t) => t.id)).toEqual(["live"]);
  });
});

describe("threadsSection", () => {
  it("marks a set-aside thread so the narration can offer it back", () => {
    const { config, state } = withThreads([{ id: "t1", scale: "minor", was_major: true, text: "Get through the inspection" }]);
    const section = threadsSection(state, config, "", 500);
    expect(section.shown).toEqual(["t1"]);
    expect(section.text).toContain("set aside");
    expect(section.text).toContain("Get through the inspection");
    expect(section.text).not.toContain("was_major");
  });

  it("reports the ids it rendered so reminders can be counted", () => {
    const { config, state } = withThreads([{ id: "t1" }, { id: "t2" }]);
    involve(state, ["t1", "t2"]);
    const section = threadsSection(state, config, "", 500);
    expect(section.shown).toEqual(["t1", "t2"]);
    expect(section.text).toContain("t1");
  });

  it("marks itself trimmed when threads were left out of the prompt", () => {
    const { config, state } = withThreads([{ id: "t1" }, { id: "t2", warm: false }]);
    involve(state, ["t1", "t2"]);
    const section = threadsSection(state, config, "", 500);
    expect(section.shown).toEqual(["t1"]);
    expect(section.trimmed).toBe(true);
  });

  it("claims no reminder for a thread the budget dropped", () => {
    const { config, state } = withThreads([{ id: "t1" }, { id: "t2" }, { id: "t3" }]);
    involve(state, ["t1", "t2", "t3"]);
    const section = threadsSection(state, config, "", 12);
    expect(section.shown.length).toBeLessThan(3);
    expect(section.text.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(section.shown.length);
  });
});

describe("contract text", () => {
  it("tells the GM to explain failure in-world when the dice are hidden", () => {
    const text = contractText(makeConfig({ dice: { sides: 100, thresholds: [50], visible: false, stat_modifier: false } }), [], "narration_first");
    expect(text).toContain("concrete in-world reason");
    expect(text).not.toContain("The player sees the roll");
  });

  it("tells the GM the roll is on screen when the dice are visible", () => {
    const text = contractText(
      makeConfig({ dice: { sides: 20, thresholds: [10], visible: true, stat_modifier: true } }),
      [],
      "narration_first",
    );
    expect(text).toContain("The player sees the roll");
    expect(text).toContain("check\".stat");
  });

  it("switches the violence rule with the config", () => {
    const deflect = contractText(makeConfig({ meta: { ...makeConfig().meta, violence: "deflect" } }), [], "narration_first");
    const adventure = contractText(makeConfig({ meta: { ...makeConfig().meta, violence: "adventure" } }), [], "narration_first");
    expect(deflect).toContain("you never narrate the injury");
    expect(adventure).toContain("characters can die");
    expect(adventure).not.toContain("you never narrate the injury");
  });

  it("lets violence land under `consequence` and makes the world answer for it", () => {
    const text = contractText(makeConfig({ meta: { ...makeConfig().meta, violence: "consequence" } }), [], "narration_first");
    expect(text).toContain("it lands");
    expect(text).toContain("no gore");
    expect(text).toContain("The world answers immediately");
    expect(text).not.toContain("you never narrate the injury");
  });

  it("scales the consequence rule with harshness", () => {
    const soft = contractText(makeConfig({ meta: { ...makeConfig().meta, harshness: "forgiving" } }), [], "narration_first");
    const hard = contractText(makeConfig({ meta: { ...makeConfig().meta, harshness: "unforgiving" } }), [], "narration_first");
    expect(soft).toContain("Consequences are gentle");
    expect(hard).toContain("Consequences are heavy");
  });

  it("states the skip allowance and any rest rule", () => {
    const text = contractText(
      makeConfig({ time: { start: NOW, min_per_action: 1, max_per_turn: 480, max_skip_minutes: 0, rest_note: "machines do not sleep" } }),
      [],
      "narration_first",
    );
    expect(text).toContain("does not skip time");
    expect(text).toContain("machines do not sleep");
  });

  it("warns the GM that the thread list is partial", () => {
    const text = contractText(makeConfig(), [], "narration_first");
    expect(text).toContain("not all of them");
    expect(text).toContain("set aside");
    expect(text).toContain("its deadline still happens");
    expect(text).toContain("Never say those words to the player");
  });

  it("forbids writing the narration twice", () => {
    expect(contractText(makeConfig(), [], "narration_first")).toContain("Never write the story as plain text as well");
  });
});
