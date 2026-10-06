import { coreModule, createInitialState } from "@book/engine";
import { ConfigSchema, type Config, type Module, type State } from "@book/schema";
import { getActiveModules } from "../src/index.ts";

export function testConfig(overrides: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({
    id: "test-game",
    version: 1,
    meta: { title: "Test", tone: "dry", content_rating: "clean" },
    modules: ["stats", "inventory", "relationships", "events", "dice"],
    gm_style: { interludes: ["The world wobbles."], rollback_note: "Try something else." },
    presentation: { profile: "light", status_line: ["money", "health", "location", "time"] },
    time: { start: "2026-10-03T09:20", min_per_action: 1, max_per_turn: 480 },
    stats: [
      { key: "money", type: "currency", start: 45, display: "GBP" },
      { key: "health", type: "bounded", min: 0, max: 100, start: 100 },
    ],
    items: [
      { id: "phone", name: "Phone" },
      { id: "cob", name: "Cob", price: 4.2 },
      { id: "spare", name: "Spare" },
      { id: "torch", name: "Torch", keeps: true },
    ],
    dice: { sides: 100, thresholds: [10, 25, 50, 75, 90], labels: ["a", "b", "c", "d", "e", "f"] },
    events: {
      scheduled: [{ id: "inspection", at: "2026-10-05T10:00", text: "Inspection", thread: { kind: "commitment", text: "Inspection day" } }],
      conditional: [{ id: "broke", when: { kind: "stat", key: "money", op: "<", value: 5 }, text: "You are nearly broke." }],
      random: [{ id: "street", chance_per_hour: 0.5, entries: [{ text: "A pigeon steals your lunch.", weight: 1 }] }],
    },
    seed: {
      entities: [
        { id: "player", type: "person", name: "Nathan", location: "room" },
        { id: "room", type: "place", name: "Box room" },
        { id: "kitchen", type: "place", name: "Kitchen" },
        { id: "dai", type: "person", name: "Dai", location: "kitchen", facts: ["Bus driver"] },
      ],
      inventory: [{ owner: "player", item: "phone", qty: 1 }],
      relationships: [{ a: "player", b: "dai", value: 5 }],
    },
    ...overrides,
  });
}

export function testSetup(overrides: Record<string, unknown> = {}): { config: Config; modules: Module[]; state: State } {
  const config = testConfig(overrides);
  const modules = getActiveModules(config);
  const state = createInitialState(config, modules, "save-1");
  return { config, modules, state };
}

export { coreModule };
