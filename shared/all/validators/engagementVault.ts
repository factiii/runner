import { z } from 'zod';

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

export const ENGAGEMENT_MOODS = ['angry', 'sad', 'happy', 'laughing'] as const;

export const engagementMoodRowSchema = z.object({
  kind: z.literal('mood'),
  id: z.string().uuid(),
  mood: z.enum(ENGAGEMENT_MOODS),
  timestamp: ms,
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
  savedAt: ms,
  updatedAt: ms
});

export const engagementRowSchema = z.union([
  engagementIntervalRowSchema,
  engagementMoodRowSchema,
  engagementSnapshotRowSchema
]);

export const engagementPushSchema = z.object({
  deviceId,
  rows: z.array(engagementRowSchema).max(ENGAGEMENT_PUSH_BATCH)
});

export const engagementQuerySchema = z
  .object({
    kind: z.enum(['history', 'daily', 'intervals']),
    range: z.object({ start: ms, end: ms }),
    /** The viewer's IANA zone: `daily` cuts days in it. */
    timeZone: z.string().min(1).max(TIME_ZONE_MAX).optional(),
    /** `history` only. */
    page: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(ENGAGEMENT_HISTORY_MAX_LIMIT).optional()
  })
  .refine((q) => q.range.end >= q.range.start, {
    message: 'A range ends after it starts.'
  })
  // History pages through everything; the reads that return every row in
  // the range are capped.
  .refine(
    (q) => q.kind === 'history' || q.range.end - q.range.start <= ENGAGEMENT_QUERY_MAX_SPAN_MS,
    { message: 'That range is too long.' }
  );

export type EngagementIntervalRow = z.infer<typeof engagementIntervalRowSchema>;
export type EngagementMoodRow = z.infer<typeof engagementMoodRowSchema>;
export type EngagementSnapshotRow = z.infer<typeof engagementSnapshotRowSchema>;
export type EngagementRow = z.infer<typeof engagementRowSchema>;
export type EngagementPush = z.infer<typeof engagementPushSchema>;
export type EngagementQuery = z.infer<typeof engagementQuerySchema>;

/** The push's answer: the newest change the Vault now holds from this
 *  device, which the device keeps as its cursor. */
export type EngagementPushResult = { acceptedThrough: number; accepted: number };

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

export type EngagementQueryResult =
  | { kind: 'history'; items: EngagementHistoryItem[] }
  | { kind: 'daily'; totals: EngagementDayTotal[]; moods: Omit<EngagementMoodRow, 'kind'>[] }
  | {
      kind: 'intervals';
      intervals: Omit<EngagementIntervalRow, 'kind'>[];
      moods: Omit<EngagementMoodRow, 'kind'>[];
    };
