import { z } from "zod";
import {
  ContentRatingSchema,
  EntityTypeSchema,
  IdSchema,
  LocalDateTimeSchema,
  PresentationProfileSchema,
  ThreadKindSchema,
} from "./ids.ts";

export const StatDefSchema = z.object({
  key: IdSchema,
  label: z.string().optional(),
  type: z.enum(["currency", "bounded", "counter"]),
  min: z.number().optional(),
  max: z.number().optional(),
  start: z.number(),
  display: z.string().optional(),
  hidden: z.boolean().default(false),
});
export type StatDef = z.infer<typeof StatDefSchema>;

export const ItemDefSchema = z.object({
  id: IdSchema,
  name: z.string(),
  price: z.number().optional(),
});
export type ItemDef = z.infer<typeof ItemDefSchema>;

export const ConditionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("stat"),
    key: IdSchema,
    op: z.enum(["<", "<=", ">", ">=", "=="]),
    value: z.number(),
  }),
  z.object({
    kind: z.literal("relationship"),
    a: IdSchema,
    b: IdSchema,
    op: z.enum(["<", "<=", ">", ">=", "=="]),
    value: z.number(),
  }),
  z.object({ kind: z.literal("after"), at: LocalDateTimeSchema }),
]);
export type Condition = z.infer<typeof ConditionSchema>;

const EventThreadSchema = z.object({ kind: ThreadKindSchema, text: z.string() });

export const ScheduledEventSchema = z.object({
  id: IdSchema,
  at: LocalDateTimeSchema,
  text: z.string(),
  entities: z.array(IdSchema).default([]),
  thread: EventThreadSchema.optional(),
});
export type ScheduledEvent = z.infer<typeof ScheduledEventSchema>;

export const ConditionalEventSchema = z.object({
  id: IdSchema,
  when: ConditionSchema,
  text: z.string(),
  entities: z.array(IdSchema).default([]),
  once: z.boolean().default(true),
});
export type ConditionalEvent = z.infer<typeof ConditionalEventSchema>;

export const RandomEventSchema = z.object({
  id: IdSchema,
  chance_per_hour: z.number().min(0).max(1),
  entries: z.array(z.object({ text: z.string(), weight: z.number().positive().default(1) })).min(1),
});
export type RandomEvent = z.infer<typeof RandomEventSchema>;

export const EventsConfigSchema = z.object({
  scheduled: z.array(ScheduledEventSchema).default([]),
  conditional: z.array(ConditionalEventSchema).default([]),
  random: z.array(RandomEventSchema).default([]),
});
export type EventsConfig = z.infer<typeof EventsConfigSchema>;

/**
 * How the player picks a story up after it has ended. Omit `continue` on an ending to make it final.
 * Everything here is applied by code, so a continuation costs no tokens.
 */
export const ContinuationSchema = z.object({
  /** Offered to the player as the way on, for example "Wake up in a police cell". */
  label: z.string(),
  /** Where the next scene starts. Must be a place that already exists in state. */
  location: IdSchema,
  /** The situation handed to the GM as a due event on the first turn after the ending. */
  note: z.string(),
  /** Time passing between the ending and the continuation (unconscious, remanded, recovering). */
  skip_minutes: z.number().int().min(0).default(0),
  /** Stats forced to a value on the way through, for example money to 0 after confiscation. */
  set_stats: z.record(IdSchema, z.number()).default({}),
  /** Strip everything the player was carrying (confiscation, hospital admission). */
  clear_inventory: z.boolean().default(false),
});
export type Continuation = z.infer<typeof ContinuationSchema>;

export const EndingSchema = z.object({
  id: IdSchema,
  /** Same condition shape as a conditional event, so endings need no new evaluator. */
  when: ConditionSchema,
  title: z.string(),
  /** Engine-written closing text in the game's voice. */
  text: z.string(),
  continue: ContinuationSchema.optional(),
});
export type Ending = z.infer<typeof EndingSchema>;

export const DiceConfigSchema = z.object({
  sides: z.number().int().min(2).default(100),
  thresholds: z.array(z.number()).default([10, 25, 50, 75, 90]),
  labels: z.array(z.string()).optional(),
  /** Tabletop mode: show the roll to the player. When false, outcomes must be explained in-world instead. */
  visible: z.boolean().default(false),
  /** Let the named stat shift the roll (tabletop); otherwise the stat only labels the check. */
  stat_modifier: z.boolean().default(false),
});
export type DiceConfig = z.infer<typeof DiceConfigSchema>;

export const OffscreenConfigSchema = z.object({
  enabled: z.boolean().default(false),
  min_skip_hours: z.number().positive().default(6),
  max_entities: z.number().int().positive().default(4),
  max_tokens: z.number().int().positive().default(600),
  scope: z.array(z.enum(["npc_goals", "threads"])).default(["npc_goals", "threads"]),
});
export type OffscreenConfig = z.infer<typeof OffscreenConfigSchema>;

export const EntitySeedSchema = z.object({
  id: IdSchema,
  type: EntityTypeSchema,
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  location: IdSchema.optional(),
  facts: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
});
export type EntitySeed = z.infer<typeof EntitySeedSchema>;

export const ThreadSeedSchema = z.object({
  kind: ThreadKindSchema,
  text: z.string(),
  due: LocalDateTimeSchema.optional(),
  entities: z.array(IdSchema).default([]),
  /** Consequence if the deadline passes unresolved. Injected as a due event; the GM narrates the fallout. */
  on_overdue: z.string().optional(),
});
export type ThreadSeed = z.infer<typeof ThreadSeedSchema>;

export const ThreadsConfigSchema = z.object({
  /** Threads shown in the prompt at once. The stored pool is unlimited. */
  max_in_context: z.number().int().positive().default(4),
  /** Unprompted reminders a thread gets before it goes cold and leaves the prompt. */
  max_reminders: z.number().int().min(0).default(2),
  /** A cold thread with a deadline comes back this many hours before it falls due. */
  rewarm_hours: z.number().min(0).default(12),
});
export type ThreadsConfig = z.infer<typeof ThreadsConfigSchema>;

/**
 * When memory is allowed to compact. Only the GM knows whether a scene has closed, so it says so on
 * the draft and the engine waits for that moment rather than cutting at a fixed turn count.
 */
export const ScenesConfigSchema = z.object({
  /** Beats that must have piled up before a scene close is worth compacting. */
  min_beats: z.number().int().min(1).default(8),
  /** Compact anyway at this many beats, so a GM that never closes a scene cannot grow memory for ever. */
  max_beats: z.number().int().min(1).default(20),
  /** Turns of the live scene kept verbatim when a forced compaction does land mid-scene. */
  keep_scene_turns: z.number().int().min(0).default(12),
});
export type ScenesConfig = z.infer<typeof ScenesConfigSchema>;

/**
 * Short-lived private notes the GM writes to itself: a secret the player has not found, a twist due
 * in a scene or two, something to pay off soon. Never shown to the player, and they expire, so
 * anything that matters beyond the next few turns has to become a thread.
 */
export const NotesConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Turns a note survives before it is dropped. */
  ttl_turns: z.number().int().min(1).default(4),
  /** Notes shown in the prompt at once, newest first. */
  max_in_context: z.number().int().min(1).default(3),
  /** Longer notes are truncated, to keep them notes rather than prose. */
  max_chars: z.number().int().min(20).default(200),
});
export type NotesConfig = z.infer<typeof NotesConfigSchema>;

export const GmStyleSchema = z.object({
  max_words: z.number().int().positive().default(90),
  person: z.enum(["first", "second", "third"]).default("second"),
  never_decide_for_player: z.boolean().default(true),
  extra_rules: z.array(z.string()).default([]),
  interludes: z.array(z.string()).min(1),
  rollback_note: z.string(),
});
export type GmStyle = z.infer<typeof GmStyleSchema>;

export const PresentationSchema = z.object({
  profile: PresentationProfileSchema.default("light"),
  status_line: z.array(z.string()).default([]),
});
export type Presentation = z.infer<typeof PresentationSchema>;

export const TimeConfigSchema = z.object({
  start: LocalDateTimeSchema,
  min_per_action: z.number().int().min(0).default(1),
  /** Guard on ordinary action turns, so a scene cannot drift hours by accident. */
  max_per_turn: z.number().int().positive().default(480),
  /** Cap on one deliberate clock.skip (sleep, travel, waiting). 0 forbids skipping entirely. */
  max_skip_minutes: z.number().int().min(0).default(840),
  /** What rest means for this character, for example "does not sleep". Shown to the GM. */
  rest_note: z.string().default(""),
});
export type TimeConfig = z.infer<typeof TimeConfigSchema>;

export const ConfigSchema = z
  .object({
    id: IdSchema,
    version: z.number().int().positive(),
    meta: z.object({
      title: z.string(),
      tone: z.string(),
      premise: z.string().default(""),
      content_rating: ContentRatingSchema.default("clean"),
      /**
       * How the GM handles the player attacking someone. A tone dial, not a capability limit.
       * `deflect`: the attempt fails for a physical reason; nothing lands. For cosy games.
       * `consequence`: it lands, narrated plainly and briefly, and the cost is social, legal and medical.
       * `adventure`: genre combat, wounds and deaths of NPCs are in bounds, not gory.
       */
      violence: z.enum(["deflect", "consequence", "adventure"]).default("deflect"),
      /** How hard the world bites back. Scales consequences, never the dice. */
      harshness: z.enum(["forgiving", "normal", "unforgiving"]).default("normal"),
    }),
    player_id: IdSchema.default("player"),
    modules: z.array(IdSchema),
    gm_style: GmStyleSchema,
    presentation: PresentationSchema,
    time: TimeConfigSchema,
    threads: ThreadsConfigSchema.default({}),
    scenes: ScenesConfigSchema.default({}),
    notes: NotesConfigSchema.default({}),
    stats: z.array(StatDefSchema).default([]),
    items: z.array(ItemDefSchema).default([]),
    events: EventsConfigSchema.default({}),
    /** Checked in order after every committed turn; the first match ends the story. */
    endings: z.array(EndingSchema).default([]),
    dice: DiceConfigSchema.optional(),
    offscreen: OffscreenConfigSchema.optional(),
    seed: z
      .object({
        entities: z.array(EntitySeedSchema).default([]),
        threads: z.array(ThreadSeedSchema).default([]),
        inventory: z
          .array(z.object({ owner: IdSchema, item: IdSchema, qty: z.number().int().positive().default(1) }))
          .default([]),
        relationships: z.array(z.object({ a: IdSchema, b: IdSchema, value: z.number() })).default([]),
      })
      .default({}),
  })
  .passthrough();
export type Config = z.infer<typeof ConfigSchema>;
