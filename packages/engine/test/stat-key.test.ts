import { describe, expect, it } from "vitest";
import { ConfigSchema, TurnDraftSchema, type Config, type Module, type Op, type State } from "@book/schema";
import { createInitialState, processOps, resolveStatKey, validateDraft } from "../src/index.ts";
import { coreModule } from "../src/core.ts";

function config(): Config {
  return ConfigSchema.parse({
    id: "t",
    version: 1,
    meta: { title: "T", tone: "dry" },
    modules: ["core"],
    gm_style: { interludes: ["wobble"], rollback_note: "again" },
    presentation: { profile: "light", status_line: [] },
    time: { start: "1717-05-01T06:00" },
    stats: [
      { key: "gold", label: "Gold", type: "currency", start: 120, display: "doubloons" },
      { key: "crew_morale", label: "Crew morale", type: "bounded", min: 0, max: 100, start: 65 },
      { key: "ship_hull", label: "Hull", type: "bounded", min: 0, max: 100, start: 85 },
      { key: "reputation_crown", label: "Infamy with the Crown", type: "counter", min: 0, start: 5 },
    ],
    seed: {
      entities: [
        { id: "player", type: "person", name: "You", location: "ship" },
        { id: "ship", type: "place", name: "The Marigold" },
      ],
    },
  });
}

const statsModule: Module = {
  id: "stats",
  ops: ["stat.add", "stat.set"],
  initState: () => ({ values: {} }),
  validateOp: () => [],
  applyOp(op: Op, state: State): State {
    if (op.op !== "stat.add") return state;
    const next = structuredClone(state);
    const stats = (next.modules.stats as { values: Record<string, number> } | undefined) ?? { values: {} };
    next.modules.stats = stats;
    stats.values[op.key] = (stats.values[op.key] ?? 0) + op.amount;
    return next;
  },
  promptFragment: () => "",
  focus: () => [],
  due: () => [],
  snapshot: () => [],
  render: () => ({}),
};

describe("stat keys", () => {
  const cfg = config();

  it("maps a label or a loose id onto the real key", () => {
    expect(resolveStatKey(cfg, "Gold")).toBe("gold");
    expect(resolveStatKey(cfg, "Crew morale")).toBe("crew_morale");
    expect(resolveStatKey(cfg, "crew-morale")).toBe("crew_morale");
    expect(resolveStatKey(cfg, "Hull")).toBe("ship_hull");
    expect(resolveStatKey(cfg, "Infamy with the Crown")).toBe("reputation_crown");
    expect(resolveStatKey(cfg, "infamy-with-the-crown")).toBe("reputation_crown");
    expect(resolveStatKey(cfg, "seamanship")).toBeUndefined();
  });

  it("stores the real id when the delta uses the label", () => {
    const state = createInitialState(cfg, [coreModule, statsModule], "s1");
    const res = processOps(state, cfg, [coreModule, statsModule], [
      { op: "stat.add", key: "Gold", amount: -20, reason: "rum" },
    ]);
    expect(res.violations).toEqual([]);
    expect(res.applied[0]).toMatchObject({ key: "gold", amount: -20 });
    expect((res.state.modules.stats as { values: Record<string, number> }).values.gold).toBe(-20);
  });

  it("accepts a label on check.stat and rejects an invented skill", () => {
    const state = createInitialState(cfg, [coreModule], "s1");
    const labeled = {
      narration: "You hold the rail.",
      delta: [],
      beat: "Held the rail.",
      check: { what: "keeping the deck", stat: "Crew morale" },
    };
    const known = validateDraft(state, cfg, [coreModule], labeled);
    expect(known.violations.filter((v) => v.code === "unknown_stat")).toEqual([]);
    expect(labeled.check.stat).toBe("crew_morale");

    const invented = validateDraft(state, cfg, [coreModule], {
      narration: "You hold the rail.",
      delta: [],
      beat: "Held the rail.",
      check: { what: "boarding", stat: "seamanship" },
    });
    expect(invented.violations.map((v) => v.code)).toEqual(["unknown_stat"]);
    expect(invented.violations[0]?.severity).toBe("fixable");
  });

  it("treats a null check as no check", () => {
    const parsed = TurnDraftSchema.safeParse({
      narration: "You hold the rail.",
      delta: [],
      beat: "Held the rail.",
      check: null,
    });
    expect(parsed.success).toBe(true);
  });
});
