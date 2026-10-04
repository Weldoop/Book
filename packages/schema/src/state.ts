import { z } from "zod";
import { EntityTypeSchema, IdSchema, LocalDateTimeSchema, ThreadKindSchema } from "./ids.ts";

export const FactSchema = z.object({
  text: z.string(),
  importance: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
  turn: z.number().int().min(0),
});
export type Fact = z.infer<typeof FactSchema>;

export const EntitySchema = z.object({
  id: IdSchema,
  type: EntityTypeSchema,
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  location: IdSchema.nullable().default(null),
  facts: z.array(FactSchema).default([]),
  tags: z.array(z.string()).default([]),
  last_touched: z.number().int().min(0).default(0),
});
export type Entity = z.infer<typeof EntitySchema>;

export const ThreadSchema = z.object({
  id: z.string(),
  kind: ThreadKindSchema,
  text: z.string(),
  due: LocalDateTimeSchema.optional(),
  status: z.enum(["open", "resolved", "failed"]).default("open"),
  entities: z.array(IdSchema).default([]),
  /** False once the thread has used up its unprompted reminders. Cold threads stay in state but leave the prompt. */
  warm: z.boolean().default(true),
  /** Unprompted reminders spent so far; see `Config.threads.max_reminders`. */
  reminders: z.number().int().min(0).default(0),
  last_shown_turn: z.number().int().min(0).default(0),
  /** Thread this one grew out of, so chains are visible in the logs. */
  parent: z.string().optional(),
  /** What happens if the deadline passes unresolved. Fires as a due event. */
  on_overdue: z.string().optional(),
  opened_turn: z.number().int().min(0),
  resolved_turn: z.number().int().min(0).optional(),
});
export type Thread = z.infer<typeof ThreadSchema>;

export const BeatSchema = z.object({ turn: z.number().int().min(0), text: z.string() });
export type Beat = z.infer<typeof BeatSchema>;

export const TranscriptTurnSchema = z.object({
  turn: z.number().int().min(1),
  input: z.string(),
  narration: z.string(),
  clock: LocalDateTimeSchema,
});
export type TranscriptTurn = z.infer<typeof TranscriptTurnSchema>;

export const SummariesSchema = z.object({
  chapters: z.array(z.string()).default([]),
  story_so_far: z.string().default(""),
  last_compacted_turn: z.number().int().min(0).default(0),
});
export type Summaries = z.infer<typeof SummariesSchema>;

export const STATE_VERSION = 1 as const;

export const StateSchema = z.object({
  version: z.literal(STATE_VERSION),
  save_id: z.string(),
  config_id: IdSchema,
  config_version: z.number().int().positive(),
  turn: z.number().int().min(0),
  clock: z.object({ now: LocalDateTimeSchema }),
  rng_seed: z.number().int(),
  entities: z.record(IdSchema, EntitySchema),
  threads: z.array(ThreadSchema),
  beats: z.array(BeatSchema),
  summaries: SummariesSchema,
  window: z.array(TranscriptTurnSchema),
  focus_next: z.array(IdSchema).default([]),
  modules: z.record(z.string(), z.unknown()),
});
export type State = z.infer<typeof StateSchema>;
