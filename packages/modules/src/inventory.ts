import { catalogItems } from "@book/engine";
import type { Config, ItemDef, Module, Op, State, Violation } from "@book/schema";

export interface InventoryState {
  owners: Record<string, Record<string, number>>;
  /** Items this save created. The book's catalog stays on the config. */
  catalog?: ItemDef[];
}

export function inventoryOf(state: State): InventoryState {
  return (state.modules.inventory as InventoryState | undefined) ?? { owners: {}, catalog: [] };
}

export function itemName(config: Config, id: string, state?: State): string {
  const created = state ? catalogItems(config, state).find((item) => item.id === id) : undefined;
  return created?.name ?? config.items.find((i) => i.id === id)?.name ?? id.replace(/[_-]/g, " ");
}

/** One inventory.add above this is a pile, not a purchase. Cash belongs on a currency stat. */
export const STACK_CAP = 12;

export const inventoryModule: Module = {
  id: "inventory",
  ops: ["item.create", "inventory.add", "inventory.remove"],

  initState(config) {
    const owners: Record<string, Record<string, number>> = {};
    for (const row of config.seed.inventory) {
      const bag = (owners[row.owner] ??= {});
      bag[row.item] = (bag[row.item] ?? 0) + row.qty;
    }
    return { owners, catalog: [] } satisfies InventoryState;
  },

  validateOp(op: Op, index: number, state: State, config: Config): Violation[] {
    if (op.op === "item.create") {
      if (catalogItems(config, state).some((item) => item.id === op.id)) {
        return [
          {
            severity: "fixable",
            code: "item_exists",
            op_index: index,
            message: `Op ${index}: '${op.id}' is already on the world sheet. Use that id.`,
          },
        ];
      }
      return [];
    }
    if (op.op !== "inventory.add" && op.op !== "inventory.remove") return [];
    if (!state.entities[op.owner]) {
      return [
        {
          severity: "fixable",
          code: "unknown_entity",
          op_index: index,
          message: `Op ${index}: inventory owner '${op.owner}' does not exist.`,
        },
      ];
    }
    const known = catalogItems(config, state);
    if ((config.items.length > 0 || known.length > 0) && !known.some((item) => item.id === op.item)) {
      return [
        {
          severity: "fixable",
          code: "unknown_item",
          op_index: index,
          message: `Op ${index}: item '${op.item}' is not on the world sheet. Copy an id from the sheet, or item.create it in this turn if the save must remember it.`,
        },
      ];
    }
    if (op.op === "inventory.add") {
      const gear = known.find((item) => item.id === op.item);
      const have = inventoryOf(state).owners[op.owner]?.[op.item] ?? 0;
      if (gear?.keeps && (op.qty !== 1 || have >= 1)) {
        return [
          {
            severity: "fixable",
            code: "gear_owned",
            op_index: index,
            message: `Op ${index}: '${itemName(config, op.item, state)}' is gear the player keeps, one of them. Do not add another.`,
          },
        ];
      }
    }
    if (op.op === "inventory.add" && op.qty > STACK_CAP) {
      const balances = config.stats
        .filter((stat) => stat.type === "currency")
        .map((stat) => `${stat.label ?? stat.key} [${stat.key}]`);
      const where = balances.length
        ? `Balances are ${balances.join(", ")}. Use stat.add on those keys.`
        : "Money is a currency stat. Use stat.add.";
      return [
        {
          severity: "fixable",
          code: "stack_too_large",
          op_index: index,
          message: `Op ${index}: inventory.add of ${op.qty} '${itemName(config, op.item)}' is more than ${STACK_CAP} of one object. ${where} Do not store notes as a pile of objects.`,
        },
      ];
    }
    if (op.op === "inventory.remove") {
      const have = inventoryOf(state).owners[op.owner]?.[op.item] ?? 0;
      if (have < op.qty) {
        return [
          {
            severity: "game_breaking",
            code: "item_not_owned",
            op_index: index,
            message: `Op ${index}: '${op.owner}' has ${have} of '${itemName(config, op.item)}' but ${op.qty} would be removed. The item is not available.`,
          },
        ];
      }
    }
    return [];
  },

  applyOp(op: Op, state: State): State {
    if (op.op !== "item.create" && op.op !== "inventory.add" && op.op !== "inventory.remove") return state;
    const s = structuredClone(state);
    const inv = (s.modules.inventory as InventoryState | undefined) ?? { owners: {}, catalog: [] };
    if (op.op === "item.create") {
      const catalog = inv.catalog ?? [];
      catalog.push({
        id: op.id,
        name: op.name,
        ...(op.price !== undefined ? { price: op.price } : {}),
        ...(op.keeps ? { keeps: true } : {}),
      });
      inv.catalog = catalog;
      s.modules.inventory = inv;
      return s;
    }
    const bag = (inv.owners[op.owner] ??= {});
    const delta = op.op === "inventory.add" ? op.qty : -op.qty;
    const next = (bag[op.item] ?? 0) + delta;
    if (next <= 0) delete bag[op.item];
    else bag[op.item] = next;
    s.modules.inventory = inv;
    return s;
  },

  promptFragment: () =>
    "INVENTORY: The world sheet lists gear (kept) and goods (for the scene). Copy those ids. A bag, a receipt, or an envelope is narration: do not create it. Something the save must remember that is not on the sheet is item.create in this turn (keeps true for gear, a price when it is sold), then inventory.add. A good that is eaten, drunk, or handed over is inventory.remove in that same turn. Buying one item also needs stat.add of its price. ENGINE NOW Carrying is the bag from the whole save. Gear already on that line is not bought again. Never entity.move an item onto a person. A currency balance is a stat, never a quantity of an object.",

  focus: () => [],
  due: () => [],

  snapshot(state, config) {
    const bag = inventoryOf(state).owners[config.player_id] ?? {};
    const items = Object.entries(bag).map(([id, qty]) => (qty > 1 ? `${itemName(config, id, state)} x${qty}` : itemName(config, id, state)));
    return [`Carrying (already owned): ${items.length ? items.join(", ") : "nothing"}`];
  },

  truth(state, config) {
    return this.snapshot(state, config);
  },

  render(state, config) {
    const bag = inventoryOf(state).owners[config.player_id] ?? {};
    const items = Object.entries(bag).map(([id, qty]) => (qty > 1 ? `${itemName(config, id, state)} x${qty}` : itemName(config, id, state)));
    return { panel: [`Inventory: ${items.length ? items.join(", ") : "empty"}`] };
  },
};
