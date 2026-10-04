import type { Config, State } from "@book/schema";
import { fitLines, renderSection } from "./text.ts";
import type { Section } from "./sections.ts";

const PLACE_CAP = 24;

function moneyPrefix(config: Config): string {
  const currency = config.stats.find((s) => s.type === "currency");
  if (!currency?.display) return "";
  if (currency.display === "£" || currency.display === "GBP") return "£";
  return `${currency.display} `;
}

/**
 * The closed world the model has to write against: catalog items with prices, and places with ids.
 * Capped so a long life does not drag every street ever mentioned into every turn.
 */
export function worldSheetSection(config: Config, state: State, cap: number): Section {
  const mark = moneyPrefix(config);
  const items = config.items.map((item) => {
    const price = item.price !== undefined ? `, ${mark}${item.price}` : "";
    return `- ${item.id}: ${item.name}${price}`;
  });
  const here = state.entities[config.player_id]?.location ?? null;
  const places = Object.values(state.entities)
    .filter((e) => e.type === "place")
    .sort((a, b) => {
      const rank = (id: string, unvisited: boolean, touched: number): number => {
        if (id === here) return 0;
        if (unvisited) return 1;
        return 2;
      };
      const ra = rank(a.id, a.tags.includes("unvisited"), a.last_touched);
      const rb = rank(b.id, b.tags.includes("unvisited"), b.last_touched);
      if (ra !== rb) return ra - rb;
      return b.last_touched - a.last_touched || a.id.localeCompare(b.id);
    })
    .slice(0, PLACE_CAP)
    .map((p) => `- ${p.id}: ${p.name}${p.tags.includes("unvisited") ? " (not yet visited)" : ""}`);

  const unmet = Object.values(state.entities)
    .filter((e) => e.type === "person" && e.tags.includes("unmet"))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((e) => `- ${e.id}: ${e.name}${e.location ? ` @ ${state.entities[e.location]?.name ?? e.location}` : ""}`);

  const lines = [
    ...items,
    ...(unmet.length
      ? ["Unmet people (do not name them until they share the player's location):", ...unmet]
      : []),
    ...(places.length ? ["Places:", ...places] : []),
  ];
  const fit = fitLines("## WORLD SHEET", lines, cap, "end");
  return { text: renderSection("## WORLD SHEET", fit.lines), trimmed: fit.trimmed || places.length < Object.values(state.entities).filter((e) => e.type === "place").length };
}

