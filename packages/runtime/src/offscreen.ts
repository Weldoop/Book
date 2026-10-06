import { processOps, humanTime } from "@book/engine";
import type { Config, LLMProvider, LLMUsage, Module, Op, State } from "@book/schema";
import { z } from "zod";
import { extractJson } from "./parse.ts";

const ResultSchema = z.object({
  changes: z
    .array(z.object({ id: z.string(), fact: z.string().min(1), importance: z.number().int().min(1).max(3).optional() }))
    .default([]),
});

function pickCharacters(state: State, config: Config): string[] {
  const limit = config.offscreen?.max_entities ?? 4;
  const threadRefs = new Set(state.threads.filter((t) => t.status === "open").flatMap((t) => t.entities));
  return Object.values(state.entities)
    .filter((e) => e.type === "person" && e.id !== config.player_id)
    .sort((a, b) => Number(threadRefs.has(b.id)) - Number(threadRefs.has(a.id)) || b.last_touched - a.last_touched || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((e) => e.id);
}

export interface OffscreenResult {
  state: State;
  usage: LLMUsage[];
  applied: number;
}

/** Optional world simulator: runs only after a large time skip, cheap tier, hard token cap, validated like any delta. */
export async function runOffscreen(args: {
  config: Config;
  state: State;
  modules: Module[];
  llm: LLMProvider;
  elapsedMinutes: number;
}): Promise<OffscreenResult> {
  const { config, state, modules, llm } = args;
  const cfg = config.offscreen;
  if (!cfg?.enabled) return { state, usage: [], applied: 0 };
  const ids = pickCharacters(state, config);
  if (ids.length === 0) return { state, usage: [], applied: 0 };

  const lines = ids.map((id) => {
    const e = state.entities[id];
    const facts = (e?.facts ?? [])
      .slice()
      .sort((a, b) => b.importance - a.importance || b.turn - a.turn)
      .slice(0, 3)
      .map((f) => f.text)
      .join("; ");
    const threads = state.threads
      .filter((t) => t.status === "open" && t.entities.includes(id))
      .map((t) => t.text)
      .join("; ");
    return `- ${id} (${e?.name}): ${facts || "no known facts"}${threads ? ` | open: ${threads}` : ""}`;
  });

  const response = await llm.complete({
    tier: "cheap",
    purpose: "offscreen",
    max_tokens: cfg.max_tokens,
    json: true,
    system: [
      {
        text: `You simulate what background characters did while the player was elsewhere. Tone: ${config.meta.tone}. Return ONLY JSON: {"changes":[{"id":"<character id>","fact":"<one short sentence of what they did or what changed for them>","importance":1|2|3}]}. importance 1 is a passing thing, 3 is something they will not forget. At most one change per character, only when something plausible and interesting happened. Never involve the player directly.`,
        cache: true,
      },
    ],
    messages: [
      {
        role: "user",
        content: `Now: ${humanTime(state.clock.now)}. About ${Math.round(args.elapsedMinutes / 60)} hours passed.\nCharacters:\n${lines.join("\n")}`,
      },
    ],
  });

  let rawChanges: z.infer<typeof ResultSchema>["changes"] = [];
  try {
    rawChanges = ResultSchema.parse(extractJson(response.text)).changes;
  } catch {
    return { state, usage: [response.usage], applied: 0 };
  }

  const ops: Op[] = rawChanges
    .filter((c) => ids.includes(c.id))
    .map((c) => ({
      op: "entity.fact.add" as const,
      id: c.id,
      fact: `(while you were away) ${c.fact}`.slice(0, 220),
      importance: (c.importance ?? 2) as 1 | 2 | 3,
    }));
  const processed = processOps(state, config, modules, ops);
  return { state: processed.state, usage: [response.usage], applied: processed.applied.length };
}
