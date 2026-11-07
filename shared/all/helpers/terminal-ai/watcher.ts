import type { AsyncSubscription, Event } from '@parcel/watcher';

import type { BareFsChange } from '../../domains/electron';

// Live view of a bare session's working tree: the card's agent, the terminal
// and git all edit the same worktree, so without this an open buffer goes
// stale in silence and the next save writes over their work.
//
// @parcel/watcher, not chokidar: chokidar v4 dropped fsevents and falls back to
// one fd per directory, which a ~600-dir worktree blows past inside the 256 fd
// limit a GUI app gets under launchd. This binds the OS recursive APIs, so one
// subscription covers the tree.

/** Pruned at any depth: build output and dependency trees. On Linux each
 *  watched dir costs an inotify watch, and node_modules alone would exhaust
 *  `max_user_watches`. */
const PRUNED_DIRS = [
  '.git',
  'node_modules',
  '.next',
  '.turbo',
  '.expo',
  'dist',
  'build',
  'out',
  'coverage',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  '.gradle',
  'Pods',
  'DerivedData'
];

/** Scratch files tools write constantly and nobody edits: Finder's, vim's
 *  swap/backup, emacs' lock files, and vim's `4913` write probe. */
const NOISE_GLOBS = ['**/.DS_Store', '**/4913', '**/*~', '**/.#*', '**/#*#'];

/** Beyond this a batch is a checkout, an install or a build, not editing:
 *  cheaper for the client to refetch than to apply thousands of paths. */
const MAX_BATCH = 200;

/** Coalescing window. Also what stands in for chokidar's `atomic` and
 *  `awaitWriteFinish`: an editor's unlink+rename save lands inside one window,
 *  and `record` keeps only the last state per path. */
const FLUSH_MS = 120;

/** Covers the gap between `bareFsWrite` returning and the OS delivering its
 *  event. */
const SELF_WRITE_MS = 2000;

/** Backoff for re-subscribing after the OS drops the watch. Doubles to the
 *  cap, which is short enough that a laptop waking from sleep reconnects
 *  before anyone reaches for refresh. */
const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 15_000;

export type Subscribe = typeof import('@parcel/watcher').subscribe;

/** Opaque to both compilers and bundlers on purpose: a bare `import()` is a
 *  TS1323 under the es2018 web/mobile tsconfigs this file also compiles for,
 *  and esbuild would inline a package that needs its `.node` on disk. */
const dynamicImport = new Function('s', 'return import(s)') as (
  s: string
) => Promise<{ subscribe: Subscribe }>;

/** Same trick for a node builtin: this file is type-checked under the web and
 *  mobile tsconfigs too, which have no business resolving `fs`. */
const importFs = new Function('s', 'return import(s)') as (
  s: string
) => Promise<{ realpath: (p: string) => Promise<string> }>;

/** A path as the OS will report it. macOS FSEvents emits realpaths, so a root
 *  reached through a symlink - `/tmp`, which is `/private/tmp`, and where a
 *  second runner alongside the default one keeps its HOME - comes back under a
 *  prefix the watcher never recognises. Best effort: a path that cannot be
 *  resolved is still worth watching under the name we were given. */
export async function resolveReal(path: string): Promise<string> {
  try {
    const { realpath } = await importFs('fs/promises');
    return await realpath(path);
  } catch {
    return path;
  }
}

/** Resolved once, at first use: a host with no matching prebuild degrades to
 *  manual refresh rather than dying on module load. */
let loadSubscribe: Promise<Subscribe | null> | null = null;
export function getSubscribe(): Promise<Subscribe | null> {
  loadSubscribe ??= dynamicImport('@parcel/watcher')
    .then((m) => m.subscribe)
    .catch(() => null);
  return loadSubscribe;
}

type Pending = {
  added: Set<string>;
  changed: Set<string>;
  removed: Set<string>;
  resync: boolean;
};

const emptyPending = (): Pending => ({
  added: new Set(),
  changed: new Set(),
  removed: new Set(),
  resync: false
});

export class WorkspaceWatcher {
  private sub: AsyncSubscription | null = null;
  /** `root` as the OS reports it. Set by open(); every event is measured
   *  against this, never against the constructor argument. */
  private watchRoot: string;
  private pending = emptyPending();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = RETRY_MIN_MS;
  /** path -> expiry. Events for these are ours (the editor just saved) and must
   *  not come back as "changed on disk". */
  private selfWrites = new Map<string, number>();
  private closed = false;

  /**
   * @param root     Absolute path of the working tree. Emitted paths are
   *                 repo-relative and `/`-prefixed, matching `bareFsList`.
   * @param emit     Called with a coalesced batch, never with an empty one.
   * @param exclude  Absolute subtrees to skip on top of the name-based pruning.
   *                 A no-git card's root is the space dir itself, which also
   *                 holds the runner's own bookkeeping.
   */
  constructor(
    private root: string,
    private emit: (change: BareFsChange) => void,
    private exclude: string[] = [],
    /** Test seam. The real one is reached through `new Function('return
     *  import(s)')`, which hides it from bundlers and from a test runner's
     *  resolver alike, so the retry logic is otherwise unreachable. */
    private subscribeImpl?: Subscribe
  ) {
    this.watchRoot = root;
  }

  /** Fire-and-forget: callers treat starting a watch as synchronous, and
   *  nothing can be emitted before `subscribe` resolves anyway. */
  start(): void {
    if (this.sub || this.closed || this.retryTimer) return;
    void this.open();
  }

  private async open(): Promise<void> {
    const subscribe = this.subscribeImpl ?? (await getSubscribe());
    if (!subscribe) return this.stop();
    // Resolve before subscribing, so the path the OS echoes back and the path
    // onEvent() measures against are the same one.
    this.watchRoot = await resolveReal(this.root);
    const exclude = await Promise.all(this.exclude.map(resolveReal));
    try {
      const sub = await subscribe(
        this.watchRoot,
        (err, events) => {
          if (err) return this.retry();
          for (const event of events) this.onEvent(event);
        },
        // Prunes the walk itself, so a pruned tree is never enumerated.
        {
          ignore: [
            ...PRUNED_DIRS.map((d) => `**/${d}/**`),
            ...NOISE_GLOBS,
            ...exclude
          ]
        }
      );
      // close() may have run while we were awaiting.
      if (this.closed) {
        await sub.unsubscribe().catch(() => undefined);
        return;
      }
      this.sub = sub;
      // Only a subscription that actually took resets the backoff; doing it on
      // entry would let a directory that fails every time spin at the minimum.
      this.retryDelay = RETRY_MIN_MS;
    } catch {
      this.retry();
    }
  }

  /**
   * Re-subscribe after the OS dropped the watch — a remount, a wake from
   * sleep, an inotify limit easing. Treating those as terminal left a runner
   * watching nothing for the rest of its life. `resync` on the way back up,
   * since whatever changed while it was down produced no events.
   */
  private retry(): void {
    if (this.closed || this.retryTimer) return;
    const sub = this.sub;
    this.sub = null;
    if (sub) void sub.unsubscribe().catch(() => undefined);

    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.closed) return;
      void this.open().then(() => {
        if (this.sub) {
          this.emit({
            added: [],
            changed: [],
            removed: [],
            resync: true
          });
        }
      });
    }, delay);
  }

  /** Give up and say so once, so the UI falls back to manual refresh rather
   *  than showing a silently frozen tree. */
  private stop(): void {
    if (this.closed) return;
    void this.close();
    this.emit({
      added: [],
      changed: [],
      removed: [],
      resync: false,
      stopped: true
    });
  }

  /** Typed kinds, so unlike a bare `fs.watch` rename there is nothing to stat
   *  to tell a create from a delete. */
  private onEvent(event: Event): void {
    if (!event.path.startsWith(this.watchRoot)) return;
    const rel = event.path.slice(this.watchRoot.length).replace(/^\/+/, '');
    if (!rel) return;
    if (event.type === 'create') this.record('added', rel);
    else if (event.type === 'delete') this.record('removed', rel);
    else this.record('changed', rel);
  }

  /** Mark a path as about to be written by us, so the editor isn't told its own
   *  save was an outside edit. */
  expectWrite(repoPath: string): void {
    this.selfWrites.set(repoPath, Date.now() + SELF_WRITE_MS);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pending = emptyPending();
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.selfWrites.clear();
    const sub = this.sub;
    this.sub = null;
    if (sub) await sub.unsubscribe().catch(() => undefined);
  }

  private record(kind: 'added' | 'changed' | 'removed', relPath: string): void {
    if (this.closed) return;
    // The leading slash matches what bareFsList hands the client. Not split on
    // `\` - that is a legal filename character on the platforms a runner
    // supports.
    const path = '/' + relPath;

    const expiry = this.selfWrites.get(path);
    if (expiry !== undefined) {
      if (expiry > Date.now()) return;
      this.selfWrites.delete(path);
    }

    const { added, changed, removed } = this.pending;
    // Last writer wins per path: a create+edit inside one window is an add, and
    // anything followed by a delete is a delete.
    added.delete(path);
    changed.delete(path);
    removed.delete(path);
    if (kind === 'added') added.add(path);
    else if (kind === 'changed') changed.add(path);
    else removed.add(path);

    if (added.size + changed.size + removed.size > MAX_BATCH) {
      this.pending = { ...emptyPending(), resync: true };
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    // Not unref'd: this file also compiles under the web/mobile tsconfigs,
    // where setTimeout is the DOM one and has no unref.
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FLUSH_MS);
  }

  private flush(): void {
    if (this.closed) return;
    const { added, changed, removed, resync } = this.pending;
    this.pending = emptyPending();
    if (!resync && !added.size && !changed.size && !removed.size) return;

    // Drop expired suppressions; nothing else ever removes them.
    const now = Date.now();
    for (const [path, expiry] of this.selfWrites) {
      if (expiry <= now) this.selfWrites.delete(path);
    }

    this.emit({
      added: resync ? [] : [...added],
      changed: resync ? [] : [...changed],
      removed: resync ? [] : [...removed],
      resync
    });
  }
}
