import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { FsObjectStore } from '@shared/vault-core/objectStore';

import { openVaultDb, type VaultDb } from './db';
import { RunnerVault } from './service';
import { withFeedTags } from './tagFeed';

// The public tag-changes feed on the analytics runner (.specs/analytics.md
// "Tags after the fact"): downloaded whole from a cursor, kept for the posts
// in the history, attached to the intervals when they are read.

const OWNER = { role: 'owner' as const, userId: '1', name: 'Owner' };
const ENGINE = path.resolve(__dirname, '../..');
const NINE = Date.UTC(2026, 10, 3, 14);
const MINUTE = 60_000;
const COOKING = 7;
const HAPPY = 11;
const FACTIIIS = [{ id: HAPPY, slug: 'happy', name: 'Happy', dimension: 'tone' }];

const change = (seq: number, postId: string, factiiiId: number, added: boolean) => ({
  seq,
  postId,
  factiiiId,
  dimension: 'tone',
  added,
  at: NINE + seq
});

describe('the tag-changes feed in the Vault', () => {
  let db: VaultDb;
  let vault: RunnerVault;

  before(async () => {
    db = await openVaultDb({ dataDir: 'memory://', engineDir: ENGINE });
    const store = new FsObjectStore(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-vault-tagfeed-')));
    vault = new RunnerVault(db, store, '1', () => {}, null, null, null);
    await vault.handle(
      'engagementPush',
      {
        deviceId: 'phone',
        rows: [
          {
            kind: 'interval',
            id: '0190a000-0000-7000-8000-000000000011',
            postId: 'post-1',
            factiiiIds: [COOKING],
            factiiiNames: { [COOKING]: 'Cooking' },
            startedAt: NINE,
            endedAt: NINE + 5 * MINUTE,
            source: 'web',
            updatedAt: NINE + 5 * MINUTE
          }
        ]
      },
      OWNER
    );
  });
  after(async () => {
    await db.close();
  });

  it('downloads from its cursor, keeps only the history’s posts, and attaches the tags', async () => {
    const asked: number[] = [];
    const pages: Record<number, unknown> = {
      0: {
        // A tag placed after the post was read, and one on a post never read.
        changes: [change(1, 'post-1', HAPPY, true), change(2, 'post-9', HAPPY, true)],
        next: 2,
        done: false,
        factiiis: FACTIIIS
      },
      2: {
        // A retag took the old one off.
        changes: [change(3, 'post-1', COOKING, false)],
        next: 3,
        done: true,
        factiiis: FACTIIIS
      }
    };
    const result = await vault.syncTagFeed(async (afterSeq) => {
      asked.push(afterSeq);
      return pages[afterSeq];
    });
    assert.deepEqual(asked, [0, 2]);
    assert.deepEqual(result, { pages: 2, kept: 2, cursor: 3, done: true });

    const read = (await vault.handle(
      'engagementQuery',
      { kind: 'intervals', range: { start: NINE - MINUTE, end: NINE + 60 * MINUTE } },
      OWNER
    )) as { intervals: { postId: string; factiiiIds: number[]; factiiiNames: Record<string, string> }[] };
    assert.deepEqual(read.intervals[0].factiiiIds, [HAPPY]);
    assert.equal(read.intervals[0].factiiiNames[String(HAPPY)], 'Happy');

    // The next download starts where this one stopped.
    const again: number[] = [];
    await vault.syncTagFeed(async (afterSeq) => {
      again.push(afterSeq);
      return { changes: [], next: afterSeq, done: true, factiiis: FACTIIIS };
    });
    assert.deepEqual(again, [3]);
  });

  it('keeps its cursor when a page cannot be read', async () => {
    await assert.rejects(vault.syncTagFeed(async () => ({ not: 'a page' })));
    const asked: number[] = [];
    await vault.syncTagFeed(async (afterSeq) => {
      asked.push(afterSeq);
      return { changes: [], next: afterSeq, done: true, factiiis: FACTIIIS };
    });
    assert.deepEqual(asked, [3]);
  });

  it('lets a later change win over an older one sent again', async () => {
    await vault.syncTagFeed(async () => ({
      changes: [change(1, 'post-1', HAPPY, false)],
      next: 3,
      done: true,
      factiiis: FACTIIIS
    }));
    const read = (await vault.handle(
      'engagementQuery',
      { kind: 'intervals', range: { start: NINE - MINUTE, end: NINE + 60 * MINUTE } },
      OWNER
    )) as { intervals: { factiiiIds: number[] }[] };
    assert.deepEqual(read.intervals[0].factiiiIds, [HAPPY]);
  });
  it('attaches a change the feed reached before the post’s interval was pushed', async () => {
    const READ_AT = Date.now() - 10 * MINUTE;
    // Read, tagged, and the feed downloaded before the device pushed it.
    await vault.syncTagFeed(async (afterSeq) => ({
      changes: [{ ...change(10, 'post-late', HAPPY, true), at: READ_AT + MINUTE }],
      next: Math.max(afterSeq, 10),
      done: true,
      factiiis: FACTIIIS
    }));
    await vault.handle(
      'engagementPush',
      {
        deviceId: 'phone',
        rows: [
          {
            kind: 'interval',
            id: '0190a000-0000-7000-8000-000000000012',
            postId: 'post-late',
            factiiiIds: [COOKING],
            factiiiNames: { [COOKING]: 'Cooking' },
            startedAt: READ_AT,
            endedAt: READ_AT + MINUTE,
            source: 'web',
            updatedAt: READ_AT + MINUTE
          }
        ]
      },
      OWNER
    );
    const read = (await vault.handle(
      'engagementQuery',
      { kind: 'intervals', range: { start: READ_AT - MINUTE, end: READ_AT + 60 * MINUTE } },
      OWNER
    )) as { intervals: { postId: string; factiiiIds: number[] }[] };
    const late = read.intervals.find((interval) => interval.postId === 'post-late');
    assert.deepEqual(late?.factiiiIds, [COOKING, HAPPY]);
  });

  it('keeps no change of a post never read once it is past the wait', async () => {
    const rows = await db.query<{ postId: string }>(
      `SELECT "postId" FROM "RunnerPostTag" WHERE "postId" = 'post-9'`
    );
    // post-9's change (seq 2) is from 2026-11-03, past TAG_FEED_PENDING_MS.
    assert.deepEqual(rows, []);
  });
});

describe('withFeedTags', () => {
  const row = { postId: 'p', factiiiIds: [1, 2], factiiiNames: { '1': 'One', '2': 'Two' } };

  it('adds what the feed says the post has and drops what was taken off', () => {
    const out = withFeedTags(
      row,
      { present: new Set([3]), removed: new Set([2]) },
      new Map([[3, 'Three']])
    );
    assert.deepEqual(out.factiiiIds, [1, 3]);
    assert.deepEqual(out.factiiiNames, { '1': 'One', '2': 'Two', '3': 'Three' });
  });

  it('leaves a post the feed says nothing of as it was', () => {
    assert.equal(withFeedTags(row, undefined, new Map()), row);
  });
});
