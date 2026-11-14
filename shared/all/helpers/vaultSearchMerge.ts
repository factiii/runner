// Oakbox's search across vaults (.specs/runner-vault.md "Search across
// vaults"): the cloud vault and every runner Vault the person reaches answer
// the same query at once, and the app shows one list.
//
// Every source ranks with the same model (bge-base-en-v1.5, 768-d) and the
// same `<=>`, so one source's distance means what another's does. A file whose
// name or text has the words carries no distance and ranks as 0: it beats any
// meaning match, as it does inside each source.

/** How long a runner gets to answer one query, from when it is asked: the
 *  link (when it is not up yet), the query embedded on the runner and the
 *  ranking. Long enough for the first search after the embedder went idle,
 *  which waits for it to start (about 10 s on Linux, 1.3 s on a Mac), and the
 *  same as a dial's wait. Past this it drops out with a note, and the cloud's
 *  list stands alone. */
export const RUNNER_VAULT_SEARCH_TIMEOUT_MS = 20_000;

/**
 * Which of the three stores a merged row is from (.specs/vault-router.md →
 * Privacy levels). `vault`: the runner's Vault, local AI only, never on
 * Factiii's servers. `runner`: Runner Cloud, on the runner with outside AI
 * allowed. `cloud`: Factiii's server. A runner tags each row it answers
 * with its own store (RunnerVaultFile.store); the server side is Cloud.
 */
export type VaultStore = 'vault' | 'runner' | 'cloud';

/** The stores a runner answers from. */
export type RunnerStore = Exclude<VaultStore, 'cloud'>;

/** What a runner's row is from when the runner does not say: a runner from
 *  before Runner Cloud has only its Vault. */
export const RUNNER_HIT_STORE: RunnerStore = 'vault';

/** One source's hit with what it ranks by. */
type RankedHit<T> = { item: T; distance: number | null };

/**
 * One list out of several sources' hits, nearest first. A word match ranks
 * as distance 0. Ties keep the order the sources were given in, and inside a
 * source the order it answered in, so the cloud's own list (given first) is
 * never reshuffled by a runner's answer arriving.
 */
export function mergeByDistance<T extends { store: VaultStore }>(
  sources: readonly (readonly RankedHit<T>[])[]
): T[] {
  return sources
    .flatMap((hits, source) =>
      hits.map((hit, index) => ({ hit, source, index }))
    )
    .sort(
      (a, b) =>
        (a.hit.distance ?? 0) - (b.hit.distance ?? 0) ||
        a.source - b.source ||
        a.index - b.index
    )
    .map(({ hit }) => hit.item);
}

/**
 * The one icon at the end of a merged row, which says the store it is from.
 * `icon` and `tone` are drawn by each app's StoreMark: the Vault a subdued
 * red lock, Runner Cloud a lock in the normal text color, Cloud a cloud.
 * `title` is the tooltip and `label` the a11y label. `explainer` is the one
 * line the mark's sheet opens on, over Move to… (.specs/vault.md "Store marks
 * and Move to…").
 */
export const STORE_MARKS: Record<
  VaultStore,
  {
    icon: 'lock' | 'cloud';
    tone: 'vault' | 'text' | 'muted';
    title: string;
    label: string;
    explainer: string;
  }
> = {
  vault: {
    icon: 'lock',
    tone: 'vault',
    title: 'Vault',
    label: 'In your Vault: kept on your machine, never in the Cloud',
    explainer:
      'Encrypted on your computer. Only you can open it, and only private AI on your computer can read it.'
  },
  runner: {
    icon: 'lock',
    tone: 'text',
    title: 'Runner Cloud',
    label: 'In Runner Cloud: kept on your machine, outside AI allowed',
    explainer:
      'On your computer. Any AI you choose can read it, and you can share it.'
  },
  cloud: {
    icon: 'cloud',
    tone: 'muted',
    title: 'Cloud',
    label: 'In the Cloud',
    explainer: 'In the Cloud. Synced everywhere.'
  }
};

/** Why a runner is missing from a search, in the small line under it. */
export type RunnerSearchDrop =
  | 'slow'
  | 'offline'
  | 'refused'
  | 'outdated'
  | 'unsupported';

export function runnerSearchNote(name: string, drop: RunnerSearchDrop): string {
  switch (drop) {
    case 'slow':
      return `${name} did not answer in ${RUNNER_VAULT_SEARCH_TIMEOUT_MS / 1000} s, so its files are not in this list.`;
    case 'offline':
      return `${name} could not be reached, so its files are not in this list.`;
    case 'refused':
      return `${name} did not let this search in.`;
    case 'outdated':
      return `${name} needs a runner update to be searched from here.`;
    case 'unsupported':
      return `This app cannot reach ${name} directly. Update Oakbox to search it.`;
  }
}

/** A runner hit's line under its name: the folder, then which machine. */
export const runnerHitWhere = (folder: string, runnerName: string): string =>
  folder ? `${folder} · on ${runnerName}` : `On ${runnerName}`;
