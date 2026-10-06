import type { Config, ItemDef, State } from "@book/schema";

export interface CatalogItem extends ItemDef {
  keeps: boolean;
}

interface InventoryBag {
  catalog?: ItemDef[];
}

function createdItems(state: State): ItemDef[] {
  const bag = state.modules.inventory as InventoryBag | undefined;
  return Array.isArray(bag?.catalog) ? bag.catalog : [];
}

/** The book's list, then anything this save has created. Gear has `keeps`. */
export function catalogItems(config: Config, state: State): CatalogItem[] {
  const byId = new Map<string, CatalogItem>();
  for (const item of config.items) byId.set(item.id, { ...item, keeps: item.keeps === true });
  for (const item of createdItems(state)) {
    if (byId.has(item.id)) continue;
    byId.set(item.id, { ...item, keeps: item.keeps === true });
  }
  return [...byId.values()];
}
