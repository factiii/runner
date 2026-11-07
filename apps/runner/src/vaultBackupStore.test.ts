import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  runVaultBackupAction,
  VAULT_BACKUP_ACTIONS,
  VaultBackupStore
} from './vaultBackupStore';

// The owner's vault backups on disk: a package is whole or absent, never
// named by the client, capped in total, and only the newest few are kept.

const T = 1_791_812_708_182;
const UPLOAD = '3f2b8c1e-9a4d-4e7f-b1c2-0d9e8f7a6b5c';
const OTHER_UPLOAD = '7a6b5c4d-0000-4e7f-b1c2-0d9e8f7a6b5c';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'runner-vault-'));
const b64 = (text: string) => Buffer.from(text).toString('base64');
const stored = (dir: string) =>
  fs.existsSync(path.join(dir, 'vault-backups'))
    ? fs.readdirSync(path.join(dir, 'vault-backups')).sort()
    : [];

/** A store on a clock the test moves. */
const storeAt = (dir: string, limits = {}) => {
  const clock = { now: T };
  return { clock, store: new VaultBackupStore(dir, limits, () => clock.now) };
};

/** Push `text` in one call. */
const push = (store: VaultBackupStore, text: string, uploadId = UPLOAD) =>
  store.write({
    uploadId,
    offset: 0,
    content: b64(text),
    last: true,
    size: Buffer.byteLength(text)
  });

describe('vault backups on the runner', () => {
  it('holds nothing, and creates nothing, before the first package', () => {
    const dir = tmp();
    const { store } = storeAt(dir);
    assert.deepEqual(store.list(), []);
    assert.equal(fs.existsSync(path.join(dir, 'vault-backups')), false);
  });

  it('assembles chunks and names the package itself', () => {
    const dir = tmp();
    const { store } = storeAt(dir);
    assert.deepEqual(
      store.write({ uploadId: UPLOAD, offset: 0, content: b64('hello ') }),
      { name: null, received: 6 }
    );
    // Not a backup until the last chunk lands.
    assert.deepEqual(store.list(), []);
    const done = store.write({
      uploadId: UPLOAD,
      offset: 6,
      content: b64('world'),
      last: true,
      size: 11
    });
    assert.deepEqual(done, {
      name: 'vault-backup-1791812708182.zip',
      received: 11
    });
    assert.deepEqual(stored(dir), ['vault-backup-1791812708182.zip']);
    const [item] = store.list();
    assert.equal(item?.name, done.name);
    assert.equal(item?.size, 11);
    assert.equal(
      fs.readFileSync(path.join(dir, 'vault-backups', done.name!), 'utf-8'),
      'hello world'
    );
  });

  it('keeps the folder and the package to the runner user', () => {
    if (process.platform === 'win32') return;
    const dir = tmp();
    const { store } = storeAt(dir);
    const { name } = push(store, 'x');
    const mode = (file: string) => fs.statSync(file).mode & 0o777;
    assert.equal(mode(path.join(dir, 'vault-backups')), 0o700);
    assert.equal(mode(path.join(dir, 'vault-backups', name!)), 0o600);
  });

  it('refuses an upload id that is a path, before touching the disk', () => {
    const dir = tmp();
    const { store } = storeAt(dir);
    for (const uploadId of ['../../escape', 'a/b/c/d/e/f', '', '.hidden-one']) {
      assert.throws(
        () => store.write({ uploadId, offset: 0, content: b64('x') }),
        /upload id/
      );
    }
    assert.equal(fs.existsSync(path.join(dir, 'vault-backups')), false);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it('refuses a chunk that is not base64', () => {
    const { store } = storeAt(tmp());
    for (const content of ['', 'not base64!', 'aGVs bG8=']) {
      assert.throws(
        () => store.write({ uploadId: UPLOAD, offset: 0, content }),
        /chunk/
      );
    }
  });

  it('drops an upload whose chunks add up past the cap', () => {
    const dir = tmp();
    const { store } = storeAt(dir, { maxBytes: 8 });
    store.write({ uploadId: UPLOAD, offset: 0, content: b64('12345') });
    assert.throws(
      () =>
        store.write({ uploadId: UPLOAD, offset: 5, content: b64('6789') }),
      /larger than/
    );
    // The temp file went with the refusal.
    assert.deepEqual(stored(dir), []);
    // Exactly the cap is fine.
    assert.equal(push(store, '12345678').received, 8);
  });

  it('drops an upload that is out of step with what the runner holds', () => {
    const dir = tmp();
    const { store } = storeAt(dir);
    store.write({ uploadId: UPLOAD, offset: 0, content: b64('12345') });
    assert.throws(
      () => store.write({ uploadId: UPLOAD, offset: 9, content: b64('x') }),
      /out of step/
    );
    assert.deepEqual(stored(dir), []);
    // And a chunk for an upload that was never started.
    assert.throws(
      () => store.write({ uploadId: OTHER_UPLOAD, offset: 5, content: b64('x') }),
      /out of step/
    );
  });

  it('drops an upload whose total is not what the client declared', () => {
    const dir = tmp();
    const { store } = storeAt(dir);
    assert.throws(
      () =>
        store.write({
          uploadId: UPLOAD,
          offset: 0,
          content: b64('12345'),
          last: true,
          size: 6
        }),
      /different amount/
    );
    assert.throws(
      () =>
        store.write({
          uploadId: UPLOAD,
          offset: 0,
          content: b64('12345'),
          last: true
        }),
      /different amount/
    );
    assert.deepEqual(stored(dir), []);
  });

  it('starts an upload over when its first chunk is sent again', () => {
    const dir = tmp();
    const { store } = storeAt(dir);
    store.write({ uploadId: UPLOAD, offset: 0, content: b64('stale-') });
    const { name } = push(store, 'fresh');
    assert.equal(
      fs.readFileSync(path.join(dir, 'vault-backups', name!), 'utf-8'),
      'fresh'
    );
  });

  it('keeps the newest three and lists them newest first', () => {
    const dir = tmp();
    const { store, clock } = storeAt(dir);
    const names: string[] = [];
    for (let i = 0; i < 5; i++) {
      clock.now = T + i * 1000;
      names.push(push(store, `package ${i}`).name!);
    }
    assert.deepEqual(
      store.list().map((b) => b.name),
      [names[4], names[3], names[2]]
    );
    assert.deepEqual(stored(dir), [names[2], names[3], names[4]]);
  });

  it('does not let a failed upload cost an older package', () => {
    const dir = tmp();
    const { store, clock } = storeAt(dir, { maxBytes: 8, keep: 1 });
    const { name } = push(store, 'kept');
    clock.now = T + 1000;
    assert.throws(() => push(store, 'far too large'), /larger than/);
    assert.deepEqual(stored(dir), [name]);
  });

  it('gives two packages in one millisecond different names', () => {
    const { store } = storeAt(tmp());
    const first = push(store, 'a').name;
    const second = push(store, 'b', OTHER_UPLOAD).name;
    assert.notEqual(first, second);
    assert.equal(store.list().length, 2);
  });

  it('clears an abandoned upload when the next one starts', () => {
    const dir = tmp();
    const { store, clock } = storeAt(dir, { staleUploadMs: 1000 });
    store.write({ uploadId: OTHER_UPLOAD, offset: 0, content: b64('half') });
    const part = path.join(dir, 'vault-backups', `${OTHER_UPLOAD}.part`);
    // The file's mtime is the real clock; move the store's past it.
    clock.now = fs.statSync(part).mtimeMs + 5000;
    push(store, 'whole');
    assert.equal(fs.existsSync(part), false);
  });

  it('reads a package back a range at a time', () => {
    const { store } = storeAt(tmp());
    const { name } = push(store, 'hello world');
    const read = (offset: number, length: number) =>
      Buffer.from(
        store.readChunk({ name: name!, offset, length }).content,
        'base64'
      ).toString();
    assert.equal(read(0, 5), 'hello');
    assert.equal(read(6, 5), 'world');
    // Past the end is short, not an error.
    assert.equal(read(6, 500), 'world');
    assert.equal(read(11, 5), '');
  });

  it('refuses a read of anything but a package it named', () => {
    const dir = tmp();
    const { store } = storeAt(dir);
    push(store, 'x');
    fs.writeFileSync(path.join(dir, 'access.json'), '{}');
    for (const name of [
      '../access.json',
      'access.json',
      '/etc/passwd',
      `${UPLOAD}.part`,
      'vault-backup-1791812708182.zip/../../access.json'
    ]) {
      assert.throws(
        () => store.readChunk({ name, offset: 0, length: 10 }),
        /Invalid vault backup name/
      );
    }
    assert.throws(
      () =>
        store.readChunk({
          name: 'vault-backup-0000000000001.zip',
          offset: 0,
          length: 10
        }),
      /No such vault backup/
    );
  });

  it('refuses a range that is too long or malformed', () => {
    const { store } = storeAt(tmp());
    const name = push(store, 'x').name!;
    assert.throws(
      () => store.readChunk({ name, offset: 0, length: 512 * 1024 + 1 }),
      /chunk length/
    );
    assert.throws(
      () => store.readChunk({ name, offset: 0, length: 0 }),
      /chunk length/
    );
    assert.throws(
      () => store.readChunk({ name, offset: -1, length: 1 }),
      /offset/
    );
  });

  it('does not follow a symlink left under a backup name', () => {
    if (process.platform === 'win32') return;
    const dir = tmp();
    const { store } = storeAt(dir);
    push(store, 'x');
    fs.writeFileSync(path.join(dir, 'config.json'), 'secret');
    const link = 'vault-backup-1791812709999.zip';
    fs.symlinkSync(
      path.join(dir, 'config.json'),
      path.join(dir, 'vault-backups', link)
    );
    assert.equal(
      store.list().some((b) => b.name === link),
      false
    );
    assert.throws(
      () => store.readChunk({ name: link, offset: 0, length: 10 }),
      /No such vault backup/
    );
  });

  it('deletes a package by name, and nothing else', () => {
    const dir = tmp();
    const { store } = storeAt(dir);
    const { name } = push(store, 'x');
    fs.writeFileSync(path.join(dir, 'access.json'), '{}');
    assert.throws(
      () => store.remove({ name: '../access.json' }),
      /Invalid vault backup name/
    );
    assert.equal(fs.existsSync(path.join(dir, 'access.json')), true);
    store.remove({ name: name! });
    assert.deepEqual(store.list(), []);
    // Deleting what is already gone is not an error.
    store.remove({ name: name! });
  });

  it('answers each action through the daemon entry point', () => {
    const { store } = storeAt(tmp());
    assert.deepEqual([...VAULT_BACKUP_ACTIONS].sort(), [
      'vaultBackupDelete',
      'vaultBackupList',
      'vaultBackupReadChunk',
      'vaultBackupWrite'
    ]);
    const written = runVaultBackupAction(store, 'vaultBackupWrite', {
      uploadId: UPLOAD,
      offset: 0,
      content: b64('abc'),
      last: true,
      size: 3
    }) as { name: string };
    const listed = runVaultBackupAction(store, 'vaultBackupList', {}) as {
      backups: { name: string }[];
    };
    assert.deepEqual(
      listed.backups.map((b) => b.name),
      [written.name]
    );
    runVaultBackupAction(store, 'vaultBackupDelete', { name: written.name });
    assert.deepEqual(runVaultBackupAction(store, 'vaultBackupList', {}), {
      backups: []
    });
    // A null payload is a refusal, not a crash.
    assert.throws(
      () => runVaultBackupAction(store, 'vaultBackupWrite', null),
      /upload id/
    );
    assert.throws(
      () => runVaultBackupAction(store, 'getConfig', null),
      /Unhandled/
    );
  });
});
