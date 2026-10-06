import { z } from "zod";
import { EntityTypeSchema, IdSchema, LocalDateTimeSchema, ThreadKindSchema, ThreadScaleSchema } from "./ids.ts";

export const FactSchema = z.object({
  text: z.string(),
  importance: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
  turn: z.number().int().min(0),
  /**
   * When a person's memory lapses, as local time. Absent means it stays:
   * a place, a seeded trait, or a serious memory such as a fight.
   */
  expires: LocalDateTimeSchema.optional(),
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
  /** Offer, a thread the player took up, or a long matter. The player never sees this word. */
  scale: ThreadScaleSchema.default("minor"),
  /** True once this was a major and then stepped back. Stays true if it is taken up again. */
  was_major: z.boolean().default(false),
  /** Scene index when this major stepped back. It is mentioned during that scene only. */
  set_aside_scene: z.number().int().min(1).optional(),
  /** Turn the player last named it, or it was opened or adopted. Standing in its place does not count. */
  last_interacted_turn: z.number().int().min(0).default(0),
  /** Clock time of that same interaction. Warmth lasts `threads.rewarm_hours` from here. */
  last_interacted_at: LocalDateTimeSchema.optional(),
  /** When an unclaimed offer lapses. Absent on minors and majors. */
  expires: LocalDateTimeSchema.optional(),
  /** True when the player dealt with it inside `threads.rewarm_hours`. */
  warm: z.boolean().default(true),
  /** Unused. Kept so older saves and configs still load. */
  reminders: z.number().int().min(0).default(0),
  last_shown_turn: z.number().int().min(0).default(0),
  /** Thread this one grew out of, so chains are visible in the logs. */
  parent: z.string().optional(),
  /** What happens if the deadline passes unresolved. Fires as a due event. */
  on_overdue: z.string().optional(),
  opened_turn: z.number().int().min(0),
  resolved_turn: z.number().int().min(0).optional(),
  /** Clock time when the thread was resolved. Used to keep that matter closed for 48 story hours. */
  resolved_at: LocalDateTimeSchema.optional(),
});
export type Thread = z.infer<typeof ThreadSchema>;

export const BeatSchema = z.object({ turn: z.number().int().min(0), text: z.string(), clock: LocalDateTimeSchema.optional() });
export type Beat = z.infer<typeof BeatSchema>;

export const TranscriptTurnSchema = z.object({
  turn: z.number().int().min(1),
  input: z.string(),
  narration: z.string(),
  clock: LocalDateTimeSchema,
  /** Phrases in the narration that were not in the save. Shown bold, and marked for the next turn. */
  highlights: z.array(z.string()).max(4).optional(),
});
export type TranscriptTurn = z.infer<typeof TranscriptTurnSchema>;

export const SummariesSchema = z.object({
  chapters: z.array(z.string()).default([]),
  story_so_far: z.string().default(""),
  last_compacted_turn: z.number().int().min(0).default(0),
  /**
   * After a failed chapter write, skip the beat-ceiling retry until this turn.
   * A scene the GM actually closed still compacts.
   */
  compaction_hold_until: z.number().int().min(0).optional(),
});
export type Summaries = z.infer<typeof SummariesSchema>;

export const SceneSchema = z.object({
  index: z.number().int().min(1).default(1),
  started_turn: z.number().int().min(0).default(0),
  /** Set when the GM declares the scene closed. The next input opens the next one. */
  closed: z.boolean().default(false),
  /** The title of the chapter that just closed. Absent on a scene that is still running. */
  title: z.string().max(60).optional(),
});
export type Scene = z.infer<typeof SceneSchema>;

/** A private GM note. Never rendered to the player and never carried into beats or summaries. */
export const GmNoteSchema = z.object({
  turn: z.number().int().min(0),
  text: z.string(),
});
export type GmNote = z.infer<typeof GmNoteSchema>;

/** An ending that has fired and is waiting for the player to carry on or leave it here. */
export const PendingEndingSchema = z.object({
  id: IdSchema,
  turn: z.number().int().min(0),
  /** False when the ending is final, so the save is closed rather than paused. */
  continuable: z.boolean(),
});
export type PendingEnding = z.infer<typeof PendingEndingSchema>;

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
  scene: SceneSchema.default({}),
  /** Private, short-lived GM notes. Not player-facing and not part of long-term memory. */
  notes: z.array(GmNoteSchema).default([]),
  /** Set while an ending is waiting on the player. Cleared when the story carries on. */
  ending: PendingEndingSchema.nullable().default(null),
  /** Endings already fired, so one cannot fire twice after a continuation. */
  endings_seen: z.array(IdSchema).default([]),
  modules: z.record(z.string(), z.unknown()),
});
export type State = z.infer<typeof StateSchema>;
