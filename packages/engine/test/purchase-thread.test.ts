import { describe, expect, it } from "vitest";
import { ConfigSchema, type Config, type Module, type Op, type State, type Thread } from "@book/schema";
import { applyDraft, coreModule, createInitialState } from "../src/index.ts";

function config(): Config {
  return ConfigSchema.parse({
    id: "t",
    version: 1,
    meta: { title: "T", tone: "dry" },
    modules: ["core"],
    gm_style: { interludes: ["wobble"], rollback_note: "again" },
    presentation: { profile: "light", status_line: [] },
    time: { start: "2026-10-03T12:10" },
    items: [
      { id: "kenwood-mixer", name: "Kenwood mixer", price: 8, keeps: true },
      { id: "milk", name: "Pint of milk", price: 1.3 },
    ],
    seed: {
      entities: [
        { id: "player", type: "person", name: "You", location: "gates" },
        { id: "gates", type: "place", name: "Singleton Park gates" },
        { id: "cafe", type: "place", name: "Green Awning Cafe" },
      ],
    },
  });
}

const inventoryModule: Module = {
  id: "inventory",
  ops: ["inventory.add", "inventory.remove"],
  initState: () => ({ owners: {} }),
  validateOp: () => [],
  applyOp(op: Op, state: State): State {
    if (op.op !== "inventory.add" && op.op !== "inventory.remove") return state;
    const next = structuredClone(state);
    const inv = (next.modules.inventory as { owners: Record<string, Record<string, number>> } | undefined) ?? { owners: {} };
    next.modules.inventory = inv;
    const bag = (inv.owners[op.owner] ??= {});
    const qty = (bag[op.item] ?? 0) + (op.op === "inventory.add" ? op.qty : -op.qty);
    if (qty <= 0) delete bag[op.item];
    else bag[op.item] = qty;
    return next;
  },
  promptFragment: () => "",
  focus: () => [],
  due: () => [],
  snapshot: () => [],
  render: () => ({}),
};

const modules = [coreModule, inventoryModule];

function meetup(): Thread {
  return {
    id: "t14",
    kind: "commitment",
    text: "Meet mixer seller at Singleton Park gates at noon to buy Kenwood mixer for £8 cash",
    status: "open",
    entities: ["gates"],
    scale: "potential",
    was_major: false,
    warm: true,
    reminders: 0,
    last_shown_turn: 0,
    last_interacted_turn: 0,
    expires: "2026-10-03T12:00",
    opened_turn: 0,
  };
}

function play(location: string, delta: unknown[]): State {
  const cfg = config();
  const state = createInitialState(cfg, modules, "s");
  const player = state.entities.player;
  if (!player) throw new Error("missing player");
  player.location = location;
  state.threads = [meetup()];
  return applyDraft(state, cfg, modules, { narration: "You hand the cash over.", delta, beat: "The mixer." }, { input: "buy it", due: [] });
}

describe("a meetup kept by the purchase", () => {
  it("resolves the thread when the item is bought at its place, even after the offer expired", () => {
    const next = play("gates", [{ op: "inventory.add", owner: "player", item: "kenwood-mixer", qty: 1 }]);
    expect(next.threads[0]?.status).toBe("resolved");
  });

  it("leaves the thread open when the same item is bought somewhere else", () => {
    const next = play("cafe", [{ op: "inventory.add", owner: "player", item: "kenwood-mixer", qty: 1 }]);
    expect(next.threads[0]?.status).toBe("open");
  });

  it("fails the offer when the goods never arrive", () => {
    const next = play("gates", [{ op: "inventory.add", owner: "player", item: "milk", qty: 1 }]);
    expect(next.threads[0]?.status).toBe("failed");
    const missed = play("gates", []);
    expect(missed.threads[0]?.status).toBe("failed");
  });
});
