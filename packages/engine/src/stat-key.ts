import type { Config } from "@book/schema";

/** Lower case, and treat spaces and hyphens as the underscores ids already use. */
function fold(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * The stat id a model meant. Accepts the id or the label, ignoring case, spaces, and hyphens.
 * "Gold" and "gold" are `gold`. "Crew morale" and "crew-morale" are `crew_morale`.
 * "Infamy with the Crown" is the stat whose label says that. An unknown name returns undefined.
 */
export function resolveStatKey(config: Config, raw: string): string | undefined {
  const exact = config.stats.find((stat) => stat.key === raw);
  if (exact) return exact.key;
  const folded = fold(raw);
  if (!folded) return undefined;
  const byKey = config.stats.find((stat) => fold(stat.key) === folded);
  if (byKey) return byKey.key;
  const byLabel = config.stats.find((stat) => stat.label !== undefined && fold(stat.label) === folded);
  return byLabel?.key;
}
