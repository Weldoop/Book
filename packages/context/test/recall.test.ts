import { describe, expect, it } from "vitest";
import type { Fact } from "@book/schema";
import { buildTurnContext } from "../src/index.ts";
import { answerFromSave, entityPlaces, recallHaystack, recallLines, selectRecalledFacts } from "../src/recall.ts";
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

describe("an out-of-character answer from the save", () => {
  const config = makeConfig();
  const state = makeState({
    entities: {
      ...makeState().entities,
      player: makeEntity({
        id: "player",
        name: "Nathan",
        aliases: ["weldo"],
        location: "flat",
        facts: [{ text: "Goes by weldo with housemates", importance: 2, turn: 1 }],
      }),
    },
    modules: {
      stats: { values: { money: 10 }, ledger: [{ clock: "2026-10-03T10:56", key: "money", amount: -4.2, reason: "Sausage and egg cob" }] },
      inventory: { owners: { player: { "salt-pork": 1 } } },
    },
    threads: [makeThread({ id: "t1", text: "Eighty doubloons owed to Crowe", status: "failed", due: "1717-05-10T12:00" })],
  });

  it("keeps player facts, the ledger and failed threads", () => {
    const lines = recallLines(state, config);
    expect(lines.some((line) => line.includes("weldo"))).toBe(true);
    expect(lines.some((line) => line.includes("Sausage and egg cob"))).toBe(true);
    expect(lines.some((line) => line.includes("salt-pork"))).toBe(true);
    expect(lines.some((line) => line.includes("Eighty doubloons"))).toBe(true);
  });

  it("answers a nickname, a purchase and a debt from the save, and stays quiet otherwise", () => {
    expect(answerFromSave(state, config, "What nickname do my housemates use?")).toContain("weldo");
    expect(answerFromSave(state, config, "What did I order at the cafe?")).toContain("Sausage and egg cob");
    expect(answerFromSave(state, config, "How many doubloons do I owe Captain Crowe?")).toMatch(/Eighty|eighty/);
    expect(answerFromSave(state, config, "What time is it?")).toBeNull();
  });

  it("reads a fact that is not on the player", () => {
    expect(answerFromSave(state, config, "When does Glenys want the mower back?")).toContain("4pm");
  });

  it("answers a pronoun from the stored tag and does not dump the ledger", () => {
    const harri = makeEntity({
      id: "harri",
      name: "Harri",
      location: "flat",
      tags: ["pronoun:he"],
      facts: [{ text: "Opens the door", importance: 2, turn: 1 }],
    });
    const next = makeState({
      entities: { ...state.entities, harri },
      modules: {
        stats: { values: { money: 10 }, ledger: [{ clock: "2026-10-03T10:56", key: "money", amount: 2, reason: "Gave Harri £2.00" }] },
      },
    });
    const answer = answerFromSave(next, config, "What pronouns does Harri use, he or she?");
    expect(answer).toBe("Harri uses he.");
    expect(answer).not.toContain("Ledger");
    expect(answer).not.toContain("£");
    expect(answerFromSave(state, config, "Is Glenys he or she?")).toBe("No pronoun is recorded for Glenys.");
  });
});
