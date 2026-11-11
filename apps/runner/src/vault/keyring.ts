import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import { normalizeVaultKey, VAULT_LOCK_IDLE_MINUTES, WRONG_VAULT_KEY } from '@shared/all/validators';

import {
  atomicWrite,
  type KdfCost,
  unwrapVaultKey,
  VAULT_KDF,
  VaultCryptoError,
  wrapVaultKey,
  type WrappedKey
} from './crypto';

// The Vault's key file (`parts/vault/keys.json`): the master key wrapped
// once, under a key derived from the owner's Vault key, never in the clear
// (.specs/vault.md "Encryption and the Vault key"). Its other fields are not
// secret: the Vault's id, when the key was set, the idle lock's minutes, and
// the KDF's salt and cost.
//
// The Vault key itself is never stored here: the owner keeps it in their
// password manager and sends it over the direct link to unlock.

export type Keyring = WrappedKey & {
  v: 2;
  vaultId: string;
  createdAt: string;
  /** When the Vault key was set: at setup, then at each change. */
  keySetAt: string;
  lockIdleMinutes: number;
};

/** A key file from the build with per-device slots and a recovery key
 *  (v1, never released): refused, not migrated (.specs/vault.md). */
export const SLOT_KEYRING =
  'This Vault was encrypted by a test build of the runner that used device keys, which this runner does not read. Remove the runner’s parts/vault folder to start the Vault again.';

/** What the master key's wrap is bound to: this Vault. */
const keyAad = (vaultId: string) => `factiii-vault ${vaultId} key v2`;

/** The key file, null when there is none, `slots` for the v1 build's. */
export function readKeyring(file: string): Keyring | 'slots' | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  const parsed = JSON.parse(raw) as { v?: unknown };
  if (parsed.v === 1) return 'slots';
  if (parsed.v !== 2) throw new Error('The Vault’s key file is from a newer runner. Update the runner.');
  return parsed as Keyring;
}

export const writeKeyring = (file: string, keyring: Keyring): void =>
  atomicWrite(file, `${JSON.stringify(keyring, null, 2)}\n`);

const nowIso = () => new Date().toISOString();

/** The canonical Vault key, or WRONG_VAULT_KEY when it cannot be one. */
function canonicalKey(vaultKey: string): string {
  const canonical = normalizeVaultKey(vaultKey);
  if (!canonical) throw new Error(WRONG_VAULT_KEY);
  return canonical;
}

/** A new key file: the master key wrapped under the Vault key. `cost` is
 *  the tests' (a light scrypt); the runner uses VAULT_KDF. */
export async function createKeyring(vk: Buffer, vaultKey: string, cost: KdfCost = VAULT_KDF): Promise<Keyring> {
  const vaultId = randomUUID();
  return {
    v: 2,
    vaultId,
    createdAt: nowIso(),
    keySetAt: nowIso(),
    lockIdleMinutes: VAULT_LOCK_IDLE_MINUTES,
    ...(await wrapVaultKey(vk, canonicalKey(vaultKey), keyAad(vaultId), cost))
  };
}

/** The key file with the master key wrapped under a new Vault key (a new
 *  salt, and today's cost): the old key no longer opens it. The data is not
 *  touched. */
export async function rekeyed(keyring: Keyring, vk: Buffer, vaultKey: string, cost: KdfCost = VAULT_KDF): Promise<Keyring> {
  return {
    ...keyring,
    keySetAt: nowIso(),
    ...(await wrapVaultKey(vk, canonicalKey(vaultKey), keyAad(keyring.vaultId), cost))
  };
}

/** The master key, or WRONG_VAULT_KEY. */
export async function unwrapWithVaultKey(keyring: Keyring, vaultKey: string): Promise<Buffer> {
  try {
    return await unwrapVaultKey(keyring, canonicalKey(vaultKey), keyAad(keyring.vaultId));
  } catch (err) {
    if (err instanceof VaultCryptoError) throw new Error(WRONG_VAULT_KEY);
    throw err;
  }
}
