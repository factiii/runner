import fs from 'node:fs';
import path from 'node:path';

import type { RunnerCleanupItem, RunnerDiskUse } from '@shared/all/domains/electron';

// Free up space beyond what the runner made (.specs/runner-setup.md "Machine
// health and Free up space"): the caches of the tools every board uses, each cleared by that
// tool's own command (or, for Xcode's build output, one fixed folder), and
// a read of the biggest folders so the owner sees what else holds the disk.
// A run clears only caches of a fresh plan, by id; never a path the client
// sent. Nothing here removes what a board, a person or a VM keeps.

type Run = (
  bin: string,
  args: string[],
  opts?: { timeoutMs?: number; cwd?: string }
) => Promise<{ code: number; output: string }>;

export type DiskIo = {
  home: string;
  runnerDir: string;
  platform: NodeJS.Platform;
  run: Run;
  /** Bytes under a path (`du -sk`), 0 when it cannot be read. */
  size(p: string): Promise<number>;
  remove(p: string): void;
};

/** A cache under this is not worth a line. */
export const MIN_CACHE_BYTES = 100 * 1024 ** 2;
/** A folder under this is not one of the biggest. */
const MIN_USE_BYTES = 500 * 1024 ** 2;
/** The biggest folders shown. */
const MAX_USES = 12;
/** A cache's own clear can take minutes (a pnpm prune walks every file). */
const CLEAR_TIMEOUT_MS = 15 * 60_000;
const READ_TIMEOUT_MS = 10_000;
/** One folder's `du` gives up after this; the scan reads several at once. */
const DU_TIMEOUT_MS = 60_000;
const DU_AT_ONCE = 6;
const KIB = 1024;

const CACHE_PREFIX = 'cache:';
/** The mobile build jobs' local EAS build, which runs from npx's downloads
 *  and drives xcodebuild. */
const EAS_LOCAL_BUILD = 'eas-cli-local-build-plugin';

type Clear = { bin: string; args: string[] } | { remove: string };

type Cache = {
  id: string;
  title: string;
  /** `pgrep -f` pattern of what uses it while it runs: a clear then waits,
   *  so it never pulls files from under a build or a running program. */
  inUse?: { pattern: string; reason: string };
  /** Where it is, as the owner reads it ("~/Library/pnpm/store/v3"). */
  shown: string;
  bytes: number;
  /** A prune: `bytes` is what the cache holds, and only the unused part goes. */
  upTo: boolean;
  clear: Clear;
};

const tilde = (home: string, p: string) =>
  p === home || p.startsWith(`${home}${path.sep}`) ? `~${p.slice(home.length)}` : p;

const exists = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** pnpm's store layout version, by the pnpm major that writes it. pnpm 7–9
 *  write `v3`; 10 writes `v10`. A store is pruned by the pnpm that owns it,
 *  or it would drop the packages that pnpm's projects link. */
const PNPM_FOR_STORE: Record<string, string> = { v3: '9', v10: '10' };

/** `docker system df`'s build cache line ("Build Cache  10  0  498MB  0B"). */
export function buildCacheBytes(output: string): number {
  const m = /^Build Cache\s+\d+\s+\d+\s+([\d.]+)\s*([kKMGT]?B)/m.exec(output);
  if (!m) return 0;
  const unit = { B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[m[2]] ?? 0;
  return Math.round(Number(m[1]) * unit);
}

/** Every known cache on this machine, with what it holds now. */
async function findCaches(io: DiskIo): Promise<Cache[]> {
  const found: Cache[] = [];
  const add = async (
    id: string,
    title: string,
    dir: string,
    clear: Clear,
    upTo = false,
    inUse?: Cache['inUse']
  ) => {
    if (!exists(dir)) return;
    found.push({
      id,
      title,
      shown: tilde(io.home, dir),
      bytes: await io.size(dir),
      upTo,
      clear,
      ...(inUse ? { inUse } : {})
    });
  };

  // pnpm: each store version beside the one this pnpm uses.
  const store = await io.run('pnpm', ['store', 'path'], { timeoutMs: READ_TIMEOUT_MS, cwd: io.home });
  const storeDir = store.code === 0 ? store.output.trim().split('\n').pop() ?? '' : '';
  if (storeDir) {
    const root = path.dirname(storeDir);
    for (const [version, major] of Object.entries(PNPM_FOR_STORE)) {
      await add(
        `${CACHE_PREFIX}pnpm-${version}`,
        `pnpm ${major} store, packages no project uses`,
        path.join(root, version),
        { bin: 'npx', args: ['-y', `pnpm@${major}`, 'store', 'prune', '--store-dir', root] },
        true
      );
    }
  }
  await add(`${CACHE_PREFIX}npm`, 'npm download cache', path.join(io.home, '.npm', '_cacache'), {
    bin: 'npm',
    args: ['cache', 'clean', '--force']
  });
  // The packages `npx` fetched to run once; npm's clean leaves them, and
  // npx fetches one again when it is next run.
  const npx = path.join(io.home, '.npm', '_npx');
  // A dev server or a mobile build job (eas-cli-local-build-plugin) runs
  // from it, so it waits while anything does.
  await add(`${CACHE_PREFIX}npx`, 'npx downloads', npx, { remove: npx }, false, {
    pattern: `${EAS_LOCAL_BUILD}|/\\.npm/_npx/`,
    reason: 'something is running from it'
  });
  const brew = await io.run('brew', ['--cache'], { timeoutMs: READ_TIMEOUT_MS });
  if (brew.code === 0 && brew.output.trim()) {
    await add(
      `${CACHE_PREFIX}homebrew`,
      'Homebrew downloads and old versions',
      brew.output.trim().split('\n').pop() ?? '',
      { bin: 'brew', args: ['cleanup', '-s', '--prune=all'] }
    );
  }
  if (io.platform === 'darwin') {
    const derived = path.join(io.home, 'Library', 'Developer', 'Xcode', 'DerivedData');
    // An xcodebuild (an EAS local build runs one) is writing into it.
    await add(
      `${CACHE_PREFIX}xcode`,
      'Xcode build output (DerivedData)',
      derived,
      { remove: derived },
      false,
      { pattern: `xcodebuild|${EAS_LOCAL_BUILD}`, reason: 'a build is using it' }
    );
  }
  // OrbStack or Docker: the same command. Its build cache is rebuilt by the
  // next build that needs it; images, containers and volumes stay.
  const df = await io.run('docker', ['system', 'df'], { timeoutMs: READ_TIMEOUT_MS });
  const buildBytes = df.code === 0 ? buildCacheBytes(df.output) : 0;
  if (buildBytes > 0) {
    found.push({
      id: `${CACHE_PREFIX}containers-build`,
      title: 'Container build cache',
      shown: 'docker builder',
      bytes: buildBytes,
      upTo: false,
      clear: { bin: 'docker', args: ['builder', 'prune', '-f'] }
    });
  }
  return found.filter((c) => c.bytes >= MIN_CACHE_BYTES);
}

/** The caches Free up space can clear, as plan items. */
export async function cacheItems(io: DiskIo): Promise<RunnerCleanupItem[]> {
  return (await findCaches(io)).map((c) => ({
    id: c.id,
    title: c.title,
    path: c.shown,
    bytes: c.bytes,
    kind: 'cache' as const,
    ...(c.upTo ? { upTo: true } : {})
  }));
}

/** Clear one cache of a fresh plan by its id. Resolves whether it ran. */
export async function clearCache(
  io: DiskIo,
  id: string,
  onLine: (line: string) => void
): Promise<boolean> {
  const cache = (await findCaches(io)).find((c) => c.id === id);
  if (!cache) {
    onLine(`Left ${id}: it is no longer there.`);
    return false;
  }
  if (cache.inUse) {
    // pgrep exits 0 on a match, 1 on none.
    const busy = await io.run('pgrep', ['-f', cache.inUse.pattern], { timeoutMs: READ_TIMEOUT_MS });
    if (busy.code === 0) {
      onLine(`Left ${cache.title}: ${cache.inUse.reason}. Try again when it finishes.`);
      return false;
    }
  }
  if ('remove' in cache.clear) {
    try {
      io.remove(cache.clear.remove);
      onLine(`Cleared ${cache.title}.`);
      return true;
    } catch (err) {
      onLine(`Could not clear ${cache.title}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
  const res = await io.run(cache.clear.bin, cache.clear.args, {
    timeoutMs: CLEAR_TIMEOUT_MS,
    cwd: io.home
  });
  if (res.code !== 0) {
    const why = res.output.trim().split('\n').pop() ?? `exit ${res.code}`;
    onLine(`Could not clear ${cache.title}: ${why}`);
    return false;
  }
  onLine(`Cleared ${cache.title}.`);
  return true;
}

/** What a folder is, where its name alone does not say. */
const KNOWN: Record<string, string> = {
  '.tart': 'Tart virtual machines',
  '.orbstack': 'OrbStack',
  '.gradle': 'Gradle (Android builds)',
  '.npm': 'npm cache',
  '.nvm': 'Node versions (nvm)',
  '.cache': 'Tool caches',
  '.claude': 'Claude Code',
  '.docker': 'Docker CLI settings',
  'Library/pnpm': 'pnpm stores',
  'Library/Caches': 'App caches',
  'Library/Developer': 'Xcode and simulators',
  'Library/Containers': 'App data (sandboxed apps)',
  'Library/Group Containers': 'Shared app data (OrbStack’s disk is here)',
  'Library/Application Support': 'App data'
};

/** A board's own folders (spacePaths.ts), as the owner knows them. */
const BOARD_PARTS: Record<string, string> = {
  repo: 'clone',
  workspace: 'workspace',
  worktrees: 'worktrees (one per session)',
  jobs: 'job checkout',
  builds: 'builds',
  backups: 'backups',
  scratchpad: 'scratchpad'
};

/** The folders to weigh: each in the home folder, Library's children in its
 *  place, and in the runner folder's place each board's own folders (its
 *  clone, workspace, worktrees, job checkout, builds), where a board is
 *  big. */
export function diskUseCandidates(home: string, runnerDir: string): string[] {
  const children = (dir: string) => {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.isSymbolicLink())
        .map((e) => path.join(dir, e.name));
    } catch {
      return [];
    }
  };
  const library = path.join(home, 'Library');
  const runner = path.resolve(runnerDir);
  return children(home).flatMap((dir) => {
    if (dir === library) return children(library);
    if (path.resolve(dir) === runner) {
      return children(runner).flatMap((board) => {
        const own = children(board);
        return own.length ? own : [board];
      });
    }
    return [dir];
  });
}

/** A folder's line: what it is, and where. */
export function diskUseLabel(home: string, runnerDir: string, dir: string): string {
  const rel = path.relative(home, dir);
  const inRunner = path.relative(runnerDir, dir);
  if (!inRunner.startsWith('..') && !path.isAbsolute(inRunner)) {
    const [board, part] = inRunner.split(path.sep);
    const what = part ? (BOARD_PARTS[part] ?? part) : 'folder';
    return `${board}: ${what}`;
  }
  return KNOWN[rel.split(path.sep).join('/')] ?? path.basename(dir);
}

/** `du -sk <dir>`'s total for `dir`, in bytes. Its errors (a folder it may
 *  not read) land in the same output, so the line is found by its path. */
export function duBytes(output: string, dir: string): number {
  for (const line of output.split('\n')) {
    const m = /^(\d+)\t(.+)$/.exec(line);
    if (m && m[2] === dir) return Number(m[1]) * KIB;
  }
  return 0;
}

/** The biggest folders under the home folder, biggest first. A read only;
 *  slow on a full disk (`du` walks every file), so it rides the dry run,
 *  which only the owner's Free up space asks for. */
export async function diskUse(io: DiskIo): Promise<RunnerDiskUse[]> {
  const dirs = diskUseCandidates(io.home, io.runnerDir);
  const sized: RunnerDiskUse[] = [];
  for (let i = 0; i < dirs.length; i += DU_AT_ONCE) {
    const batch = dirs.slice(i, i + DU_AT_ONCE);
    const sizes = await Promise.all(
      batch.map(async (dir) => {
        // `-x`: one disk. du exits 1 on a folder it may not read (OrbStack's
        // data) and still prints what it could weigh.
        const res = await io.run('du', ['-skx', dir], { timeoutMs: DU_TIMEOUT_MS });
        return duBytes(res.output, dir);
      })
    );
    batch.forEach((dir, j) => {
      if (sizes[j] >= MIN_USE_BYTES) {
        sized.push({ label: diskUseLabel(io.home, io.runnerDir, dir), path: tilde(io.home, dir), bytes: sizes[j] });
      }
    });
  }
  return sized.sort((a, b) => b.bytes - a.bytes).slice(0, MAX_USES);
}
