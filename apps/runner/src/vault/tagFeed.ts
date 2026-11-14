import {
  autoTagChangesOutputSchema,
  type AutoTagChangesOutput,
  type AutoTagFeedFactiii
} from '@shared/all/validators/autoTag';

import type { Statement } from './dbProtocol';
import type { VaultDb } from './db';

// The public tag-changes feed, on the analytics runner (.specs/analytics.md
// "Tags after the fact", .specs/auto-tag.md): every automatic tag added to or
// taken off any public post, downloaded whole since the last download, so the
// server never learns which posts this runner's owner read. Kept here are the
// changes of the posts in the owner's history; they are attached to the
// intervals when they are read, so a tag placed after a post was read, or a
// retag, counts for it.
//
// A change before the post was read is already in the interval's own
// factiiiIds (the client held the post's tags when the view started). But a
// post can be read before the feed reaches its change and its interval pushed
// only after: a device pushes while its link is up, and holds what it read
// while it is not. So a change for a post not in the history yet is kept
// too, for TAG_FEED_PENDING_MS after it was made, and attached when the
// interval arrives; one older than that is dropped (and its kept row pruned),
// so the Vault does not grow with every public post. Attaching the feed's
// latest word to an interval that already had it changes nothing.

export const TAG_FEED_MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: 'runner_0104_tag_feed',
    sql: `CREATE TABLE "RunnerPostTag" (
  "userId" INTEGER NOT NULL,
  "postId" TEXT NOT NULL,
  "factiiiId" INTEGER NOT NULL,
  "dimension" TEXT NOT NULL,
  "present" BOOLEAN NOT NULL,
  "seq" BIGINT NOT NULL,
  PRIMARY KEY ("userId", "postId", "factiiiId")
);
CREATE TABLE "RunnerTagFeed" (
  "userId" INTEGER NOT NULL PRIMARY KEY,
  "cursor" BIGINT NOT NULL DEFAULT 0,
  "factiiis" JSONB NOT NULL DEFAULT '[]',
  "fetchedAt" BIGINT
);`
  },
  {
    // When each change was made (the feed's `at`), so a change of a post not
    // read yet is pruned once it is past TAG_FEED_PENDING_MS. Null on the rows
    // kept before: all of them are of posts read, and never pruned.
    id: 'runner_0106_tag_feed_pending',
    sql: `ALTER TABLE "RunnerPostTag" ADD COLUMN "at" BIGINT;
CREATE INDEX "RunnerPostTag_userId_at_idx" ON "RunnerPostTag"("userId", "at");`
  }
];

/** How long a change of a post not in the history yet is kept, waiting for
 *  its interval: a device away from its runner for longer than this pushes
 *  intervals whose tags placed meanwhile are missed (their own still count). */
export const TAG_FEED_PENDING_MS = 7 * 24 * 60 * 60 * 1000;

/** One page of the feed after `after` (the server's `autoTag.changes`). */
export type FetchTagChanges = (after: number) => Promise<unknown>;

/** Pages one download reads at most, so a first download of a long feed is
 *  spread over a few runs rather than holding the Vault for minutes. */
export const TAG_FEED_MAX_PAGES = 50;

export type TagFeedSync = { pages: number; kept: number; cursor: number; done: boolean };

/** What the feed says of one post: the tags it has now, and the ones taken
 *  off it. */
export type PostTagState = { present: Set<number>; removed: Set<number> };

type FeedRow = { cursor: string | number; factiiis: unknown };

const asFactiiis = (value: unknown): AutoTagFeedFactiii[] =>
  Array.isArray(value)
    ? value.filter(
        (f): f is AutoTagFeedFactiii =>
          !!f &&
          typeof f === 'object' &&
          Number.isFinite((f as AutoTagFeedFactiii).id) &&
          typeof (f as AutoTagFeedFactiii).slug === 'string' &&
          typeof (f as AutoTagFeedFactiii).name === 'string'
      )
    : [];

export class VaultTagFeed {
  constructor(private readonly db: VaultDb) {}

  private async feedRow(userId: number): Promise<FeedRow | null> {
    const [row] = await this.db.query<FeedRow>(
      `SELECT "cursor", "factiiis" FROM "RunnerTagFeed" WHERE "userId" = $1`,
      [userId]
    );
    return row ?? null;
  }

  /** The dimension lists the last download held: names and which are Tones. */
  async factiiis(userId: number): Promise<AutoTagFeedFactiii[]> {
    return asFactiiis((await this.feedRow(userId))?.factiiis);
  }

  /**
   * Download the feed from where the last download stopped, page by page,
   * keeping the changes of posts in `userId`'s history. A page that fails to
   * download or parse ends the run; the cursor stays where the last kept page
   * left it, so nothing is skipped.
   */
  async sync(
    userId: number,
    fetchPage: FetchTagChanges,
    maxPages: number = TAG_FEED_MAX_PAGES,
    now: number = Date.now()
  ): Promise<TagFeedSync> {
    let cursor = Number((await this.feedRow(userId))?.cursor ?? 0);
    let kept = 0;
    let pages = 0;
    let done = false;
    while (pages < maxPages && !done) {
      const page: AutoTagChangesOutput = autoTagChangesOutputSchema.parse(await fetchPage(cursor));
      pages++;
      done = page.done || page.next <= cursor;
      kept += await this.keep(userId, page, now);
      cursor = page.next;
    }
    return { pages, kept, cursor, done };
  }

  /** One page into the Vault, all or none, with the new cursor. Answers how
   *  many of its changes were of posts in the history. */
  private async keep(userId: number, page: AutoTagChangesOutput, now: number): Promise<number> {
    const postIds = [...new Set(page.changes.map((change) => change.postId))];
    const read = postIds.length
      ? new Set(
          (
            await this.db.query<{ postId: string }>(
              `SELECT DISTINCT "postId" FROM "RunnerEngagementInterval"
WHERE "userId" = $1 AND "postId" = ANY($2::text[])`,
              [userId, postIds]
            )
          ).map((row) => row.postId)
        )
      : new Set<string>();
    const statements: Statement[] = [];
    const pendingSince = now - TAG_FEED_PENDING_MS;
    let kept = 0;
    for (const change of page.changes) {
      if (read.has(change.postId)) kept++;
      // A post not read yet: kept while its interval may still be on its way.
      else if (change.at < pendingSince) continue;
      // The latest change of a tag wins; an older one arriving again is
      // ignored.
      statements.push({
        sql: `INSERT INTO "RunnerPostTag" ("userId", "postId", "factiiiId", "dimension", "present", "seq", "at")
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT ("userId", "postId", "factiiiId") DO UPDATE SET
  "present" = EXCLUDED."present",
  "dimension" = EXCLUDED."dimension",
  "seq" = EXCLUDED."seq",
  "at" = EXCLUDED."at"
WHERE "RunnerPostTag"."seq" < EXCLUDED."seq"`,
        params: [userId, change.postId, change.factiiiId, change.dimension, change.added, change.seq, change.at]
      });
    }
    // What waited longer than TAG_FEED_PENDING_MS for a post still not read.
    statements.push({
      sql: `DELETE FROM "RunnerPostTag" t
WHERE t."userId" = $1 AND t."at" < $2
  AND NOT EXISTS (
    SELECT 1 FROM "RunnerEngagementInterval" i
    WHERE i."userId" = t."userId" AND i."postId" = t."postId"
  )`,
      params: [userId, pendingSince]
    });
    statements.push({
      sql: `INSERT INTO "RunnerTagFeed" ("userId", "cursor", "factiiis", "fetchedAt")
VALUES ($1, $2, $3::jsonb, $4)
ON CONFLICT ("userId") DO UPDATE SET
  "cursor" = GREATEST("RunnerTagFeed"."cursor", EXCLUDED."cursor"),
  "factiiis" = EXCLUDED."factiiis",
  "fetchedAt" = EXCLUDED."fetchedAt"`,
      params: [userId, page.next, JSON.stringify(page.factiiis), now]
    });
    await this.db.batch(statements);
    return kept;
  }

  /** What the feed says of each of these posts. A post it says nothing of is
   *  not in the map. */
  async postTags(userId: number, postIds: readonly string[]): Promise<Map<string, PostTagState>> {
    const out = new Map<string, PostTagState>();
    if (postIds.length === 0) return out;
    const rows = await this.db.query<{ postId: string; factiiiId: number; present: boolean }>(
      `SELECT "postId", "factiiiId", "present" FROM "RunnerPostTag"
WHERE "userId" = $1 AND "postId" = ANY($2::text[])`,
      [userId, [...new Set(postIds)]]
    );
    for (const row of rows) {
      const state = out.get(row.postId) ?? { present: new Set<number>(), removed: new Set<number>() };
      (row.present ? state.present : state.removed).add(Number(row.factiiiId));
      out.set(row.postId, state);
    }
    return out;
  }
}

/**
 * An interval's factiiis with the feed's word on its post: a tag taken off
 * since goes, a tag added since (a late tag, a retag) comes in, named from
 * the feed's lists. Everything else the interval held stays.
 */
export const withFeedTags = <
  T extends { postId: string; factiiiIds: number[]; factiiiNames: Record<string, string> }
>(
  interval: T,
  state: PostTagState | undefined,
  names: ReadonlyMap<number, string>
): T => {
  if (!state) return interval;
  const ids = interval.factiiiIds.filter((id) => !state.removed.has(id));
  const factiiiNames = { ...interval.factiiiNames };
  for (const id of state.present) {
    if (!ids.includes(id)) ids.push(id);
    const name = names.get(id);
    if (name && !factiiiNames[String(id)]) factiiiNames[String(id)] = name;
  }
  return { ...interval, factiiiIds: ids, factiiiNames };
};
