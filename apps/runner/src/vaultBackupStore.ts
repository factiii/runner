import type {
  BoardAgentActionMap,
  RunnerVaultBackupItem
} from '@shared/all/domains/electron';
import {
  isRunnerVaultBackupChunk,
  isSafeRunnerVaultBackupName,
  isSafeRunnerVaultUploadId,
  RUNNER_VAULT_BACKUP_DIR,
  RUNNER_VAULT_BACKUP_KEEP,
  RUNNER_VAULT_BACKUP_MAX_BYTES,
  RUNNER_VAULT_BACKUP_READ_CHUNK_BYTES,
  RUNNER_VAULT_BACKUP_STALE_UPLOAD_MS,
  runnerVaultBackupName,
  runnerVaultBackupsToPrune,
  runnerVaultWriteRefusal,
  sortRunnerVaultBackupNames
} from '@shared/all/helpers/runnerVaultBackup';
import fs from 'fs';
import path from 'path';

// The owner's phone vault, held by this runner (.specs/mobile-vault.md "Runner backup").
//
// Runner-wide: `<runner dir>/vault-backups`, beside access.json and not inside
// any board's folder, because the package belongs to the person who owns the
// runner and to no board on it. The daemon answers these actions itself,
// before any per-board dispatch, and only on the owner's channel.
//
// What is stored is the package the phone already uploads to our bucket:
// ciphertext plus the key wrapped under the owner's passphrase. The runner is
// never sent the passphrase or the key, so it holds the file and cannot open it.

/** The actions the daemon answers here, before any per-board dispatch. */
export const VAULT_BACKUP_ACTIONS = new Set<keyof BoardAgentActionMap>([
  'vaultBackupWrite',
  'vaultBackupList',
  'vaultBackupReadChunk',
  'vaultBackupDelete'
]);

/** An upload in progress. Never a backup name, so a half-sent package is
 *  never listed, read, restored or counted by retention. */
const PART_SUFFIX = '.part';

/** Only the runner user: the folder, and every file in it. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export type VaultBackupLimits = {
  maxBytes: number;
  keep: number;
  staleUploadMs: number;
};

const DEFAULT_LIMITS: VaultBackupLimits = {
  maxBytes: RUNNER_VAULT_BACKUP_MAX_BYTES,
  keep: RUNNER_VAULT_BACKUP_KEEP,
  staleUploadMs: RUNNER_VAULT_BACKUP_STALE_UPLOAD_MS
};

export class VaultBackupStore {
  private readonly dir: string;
  private readonly limits: VaultBackupLimits;

  /**
   * @param runnerDir The runner's own state dir (CONFIG_DIR).
   * @param limits    The caps. Overridable so a test does not have to write
   *                  512MB to reach one.
   * @param now       The clock a stored name is picked from.
   */
  constructor(
    runnerDir: string,
    limits: Partial<VaultBackupLimits> = {},
    private readonly now: () => number = Date.now
  ) {
    this.dir = path.join(runnerDir, RUNNER_VAULT_BACKUP_DIR);
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /** Every finished package, newest first. */
  list(): RunnerVaultBackupItem[] {
    const items: RunnerVaultBackupItem[] = [];
    for (const name of sortRunnerVaultBackupNames(this.entries())) {
      const stat = this.statFile(path.join(this.dir, name));
      if (!stat) continue;
      items.push({ name, size: stat.size, modifiedAt: stat.mtimeMs });
    }
    return items;
  }

  /**
   * Append one chunk to an upload, and finish it on `last`.
   *
   * The chunks land in `<uploadId>.part` and only a rename makes them a
   * backup, so a package is either whole or absent: a link that drops halfway
   * leaves nothing a restore could pick up. Any refusal past the first checks
   * deletes the part file, so a client that gets an error starts again from 0
   * rather than appending to something it can no longer describe.
   */
  write(
    p: BoardAgentActionMap['vaultBackupWrite']['payload']
  ): BoardAgentActionMap['vaultBackupWrite']['result'] {
    // Before anything touches the disk: the id is about to be a file name.
    if (!isSafeRunnerVaultUploadId(p?.uploadId)) {
      throw new Error('Invalid vault backup upload id.');
    }
    if (!isRunnerVaultBackupChunk(p.content)) {
      throw new Error('Invalid vault backup chunk.');
    }
    const part = path.join(this.dir, `${p.uploadId}${PART_SUFFIX}`);
    try {
      const bytes = Buffer.from(p.content, 'base64');
      const refusal = runnerVaultWriteRefusal(
        p.offset,
        bytes.length,
        this.limits.maxBytes
      );
      if (refusal) throw new Error(refusal);

      fs.mkdirSync(this.dir, { recursive: true, mode: DIR_MODE });
      // mkdir applies a mode only on create, so an existing dir is tightened too.
      fs.chmodSync(this.dir, DIR_MODE);
      if (p.offset === 0) {
        this.removeStaleUploads();
        fs.writeFileSync(part, bytes, { mode: FILE_MODE });
      } else {
        // The client says how much it has sent; the file says how much
        // arrived. A lost or repeated chunk shows up here, not as a package
        // that fails to decrypt on the day it is needed.
        const stored = this.statFile(part)?.size;
        if (stored !== p.offset) {
          throw new Error(
            'This vault backup upload is out of step with the runner. Start it again.'
          );
        }
        fs.appendFileSync(part, bytes);
      }
      const received = p.offset + bytes.length;
      if (!p.last) return { name: null, received };

      if (p.size !== received) {
        throw new Error(
          'The runner received a different amount than the vault backup holds. Start it again.'
        );
      }
      const name = this.claimName();
      fs.renameSync(part, path.join(this.dir, name));
      this.prune();
      return { name, received };
    } catch (err) {
      fs.rmSync(part, { force: true });
      throw err;
    }
  }

  /** One byte range of a package, base64. What a restore is built out of. */
  readChunk(
    p: BoardAgentActionMap['vaultBackupReadChunk']['payload']
  ): BoardAgentActionMap['vaultBackupReadChunk']['result'] {
    const file = this.resolve(p?.name);
    if (!Number.isInteger(p.offset) || p.offset < 0) {
      throw new Error('Invalid vault backup offset.');
    }
    if (
      !Number.isInteger(p.length) ||
      p.length <= 0 ||
      p.length > RUNNER_VAULT_BACKUP_READ_CHUNK_BYTES
    ) {
      throw new Error('Invalid vault backup chunk length.');
    }
    if (!this.statFile(file)) throw new Error('No such vault backup.');
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(p.length);
      const read = fs.readSync(fd, buffer, 0, p.length, p.offset);
      return {
        content: buffer.subarray(0, read).toString('base64'),
        encoding: 'base64'
      };
    } finally {
      fs.closeSync(fd);
    }
  }

  remove(p: BoardAgentActionMap['vaultBackupDelete']['payload']): void {
    fs.rmSync(this.resolve(p?.name), { force: true });
  }

  /** Absolute path for a stored name. Flat by construction: the name is one
   *  the runner made, never joined with anything a caller chose. */
  private resolve(name: unknown): string {
    if (!isSafeRunnerVaultBackupName(name)) {
      throw new Error('Invalid vault backup name.');
    }
    return path.join(this.dir, name);
  }

  private entries(): string[] {
    try {
      return fs.readdirSync(this.dir);
    } catch {
      // Nothing has been pushed here yet.
      return [];
    }
  }

  /** A regular file's stat, or null. `lstat`, so a symlink somebody left in
   *  the folder is not followed out of it. */
  private statFile(file: string): fs.Stats | null {
    try {
      const stat = fs.lstatSync(file);
      return stat.isFile() ? stat : null;
    } catch {
      return null;
    }
  }

  /** A name from this runner's clock that nothing holds yet. Two packages
   *  landing in one millisecond get consecutive ones. */
  private claimName(): string {
    let at = this.now();
    while (fs.existsSync(path.join(this.dir, runnerVaultBackupName(at)))) {
      at += 1;
    }
    return runnerVaultBackupName(at);
  }

  /** Keep the newest few. After the rename, so the package that just landed
   *  is counted and a failed upload never costs an older one. */
  private prune(): void {
    for (const name of runnerVaultBackupsToPrune(
      this.entries(),
      this.limits.keep
    )) {
      fs.rmSync(path.join(this.dir, name), { force: true });
    }
  }

  /** Uploads that were abandoned: the phone was closed, or the link went and
   *  never came back. Checked when a new one starts, so nothing needs a timer. */
  private removeStaleUploads(): void {
    const cutoff = this.now() - this.limits.staleUploadMs;
    for (const entry of this.entries()) {
      if (!entry.endsWith(PART_SUFFIX)) continue;
      const file = path.join(this.dir, entry);
      const stat = this.statFile(file);
      if (stat && stat.mtimeMs < cutoff) fs.rmSync(file, { force: true });
    }
  }
}

/** Run one vault backup action against `store` and return what to answer. */
export function runVaultBackupAction(
  store: VaultBackupStore,
  action: keyof BoardAgentActionMap,
  payload: unknown
): unknown {
  switch (action) {
    case 'vaultBackupWrite':
      return store.write(
        payload as BoardAgentActionMap['vaultBackupWrite']['payload']
      );
    case 'vaultBackupList':
      return { backups: store.list() };
    case 'vaultBackupReadChunk':
      return store.readChunk(
        payload as BoardAgentActionMap['vaultBackupReadChunk']['payload']
      );
    case 'vaultBackupDelete':
      store.remove(
        payload as BoardAgentActionMap['vaultBackupDelete']['payload']
      );
      return undefined;
    default:
      throw new Error(`Unhandled vault backup action: ${action}`);
  }
}
