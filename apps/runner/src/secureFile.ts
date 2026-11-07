import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { getKeychainKey } from './keychain';
import { requireKeychainKey, SecureStoreError, vaultKey } from './secureStore';

// At-rest encryption for the files the runner keeps a credential in: the
// pairing config, and each board's GitHub connection.
// AES-256-GCM under the machine keychain key - the same key for all of them,
// so the runner can always read what it needs to work unattended. The owner
// password never stands between the runner and these files.
//
// There is NO plaintext fallback, by design. A host that cannot encrypt cannot
// store credentials: writes throw, and reads of an existing connection file
// throw too rather than handing a secret back to a machine that has just
// proven it cannot protect it. There is no password either: the connection
// password is gone, and survives only as the one unlock a runner that had one
// needs to get its old files out of the vault (secureStore.ts). The daemon
// stays up and reports the diagnosis so the UI can say which tool is missing
// and how to install it.
//
// What this closes is OFFLINE access: backups, synced folders, a stolen disk
// without the login keychain. It does not protect against a compromised runner
// host - the daemon can always read what it can use.
//
// The JSON layout inside is untouched, so callers (and agent-adapter's
// per-board diffing) don't change shape; only the bytes on disk do.

// Marks an encrypted payload. Plaintext JSON starts with '{', so the two are
// trivially distinguishable on read without a sidecar.
const MAGIC = 'FACTIII1';

// v1: encrypted directly under the machine keychain key. Every file written
//     today, connection files and the boot config alike.
// v2: encrypted under the vault data key, which a connection password could
//     wrap. No longer written: a v2 file is rewritten as v1 the first time the
//     vault lets it be read (see readSecureBuffer), and the vault is retired
//     once none is left.
type Envelope = {
  v: 1 | 2;
  iv: string;
  tag: string;
  data: string;
};

/** Seal under the machine keychain key (the v1 envelope). */
function encrypt(plain: Buffer, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  const envelope: Envelope = {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  };
  return `${MAGIC}${JSON.stringify(envelope)}`;
}

function decrypt(envelope: Envelope, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(envelope.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.data, 'base64')),
    decipher.final()
  ]);
}

function parseEnvelope(raw: string): Envelope | null {
  if (!raw.startsWith(MAGIC)) return null;
  try {
    const parsed = JSON.parse(raw.slice(MAGIC.length)) as Envelope;
    return parsed.v === 1 || parsed.v === 2 ? parsed : null;
  } catch {
    return null;
  }
}

function atomicWrite(filePath: string, body: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // The write is atomic via rename: a crash mid-write would otherwise leave a
  // truncated file that reads as "nothing configured", silently dropping the
  // user's tokens.
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch (err) {
    // The file being replaced is untouched; don't leave the half-write beside it.
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

// ── connection files (keychain key; the vault only for a legacy v2 file) ──

/**
 * Read and decrypt a connection file.
 *
 * Returns null only when the file is missing or unparseable - the cases every
 * caller already treats as "nothing configured". Throws SecureStoreError when
 * the machine cannot decrypt: no keychain, or a file an older runner sealed
 * under the vault while the vault is locked behind a connection password.
 * That second case ends at the first unlock, because the file is rewritten
 * here.
 *
 * Converts on read: a v2 (vault) or plaintext file is rewritten under the
 * keychain key, so upgrading needs no re-pairing and no manual step.
 */
export function readSecureBuffer(filePath: string): Buffer | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const envelope = parseEnvelope(raw);

  if (envelope?.v === 2) {
    // Throws while the vault is locked or the keychain is unusable.
    const key = vaultKey();
    // No vault at all: nothing can open this file.
    if (!key) return null;
    let plain: Buffer;
    try {
      plain = decrypt(envelope, key);
    } catch {
      // Right format, wrong key or damaged bytes. Refusing beats handing back
      // garbage; the file stays where it is.
      return null;
    }
    reseal(filePath, plain);
    return plain;
  }

  // Throws when this host cannot protect the file - deliberately, plaintext
  // included: a machine that cannot encrypt does not get to read credentials
  // back out either.
  const machineKey = requireKeychainKey();

  if (envelope) {
    try {
      return decrypt(envelope, machineKey);
    } catch {
      return null;
    }
  }

  // Plaintext, from a runner that predates encryption.
  const plain = Buffer.from(raw, 'utf-8');
  reseal(filePath, plain);
  return plain;
}

// Rewrite under the keychain key. The value just read is still good and the
// old file is still in place if this fails, so it never breaks the read - but
// it is said out loud, because a file left in the vault envelope locks again
// with the next restart.
function reseal(filePath: string, plain: Buffer): void {
  try {
    writeSecureBuffer(filePath, plain);
  } catch (err) {
    console.error(
      `[secure] Could not rewrite ${filePath} under the keychain key (${
        err instanceof Error ? err.message : String(err)
      }). The existing file was left as it is.`
    );
  }
}

/** Encrypt and write a connection file. Throws rather than writing plaintext. */
function writeSecureBuffer(filePath: string, plain: Buffer): void {
  atomicWrite(filePath, encrypt(plain, requireKeychainKey()));
}

export function readSecureJson<T>(filePath: string): T | null {
  const plain = readSecureBuffer(filePath);
  if (!plain) return null;
  try {
    return JSON.parse(plain.toString('utf-8')) as T;
  } catch {
    return null;
  }
}

export function writeSecureJson(filePath: string, value: unknown): void {
  writeSecureBuffer(filePath, Buffer.from(JSON.stringify(value), 'utf-8'));
}

/** Whether a file is still in the vault (v2) envelope an older runner wrote,
 *  and so needs the vault - and its password, if one is set - to be read.
 *
 *  A file that exists but cannot be read counts as sealed: the vault is
 *  retired on the strength of this answer, and never on a guess. */
export function isVaultSealedFile(filePath: string): boolean {
  try {
    return parseEnvelope(fs.readFileSync(filePath, 'utf-8'))?.v === 2;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== 'ENOENT' && code !== 'ENOTDIR';
  }
}

// ── boot config (keychain key only, no password) ──

/**
 * The pairing config is read BEFORE the runner can connect, and the unlock
 * prompt arrives over that connection - so it is wrapped by the machine
 * keychain alone and never by the owner password. It is still encrypted at
 * rest; it just cannot be part of the lockable vault without deadlocking the
 * only channel that can unlock it.
 *
 * Same envelope as the connection files. It keeps its own reader because a
 * legacy plaintext pairing config must still be readable on a host with no
 * keychain, or that host could never reconnect to be told how to fix it.
 */
export function readBootJson<T>(filePath: string): T | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const machineKey = getKeychainKey();
  const envelope = parseEnvelope(raw);

  if (envelope) {
    if (!machineKey) {
      // Whatever the envelope, nothing here can be read without this key.
      throw new SecureStoreError(
        'no-keychain',
        'The runner’s pairing config is encrypted but this machine’s keychain is unavailable.',
        'Fix the keychain (see the runner logs) and start again, or re-pair with "factiii-runner connect".'
      );
    }
    try {
      return JSON.parse(decrypt(envelope, machineKey).toString('utf-8')) as T;
    } catch {
      return null;
    }
  }

  let parsed: T;
  try {
    parsed = JSON.parse(raw) as T;
  } catch {
    return null;
  }
  if (machineKey) {
    try {
      writeBootJson(filePath, parsed);
    } catch {
      // Migration is best-effort; the value we just read is still good.
    }
  }
  return parsed;
}

export function writeBootJson(filePath: string, value: unknown): void {
  const machineKey = getKeychainKey();
  if (!machineKey) {
    // Same rule as the vault: encrypt or don't store it at all.
    throw new SecureStoreError(
      'no-keychain',
      'Refusing to save the pairing config unencrypted — this machine has no usable keychain.',
      'Install a keyring (see "factiii-runner status") and re-run setup.'
    );
  }
  atomicWrite(
    filePath,
    encrypt(Buffer.from(JSON.stringify(value), 'utf-8'), machineKey)
  );
}
