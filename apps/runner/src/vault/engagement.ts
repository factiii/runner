import type { BoardAgentActionMap } from '@shared/all/domains/electron';
import { factiiiDayTotals } from '@shared/all/helpers/engagementDays';
import {
  ENGAGEMENT_HISTORY_MAX_LIMIT,
  type EngagementIntervalRow,
  type EngagementMoodRow,
  engagementPushSchema,
  engagementQuerySchema
} from '@shared/all/validators';

import type { Statement } from './dbProtocol';
import type { VaultDb } from './db';

// The owner's viewing data in the Vault (.specs/analytics.md "The runner's
// Vault"): every device's engagement intervals, mood entries and the
// snapshots History shows, pushed from
// each device's local outbox over a direct link, and read back by the views
// as "All devices". Factiii's server never sees a row.
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
  }
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

type MoodDbRow = {
  id: string;
  mood: EngagementMoodRow['mood'];
  timestamp: string | number;
  updatedAt: string | number;
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

const toMood = (row: MoodDbRow): Omit<EngagementMoodRow, 'kind'> => ({
  id: row.id,
  mood: row.mood,
  timestamp: Number(row.timestamp),
  updatedAt: Number(row.updatedAt)
});

export class VaultEngagement {
  constructor(private readonly db: VaultDb) {}

  /**
   * Store a device's rows for `userId`, all or none. Each row upserts on its
   * id; a later save of an open interval moves its end, an older re-send
   * changes nothing. A row id another account already holds is left alone.
   */
  async push(
    payload: unknown,
    userId: number
  ): Promise<BoardAgentActionMap['engagementPush']['result']> {
    const { deviceId, rows } = engagementPushSchema.parse(payload);
    const statements: Statement[] = [];
    let newest = 0;
    for (const row of rows) {
      newest = Math.max(newest, row.updatedAt);
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
      } else {
        statements.push({
          sql: `INSERT INTO "RunnerMoodEntry" ("id", "userId", "deviceId", "mood", "timestamp", "updatedAt")
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT ("id") DO UPDATE SET
  "mood" = EXCLUDED."mood",
  "timestamp" = EXCLUDED."timestamp",
  "updatedAt" = EXCLUDED."updatedAt"
WHERE "RunnerMoodEntry"."userId" = EXCLUDED."userId"
  AND "RunnerMoodEntry"."updatedAt" < EXCLUDED."updatedAt"`,
          params: [row.id, userId, deviceId, row.mood, row.timestamp, row.updatedAt]
        });
      }
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
    const intervals = (
      await this.db.query<IntervalDbRow>(
        `SELECT "id", "deviceId", "postId", "factiiiIds", "factiiiNames", "startedAt", "endedAt", "source", "updatedAt"
FROM "RunnerEngagementInterval"
WHERE "userId" = $1 AND "endedAt" >= $2 AND "startedAt" <= $3
ORDER BY "startedAt", "id"`,
        [userId, start, end]
      )
    ).map(toInterval);
    const moods = (
      await this.db.query<MoodDbRow>(
        `SELECT "id", "mood", "timestamp", "updatedAt" FROM "RunnerMoodEntry"
WHERE "userId" = $1 AND "timestamp" BETWEEN $2 AND $3
ORDER BY "timestamp", "id"`,
        [userId, start, end]
      )
    ).map(toMood);
    if (query.kind === 'intervals') {
      return { kind: 'intervals', intervals: intervals.map(({ deviceId: _d, ...row }) => row), moods };
    }
    const clipped = intervals.map((row) => ({
      ...row,
      startedAt: Math.max(row.startedAt, start),
      endedAt: Math.min(row.endedAt, end)
    }));
    return { kind: 'daily', totals: factiiiDayTotals(clipped, query.timeZone), moods };
  }
}
