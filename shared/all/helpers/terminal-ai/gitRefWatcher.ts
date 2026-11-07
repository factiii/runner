import type { AsyncSubscription, Event } from '@parcel/watcher';

import type { Subscribe } from './watcher';
import { getSubscribe, resolveReal } from './watcher';

// The working-tree watcher prunes .git, so a commit, a checkout or a new
// branch made in the session's terminal (by its agent, which runs git itself)
// reached the git panel only on its next read. This watches what those
// change - HEAD and the refs - and says so, so the panel's branch, counts and
// Changes follow the agent. See .specs/ide-git-panel.md "Live HEAD".
//
// A linked worktree keeps HEAD in its own git dir (`.git/worktrees/<name>`)
// and its refs in the clone's common dir, which every other session's
// worktree shares: both are watched, and the common dir's `worktrees` (every
// other session's HEAD and index) is left out.

/** Coalescing window: a commit writes the ref, its log and HEAD's log within
 *  a few ms, and a checkout rewrites HEAD and the index. */
const FLUSH_MS = 150;

/** Back off before re-subscribing after the OS drops the watch. */
const RETRY_MS = 2000;

/** In the git dir: HEAD and the files that say an operation is under way
 *  (MERGE_HEAD, REVERT_HEAD, CHERRY_PICK_HEAD), plus ORIG_HEAD and
 *  FETCH_HEAD. Never the index: every panel read writes it (intent-to-add),
 *  so watching it would have the panel wake itself forever. */
const HEAD_FILE = /^[A-Z_]*HEAD$/;

/** Under the common dir, what is never a ref. Pruned from the walk itself. */
const COMMON_PRUNED = [
  'objects',
  'logs',
  'worktrees',
  'hooks',
  'info',
  'lfs',
  'modules'
];

export type GitDirs = { gitDir: string; commonDir: string };

/** `rev-parse` for where `workdir`'s HEAD and refs live, absolute. null for a
 *  folder that is not a checkout. */
export async function readGitDirs(
  run: (argv: string[]) => Promise<string>,
  workdir: string
): Promise<GitDirs | null> {
  const out = await run([
    'git',
    '-C',
    workdir,
    'rev-parse',
    '--absolute-git-dir',
    '--git-common-dir'
  ]).catch(() => '');
  const [gitDir, common] = out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!gitDir || !common) return null;
  // --git-common-dir is relative to the -C folder unless it is elsewhere.
  const commonDir = common.startsWith('/')
    ? common
    : `${workdir.replace(/\/+$/, '')}/${common}`;
  return { gitDir, commonDir: commonDir.replace(/\/\.$/, '') };
}

/** Whether a path the OS reported is one that moves HEAD or a ref. */
export function isRefPath(path: string, dirs: GitDirs): boolean {
  if (path.endsWith('.lock')) return false;
  const under = (dir: string) =>
    path.startsWith(dir + '/') ? path.slice(dir.length + 1) : null;
  const inGit = under(dirs.gitDir);
  if (inGit !== null && HEAD_FILE.test(inGit)) return true;
  const inCommon = under(dirs.commonDir);
  if (inCommon === null) return false;
  return inCommon === 'packed-refs' || inCommon.startsWith('refs/');
}

export class GitRefWatcher {
  private subs: AsyncSubscription[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  /**
   * @param workdir  The checkout the git panel reads (gitWorkdir).
   * @param run      Runs a command and resolves its stdout (ExecTarget.run).
   * @param emit     Called once per coalesced burst of ref changes.
   */
  constructor(
    readonly workdir: string,
    private run: (argv: string[]) => Promise<string>,
    private emit: () => void,
    /** Test seam, as WorkspaceWatcher's. */
    private subscribeImpl?: Subscribe
  ) {}

  start(): void {
    if (this.subs.length || this.closed || this.retryTimer) return;
    void this.open();
  }

  private async open(): Promise<void> {
    const subscribe = this.subscribeImpl ?? (await getSubscribe());
    if (!subscribe || this.closed) return;
    const found = await readGitDirs(this.run, this.workdir);
    if (!found || this.closed) return;
    // As the OS reports them (macOS FSEvents gives realpaths).
    const dirs: GitDirs = {
      gitDir: await resolveReal(found.gitDir),
      commonDir: await resolveReal(found.commonDir)
    };
    const onEvents = (err: Error | null, events: Event[]) => {
      if (err) return this.retry();
      if (events.some((event) => isRefPath(event.path, dirs))) {
        this.scheduleFlush();
      }
    };
    const pruned = COMMON_PRUNED.map((d) => `${dirs.commonDir}/${d}`);
    try {
      const subs = [
        await subscribe(dirs.commonDir, onEvents, { ignore: pruned })
      ];
      // A linked worktree's own dir sits under the pruned `worktrees`.
      if (dirs.gitDir !== dirs.commonDir) {
        subs.push(
          await subscribe(dirs.gitDir, onEvents, {
            ignore: [`${dirs.gitDir}/logs`]
          })
        );
      }
      if (this.closed) {
        await Promise.all(subs.map((s) => s.unsubscribe().catch(() => {})));
        return;
      }
      this.subs = subs;
    } catch {
      this.retry();
    }
  }

  private retry(): void {
    if (this.closed || this.retryTimer) return;
    const subs = this.subs;
    this.subs = [];
    for (const sub of subs) void sub.unsubscribe().catch(() => {});
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      // Whatever moved while it was down produced no event.
      void this.open().then(() => {
        if (this.subs.length) this.emit();
      });
    }, RETRY_MS);
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.closed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (!this.closed) this.emit();
    }, FLUSH_MS);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.flushTimer = null;
    this.retryTimer = null;
    const subs = this.subs;
    this.subs = [];
    await Promise.all(subs.map((s) => s.unsubscribe().catch(() => {})));
  }
}
