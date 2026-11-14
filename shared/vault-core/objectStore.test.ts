import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { FsObjectStore } from './objectStore';

// The Vault's file store: R2's verbs on disk, keys never naming a path, and
// signed tickets that are the only way a device writes or reads an object.

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'runner-vault-store-'));
const bytes = (text: string) => new Uint8Array(Buffer.from(text));
const text = (b: Uint8Array) => Buffer.from(b).toString();

const storeAt = (dir = tmp()) => {
  const clock = { now: 1_800_000_000_000 };
  return { dir, clock, store: new FsObjectStore(dir, () => clock.now) };
};

describe('FsObjectStore', () => {
  it('puts, heads, gets, ranges, lists and deletes', async () => {
    const { store } = storeAt();
    const head = await store.put('vault/1/a/notes.txt', bytes('hello vault'), 'text/plain');
    assert.equal(head.size, 11);
    assert.equal(head.contentType, 'text/plain');
    assert.match(head.sha256, /^[0-9a-f]{64}$/);
    assert.equal(text(await store.get('vault/1/a/notes.txt')), 'hello vault');
    assert.equal(text(await store.getRange('vault/1/a/notes.txt', 6, 100)), 'vault');
    await store.put('vault/2/b/other.txt', bytes('x'), 'text/plain');
    assert.deepEqual(
      (await store.list('vault/1/')).map((o) => o.key),
      ['vault/1/a/notes.txt']
    );
    assert.equal(await store.delete('vault/1/a/notes.txt'), true);
    assert.equal(await store.head('vault/1/a/notes.txt'), null);
    await assert.rejects(store.get('vault/1/a/notes.txt'), /not found/);
    // A missing key is not a failure.
    assert.equal(await store.delete('vault/9/none'), true);
  });

  it('never lets a key name a path', async () => {
    const { dir, store } = storeAt();
    await store.put('../../escape.txt', bytes('x'), 'text/plain');
    assert.equal(fs.existsSync(path.join(dir, '..', '..', 'escape.txt')), false);
    assert.ok(fs.readdirSync(dir).every((name) => /^[0-9a-f]{64}(\.json)?$/.test(name)));
  });

  it('writes through a put ticket only when the ranges add up', async () => {
    const { store } = storeAt();
    const { url, method } = await store.presignPut('vault/1/j/f.txt', 'text/plain', 6, 100);
    assert.equal(method, 'PUT');
    assert.ok(url.startsWith('runner-vault:put?'));
    const first = store.writeSigned(url, 0, bytes('abc'), false);
    assert.deepEqual([first.received, first.head], [3, null]);
    // Nothing is stored until the last range.
    assert.equal(await store.head('vault/1/j/f.txt'), null);
    const done = store.writeSigned(url, 3, bytes('def'), true);
    assert.equal(done.head?.size, 6);
    assert.equal(text(await store.get('vault/1/j/f.txt')), 'abcdef');
  });

  it('refuses a write that lost its place, runs long, or ends short', async () => {
    const { store } = storeAt();
    const { url } = await store.presignPut('vault/1/j/g.txt', 'text/plain', 4, 100);
    store.writeSigned(url, 0, bytes('ab'), false);
    assert.throws(() => store.writeSigned(url, 1, bytes('cd'), false), /lost its place/);
    store.writeSigned(url, 0, bytes('ab'), false);
    assert.throws(() => store.writeSigned(url, 2, bytes('cde'), false), /bigger/);
    store.writeSigned(url, 0, bytes('ab'), false);
    assert.throws(() => store.writeSigned(url, 2, bytes('c'), true), /smaller/);
    assert.equal(await store.head('vault/1/j/g.txt'), null);
  });

  it('refuses a forged, expired or wrong-way ticket', async () => {
    const { store, clock } = storeAt();
    await assert.rejects(store.presignPut('k', 'text/plain', 200, 100), /exceeds/);
    const { url } = await store.presignPut('vault/1/j/h.txt', 'text/plain', 1, 100);
    const forged = url.replace('n=1', 'n=9');
    assert.throws(() => store.writeSigned(forged, 0, bytes('x'), true), /not valid/);
    // Another runner process (another key) does not take it either.
    const other = new FsObjectStore(tmp());
    assert.throws(() => other.writeSigned(url, 0, bytes('x'), true), /not valid/);
    await assert.rejects(store.readSigned(url, 0, 1), /not for reading/);
    store.writeSigned(url, 0, bytes('x'), true);
    const get = await store.presignGet('vault/1/j/h.txt', 60, 'h.txt');
    assert.equal(text((await store.readSigned(get, 0, 10)).bytes), 'x');
    assert.throws(() => store.writeSigned(get, 0, bytes('y'), true), /not for writing/);
    clock.now += 61_000;
    await assert.rejects(store.readSigned(get, 0, 10), /expired/);
    const late = await store.presignPut('vault/1/j/i.txt', 'text/plain', 1, 100, 1);
    clock.now += 2000;
    assert.throws(() => store.writeSigned(late.url, 0, bytes('x'), true), /expired/);
  });
});
