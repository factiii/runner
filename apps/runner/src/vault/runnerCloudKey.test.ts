import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { CONFIG_DIR } from '../paths';

import { type KeyLookup, RunnerCloudSeal, type RunnerKeyStore } from '@shared/vault-core/runnerCloudSeal';
import {
  defaultRunnerKeyStores,
  fileKeyStore,
  legacyRunnerKeyStores,
  moveKeychainKeyToFile,
  RUNNER_CLOUD_KEY_FILE
} from './runnerCloudKey';

// Where Runner Cloud's key is kept (.specs/runner-vault.md "Runner Cloud
// encryption"): a 0600 file on every OS; a key an older runner kept in the
// Keychain on a Mac is moved to the file once. Making, checking and sealing
// with it are vault-core's, tested there
// (shared/vault-core/runnerCloudSeal.test.ts). No test here touches a real
// Keychain: the Keychain's store is a fake, and the legacy stores for any
// folder but the runner's own, or off a Mac, are none.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-cloud-key-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A store standing in for the Keychain: answers what it is told to. */
function fakeStore(where: RunnerKeyStore['where'] = 'keychain') {
  let held: Buffer | null = null;
  let broken = false;
  const store: RunnerKeyStore = {
    where,
    read: (): KeyLookup => {
      if (broken) return { state: 'error', why: 'locked' };
      return held ? { state: 'found', key: Buffer.from(held) } : { state: 'missing' };
    },
    write: (key) => {
      if (broken) throw new Error('locked');
      held = Buffer.from(key);
    },
    remove: () => {
      held = null;
    }
  };
  return {
    store,
    held: () => held,
    breakIt: (value: boolean) => {
      broken = value;
    }
  };
}

const quiet = () => undefined;

describe('where Runner Cloud’s key is kept', () => {
  it('keeps it in a 0600 file, and tells a missing file from a bad one', () => {
    const file = path.join(tmp, 'keyfile', RUNNER_CLOUD_KEY_FILE);
    const store = fileKeyStore(file);
    assert.deepEqual(store.read(), { state: 'missing' });
    const key = Buffer.alloc(32, 7);
    store.write(key);
    const back = store.read();
    assert.equal(back.state, 'found');
    assert.ok(back.state === 'found' && back.key.equals(key));
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.writeFileSync(file, 'short');
    assert.equal(store.read().state, 'error');
  });

  it('keeps it in the file alone, on every OS', () => {
    assert.deepEqual(defaultRunnerKeyStores(tmp).map((s) => s.where), ['file']);
    assert.deepEqual(defaultRunnerKeyStores(CONFIG_DIR).map((s) => s.where), ['file']);
  });

  it('reads an older runner’s Keychain only for the runner’s own dir on a Mac', () => {
    assert.deepEqual(legacyRunnerKeyStores(tmp, 'darwin'), []);
    assert.deepEqual(legacyRunnerKeyStores(CONFIG_DIR, 'linux'), []);
    assert.deepEqual(legacyRunnerKeyStores(CONFIG_DIR, 'win32'), []);
    assert.deepEqual(legacyRunnerKeyStores(CONFIG_DIR, 'darwin').map((s) => s.where), ['keychain']);
  });
});

describe('a key an older runner kept in the Keychain', () => {
  it('moves to the real 0600 file once, and the Keychain item is deleted after', () => {
    const keychain = fakeStore();
    const root = path.join(tmp, 'moved', 'cloud');
    new RunnerCloudSeal({ root, stores: [keychain.store], log: quiet }).create();
    const key = Buffer.from(keychain.held() as Buffer);
    const stores = [fileKeyStore(path.join(tmp, 'moved', RUNNER_CLOUD_KEY_FILE))];
    const seal = new RunnerCloudSeal({ root, stores, legacy: [keychain.store], log: quiet });
    assert.equal(moveKeychainKeyToFile(seal, stores, [keychain.store]), 'moved');
    assert.equal(keychain.held(), null);
    const onDisk = stores[0].read();
    assert.ok(onDisk.state === 'found' && onDisk.key.equals(key));
    // The next start: the file alone opens it, nothing to move.
    const later = new RunnerCloudSeal({ root, stores, log: quiet });
    assert.ok(later.key().equals(key));
    assert.equal(moveKeychainKeyToFile(later, stores, []), 'none');
  });
});

describe('Runner Cloud’s key in the runner’s stores', () => {
  it('falls back to the file when the Keychain will not answer, and never writes over it', () => {
    const keychain = fakeStore();
    keychain.breakIt(true);
    const file = fileKeyStore(path.join(tmp, 'fallback', RUNNER_CLOUD_KEY_FILE));
    const seal = new RunnerCloudSeal({ root: path.join(tmp, 'fallback', 'cloud'), stores: [keychain.store, file], log: quiet });
    seal.create();
    assert.equal(keychain.held(), null);
    assert.match(fs.readFileSync(seal.paths.keys, 'utf-8'), /"keyIn": "file"/);
    // The Keychain answers again: the file it was made in still opens it.
    keychain.breakIt(false);
    const later = new RunnerCloudSeal({ root: path.join(tmp, 'fallback', 'cloud'), stores: [keychain.store, file], log: quiet });
    assert.ok(later.key().equals(seal.key()));
  });
});
