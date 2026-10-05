import { z } from "zod";
import { EntityTypeSchema, IdSchema, LocalDateTimeSchema, ThreadKindSchema, ThreadScaleSchema } from "./ids.ts";

/** Closed, versioned set of state-change operations. Each op is owned by one module. */
export const DELTA_VERSION = 1 as const;

export const OpSchema = z.discriminatedUnion("op", [
  // core
  z.object({ op: z.literal("clock.advance"), minutes: z.number().int().min(0) }),
  // A deliberate long skip (sleep, travel, waiting). Capped by `time.max_skip_minutes`, not `max_per_turn`.
  z.object({ op: z.literal("clock.skip"), minutes: z.number().int().min(1), reason: z.string().min(1) }),
  z.object({
    op: z.literal("entity.create"),
    id: IdSchema,
    type: EntityTypeSchema,
    name: z.string().min(1),
    aliases: z.array(z.string()).optional(),
    location: IdSchema.optional(),
    facts: z.array(z.string()).optional(),
    /** `unmet` hides a person until they share the player's location. `unvisited` marks a place not yet entered. */
    tags: z.array(z.string().min(1)).max(8).optional(),
  }),
  z.object({ op: z.literal("entity.move"), id: IdSchema, location: IdSchema }),
  z.object({
    op: z.literal("entity.fact.add"),
    id: IdSchema,
    fact: z.string().min(1),
    importance: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
  }),
  z.object({
    op: z.literal("thread.open"),
    kind: ThreadKindSchema,
    text: z.string().min(1),
    due: LocalDateTimeSchema.optional(),
    entities: z.array(IdSchema).optional(),
    /** Set when this thread grows out of one the player just resolved, so chains are traceable. */
    parent: z.string().optional(),
    /** Defaults to a minor. The opening uses major. An offer is potential. */
    scale: ThreadScaleSchema.default("minor"),
  }),
  z.object({
    op: z.literal("thread.adopt"),
    id: z.string(),
    /** Raise an offer to a minor, a minor to a major, or set a major back to a minor. */
    scale: z.enum(["minor", "major"]),
  }),
  z.object({ op: z.literal("thread.resolve"), id: z.string() }),
  // stats
  z.object({ op: z.literal("stat.add"), key: IdSchema, amount: z.number(), reason: z.string().optional() }),
  z.object({ op: z.literal("stat.set"), key: IdSchema, value: z.number(), reason: z.string().optional() }),
  // inventory
  z.object({ op: z.literal("inventory.add"), owner: IdSchema, item: IdSchema, qty: z.number().int().min(1).default(1) }),
  z.object({ op: z.literal("inventory.remove"), owner: IdSchema, item: IdSchema, qty: z.number().int().min(1).default(1) }),
  // relationships
  z.object({ op: z.literal("relationship.add"), a: IdSchema, b: IdSchema, amount: z.number() }),
]);
export type Op = z.infer<typeof OpSchema>;
export type OpName = Op["op"];

export const OP_NAMES: OpName[] = OpSchema.options.map((o) => o.shape.op.value);

/**
 * Set by the GM when it resolved a risky action with the supplied fate die.
 * `stat` is loose on purpose: the model often writes a label ("Crew morale").
 * The engine maps that to the real id, and rejects one that matches nothing.
 */
export const CheckSchema = z.object({
  what: z.string().min(1),
  stat: z.string().min(1).max(80).optional(),
});
export type Check = z.infer<typeof CheckSchema>;

export const TurnDraftSchema = z.object({
  narration: z.string().min(1),
  delta: z.array(z.unknown()).default([]),
  beat: z.string().min(1),
  focus_next: z.array(IdSchema).optional(),
  need: z.array(IdSchema).optional(),
  /** `null` is treated as omitted. Some models emit it when they did not roll. */
  check: CheckSchema.nullish(),
  /** Set only when the scene has come to a natural close, which is when memory may compact. */
  scene_ended: z.boolean().optional(),
  /**
   * Place id where the narration stops. Optional: a missing `at` is not a violation.
   * When it is set, it has to be the player's location after the delta.
   */
  at: IdSchema.optional(),
  /** Short private notes for the GM's own use over the next few turns. Never shown to the player. */
  notes: z.array(z.string()).optional(),
});
/** Raw model draft. `delta` is parsed op-by-op by the validator so one bad op can be reported precisely. */
export type TurnDraft = z.infer<typeof TurnDraftSchema>;

export type Severity = "fixable" | "game_breaking";

export interface Violation {
  severity: Severity;
  code: string;
  message: string;
  op_index?: number;
}
