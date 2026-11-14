import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { BLOB_KIND, openBlob, openSealedFile } from './crypto';
import {
  type KeyLookup,
  RUNNER_CLOUD_KEY_MISSING,
  RunnerCloudSeal,
  type RunnerKeyStore
} from './runnerCloudSeal';
import { SealCrash, type SealStep } from './sealMigration';

// Runner Cloud's key (.specs/runner-vault.md "Runner Cloud encryption"): made
// once, never replaced while one exists that cannot be read, and the move of a
// plaintext Runner Cloud to sealed safe at every step. Every store here is a
// fake; where the runner really keeps the key (a 0600 file, or the Keychain on
// a Mac) is tested beside it (apps/runner/src/vault/runnerCloudKey.test.ts).

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-cloud-key-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const DUMP = Buffer.from('PLAIN-CLOUD-DUMP and the rest of a database');
const BODY = Buffer.from('PLAIN-CLOUD-FILE, shared with a friend');

/** A store standing in for the Keychain: answers what it is told to. */
function fakeStore(where: RunnerKeyStore['where'] = 'keychain') {
  let held: Buffer | null = null;
  let broken = false;
  const store: RunnerKeyStore = {
    where,
    read: (): KeyLookup => {
      if (broken) return { state: 'error', why: 'locked' };
      return held
        ? { state: 'found', key: Buffer.from(held) }
        : { state: 'missing' };
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

/** A Runner Cloud from before encryption: a database folder and one file. */
function plainCloud(name: string) {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, 'db', 'base'), { recursive: true });
  fs.writeFileSync(path.join(root, 'db', 'base', 'page'), DUMP);
  fs.mkdirSync(path.join(root, 'objects'), { recursive: true });
  const object = createHash('sha256').update('vault/1/u/a.txt').digest('hex');
  fs.writeFileSync(path.join(root, 'objects', object), BODY);
  fs.writeFileSync(
    path.join(root, 'objects', `${object}.json`),
    JSON.stringify({
      key: 'vault/1/u/a.txt',
      size: BODY.length,
      contentType: 'text/plain',
      sha256: createHash('sha256').update(BODY).digest('hex')
    })
  );
  return { root, object };
}

const sealOptions = (at?: (step: SealStep) => void) => ({
  dumpPlain: async () => new Uint8Array(DUMP),
  verifyDump: async (plain: Buffer) => {
    assert.ok(plain.equals(DUMP));
  },
  at
});

const quiet = () => undefined;

describe('Runner Cloud’s key', () => {
  it('is made once for a new Runner Cloud, in the first store that keeps it', () => {
    const keychain = fakeStore();
    const seal = new RunnerCloudSeal({
      root: path.join(tmp, 'new'),
      stores: [keychain.store],
      log: quiet
    });
    assert.equal(seal.sealed(), false);
    seal.create();
    assert.equal(seal.sealed(), true);
    const key = seal.key();
    assert.ok(keychain.held()?.equals(key));
    // The key file says where the key is, and never holds it.
    const record = fs.readFileSync(seal.paths.keys, 'utf-8');
    assert.match(record, /"keyIn": "keychain"/);
    assert.ok(!record.includes(key.toString('base64')));
    assert.ok(!record.includes(key.toString('hex')));
    // Made again later: the same key.
    seal.create();
    const again = new RunnerCloudSeal({
      root: path.join(tmp, 'new'),
      stores: [keychain.store],
      log: quiet
    });
    assert.ok(again.key().equals(key));
  });

  it('falls back to the file when the Keychain will not answer, and never writes over it', () => {
    const keychain = fakeStore();
    keychain.breakIt(true);
    const file = fakeStore('file').store;
    const seal = new RunnerCloudSeal({
      root: path.join(tmp, 'fallback', 'cloud'),
      stores: [keychain.store, file],
      log: quiet
    });
    seal.create();
    assert.equal(keychain.held(), null);
    assert.match(fs.readFileSync(seal.paths.keys, 'utf-8'), /"keyIn": "file"/);
    // The Keychain answers again: the file it was made in still opens it.
    keychain.breakIt(false);
    const later = new RunnerCloudSeal({
      root: path.join(tmp, 'fallback', 'cloud'),
      stores: [keychain.store, file],
      log: quiet
    });
    assert.ok(later.key().equals(seal.key()));
  });

  it('refuses a key it cannot read or that is another one, and makes none in its place', () => {
    const keychain = fakeStore();
    const root = path.join(tmp, 'refuse');
    new RunnerCloudSeal({
      root,
      stores: [keychain.store],
      log: quiet
    }).create();
    const made = keychain.held();
    keychain.breakIt(true);
    assert.throws(
      () =>
        new RunnerCloudSeal({
          root,
          stores: [keychain.store],
          log: quiet
        }).key(),
      (err: Error) => err.message.startsWith(RUNNER_CLOUD_KEY_MISSING)
    );
    keychain.breakIt(false);
    keychain.store.write(Buffer.alloc(32, 1));
    assert.throws(
      () =>
        new RunnerCloudSeal({
          root,
          stores: [keychain.store],
          log: quiet
        }).key(),
      /another one/
    );
    assert.ok(made);
  });

  it('says so when it has nowhere to keep a key', () => {
    const keychain = fakeStore();
    keychain.breakIt(true);
    const seal = new RunnerCloudSeal({
      root: path.join(tmp, 'nowhere'),
      stores: [keychain.store],
      log: quiet
    });
    assert.throws(() => seal.create(), /nowhere to keep Runner Cloud’s key/);
    assert.equal(seal.sealed(), false);
  });
});

describe('a key an older runner kept in the Keychain', () => {
  /** A Runner Cloud whose key file says the Keychain holds its key. */
  function keychainCloud(name: string) {
    const keychain = fakeStore('keychain');
    const root = path.join(tmp, name);
    new RunnerCloudSeal({
      root,
      stores: [keychain.store],
      log: quiet
    }).create();
    return { root, keychain, key: Buffer.from(keychain.held() as Buffer) };
  }

  it('still opens from the Keychain until it is moved, and is moved to the file once', () => {
    const { root, keychain, key } = keychainCloud('move-ok');
    const file = fakeStore('file');
    const seal = new RunnerCloudSeal({
      root,
      stores: [file.store],
      legacy: [keychain.store],
      log: quiet
    });
    assert.ok(seal.key().equals(key));
    assert.equal(seal.moveKey(keychain.store, file.store), 'moved');
    assert.ok(file.held()?.equals(key));
    // The Keychain's copy goes only after the file holds it and the key
    // file points there.
    assert.equal(keychain.held(), null);
    assert.match(fs.readFileSync(seal.paths.keys, 'utf-8'), /"keyIn": "file"/);
    // The next start opens it from the file alone, and moves nothing.
    const later = new RunnerCloudSeal({
      root,
      stores: [file.store],
      log: quiet
    });
    assert.ok(later.key().equals(key));
    assert.equal(later.moveKey(keychain.store, file.store), 'none');
  });

  it('leaves the key in the Keychain when the file cannot take it, to try again', () => {
    const { root, keychain, key } = keychainCloud('move-fails');
    const file = fakeStore('file');
    file.breakIt(true);
    const seal = new RunnerCloudSeal({
      root,
      stores: [file.store],
      legacy: [keychain.store],
      log: quiet
    });
    const moved = seal.moveKey(keychain.store, file.store);
    assert.ok(typeof moved === 'object' && moved.failed.length > 0);
    assert.ok(keychain.held()?.equals(key));
    assert.match(
      fs.readFileSync(seal.paths.keys, 'utf-8'),
      /"keyIn": "keychain"/
    );
    assert.ok(seal.key().equals(key));
    file.breakIt(false);
    assert.equal(seal.moveKey(keychain.store, file.store), 'moved');
  });

  it('never moves a key that is another one, or writes over another key in the file', () => {
    const { root, keychain } = keychainCloud('move-wrong');
    const file = fakeStore('file');
    const seal = new RunnerCloudSeal({
      root,
      stores: [file.store],
      legacy: [keychain.store],
      log: quiet
    });
    file.store.write(Buffer.alloc(32, 9));
    const moved = seal.moveKey(keychain.store, file.store);
    assert.ok(typeof moved === 'object');
    assert.ok(file.held()?.equals(Buffer.alloc(32, 9)));
    assert.ok(keychain.held() !== null);
    keychain.store.write(Buffer.alloc(32, 3));
    assert.ok(
      typeof seal.moveKey(keychain.store, fakeStore('file').store) === 'object'
    );
    assert.match(
      fs.readFileSync(seal.paths.keys, 'utf-8'),
      /"keyIn": "keychain"/
    );
  });
});

describe('a Runner Cloud from before encryption', () => {
  it('is encrypted in place: nothing in the clear, everything opens under the key', async () => {
    const { root, object } = plainCloud('migrate');
    const keychain = fakeStore();
    const seal = new RunnerCloudSeal({
      root,
      stores: [keychain.store],
      log: quiet
    });
    assert.equal(seal.plain(), true);
    await seal.seal(sealOptions());
    assert.equal(seal.plain(), false);
    assert.equal(seal.sealed(), true);
    assert.equal(fs.existsSync(path.join(root, 'db')), false);
    assert.equal(fs.existsSync(path.join(root, 'objects.plain')), false);
    const key = seal.key();
    assert.ok(
      openBlob(key, BLOB_KIND.dump, fs.readFileSync(seal.paths.dump)).equals(
        DUMP
      )
    );
    assert.ok(
      openSealedFile(key, path.join(root, 'objects', object)).equals(BODY)
    );
    assert.ok(
      !fs.readFileSync(path.join(root, 'objects', object)).includes(BODY)
    );
  });

  it('keeps the plaintext as it was when cut short before the commit, then finishes with the same key', async () => {
    for (const step of [
      'journal',
      'keys',
      'dump',
      'objects',
      'verify'
    ] as SealStep[]) {
      const { root, object } = plainCloud(`crash-${step}`);
      const keychain = fakeStore();
      const seal = new RunnerCloudSeal({
        root,
        stores: [keychain.store],
        log: quiet
      });
      await assert.rejects(
        seal.seal(
          sealOptions((at) => {
            if (at === step) throw new SealCrash(step);
          })
        )
      );
      const made = keychain.held();
      // The next start rolls it back: the plaintext untouched.
      const next = new RunnerCloudSeal({
        root,
        stores: [keychain.store],
        log: quiet
      });
      next.recover();
      assert.equal(next.plain(), true, step);
      assert.ok(
        fs.readFileSync(path.join(root, 'objects', object)).equals(BODY),
        step
      );
      assert.ok(
        fs.readFileSync(path.join(root, 'db', 'base', 'page')).equals(DUMP),
        step
      );
      // And seals with the key it had already made.
      await next.seal(sealOptions());
      assert.ok(made && next.key().equals(made), step);
      assert.ok(
        openSealedFile(next.key(), path.join(root, 'objects', object)).equals(
          BODY
        ),
        step
      );
    }
  });

  it('finishes at the next start when cut short after the commit', async () => {
    for (const step of [
      'commit',
      'dump-in-place',
      'objects-aside',
      'objects-in-place',
      'keys-in-place',
      'shred'
    ] as SealStep[]) {
      const { root, object } = plainCloud(`forward-${step}`);
      const keychain = fakeStore();
      const seal = new RunnerCloudSeal({
        root,
        stores: [keychain.store],
        log: quiet
      });
      await assert.rejects(
        seal.seal(
          sealOptions((at) => {
            if (at === step) throw new SealCrash(step);
          })
        )
      );
      const next = new RunnerCloudSeal({
        root,
        stores: [keychain.store],
        log: quiet
      });
      next.recover();
      assert.equal(next.sealed(), true, step);
      assert.equal(next.plain(), false, step);
      assert.equal(fs.existsSync(path.join(root, 'db')), false, step);
      assert.ok(
        openSealedFile(next.key(), path.join(root, 'objects', object)).equals(
          BODY
        ),
        step
      );
    }
  });
});
