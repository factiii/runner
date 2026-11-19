import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  relaySecretsRefusal,
  RELAY_VAULT_REFUSAL
} from '@shared/all/helpers/board-agent-core/runner-access';

import { openVaultDb, type VaultDb } from './db';
import { FsObjectStore } from '@shared/vault-core/objectStore';
import { RunnerVault } from './service';

// The owner's viewing data in the Vault (.specs/analytics.md "The runner's
// Vault"), on a real PGlite.

const OWNER = { role: 'owner' as const, userId: '1', name: 'Owner' };
const PEER = { role: 'member' as const, spaceSlugs: [], userId: '2', name: 'Peer', vault: true };
const ENGINE = path.resolve(__dirname, '../..');
const NY = 'America/New_York';
// 2026-11-03 09:00 in New York.
const NINE = Date.UTC(2026, 10, 3, 14);
const MINUTE = 60_000;
const DAY = 86_400_000;

const interval = (id: string, startedAt: number, minutes: number, postId = 'post-1') => ({
  kind: 'interval' as const,
  id,
  postId,
  factiiiIds: [7],
  factiiiNames: { '7': 'Cooking' },
  startedAt,
  endedAt: startedAt + minutes * MINUTE,
  source: 'mobile',
  updatedAt: startedAt + minutes * MINUTE
});

describe('the Vault’s viewing data', () => {
  let db: VaultDb;
  let vault: RunnerVault;

  before(async () => {
    db = await openVaultDb({ dataDir: 'memory://', engineDir: ENGINE });
    const store = new FsObjectStore(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-vault-engagement-')));
    vault = new RunnerVault(db, store, '1', () => {}, null, null, null);
  });
  after(async () => {
    await db.close();
  });

  const A = '0190a000-0000-7000-8000-000000000001';
  const B = '0190a000-0000-7000-8000-000000000002';
  const RETIRED = '0190a000-0000-7000-8000-000000000003';

  it('upserts on id, so a re-send and a later save are harmless', async () => {
    const first = await vault.handle(
      'engagementPush',
      { deviceId: 'phone', rows: [interval(A, NINE, 1)] },
      OWNER
    );
    assert.deepEqual(first, { acceptedThrough: NINE + MINUTE, accepted: 1 });
    // The open interval saved again, longer; then the old copy re-sent.
    await vault.handle('engagementPush', { deviceId: 'phone', rows: [interval(A, NINE, 3)] }, OWNER);
    await vault.handle('engagementPush', { deviceId: 'phone', rows: [interval(A, NINE, 1)] }, OWNER);
    const retired = await vault.handle(
      'engagementPush',
      {
        deviceId: 'laptop',
        rows: [
          {
            kind: 'snapshot',
            postId: 'post-2',
            slug: 'a-post',
            content: 'Hello',
            authorUsername: 'jo',
            authorName: 'Jo',
            anonymous: false,
            factiiiNames: { '7': 'Cooking' },
            postCreatedAt: NINE - MINUTE,
            // The "written by AI" mark; `editedByAi` left out, as a device
            // older than the mark leaves out both.
            byAi: true,
            savedAt: NINE + 60 * MINUTE,
            updatedAt: NINE + 60 * MINUTE
          },
          interval(B, NINE + 60 * MINUTE, 2, 'post-2'),
          // A self-report row from an app older than the drop: acknowledged,
          // never kept.
          { kind: 'mood', id: RETIRED, mood: 'happy', timestamp: NINE + 70 * MINUTE, updatedAt: NINE + 70 * MINUTE }
        ]
      },
      OWNER
    );
    assert.deepEqual(retired, { acceptedThrough: NINE + 70 * MINUTE, accepted: 3 });
    const answer = (await vault.handle(
      'engagementQuery',
      { kind: 'intervals', range: { start: NINE - MINUTE, end: NINE + 120 * MINUTE } },
      OWNER
    )) as { intervals: { id: string; endedAt: number }[] };
    const { intervals } = answer;
    assert.deepEqual(
      intervals.map((row) => [row.id, row.endedAt]),
      [
        [A, NINE + 3 * MINUTE],
        [B, NINE + 62 * MINUTE]
      ]
    );
    assert.deepEqual(Object.keys(answer), ['kind', 'intervals']);
  });

  it('answers history and day totals across devices', async () => {
    const range = { start: NINE - 60 * MINUTE, end: NINE + 600 * MINUTE };
    const history = (await vault.handle('engagementQuery', { kind: 'history', range }, OWNER)) as {
      items: {
        postId: string;
        duration: number;
        snapshot: { content: string; byAi?: boolean; editedByAi?: boolean } | null;
      }[];
    };
    // The snapshot's AI mark comes back as it was pushed; one not sent is false.
    assert.deepEqual(
      [history.items[0]?.snapshot?.byAi, history.items[0]?.snapshot?.editedByAi],
      [true, false]
    );
    assert.deepEqual(
      history.items.map((item) => [item.postId, item.duration, item.snapshot?.content ?? null]),
      [
        ['post-2', 120, 'Hello'],
        ['post-1', 180, null]
      ]
    );
    const daily = (await vault.handle(
      'engagementQuery',
      { kind: 'daily', range, timeZone: NY },
      OWNER
    )) as { totals: { dayKey: string; factiiiName: string; duration: number }[] };
    // viewedAt is the last moment read, inside the day (the reading's end,
    // less 1 ms, so one cut at midnight is not the next day's first moment).
    assert.deepEqual(daily.totals, [
      { dayKey: '2026-11-03', factiiiId: 7, factiiiName: 'Cooking', duration: 300, viewedAt: NINE + 62 * MINUTE - 1 }
    ]);
  });

  it('runs Findings as a job over every device and answers them to a query', async () => {
    const TONE = { id: 101, slug: 'happy' };
    // Before any run there is nothing stored, and no number is made up.
    const before = (await vault.handle('engagementQuery', { kind: 'findings', range: { start: 0, end: 1 } }, OWNER)) as {
      findings: unknown;
    };
    assert.equal(before.findings, null);

    // Twenty days of reading from two devices; the latest push carries the
    // zone and the Tone list.
    const rows = (device: number) =>
      Array.from({ length: 10 }, (_, d) => ({
        ...interval(
          `0190a000-0000-7000-8000-0000000${String(1000 + device * 100 + d).padStart(5, '0')}`,
          NINE + (device * 10 + d) * DAY,
          5,
          `post-${device}-${d}`
        ),
        factiiiIds: [7, 8],
        factiiiNames: { '7': 'Cooking', '8': 'Travel' }
      }));
    await vault.handle('engagementPush', { deviceId: 'phone', rows: rows(0) }, OWNER);
    await vault.handle(
      'engagementPush',
      { deviceId: 'laptop', rows: rows(1), timeZone: NY, tones: [TONE] },
      OWNER
    );

    const now = NINE + 25 * DAY;
    assert.deepEqual(await vault.runFindings(now), { state: 'computed', computedAt: now });
    // Nothing changed since: nothing is worked out again.
    assert.deepEqual(await vault.runFindings(now), { state: 'unchanged' });

    const read = (await vault.handle('engagementQuery', { kind: 'findings', range: { start: 0, end: 1 } }, OWNER)) as {
      kind: string;
      findings: {
        computedAt: number;
        windowDays: number;
        timeZone: string;
        result: { status: string; activeDays: number; tone: { status: string } };
      };
    };
    assert.equal(read.kind, 'findings');
    assert.equal(read.findings.computedAt, now);
    assert.equal(read.findings.windowDays, 90);
    assert.equal(read.findings.timeZone, NY);
    // Both devices' days count; nothing read had the Tone, and it says so.
    assert.equal(read.findings.result.status, 'ok');
    assert.equal(read.findings.result.activeDays, 20);
    assert.deepEqual(read.findings.result.tone, { status: 'no-tags' });
  });

  it('is the owner’s alone, and never on the relay', async () => {
    // The Vault lets nobody but the owner in (vault.md rule 2).
    await assert.rejects(
      vault.handle('engagementQuery', { kind: 'intervals', range: { start: 0, end: 1 } }, PEER),
      /a Vault is never shared/
    );
    assert.equal(relaySecretsRefusal('socket', 'engagementPush', {}), RELAY_VAULT_REFUSAL);
    assert.equal(relaySecretsRefusal('socket', 'engagementQuery', {}), RELAY_VAULT_REFUSAL);
  });

  it('refuses a malformed row before touching the database', async () => {
    await assert.rejects(
      vault.handle(
        'engagementPush',
        { deviceId: 'phone', rows: [{ ...interval(A, NINE, 1), endedAt: NINE - 1 }] },
        OWNER
      )
    );
  });
});
