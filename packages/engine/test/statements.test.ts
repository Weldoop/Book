import { describe, expect, it } from "vitest";
import { ConfigSchema, StateSchema, type Config } from "@book/schema";
import {
  applyDraft,
  coreModule,
  createInitialState,
  LEDGER_CAP,
  readPlayerStatements,
  recordPlayerStatements,
} from "../src/index.ts";

function config(): Config {
  return ConfigSchema.parse({
    id: "t",
    version: 1,
    meta: { title: "T", tone: "dry" },
    modules: ["core"],
    gm_style: { interludes: ["wobble"], rollback_note: "again" },
    presentation: { profile: "light", status_line: [] },
    time: { start: "2026-10-03T09:00" },
    seed: {
      entities: [
        { id: "player", type: "person", name: "You", location: "kitchen" },
        { id: "kitchen", type: "place", name: "Kitchen" },
        { id: "dai", type: "person", name: "Dai", location: "garden" },
        { id: "cerys", type: "person", name: "Cerys", location: "kitchen" },
        { id: "marcus", type: "person", name: "Marcus", location: "kitchen" },
      ],
    },
  });
}

function draft(delta: unknown[] = []) {
  return { narration: "Time passes.", delta, beat: "Time passes." };
}

describe("player statements", () => {
  it("writes a stated name, a nickname, a reported promise, a debt, and a plan", () => {
    const cfg = config();
    const state = createInitialState(cfg, [coreModule], "s");
    state.entities.marcus!.location = "garden";
    const hits = readPlayerStatements(
      [
        "Its weldo, dai",
        "dai has already said hes doing the bins tomorrow",
        "My names nathan mrs pugh",
        "But you do owe me a coffee i Jokingly but seriously say",
        "Uplands tavern at 8 with a couple of my flatmates",
      ].join("\n"),
      state,
      cfg,
    );
    expect(hits.map((hit) => hit.text)).toEqual([
      "You go by Weldo.",
      "Dai is doing the bins tomorrow",
      "Your name is Nathan.",
      "Cerys owes you a coffee.",
      "Uplands tavern at 8",
    ]);
    expect(hits.find((hit) => hit.kind === "commitment" && hit.text.includes("bins"))?.thread?.entities).toEqual(["dai"]);
    expect(hits.find((hit) => hit.text.includes("coffee"))?.thread?.kind).toBe("debt");
  });

  it("does not keep weather, a price aside, a denial, or an out-of-character line", () => {
    const cfg = config();
    const state = createInitialState(cfg, [coreModule], "s");
    expect(readPlayerStatements("it's raining", state, cfg)).toEqual([]);
    expect(readPlayerStatements("Dont worry about it, its only a couple of quid", state, cfg)).toEqual([]);
    expect(readPlayerStatements("you don't owe me a coffee", state, cfg)).toEqual([]);
    expect(readPlayerStatements("you do not owe me a tenner", state, cfg)).toEqual([]);
    expect(readPlayerStatements("OOC: my name is Nathan", state, cfg)).toEqual([]);
    expect(readPlayerStatements("(what is my name)", state, cfg)).toEqual([]);
    expect(readPlayerStatements("It's Dai", state, cfg)).toEqual([]);
  });

  it("names both people in the room when you is not one person", () => {
    const cfg = config();
    const state = createInitialState(cfg, [coreModule], "s");
    const hits = readPlayerStatements("you do owe me a coffee", state, cfg);
    expect(hits[0]?.text).toBe("Cerys and Marcus owe you a coffee.");
    expect(hits[0]?.thread?.entities).toEqual(["cerys", "marcus"]);
  });

  it("commits the line onto the player, the ledger, and a minor thread", () => {
    const cfg = config();
    const state = createInitialState(cfg, [coreModule], "s");
    state.entities.marcus!.location = "garden";
    const next = applyDraft(
      state,
      cfg,
      [coreModule],
      draft(),
      { input: "Its weldo, dai\nMy names nathan\nBut you do owe me a coffee", due: [] },
    );
    expect(next.entities.player?.name).toBe("Nathan");
    expect(next.entities.player?.aliases).toContain("Weldo");
    expect(next.ledger.map((entry) => entry.text)).toEqual([
      "You go by Weldo.",
      "Your name is Nathan.",
      "Cerys owes you a coffee.",
    ]);
    expect(next.ledger.every((entry) => entry.turn === 1)).toBe(true);
    const debt = next.threads.find((thread) => thread.text.includes("coffee"));
    expect(debt?.scale).toBe("minor");
    expect(debt?.kind).toBe("debt");
    expect(debt?.entities).toEqual(["cerys"]);
    expect(state.entities.player?.name).toBe("You");
  });

  it("keeps the name when the commitment cap drops the oldest plan", () => {
    const cfg = config();
    const state = createInitialState(cfg, [coreModule], "s");
    recordPlayerStatements(state, cfg, "My names nathan");
    for (let n = 1; n <= LEDGER_CAP + 1; n++) {
      state.turn = n;
      recordPlayerStatements(state, cfg, `North gate at ${n}`);
    }
    const commitments = state.ledger.filter((entry) => entry.kind === "commitment");
    expect(state.ledger.some((entry) => entry.kind === "name")).toBe(true);
    expect(commitments).toHaveLength(LEDGER_CAP);
    expect(commitments[0]?.text).toBe("North gate at 2");
    expect(commitments.at(-1)?.text).toBe(`North gate at ${LEDGER_CAP + 1}`);
  });

  it("loads a save that was written before the ledger existed", () => {
    const cfg = config();
    const state = createInitialState(cfg, [coreModule], "s");
    const raw = StateSchema.parse(state);
    const stored = { ...raw } as { ledger?: unknown };
    delete stored.ledger;
    expect(StateSchema.parse(stored).ledger).toEqual([]);
  });
});
