import { describe, expect, it } from "vitest";
import { buildOocContext, buildTurnContext } from "../src/index.ts";
import { makeConfig, makeEntity, makeModule, makeState } from "./fixtures.ts";

describe("what the player said", () => {
  it("shows the name on the scene line and the ledger to a later question", () => {
    const config = makeConfig();
    const base = makeState();
    const state = makeState({
      turn: 122,
      entities: {
        ...base.entities,
        player: makeEntity({ id: "player", name: "Nathan", aliases: ["weldo"], location: "flat" }),
      },
      ledger: [
        { turn: 20, text: "Your name is Nathan.", kind: "name" },
        { turn: 19, text: "Dai is doing the bins tomorrow", kind: "commitment" },
        { turn: 77, text: "Uplands tavern at 8", kind: "commitment" },
      ],
    });
    const turn = buildTurnContext({
      config,
      state,
      modules: [makeModule({ id: "core" })],
      input: "hello",
      kind: "act",
      due: [],
    });
    const text = turn.messages[0]?.content ?? "";
    expect(text).toContain("You: Nathan [player]; aka weldo");
    expect(text).toContain("## WHAT YOU SAID");
    expect(text).toContain("Dai is doing the bins tomorrow");
    const names = turn.parts.map((part) => part.name);
    expect(names.indexOf("ledger")).toBeGreaterThan(names.indexOf("scene"));
    expect(names.indexOf("state_snapshot")).toBeGreaterThan(names.indexOf("ledger"));
    expect(turn.parts.find((part) => part.name === "ledger")?.tokens).toBeLessThanOrEqual(120);

    const ooc = buildOocContext({ config, state, modules: [], input: "OOC: Who said they were doing the bins?" });
    const question = ooc.messages[0]?.content ?? "";
    expect(question).toContain("Dai is doing the bins tomorrow");
    expect(question).toContain("Uplands tavern at 8");
    expect(question).toContain("You: Nathan [player]; aka weldo");
    expect(ooc.system[0]?.text).toContain("what the player has said");
  });
});
