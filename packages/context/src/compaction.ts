import type { Config, Fact, Module, State } from "@book/schema";
import { orderThreads } from "./attention.ts";
import { recentBeats } from "./sections.ts";
import { extractJsonObject, fitLines, renderSection, tokensOf, trimOldestSentences } from "./text.ts";
import { sumTokens } from "./turn.ts";
import type { BuiltContext, ContextPart } from "./types.ts";

export interface CompactionFact {
  id: string;
  fact: string;
  importance: 1 | 2 | 3;
}

export interface CompactionResult {
  chapter_summary: string;
  story_so_far: string;
  facts: CompactionFact[];
  resolve_threads: string[];
}

export const STORY_SO_FAR_CAP_TOKENS = 500;
export const CHAPTER_CAP_TOKENS = 250;
export const MAX_FACTS_PER_ENTITY = 8;
const KEEP_WINDOW = 6;
const REQUEST_BEATS_CAP = 1500;
const REQUEST_ENTITIES_CAP = 1800;
const REQUEST_THREADS_CAP = 600;
const REQUEST_STORY_CAP = 700;

/**
 * Compaction waits for the GM to close a scene, so a chapter summary is never cut through the middle
 * of one. `max_beats` is the backstop: a GM that never closes a scene still gets compacted, because
 * unbounded beats would break the context budget.
 */
export function shouldCompact(state: State, config: Config): boolean {
  const beats = recentBeats(state).length;
  const sceneClose = state.scene.closed && beats >= config.scenes.min_beats;
  if (sceneClose) return true;
  const hold = state.summaries.compaction_hold_until;
  if (hold !== undefined && state.turn < hold) return false;
  return beats >= config.scenes.max_beats;
}

/**
 * How many turns stay verbatim after compacting. A scene that has closed can safely drop to the
 * standard window; a forced mid-scene compaction keeps the live scene so the GM does not lose the
 * start of what it is in the middle of narrating.
 */
export function windowKeep(state: State, config: Config): number {
  if (state.scene.closed) return KEEP_WINDOW;
  const sceneTurns = state.turn - state.scene.started_turn;
  return Math.min(Math.max(KEEP_WINDOW, sceneTurns), Math.max(KEEP_WINDOW, config.scenes.keep_scene_turns));
}

export const COMPACTION_SYSTEM = [
  "You are the archivist of an interactive story. Compress old events into durable memory. Reply with a single JSON object only, no prose, no code fences.",
  "Keys:",
  '- "chapter_summary": string, at most 80 words, covering the beats shown.',
  '- "story_so_far": string, at most 160 words, merging the current story so far with the new chapter. You MUST keep running jokes, favours owed, promises, nicknames and recurring characters.',
  '- "facts": array of {"id": string, "fact": string, "importance": 1|2|3}. For each entity you want to tidy, list ALL the facts it should keep (consolidated: merge duplicates, drop outdated or trivial ones, at most 8 per entity). Your list replaces its old facts. Only use entity ids shown below; omit entities that need no change.',
  '- "resolve_threads": array of thread ids that are clearly finished. Only use ids shown below.',
  "Never invent events. Use only what is shown.",
].join("\n");

export interface CompactionInput {
  config: Config;
  state: State;
  modules: Module[];
}

export function buildCompactionRequest(i: CompactionInput): BuiltContext {
  const { state } = i;
  const since = state.summaries.last_compacted_turn;

  const story = state.summaries.story_so_far.trim();
  const storyFit = story ? trimOldestSentences(story, REQUEST_STORY_CAP) : { text: "", trimmed: false };
  const storyText = story ? `## CURRENT STORY SO FAR\n${storyFit.text}` : "";

  const beatLines = recentBeats(state).map((b) => `- t${b.turn}: ${b.text}`);
  const beatFit = fitLines("## BEATS SINCE LAST COMPACTION", beatLines, REQUEST_BEATS_CAP, "start");
  const beatsText = renderSection("## BEATS SINCE LAST COMPACTION", beatFit.lines);

  const threadLines = orderThreads(state.threads).map(
    (t) => `- ${t.id} [${t.kind}]${t.due ? ` due ${t.due}` : ""}: ${t.text}`,
  );
  const threadFit = fitLines("## OPEN THREADS", threadLines, REQUEST_THREADS_CAP, "end");
  const threadsText = renderSection("## OPEN THREADS", threadFit.lines);

  // Whole entities only: a partial fact list would make the replacement lose facts.
  const touched = Object.values(state.entities)
    .filter((e) => e.last_touched > since && e.facts.length > 0)
    .sort((a, b) => b.last_touched - a.last_touched || a.id.localeCompare(b.id));
  const entityLines = touched.map((e) => {
    const facts = [...e.facts]
      .sort((a, b) => b.importance - a.importance || b.turn - a.turn)
      .map((f) => `${f.text} (${f.importance})`)
      .join("; ");
    return `- ${e.name} [${e.id}]: ${facts}`;
  });
  const entityFit = fitLines("## ENTITY FACTS (importance 1-3)", entityLines, REQUEST_ENTITIES_CAP, "end");
  const entitiesText = renderSection("## ENTITY FACTS (importance 1-3)", entityFit.lines);

  const sections: { part: string; text: string; trimmed: boolean }[] = [
    { part: "story_so_far", text: storyText, trimmed: storyFit.trimmed },
    { part: "beats", text: beatsText, trimmed: beatFit.trimmed },
    { part: "threads", text: threadsText, trimmed: threadFit.trimmed },
    { part: "entities_in_focus", text: entitiesText, trimmed: entityFit.trimmed },
  ];
  const parts: ContextPart[] = [
    { name: "contract", tokens: tokensOf(COMPACTION_SYSTEM), trimmed: false },
    ...sections.map((s) => ({ name: s.part, tokens: tokensOf(s.text), trimmed: s.trimmed })),
  ];
  return {
    system: [{ text: COMPACTION_SYSTEM, cache: true }],
    messages: [
      {
        role: "user",
        content: sections
          .map((s) => s.text)
          .filter((t) => t)
          .concat("Return the JSON object now.")
          .join("\n\n"),
      },
    ],
    parts,
    total_tokens: sumTokens(parts),
    focus: [],
  };
}

function asImportance(v: unknown): 1 | 2 | 3 {
  const n = typeof v === "number" ? Math.round(v) : 2;
  return n <= 1 ? 1 : n >= 3 ? 3 : 2;
}

export function parseCompactionResult(
  text: string,
): { ok: true; value: CompactionResult } | { ok: false; error: string } {
  const raw = extractJsonObject(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "no JSON object found in compaction reply" };
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.story_so_far !== "string" || o.story_so_far.trim() === "") {
    return { ok: false, error: "story_so_far must be a non-empty string" };
  }
  if (typeof o.chapter_summary !== "string") {
    return { ok: false, error: "chapter_summary must be a string" };
  }
  if (o.facts !== undefined && !Array.isArray(o.facts)) return { ok: false, error: "facts must be an array" };
  if (o.resolve_threads !== undefined && !Array.isArray(o.resolve_threads)) {
    return { ok: false, error: "resolve_threads must be an array" };
  }
  const facts: CompactionFact[] = [];
  for (const f of (o.facts as unknown[] | undefined) ?? []) {
    if (!f || typeof f !== "object") continue;
    const r = f as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.fact !== "string" || r.fact.trim() === "") continue;
    facts.push({ id: r.id, fact: r.fact.trim(), importance: asImportance(r.importance) });
  }
  const resolve = ((o.resolve_threads as unknown[] | undefined) ?? []).filter(
    (x): x is string => typeof x === "string",
  );
  return {
    ok: true,
    value: {
      chapter_summary: o.chapter_summary.trim(),
      story_so_far: o.story_so_far.trim(),
      facts,
      resolve_threads: resolve,
    },
  };
}

function consolidate(existing: Fact[], incoming: CompactionFact[], turn: number): Fact[] {
  const turnByText = new Map(existing.map((f) => [f.text, f.turn]));
  const seen = new Set<string>();
  const facts: Fact[] = [];
  for (const f of incoming) {
    if (seen.has(f.fact)) continue;
    seen.add(f.fact);
    facts.push({ text: f.fact, importance: f.importance, turn: turnByText.get(f.fact) ?? turn });
  }
  const ranked = facts
    .map((f, index) => ({ f, index }))
    .sort((a, b) => b.f.importance - a.f.importance || b.f.turn - a.f.turn || a.index - b.index)
    .slice(0, MAX_FACTS_PER_ENTITY);
  return ranked.sort((a, b) => a.index - b.index).map((r) => r.f);
}

export function applyCompaction(state: State, result: CompactionResult, config: Config): State {
  const chapter = result.chapter_summary.trim()
    ? trimOldestSentences(result.chapter_summary, CHAPTER_CAP_TOKENS).text
    : "";
  const story = result.story_so_far.trim()
    ? trimOldestSentences(result.story_so_far, STORY_SO_FAR_CAP_TOKENS).text
    : state.summaries.story_so_far;

  const byEntity = new Map<string, CompactionFact[]>();
  for (const f of result.facts) {
    if (!state.entities[f.id]) continue;
    const list = byEntity.get(f.id) ?? [];
    list.push(f);
    byEntity.set(f.id, list);
  }
  const entities = { ...state.entities };
  for (const [id, incoming] of byEntity) {
    const entity = state.entities[id];
    if (!entity) continue;
    entities[id] = { ...entity, facts: consolidate(entity.facts, incoming, state.turn) };
  }

  const resolve = new Set(result.resolve_threads);
  const threads = state.threads.map((t) =>
    resolve.has(t.id) && t.status === "open" ? { ...t, status: "resolved" as const, resolved_turn: state.turn } : t,
  );

  return {
    ...state,
    entities,
    threads,
    beats: state.beats.filter((b) => b.turn > state.turn),
    summaries: {
      chapters: chapter ? [...state.summaries.chapters, chapter] : [...state.summaries.chapters],
      story_so_far: story,
      last_compacted_turn: state.turn,
    },
    window: state.window.slice(-windowKeep(state, config)),
  };
}
