import { formatBytes } from '../domains/oakbox';
import type { RunnerStore, VaultStore } from './vaultSearchMerge';

// Move to… (.specs/vault.md "The three places", "Store marks and Move to…"):
// one item from the store it is in to another, explicit and never
// automatic: copied there, then deleted where it was. A copy that does not
// land leaves the original where it was.
//
// - Vault ⇄ Runner Cloud: on the runner, in one call (`vaultMove`).
// - Runner Cloud → Cloud: the app pulls the file off the runner over the
//   direct link and adds it to the Cloud as any added file goes (the storage
//   plan checked first, and again by the server), then deletes it on the
//   runner once the Cloud holds the bytes.
// - Cloud → Runner Cloud or Vault: the app fetches the Cloud copy, sends it
//   to the runner over the direct link, then deletes it from the Cloud.
// - Vault → Cloud is not offered: the Vault never leaves the runner (rule 3).
//
// The logic is here, the I/O is each app's (`MoveIO`), so web and phone move
// the same way.

/** Where an item can be moved to from `from`. Cloud → the runner only with a
 *  computer chosen; nothing from the Vault to the Cloud, and nothing to the
 *  Cloud at all with `cloud: false` (Runner mode, which uses nothing of
 *  Factiii's content: `onRunner`). */
export function moveTargets(
  from: VaultStore,
  { runner, cloud = true }: { runner: boolean; cloud?: boolean }
): VaultStore[] {
  switch (from) {
    case 'vault':
      return ['runner'];
    case 'runner':
      return cloud ? ['vault', 'cloud'] : ['vault'];
    case 'cloud':
      return runner ? ['runner', 'vault'] : [];
  }
}

/** Each target's button in the mark's sheet. */
export const MOVE_LABEL: Record<VaultStore, string> = {
  vault: 'Move to Vault',
  runner: 'Move to Runner Cloud',
  cloud: 'Move to Cloud'
};

/** Under the buttons on a Vault item: why the Cloud is not there. */
export const VAULT_STAYS_NOTE =
  'A Vault item never goes to the Cloud. Move it to Runner Cloud first if you want it there.';

/** Under the buttons where nothing can be moved. */
export const MOVE_NOT_YOURS = 'Only the person who added it can move it.';
export const MOVE_PUBLISHED =
  'This file is published. Take the post down to move it.';
export const MOVE_SYNCED =
  'This file is synced from your OneDrive, so it stays in the Cloud.';
export const MOVE_NO_RUNNER =
  'Add your computer in Account > Backend to keep files in Runner Cloud or your Vault.';

/** Why an item cannot move at all, when it cannot. */
export type MoveBlock = 'notYours' | 'published' | 'synced';

export const MOVE_BLOCK_NOTE: Record<MoveBlock, string> = {
  notYours: MOVE_NOT_YOURS,
  published: MOVE_PUBLISHED,
  synced: MOVE_SYNCED
};

/** A Cloud file that cannot move: another account's in a shared vault, one
 *  published (moving it would take a public post down), or one synced from
 *  OneDrive (the next sync would write it back). */
export function cloudMoveBlock(file: {
  addedBy: unknown;
  published?: boolean;
  uploadSource?: string | null;
}): MoveBlock | null {
  if (file.addedBy !== null && file.addedBy !== undefined) return 'notYours';
  if (file.published) return 'published';
  if (file.uploadSource && file.uploadSource !== 'S3') return 'synced';
  return null;
}

/** A runner file that cannot move: one on a runner shared with the reader,
 *  or one someone else added. Only the runner's owner moves (`vaultMove`). */
export function runnerMoveBlock(hit: {
  mine?: boolean;
  runner: { shared?: boolean };
}): MoveBlock | null {
  return hit.runner.shared || hit.mine === false ? 'notYours' : null;
}

/** The Cloud's answer before a move there: no room on the plan. */
export const cloudNoRoom = (bytes: number, leftBytes: number): string =>
  leftBytes <= 0
    ? 'Your Cloud storage is full. Upgrade your storage plan, or free some space, to move this to the Cloud. Runner Cloud is free.'
    : `This needs ${formatBytes(bytes)} and your Cloud storage has ${formatBytes(leftBytes)} left. Upgrade your storage plan to move it, or keep it in Runner Cloud, which is free.`;

/** Room left in the Cloud from the storage answer (`onedriveEmbed.storage`):
 *  what uploads are refused at, the plan plus its small overage. */
export const cloudLeftBytes = (storage: {
  usedBytes: number;
  ceilingBytes: number;
}): number => Math.max(0, storage.ceilingBytes - storage.usedBytes);

/** One item to move: its id where it is, its name (folders and all), its
 *  size when known, and the store it is in. */
export type MoveItem = {
  id: string;
  name: string;
  size: number | null;
  store: VaultStore;
};

/** The store on the runner an item is in, for the runner's own actions on
 *  it (download, delete): named, so a Runner Cloud item never waits on a
 *  locked Vault. None for a Cloud item. */
export const runnerStoreOf = (item: MoveItem): RunnerStore | undefined =>
  item.store === 'cloud' ? undefined : item.store;

/** The app's half of a move. Each copy resolves once the other side holds
 *  the bytes, and throws when it does not. */
export type MoveIO = {
  /** Between the runner's two stores, on the runner (`vaultMove`). */
  runnerMove: (
    ids: string[],
    to: RunnerStore
  ) => Promise<{
    moved: { from: string }[];
    failed: { uploadId: string; error: string }[];
  }>;
  /** Bytes left in the Cloud, or null when it cannot be told (the server
   *  still refuses at the ceiling). */
  cloudRoom: () => Promise<number | null>;
  copyToCloud: (item: MoveItem) => Promise<void>;
  copyToRunner: (item: MoveItem, to: RunnerStore) => Promise<void>;
  deleteFromRunner: (item: MoveItem) => Promise<void>;
  deleteFromCloud: (item: MoveItem) => Promise<void>;
};

export type MoveResult = {
  moved: string[];
  failed: { id: string; name: string; error: string }[];
};

const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** The original stayed because its copy landed but the delete did not. */
const copiedNotRemoved = (to: VaultStore, err: unknown): string =>
  `Copied to ${STORE_NAME[to]}, but the original could not be removed: ${messageOf(err)} Delete it yourself, or try again.`;

const STORE_NAME: Record<VaultStore, string> = {
  vault: 'your Vault',
  runner: 'Runner Cloud',
  cloud: 'the Cloud'
};

/** Move each item to `to`, one at a time. What moved, and why any did not. */
export async function moveItems(
  items: MoveItem[],
  to: VaultStore,
  io: MoveIO,
  { runner, cloud = true }: { runner: boolean; cloud?: boolean }
): Promise<MoveResult> {
  const result: MoveResult = { moved: [], failed: [] };
  const fail = (item: MoveItem, error: string) =>
    result.failed.push({ id: item.id, name: item.name, error });

  const movable = items.filter((item) => {
    if (item.store === to) return false;
    if (moveTargets(item.store, { runner, cloud }).includes(to)) return true;
    fail(
      item,
      item.store === 'vault' && to === 'cloud'
        ? VAULT_STAYS_NOTE
        : `${MOVE_LABEL[to]} is not offered for this item.`
    );
    return false;
  });

  // On the runner: both stores are its own, so it moves them in one call.
  const onRunner = movable.filter(
    (item) => item.store !== 'cloud' && to !== 'cloud'
  );
  if (onRunner.length > 0) {
    try {
      const answer = await io.runnerMove(
        onRunner.map((item) => item.id),
        to as RunnerStore
      );
      const moved = new Set(answer.moved.map((m) => m.from));
      const why = new Map(answer.failed.map((f) => [f.uploadId, f.error]));
      for (const item of onRunner) {
        if (moved.has(item.id)) result.moved.push(item.id);
        else fail(item, why.get(item.id) ?? 'The runner did not move it.');
      }
    } catch (err) {
      for (const item of onRunner) fail(item, messageOf(err));
    }
  }

  // To the Cloud: the plan is checked for the lot before anything is sent.
  const toCloud = movable.filter(
    (item) => to === 'cloud' && item.store !== 'cloud'
  );
  if (toCloud.length > 0) {
    const bytes = toCloud.reduce((sum, item) => sum + (item.size ?? 0), 0);
    const left = await io.cloudRoom().catch(() => null);
    if (left !== null && bytes > left) {
      for (const item of toCloud) fail(item, cloudNoRoom(bytes, left));
    } else {
      for (const item of toCloud) {
        try {
          await io.copyToCloud(item);
        } catch (err) {
          fail(item, messageOf(err));
          continue;
        }
        try {
          await io.deleteFromRunner(item);
          result.moved.push(item.id);
        } catch (err) {
          fail(item, copiedNotRemoved(to, err));
        }
      }
    }
  }

  // From the Cloud to the runner.
  const fromCloud = movable.filter((item) => item.store === 'cloud');
  for (const item of fromCloud) {
    try {
      await io.copyToRunner(item, to as RunnerStore);
    } catch (err) {
      fail(item, messageOf(err));
      continue;
    }
    try {
      await io.deleteFromCloud(item);
      result.moved.push(item.id);
    } catch (err) {
      fail(item, copiedNotRemoved(to, err));
    }
  }
  return result;
}

/** One line for the toast after a move. */
export function moveSummary(result: MoveResult, to: VaultStore): string {
  if (result.failed.length === 0) {
    return result.moved.length === 1
      ? `Moved to ${STORE_NAME[to]}.`
      : `Moved ${result.moved.length} items to ${STORE_NAME[to]}.`;
  }
  return result.failed[0]!.error;
}

/** A Cloud upload job as the drop queue answers it
 *  (`onedriveEmbed.dropProgress.items`). */
type DropJob = { jobId: string; phase: string; uploadId?: string | null };

/** Whether the Cloud holds the bytes of the job a move added: past the
 *  upload (queued, being read, done) or with its row made. A job not in the
 *  answer, or still uploading, or failed with no row, does not count, so the
 *  original stays. */
export const cloudHoldsJob = (
  items: readonly DropJob[],
  jobId: string
): boolean => {
  const job = items.find((item) => item.jobId === jobId);
  if (!job) return false;
  if (job.uploadId) return true;
  return job.phase !== 'uploading' && job.phase !== 'error';
};
