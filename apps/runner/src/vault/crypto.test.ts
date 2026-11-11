import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { normalizeVaultKey } from '@shared/all/validators';

import {
  atomicWrite,
  BLOB_KIND,
  newMasterKey,
  newVaultPassphrase,
  openBlob,
  openSealedFile,
  readSealedRange,
  SEGMENT_BYTES,
  sealBlob,
  sealFile,
  shredPath,
  STREAM_HEADER_BYTES,
  streamPlainSize,
  unwrapVaultKey,
  VAULT_KDF,
  VaultCryptoError,
  wrapVaultKey
} from './crypto';
import { FsObjectStore } from './objectStore';

// The Vault's encryption at rest (.specs/vault.md "Encryption and the
// Vault key"): sealed blobs, sealed files in segments, the master key's wrap
// under a Vault key, and the sealed file store.

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-crypto-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const flip = (bytes: Buffer, at: number) => {
  const copy = Buffer.from(bytes);
  copy[at] = (copy[at] ?? 0) ^ 1;
  return copy;
};

describe('sealed blobs', () => {
  const vk = newMasterKey();
  const plain = Buffer.from('a database dump');

  it('round-trips, and each seal is fresh', () => {
    const a = sealBlob(vk, BLOB_KIND.dump, plain);
    const b = sealBlob(vk, BLOB_KIND.dump, plain);
    assert.notDeepEqual(a, b);
    assert.deepEqual(openBlob(vk, BLOB_KIND.dump, a), plain);
    assert.equal(a.includes(plain), false);
  });

  it('refuses a changed byte anywhere: header, salt, nonce, body, tag', () => {
    const sealed = sealBlob(vk, BLOB_KIND.dump, plain);
    for (const at of [4, 6, 22, 35, sealed.length - 20, sealed.length - 1]) {
      assert.throws(() => openBlob(vk, BLOB_KIND.dump, flip(sealed, at)), VaultCryptoError, `byte ${at}`);
    }
  });

  it('refuses a wrong key and the wrong kind', () => {
    const sealed = sealBlob(vk, BLOB_KIND.dump, plain);
    assert.throws(() => openBlob(newMasterKey(), BLOB_KIND.dump, sealed), VaultCryptoError);
    assert.throws(() => openBlob(vk, BLOB_KIND.meta, sealed), VaultCryptoError);
  });
});

describe('sealed files', () => {
  const vk = newMasterKey();

  for (const size of [0, 1, SEGMENT_BYTES - 1, SEGMENT_BYTES, SEGMENT_BYTES + 1, 3 * SEGMENT_BYTES + 5]) {
    it(`round-trips ${size} bytes, whole and by range`, () => {
      const plain = randomBytes(size);
      const file = path.join(dir, `f${size}`);
      const { size: got, sha256 } = sealFile(vk, file, plain);
      assert.equal(got, size);
      assert.equal(sha256, createHash('sha256').update(plain).digest('hex'));
      assert.equal(streamPlainSize(fs.statSync(file).size), size);
      assert.deepEqual(openSealedFile(vk, file), plain);
      for (const [offset, length] of [
        [0, 10],
        [SEGMENT_BYTES - 3, 7],
        [Math.max(0, size - 4), 100],
        [size + 10, 5]
      ] as const) {
        assert.deepEqual(readSealedRange(vk, file, offset, length), plain.subarray(offset, offset + length));
      }
    });
  }

  it('holds no plaintext on disk', () => {
    const plain = Buffer.from('SECRET-MARKER '.repeat(10_000));
    const file = path.join(dir, 'marker');
    sealFile(vk, file, plain);
    assert.equal(fs.readFileSync(file).includes(Buffer.from('SECRET-MARKER')), false);
  });

  it('refuses a changed byte, a wrong key, swapped segments and a cut tail', () => {
    const plain = randomBytes(3 * SEGMENT_BYTES + 100);
    const file = path.join(dir, 'tamper');
    sealFile(vk, file, plain);
    const sealed = fs.readFileSync(file);
    const sealedSegment = SEGMENT_BYTES + 16;

    fs.writeFileSync(file, flip(sealed, STREAM_HEADER_BYTES + 10));
    assert.throws(() => readSealedRange(vk, file, 0, 10), VaultCryptoError);
    fs.writeFileSync(file, flip(sealed, 10));
    assert.throws(() => readSealedRange(vk, file, 2 * SEGMENT_BYTES, 10), VaultCryptoError);

    fs.writeFileSync(file, sealed);
    assert.throws(() => readSealedRange(newMasterKey(), file, 0, 10), VaultCryptoError);

    // Segments 0 and 1 swapped.
    const swapped = Buffer.concat([
      sealed.subarray(0, STREAM_HEADER_BYTES),
      sealed.subarray(STREAM_HEADER_BYTES + sealedSegment, STREAM_HEADER_BYTES + 2 * sealedSegment),
      sealed.subarray(STREAM_HEADER_BYTES, STREAM_HEADER_BYTES + sealedSegment),
      sealed.subarray(STREAM_HEADER_BYTES + 2 * sealedSegment)
    ]);
    fs.writeFileSync(file, swapped);
    assert.throws(() => readSealedRange(vk, file, 0, 10), VaultCryptoError);

    // Cut at a segment boundary: the new last segment was not sealed as last.
    fs.writeFileSync(file, sealed.subarray(0, STREAM_HEADER_BYTES + 2 * sealedSegment));
    assert.throws(() => openSealedFile(vk, file), VaultCryptoError);
  });
});

describe('the Vault key and its wrap', () => {
  const LIGHT = { N: 2 ** 10, r: 8, p: 1 };

  it('unwraps only with its Vault key and its own Vault', async () => {
    const vk = newMasterKey();
    const key = normalizeVaultKey(newVaultPassphrase()) ?? '';
    const slot = await wrapVaultKey(vk, key, 'vault A', LIGHT);
    assert.deepEqual(await unwrapVaultKey(slot, key, 'vault A'), vk);
    const other = normalizeVaultKey(newVaultPassphrase()) ?? '';
    await assert.rejects(() => unwrapVaultKey(slot, other, 'vault A'), VaultCryptoError);
    await assert.rejects(() => unwrapVaultKey(slot, key, 'vault B'), VaultCryptoError);
    // A fresh salt and nonce every wrap: the same key wraps differently.
    const again = await wrapVaultKey(vk, key, 'vault A', LIGHT);
    assert.notEqual(again.kdf.salt, slot.kdf.salt);
    assert.notEqual(again.wrapped, slot.wrapped);
  });

  it('derives with scrypt at 2^17, 8, 1 by default, and stores the cost', async () => {
    assert.deepEqual(VAULT_KDF, { N: 2 ** 17, r: 8, p: 1 });
    const vk = newMasterKey();
    const key = normalizeVaultKey(newVaultPassphrase()) ?? '';
    const slot = await wrapVaultKey(vk, key, 'vault A');
    assert.equal(slot.kdf.name, 'scrypt');
    assert.equal(slot.kdf.N, 2 ** 17);
    assert.equal(Buffer.from(slot.kdf.salt, 'base64').length, 16);
    assert.deepEqual(await unwrapVaultKey(slot, key, 'vault A'), vk);
  });

  it('is 8 groups of 4 from the unambiguous alphabet', () => {
    const key = newVaultPassphrase();
    assert.match(key, /^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
    assert.notEqual(newVaultPassphrase(), key);
  });
});

describe('writing to disk', () => {
  it('writes atomically and shreds plaintext', () => {
    const file = path.join(dir, 'atomic.json');
    atomicWrite(file, '{"a":1}');
    atomicWrite(file, '{"a":2}');
    assert.equal(fs.readFileSync(file, 'utf-8'), '{"a":2}');
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')),
      []
    );
    const folder = path.join(dir, 'plain');
    fs.mkdirSync(path.join(folder, 'deep'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'deep', 'x'), 'plaintext');
    shredPath(folder);
    assert.equal(fs.existsSync(folder), false);
  });
});

describe('the sealed file store', () => {
  let key: Buffer | null = newMasterKey();
  const sealKey = () => {
    if (!key) throw new Error('locked');
    return key;
  };
  const root = path.join(dir, 'objects');
  const store = new FsObjectStore(root, Date.now, undefined, sealKey);

  it('puts, gets, ranges, heads and lists with nothing in the clear', async () => {
    const body = Buffer.from('VAULT-FILE-BODY '.repeat(9000));
    const head = await store.put('vault/1/u/notes/secret-name.txt', body, 'text/plain');
    assert.equal(head.size, body.length);
    assert.deepEqual(Buffer.from(await store.get('vault/1/u/notes/secret-name.txt')), body);
    assert.deepEqual(
      Buffer.from(await store.getRange('vault/1/u/notes/secret-name.txt', 70_000, 20)),
      body.subarray(70_000, 70_020)
    );
    assert.equal((await store.list('vault/1/'))[0]?.key, 'vault/1/u/notes/secret-name.txt');
    for (const name of fs.readdirSync(root)) {
      const bytes = fs.readFileSync(path.join(root, name));
      assert.equal(bytes.includes(Buffer.from('VAULT-FILE-BODY')), false, name);
      assert.equal(bytes.includes(Buffer.from('secret-name')), false, name);
      assert.equal(bytes.includes(Buffer.from('text/plain')), false, name);
    }
  });

  it('seals a signed upload as its ranges arrive', async () => {
    const body = randomBytes(SEGMENT_BYTES * 2 + 77);
    const { url } = await store.presignPut('vault/1/u/up.bin', 'application/octet-stream', body.length, 1e9);
    const cut = SEGMENT_BYTES + 3;
    assert.equal(store.writeSigned(url, 0, body.subarray(0, cut), false).head, null);
    const part = fs.readdirSync(root).find((name) => name.endsWith('.part'));
    assert.ok(part);
    assert.equal(fs.readFileSync(path.join(root, part)).includes(body.subarray(0, 64)), false);
    assert.throws(() => store.writeSigned(url, 5, body.subarray(cut), true), /lost its place/);
    store.writeSigned(url, 0, body.subarray(0, cut), false);
    const done = store.writeSigned(url, cut, body.subarray(cut), true);
    assert.equal(done.head?.size, body.length);
    assert.equal(done.head?.sha256, createHash('sha256').update(body).digest('hex'));
    assert.deepEqual(Buffer.from(await store.get('vault/1/u/up.bin')), body);
  });

  it('refuses a tampered sidecar and answers nothing while locked', async () => {
    const key0 = 'vault/1/u/notes/secret-name.txt';
    const file = path.join(root, `${createHash('sha256').update(key0).digest('hex')}.json`);
    const sidecar = fs.readFileSync(file);
    fs.writeFileSync(file, flip(sidecar, sidecar.length - 3));
    await assert.rejects(() => store.head(key0), VaultCryptoError);
    // A list leaves it out rather than serve it.
    assert.deepEqual((await store.list('vault/1/')).map((o) => o.key), ['vault/1/u/up.bin']);
    fs.writeFileSync(file, sidecar);
    key = null;
    await assert.rejects(() => store.get(key0), /locked/);
    await assert.rejects(() => store.list('vault/'), /locked/);
  });
});
