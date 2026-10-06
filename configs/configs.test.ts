import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../packages/schema/src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ALLOWED_MODULES = ["stats", "inventory", "relationships", "events", "dice", "offscreen"];
const RESERVED_STATUS_KEYS = ["turn", "location", "time"];

const configNames = readdirSync(here, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(here, d.name, "config.json")))
  .map((d) => d.name)
  .sort();

function load(name: string): Config {
  const raw: unknown = JSON.parse(readFileSync(join(here, name, "config.json"), "utf8"));
  return ConfigSchema.parse(raw);
}

function parseLocal(value: string): number {
  const ms = Date.parse(`${value}:00Z`);
  expect(Number.isNaN(ms), `invalid datetime ${value}`).toBe(false);
  return ms;
}

describe("config discovery", () => {
  it("finds uk-life and pirate", () => {
    expect(configNames).toEqual(expect.arrayContaining(["uk-life", "pirate"]));
  });
});

describe.each(configNames)("config %s", (name) => {
  const config = load(name);
  const entityIds = new Set(config.seed.entities.map((e) => e.id));
  const itemIds = new Set(config.items.map((i) => i.id));
  const statKeys = new Set(config.stats.map((s) => s.key));

  it("parses with ConfigSchema and id matches directory", () => {
    expect(config.id).toBe(name);
  });

  it("has the player as a seeded person", () => {
    const player = config.seed.entities.find((e) => e.id === config.player_id);
    expect(player?.type).toBe("person");
    expect(player?.location && entityIds.has(player.location)).toBe(true);
  });

  it("only lists built modules", () => {
    for (const m of config.modules) expect(ALLOWED_MODULES).toContain(m);
    expect(new Set(config.modules).size).toBe(config.modules.length);
  });

  it("has unique seed entity, stat, item and event ids", () => {
    expect(entityIds.size).toBe(config.seed.entities.length);
    expect(statKeys.size).toBe(config.stats.length);
    expect(itemIds.size).toBe(config.items.length);
    const eventIds = [
      ...config.events.scheduled.map((e) => e.id),
      ...config.events.conditional.map((e) => e.id),
      ...config.events.random.map((e) => e.id),
    ];
    expect(new Set(eventIds).size).toBe(eventIds.length);
  });

  it("status line keys are stats or reserved display keys", () => {
    for (const key of config.presentation.status_line) {
      expect(statKeys.has(key) || RESERVED_STATUS_KEYS.includes(key), `status key ${key}`).toBe(true);
    }
  });

  it("stat definitions are coherent", () => {
    for (const s of config.stats) {
      if (s.min !== undefined) expect(s.start).toBeGreaterThanOrEqual(s.min);
      if (s.max !== undefined) expect(s.start).toBeLessThanOrEqual(s.max);
      if (s.type === "bounded") {
        expect(s.min).toBeDefined();
        expect(s.max).toBeDefined();
      }
    }
  });

  it("entity locations and seed references exist", () => {
    for (const e of config.seed.entities) {
      if (e.location) expect(entityIds.has(e.location), `${e.id} location ${e.location}`).toBe(true);
    }
    for (const t of config.seed.threads) {
      for (const id of t.entities) expect(entityIds.has(id), `thread entity ${id}`).toBe(true);
    }
    for (const inv of config.seed.inventory) {
      expect(entityIds.has(inv.owner), `inventory owner ${inv.owner}`).toBe(true);
      expect(itemIds.has(inv.item), `inventory item ${inv.item}`).toBe(true);
    }
    for (const r of config.seed.relationships) {
      expect(entityIds.has(r.a), `relationship ${r.a}`).toBe(true);
      expect(entityIds.has(r.b), `relationship ${r.b}`).toBe(true);
    }
  });

  it("scheduled events are valid, on or after start, and reference known entities", () => {
    const start = parseLocal(config.time.start);
    expect(config.events.scheduled.length).toBeGreaterThanOrEqual(3);
    for (const ev of config.events.scheduled) {
      expect(parseLocal(ev.at), `${ev.id} before start`).toBeGreaterThanOrEqual(start);
      for (const id of ev.entities) expect(entityIds.has(id), `${ev.id} entity ${id}`).toBe(true);
    }
    for (const t of config.seed.threads) {
      if (t.due) expect(parseLocal(t.due)).toBeGreaterThanOrEqual(start);
    }
  });

  it("conditional events reference existing stats and entities", () => {
    const kinds = new Set(config.events.conditional.map((c) => c.when.kind));
    expect(config.events.conditional.length).toBeGreaterThanOrEqual(2);
    expect(kinds.size).toBeGreaterThanOrEqual(2);
    for (const ev of config.events.conditional) {
      const w = ev.when;
      if (w.kind === "stat") expect(statKeys.has(w.key), `${ev.id} stat ${w.key}`).toBe(true);
      if (w.kind === "relationship") {
        expect(entityIds.has(w.a), `${ev.id} entity ${w.a}`).toBe(true);
        expect(entityIds.has(w.b), `${ev.id} entity ${w.b}`).toBe(true);
      }
      if (w.kind === "after") parseLocal(w.at);
      for (const id of ev.entities) expect(entityIds.has(id), `${ev.id} entity ${id}`).toBe(true);
    }
  });

  it("random tables are sane", () => {
    expect(config.events.random.length).toBeGreaterThanOrEqual(2);
    for (const r of config.events.random) {
      expect(r.chance_per_hour).toBeLessThanOrEqual(0.15);
      expect(r.entries.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("dice labels match thresholds and fit the die", () => {
    expect(config.dice).toBeDefined();
    const dice = config.dice!;
    expect(dice.labels).toHaveLength(dice.thresholds.length + 1);
    const sorted = [...dice.thresholds].sort((a, b) => a - b);
    expect(dice.thresholds).toEqual(sorted);
    expect(Math.max(...dice.thresholds)).toBeLessThan(100);
    expect(Math.min(...dice.thresholds)).toBeGreaterThan(0);
  });

  it("has enough interludes and a rollback note", () => {
    expect(config.gm_style.interludes.length).toBeGreaterThanOrEqual(5);
    expect(config.gm_style.rollback_note.length).toBeGreaterThan(10);
  });
});

describe("uk-life specifics", () => {
  const config = load("uk-life");

  it("matches the brief", () => {
    expect(config.modules).toEqual(["stats", "inventory", "relationships", "events", "dice", "offscreen"]);
    expect(config.time.start).toBe("2026-10-03T09:20");
    expect(config.meta.content_rating).toBe("romance");
    expect(config.presentation).toEqual({
      profile: "light",
      status_line: ["turn", "cash", "bank", "health", "energy", "location", "time"],
    });
    expect(config.seed.entities.filter((entity) => entity.type === "person" && entity.id !== "player").map((entity) => entity.id)).toEqual([
      "1",
      "2",
      "3",
      "4",
    ]);
    expect(config.events.scheduled.find((event) => event.id === "bins-out")?.entities).toContain("1");
    expect(config.opening?.pinned ?? []).toEqual([]);
    expect(config.opening?.cast?.map((person) => person.name)).toEqual([
      "Nia Davies",
      "Tomos Reed",
      "Aisha Khan",
      "Owen Price",
      "Leah Morgan",
      "Harri Jones",
      "Sian Berg",
      "Jake Okoye",
    ]);
    expect(config.stats.find((s) => s.key === "cash")?.start).toBe(15);
    expect(config.items.find((item) => item.id === "phone")?.keeps).toBe(true);
    expect(config.items.find((item) => item.id === "pint")?.keeps).toBeUndefined();
    expect(config.stats.find((s) => s.key === "bank")?.start).toBe(30);
    expect(config.dice).toMatchObject({ sides: 100, thresholds: [10, 25, 50, 75, 90] });
    expect(config.offscreen).toMatchObject({ enabled: true, min_skip_hours: 6, max_entities: 4, max_tokens: 600 });
    expect(config.gm_style).toMatchObject({ max_words: 90, person: "second", never_decide_for_player: true });
  });

  it("schedules the key weekend events", () => {
    const at = Object.fromEntries(config.events.scheduled.map((e) => [e.id, e.at]));
    expect(at["inspection-window"]).toBe("2026-10-05T10:00");
    expect(at["bins-out"]).toBe("2026-10-04T20:00");
    expect(at["mobile-plan-renewal"]?.startsWith("2026-10-05")).toBe(true);
  });
});

describe("pirate specifics", () => {
  const config = load("pirate");

  it("matches the brief", () => {
    expect(config.modules).toEqual(["stats", "inventory", "relationships", "events", "dice"]);
    expect(config.presentation.profile).toBe("tabletop");
    expect(config.meta.content_rating).toBe("clean");
    expect(config.dice).toMatchObject({
      sides: 20,
      thresholds: [5, 25, 50, 75, 90],
      visible: true,
      stat_modifier: false,
    });
    expect(config.time.max_per_turn).toBe(1440);
    expect(config.time.max_skip_minutes).toBe(10080);
    expect(config.travel.journeys).toEqual(expect.arrayContaining(["sail", "set a course", "weigh anchor"]));
    expect(config.travel.local).toEqual(expect.arrayContaining(["rail", "deck", "hold"]));
    expect(config.offscreen?.enabled ?? false).toBe(false);
    expect(config.opening).toEqual({});
    const keys = config.stats.map((s) => s.key);
    expect(keys).toEqual(
      expect.arrayContaining(["gold", "supplies", "crew_morale", "ship_hull", "reputation_crown", "reputation_pirates"]),
    );
  });
});
