import type { Config, Module, Op, State, Violation } from "@book/schema";

export interface InventoryState {
  owners: Record<string, Record<string, number>>;
}

export function inventoryOf(state: State): InventoryState {
  return (state.modules.inventory as InventoryState | undefined) ?? { owners: {} };
}

export function itemName(config: Config, id: string): string {
  return config.items.find((i) => i.id === id)?.name ?? id.replace(/[_-]/g, " ");
}

/** One inventory.add above this is a pile, not a purchase. Cash belongs on a currency stat. */
export const STACK_CAP = 12;

export const inventoryModule: Module = {
  id: "inventory",
  ops: ["inventory.add", "inventory.remove"],

  initState(config) {
    const owners: Record<string, Record<string, number>> = {};
    for (const row of config.seed.inventory) {
      const bag = (owners[row.owner] ??= {});
      bag[row.item] = (bag[row.item] ?? 0) + row.qty;
    }
    return { owners } satisfies InventoryState;
  },

  validateOp(op: Op, index: number, state: State, config: Config): Violation[] {
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
    if (config.items.length > 0 && !config.items.some((item) => item.id === op.item)) {
      return [
        {
          severity: "fixable",
          code: "unknown_item",
          op_index: index,
          message: `Op ${index}: item '${op.item}' is not in the catalog. Use an item id from the world sheet.`,
        },
      ];
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
    if (op.op !== "inventory.add" && op.op !== "inventory.remove") return state;
    const s = structuredClone(state);
    const inv = (s.modules.inventory as InventoryState | undefined) ?? { owners: {} };
    const bag = (inv.owners[op.owner] ??= {});
    const delta = op.op === "inventory.add" ? op.qty : -op.qty;
    const next = (bag[op.item] ?? 0) + delta;
    if (next <= 0) delete bag[op.item];
    else bag[op.item] = next;
    s.modules.inventory = inv;
    return s;
  },

  promptFragment: () =>
    "INVENTORY: Items change hands only through inventory.add / inventory.remove, and the item id must be one from the world sheet. Never entity.move an item onto a person. Buying needs both a stat.add for the price and an inventory.add. The player can only use or give away items listed in STATE. A currency balance is a stat, never a quantity of an object. The wallet is one object. Do not inventory.add a stack of wallets, notes, or coins to store money.",

  focus: () => [],
  due: () => [],

  snapshot(state, config) {
    const bag = inventoryOf(state).owners[config.player_id] ?? {};
    const items = Object.entries(bag).map(([id, qty]) => (qty > 1 ? `${itemName(config, id)} x${qty}` : itemName(config, id)));
    return [`Carrying: ${items.length ? items.join(", ") : "nothing"}`];
  },

  truth(state, config) {
    return this.snapshot(state, config);
  },

  render(state, config) {
    const bag = inventoryOf(state).owners[config.player_id] ?? {};
    const items = Object.entries(bag).map(([id, qty]) => (qty > 1 ? `${itemName(config, id)} x${qty}` : itemName(config, id)));
    return { panel: [`Inventory: ${items.length ? items.join(", ") : "empty"}`] };
  },
};
