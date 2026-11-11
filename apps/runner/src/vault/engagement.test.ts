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
import { FsObjectStore } from './objectStore';
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
    await vault.handle('vaultShareSet', { memberId: '2', shared: true }, OWNER);
  });
  after(async () => {
    await db.close();
  });

  const A = '0190a000-0000-7000-8000-000000000001';
  const B = '0190a000-0000-7000-8000-000000000002';
  const MOOD = '0190a000-0000-7000-8000-000000000003';

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
    await vault.handle(
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
            savedAt: NINE + 60 * MINUTE,
            updatedAt: NINE + 60 * MINUTE
          },
          interval(B, NINE + 60 * MINUTE, 2, 'post-2'),
          { kind: 'mood', id: MOOD, mood: 'happy', timestamp: NINE + 70 * MINUTE, updatedAt: NINE + 70 * MINUTE }
        ]
      },
      OWNER
    );
    const { intervals, moods } = (await vault.handle(
      'engagementQuery',
      { kind: 'intervals', range: { start: NINE - MINUTE, end: NINE + 120 * MINUTE } },
      OWNER
    )) as { intervals: { id: string; endedAt: number }[]; moods: { mood: string }[] };
    assert.deepEqual(
      intervals.map((row) => [row.id, row.endedAt]),
      [
        [A, NINE + 3 * MINUTE],
        [B, NINE + 62 * MINUTE]
      ]
    );
    assert.deepEqual(moods.map((m) => m.mood), ['happy']);
  });

  it('answers history and day totals across devices', async () => {
    const range = { start: NINE - 60 * MINUTE, end: NINE + 600 * MINUTE };
    const history = (await vault.handle('engagementQuery', { kind: 'history', range }, OWNER)) as {
      items: { postId: string; duration: number; snapshot: { content: string } | null }[];
    };
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
    assert.deepEqual(daily.totals, [
      { dayKey: '2026-11-03', factiiiId: 7, factiiiName: 'Cooking', duration: 300, viewedAt: NINE + 62 * MINUTE }
    ]);
  });

  it('is the owner’s alone, and never on the relay', async () => {
    await assert.rejects(
      vault.handle('engagementQuery', { kind: 'intervals', range: { start: 0, end: 1 } }, PEER),
      /Only the owner/
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
