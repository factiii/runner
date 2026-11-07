// The rules for a vault backup held on a runner. See
// .specs/mobile-vault.md "Runner backup".
//
// Pure, and imported by both ends: the runner's store enforces these, and the
// phone uses the same numbers to size its chunks and to refuse a package the
// runner would refuse anyway, before sending half a gigabyte of it.

/** The folder under the runner's own directory. Runner-wide, never a space's
 *  `backups/`: the package is the runner OWNER's, and a space's folders are
 *  what its agents and its members are pointed at. */
export const RUNNER_VAULT_BACKUP_DIR = 'vault-backups';

/** One package. The same figure as the scratchpad's download cap, because the
 *  package comes back the same way: a range at a time, into a file. */
export const RUNNER_VAULT_BACKUP_MAX_BYTES = 512 * 1024 * 1024;

/** How many packages a runner keeps. Pruned after a write lands, oldest first. */
export const RUNNER_VAULT_BACKUP_KEEP = 3;

/** Raw bytes per write. Base64 inflates by 4/3, so this is ~512K characters a
 *  call: the size a dropped image already goes up in (the relay drops a packet
 *  over 1MB). A multiple of 3, so no chunk but the last ends in padding. */
export const RUNNER_VAULT_BACKUP_WRITE_CHUNK_BYTES = 384 * 1024;

/** Bytes per range on the way back, and the most a runner hands out per call.
 *  The scratchpad's figure, for the scratchpad's reasons. */
export const RUNNER_VAULT_BACKUP_READ_CHUNK_BYTES = 512 * 1024;

/** The most base64 a runner decodes in one write. Twice what a client sends,
 *  so a client may grow its chunk without a runner release, while one call
 *  still cannot make the runner hold the whole cap in memory. */
export const RUNNER_VAULT_BACKUP_WRITE_MAX_CHARS =
  Math.ceil((RUNNER_VAULT_BACKUP_WRITE_CHUNK_BYTES * 2 * 4) / 3) + 4;

/** An upload nobody finished is deleted once it is this old, the next time
 *  any upload starts. */
export const RUNNER_VAULT_BACKUP_STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;

/** How an engine answers an action it has never heard of. A runner older than
 *  this feature says exactly this to `vaultBackupList`, which is how the app
 *  knows to ask for an update rather than report a failure. */
export const RUNNER_UNKNOWN_ACTION_PREFIX = 'Unknown board-agent action';

const NAME_PATTERN = /^vault-backup-(\d{13})\.zip$/;
const UPLOAD_ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,63}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** The stored name for a package that landed at `timestampMs`. The runner
 *  picks it from its own clock: a client never names a file. */
export function runnerVaultBackupName(timestampMs: number): string {
  return `vault-backup-${String(Math.trunc(timestampMs)).padStart(13, '0')}.zip`;
}

/**
 * A name the runner will read or delete. Stricter than the scratchpad's guard
 * because nothing here is agent-written: the only names that exist are the
 * ones `runnerVaultBackupName` made, so anything else is not a backup.
 */
export function isSafeRunnerVaultBackupName(name: unknown): name is string {
  return typeof name === 'string' && NAME_PATTERN.test(name);
}

/** When a package landed, by its name. Null for anything that is not one. */
export function runnerVaultBackupTimestamp(name: string): number | null {
  const match = NAME_PATTERN.exec(name);
  return match ? Number(match[1]) : null;
}

/** The client's handle on one upload. It becomes part of a temp file's name,
 *  so it is held to lowercase letters, digits and dashes (a UUID fits). */
export function isSafeRunnerVaultUploadId(id: unknown): id is string {
  return typeof id === 'string' && UPLOAD_ID_PATTERN.test(id);
}

/** Whether `content` is base64 the runner will decode: the right alphabet,
 *  and no longer than one write may be. */
export function isRunnerVaultBackupChunk(content: unknown): content is string {
  return (
    typeof content === 'string' &&
    content.length > 0 &&
    content.length <= RUNNER_VAULT_BACKUP_WRITE_MAX_CHARS &&
    BASE64_PATTERN.test(content)
  );
}

/**
 * Why a chunk of `chunkBytes` may not be appended to an upload already holding
 * `storedBytes`, or null when it may. Checked against the total on disk, not
 * per chunk, so the chunks cannot add up past the cap.
 */
export function runnerVaultWriteRefusal(
  storedBytes: number,
  chunkBytes: number,
  maxBytes = RUNNER_VAULT_BACKUP_MAX_BYTES
): string | null {
  if (!Number.isInteger(storedBytes) || storedBytes < 0) {
    return 'Invalid vault backup offset.';
  }
  if (!Number.isInteger(chunkBytes) || chunkBytes <= 0) {
    return 'A vault backup chunk cannot be empty.';
  }
  if (storedBytes + chunkBytes > maxBytes) {
    return `This vault backup is larger than the ${Math.floor(maxBytes / (1024 * 1024))} MB a runner stores.`;
  }
  return null;
}

/** Stored names, newest first. Anything that is not a backup name is left out. */
export function sortRunnerVaultBackupNames(names: string[]): string[] {
  return names
    .filter(isSafeRunnerVaultBackupName)
    .sort(
      (a, b) =>
        (runnerVaultBackupTimestamp(b) ?? 0) -
        (runnerVaultBackupTimestamp(a) ?? 0)
    );
}

/**
 * The stored names retention removes: everything past the newest `keep`.
 * Ordered by the timestamp in the name, never by mtime, which a copy or a
 * restore of the runner's own disk rewrites. A name that is not a backup is
 * never returned, so this cannot be talked into deleting anything else.
 */
export function runnerVaultBackupsToPrune(
  names: string[],
  keep = RUNNER_VAULT_BACKUP_KEEP
): string[] {
  return sortRunnerVaultBackupNames(names).slice(Math.max(0, keep));
}

/** Whether a runner's answer means it predates these actions. */
export function isRunnerVaultBackupUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.includes(RUNNER_UNKNOWN_ACTION_PREFIX);
}
