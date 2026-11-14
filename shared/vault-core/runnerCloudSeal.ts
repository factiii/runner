import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';

import {
  RUNNER_CLOUD_KEY_MISSING,
  RUNNER_CLOUD_SEALING
} from '@shared/all/validators';

import { atomicWrite, newMasterKey } from './crypto';
import {
  recoverSeal,
  type SealOptions,
  type SealPaths,
  sealPaths,
  sealVault
} from './sealMigration';

// Runner Cloud's key (.specs/runner-vault.md "Runner Cloud encryption"):
// Runner Cloud is sealed with the same code as the Vault (sealedDb.ts, the
// object store's `sealKey`, sealMigration.ts), but under a key the runner
// holds, so AI and the people the owner shares it with work while the owner
// is away. Nobody types it: it is made on the first start that needs it and
// kept by the runner.
//
// Where the key is kept is the runner's, behind one small interface
// (`RunnerKeyStore`): a 0600 file in its config dir on every OS
// (apps/runner/src/vault/runnerCloudKey.ts). A key an older runner kept in
// the macOS Keychain is moved to the file once (`moveKey`; Jon, 2026-11-11,
// q22: no Keychain). This file is the sealing half: the key file, the check,
// the move to sealed, and that one move of the key.
//
// Runner Cloud's key file (`parts/runner-storage/keys.json`) says which of
// them holds the key and carries a check (an HMAC under the key), never the
// key: a key that does not match is refused rather than used, and a key that
// cannot be read is never replaced by a new one, which would orphan every
// file sealed under the old.
//
// What this protects: Runner Cloud's folder on its own (a backup of
// `parts`, a copied disk folder). It does not protect against the runner's
// own user, which holds the key so it can work unattended.

/** What a store answered for the key. Only `missing` licenses minting. */
export type KeyLookup =
  | { state: 'found'; key: Buffer }
  | { state: 'missing' }
  | { state: 'error'; why: string };

/** Where Runner Cloud's key is kept. `keychain` is only an older runner's,
 *  read to move its key to the file. */
export type RunnerKeyStore = {
  where: 'keychain' | 'file';
  read(): KeyLookup;
  write(key: Buffer): void;
  /** Drop the key from this store (the Keychain's, once moved). */
  remove?(): void;
};

/** Runner Cloud's key file: a record of where its key is, not the key. */
export type RunnerCloudKeyFile = {
  v: 1;
  kind: 'runner-held';
  /** This Runner Cloud's own id (the journal's and the check's). */
  vaultId: string;
  keyIn: RunnerKeyStore['where'];
  /** HMAC-SHA256 under the key, so a wrong key is told from the right one. */
  check: string;
  createdAt: string;
};

// The words live in shared validators, so the app matches the same string.
export { RUNNER_CLOUD_KEY_MISSING, RUNNER_CLOUD_SEALING };

const keyCheck = (key: Buffer, vaultId: string): string =>
  createHmac('sha256', key)
    .update(`factiii runner-cloud ${vaultId} key check v1`)
    .digest('base64');

const checkMatches = (key: Buffer, record: RunnerCloudKeyFile): boolean => {
  const want = Buffer.from(record.check, 'base64');
  const got = Buffer.from(keyCheck(key, record.vaultId), 'base64');
  return want.length === got.length && timingSafeEqual(want, got);
};

function readRecord(file: string): RunnerCloudKeyFile | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  const parsed = JSON.parse(raw) as Partial<RunnerCloudKeyFile>;
  if (parsed.v !== 1 || parsed.kind !== 'runner-held') {
    throw new Error(
      'Runner Cloud’s key file is from a newer runner. Update the runner.'
    );
  }
  return parsed as RunnerCloudKeyFile;
}

export type RunnerCloudSealOptions = {
  /** Runner Cloud's folder, `parts/runner-storage`. */
  root: string;
  stores: RunnerKeyStore[];
  /** Stores only read, for a key file that names one (an older runner's
   *  Keychain), until `moveKey` moves the key out. Never written to. */
  legacy?: RunnerKeyStore[];
  log?: (line: string) => void;
};

/** What `moveKey` did. */
export type KeyMove = 'moved' | 'none' | { failed: string };

/**
 * Runner Cloud's encryption: its key, made or found, and the one-time move
 * of a plaintext Runner Cloud to sealed.
 *
 * - `sealed()`: its key file is there (a new Runner Cloud is sealed from its
 *   first file; an old one once `seal` has run).
 * - `key()`: the key, read once from where the key file says and checked.
 * - `create()`: a new, empty Runner Cloud's key file, before its first write.
 * - `seal(...)`: a plaintext Runner Cloud encrypted in place, crash-safe
 *   (sealMigration.ts: written beside it, verified by decrypting, then
 *   swapped in at one commit point).
 */
export class RunnerCloudSeal {
  readonly paths: SealPaths;
  private cached: Buffer | null = null;
  private readonly log: (line: string) => void;

  constructor(private readonly options: RunnerCloudSealOptions) {
    this.paths = sealPaths(options.root);
    this.log = options.log ?? ((line) => console.log(`[runner-cloud] ${line}`));
  }

  /** Finish or undo a move to sealed that a crash cut short. */
  recover(): void {
    const recovered = recoverSeal(this.paths);
    if (recovered !== 'none')
      this.log(
        `Encrypting Runner Cloud: ${recovered} after an interrupted run.`
      );
  }

  sealed(): boolean {
    return fs.existsSync(this.paths.keys);
  }

  /** A plaintext Runner Cloud from before encryption is on disk. */
  plain(): boolean {
    return (
      !this.sealed() &&
      (fs.existsSync(this.paths.plainDb) || fs.existsSync(this.paths.objects))
    );
  }

  key(): Buffer {
    if (this.cached) return this.cached;
    const record = readRecord(this.paths.keys);
    if (!record) throw new Error(RUNNER_CLOUD_KEY_MISSING);
    const store = [...this.options.stores, ...(this.options.legacy ?? [])].find(
      (s) => s.where === record.keyIn
    );
    const found = store?.read();
    if (found?.state !== 'found') {
      const why =
        found?.state === 'error' ? found.why : `no key in the ${record.keyIn}`;
      throw new Error(`${RUNNER_CLOUD_KEY_MISSING} (${why})`);
    }
    if (!checkMatches(found.key, record))
      throw new Error(
        `${RUNNER_CLOUD_KEY_MISSING} (the key there is another one)`
      );
    this.cached = found.key;
    return found.key;
  }

  /** The key to seal with: one a store already holds (from a run cut short,
   *  so nothing sealed under it is orphaned), else a new one, in the first
   *  store that keeps it. */
  private obtain(): { key: Buffer; keyIn: RunnerKeyStore['where'] } {
    const problems: string[] = [];
    for (const store of this.options.stores) {
      const found = store.read();
      if (found.state === 'found')
        return { key: found.key, keyIn: store.where };
    }
    for (const store of this.options.stores) {
      const found = store.read();
      if (found.state === 'error') {
        // Unreachable is not absent: never write over it.
        problems.push(`${store.where}: ${found.why}`);
        continue;
      }
      const key = newMasterKey();
      try {
        store.write(key);
        const back = store.read();
        if (back.state === 'found' && back.key.equals(key))
          return { key, keyIn: store.where };
        problems.push(`${store.where}: the key did not read back`);
      } catch (err) {
        problems.push(
          `${store.where}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    throw new Error(
      `This runner has nowhere to keep Runner Cloud’s key (${problems.join('; ')}).`
    );
  }

  private record(
    key: Buffer,
    keyIn: RunnerKeyStore['where']
  ): RunnerCloudKeyFile {
    const vaultId = randomUUID();
    return {
      v: 1,
      kind: 'runner-held',
      vaultId,
      keyIn,
      check: keyCheck(key, vaultId),
      createdAt: new Date().toISOString()
    };
  }

  /** A new Runner Cloud: its key file, so its first write is sealed. */
  create(): void {
    if (this.sealed()) return;
    const { key, keyIn } = this.obtain();
    fs.mkdirSync(this.paths.root, { recursive: true, mode: 0o700 });
    atomicWrite(
      this.paths.keys,
      `${JSON.stringify(this.record(key, keyIn), null, 2)}\n`
    );
    this.cached = key;
  }

  /**
   * Move the key from the store the key file names (`from`, an older
   * runner's Keychain) to `to`, once: read and check it, write it to `to`,
   * read it back, point the key file at `to` (the same id and check), and
   * only then drop it from `from`. Anything short of that leaves the key
   * where it was and the key file unchanged, to try again at the next start;
   * a key `to` already holds is never written over with another.
   */
  moveKey(from: RunnerKeyStore, to: RunnerKeyStore): KeyMove {
    const record = readRecord(this.paths.keys);
    if (!record || record.keyIn !== from.where || from.where === to.where)
      return 'none';
    const found = from.read();
    if (found.state !== 'found')
      return {
        failed:
          found.state === 'error' ? found.why : `no key in the ${from.where}`
      };
    if (!checkMatches(found.key, record))
      return { failed: `the key in the ${from.where} is another one` };
    try {
      const there = to.read();
      if (there.state === 'error')
        return { failed: `${to.where}: ${there.why}` };
      if (there.state === 'found' && !there.key.equals(found.key)) {
        return { failed: `the ${to.where} already holds another key` };
      }
      if (there.state === 'missing') to.write(found.key);
      const back = to.read();
      if (back.state !== 'found' || !back.key.equals(found.key))
        return { failed: `the key did not read back from the ${to.where}` };
      atomicWrite(
        this.paths.keys,
        `${JSON.stringify({ ...record, keyIn: to.where }, null, 2)}\n`
      );
    } catch (err) {
      return { failed: err instanceof Error ? err.message : String(err) };
    }
    this.cached = found.key;
    try {
      from.remove?.();
    } catch (err) {
      // The key file points at the file now; a copy left behind is only
      // untidy, so say so and carry on.
      this.log(
        `Runner Cloud's key is in the ${to.where}, but the old copy in the ${from.where} could not be removed (${err instanceof Error ? err.message : String(err)}).`
      );
    }
    this.log(
      `Runner Cloud's key moved from the ${from.where} to the ${to.where}.`
    );
    return 'moved';
  }

  /** Encrypt a plaintext Runner Cloud in place. */
  async seal(
    options: Pick<SealOptions, 'dumpPlain' | 'verifyDump' | 'at'>
  ): Promise<void> {
    const { key, keyIn } = this.obtain();
    await sealVault({
      ...options,
      paths: this.paths,
      vk: key,
      keyring: this.record(key, keyIn)
    });
    this.cached = key;
    this.log('Runner Cloud is encrypted.');
  }
}
