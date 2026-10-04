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
});
export type ThreadSeed = z.infer<typeof ThreadSeedSchema>;

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
  max_per_turn: z.number().int().positive().default(480),
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
    }),
    player_id: IdSchema.default("player"),
    modules: z.array(IdSchema),
    gm_style: GmStyleSchema,
    presentation: PresentationSchema,
    time: TimeConfigSchema,
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
