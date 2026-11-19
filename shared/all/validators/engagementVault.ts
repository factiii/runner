import { z } from 'zod';

import type { FindingsResult } from '../helpers/findings/findings';

// A device's viewing data in its owner's runner Vault (.specs/analytics.md
// "The runner's Vault"): the push from a device's local outbox, and the reads
// a view makes while a direct link is up. Checked on the runner before
// anything touches its database; used by the client to build the payloads.

/** Rows in one push. The device sends at most this many, oldest change
 *  first, and pushes again until it has none left. */
export const ENGAGEMENT_PUSH_BATCH = 500;
/** Longest one query may span: a year and a bit. */
export const ENGAGEMENT_QUERY_MAX_SPAN_MS = 400 * 24 * 60 * 60 * 1000;
/** History rows one page holds. */
export const ENGAGEMENT_HISTORY_MAX_LIMIT = 100;

const ID_MAX = 64;
const NAME_MAX = 200;
const FACTIIIS_MAX = 200;
const TIME_ZONE_MAX = 64;
const SLUG_MAX = 200;
/** Tone factiiis one push may name. */
const TONES_MAX = 100;

const ms = z.number().int().nonnegative();
const deviceId = z.string().min(1).max(ID_MAX);

export const engagementIntervalRowSchema = z
  .object({
    kind: z.literal('interval'),
    id: z.string().uuid(),
    postId: z.string().min(1).max(ID_MAX),
    factiiiIds: z.array(z.number().int()).max(FACTIIIS_MAX),
    factiiiNames: z.record(z.string(), z.string().max(NAME_MAX)),
    startedAt: ms,
    endedAt: ms,
    source: z.string().max(ID_MAX),
    updatedAt: ms
  })
  .refine((row) => row.endedAt >= row.startedAt, {
    message: 'An interval ends after it starts.'
  });

/**
 * A self-report row from an app older than the drop of the self-report
 * (.specs/analytics.md "Tone is passive"; the wire kind keeps its old name).
 * Accepted so that app's push of its intervals still lands, and never
 * stored: the runner drops it.
 */
export const engagementRetiredRowSchema = z.object({
  kind: z.literal('mood'),
  updatedAt: ms
});

/** Post text a snapshot keeps at most. */
export const POST_SNAPSHOT_CONTENT_MAX = 4000;

/** What a post looked like when first engaged (History's row). */
export const engagementSnapshotRowSchema = z.object({
  kind: z.literal('snapshot'),
  postId: z.string().min(1).max(ID_MAX),
  slug: z.string().max(NAME_MAX).nullable(),
  content: z.string().max(POST_SNAPSHOT_CONTENT_MAX),
  authorUsername: z.string().max(NAME_MAX).nullable(),
  authorName: z.string().max(NAME_MAX).nullable(),
  anonymous: z.boolean(),
  factiiiNames: z.record(z.string(), z.string().max(NAME_MAX)),
  postCreatedAt: ms.nullable(),
  // The "written by AI" mark as the post carried it, named and typed as the
  // server's PostDto has it (.specs/ai-actions.md "The tag"). Optional: a
  // device or runner older than the mark sends neither, which reads as not
  // AI.
  byAi: z.boolean().optional(),
  editedByAi: z.boolean().optional(),
  savedAt: ms,
  updatedAt: ms
});

/** A private dimension's name and values at most (.specs/analytics.md
 *  "Private tags"). */
export const PRIVATE_DIMENSION_NAME_MAX = 40;
export const PRIVATE_DIMENSION_VALUE_MAX = 30;
export const PRIVATE_DIMENSION_VALUES_MIN = 2;
export const PRIVATE_DIMENSION_VALUES_MAX = 12;

/**
 * One of the owner's own dimensions (.specs/analytics.md "Private tags"): a
 * name and the values the runner's Ollama picks one of for each post they
 * read. Sent straight to the runner, never through Factiii's server, and kept
 * in the Vault only. `deleted` takes it and its tags away.
 */
export const engagementPrivateDimensionRowSchema = z.object({
  kind: z.literal('privateDimension'),
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(PRIVATE_DIMENSION_NAME_MAX),
  values: z
    .array(z.string().trim().min(1).max(PRIVATE_DIMENSION_VALUE_MAX))
    .min(PRIVATE_DIMENSION_VALUES_MIN)
    .max(PRIVATE_DIMENSION_VALUES_MAX),
  deleted: z.boolean().default(false),
  updatedAt: ms
});

export const engagementRowSchema = z.union([
  engagementIntervalRowSchema,
  engagementSnapshotRowSchema,
  engagementRetiredRowSchema,
  engagementPrivateDimensionRowSchema
]);

/** One Tone factiii, as the server lists it (`stats.toneConfig`). */
export const engagementToneSchema = z.object({
  id: z.number().int(),
  slug: z.string().min(1).max(SLUG_MAX)
});

export const engagementPushSchema = z.object({
  deviceId,
  rows: z.array(engagementRowSchema).max(ENGAGEMENT_PUSH_BATCH),
  /** The pushing device's IANA zone and the Tone factiiis, for the runner's
   *  scheduled Findings job: it has no zone of its own to cut days in and
   *  cannot ask Factiii's server which factiiis are Tones. Kept per account,
   *  the latest push's winning. */
  timeZone: z.string().min(1).max(TIME_ZONE_MAX).optional(),
  tones: z.array(engagementToneSchema).max(TONES_MAX).optional()
});

export const engagementQuerySchema = z
  .object({
    /** `findings` reads the Findings job's last result; it ignores the
     *  range. */
    kind: z.enum(['history', 'daily', 'intervals', 'findings', 'privateTags']),
    range: z.object({ start: ms, end: ms }),
    /** The viewer's IANA zone: `daily` cuts days in it. */
    timeZone: z.string().min(1).max(TIME_ZONE_MAX).optional(),
    /** `history` only. */
    page: z.number().int().nonnegative().optional(),
    limit: z
      .number()
      .int()
      .positive()
      .max(ENGAGEMENT_HISTORY_MAX_LIMIT)
      .optional()
  })
  .refine((q) => q.range.end >= q.range.start, {
    message: 'A range ends after it starts.'
  })
  // History pages through everything; the reads that return every row in
  // the range are capped.
  .refine(
    (q) =>
      q.kind === 'history' ||
      q.kind === 'privateTags' ||
      q.range.end - q.range.start <= ENGAGEMENT_QUERY_MAX_SPAN_MS,
    { message: 'That range is too long.' }
  );

export type EngagementIntervalRow = z.infer<typeof engagementIntervalRowSchema>;
export type EngagementTone = z.infer<typeof engagementToneSchema>;
export type EngagementSnapshotRow = z.infer<typeof engagementSnapshotRowSchema>;
export type EngagementRow = z.infer<typeof engagementRowSchema>;
export type EngagementPush = z.infer<typeof engagementPushSchema>;
export type EngagementQuery = z.infer<typeof engagementQuerySchema>;

/** The push's answer: the newest change the Vault now holds from this
 *  device, which the device keeps as its cursor. */
export type EngagementPushResult = {
  acceptedThrough: number;
  accepted: number;
};

export type EngagementHistoryItem = {
  postId: string;
  viewedAt: number;
  /** Seconds. */
  duration: number;
  /** What the post looked like then; null for a post viewed before
   *  snapshots were kept. */
  snapshot: Omit<EngagementSnapshotRow, 'kind'> | null;
};

export type EngagementDayTotal = {
  dayKey: string;
  factiiiId: number;
  factiiiName: string;
  /** Seconds. */
  duration: number;
  viewedAt: number;
};

/** The runner's Findings job's last result (findingsJob.ts), as the Vault
 *  keeps it. */
export type EngagementStoredFindings = {
  result: FindingsResult;
  /** When the job ran, ms. */
  computedAt: number;
  /** The days it looked back over. */
  windowDays: number;
  /** The zone it cut days in. */
  timeZone: string | null;
};

export type EngagementPrivateDimensionRow = z.infer<
  typeof engagementPrivateDimensionRowSchema
>;

/** One private dimension as the Vault answers it: how many of the posts read
 *  got each value, and how many wait for the runner's Ollama. */
export type EngagementPrivateDimension = {
  id: string;
  name: string;
  values: string[];
  /** Posts read that have a value, by value. */
  counts: Record<string, number>;
  /** Posts read that have no value yet. */
  waiting: number;
};

export type EngagementPrivateTags = {
  dimensions: EngagementPrivateDimension[];
  /** Why the last run tagged nothing, when it did not: no Ollama model on
   *  this runner, or Ollama not answering. Null when it ran. */
  problem: string | null;
};

export type EngagementQueryResult =
  | { kind: 'history'; items: EngagementHistoryItem[] }
  | { kind: 'daily'; totals: EngagementDayTotal[] }
  | {
      kind: 'intervals';
      intervals: Omit<EngagementIntervalRow, 'kind'>[];
    }
  | {
      kind: 'findings';
      /** Null until the job has run once. */
      findings: EngagementStoredFindings | null;
    }
  | ({ kind: 'privateTags' } & EngagementPrivateTags);

/** "Use this runner": the account's analytics runner, or null for none
 *  chosen (a device then keeps the first owned runner it reaches). */
export const analyticsHomeSetSchema = z.object({
  runnerId: z.number().int().positive().nullable()
});
