import { applyDraft, collectDue, processOps, rollFate, validateDraft } from "@book/engine";
import { describe, expect, it } from "vitest";
import { getActiveModules, renderView, statsOf, inventoryOf, relationshipValue, eventsOf } from "../src/index.ts";
import { testConfig, testSetup } from "./helpers.ts";

const draft = (delta: unknown[], extra: Record<string, unknown> = {}) => ({
  narration: "You do the thing.",
  delta,
  beat: "Did the thing.",
  ...extra,
});

describe("op validation", () => {
  it("accepts a valid purchase and applies it", () => {
    const { config, modules, state } = testSetup();
    const next = applyDraft(
      state,
      config,
      modules,
      draft([
        { op: "stat.add", key: "money", amount: -4.2, reason: "cob" },
        { op: "inventory.add", owner: "player", item: "cob" },
        { op: "clock.advance", minutes: 20 },
      ]) as never,
      { input: "buy a cob", due: [] },
    );
    expect(statsOf(next).values.money).toBe(40.8);
    expect(inventoryOf(next).owners.player?.cob).toBe(1);
    expect(next.clock.now).toBe("2026-10-03T09:40");
    expect(next.turn).toBe(1);
    expect(state.turn).toBe(0);
    expect(statsOf(state).values.money).toBe(45);
  });

  it("flags overspending as game breaking", () => {
    const { config, modules, state } = testSetup();
    const res = validateDraft(state, config, modules, draft([{ op: "stat.add", key: "money", amount: -100 }]) as never);
    expect(res.ok).toBe(false);
    expect(res.violations[0]).toMatchObject({ severity: "game_breaking", code: "insufficient_funds" });
  });

  it("flags removing an unowned item as game breaking", () => {
    const { config, modules, state } = testSetup();
    const res = validateDraft(state, config, modules, draft([{ op: "inventory.remove", owner: "player", item: "sword" }]) as never);
    expect(res.violations[0]).toMatchObject({ severity: "game_breaking", code: "item_not_owned" });
  });

  it("treats malformed ops and unknown ids as fixable", () => {
    const { config, modules, state } = testSetup();
    const res = validateDraft(
      state,
      config,
      modules,
      draft([
        { op: "clock.advance", minutes: "ten" },
        { op: "entity.fact.add", id: "nobody", fact: "x" },
        { op: "stat.add", key: "mana", amount: 1 },
        { op: "does.not.exist" },
      ]) as never,
    );
    expect(res.violations.map((v) => v.code)).toEqual(["bad_op", "unknown_entity", "unknown_stat", "bad_op"]);
    expect(res.violations.every((v) => v.severity === "fixable")).toBe(true);
  });

  it("lets later ops see earlier ones in the same delta", () => {
    const { config, modules, state } = testSetup();
    const res = processOps(state, config, modules, [
      { op: "entity.create", id: "glenys", type: "person", name: "Glenys", location: "room" },
      { op: "entity.fact.add", id: "glenys", fact: "Lent a mower", importance: 3 },
      { op: "relationship.add", a: "player", b: "glenys", amount: 5 },
    ]);
    expect(res.violations).toEqual([]);
    expect(relationshipValue(res.state, "player", "glenys")).toBe(5);
    expect(res.state.entities.glenys?.facts[0]?.text).toBe("Lent a mower");
  });

  it("rejects time jumps beyond the per-turn limit", () => {
    const { config, modules, state } = testSetup();
    const res = validateDraft(state, config, modules, draft([{ op: "clock.advance", minutes: 300 }, { op: "clock.advance", minutes: 300 }]) as never);
    expect(res.violations.some((v) => v.code === "time_jump" && v.severity === "game_breaking")).toBe(true);
  });

  it("rejects ops from inactive modules as fixable", () => {
    const { config, modules, state } = testSetup({ modules: ["stats"] });
    const only = getActiveModules(config);
    expect(only.map((m) => m.id)).toEqual(["core", "stats"]);
    const res = validateDraft(state, config, modules, draft([{ op: "inventory.add", owner: "player", item: "phone" }]) as never);
    expect(res.violations[0]?.code).toBe("inactive_op");
  });

  it("clamps bounded stats instead of rejecting", () => {
    const { config, modules, state } = testSetup();
    const res = processOps(state, config, modules, [{ op: "stat.add", key: "health", amount: -500 }]);
    expect(res.violations).toEqual([]);
    expect(statsOf(res.state).values.health).toBe(0);
  });

  it("rejects moving dead entities", () => {
    const { config, modules, state } = testSetup();
    const dead = structuredClone(state);
    dead.entities.dai!.tags.push("dead");
    const res = validateDraft(dead, config, modules, draft([{ op: "entity.move", id: "dai", location: "room" }]) as never);
    expect(res.violations[0]).toMatchObject({ severity: "game_breaking", code: "dead_entity" });
  });
});

describe("turn application", () => {
  it("always advances time by at least min_per_action and records window and beat", () => {
    const { config, modules, state } = testSetup();
    const next = applyDraft(state, config, modules, draft([]) as never, { input: "look", due: [] });
    expect(next.clock.now).toBe("2026-10-03T09:21");
    expect(next.beats).toEqual([{ turn: 1, text: "Did the thing." }]);
    expect(next.window[0]).toMatchObject({ turn: 1, input: "look" });
  });

  it("refuses to apply an invalid draft", () => {
    const { config, modules, state } = testSetup();
    expect(() => applyDraft(state, config, modules, draft([{ op: "stat.add", key: "money", amount: -999 }]) as never, { input: "x", due: [] })).toThrow();
  });

  it("filters focus_next to known entities", () => {
    const { config, modules, state } = testSetup();
    const next = applyDraft(state, config, modules, draft([], { focus_next: ["dai", "ghost"] }) as never, { input: "x", due: [] });
    expect(next.focus_next).toEqual(["dai"]);
  });
});

describe("events", () => {
  it("fires scheduled events once the clock reaches them and opens a thread", () => {
    const { config, modules, state } = testSetup();
    const later = { ...state, clock: { now: "2026-10-05T10:05" }, modules: { ...state.modules, events: { fired: {}, last_eval: "2026-10-05T09:00" } } };
    const due = collectDue(later, config, modules);
    expect(due.find((d) => d.id === "inspection")).toBeTruthy();
    const next = applyDraft(later, config, modules, draft([]) as never, { input: "x", due });
    expect(eventsOf(next).fired.inspection).toBe("2026-10-05T10:05");
    expect(next.threads.some((t) => t.text === "Inspection day")).toBe(true);
    expect(collectDue(next, config, modules).find((d) => d.id === "inspection")).toBeUndefined();
  });

  it("fires conditional events when the condition holds", () => {
    const { config, modules, state } = testSetup();
    const broke = structuredClone(state);
    (broke.modules.stats as { values: Record<string, number> }).values.money = 2;
    expect(collectDue(broke, config, modules).some((d) => d.id === "broke")).toBe(true);
  });

  it("rolls random events deterministically per save and turn", () => {
    const { config, modules, state } = testSetup();
    const s = structuredClone(state);
    s.modules.events = { fired: {}, last_eval: "2026-10-03T03:20" };
    const a = collectDue(s, config, modules).map((d) => d.text);
    const b = collectDue(s, config, modules).map((d) => d.text);
    expect(a).toEqual(b);
  });

  it("never fires random events on the very first turn", () => {
    const { config, modules, state } = testSetup();
    expect(collectDue(state, config, modules).some((d) => d.kind === "random")).toBe(false);
  });
});

describe("fate die", () => {
  it("is deterministic and within range", () => {
    const { config, state } = testSetup();
    const a = rollFate(state, config);
    expect(a).toBe(rollFate(state, config));
    expect(a).toBeGreaterThanOrEqual(1);
    expect(a).toBeLessThanOrEqual(100);
  });

  it("is absent when the dice module config is missing", () => {
    const config = testConfig();
    const { dice: _dice, ...rest } = config;
    const { state } = testSetup();
    expect(rollFate(state, rest as never)).toBeUndefined();
  });
});

describe("renderView", () => {
  it("builds the status line in code", () => {
    const { config, modules, state } = testSetup();
    const view = renderView(config, state, modules);
    expect(view.status).toBe("money: £45.00 | health: 100/100 | Box room | Sat 3 Oct 2026, 09:20");
    expect(view.panel).toEqual([]);
  });

  it("hides everything in the novel profile and shows a panel in tabletop", () => {
    const novel = testSetup({ presentation: { profile: "novel", status_line: [] } });
    expect(renderView(novel.config, novel.state, novel.modules)).toEqual({ status: null, panel: [] });
    const tabletop = testSetup({ presentation: { profile: "tabletop", status_line: ["money"] } });
    const view = renderView(tabletop.config, tabletop.state, tabletop.modules);
    expect(view.panel.join("\n")).toContain("money");
    expect(view.panel.join("\n")).toContain("Phone");
  });
});

describe("replay determinism", () => {
  it("applying the same drafts yields identical state", () => {
    const { config, modules, state } = testSetup();
    const drafts = [
      draft([{ op: "stat.add", key: "money", amount: -3 }, { op: "clock.advance", minutes: 30 }]),
      draft([{ op: "entity.move", id: "player", location: "kitchen" }]),
    ];
    const run = () => drafts.reduce((s, d) => applyDraft(s, config, modules, d as never, { input: "x", due: collectDue(s, config, modules) }), state);
    expect(run()).toEqual(run());
  });
});
