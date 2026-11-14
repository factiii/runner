import type { BoardAgentActionMap } from '@shared/all/domains/electron';
import { factiiiDayTotals } from '@shared/all/helpers/engagementDays';
import {
  computeFindings,
  findingsCacheKey,
  type FindingsInput,
  FINDINGS_WINDOW_DAYS
} from '@shared/all/helpers/findings/findings';
import { toneValenceById } from '@shared/all/helpers/tones';
import {
  ENGAGEMENT_HISTORY_MAX_LIMIT,
  type EngagementIntervalRow,
  type EngagementStoredFindings,
  type EngagementTone,
  engagementPushSchema,
  engagementQuerySchema
} from '@shared/all/validators';

import type { Statement } from './dbProtocol';
import type { VaultDb } from './db';
import { type FetchTagChanges, TAG_FEED_MIGRATIONS, type TagFeedSync, VaultTagFeed, withFeedTags } from './tagFeed';
import { PRIVATE_TAG_MIGRATIONS, type PrivateTagModel, VaultPrivateTags } from './privateTags';

// The owner's viewing data in the Vault (.specs/analytics.md "The runner's
// Vault"): every device's engagement intervals and the snapshots History
// shows, pushed from each device's local outbox over a direct link, and read
// back by the views as "All devices"; and the Findings job's last result
// (findingsJob.ts), worked out here over every device's intervals. Factiii's
// server never sees a row.
//
// These tables are the Vault's own, not the server's: they are not in
// vault.prisma, so schemaGen's drift check never compares them. Their
// migrations run after the generated ones (db.ts `migrate`), recorded in
// _vault_migrations like the rest.

export const ENGAGEMENT_MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: 'runner_0101_engagement',
    sql: `CREATE TABLE "RunnerEngagementInterval" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "deviceId" TEXT NOT NULL,
  "postId" TEXT NOT NULL,
  "factiiiIds" JSONB NOT NULL DEFAULT '[]',
  "factiiiNames" JSONB NOT NULL DEFAULT '{}',
  "startedAt" BIGINT NOT NULL,
  "endedAt" BIGINT NOT NULL,
  "source" TEXT NOT NULL,
  "updatedAt" BIGINT NOT NULL
);
CREATE INDEX "RunnerEngagementInterval_userId_startedAt_idx" ON "RunnerEngagementInterval"("userId", "startedAt");
CREATE INDEX "RunnerEngagementInterval_userId_postId_idx" ON "RunnerEngagementInterval"("userId", "postId");
CREATE TABLE "RunnerMoodEntry" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "deviceId" TEXT NOT NULL,
  "mood" TEXT NOT NULL,
  "timestamp" BIGINT NOT NULL,
  "updatedAt" BIGINT NOT NULL
);
CREATE INDEX "RunnerMoodEntry_userId_timestamp_idx" ON "RunnerMoodEntry"("userId", "timestamp");
CREATE TABLE "RunnerEngagementDevice" (
  "userId" INTEGER NOT NULL,
  "deviceId" TEXT NOT NULL,
  "acceptedThrough" BIGINT NOT NULL DEFAULT 0,
  "lastPushAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("userId", "deviceId")
);`
  },
  {
    // What each post looked like when first engaged: History's rows, so no
    // view asks Factiii's server which posts were read.
    id: 'runner_0102_post_snapshots',
    sql: `CREATE TABLE "RunnerPostSnapshot" (
  "userId" INTEGER NOT NULL,
  "postId" TEXT NOT NULL,
  "slug" TEXT,
  "content" TEXT NOT NULL,
  "authorUsername" TEXT,
  "authorName" TEXT,
  "anonymous" BOOLEAN NOT NULL DEFAULT false,
  "factiiiNames" JSONB NOT NULL DEFAULT '{}',
  "postCreatedAt" BIGINT,
  "savedAt" BIGINT NOT NULL,
  "updatedAt" BIGINT NOT NULL,
  PRIMARY KEY ("userId", "postId")
);`
  },
  {
    // Tone is passive (.specs/analytics.md "Tone is passive"): the
    // self-report entries are dropped with the self-report. The Findings
    // job's last result, and what it needs that no interval carries: the
    // owner's zone and which factiiis are Tones (from the latest push).
    id: 'runner_0103_findings_tone',
    sql: `DROP TABLE IF EXISTS "RunnerMoodEntry";
CREATE TABLE "RunnerFindings" (
  "userId" INTEGER NOT NULL PRIMARY KEY,
  "timeZone" TEXT,
  "tones" JSONB NOT NULL DEFAULT '[]',
  "result" JSONB,
  "dataKey" TEXT,
  "windowDays" INTEGER,
  "computedAt" BIGINT
);`
  },
  // The public tag-changes feed, attached to the history (tagFeed.ts).
  ...TAG_FEED_MIGRATIONS,
  // The owner's own dimensions and the local model's tags (privateTags.ts).
  ...PRIVATE_TAG_MIGRATIONS
];

type IntervalDbRow = {
  id: string;
  deviceId: string;
  postId: string;
  factiiiIds: unknown;
  factiiiNames: unknown;
  startedAt: string | number;
  endedAt: string | number;
  source: string;
  updatedAt: string | number;
};

type FindingsDbRow = {
  timeZone: string | null;
  tones: unknown;
  result: unknown;
  dataKey: string | null;
  windowDays: number | null;
  computedAt: string | number | null;
};

type HistoryDbRow = {
  postId: string;
  viewedAt: string | number;
  ms: string | number;
  hasSnapshot: boolean;
  slug: string | null;
  content: string | null;
  authorUsername: string | null;
  authorName: string | null;
  anonymous: boolean | null;
  factiiiNames: unknown;
  postCreatedAt: string | number | null;
  savedAt: string | number | null;
  updatedAt: string | number | null;
};

const DEFAULT_HISTORY_LIMIT = 20;
const MS_PER_DAY = 86_400_000;

/** What the Findings job did for one account. */
export type FindingsRun =
  | { state: 'computed'; computedAt: number }
  | { state: 'unchanged' }
  | { state: 'no-data' };

const asIds = (value: unknown): number[] =>
  Array.isArray(value) ? value.filter((id): id is number => Number.isFinite(id)) : [];

const asNames = (value: unknown): Record<string, string> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      )
    : {};

const toInterval = (row: IntervalDbRow): Omit<EngagementIntervalRow, 'kind'> & { deviceId: string } => ({
  id: row.id,
  deviceId: row.deviceId,
  postId: row.postId,
  factiiiIds: asIds(row.factiiiIds),
  factiiiNames: asNames(row.factiiiNames),
  startedAt: Number(row.startedAt),
  endedAt: Number(row.endedAt),
  source: row.source,
  updatedAt: Number(row.updatedAt)
});

const asTones = (value: unknown): EngagementTone[] =>
  Array.isArray(value)
    ? value.filter(
        (tone): tone is EngagementTone =>
          !!tone &&
          typeof tone === 'object' &&
          Number.isFinite((tone as EngagementTone).id) &&
          typeof (tone as EngagementTone).slug === 'string'
      )
    : [];

export class VaultEngagement {
  private readonly tagFeed: VaultTagFeed;
  private readonly privateTags: VaultPrivateTags;

  constructor(private readonly db: VaultDb) {
    this.tagFeed = new VaultTagFeed(db);
    this.privateTags = new VaultPrivateTags(db);
  }

  /** Tag the posts read along the owner's own dimensions, with this
   *  runner's Ollama (privateTags.ts). */
  runPrivateTags(userId: number, model: PrivateTagModel): Promise<number> {
    return this.privateTags.run(userId, model);
  }

  /** Download the public tag-changes feed since the last download
   *  (tagFeed.ts). */
  syncTagFeed(userId: number, fetchPage: FetchTagChanges): Promise<TagFeedSync> {
    return this.tagFeed.sync(userId, fetchPage);
  }

  /** The intervals with the feed's tags of their posts attached: a tag
   *  placed after a post was read, or taken off by a retag, counts. */
  private async withTags<T extends { postId: string; factiiiIds: number[]; factiiiNames: Record<string, string> }>(
    userId: number,
    intervals: T[]
  ): Promise<T[]> {
    const states = await this.tagFeed.postTags(
      userId,
      intervals.map((row) => row.postId)
    );
    if (states.size === 0) return intervals;
    const names = new Map((await this.tagFeed.factiiis(userId)).map((f) => [f.id, f.name]));
    return intervals.map((row) => withFeedTags(row, states.get(row.postId), names));
  }

  /**
   * Store a device's rows for `userId`, all or none. Each row upserts on its
   * id; a later save of an open interval moves its end, an older re-send
   * changes nothing. A row id another account already holds is left alone.
   */
  async push(
    payload: unknown,
    userId: number
  ): Promise<BoardAgentActionMap['engagementPush']['result']> {
    const { deviceId, rows, timeZone, tones } = engagementPushSchema.parse(payload);
    const statements: Statement[] = [];
    let newest = 0;
    for (const row of rows) {
      newest = Math.max(newest, row.updatedAt);
      // A retired self-report row from an older app: acknowledged, never
      // kept.
      if (row.kind === 'mood') continue;
      if (row.kind === 'privateDimension') {
        statements.push(...this.privateTags.statements(row, userId));
        continue;
      }
      if (row.kind === 'interval') {
        statements.push({
          sql: `INSERT INTO "RunnerEngagementInterval"
  ("id", "userId", "deviceId", "postId", "factiiiIds", "factiiiNames", "startedAt", "endedAt", "source", "updatedAt")
VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10)
ON CONFLICT ("id") DO UPDATE SET
  "endedAt" = GREATEST("RunnerEngagementInterval"."endedAt", EXCLUDED."endedAt"),
  "updatedAt" = GREATEST("RunnerEngagementInterval"."updatedAt", EXCLUDED."updatedAt")
WHERE "RunnerEngagementInterval"."userId" = EXCLUDED."userId"`,
          params: [
            row.id,
            userId,
            deviceId,
            row.postId,
            JSON.stringify(row.factiiiIds),
            JSON.stringify(row.factiiiNames),
            row.startedAt,
            row.endedAt,
            row.source,
            row.updatedAt
          ]
        });
      } else if (row.kind === 'snapshot') {
        // The first device to send a post's snapshot keeps it.
        statements.push({
          sql: `INSERT INTO "RunnerPostSnapshot"
  ("userId", "postId", "slug", "content", "authorUsername", "authorName", "anonymous", "factiiiNames", "postCreatedAt", "savedAt", "updatedAt")
VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)
ON CONFLICT ("userId", "postId") DO NOTHING`,
          params: [
            userId,
            row.postId,
            row.slug,
            row.content,
            row.authorUsername,
            row.authorName,
            row.anonymous,
            JSON.stringify(row.factiiiNames),
            row.postCreatedAt,
            row.savedAt,
            row.updatedAt
          ]
        });
      }
    }
    // The zone and the Tone list the Findings job reads, from whichever
    // device pushed last; a push without them keeps what is held.
    if (timeZone !== undefined || tones !== undefined) {
      statements.push({
        sql: `INSERT INTO "RunnerFindings" ("userId", "timeZone", "tones")
VALUES ($1, $2, $3::jsonb)
ON CONFLICT ("userId") DO UPDATE SET
  "timeZone" = COALESCE(EXCLUDED."timeZone", "RunnerFindings"."timeZone"),
  "tones" = CASE WHEN $4 THEN EXCLUDED."tones" ELSE "RunnerFindings"."tones" END`,
        params: [userId, timeZone ?? null, JSON.stringify(tones ?? []), tones !== undefined]
      });
    }
    statements.push({
      sql: `INSERT INTO "RunnerEngagementDevice" ("userId", "deviceId", "acceptedThrough", "lastPushAt")
VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
ON CONFLICT ("userId", "deviceId") DO UPDATE SET
  "acceptedThrough" = GREATEST("RunnerEngagementDevice"."acceptedThrough", EXCLUDED."acceptedThrough"),
  "lastPushAt" = CURRENT_TIMESTAMP`,
      params: [userId, deviceId, newest]
    });
    await this.db.batch(statements);
    return { acceptedThrough: newest, accepted: rows.length };
  }

  /** One view's read of every device's rows for `userId`. */
  async query(
    payload: unknown,
    userId: number
  ): Promise<BoardAgentActionMap['engagementQuery']['result']> {
    const query = engagementQuerySchema.parse(payload);
    const { start, end } = query.range;
    if (query.kind === 'findings') return { kind: 'findings', findings: await this.storedFindings(userId) };
    if (query.kind === 'privateTags') return { kind: 'privateTags', ...(await this.privateTags.read(userId)) };
    if (query.kind === 'history') {
      const limit = Math.min(query.limit ?? DEFAULT_HISTORY_LIMIT, ENGAGEMENT_HISTORY_MAX_LIMIT);
      const rows = await this.db.query<HistoryDbRow>(
        `SELECT t."postId", t."viewedAt", t."ms",
  s."slug", s."content", s."authorUsername", s."authorName", s."anonymous", s."factiiiNames",
  s."postCreatedAt", s."savedAt", s."updatedAt", (s."postId" IS NOT NULL) AS "hasSnapshot"
FROM (
  SELECT "postId", MAX("endedAt") AS "viewedAt", SUM("endedAt" - "startedAt") AS "ms"
  FROM "RunnerEngagementInterval"
  WHERE "userId" = $1 AND "endedAt" >= $2 AND "startedAt" <= $3
  GROUP BY "postId"
) t
LEFT JOIN "RunnerPostSnapshot" s ON s."userId" = $1 AND s."postId" = t."postId"
ORDER BY t."viewedAt" DESC, t."postId"
LIMIT $4 OFFSET $5`,
        [userId, start, end, limit, (query.page ?? 0) * limit]
      );
      return {
        kind: 'history',
        items: rows.map((row) => ({
          postId: row.postId,
          viewedAt: Number(row.viewedAt),
          duration: Math.round(Number(row.ms) / 1000),
          snapshot: row.hasSnapshot
            ? {
                postId: row.postId,
                slug: row.slug,
                content: row.content ?? '',
                authorUsername: row.authorUsername,
                authorName: row.authorName,
                anonymous: row.anonymous === true,
                factiiiNames: asNames(row.factiiiNames),
                postCreatedAt: row.postCreatedAt === null ? null : Number(row.postCreatedAt),
                savedAt: Number(row.savedAt),
                updatedAt: Number(row.updatedAt)
              }
            : null
        }))
      };
    }
    const intervals = await this.withTags(
      userId,
      (
        await this.db.query<IntervalDbRow>(
          `SELECT "id", "deviceId", "postId", "factiiiIds", "factiiiNames", "startedAt", "endedAt", "source", "updatedAt"
FROM "RunnerEngagementInterval"
WHERE "userId" = $1 AND "endedAt" >= $2 AND "startedAt" <= $3
ORDER BY "startedAt", "id"`,
          [userId, start, end]
        )
      ).map(toInterval)
    );
    if (query.kind === 'intervals') {
      return { kind: 'intervals', intervals: intervals.map(({ deviceId: _d, ...row }) => row) };
    }
    const clipped = intervals.map((row) => ({
      ...row,
      startedAt: Math.max(row.startedAt, start),
      endedAt: Math.min(row.endedAt, end)
    }));
    return { kind: 'daily', totals: factiiiDayTotals(clipped, query.timeZone) };
  }

  private async findingsRow(userId: number): Promise<FindingsDbRow | null> {
    const [row] = await this.db.query<FindingsDbRow>(
      `SELECT "timeZone", "tones", "result", "dataKey", "windowDays", "computedAt"
FROM "RunnerFindings" WHERE "userId" = $1`,
      [userId]
    );
    return row ?? null;
  }

  /** The Findings job's last result for `userId`, or null before its first
   *  run. */
  async storedFindings(userId: number): Promise<EngagementStoredFindings | null> {
    const row = await this.findingsRow(userId);
    if (!row?.result || row.computedAt === null) return null;
    return {
      result: row.result as EngagementStoredFindings['result'],
      computedAt: Number(row.computedAt),
      windowDays: row.windowDays ?? FINDINGS_WINDOW_DAYS,
      timeZone: row.timeZone
    };
  }

  /** The accounts that have viewing data here: the owner, in practice. */
  async findingsUsers(): Promise<number[]> {
    const rows = await this.db.query<{ userId: number }>(
      `SELECT DISTINCT "userId" FROM "RunnerEngagementInterval" ORDER BY "userId"`
    );
    return rows.map((row) => Number(row.userId));
  }

  /**
   * The Findings job for one account (.specs/analytics.md "Findings"): the
   * tests over every device's intervals of the last FINDINGS_WINDOW_DAYS, in
   * the zone and with the Tone list the latest push gave. Skipped when the
   * rows, zone and Tones are what the last run saw.
   */
  async runFindings(userId: number, now: number = Date.now()): Promise<FindingsRun> {
    const end = now;
    const start = end - FINDINGS_WINDOW_DAYS * MS_PER_DAY;
    const intervals = await this.withTags(
      userId,
      (
        await this.db.query<IntervalDbRow>(
          `SELECT "id", "deviceId", "postId", "factiiiIds", "factiiiNames", "startedAt", "endedAt", "source", "updatedAt"
FROM "RunnerEngagementInterval"
WHERE "userId" = $1 AND "endedAt" >= $2 AND "startedAt" <= $3
ORDER BY "startedAt", "id"`,
          [userId, start, end]
        )
      ).map(toInterval)
    );
    if (intervals.length === 0) return { state: 'no-data' };
    const held = await this.findingsRow(userId);
    // The Tone list a device pushed; before any push carried one, the feed's.
    const pushedTones = asTones(held?.tones);
    const tones =
      pushedTones.length > 0
        ? pushedTones
        : (await this.tagFeed.factiiis(userId)).filter((f) => f.dimension === 'tone');
    const factiiiNames: Record<number, string> = {};
    for (const interval of intervals) {
      for (const [id, name] of Object.entries(interval.factiiiNames)) factiiiNames[Number(id)] = name;
    }
    const input: FindingsInput = {
      intervals,
      factiiiNames,
      toneValence: toneValenceById(tones),
      ...(held?.timeZone ? { timeZone: held.timeZone } : {})
    };
    // The window slides with the day, so the day is part of the key.
    const dataKey = `${FINDINGS_WINDOW_DAYS}:${Math.floor(now / MS_PER_DAY)}:${findingsCacheKey(input)}`;
    if (held?.dataKey === dataKey && held.result) return { state: 'unchanged' };
    const result = computeFindings(input);
    await this.db.query(
      `INSERT INTO "RunnerFindings" ("userId", "result", "dataKey", "windowDays", "computedAt")
VALUES ($1, $2::jsonb, $3, $4, $5)
ON CONFLICT ("userId") DO UPDATE SET
  "result" = EXCLUDED."result",
  "dataKey" = EXCLUDED."dataKey",
  "windowDays" = EXCLUDED."windowDays",
  "computedAt" = EXCLUDED."computedAt"`,
      [userId, JSON.stringify(result), dataKey, FINDINGS_WINDOW_DAYS, now]
    );
    return { state: 'computed', computedAt: now };
  }
}
