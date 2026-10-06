import { applyDraft, collectDue, processOps, rollFate, validateDraft } from "@book/engine";
import { describe, expect, it } from "vitest";
import { fateLabel, formatStat, getActiveModules, renderView, statsOf, inventoryOf, relationshipValue, eventsOf } from "../src/index.ts";
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

  it("rejects a huge stack of one object and points the repair at the balance", () => {
    const { config, modules, state } = testSetup();
    const res = validateDraft(
      state,
      config,
      modules,
      draft([{ op: "inventory.add", owner: "player", item: "cob", qty: 65 }]) as never,
    );
    expect(res.violations[0]).toMatchObject({ severity: "fixable", code: "stack_too_large" });
    expect(res.violations[0]?.message).toContain("stat.add");
    expect(res.violations[0]?.message).toContain("money");
  });

  it("flags overspending as game breaking", () => {
    const { config, modules, state } = testSetup();
    const res = validateDraft(state, config, modules, draft([{ op: "stat.add", key: "money", amount: -100 }]) as never);
    expect(res.ok).toBe(false);
    expect(res.violations[0]).toMatchObject({ severity: "game_breaking", code: "insufficient_funds" });
  });

  it("flags removing gear the player never had as game breaking, and lets a good the bag never held pass as narration", () => {
    const { config, modules, state } = testSetup();
    const gear = validateDraft(state, config, modules, draft([{ op: "inventory.remove", owner: "player", item: "torch" }]) as never);
    expect(gear.violations[0]).toMatchObject({ severity: "game_breaking", code: "item_not_owned" });
    const good = draft([{ op: "inventory.remove", owner: "player", item: "spare" }]) as never as { delta: unknown[] };
    const res = validateDraft(state, config, modules, good as never);
    expect(res.ok).toBe(true);
    expect(good.delta).toEqual([]);
  });

  it("keeps the charge and drops the bag op when a bought good is not on the sheet", () => {
    const { config, modules, state } = testSetup();
    const d = draft([
      { op: "stat.add", key: "money", amount: -2.3, reason: "Milk and a loaf" },
      { op: "inventory.add", owner: "player", item: "loaf" },
    ]) as never as { delta: unknown[] };
    const res = validateDraft(state, config, modules, d as never);
    expect(res.ok).toBe(true);
    expect(d.delta).toEqual([{ op: "stat.add", key: "money", amount: -2.3, reason: "Milk and a loaf" }]);
  });

  it("creates gear the save must remember and refuses a second copy", () => {
    const { config, modules, state } = testSetup();
    const next = applyDraft(
      state,
      config,
      modules,
      draft([
        { op: "item.create", id: "strimmer", name: "Petrol strimmer", keeps: true, price: 40 },
        { op: "inventory.add", owner: "player", item: "strimmer", qty: 1 },
        { op: "stat.add", key: "money", amount: -40, reason: "Petrol strimmer" },
      ]) as never,
      { input: "buy a strimmer", due: [] },
    );
    expect(inventoryOf(next).owners.player?.strimmer).toBe(1);
    expect(inventoryOf(next).catalog).toEqual([{ id: "strimmer", name: "Petrol strimmer", price: 40, keeps: true }]);
    const again = validateDraft(next, config, modules, draft([{ op: "inventory.add", owner: "player", item: "strimmer", qty: 1 }]) as never);
    expect(again.violations[0]?.code).toBe("gear_owned");
  });

  it("refuses to create an id the sheet already has", () => {
    const { config, modules, state } = testSetup();
    const res = validateDraft(state, config, modules, draft([{ op: "item.create", id: "cob", name: "Cob" }]) as never);
    expect(res.violations[0]).toMatchObject({ severity: "fixable", code: "item_exists" });
  });

  it("buys a scene good and finishes it in the same turn", () => {
    const { config, modules, state } = testSetup();
    const next = applyDraft(
      state,
      config,
      modules,
      draft(
        [
          { op: "item.create", id: "pint", name: "Pint of lager", price: 4.5 },
          { op: "inventory.add", owner: "player", item: "pint", qty: 1 },
          { op: "inventory.remove", owner: "player", item: "pint", qty: 1 },
          { op: "stat.add", key: "money", amount: -4.5, reason: "Pint of lager" },
        ],
        { narration: "You buy a pint of lager and drink it." },
      ) as never,
      { input: "buy a pint and drink it", due: [] },
    );
    expect(inventoryOf(next).owners.player?.pint).toBeUndefined();
    expect(inventoryOf(next).catalog).toEqual([{ id: "pint", name: "Pint of lager", price: 4.5 }]);
    expect(statsOf(next).values.money).toBe(40.5);
    const another = applyDraft(
      next,
      config,
      modules,
      draft([
        { op: "inventory.add", owner: "player", item: "pint", qty: 1 },
        { op: "stat.add", key: "money", amount: -4.5, reason: "Pint of lager" },
      ]) as never,
      { input: "another pint", due: [] },
    );
    expect(inventoryOf(another).owners.player?.pint).toBe(1);
  });

  it("leaves a carrier bag in the narration", () => {
    const { config, modules, state } = testSetup();
    const res = validateDraft(state, config, modules, {
      narration: "You hold the carrier bag and the receipt.",
      delta: [],
      beat: "A bag.",
    } as never);
    expect(res.violations).toEqual([]);
    expect(inventoryOf(state).catalog ?? []).toEqual([]);
  });

  it("rejects an item id that is not in the catalog", () => {
    const { config, modules, state } = testSetup();
    const res = validateDraft(state, config, modules, draft([{ op: "inventory.add", owner: "player", item: "sword" }]) as never);
    expect(res.violations[0]).toMatchObject({ severity: "fixable", code: "unknown_item" });
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
    const withinSkip = validateDraft(
      state,
      config,
      modules,
      draft([{ op: "clock.advance", minutes: 300 }, { op: "clock.advance", minutes: 300 }]) as never,
    );
    const hop = withinSkip.violations.find((v) => v.code === "time_jump");
    expect(hop).toMatchObject({ severity: "fixable" });
    expect(hop?.message).toContain("clock.skip");
    const overSkip = validateDraft(state, config, modules, draft([{ op: "clock.advance", minutes: 2000 }]) as never);
    expect(overSkip.violations.some((v) => v.code === "time_jump" && v.severity === "game_breaking")).toBe(true);
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
    expect(next.beats).toEqual([{ turn: 1, text: "Did the thing.", clock: "2026-10-03T09:21" }]);
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

  it("spreads a d20 from catastrophe to legendary", () => {
    const config = testConfig({
      dice: {
        sides: 20,
        thresholds: [5, 25, 50, 75, 90],
        labels: ["Catastrophe", "Failure", "Setback", "Success", "Strong success", "Legendary"],
      },
    });
    expect(fateLabel(config, 1)).toBe("Catastrophe");
    expect(fateLabel(config, 4)).toBe("Failure");
    expect(fateLabel(config, 11)).toBe("Success");
    expect(fateLabel(config, 19)).toBe("Legendary");
    expect(fateLabel(config, 20)).toBe("Legendary");
  });

  it("is absent when the dice module config is missing", () => {
    const config = testConfig();
    const { dice: _dice, ...rest } = config;
    const { state } = testSetup();
    expect(rollFate(state, rest as never)).toBeUndefined();
  });
});

describe("stat display", () => {
  it("writes a word currency after the number and keeps pounds as a symbol", () => {
    const gold = { key: "gold", type: "currency" as const, start: 72, display: "doubloons", hidden: false };
    const pounds = { key: "money", type: "currency" as const, start: 45, display: "GBP", hidden: false };
    const symbol = { key: "money", type: "currency" as const, start: 45, display: "£", hidden: false };
    expect(formatStat(gold, 72)).toBe("72.00 doubloons");
    expect(formatStat(pounds, 45)).toBe("£45.00");
    expect(formatStat(symbol, 45)).toBe("£45.00");
  });

  it("shows the id beside the label in the state snapshot", () => {
    const { config, modules, state } = testSetup({
      stats: [{ key: "gold", label: "Gold", type: "currency", start: 72, display: "doubloons" }],
    });
    const stats = modules.find((m) => m.id === "stats");
    expect(stats?.snapshot(state, config).join(" ")).toBe("Stats: Gold [gold]: 72.00 doubloons");
  });

  it("keeps a dated log of money moving, capped, and shows it under the stats", () => {
    const { config, modules, state } = testSetup();
    const stats = modules.find((m) => m.id === "stats");
    if (!stats) throw new Error("stats module missing");
    let next = { ...state, clock: { now: "2026-10-03T11:15" } };
    next = stats.applyOp({ op: "stat.add", key: "money", amount: -2.5, reason: "Milk and bread" }, next, config);
    next = stats.applyOp({ op: "stat.add", key: "health", amount: -5, reason: "Scratches" }, next, config);
    next = { ...next, clock: { now: "2026-10-05T21:00" } };
    next = stats.applyOp({ op: "stat.add", key: "money", amount: 40, reason: "Shift wages" }, next, config);
    expect(stats.snapshot(next, config).at(-1)).toBe("Money so far: Sat 3 Oct 11:15 -£2.50 money Milk and bread; Mon 5 Oct 21:00 +£40.00 money Shift wages");
    for (let i = 0; i < 15; i++) next = stats.applyOp({ op: "stat.add", key: "money", amount: -1, reason: `Coffee ${i}` }, next, config);
    const ledger = (next.modules.stats as { ledger: unknown[] }).ledger;
    expect(ledger).toHaveLength(10);
    expect(stats.snapshot(next, config).at(-1)).toContain("Coffee 14");
    expect(stats.snapshot(next, config).at(-1)).not.toContain("Milk");
  });

  it("repeats the status figures and what is carried as engine truth", () => {
    const { config, modules, state } = testSetup();
    const stats = modules.find((m) => m.id === "stats");
    const inventory = modules.find((m) => m.id === "inventory");
    expect(stats?.truth?.(state, config)).toEqual(["money: £45.00 | health: 100/100"]);
    expect(inventory?.truth?.(state, config)).toEqual(["Carrying (already owned): Phone"]);
  });
});

describe("renderView", () => {
  it("builds the status line in code", () => {
    const { config, modules, state } = testSetup();
    const view = renderView(config, state, modules);
    expect(view.status).toBe("money: £45.00 | health: 100/100 | Box room | Sat 3 Oct 2026, 09:20");
    expect(view.panel).toEqual([]);
  });

  it("shows energy when the status line asks for it and keeps relationship scores off the panel", () => {
    const { config, modules, state } = testSetup({
      presentation: { profile: "tabletop", status_line: ["money", "energy"] },
      stats: [
        { key: "money", type: "currency", start: 45, display: "GBP" },
        { key: "energy", label: "Energy", type: "bounded", min: 0, max: 100, start: 80 },
      ],
    });
    const view = renderView(config, state, modules);
    expect(view.status).toBe("money: £45.00 | Energy: 80/100");
    expect(view.panel.join("\n")).not.toContain("Relationships");
  });

  it("puts the turn number on the status line when the config asks for it", () => {
    const { config, modules, state } = testSetup({ presentation: { profile: "light", status_line: ["turn", "money"] } });
    expect(renderView(config, { ...state, turn: 7 }, modules).status).toBe("Turn 7 | money: £45.00");
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
