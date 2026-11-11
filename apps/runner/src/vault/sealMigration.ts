import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  atomicWrite,
  BLOB_KIND,
  fsyncDir,
  openBlob,
  readSealedRange,
  SealedFileWriter,
  sealBlob,
  shredPath,
  streamPlainSize
} from './crypto';
import { type Keyring, writeKeyring } from './keyring';

// Encrypting a Vault that is still plaintext (.specs/vault.md "Encryption and
// the Vault key" → Migration): every Vault from before step 4 has its database
// on disk in `parts/vault/db` and its files in `parts/vault/objects`.
//
// Crash-safe by one commit point, the journal's `committed` write:
//
//   staging   journal → keys.next.json → db.sealed.next → objects.sealing/
//             → verify (the dump loads; every file opens to its hash)
//   commit    journal says committed (atomic)
//   forward   db.sealed.next → db.sealed; objects → objects.plain,
//             objects.sealing → objects; keys.next.json → keys.json;
//             shred db/ and objects.plain/; journal removed
//
// A crash before the commit rolls back: the staged ciphertext is removed and
// the plaintext Vault is as it was, so the next setup starts over (with the
// same Vault key, if it is still waiting: the master key was never kept). A
// crash after it rolls forward at the next start, which needs no key: every
// step is a rename or a removal, each safe to run twice. Until the journal
// is gone the daemon serves nothing from the Vault.

export type SealPaths = {
  root: string;
  journal: string;
  keys: string;
  keysNext: string;
  plainDb: string;
  dump: string;
  dumpNext: string;
  objects: string;
  objectsNext: string;
  objectsOld: string;
};

export function sealPaths(root: string): SealPaths {
  return {
    root,
    journal: path.join(root, 'seal-journal.json'),
    keys: path.join(root, 'keys.json'),
    keysNext: path.join(root, 'keys.next.json'),
    plainDb: path.join(root, 'db'),
    dump: path.join(root, 'db.sealed'),
    dumpNext: path.join(root, 'db.sealed.next'),
    objects: path.join(root, 'objects'),
    objectsNext: path.join(root, 'objects.sealing'),
    objectsOld: path.join(root, 'objects.plain')
  };
}

export type SealStep =
  | 'journal'
  | 'keys'
  | 'dump'
  | 'objects'
  | 'verify'
  | 'commit'
  | 'dump-in-place'
  | 'objects-aside'
  | 'objects-in-place'
  | 'keys-in-place'
  | 'shred'
  | 'done';

type Journal = { v: 1; phase: 'staging' | 'committed'; vaultId: string };

export type SealOptions = {
  paths: SealPaths;
  vk: Buffer;
  keyring: Keyring;
  /** The plaintext database as a dump, or null when there is none. */
  dumpPlain: () => Promise<Uint8Array | null>;
  /** Throws unless this dump loads and holds what the plaintext held. */
  verifyDump: (plain: Buffer) => Promise<void>;
  /** For the tests: called after each step; a throw is a crash there. */
  at?: (step: SealStep) => void;
};

const CHUNK = 1 << 20;

/** What a test throws from `at` to stop the migration as a crash would:
 *  nothing is undone, as after a power cut. Any other error before the
 *  commit rolls back at once. */
export class SealCrash extends Error {}

function readJournal(file: string): Journal | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as Journal;
  } catch {
    return null;
  }
}

/** Seal one plaintext object into `to`, a megabyte at a time. */
function sealObject(vk: Buffer, from: string, to: string): void {
  const writer = new SealedFileWriter(vk, to);
  const fd = fs.openSync(from, 'r');
  try {
    const buffer = Buffer.alloc(CHUNK);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, CHUNK, null);
      if (read === 0) break;
      writer.write(buffer.subarray(0, read));
    }
    writer.finish();
  } catch (err) {
    writer.close();
    throw err;
  } finally {
    fs.closeSync(fd);
  }
}

/** A sealed object's plaintext hash, read a megabyte at a time. */
function sealedHash(vk: Buffer, file: string): { size: number; sha256: string } {
  const size = streamPlainSize(fs.statSync(file).size);
  if (size === null) throw new Error(`A sealed file is cut short: ${path.basename(file)}`);
  const hash = createHash('sha256');
  // An empty file still opens its one segment, which proves the key.
  if (size === 0) readSealedRange(vk, file, 0, 0);
  for (let at = 0; at < size; at += CHUNK) hash.update(readSealedRange(vk, file, at, CHUNK));
  return { size, sha256: hash.digest('hex') };
}

type PlainMeta = { key: string; size: number; sha256: string };

/** Encrypt a plaintext Vault in place. Resolves once it is all done. */
export async function sealVault(options: SealOptions): Promise<void> {
  const { paths, at = () => undefined } = options;
  if (fs.existsSync(paths.journal)) throw new Error('The Vault is already being encrypted.');
  if (fs.existsSync(paths.keys)) throw new Error('This Vault is already encrypted.');
  fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  try {
    await stage(options, at);
  } catch (err) {
    if (!(err instanceof SealCrash)) rollBack(paths);
    throw err;
  }
  atomicWrite(paths.journal, JSON.stringify({ v: 1, phase: 'committed', vaultId: options.keyring.vaultId } satisfies Journal));
  at('commit');
  rollForward(paths, at);
}

/** Everything before the commit point: staged beside the plaintext. */
async function stage(options: SealOptions, at: (step: SealStep) => void): Promise<void> {
  const { paths, vk, keyring } = options;

  atomicWrite(paths.journal, JSON.stringify({ v: 1, phase: 'staging', vaultId: keyring.vaultId } satisfies Journal));
  at('journal');
  writeKeyring(paths.keysNext, keyring);
  at('keys');

  const plain = await options.dumpPlain();
  if (plain) {
    const bytes = Buffer.from(plain);
    try {
      atomicWrite(paths.dumpNext, sealBlob(vk, BLOB_KIND.dump, bytes));
    } finally {
      bytes.fill(0);
    }
  }
  at('dump');

  // Each object and its sidecar, sealed beside the plaintext ones.
  fs.rmSync(paths.objectsNext, { recursive: true, force: true });
  fs.mkdirSync(paths.objectsNext, { recursive: true, mode: 0o700 });
  const sealed: PlainMeta[] = [];
  if (fs.existsSync(paths.objects)) {
    for (const name of fs.readdirSync(paths.objects)) {
      if (!name.endsWith('.json')) continue;
      const object = name.slice(0, -'.json'.length);
      const from = path.join(paths.objects, object);
      let meta: PlainMeta;
      try {
        meta = JSON.parse(fs.readFileSync(path.join(paths.objects, name), 'utf-8')) as PlainMeta;
      } catch {
        // A sidecar cut short by a crash names nothing (objectStore.ts).
        continue;
      }
      if (!fs.existsSync(from)) continue;
      sealObject(vk, from, path.join(paths.objectsNext, object));
      fs.writeFileSync(
        path.join(paths.objectsNext, name),
        sealBlob(vk, BLOB_KIND.meta, fs.readFileSync(path.join(paths.objects, name))),
        { mode: 0o600 }
      );
      sealed.push({ ...meta, key: object });
    }
  }
  fsyncDir(paths.objectsNext);
  at('objects');

  // Verify by decrypting: the dump loads, every file opens to its hash.
  if (plain) {
    const opened = openBlob(vk, BLOB_KIND.dump, fs.readFileSync(paths.dumpNext));
    try {
      await options.verifyDump(opened);
    } finally {
      opened.fill(0);
    }
  }
  for (const meta of sealed) {
    const got = sealedHash(vk, path.join(paths.objectsNext, meta.key));
    if (got.size !== meta.size || got.sha256 !== meta.sha256) {
      throw new Error(`A file did not encrypt cleanly (${meta.key.slice(0, 12)}…). Nothing was changed.`);
    }
  }
  at('verify');
}

/** Put the sealed Vault in place and remove the plaintext. Every step can
 *  run again after a crash. */
function rollForward(paths: SealPaths, at: (step: SealStep) => void): void {
  if (fs.existsSync(paths.dumpNext)) {
    fs.renameSync(paths.dumpNext, paths.dump);
    fsyncDir(paths.root);
  }
  at('dump-in-place');
  if (fs.existsSync(paths.objectsNext)) {
    if (fs.existsSync(paths.objects) && !fs.existsSync(paths.objectsOld)) {
      fs.renameSync(paths.objects, paths.objectsOld);
      fsyncDir(paths.root);
    }
    at('objects-aside');
    fs.renameSync(paths.objectsNext, paths.objects);
    fsyncDir(paths.root);
  }
  at('objects-in-place');
  if (fs.existsSync(paths.keysNext)) {
    fs.renameSync(paths.keysNext, paths.keys);
    fsyncDir(paths.root);
  }
  at('keys-in-place');
  shredPath(paths.plainDb);
  shredPath(paths.objectsOld);
  at('shred');
  fs.rmSync(paths.journal, { force: true });
  fsyncDir(paths.root);
  at('done');
}

/** Undo a migration that never reached its commit: the plaintext Vault was
 *  never touched. */
function rollBack(paths: SealPaths): void {
  fs.rmSync(paths.objectsNext, { recursive: true, force: true });
  fs.rmSync(paths.dumpNext, { force: true });
  fs.rmSync(paths.keysNext, { force: true });
  fs.rmSync(paths.journal, { force: true });
  fsyncDir(paths.root);
}

/** At start, before the Vault is read: finish or undo a migration a crash
 *  cut short. */
export function recoverSeal(paths: SealPaths): 'none' | 'rolled-back' | 'rolled-forward' {
  if (!fs.existsSync(paths.journal)) return 'none';
  const journal = readJournal(paths.journal);
  if (journal?.phase === 'committed') {
    rollForward(paths, () => undefined);
    return 'rolled-forward';
  }
  // Staging, or a journal cut short (its write is atomic, so only by hand).
  rollBack(paths);
  return 'rolled-back';
}
