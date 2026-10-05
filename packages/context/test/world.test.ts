import { describe, expect, it } from "vitest";
import { buildTurnContext } from "../src/index.ts";
import { makeConfig, makeState } from "./fixtures.ts";

describe("world sheet", () => {
  it("lists catalog ids and prices, marks unvisited places, and keeps unmet people off the scene roster", () => {
    const config = makeConfig({
      items: [{ id: "garden-gloves", name: "Garden gloves", price: 4 }],
      stats: [{ key: "money", type: "currency", start: 10, display: "£" }],
    });
    const state = makeState();
    state.entities.cafe = {
      ...state.entities.cafe!,
      tags: ["unvisited"],
      facts: [{ text: "Someone mentioned it", importance: 1, turn: 0 }],
    };
    state.entities.glenys = { ...state.entities.glenys!, tags: ["unmet"] };
    const text =
      buildTurnContext({ config, state, modules: [], input: "look around", kind: "act", due: [] }).messages[0]?.content ??
      "";
    expect(text).toContain("## WORLD SHEET");
    expect(text).toContain("Gear is kept.");
    expect(text).toContain("- garden-gloves: Garden gloves, good, £4");
    expect(text).toContain("cafe: Corner Cafe (not yet visited)");
    expect(text).toContain("do not name them");
    expect(text).toContain("- glenys: Glenys");
    const present = text.split("\n").find((line) => line.startsWith("Present:")) ?? "";
    expect(present).not.toContain("Glenys");
  });
});
