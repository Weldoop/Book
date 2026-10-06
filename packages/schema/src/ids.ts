import { z } from "zod";

export const IdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_.-]*$/, "ids are lowercase letters, digits, _ . -");
export type Id = z.infer<typeof IdSchema>;

export const LocalDateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "expected YYYY-MM-DDTHH:mm (local, no timezone)");
export type LocalDateTime = z.infer<typeof LocalDateTimeSchema>;

export const ContentRatingSchema = z.enum(["clean", "romance", "mature"]);
export type ContentRating = z.infer<typeof ContentRatingSchema>;

export const PresentationProfileSchema = z.enum(["novel", "light", "tabletop"]);
export type PresentationProfile = z.infer<typeof PresentationProfileSchema>;

export const EntityTypeSchema = z.enum(["person", "place", "item", "faction", "other"]);
export type EntityType = z.infer<typeof EntityTypeSchema>;

export const ThreadKindSchema = z.enum(["commitment", "goal", "debt", "mystery", "callback"]);
export type ThreadKind = z.infer<typeof ThreadKindSchema>;

/** How big a thread is. Hidden from the player. `potential` is an offer, `minor` is taken up, `major` is the long one. */
export const ThreadScaleSchema = z.enum(["potential", "minor", "major"]);
export type ThreadScale = z.infer<typeof ThreadScaleSchema>;
