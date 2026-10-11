import ukLifeJson from "../../../configs/uk-life/config.json" with { type: "json" };
import pirateJson from "../../../configs/pirate/config.json" with { type: "json" };
import { ConfigSchema } from "@book/schema";
import type { Config } from "@book/schema";

export interface GameCard {
  id: string;
  title: string;
  premise: string;
}

function load(file: string, raw: unknown): Config {
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Config ${file} is not valid: ${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`);
  }
  return parsed.data;
}

const configs: Config[] = [load("uk-life", ukLifeJson), load("pirate", pirateJson)];

export function listGames(): GameCard[] {
  return configs.map((config) => ({
    id: config.id,
    title: config.meta.title,
    premise: config.meta.premise,
  }));
}

/** A fresh copy, so a turn cannot rewrite the catalog. */
export function findGame(id: string): Config | undefined {
  const found = configs.find((config) => config.id === id);
  return found ? structuredClone(found) : undefined;
}
