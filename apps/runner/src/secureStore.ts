import type { SecureStoreStatus } from '@shared/all/domains/electron';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { getKeychainKey, keychainStatus } from './keychain';
import { CONFIG_DIR } from './paths';

export type { SecureStoreStatus };

// What is left of the runner's vault: one random data key (DEK), wrapped by
// the machine's keychain key and - on runners where the owner once set a
// connection password - by that password too.
//
//   wrapKey = HKDF-SHA256( keychainKey [|| scrypt(password)] )
//   vault-key.json holds the DEK encrypted under wrapKey (AES-256-GCM)
//
// THE VAULT IS READ-ONLY AND ON ITS WAY OUT. The GitHub and OneDrive
// connection files used to be sealed under the DEK, which meant a
// password-protected runner could not clone, deploy or even show who was
// connected after a restart until someone typed the password. They are now
// sealed under the keychain key alone, like the pairing config
// (secureFile.ts), and the connection password is gone: nothing here can
// create a vault, set a password or change one.
//
// What remains is the way out for files an older runner sealed under the DEK:
// open the vault (unlock, for the one use a password-protected runner needs
// after updating), let agent-adapter rewrite those files, then retire the
// vault file so no later restart has anything to lock (retireVault).
//
// The deploy secrets store is a different thing with its own password, taken
// per operation and never cached (see host-secrets.ts).

const VAULT_KEY_FILE = path.join(CONFIG_DIR, 'vault-key.json');

/** Where a vault nothing needs any more is moved. Renamed rather than deleted:
 *  it costs nothing to keep, and it is the only way back if a vault-sealed
 *  file turns up somewhere the runner never looks (a hand-made backup). */
const RETIRED_VAULT_KEY_FILE = path.join(CONFIG_DIR, 'vault-key.retired.json');

// N=2^15 (r=8) needs exactly 32MiB, which is Node's default scrypt maxmem and
// the limit check is exclusive - raise the ceiling, keep the hardness. These
// are the parameters existing vault files were written with.
const SCRYPT_N = 1 << 15;

export type SecureStoreCode =
  | 'no-keychain'
  | 'locked'
  | 'bad-password'
  | 'no-password-set';

/** Every failure the vault can hand back, carrying the remedy with it so the
 *  UI never has to guess what to tell the owner. */
export class SecureStoreError extends Error {
  readonly code: SecureStoreCode;
  readonly fix: string;

  constructor(code: SecureStoreCode, message: string, fix = '') {
    super(message);
    this.name = 'SecureStoreError';
    this.code = code;
    this.fix = fix;
  }
}

export function isSecureStoreError(err: unknown): err is SecureStoreError {
  return err instanceof SecureStoreError;
}

type VaultKeyFile = {
  v: 1;
  passwordEnabled: boolean;
  /** scrypt salt for the password half; null when no password is set. */
  salt: string | null;
  /** The DEK, encrypted under wrapKey. */
  iv: string;
  tag: string;
  data: string;
};

// ── key material ──

/** The machine keychain key, or the actionable error every credential path
 *  reports when this host has none. */
export function requireKeychainKey(): Buffer {
  const key = getKeychainKey();
  if (key) return key;
  const status = keychainStatus();
  throw new SecureStoreError(
    'no-keychain',
    `This machine has no usable ${status.backend === 'libsecret' ? 'keyring' : 'keychain'}, so the runner refuses to store credentials. ${status.problem}`,
    status.fix
  );
}

function passwordKey(password: string, salt: Buffer): Buffer {
  return crypto.scryptSync(password, salt, 32, {
    N: SCRYPT_N,
    maxmem: 64 * 1024 * 1024
  });
}

function wrapKey(machineKey: Buffer, pwKey: Buffer | null): Buffer {
  const ikm = pwKey ? Buffer.concat([machineKey, pwKey]) : machineKey;
  return Buffer.from(
    crypto.hkdfSync(
      'sha256',
      ikm,
      Buffer.alloc(0),
      Buffer.from('factiii-runner-vault-v1'),
      32
    )
  );
}

function unseal(
  box: Pick<VaultKeyFile, 'iv' | 'tag' | 'data'>,
  key: Buffer
): Buffer | null {
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(box.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(box.data, 'base64')),
      decipher.final()
    ]);
  } catch {
    // Wrong key or tampered file. GCM's tag makes this the password check too.
    return null;
  }
}

// ── vault-key.json ──

function readVaultFile(): VaultKeyFile | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(VAULT_KEY_FILE, 'utf-8')
    ) as VaultKeyFile;
    return parsed.v === 1 ? parsed : null;
  } catch {
    return null;
  }
}

// The DEK for this process, once the vault has been opened.
let unlockedDek: Buffer | null = null;

/**
 * The key legacy (v2) connection files were encrypted under, or null when
 * there is no vault file - in which case nothing can open such a file.
 *
 * Throws when the vault exists and cannot be opened: no keychain, or a
 * password-protected vault the owner has not unlocked yet.
 */
export function vaultKey(): Buffer | null {
  if (unlockedDek) return unlockedDek;

  const machineKey = requireKeychainKey();
  const file = readVaultFile();
  if (!file) return null;

  if (file.passwordEnabled) {
    throw new SecureStoreError(
      'locked',
      'Connections saved by an older version of this runner are still locked behind your connection password. Enter it once and they stay readable for good.',
      'Open Runner Settings → Secrets on any device and enter the password, restart the runner in a terminal and type it there, or run "factiii-runner password".'
    );
  }

  const dek = unseal(file, wrapKey(machineKey, null));
  if (!dek) {
    throw new SecureStoreError(
      'no-keychain',
      'Connections saved by an older version of this runner cannot be decrypted with this machine’s keychain key.',
      `The keychain entry was replaced or ${VAULT_KEY_FILE} was copied from another machine. Connect GitHub again on each board to replace them.`
    );
  }
  unlockedDek = dek;
  return dek;
}

/** Whether a vault file with a password on it still exists. */
export function passwordEnabled(): boolean {
  return readVaultFile()?.passwordEnabled ?? false;
}

/** Open a password-protected vault for the rest of this process's life, so
 *  the files in it can be converted. The one use the password still has. */
export function unlock(password: string): void {
  const machineKey = requireKeychainKey();
  const file = readVaultFile();
  if (!file?.passwordEnabled) {
    throw new SecureStoreError(
      'no-password-set',
      'This runner has no connection password, so there is nothing to unlock.'
    );
  }
  const dek = unseal(
    file,
    wrapKey(machineKey, passwordKey(password, Buffer.from(file.salt!, 'base64')))
  );
  if (!dek) {
    throw new SecureStoreError(
      'bad-password',
      'That password does not unlock this runner.'
    );
  }
  unlockedDek = dek;
}

/**
 * Take the vault file out of service. The caller has established that no file
 * the runner reads is still sealed under the DEK, so the DEK - and the
 * password on it, if any - protects nothing; with the file gone,
 * passwordEnabled() is false and no restart has anything to lock.
 *
 * Returns whether there was a vault to retire.
 */
export function retireVault(): boolean {
  if (!fs.existsSync(VAULT_KEY_FILE)) return false;
  fs.renameSync(VAULT_KEY_FILE, RETIRED_VAULT_KEY_FILE);
  if (unlockedDek) unlockedDek.fill(0);
  unlockedDek = null;
  return true;
}

/**
 * The keychain and vault half of the storage state. `ready` is about the
 * keychain alone, since that is all a connection file needs; a locked vault
 * is reported in `unlocked` and does not make the store unusable. Whether a
 * locked vault is actually holding a file hostage is the caller's question -
 * see credentialStoreStatus in agent-adapter.ts, which is what the UI gets.
 *
 * `passwordSupported` is false: no password can be set any more, and clients
 * old and new use it to decide whether to offer one.
 */
export function storeStatus(): SecureStoreStatus {
  const keychain = keychainStatus();
  const withPassword = passwordEnabled();
  const unlocked = Boolean(unlockedDek);

  const base = {
    backend: 'runner-keychain',
    keyStore: keychain.backend,
    passwordSupported: false,
    passwordEnabled: withPassword,
    missingTool: keychain.missingTool
  } as const;

  if (!keychain.available) {
    return {
      ...base,
      unlocked: false,
      ready: false,
      problem: `Credentials cannot be stored on this machine: ${keychain.problem}`,
      fix: keychain.fix
    };
  }
  return {
    ...base,
    unlocked: !withPassword || unlocked,
    ready: true,
    problem: '',
    fix: ''
  };
}
