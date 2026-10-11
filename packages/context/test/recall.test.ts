import { describe, expect, it } from "vitest";
import type { Fact } from "@book/schema";
import { buildTurnContext } from "../src/index.ts";
import { entityPlaces, recallHaystack, selectRecalledFacts } from "../src/recall.ts";
import { makeConfig, makeEntity, makeState, makeThread, statsModule } from "./fixtures.ts";

function fact(text: string, importance: 1 | 2 | 3, turn: number): Fact {
  return { text, importance, turn };
}

describe("recall before the reply", () => {
  it("pulls a buried fact that shares the player's line, and a debt, ahead of colder ones", () => {
    const buried = fact("She calls you Weldo", 1, 1);
    const fillers = [2, 3, 4, 5, 6, 7].map((turn) => fact(`Passing remark ${turn} about the weather`, 2, turn));
    const glenys = makeEntity({
      id: "glenys",
      name: "Glenys",
      location: "flat",
      facts: [...fillers, buried],
    });
    const state = makeState({
      entities: {
        ...makeState().entities,
        player: makeEntity({ id: "player", name: "You", aliases: ["Weldo"], location: "flat" }),
        glenys,
      },
    });
    const hay = recallHaystack("look around", [], ["You", "Weldo"]);
    const picked = selectRecalledFacts(glenys.facts, state.clock.now, hay, entityPlaces(state), 6);
    expect(picked.map((item) => item.text)).toContain("She calls you Weldo");
    expect(picked).toHaveLength(6);

    const debt = fact("Owes you £7 from the shop run", 1, 1);
    const nia = makeEntity({
      id: "nia",
      name: "Nia",
      location: "flat",
      facts: [...fillers, debt],
    });
    const owing = makeState({
      entities: { ...makeState().entities, nia },
      threads: [makeThread({ id: "t6", text: "Aisha and Nia owe you £7 from the shop run" })],
    });
    const shown = buildTurnContext({
      config: makeConfig(),
      state: owing,
      modules: [statsModule],
      input: "look around",
      kind: "act",
      due: [],
    });
    expect(shown.messages[0]?.content).toContain("Owes you £7 from the shop run");
  });

  it("shows the witnessed place, not the later contradiction", () => {
    const state = makeState();
    state.entities.market = makeEntity({ id: "market", type: "place", name: "The market" });
    const glenys = state.entities.glenys;
    if (!glenys) throw new Error("missing glenys");
    glenys.facts = [
      fact("Sold the camera at the cafe for £38", 2, 4),
      fact("Sold the camera at the market for £38", 2, 9),
      fact("Hums while she gardens", 1, 2),
    ];
    const text =
      buildTurnContext({
        config: makeConfig(),
        state,
        modules: [statsModule],
        input: "what did we do with the camera",
        kind: "act",
        due: [],
      }).messages[0]?.content ?? "";
    expect(text).toContain("Sold the camera at the cafe for £38");
    expect(text).not.toContain("Sold the camera at the market for £38");
  });

  it("leaves an expired fact out and returns nothing when the cap is zero", () => {
    const facts = [fact("You were short about the bins", 1, 1)];
    facts[0]!.expires = "2026-10-01T09:00";
    expect(selectRecalledFacts(facts, "2026-10-03T09:20", "bins", ["flat"], 6)).toEqual([]);
    expect(selectRecalledFacts([fact("Keeps the spare key", 2, 1)], "2026-10-03T09:20", "key", [], 0)).toEqual([]);
  });
});
