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

  it("keeps catalog prices and a visited place ahead of an unvisited one", () => {
    const config = makeConfig({
      items: [{ id: "loaf", name: "Loaf", price: 0.59 }],
      stats: [{ key: "money", type: "currency", start: 10, display: "£" }],
    });
    const state = makeState();
    state.entities.lidl = {
      ...state.entities.cafe!,
      id: "lidl",
      name: "Lidl",
      tags: [],
      last_touched: 4,
      facts: [],
    };
    state.entities.hospital = {
      ...state.entities.cafe!,
      id: "hospital",
      name: "Hospital",
      tags: ["unvisited"],
      last_touched: 0,
      facts: [{ text: "Mentioned once", importance: 1, turn: 0 }],
    };
    const text =
      buildTurnContext({
        config,
        state,
        modules: [],
        input: "back to the shops",
        kind: "act",
        due: [],
        budget: { world_sheet: 55 },
      }).messages[0]?.content ?? "";
    const sheet = text.split("## FOCUS ENTITIES")[0] ?? text;
    expect(sheet).toContain("- loaf: Loaf, good, £0.59");
    expect(sheet).toContain("lidl: Lidl");
    expect(sheet).not.toContain("hospital: Hospital");
  });
});
