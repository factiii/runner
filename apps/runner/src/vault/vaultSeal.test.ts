import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { BoardAgentActionMap, RunnerVaultFile } from '@shared/all/domains/electron';
import type { VouchedScope } from '@shared/all/helpers/board-agent-core/runner-access';
import { isVaultLocked, WRONG_VAULT_KEY } from '@shared/all/validators';

import type { AskEngines } from './ask';
import type { CategorizeEngines } from './categorize';
import { createDaemonVault, type DaemonVault } from './daemonVault';
import type { Embedder } from './embedder';
import { VAULT_ENGINE_PACKAGE } from './engine';

// The encrypted Vault as the daemon holds it (.specs/vault.md "Encryption and
// the Vault key"): a plaintext Vault with files encrypted in place on setup,
// served while unlocked, VAULT_LOCKED while locked, nothing of it in the
// clear on disk, and Runner Storage untouched by any of it.

const OWNER = { role: 'owner' as const, userId: '1', name: 'Owner' };
const MEMBER = { role: 'member' as const, spaceSlugs: [], userId: '3', name: 'M', vault: true };
const runnerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-seal-'));
const ROOT_MODULES = path.resolve(__dirname, '../../../../node_modules');
const vaultRoot = path.join(runnerDir, 'parts', 'vault');

const embedder: Embedder = {
  state: () => 'missing',
  embed: () => Promise.reject(new Error('No embedder.')),
  read: () => Promise.reject(new Error('No embedder.')),
  stop: () => undefined
};
const engines: AskEngines = {
  ollamaModels: async () => [],
  ollamaTakesTools: async () => false,
  clis: async () => [],
  ollama: async () => '',
  cli: async () => ''
};
const categorizeEngines: CategorizeEngines = {
  models: async () => ({ ollama: [], cli: [] }),
  ask: async () => '{}'
};

let daemon: DaemonVault;
const call = <A extends keyof BoardAgentActionMap>(action: A, payload: unknown, scope: VouchedScope = OWNER) =>
  daemon.handle(action, payload, scope) as Promise<BoardAgentActionMap[A]['result']>;

async function add(name: string, body: string, store?: 'vault' | 'runner') {
  const bytes = Buffer.from(body);
  const { ticket } = await call('vaultUploadStart', {
    name,
    size: bytes.length,
    contentType: 'text/plain',
    ...(store ? { store } : {})
  });
  const { file } = await call('vaultWrite', { ticket, offset: 0, content: bytes.toString('base64'), last: true });
  return file as RunnerVaultFile;
}

async function read(uploadId: string): Promise<string> {
  const head = await call('vaultDownload', { uploadId });
  const { content } = await call('vaultRead', { ticket: head.ticket, offset: 0, length: head.size });
  return Buffer.from(content, 'base64').toString();
}

/** Every byte under a folder. */
function bytesUnder(dir: string): Buffer {
  if (!fs.existsSync(dir)) return Buffer.alloc(0);
  return Buffer.concat(
    fs
      .readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name)))
  );
}

const vaultBytesHave = (marker: string) =>
  bytesUnder(path.join(vaultRoot, 'objects')).includes(Buffer.from(marker)) ||
  bytesUnder(path.join(vaultRoot, 'db')).includes(Buffer.from(marker)) ||
  (fs.existsSync(path.join(vaultRoot, 'db.sealed')) &&
    fs.readFileSync(path.join(vaultRoot, 'db.sealed')).includes(Buffer.from(marker)));

/** A light scrypt: the runner's own is 128 MiB a derivation. */
const kdf = { N: 2 ** 10, r: 8, p: 1 };

before(() => {
  const modules = path.join(vaultRoot, 'engine', 'node_modules');
  fs.mkdirSync(path.join(modules, '@electric-sql'), { recursive: true });
  fs.symlinkSync(path.join(ROOT_MODULES, VAULT_ENGINE_PACKAGE), path.join(modules, VAULT_ENGINE_PACKAGE));
  daemon = createDaemonVault(runnerDir, '1', () => undefined, embedder, engines, categorizeEngines, { kdf });
});
after(async () => {
  await daemon.close();
  fs.rmSync(runnerDir, { recursive: true, force: true });
});

describe('the encrypted Vault on the daemon', () => {
  let first: RunnerVaultFile;
  let vaultKey = '';

  it('encrypts a plaintext Vault with files in place', async () => {
    first = await add('notes/plain-before.txt', 'PLAIN-BEFORE-MARKER in a file from before step 4');
    await add('kept.txt', 'RUNNER-STORAGE-MARKER stays plain', 'runner');
    assert.equal((await call('vaultKeyStatus', {})).state, 'plain');
    // Before setup the file is plaintext on disk, as every Vault was.
    assert.equal(vaultBytesHave('PLAIN-BEFORE-MARKER'), true);

    // The key is shown first; nothing is encrypted until it comes back.
    const shown = await call('vaultKeySetupStart', {});
    vaultKey = shown.vaultKey;
    assert.equal((await call('vaultKeyStatus', {})).state, 'plain');
    assert.equal(vaultBytesHave('PLAIN-BEFORE-MARKER'), true);
    await assert.rejects(() => call('vaultKeySetup', { pendingId: shown.pendingId, vaultKey: 'ABCD'.repeat(8) }));
    assert.equal(vaultBytesHave('PLAIN-BEFORE-MARKER'), true);

    const setup = await call('vaultKeySetup', { pendingId: shown.pendingId, vaultKey });
    assert.equal(setup.state, 'unlocked');
    assert.equal(fs.existsSync(path.join(vaultRoot, 'db')), false);
    assert.equal(vaultBytesHave('PLAIN-BEFORE-MARKER'), false);
    assert.equal(vaultBytesHave('plain-before.txt'), false);

    // Everything is still there, read through the key.
    const { files } = await call('vaultFiles', { store: 'vault' });
    assert.deepEqual(files.map((file) => file.name), ['notes/plain-before.txt']);
    assert.match(await read(first.id), /PLAIN-BEFORE-MARKER/);
    // Runner Storage is not the Vault: it stays as it was.
    assert.equal(bytesUnder(path.join(runnerDir, 'parts', 'runner-storage')).includes(Buffer.from('RUNNER-STORAGE-MARKER')), true);
  });

  it('serves nothing but VAULT_LOCKED while locked, and Runner Storage named alone', async () => {
    const later = await add('later.txt', 'SEALED-LATER-MARKER added while encrypted');
    assert.equal(vaultBytesHave('SEALED-LATER-MARKER'), false);
    const locked = await call('vaultLock', {});
    assert.equal(locked.state, 'locked');
    // The lock flushed the dump: nothing of the later file in the clear.
    assert.equal(vaultBytesHave('SEALED-LATER-MARKER'), false);

    for (const [action, payload] of [
      ['vaultFiles', { store: 'vault' }],
      ['vaultFiles', {}],
      ['vaultStatus', {}],
      ['vaultSearch', { query: 'marker' }],
      ['vaultDownload', { uploadId: later.id, store: 'vault' }],
      ['engagementQuery', { kind: 'intervals' }]
    ] as const) {
      await assert.rejects(
        () => daemon.handle(action, payload, OWNER),
        (err: Error) => isVaultLocked(err.message),
        `${action} ${JSON.stringify(payload)}`
      );
    }
    const runner = await call('vaultFiles', { store: 'runner' });
    assert.deepEqual(runner.files.map((file) => file.name), ['kept.txt']);
    // A member gets the same answer; the keys are the owner's alone.
    await assert.rejects(() => daemon.handle('vaultFiles', { store: 'vault' }, MEMBER), (err: Error) =>
      isVaultLocked(err.message)
    );
    await assert.rejects(() => call('vaultKeyStatus', {}, MEMBER), /Only the owner/);
    assert.equal(await daemon.ingest(), null);
  });

  it('unlocks with the Vault key, and serves again', async () => {
    await assert.rejects(() => call('vaultUnlock', { vaultKey: 'ABCD'.repeat(8) }), { message: WRONG_VAULT_KEY });
    assert.equal((await call('vaultKeyStatus', {})).state, 'locked');
    const status = await call('vaultUnlock', { vaultKey });
    assert.equal(status.state, 'unlocked');
    const { files } = await call('vaultFiles', { store: 'vault' });
    assert.deepEqual(files.map((file) => file.name).sort(), ['later.txt', 'notes/plain-before.txt']);
  });

  it('changes the Vault key without touching the data', async () => {
    const shown = await call('vaultKeyChangeStart', {});
    await call('vaultKeyChange', { pendingId: shown.pendingId, vaultKey: shown.vaultKey });
    await call('vaultLock', {});
    await assert.rejects(() => call('vaultUnlock', { vaultKey }), { message: WRONG_VAULT_KEY });
    vaultKey = shown.vaultKey;
    await call('vaultUnlock', { vaultKey });
    assert.match(await read(first.id), /PLAIN-BEFORE-MARKER/);
    // A member cannot change it.
    await assert.rejects(() => call('vaultKeyChangeStart', {}, MEMBER), /Only the owner/);
  });

  it('opens again after a restart from the encrypted dump alone', async () => {
    await daemon.close();
    daemon = createDaemonVault(runnerDir, '1', () => undefined, embedder, engines, categorizeEngines, { kdf });
    await daemon.load();
    assert.equal((await call('vaultKeyStatus', {})).state, 'locked');
    await call('vaultUnlock', { vaultKey });
    const { files } = await call('vaultFiles', { store: 'vault' });
    assert.equal(files.length, 2);
  });
});
