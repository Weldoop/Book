import { humanTime } from "@book/engine";
import type { Config, Module, State } from "@book/schema";
import { formatStat, statDef, statsOf } from "./stats.ts";

export interface PlayerView {
  status: string | null;
  panel: string[];
}

/** Deterministic player-facing view. The model never writes this. */
export function renderView(config: Config, state: State, modules: Module[]): PlayerView {
  const profile = config.presentation.profile;
  if (profile === "novel") return { status: null, panel: [] };

  const parts: string[] = [];
  for (const key of config.presentation.status_line) {
    if (key === "time") parts.push(humanTime(state.clock.now));
    else if (key === "location") {
      const loc = state.entities[config.player_id]?.location;
      const place = loc ? state.entities[loc] : undefined;
      if (place) parts.push(place.name);
    } else {
      const def = statDef(config, key);
      if (def) parts.push(`${def.label ?? def.key}: ${formatStat(def, statsOf(state).values[key] ?? def.start)}`);
    }
  }
  const status = parts.length ? parts.join(" | ") : null;

  if (profile === "light") return { status, panel: [] };
  const panel = modules.flatMap((m) => m.render(state, config).panel ?? []);
  return { status, panel };
}
