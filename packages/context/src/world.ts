import { catalogItems } from "@book/engine";
import type { Config, Entity, State } from "@book/schema";
import { fitLines, renderSection, tokensOf, wordMatcher } from "./text.ts";
import type { Section } from "./sections.ts";

const PLACE_CAP = 24;

function moneyPrefix(config: Config): string {
  const currency = config.stats.find((s) => s.type === "currency");
  if (!currency?.display) return "";
  if (currency.display === "£" || currency.display === "GBP") return "£";
  return `${currency.display} `;
}

function namedPlace(place: Entity, input: string): boolean {
  for (const term of [place.name, ...place.aliases, place.id.replace(/[_-]+/g, " ")]) {
    const matcher = wordMatcher(term);
    if (matcher?.test(input)) return true;
  }
  return false;
}

/**
 * The closed world the model has to write against: catalog items with prices, and places with ids.
 * Catalog lines stay. Visited places and places named in the input outrank unvisited ones, so a
 * shop the player has used is not dropped to keep a hospital they have never seen.
 */
export function worldSheetSection(config: Config, state: State, cap: number, input = ""): Section {
  const mark = moneyPrefix(config);
  const itemLines = catalogItems(config, state).map((item) => {
    const kind = item.keeps ? "gear" : "good";
    const price = item.price !== undefined ? `, ${mark}${item.price}` : "";
    return `- ${item.id}: ${item.name}, ${kind}${price}`;
  });
  const here = state.entities[config.player_id]?.location ?? null;
  const places = Object.values(state.entities)
    .filter((e) => e.type === "place")
    .sort((a, b) => {
      const rank = (place: Entity): number => {
        if (place.id === here) return 0;
        if (namedPlace(place, input)) return 1;
        if (!place.tags.includes("unvisited")) return 2;
        return 3;
      };
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      return b.last_touched - a.last_touched || a.id.localeCompare(b.id);
    })
    .slice(0, PLACE_CAP)
    .map((p) => `- ${p.id}: ${p.name}${p.tags.includes("unvisited") ? " (not yet visited)" : ""}`);

  const unmet = Object.values(state.entities)
    .filter((e) => e.type === "person" && e.tags.includes("unmet"))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((e) => `- ${e.id}: ${e.name}${e.location ? ` @ ${state.entities[e.location]?.name ?? e.location}` : ""}`);

  const head = [
    ...(itemLines.length
      ? ["Gear is kept. A good is used in the scene. Anything not listed is narration unless this turn creates it.", ...itemLines]
      : []),
    ...(unmet.length
      ? ["Unmet people (do not name them until they share the player's location):", ...unmet]
      : []),
  ];
  const placeBlock = places.length ? ["Places:", ...places] : [];
  const allPlaces = Object.values(state.entities).filter((e) => e.type === "place").length;
  const header = "## WORLD SHEET";
  const headText = renderSection(header, head);
  const headTokens = head.length === 0 ? 0 : tokensOf(headText);
  if (placeBlock.length === 0) {
    return { text: headText, trimmed: false };
  }
  if (headTokens >= cap) {
    return { text: headText, trimmed: allPlaces > 0 };
  }
  const placeFit = fitLines(header, placeBlock, cap - headTokens + tokensOf(header), "end");
  const lines = [...head, ...placeFit.lines];
  return {
    text: renderSection(header, lines),
    trimmed: placeFit.trimmed || places.length < allPlaces,
  };
}

