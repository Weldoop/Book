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
       * How the GM handles the player attacking someone.
       * `deflect`: no injury narration; hostile acts land as social, domestic and legal fallout.
       * `adventure`: genre combat, wounds and deaths of NPCs are in bounds, not gory.
       */
      violence: z.enum(["deflect", "adventure"]).default("deflect"),
      /** How hard the world bites back. Scales consequences, never the dice. */
      harshness: z.enum(["forgiving", "normal", "unforgiving"]).default("normal"),
    }),
    player_id: IdSchema.default("player"),
    modules: z.array(IdSchema),
    gm_style: GmStyleSchema,
    presentation: PresentationSchema,
    time: TimeConfigSchema,
    threads: ThreadsConfigSchema.default({}),
    stats: z.array(StatDefSchema).default([]),
    items: z.array(ItemDefSchema).default([]),
    events: EventsConfigSchema.default({}),
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
