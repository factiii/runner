import { z } from 'zod';

// The public auto-tag routes (.specs/auto-tag.md): the tag-changes feed the
// analytics runners download whole, and the public correlations. Shared by the
// server, the clients and the runner, so the runner parses exactly what the
// server sends.

export const AUTO_TAG_DIMENSION_VALUES = ['tone', 'intent', 'subject'] as const;

/** The most changes one page of the feed holds. */
export const AUTO_TAG_CHANGES_MAX_LIMIT = 2000;

export const autoTagChangesInputSchema = z.object({
  /** The last change already held (the `next` of the page before); 0 to
   *  start from the first change ever made. */
  after: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(AUTO_TAG_CHANGES_MAX_LIMIT).optional()
});

const dimensionSchema = z.string();

export const autoTagFeedFactiiiSchema = z.object({
  id: z.number().int(),
  slug: z.string(),
  name: z.string(),
  dimension: dimensionSchema
});

export const autoTagChangeSchema = z.object({
  /** The change's place in the feed: the cursor. */
  seq: z.number().int(),
  /** The post's id as the clients hold it (Post.uuid), the id engagement
   *  intervals carry. */
  postId: z.string(),
  factiiiId: z.number().int(),
  dimension: dimensionSchema,
  added: z.boolean(),
  /** ms since epoch. */
  at: z.number()
});

export const autoTagChangesOutputSchema = z.object({
  changes: z.array(autoTagChangeSchema),
  /** The cursor to ask from next; the same `after` when nothing is new. */
  next: z.number().int(),
  /** False when this page was full and more wait. */
  done: z.boolean(),
  /** What every dimension offers now, with names, so a runner can name and
   *  score a tag it has never seen on a post. */
  factiiis: z.array(autoTagFeedFactiiiSchema)
});

export type AutoTagChangesInput = z.input<typeof autoTagChangesInputSchema>;
export type AutoTagFeedChange = z.infer<typeof autoTagChangeSchema>;
export type AutoTagChangesOutput = z.infer<typeof autoTagChangesOutputSchema>;
export type AutoTagFeedFactiii = z.infer<typeof autoTagFeedFactiiiSchema>;

/** The correlations' windows, in days. */
export const AUTO_TAG_CORRELATION_DAYS = [7, 30, 90] as const;

export const autoTagCorrelationsInputSchema = z.object({
  days: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(30)
});

export type AutoTagCorrelationsInput = z.input<
  typeof autoTagCorrelationsInputSchema
>;
