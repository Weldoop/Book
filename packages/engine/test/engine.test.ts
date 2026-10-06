import { describe, expect, it } from "vitest";
import {
  addMinutes,
  classifyInput,
  createRng,
  diffMinutes,
  humanTime,
  parseLocal,
  playerNotices,
  rngFor,
  stripOocPrefix,
} from "../src/index.ts";

describe("time", () => {
  it("adds minutes across midnight and formats", () => {
    expect(addMinutes("2026-10-03T23:50", 20)).toBe("2026-10-04T00:10");
    expect(diffMinutes("2026-10-04T00:10", "2026-10-03T23:50")).toBe(20);
    expect(humanTime("2026-10-03T09:20")).toBe("Sat 3 Oct 2026, 09:20");
    expect(() => parseLocal("nope")).toThrow();
  });
});

describe("rng", () => {
  it("is deterministic per seed and independent per salt", () => {
    const a = createRng(42);
    const b = createRng(42);
    expect([a.next(), a.next()]).toEqual([b.next(), b.next()]);
    expect(rngFor(1, 1, "a").next()).not.toBe(rngFor(1, 1, "b").next());
    expect(rngFor(1, 1, "a").next()).toBe(rngFor(1, 1, "a").next());
  });
});

describe("classifyInput", () => {
  it.each([
    ["...", "continue"],
    ["", "continue"],
    ["…", "continue"],
    ["OOC: wait is this doubles", "ooc"],
    ["OOC wait is this doubles", "ooc"],
    ["(what do I know?)", "ooc"],
    ["DM", "ooc"],
    ["Dm", "ooc"],
    ["Go to the shop", "act"],
    ["Crack on with the garden until 4 and drop the mower back next door...", "act"],
    ["What are loppers", "act"],
  ])("%s -> %s", (input, kind) => {
    expect(classifyInput(input)).toBe(kind);
  });

  it("strips the out-of-character prefix", () => {
    expect(stripOocPrefix("OOC: what now?")).toBe("what now?");
    expect(stripOocPrefix("(what now?)")).toBe("what now?");
  });
});

describe("playerNotices", () => {
  it("prints low-money warnings and broken promises, and leaves the calendar to the story", () => {
    const lines = playerNotices([
      { id: "low-funds", kind: "conditional", text: "Pasta week is approaching.", entities: ["player"] },
      { id: "overdue:t4", kind: "scheduled", text: "You said you would be there at two.", entities: [] },
      { id: "bins-out", kind: "scheduled", text: "Bin night.", entities: [] },
      { id: "street", kind: "random", text: "A seagull considers your sandwich.", entities: [] },
    ]);
    expect(lines).toEqual(["Pasta week is approaching.", "You said you would be there at two."]);
  });
});
