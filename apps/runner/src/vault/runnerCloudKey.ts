import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { atomicWrite, VAULT_KEY_BYTES } from '@shared/vault-core/crypto';
import type { KeyMove, RunnerCloudSeal, RunnerKeyStore } from '@shared/vault-core/runnerCloudSeal';

import { CONFIG_DIR } from '../paths';

// Runner Cloud's key (.specs/runner-vault.md "Runner Cloud encryption"):
// Runner Cloud is sealed with the same code as the Vault (vault-core's
// sealedDb.ts, the object store's `sealKey`, sealMigration.ts), but under a key
// the runner holds, so AI and the people the owner shares it with work while
// the owner is away. Nobody types it: it is made on the first start that needs
// it and kept by the runner. The sealing half (the key file, its check, the
// move to sealed: `RunnerCloudSeal`) is vault-core's
// (shared/vault-core/runnerCloudSeal.ts); this file is where the key is kept.
//
// Where the key is kept, behind one small interface (`RunnerKeyStore`): a
// file in the runner's config dir, `runner-cloud.key`, mode 0600, on every OS
// (Jon, 2026-11-11, q22: no Keychain). An older runner kept it in the macOS
// login Keychain (security(1)), for the runner's own config dir only; that
// key is moved to the file once (`moveKeychainKeyToFile`: read, written to the
// file, read back, the key file pointed at the file, then the Keychain item
// deleted), and the Keychain is only read until then.

export const RUNNER_CLOUD_KEY_FILE = 'runner-cloud.key';

const fromBase64Key = (text: string): Buffer | null => {
  const key = Buffer.from(text.trim(), 'base64');
  return key.length === VAULT_KEY_BYTES ? key : null;
};

/** The key in a 0600 file in the runner's config dir. */
export function fileKeyStore(file: string): RunnerKeyStore {
  return {
    where: 'file',
    read: () => {
      let text: string;
      try {
        text = fs.readFileSync(file, 'utf-8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' };
        return { state: 'error', why: `could not read ${file}` };
      }
      const key = fromBase64Key(text);
      return key ? { state: 'found', key } : { state: 'error', why: `${file} does not hold a key` };
    },
    write: (key) => atomicWrite(file, `${key.toString('base64')}\n`)
  };
}

/** `security` exits 44 (errSecItemNotFound) for a genuinely absent item. */
const SEC_ITEM_NOT_FOUND = 44;
const KEYCHAIN_SERVICE = 'factiii-runner';

/** The key an older runner kept in the macOS login Keychain, one item per
 *  runner dir: read and removed to move it to the file, never written by
 *  this runner. */
export function macKeychainStore(runnerDir: string): RunnerKeyStore {
  const account = `runner-cloud-key:${createHash('sha256').update(runnerDir).digest('hex').slice(0, 12)}`;
  return {
    where: 'keychain',
    read: () => {
      try {
        const out = execFileSync(
          'security',
          ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'],
          { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
        );
        const key = fromBase64Key(out);
        return key ? { state: 'found', key } : { state: 'error', why: 'the Keychain item does not hold a key' };
      } catch (err) {
        // A locked or unreachable Keychain is not an absent key.
        const status = (err as { status?: number | null }).status;
        return status === SEC_ITEM_NOT_FOUND
          ? { state: 'missing' }
          : { state: 'error', why: 'the login Keychain did not answer' };
      }
    },
    write: () => {
      throw new Error('Runner Cloud’s key is no longer written to the Keychain');
    },
    remove: () => {
      try {
        execFileSync('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account], {
          stdio: 'ignore'
        });
      } catch (err) {
        // Already gone is what we wanted.
        if ((err as { status?: number | null }).status !== SEC_ITEM_NOT_FOUND) throw err;
      }
    }
  };
}

/** Where the runner keeps Runner Cloud's key: the 0600 file, on every OS. */
export function defaultRunnerKeyStores(runnerDir: string): RunnerKeyStore[] {
  return [fileKeyStore(path.join(runnerDir, RUNNER_CLOUD_KEY_FILE))];
}

/** Stores an older runner may have left the key in, only read until it is
 *  moved: the Keychain on a Mac, for the runner's own dir (so a test or a
 *  second runner in another folder never reaches the owner's Keychain). */
export function legacyRunnerKeyStores(runnerDir: string, platform: NodeJS.Platform = process.platform): RunnerKeyStore[] {
  const ownDir = path.resolve(runnerDir) === path.resolve(CONFIG_DIR);
  return platform === 'darwin' && ownDir ? [macKeychainStore(runnerDir)] : [];
}

/** Move a Keychain-held key to the file, once (a no-op when the key file
 *  already names the file, or there is no Keychain store). */
export function moveKeychainKeyToFile(seal: RunnerCloudSeal, stores: RunnerKeyStore[], legacy: RunnerKeyStore[]): KeyMove {
  const keychain = legacy.find((s) => s.where === 'keychain');
  const file = stores.find((s) => s.where === 'file');
  if (!keychain || !file) return 'none';
  return seal.moveKey(keychain, file);
}
