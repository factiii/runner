import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { relaySecretsRefusal, RELAY_VAULT_REFUSAL } from '@shared/all/helpers/board-agent-core/runner-access';
import { isVaultLocked, VAULT_KEY_PENDING_MS, VAULT_LOCKED, WRONG_VAULT_KEY } from '@shared/all/validators';

import { SLOT_KEYRING } from './keyring';
import { ALREADY_SEALED, KEY_NOT_SAVED, NO_PENDING_KEY, type VaultKeysOptions, VaultKeys } from './vaultKeys';

// The Vault's key as the runner holds it (.specs/vault.md "Encryption and
// the Vault key"): setup in two steps (a new Vault key shown, then sent back
// before anything is sealed), unlock and lock, the idle lock, changing the
// key, and a key file from the slot build refused.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-keys-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A light scrypt: the runner's own is 128 MiB a derivation. */
const LIGHT = { N: 2 ** 10, r: 8, p: 1 };

function keysAt(name: string, extra: Partial<VaultKeysOptions> = {}) {
  const root = path.join(tmp, name);
  const locks: number[] = [];
  const keys = new VaultKeys({
    root,
    onLock: async () => {
      locks.push(Date.now());
    },
    seal: { before: async () => undefined, dumpPlain: async () => null, verifyDump: async () => undefined },
    kdf: LIGHT,
    log: () => undefined,
    ...extra
  });
  return { keys, root, locks };
}

/** Setup as the app runs it: the key shown, then filled back. */
async function setUp(keys: VaultKeys): Promise<string> {
  const shown = keys.setupStart();
  await keys.setup({ pendingId: shown.pendingId, vaultKey: shown.vaultKey });
  return shown.vaultKey;
}

describe('setup asks for the Vault key back before it seals', () => {
  it('shows a new key, changes nothing on disk, and seals only with that key sent back', async () => {
    const { keys, root } = keysAt('setup');
    assert.equal(keys.state(), 'plain');
    assert.throws(() => keys.key(), (err: Error) => isVaultLocked(err.message));
    const shown = keys.setupStart();
    assert.match(shown.vaultKey, /^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
    // Shown, not yet saved: nothing is written, and the Vault stays plain.
    assert.equal(fs.existsSync(path.join(root, 'keys.json')), false);
    assert.equal(keys.state(), 'plain');

    await assert.rejects(() => keys.setup({ pendingId: shown.pendingId, vaultKey: 'ABCD-'.repeat(7) + 'ABCD' }), {
      message: KEY_NOT_SAVED
    });
    await assert.rejects(
      () => keys.setup({ pendingId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', vaultKey: shown.vaultKey }),
      { message: NO_PENDING_KEY }
    );
    assert.equal(keys.state(), 'plain');

    // Filled back by the password manager, or typed in any case.
    const status = await keys.setup({ pendingId: shown.pendingId, vaultKey: shown.vaultKey.toLowerCase() });
    assert.equal(status.state, 'unlocked');
    assert.ok(status.vaultId);
    assert.ok(status.keySetAt);
    assert.equal(status.problem, null);
    // Nothing secret on disk: not the Vault key, not the master key.
    const onDisk = fs.readFileSync(path.join(root, 'keys.json'), 'utf-8');
    assert.equal(onDisk.includes(shown.vaultKey), false);
    assert.equal(onDisk.includes(shown.vaultKey.replace(/-/g, '')), false);
    assert.equal(onDisk.includes(keys.key().toString('base64')), false);
    assert.throws(() => keys.setupStart(), { message: ALREADY_SEALED });
    // The shown key was used: it does not set up again.
    await assert.rejects(() => keys.setup(shown), { message: ALREADY_SEALED });
  });

  it('keeps the key waiting when sealing fails, so the same saved key can be tried again', async () => {
    let fail = true;
    const { keys } = keysAt('setup-retry', {
      seal: {
        before: async () => {
          if (fail) throw new Error('disk full');
        },
        dumpPlain: async () => null,
        verifyDump: async () => undefined
      }
    });
    const shown = keys.setupStart();
    await assert.rejects(() => keys.setup(shown), /disk full/);
    assert.equal(keys.state(), 'plain');
    fail = false;
    assert.equal((await keys.setup(shown)).state, 'unlocked');
  });

  it('lets a shown key expire', async () => {
    let now = 1_000_000;
    const { keys } = keysAt('setup-expired', { now: () => now });
    const shown = keys.setupStart();
    now += VAULT_KEY_PENDING_MS + 1;
    await assert.rejects(() => keys.setup(shown), { message: NO_PENDING_KEY });
  });
});

describe('unlock and lock', () => {
  it('refuses a wrong key and opens with the right one, however it is typed', async () => {
    const { keys } = keysAt('unlock');
    const vaultKey = await setUp(keys);
    const vk = Buffer.from(keys.key());
    await keys.lock();
    assert.equal(keys.state(), 'locked');
    assert.throws(() => keys.key(), new RegExp(VAULT_LOCKED.slice(0, 20)));

    await assert.rejects(() => keys.unlock({ vaultKey: 'ABCD-'.repeat(7) + 'ABCD' }), { message: WRONG_VAULT_KEY });
    await assert.rejects(() => keys.unlock({ vaultKey: 'not a key at all, far too long to be one' }), {
      message: WRONG_VAULT_KEY
    });
    assert.equal(keys.state(), 'locked');

    const unlocked = await keys.unlock({ vaultKey: ` ${vaultKey.toLowerCase().replace(/-/g, ' ')} ` });
    assert.equal(unlocked.state, 'unlocked');
    assert.deepEqual(keys.key(), vk);

    // A runner restarted: locked, the same key opens it.
    const again = keysAt('unlock').keys;
    assert.equal(again.state(), 'locked');
    await again.unlock({ vaultKey });
    assert.deepEqual(again.key(), vk);
  });

  it('locks after its idle time with no activity, flushing first', async () => {
    const { keys, locks } = keysAt('idle', { idleMs: 80 });
    await setUp(keys);
    await new Promise((resolve) => setTimeout(resolve, 50));
    keys.touch();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(keys.state(), 'unlocked');
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(keys.state(), 'locked');
    assert.equal(locks.length, 1);
  });

  it('stays unlocked when the flush before a lock fails', async () => {
    const { keys } = keysAt('failed-flush', {
      onLock: async () => {
        throw new Error('disk full');
      }
    });
    await setUp(keys);
    await assert.rejects(() => keys.lock(), /disk full/);
    assert.equal(keys.state(), 'unlocked');
  });

  it('keeps the idle setting', async () => {
    const { keys } = keysAt('settings');
    await setUp(keys);
    assert.equal(keys.status().lockIdleMinutes, 15);
    assert.equal(keys.settings(5).lockIdleMinutes, 5);
    assert.equal(keysAt('settings').keys.status().lockIdleMinutes, 5);
  });
});

describe('changing the Vault key', () => {
  it('re-wraps the master key: the old key fails, the new one opens the same Vault', async () => {
    const { keys, root } = keysAt('change');
    const oldKey = await setUp(keys);
    const vk = Buffer.from(keys.key());
    const before = JSON.parse(fs.readFileSync(path.join(root, 'keys.json'), 'utf-8')) as { vaultId: string };

    const shown = await keys.changeStart({});
    assert.notEqual(shown.vaultKey, oldKey);
    // Not confirmed yet: the old key still opens it.
    await assert.rejects(() => keys.change({ pendingId: shown.pendingId, vaultKey: oldKey }), { message: KEY_NOT_SAVED });
    await keys.lock();
    await keys.unlock({ vaultKey: oldKey });

    const status = await keys.change(shown);
    assert.equal(status.state, 'unlocked');
    assert.equal(status.vaultId, before.vaultId);
    await keys.lock();
    await assert.rejects(() => keys.unlock({ vaultKey: oldKey }), { message: WRONG_VAULT_KEY });
    await keys.unlock({ vaultKey: shown.vaultKey });
    // The same master key: nothing was re-encrypted, all of it still opens.
    assert.deepEqual(keys.key(), vk);
    // And after a restart.
    const again = keysAt('change').keys;
    await assert.rejects(() => again.unlock({ vaultKey: oldKey }), { message: WRONG_VAULT_KEY });
    await again.unlock({ vaultKey: shown.vaultKey });
    assert.deepEqual(again.key(), vk);
  });

  it('needs the current key while locked, and that unlocks', async () => {
    const { keys } = keysAt('change-locked');
    const oldKey = await setUp(keys);
    await keys.lock();
    await assert.rejects(() => keys.changeStart({}), (err: Error) => isVaultLocked(err.message));
    await assert.rejects(() => keys.changeStart({ vaultKey: 'ABCD-'.repeat(7) + 'ABCD' }), { message: WRONG_VAULT_KEY });
    const shown = await keys.changeStart({ vaultKey: oldKey });
    assert.equal(keys.state(), 'unlocked');
    await keys.change(shown);
    // A confirmed key is used up.
    await assert.rejects(() => keys.change(shown), { message: NO_PENDING_KEY });
  });
});

describe('a key file from the slot build', () => {
  it('is refused with a clear message, and the Vault stays sealed', async () => {
    const root = path.join(tmp, 'slots');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, 'keys.json'),
      JSON.stringify({ v: 1, vaultId: 'x', createdAt: '', lockIdleMinutes: 15, slots: [] })
    );
    const { keys } = keysAt('slots');
    assert.equal(keys.sealed(), true);
    assert.equal(keys.state(), 'locked');
    assert.equal(keys.status().problem, SLOT_KEYRING);
    assert.throws(() => keys.key(), { message: SLOT_KEYRING });
    await assert.rejects(() => keys.unlock({ vaultKey: 'ABCD-'.repeat(7) + 'ABCD' }), { message: SLOT_KEYRING });
    assert.throws(() => keys.setupStart(), { message: SLOT_KEYRING });
  });
});

describe('the relay', () => {
  it('never carries a key action', () => {
    for (const action of [
      'vaultKeyStatus',
      'vaultKeySetupStart',
      'vaultKeySetup',
      'vaultUnlock',
      'vaultLock',
      'vaultKeySettings',
      'vaultKeyChangeStart',
      'vaultKeyChange'
    ] as const) {
      assert.equal(relaySecretsRefusal('socket', action, {}), RELAY_VAULT_REFUSAL, action);
      assert.equal(relaySecretsRefusal('webrtc', action, {}), null, action);
    }
  });
});
