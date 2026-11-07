import type { BoardAgentActionMap } from '@shared/all/domains/electron';

import {
  convertVaultSealedFiles,
  credentialStoreStatus
} from './agent-adapter';
import { type SecureStoreStatus, unlock } from './secureStore';

// What the `secure*` data-channel actions do now that the connection password
// is gone: report the credential store, and take the one unlock a runner that
// had a password still needs. Both answer with a SecureStoreStatus.

/** The actions the daemon answers here, before any per-board dispatch. */
export const SECURE_ACTIONS = new Set<keyof BoardAgentActionMap>([
  'secureStatus',
  'secureUnlock'
]);

/**
 * Move every file still in the vault envelope under the keychain key, retire
 * the vault when none is left, and say on the console what happened. Quiet
 * while the vault is locked: that state is the status's to report.
 */
export function convertVaultFilesAndReport(): void {
  const { converted, left, retired } = convertVaultSealedFiles();
  if (converted) {
    console.log(
      `[secure] Moved ${converted} saved connection file${converted === 1 ? '' : 's'} from the password vault to the machine keychain.`
    );
  }
  if (retired) {
    console.log(
      '[secure] Nothing is left in the password vault, so it was retired (vault-key.retired.json). This runner has no connection password.'
    );
  }
  if (left.length && credentialStoreStatus().unlocked) {
    console.error(
      `[secure] Could not decrypt or rewrite, left in place (reconnect on those boards to replace them):\n  ${left.join('\n  ')}`
    );
  }
}

/**
 * Run one secure action and return the status to answer with.
 *
 * - secureStatus: report only.
 * - secureUnlock: the one use the password still has. Opens the vault,
 *   converts every board's files, retires the vault.
 */
export function runSecureAction(
  action: keyof BoardAgentActionMap,
  payload: unknown
): SecureStoreStatus {
  if (action === 'secureUnlock') {
    unlock((payload as { password: string }).password);
    convertVaultFilesAndReport();
  }
  return credentialStoreStatus();
}
