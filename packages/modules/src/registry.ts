import { coreModule } from "@book/engine";
import type { Config, Module } from "@book/schema";
import { diceModule } from "./dice.ts";
import { eventsModule } from "./events.ts";
import { inventoryModule } from "./inventory.ts";
import { offscreenModule } from "./offscreen.ts";
import { relationshipsModule } from "./relationships.ts";
import { statsModule } from "./stats.ts";

export const BUILTIN_MODULES: Record<string, Module> = {
  stats: statsModule,
  inventory: inventoryModule,
  relationships: relationshipsModule,
  events: eventsModule,
  dice: diceModule,
  offscreen: offscreenModule,
};

/** Core plus the modules listed in the config, in config order. Throws on unknown module ids. */
export function getActiveModules(config: Config): Module[] {
  const modules: Module[] = [coreModule];
  for (const id of config.modules) {
    const m = BUILTIN_MODULES[id];
    if (!m) throw new Error(`Unknown module '${id}' in config '${config.id}'. Available: ${Object.keys(BUILTIN_MODULES).join(", ")}`);
    if (!modules.includes(m)) modules.push(m);
  }
  return modules;
}
