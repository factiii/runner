import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { FsObjectStore } from '@shared/vault-core/objectStore';

import { openVaultDb, type VaultDb } from './db';
import { readPrivateValue } from './privateTags';
import { RunnerVault } from './service';

// Private tags (.specs/analytics.md "Private tags"): the owner's own
// dimensions, tagged by this runner's Ollama over the posts read, kept in the
// Vault only.

const OWNER = { role: 'owner' as const, userId: '1', name: 'Owner' };
const ENGINE = path.resolve(__dirname, '../..');
const NINE = Date.UTC(2026, 10, 3, 14);
const DIMENSION = '0190a000-0000-7000-8000-0000000000d1';

const snapshot = (postId: string, content: string, savedAt: number) => ({
  kind: 'snapshot' as const,
  postId,
  slug: null,
  content,
  authorUsername: null,
  authorName: null,
  anonymous: false,
  factiiiNames: {},
  postCreatedAt: null,
  savedAt,
  updatedAt: savedAt
});

const dimension = (values: string[], updatedAt: number, deleted = false) => ({
  kind: 'privateDimension' as const,
  id: DIMENSION,
  name: 'Useful',
  values,
  deleted,
  updatedAt
});

type Read = {
  kind: 'privateTags';
  dimensions: { name: string; counts: Record<string, number>; waiting: number }[];
  problem: string | null;
};

describe('private tags in the Vault', () => {
  let db: VaultDb;
  let vault: RunnerVault;
  const asked: string[] = [];
  const model = {
    models: async () => ['llama3.2'],
    ask: async (_model: string, system: string, prompt: string) => {
      asked.push(prompt);
      assert.match(system, /"Useful"/);
      return prompt.includes('recipe') ? '{"value":"yes"}' : 'not json';
    }
  };
  const read = async () =>
    (await vault.handle('engagementQuery', { kind: 'privateTags', range: { start: 0, end: 1 } }, OWNER)) as Read;

  before(async () => {
    db = await openVaultDb({ dataDir: 'memory://', engineDir: ENGINE });
    const store = new FsObjectStore(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-vault-private-')));
    vault = new RunnerVault(db, store, '1', () => {}, null, null, null);
    await vault.handle(
      'engagementPush',
      {
        deviceId: 'phone',
        rows: [
          snapshot('post-1', 'A recipe for bread', NINE),
          snapshot('post-2', 'Hot take', NINE + 1),
          dimension(['Yes', 'No'], NINE + 2)
        ]
      },
      OWNER
    );
  });
  after(async () => {
    await db.close();
  });

  it('tags each read post once with a listed value, on the local model', async () => {
    assert.equal(await vault.runPrivateTags(model), 1);
    // Asked about both; the next run asks about neither again.
    assert.equal(asked.length, 2);
    await vault.runPrivateTags(model);
    assert.equal(asked.length, 2);
    const answer = await read();
    assert.deepEqual(answer.dimensions, [
      { id: DIMENSION, name: 'Useful', values: ['Yes', 'No'], counts: { Yes: 1, No: 0 }, waiting: 0 }
    ]);
    assert.equal(answer.problem, null);
  });

  it('asks again when the values change, and forgets a deleted dimension', async () => {
    await vault.handle('engagementPush', { deviceId: 'phone', rows: [dimension(['Yes', 'No', 'Maybe'], NINE + 3)] }, OWNER);
    assert.equal((await read()).dimensions[0].waiting, 2);
    await vault.handle('engagementPush', { deviceId: 'phone', rows: [dimension(['Yes', 'No'], NINE + 4, true)] }, OWNER);
    assert.deepEqual((await read()).dimensions, []);
  });

  it('says so when the runner has no local model', async () => {
    await vault.handle('engagementPush', { deviceId: 'phone', rows: [dimension(['Yes', 'No'], NINE + 5)] }, OWNER);
    await vault.runPrivateTags({ models: async () => [], ask: model.ask });
    assert.match((await read()).problem ?? '', /no Ollama model/);
  });
});

describe('readPrivateValue', () => {
  it('takes only a listed value, in any case', () => {
    assert.equal(readPrivateValue('{"value":" YES "}', ['Yes', 'No']), 'Yes');
    assert.equal(readPrivateValue('{"value":"perhaps"}', ['Yes', 'No']), null);
    assert.equal(readPrivateValue('yes', ['Yes', 'No']), null);
  });
});
