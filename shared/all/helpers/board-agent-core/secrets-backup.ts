// An offline backup of one board's secrets, for the runner's owner.
//
// A backup is the board's secrets themselves (the keys, their descriptions,
// the file secrets), read out of the store with the board password and sealed
// under a passphrase chosen when the backup is made. The passphrase alone
// opens it: the board's key and password are not in it and are not needed
// again. So the file and its passphrase must be kept apart.
//
// A backup goes back into a board by import: the runner encrypts each secret
// to that board's own key. Restoring is an import of everything into a board
// that has no store, under a password typed then.

import crypto from 'crypto';

import type {
  OpenedSecretsBackup,
  SecretsBackupImportPlan
} from '../../domains/electron';
import { backupPassphraseProblem } from '../../domains/secretsBackup';
import {
  type BackupContents,
  boardHoldsSecrets,
  compareBackupWithStore,
  importBackupIntoStore,
  initSecrets,
  normalizeMeta,
  readStoreForBackup,
  spaceKeyDir,
  unwrapIdentity
} from './host-secrets';

const FORMAT = 'factiii-secrets-backup';
// 1 was the board's secrets folder as ciphertext, opened with the board
// password as well. 2 is the secrets themselves under the passphrase alone.
const VERSION = 2;
// The same cost as the board key's own wrap (host-secrets.ts).
const SCRYPT_N = 1 << 15;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export const OLD_BACKUP =
  'This backup was made by an older runner and this runner cannot open it. Make a new backup.';
const NOT_A_BACKUP = 'That is not a secrets backup file.';

type Bundle = {
  format: typeof FORMAT;
  version: number;
  board: string;
  createdAt: string;
  salt: string;
  iv: string;
  tag: string;
  data: string;
};

/** What is sealed: file secrets as base64 by name. */
type Archive = {
  secrets: Record<string, string>;
  meta: BackupContents['meta'];
  files: Record<string, string>;
};

const deriveKey = (passphrase: string, salt: Buffer): Buffer =>
  crypto.scryptSync(passphrase, salt, 32, {
    N: SCRYPT_N,
    maxmem: SCRYPT_MAXMEM
  });

/** Bound into the seal, so a bundle's label cannot be edited to pass one
 *  board's backup off as another's. */
const header = (b: Pick<Bundle, 'version' | 'board' | 'createdAt'>): Buffer =>
  Buffer.from(`${FORMAT}\n${b.version}\n${b.board}\n${b.createdAt}`, 'utf-8');

const wipe = (contents: BackupContents): void => {
  for (const file of contents.files) file.data.fill(0);
};

/** The backup file's contents. Throws 'Wrong password.' like every other
 *  password road, and counts against the same guess limit. */
export async function exportSecretsBackup(opts: {
  spaceDir: string;
  board: string;
  password: string;
  passphrase: string;
}): Promise<string> {
  const problem = backupPassphraseProblem(opts.passphrase, opts.password);
  if (problem) throw new Error(problem);
  const contents = await readStoreForBackup(opts.spaceDir, opts.password);
  let plain: Buffer;
  try {
    const archive: Archive = {
      secrets: contents.values,
      meta: contents.meta,
      files: Object.fromEntries(
        contents.files.map((f) => [f.name, f.data.toString('base64')])
      )
    };
    plain = Buffer.from(JSON.stringify(archive), 'utf-8');
  } finally {
    wipe(contents);
  }
  const meta = {
    version: VERSION,
    board: opts.board,
    createdAt: new Date().toISOString()
  };
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    deriveKey(opts.passphrase, salt),
    iv
  );
  cipher.setAAD(header(meta));
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  plain.fill(0);
  const bundle: Bundle = {
    format: FORMAT,
    ...meta,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  };
  return JSON.stringify(bundle);
}

/** What a backup file says about itself, without the passphrase. */
function parseBundle(raw: string): Bundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(NOT_A_BACKUP);
  }
  const b = parsed as Partial<Bundle> | null;
  if (!b || b.format !== FORMAT || typeof b.version !== 'number') {
    throw new Error(NOT_A_BACKUP);
  }
  if (b.version < VERSION) throw new Error(OLD_BACKUP);
  if (b.version > VERSION) {
    throw new Error(
      'This backup was made by a newer runner. Update the runner, then restore it.'
    );
  }
  const strings = [b.board, b.createdAt, b.salt, b.iv, b.tag, b.data];
  if (strings.some((value) => typeof value !== 'string')) {
    throw new Error(NOT_A_BACKUP);
  }
  return b as Bundle;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const allStrings = (record: Record<string, unknown>): record is Record<string, string> =>
  Object.values(record).every((value) => typeof value === 'string');

/** Take the passphrase's seal off: the board's secrets, in memory. The
 *  caller wipes them. No guess limit applies: the passphrase guards a file
 *  its guesser already holds. */
function unseal(
  raw: string,
  passphrase: string
): { bundle: Bundle; contents: BackupContents } {
  const bundle = parseBundle(raw);
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    deriveKey(passphrase, Buffer.from(bundle.salt, 'base64')),
    Buffer.from(bundle.iv, 'base64')
  );
  decipher.setAAD(header(bundle));
  decipher.setAuthTag(Buffer.from(bundle.tag, 'base64'));
  let plain: Buffer;
  try {
    plain = Buffer.concat([
      decipher.update(Buffer.from(bundle.data, 'base64')),
      decipher.final()
    ]);
  } catch {
    throw new Error('Wrong backup passphrase, or the file was changed.');
  }
  let archive: unknown;
  try {
    archive = JSON.parse(plain.toString('utf-8'));
  } catch {
    throw new Error(NOT_A_BACKUP);
  } finally {
    plain.fill(0);
  }
  if (
    !isRecord(archive) ||
    !isRecord(archive.secrets) ||
    !allStrings(archive.secrets) ||
    !isRecord(archive.meta) ||
    !isRecord(archive.files) ||
    !allStrings(archive.files)
  ) {
    throw new Error(NOT_A_BACKUP);
  }
  return {
    bundle,
    contents: {
      values: archive.secrets,
      // A backup file can be made by anyone: every description is read as
      // the store reads its own, text fields only.
      meta: Object.fromEntries(
        Object.entries(archive.meta).map(([key, row]) => [
          key,
          normalizeMeta(row)
        ])
      ),
      files: Object.entries(archive.files)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, data]) => ({ name, data: Buffer.from(data, 'base64') }))
    }
  };
}

/** A file secret larger than this is named but not sent to the page: it is
 *  one message on the owner's link, and nobody reads a key that size by eye.
 *  Restore the backup on the runner to get at one. */
const BACKUP_FILE_VIEW_MAX = 1024 * 1024;

/** Read a backup's secrets, for its owner. It takes the file and its
 *  passphrase, and nothing else. No board is read, written or changed, and
 *  nothing touches the disk. */
export function openSecretsBackup(opts: {
  bundle: string;
  passphrase: string;
}): OpenedSecretsBackup {
  const { bundle, contents } = unseal(opts.bundle, opts.passphrase);
  try {
    return {
      board: bundle.board,
      createdAt: bundle.createdAt,
      secrets: Object.keys(contents.values)
        .sort()
        .map((name) => ({
          name,
          value: contents.values[name]!,
          description:
            contents.meta[name]?.description || contents.meta[name]?.title || ''
        })),
      files: contents.files.map(({ name, data }) => ({
        name,
        size: data.length,
        data:
          data.length > BACKUP_FILE_VIEW_MAX ? null : data.toString('base64')
      }))
    };
  } finally {
    wipe(contents);
  }
}

/** What an import needs from the owner: the file, its passphrase, and the
 *  board it goes into. */
type ImportOpts = {
  bundle: string;
  passphrase: string;
  spaceDir: string;
};

/** A backup beside the board it would be imported into: names, masked tails
 *  and sizes. Nothing is written. `targetKey` opens the board's store, after
 *  the backup has opened; null for a board with no store yet. */
export async function planSecretsBackupImport(
  opts: ImportOpts & { targetKey: (() => Promise<string>) | null }
): Promise<SecretsBackupImportPlan> {
  const { bundle, contents } = unseal(opts.bundle, opts.passphrase);
  try {
    const identity = opts.targetKey ? await opts.targetKey() : null;
    return {
      board: bundle.board,
      createdAt: bundle.createdAt,
      ...(await compareBackupWithStore(contents, opts.spaceDir, identity))
    };
  } finally {
    wipe(contents);
  }
}

type Imported = {
  board: string;
  createdAt: string;
  secrets: string[];
  files: string[];
};

/** Import the picked secrets into the board (host-secrets.ts
 *  `importBackupIntoStore`). Answers with the names written, never a value. */
export async function applySecretsBackupImport(
  opts: ImportOpts & {
    targetKey: () => Promise<string>;
    secrets: unknown;
    files: unknown;
  }
): Promise<Imported> {
  const { bundle, contents } = unseal(opts.bundle, opts.passphrase);
  try {
    return {
      board: bundle.board,
      createdAt: bundle.createdAt,
      ...(await importBackupIntoStore(contents, opts.spaceDir, opts.targetKey, {
        secrets: opts.secrets,
        files: opts.files
      }))
    };
  } finally {
    wipe(contents);
  }
}

/** Open a board's store with its password, or create it under that password
 *  when the board has none (as `initSecrets` makes one). */
export function storeKeyFor(
  spaceDir: string,
  password: unknown,
  hasStore: boolean
): () => Promise<string> {
  const configDir = spaceKeyDir(spaceDir);
  return async () => {
    if (typeof password !== 'string' || password === '') {
      throw new Error(
        hasStore
          ? 'Type this board’s password to import into it.'
          : 'Set a password for this board to import into it.'
      );
    }
    if (!hasStore) await initSecrets(configDir, password);
    return unwrapIdentity(configDir, password);
  };
}

/** Put a whole backup into a board that has no secrets: a new store under
 *  `password`, then every secret of the backup imported into it. Never into
 *  a board that holds any (boardHoldsSecrets). */
export async function restoreSecretsBackup(opts: {
  spaceDir: string;
  bundle: string;
  passphrase: string;
  password: string;
}): Promise<Imported> {
  const { bundle, contents } = unseal(opts.bundle, opts.passphrase);
  try {
    if (await boardHoldsSecrets(opts.spaceDir)) {
      throw new Error(
        'This board already has secrets. A backup is only restored into a board that has none.'
      );
    }
    const pick = (name: string) => ({ name });
    return {
      board: bundle.board,
      createdAt: bundle.createdAt,
      ...(await importBackupIntoStore(
        contents,
        opts.spaceDir,
        storeKeyFor(opts.spaceDir, opts.password, false),
        {
          secrets: Object.keys(contents.values).map(pick),
          files: contents.files.map((f) => pick(f.name))
        }
      ))
    };
  } finally {
    wipe(contents);
  }
}
