import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { AuditLog } from '@shared/all/helpers/board-agent-core/audit';
import { exportSecretsBackup, openSecretsBackup } from '@shared/all/helpers/board-agent-core/secrets-backup';

import { createOpsStore } from './store';

// The Secrets tab's store ops (store.ts) on a real store: sops and age, as
// host-secrets.test.ts. Skipped where they are not installed.

const has = (bin: string) => spawnSync('which', [bin]).status === 0;
const withBinaries = has('sops') && has('age') && has('age-keygen');

const PASSWORD = 'correct-horse-battery';
const PASSPHRASE = 'backup-passphrase-1';
const actor = { by: { userId: 'owner', name: 'Owner' }, via: 'data-channel' as const };

describe('ops store: the Secrets tab over the ops user', { skip: !withBinaries }, () => {
  let root = '';
  let spaceDir = '';
  let opsHome = '';
  const store = () =>
    createOpsStore({
      slug: 'alpha',
      opsHome,
      spaceDir,
      audit: { append: async () => undefined } as unknown as AuditLog,
      lockWindow: () => undefined
    });

  /** The board's value of `key`, read the way only a test may: a backup made
   *  and opened here. */
  const valueOf = async (key: string) => {
    const bundle = await exportSecretsBackup({ spaceDir, board: 'alpha', password: PASSWORD, passphrase: PASSPHRASE });
    return openSecretsBackup({ bundle, passphrase: PASSPHRASE }).secrets.find((s) => s.name === key)?.value;
  };

  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ops-store-'));
    spaceDir = path.join(root, 'spaces', 'alpha');
    opsHome = path.join(root, 'ops');
    await fs.mkdir(path.join(spaceDir, 'secrets'), { recursive: true });
  });
  after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('creates the store, lists names, and answers a wrong password with a refusal', async () => {
    const s = store();
    assert.deepEqual(await s.status(), { initialized: false });
    assert.deepEqual(await s.init({ ...actor, password: PASSWORD }), { success: true });
    assert.deepEqual(await s.status(), { initialized: true });
    await s.set({ ...actor, password: PASSWORD, key: 'API_KEY', value: 'one' });
    await s.setMeta({ key: 'API_KEY', patch: { title: 'API key' } });
    const listed = await s.list({ ...actor, password: PASSWORD });
    assert.deepEqual(listed.keys, ['API_KEY']);
    assert.equal(listed.meta.API_KEY?.title, 'API key');
    await assert.rejects(s.list({ ...actor, password: 'wrong-password' }));
  });

  it('plans and imports a backup by name, never saying whether two values are equal', async () => {
    const s = store();
    const { file } = await s.backupExport({ ...actor, password: PASSWORD, passphrase: PASSPHRASE });
    const bundle = await fs.readFile(path.join(opsHome, 'backups', file), 'utf-8');
    await s.set({ ...actor, password: PASSWORD, key: 'API_KEY', value: 'two' });

    const plan = await s.backupPlan({ ...actor, bundle, passphrase: PASSPHRASE, targetPassword: PASSWORD });
    assert.deepEqual(plan.secrets, [{ name: 'API_KEY', exists: true }]);

    const req = { ...actor, bundle, passphrase: PASSPHRASE, targetPassword: PASSWORD };
    // No choice made: the board's value is kept.
    const kept = await s.backupImport({ ...req, picks: { secrets: [{ name: 'API_KEY' }], files: [] } });
    assert.deepEqual(kept.secrets, []);
    assert.equal(await valueOf('API_KEY'), 'two');
    // Take: the backup's value.
    const taken = await s.backupImport({ ...req, picks: { secrets: [{ name: 'API_KEY', conflict: 'take' }], files: [] } });
    assert.deepEqual(taken.secrets, ['API_KEY']);
    assert.equal(await valueOf('API_KEY'), 'one');
    // Take again, now equal: the same answer as when they differed.
    const again = await s.backupImport({ ...req, picks: { secrets: [{ name: 'API_KEY', conflict: 'take' }], files: [] } });
    assert.deepEqual(again.secrets, ['API_KEY']);
    // The panel's "Import every secret in it": no picks, the backup's values.
    await s.set({ ...actor, password: PASSWORD, key: 'API_KEY', value: 'three' });
    const every = await s.backupImport(req);
    assert.deepEqual(every.secrets, ['API_KEY']);
    assert.equal(await valueOf('API_KEY'), 'one');
  });

  it("names an env file's keys with no tail", async () => {
    const s = store();
    const env = Buffer.from('DATABASE_URL=postgres://secret-value\nPORT=5432\n').toString('base64');
    await s.setFile({ ...actor, password: PASSWORD, name: 'PROD_ENV', contentBase64: env });
    const keys = await s.fileEnvKeys({ ...actor, password: PASSWORD, name: 'PROD_ENV' });
    assert.deepEqual(keys, [
      { name: 'DATABASE_URL', editable: true },
      { name: 'PORT', editable: true }
    ]);
    const set = await s.fileEnvSet({ ...actor, password: PASSWORD, name: 'PROD_ENV', key: 'PORT', value: '6543' });
    assert.equal(set.occurrences, 1);
    assert.ok(set.keys.every((k) => !('masked' in k)));
  });
});
