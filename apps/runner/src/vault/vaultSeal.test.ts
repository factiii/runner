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
import { openVaultDb } from './db';
import type { Embedder } from './embedder';
import { VAULT_ENGINE_PACKAGE } from './engine';
import { openSealedVaultDb } from '@shared/vault-core/sealedDb';
import { sealPaths } from '@shared/vault-core/sealMigration';

// The encrypted Vault as the daemon holds it (.specs/vault.md "Encryption and
// the Vault key"): a plaintext Vault with files encrypted in place on setup,
// served while unlocked, VAULT_LOCKED while locked, nothing of it in the
// clear on disk, and Runner Cloud untouched by any of it.

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
    await add('kept.txt', 'RUNNER-STORAGE-MARKER sealed under the runner key', 'runner');
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
    // Runner Cloud is not the Vault: sealed from its first file under the
    // runner's own key, not the Vault key, and untouched by the setup.
    assert.equal(bytesUnder(path.join(runnerDir, 'parts', 'runner-storage')).includes(Buffer.from('RUNNER-STORAGE-MARKER')), false);
    assert.equal(fs.existsSync(path.join(runnerDir, 'parts', 'runner-storage', 'keys.json')), true);
    const kept = (await call('vaultFiles', { store: 'runner' })).files[0];
    assert.ok(kept);
    assert.match(await read(kept.id), /RUNNER-STORAGE-MARKER/);
  });

  it('serves nothing but VAULT_LOCKED while locked, and Runner Cloud named alone', async () => {
    const later = await add('later.txt', 'SEALED-LATER-MARKER added while encrypted');
    assert.equal(vaultBytesHave('SEALED-LATER-MARKER'), false);
    const locking = call('vaultLock', {});
    // A call while the lock writes the last dump is refused, never served
    // from a second decrypted copy opened beside the one being saved.
    await assert.rejects(
      () => call('vaultFiles', { store: 'vault' }),
      (err: Error) => isVaultLocked(err.message)
    );
    const locked = await locking;
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
    // A Runner Cloud file by id, its store named, opens and deletes while
    // locked; with none named the Vault is asked first, and answers locked.
    const keptId = runner.files[0]!.id;
    await assert.rejects(() => call('vaultDownload', { uploadId: keptId }), (err: Error) => isVaultLocked(err.message));
    const head = await call('vaultDownload', { uploadId: keptId, store: 'runner' });
    assert.match(head.ticket, /^runner-storage:/);
    const scratch = (await call('vaultFiles', { store: 'runner' })).files.length;
    const extra = await add('scratch.txt', 'deleted while locked', 'runner');
    assert.deepEqual(await call('vaultDelete', { uploadIds: [extra.id], store: 'runner' }), { deleted: 1, kept: 0 });
    assert.equal((await call('vaultFiles', { store: 'runner' })).files.length, scratch);
    // Who is let in is Runner Cloud's: the owner lets someone in and out
    // while locked, and is answered with Runner Cloud's status, not refused.
    const letIn = await call('vaultShareSet', { memberId: '3', shared: true });
    assert.deepEqual(letIn.members, ['3']);
    assert.deepEqual(letIn.runnerStorage, { files: 1, bytes: letIn.bytes });
    assert.deepEqual((await call('vaultShareSet', { memberId: '3', shared: false })).members, []);
    // A member never reaches the Vault, locked or not (vault.md rule 2);
    // the keys are the owner's alone.
    await assert.rejects(() => daemon.handle('vaultFiles', { store: 'vault' }, MEMBER), /a Vault is never shared/);
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

  it('erases a locked Vault whose key is lost, and keeps Runner Cloud', async () => {
    await call('vaultLock', {});
    // The owner's alone, and only with the word typed.
    await assert.rejects(() => call('vaultErase', { confirm: 'ERASE' }, MEMBER), /Only the owner/);
    await assert.rejects(() => call('vaultErase', { confirm: 'erase' }));
    assert.equal((await call('vaultKeyStatus', {})).state, 'locked');

    const erased = await call('vaultErase', { confirm: 'ERASE' });
    assert.equal(erased.state, 'plain');
    assert.equal(erased.vaultId, null);
    assert.equal(fs.existsSync(path.join(vaultRoot, 'keys.json')), false);
    assert.equal(fs.existsSync(path.join(vaultRoot, 'db.sealed')), false);
    assert.equal(fs.existsSync(path.join(vaultRoot, 'objects')), false);
    // An empty Vault, open, ready to be set up again.
    assert.deepEqual((await call('vaultFiles', { store: 'vault' })).files, []);
    assert.ok((await call('vaultKeySetupStart', {})).vaultKey);
    // Runner Cloud is another folder with its own key: all there.
    assert.equal(fs.existsSync(path.join(runnerDir, 'parts', 'runner-storage', 'keys.json')), true);
    const { files } = await call('vaultFiles', { store: 'runner' });
    assert.deepEqual(files.map((file) => file.name), ['kept.txt']);
    assert.match(await read(files[0]!.id), /RUNNER-STORAGE-MARKER/);
    // Nothing left to forget on a Vault with no key.
    await assert.rejects(() => call('vaultErase', { confirm: 'ERASE' }), /not encrypted yet/);
  });
});

describe('who was let in, moved out of a Vault locked at start', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-seal-shares-'));
  const root = path.join(dir, 'parts', 'vault');
  const engineDir = path.join(root, 'engine');
  let owned: DaemonVault;
  let vaultKey = '';
  const handle = <A extends keyof BoardAgentActionMap>(action: A, payload: unknown) =>
    owned.handle(action, payload, OWNER) as Promise<BoardAgentActionMap[A]['result']>;

  /** The sealed Vault's database, opened with a copy of the master key. */
  const openVault = (vk: Buffer) =>
    openSealedVaultDb({
      open: (load) => openVaultDb({ dataDir: 'memory://', engineDir, load }),
      dumpPath: sealPaths(root).dump,
      key: () => vk
    });

  before(async () => {
    const modules = path.join(engineDir, 'node_modules');
    fs.mkdirSync(path.join(modules, '@electric-sql'), { recursive: true });
    fs.symlinkSync(path.join(ROOT_MODULES, VAULT_ENGINE_PACKAGE), path.join(modules, VAULT_ENGINE_PACKAGE));
    owned = createDaemonVault(dir, '1', () => undefined, embedder, engines, categorizeEngines, { kdf });
    const shown = await handle('vaultKeySetupStart', {});
    vaultKey = shown.vaultKey;
    await handle('vaultKeySetup', { pendingId: shown.pendingId, vaultKey });
    const vk = Buffer.from(owned.keys.key());
    await owned.close();
    // A runner from before: member 3 let in, in the Vault's own table and
    // its cache.
    const db = await openVault(vk);
    await db.batch([
      {
        sql: `INSERT INTO "VaultShare" ("ownerId", "memberId", "status", "acceptedAt")
              VALUES (1, 3, 'ACCEPTED', CURRENT_TIMESTAMP)`
      }
    ]);
    await db.close();
    fs.writeFileSync(path.join(root, 'members.json'), JSON.stringify(['3']));
  });
  after(async () => {
    await owned.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lets nobody back in from the Vault at its unlock', async () => {
    owned = createDaemonVault(dir, '1', () => undefined, embedder, engines, categorizeEngines, { kdf });
    await owned.load();
    assert.equal((await handle('vaultKeyStatus', {})).state, 'locked');
    // The cache moved at start, the Vault's table waiting for the unlock.
    assert.deepEqual(owned.members(), ['3']);
    assert.equal(fs.existsSync(path.join(root, 'members.json')), false);
    await handle('vaultShareSet', { memberId: '3', shared: false });
    assert.deepEqual(owned.members(), []);

    await handle('vaultUnlock', { vaultKey });
    // The move after an unlock runs in the background, once the Vault's
    // database is open: a Vault read waits for the same start.
    await handle('vaultStatus', { store: 'vault' });
    for (let i = 0; i < 50 && owned.members().length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(owned.members(), []);
    assert.deepEqual((await handle('vaultStatus', {})).members, []);
    // The Vault's table was emptied all the same.
    const vk = Buffer.from(owned.keys.key());
    await owned.close();
    const db = await openVault(vk);
    try {
      assert.deepEqual(await db.query('SELECT * FROM "VaultShare"'), []);
    } finally {
      await db.close();
    }
  });
});

/** The idle lock in this test: the store's opens are well inside it. */
const IDLE_LOCK_MS = 5_000;

describe('the idle lock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-seal-idle-'));
  const engineDir = path.join(dir, 'parts', 'vault', 'engine');
  let idle: DaemonVault;
  const handle = <A extends keyof BoardAgentActionMap>(action: A, payload: unknown, scope: VouchedScope = OWNER) =>
    idle.handle(action, payload, scope) as Promise<BoardAgentActionMap[A]['result']>;

  before(() => {
    const modules = path.join(engineDir, 'node_modules');
    fs.mkdirSync(path.join(modules, '@electric-sql'), { recursive: true });
    fs.symlinkSync(path.join(ROOT_MODULES, VAULT_ENGINE_PACKAGE), path.join(modules, VAULT_ENGINE_PACKAGE));
    // Longer than the database takes to open, so no lock lands mid-start:
    // on GitHub's two-core runner an open takes over 2 s, and 2 s here had
    // the idle lock land in the unlock (vaultKeys.ts lock).
    idle = createDaemonVault(dir, '1', () => undefined, embedder, engines, categorizeEngines, {
      kdf,
      lockIdleMs: IDLE_LOCK_MS
    });
  });
  after(async () => {
    await idle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('counts the calls that reach the Vault, never Runner Cloud’s or a member’s', async () => {
    const shown = await handle('vaultKeySetupStart', {});
    await handle('vaultKeySetup', { pendingId: shown.pendingId, vaultKey: shown.vaultKey });
    const bytes = Buffer.from('in Runner Cloud');
    const { ticket } = await handle('vaultUploadStart', {
      name: 'shared.txt',
      size: bytes.length,
      contentType: 'text/plain',
      store: 'runner'
    });
    await handle('vaultWrite', { ticket, offset: 0, content: bytes.toString('base64'), last: true });
    await handle('vaultShareSet', { memberId: '3', shared: true });
    // The idle time from a fresh unlock, the Vault's database open.
    await handle('vaultLock', {});
    await handle('vaultUnlock', { vaultKey: shown.vaultKey });
    await handle('vaultStatus', { store: 'vault' });
    assert.equal(idle.keys.state(), 'unlocked');
    // Runner Cloud asked over and over, past the idle time: the Vault locks.
    const until = Date.now() + 3 * IDLE_LOCK_MS;
    while (Date.now() < until && idle.keys.state() === 'unlocked') {
      await handle('vaultFiles', {}, MEMBER);
      await handle('vaultFiles', { store: 'runner' });
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(idle.keys.state(), 'locked');
  });
});
