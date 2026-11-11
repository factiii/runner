import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, scrypt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { formatVaultKey, VAULT_KEY_ALPHABET, VAULT_KEY_CHARS } from '@shared/all/validators';

// The Vault's encryption at rest (.specs/vault.md "Encryption and the Vault
// key"). Node's own AES-256-GCM, HKDF-SHA256, scrypt and random bytes: no
// primitive is written here, only how they are put together.
//
// - The master key (VK): 32 random bytes per Vault, in memory only while the
//   Vault is unlocked, on disk only wrapped under the owner's Vault key. Each use derives its own key from it with HKDF and a
//   random salt, so no two blobs or files share a GCM key, and nonce reuse
//   across them cannot happen.
// - A sealed blob (the database dump, a file's sidecar): one AES-256-GCM
//   message under a versioned header that is also its associated data.
// - A sealed file: the STREAM construction (as age and Tink use it): the
//   plaintext in 64 KiB segments, each its own GCM message whose nonce is a
//   random per-file prefix, the segment's index and a last-segment flag, all
//   under the header as associated data. A range is read by opening only the
//   segments it covers; cutting, reordering or swapping segments, or
//   dropping the tail, fails the tag.

export const VAULT_KEY_BYTES = 32;
const GCM_NONCE = 12;
const GCM_TAG = 16;
const SALT = 16;

export class VaultCryptoError extends Error {
  constructor(message = 'This Vault data does not open with this key: the key is wrong, or the data was changed.') {
    super(message);
    this.name = 'VaultCryptoError';
  }
}

export const newMasterKey = (): Buffer => randomBytes(VAULT_KEY_BYTES);

export function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string, bytes = 32): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, bytes));
}

/** Overwrite a key buffer in place, so a dropped key leaves no copy behind
 *  in this buffer (the GC may hold others; .specs/vault.md "Honest limits"). */
export function wipe(buffer: Buffer | null | undefined): void {
  buffer?.fill(0);
}

function gcmSeal(key: Buffer, nonce: Buffer, plain: Uint8Array, aad: Buffer): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

function gcmOpen(key: Buffer, nonce: Buffer, sealed: Buffer, aad: Buffer): Buffer {
  if (sealed.length < GCM_TAG) throw new VaultCryptoError();
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.subarray(sealed.length - GCM_TAG));
  try {
    return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - GCM_TAG)), decipher.final()]);
  } catch {
    throw new VaultCryptoError();
  }
}

// ── Sealed blobs ──
// "FVB1" | kind (1) | salt (16) | nonce (12) | ciphertext | tag (16).

const BLOB_MAGIC = Buffer.from('FVB1');
/** What a blob holds: its key is derived for that use only, and the kind is
 *  in the header, so a sidecar never opens as a dump. */
export const BLOB_KIND = { dump: 1, meta: 2 } as const;
type BlobKind = (typeof BLOB_KIND)[keyof typeof BLOB_KIND];
const BLOB_HEADER = BLOB_MAGIC.length + 1 + SALT + GCM_NONCE;

export function sealBlob(vk: Buffer, kind: BlobKind, plain: Uint8Array): Buffer {
  const salt = randomBytes(SALT);
  const nonce = randomBytes(GCM_NONCE);
  const header = Buffer.concat([BLOB_MAGIC, Buffer.from([kind]), salt, nonce]);
  const key = hkdf(vk, salt, `factiii-vault blob ${kind} v1`);
  try {
    return Buffer.concat([header, gcmSeal(key, nonce, plain, header)]);
  } finally {
    wipe(key);
  }
}

export function openBlob(vk: Buffer, kind: BlobKind, sealed: Uint8Array): Buffer {
  const blob = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  if (blob.length < BLOB_HEADER + GCM_TAG || !blob.subarray(0, 4).equals(BLOB_MAGIC)) {
    throw new VaultCryptoError('This is not a sealed Vault file.');
  }
  if (blob[4] !== kind) throw new VaultCryptoError();
  const header = blob.subarray(0, BLOB_HEADER);
  const salt = header.subarray(5, 5 + SALT);
  const nonce = header.subarray(5 + SALT);
  const key = hkdf(vk, salt, `factiii-vault blob ${kind} v1`);
  try {
    return gcmOpen(key, nonce, blob.subarray(BLOB_HEADER), header);
  } finally {
    wipe(key);
  }
}

/** A blob in the sealed format (its magic), for telling it from plaintext. */
export const isSealedBlob = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 && Buffer.from(bytes.buffer, bytes.byteOffset, 4).equals(BLOB_MAGIC);

// ── Sealed files (STREAM) ──
// Header: "FVS1" | segment size (u32 BE) | salt (16) | nonce prefix (7).
// Segment i: GCM(key, prefix ‖ u32 BE i ‖ last ? 1 : 0, plain_i, aad=header).
// Every segment holds SEGMENT bytes but the last, which holds 0..SEGMENT.

const STREAM_MAGIC = Buffer.from('FVS1');
export const SEGMENT_BYTES = 64 * 1024;
const PREFIX = 7;
export const STREAM_HEADER_BYTES = STREAM_MAGIC.length + 4 + SALT + PREFIX;
const SEALED_SEGMENT = SEGMENT_BYTES + GCM_TAG;

type StreamHeader = { header: Buffer; segment: number; key: Buffer; prefix: Buffer };

function streamNonce(prefix: Buffer, index: number, last: boolean): Buffer {
  const nonce = Buffer.alloc(GCM_NONCE);
  prefix.copy(nonce, 0);
  nonce.writeUInt32BE(index, PREFIX);
  nonce[GCM_NONCE - 1] = last ? 1 : 0;
  return nonce;
}

function newStreamHeader(vk: Buffer): StreamHeader {
  const salt = randomBytes(SALT);
  const prefix = randomBytes(PREFIX);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(SEGMENT_BYTES);
  const header = Buffer.concat([STREAM_MAGIC, size, salt, prefix]);
  return { header, segment: SEGMENT_BYTES, key: hkdf(vk, salt, 'factiii-vault file v1'), prefix };
}

function parseStreamHeader(vk: Buffer, header: Buffer): StreamHeader {
  if (header.length < STREAM_HEADER_BYTES || !header.subarray(0, 4).equals(STREAM_MAGIC)) {
    throw new VaultCryptoError('This is not a sealed Vault file.');
  }
  const segment = header.readUInt32BE(4);
  if (segment !== SEGMENT_BYTES) throw new VaultCryptoError();
  const salt = header.subarray(8, 8 + SALT);
  const prefix = header.subarray(8 + SALT, STREAM_HEADER_BYTES);
  return {
    header: header.subarray(0, STREAM_HEADER_BYTES),
    segment,
    key: hkdf(vk, salt, 'factiii-vault file v1'),
    prefix
  };
}

/** The plaintext size of a sealed file of `sealedSize` bytes, or null when no
 *  plaintext size gives that length (cut or padded). */
export function streamPlainSize(sealedSize: number): number | null {
  const body = sealedSize - STREAM_HEADER_BYTES;
  if (body < GCM_TAG) return null;
  const segments = Math.ceil(body / SEALED_SEGMENT);
  const lastSealed = body - (segments - 1) * SEALED_SEGMENT;
  if (lastSealed < GCM_TAG) return null;
  return body - segments * GCM_TAG;
}

/**
 * Seal a file as its bytes arrive: whole segments go to disk as they fill,
 * the rest waits in memory for the next write. `finish` writes the last
 * segment (empty for an empty or segment-aligned file) and returns the
 * plaintext's size and SHA-256. Nothing of the plaintext is written.
 */
export class SealedFileWriter {
  private readonly head: StreamHeader;
  private readonly fd: number;
  private pending: Buffer = Buffer.alloc(0);
  private index = 0;
  private size = 0;
  private readonly hash = createHash('sha256');
  private done = false;

  constructor(vk: Buffer, readonly file: string) {
    this.head = newStreamHeader(vk);
    this.fd = fs.openSync(file, 'w', 0o600);
    fs.writeSync(this.fd, this.head.header);
  }

  /** Plaintext bytes taken so far. */
  get received(): number {
    return this.size;
  }

  write(bytes: Uint8Array): void {
    if (this.done) throw new Error('This file is already sealed.');
    this.hash.update(bytes);
    this.size += bytes.length;
    this.pending = this.pending.length ? Buffer.concat([this.pending, bytes]) : Buffer.from(bytes);
    // Keep the tail back: the last segment is sealed with its flag at finish.
    while (this.pending.length > this.head.segment) {
      this.emit(this.pending.subarray(0, this.head.segment), false);
      this.pending = this.pending.subarray(this.head.segment);
    }
  }

  private emit(plain: Buffer, last: boolean): void {
    const nonce = streamNonce(this.head.prefix, this.index, last);
    fs.writeSync(this.fd, gcmSeal(this.head.key, nonce, plain, this.head.header));
    this.index += 1;
  }

  /** Seal the last segment, fsync and close. */
  finish(): { size: number; sha256: string } {
    this.emit(this.pending, true);
    this.pending = Buffer.alloc(0);
    fs.fsyncSync(this.fd);
    this.close();
    return { size: this.size, sha256: this.hash.digest('hex') };
  }

  /** Close without sealing the end (a dropped upload); the file is junk. */
  close(): void {
    if (this.done) return;
    this.done = true;
    fs.closeSync(this.fd);
    wipe(this.head.key);
  }
}

/** Seal a whole buffer into `file`. */
export function sealFile(vk: Buffer, file: string, plain: Uint8Array): { size: number; sha256: string } {
  const writer = new SealedFileWriter(vk, file);
  try {
    writer.write(plain);
    return writer.finish();
  } catch (err) {
    writer.close();
    throw err;
  }
}

/** One range of a sealed file's plaintext, opening only the segments it
 *  covers (and checking the file's length is one a sealed file can have). */
export function readSealedRange(vk: Buffer, file: string, offset: number, length: number): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    const sealedSize = fs.fstatSync(fd).size;
    const plainSize = streamPlainSize(sealedSize);
    if (plainSize === null) throw new VaultCryptoError();
    const headerBytes = Buffer.alloc(STREAM_HEADER_BYTES);
    fs.readSync(fd, headerBytes, 0, STREAM_HEADER_BYTES, 0);
    const head = parseStreamHeader(vk, headerBytes);
    try {
      const end = Math.min(plainSize, offset + length);
      if (end <= offset) {
        // An empty range still proves the key: open the last segment.
        if (plainSize === 0) openSegment(fd, head, 0, sealedSize, true);
        return Buffer.alloc(0);
      }
      const segments = Math.ceil((sealedSize - STREAM_HEADER_BYTES) / SEALED_SEGMENT);
      const first = Math.floor(offset / head.segment);
      const lastNeeded = Math.floor((end - 1) / head.segment);
      const parts: Buffer[] = [];
      for (let i = first; i <= lastNeeded; i++) {
        parts.push(openSegment(fd, head, i, sealedSize, i === segments - 1));
      }
      const joined = Buffer.concat(parts);
      const start = offset - first * head.segment;
      return joined.subarray(start, start + (end - offset));
    } finally {
      wipe(head.key);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function openSegment(fd: number, head: StreamHeader, index: number, sealedSize: number, last: boolean): Buffer {
  const at = STREAM_HEADER_BYTES + index * SEALED_SEGMENT;
  const size = Math.min(SEALED_SEGMENT, sealedSize - at);
  const sealed = Buffer.alloc(size);
  fs.readSync(fd, sealed, 0, size, at);
  return gcmOpen(head.key, streamNonce(head.prefix, index, last), sealed, head.header);
}

/** A sealed file's whole plaintext. */
export function openSealedFile(vk: Buffer, file: string): Buffer {
  const plainSize = streamPlainSize(fs.statSync(file).size);
  if (plainSize === null) throw new VaultCryptoError();
  return readSealedRange(vk, file, 0, plainSize);
}

// ── The Vault key ──
// What the owner holds: 32 Crockford base32 characters (160 bits) from the
// system's random source, shown once in 8 groups of 4 and kept in their
// password manager. The master key is wrapped once under a key-encryption
// key (KEK) derived from it with scrypt (Node's own, from OpenSSL: no
// dependency), a GCM wrap whose associated data names the Vault, so the
// wrap cannot be moved to another Vault.
//
// The Vault key is random, so stretching is not what keeps it from being
// guessed (2^160 tries); scrypt's memory-hard cost is there in case a key
// ever is weaker than that, and costs one derivation per unlock. Its
// parameters are stored with the wrap, so they can be raised later.

export type KdfParams = { name: 'scrypt'; N: number; r: number; p: number; salt: string };
export type WrappedKey = { kdf: KdfParams; nonce: string; wrapped: string };

/** scrypt at N = 2^17, r = 8, p = 1: 128 MiB and a few tenths of a second
 *  per derivation (OWASP's first recommended setting). */
export type KdfCost = { N: number; r: number; p: number };
export const VAULT_KDF: Readonly<KdfCost> = { N: 2 ** 17, r: 8, p: 1 };

export function newVaultPassphrase(): string {
  const bytes = randomBytes(VAULT_KEY_CHARS);
  // 256 is a multiple of 32, so the low five bits are uniform.
  return formatVaultKey([...bytes].map((byte) => VAULT_KEY_ALPHABET[byte & 31]).join(''));
}

/** The KEK from a Vault key's canonical characters (normalizeVaultKey). */
export function deriveKek(canonical: string, kdf: KdfParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      Buffer.from(canonical, 'utf-8'),
      Buffer.from(kdf.salt, 'base64'),
      32,
      // scrypt needs 128 · N · r bytes; OpenSSL's default cap is 32 MiB.
      { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r + (1 << 20) },
      (err, key) => (err ? reject(err) : resolve(key))
    );
  });
}

/** Wrap the master key under a Vault key: a fresh salt every time, so a
 *  changed key shares nothing with the old one. */
export async function wrapVaultKey(
  vk: Buffer,
  canonical: string,
  aad: string,
  cost: KdfCost = VAULT_KDF
): Promise<WrappedKey> {
  const kdf: KdfParams = { name: 'scrypt', ...cost, salt: randomBytes(SALT).toString('base64') };
  const nonce = randomBytes(GCM_NONCE);
  const kek = await deriveKek(canonical, kdf);
  try {
    return {
      kdf,
      nonce: nonce.toString('base64'),
      wrapped: gcmSeal(kek, nonce, vk, Buffer.from(aad)).toString('base64')
    };
  } finally {
    wipe(kek);
  }
}

/** The master key, or VaultCryptoError for a wrong Vault key. */
export async function unwrapVaultKey(slot: WrappedKey, canonical: string, aad: string): Promise<Buffer> {
  if (slot.kdf?.name !== 'scrypt') throw new Error('The Vault’s key file uses a key derivation this runner does not know.');
  const kek = await deriveKek(canonical, slot.kdf);
  try {
    const vk = gcmOpen(kek, Buffer.from(slot.nonce, 'base64'), Buffer.from(slot.wrapped, 'base64'), Buffer.from(aad));
    if (vk.length !== VAULT_KEY_BYTES) throw new VaultCryptoError();
    return vk;
  } finally {
    wipe(kek);
  }
}

// ── Writing to disk ──

/** Write a file so a crash leaves the old one or the new one, never half:
 *  a temp file beside it, fsync, rename, fsync of the folder. */
export function atomicWrite(file: string, bytes: Uint8Array | string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = fs.openSync(temp, 'w', 0o600);
  try {
    fs.writeSync(fd, typeof bytes === 'string' ? Buffer.from(bytes) : bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temp, file);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
  fsyncDir(dir);
}

export function fsyncDir(dir: string): void {
  try {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Some file systems refuse a directory fsync; the rename stands.
  }
}

/**
 * Remove plaintext as well as the runner can: each file overwritten with
 * random bytes and fsynced, then unlinked. On an SSD or APFS (copy on write,
 * local snapshots) the old blocks may survive the overwrite; the spec says
 * so ("Honest limits").
 */
export function shredPath(target: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return;
  }
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(target)) shredPath(path.join(target, name));
    fs.rmSync(target, { recursive: true, force: true });
    return;
  }
  if (stat.isFile() && stat.size > 0) {
    try {
      const fd = fs.openSync(target, 'r+');
      try {
        const chunk = 1 << 20;
        for (let at = 0; at < stat.size; at += chunk) {
          fs.writeSync(fd, randomBytes(Math.min(chunk, stat.size - at)), 0, Math.min(chunk, stat.size - at), at);
        }
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // Unwritable: removed below all the same.
    }
  }
  fs.rmSync(target, { force: true });
}
