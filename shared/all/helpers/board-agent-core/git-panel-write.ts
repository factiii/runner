import type {
  BareGitOperation,
  BareGitPanelInfo,
  BareGitStash
} from '../../domains/electron';
import type { BareGitOp } from '../../validators/runnerGit';
import { bareGitOpSchema } from '../../validators/runnerGit';
import { splitCommitMessage } from '../card-ai/gitPanel';
import type { ExecTarget } from './exec';
import {
  gitInDir,
  gitRemote,
  parseLeftRight,
  parseStatus,
  stagePaths,
  toRepoRelative,
  unstagePaths
} from './git';

// The IDE git panel's writes, GitHub Desktop's set (.specs/ide-git-panel.md).
// Every one runs in one workdir the caller has already proven is the
// session's own worktree (terminal-mode.ts gitWriteWorkdir); this file checks
// what is asked of git there: names against `git check-ref-format`, paths
// against toRepoRelative, commits against HEAD's history, and the default
// branch against every commit and push.

/** What the runner's policy says about this repository. */
export type GitPanelPolicy = {
  /** The space's default branch (its mainBranch). The panel never commits,
   *  merges, reverts or pushes on it: "Never push to the default branch" is
   *  what every session is told, and the panel is a session's hands. */
  defaultBranch: string;
};

type Ctx = { target: ExecTarget; workdir: string; policy: GitPanelPolicy };

export type GitPanelOpResult = {
  notice?: string;
  draft?: { summary: string; description: string };
};

/** The message the panel's stashes carry, GitHub Desktop's `!!GitHub_Desktop`
 *  idea: the branch the changes were left on follows it. The stash stack is
 *  the clone's, shared by every worktree, so a stash is only ever touched by
 *  its sha and only when it carries this tag. */
export const PANEL_STASH_TAG = '!!factiii-panel:';

/** Git's own words for a failure, without the command line execFile puts in
 *  front, the hints, or the `fatal:` / `error:` prefixes. */
export function gitError(err: unknown): Error {
  const stderr =
    err && typeof err === 'object' && 'stderr' in err
      ? String((err as { stderr: unknown }).stderr ?? '')
      : '';
  const raw = stderr.trim() || (err instanceof Error ? err.message : '');
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line && !line.startsWith('hint:') && !line.startsWith('Command failed:')
    )
    .map((line) => line.replace(/^(fatal|error|git apply):\s*/i, ''));
  return new Error(lines.join('\n') || 'git failed.');
}

const git = (ctx: Ctx, ...args: string[]): Promise<string> =>
  gitInDir(ctx.target, ctx.workdir, ...args).catch((err: unknown) => {
    throw gitError(err);
  });

/** A read whose failure means "no": a ref that does not exist, an empty repo. */
const gitOr = (ctx: Ctx, ...args: string[]): Promise<string> =>
  gitInDir(ctx.target, ctx.workdir, ...args).catch(() => '');

const succeeds = (ctx: Ctx, ...args: string[]): Promise<boolean> =>
  gitInDir(ctx.target, ctx.workdir, ...args).then(
    () => true,
    () => false
  );

const remote = (ctx: Ctx, ...args: string[]): Promise<string> =>
  gitRemote(ctx.target, ctx.workdir, ...args).catch((err: unknown) => {
    throw gitError(err);
  });

/** The checked-out branch, '' when HEAD is detached. */
async function currentBranch(ctx: Ctx): Promise<string> {
  return (
    await gitOr(ctx, 'symbolic-ref', '--quiet', '--short', 'HEAD')
  ).trim();
}

/** What the runner says when the agent moved HEAD after the client's button
 *  named a branch: the commit or push would land somewhere the user did not
 *  pick. */
export const agentSwitchedError = (branch: string): Error =>
  new Error(
    `The agent switched to ${branch || 'a detached HEAD'} — check the changes and try again.`
  );

/** Refuse when HEAD is not on the branch the client expected. `undefined`
 *  (an older client) is not checked. */
async function checkExpectedBranch(
  ctx: Ctx,
  expected: string | undefined
): Promise<void> {
  if (expected === undefined) return;
  const branch = await currentBranch(ctx);
  if (branch !== expected) throw agentSwitchedError(branch);
}

/** The default branch by the space's config, and by origin's HEAD when the
 *  two disagree (a repository whose default was renamed): both refused. */
async function protectedBranches(ctx: Ctx): Promise<Set<string>> {
  const names = new Set([ctx.policy.defaultBranch || 'main']);
  const originHead = (
    await gitOr(
      ctx,
      'symbolic-ref',
      '--quiet',
      '--short',
      'refs/remotes/origin/HEAD'
    )
  ).trim();
  if (originHead.startsWith('origin/')) {
    names.add(originHead.slice('origin/'.length));
  }
  return names;
}

const refNames = async (ctx: Ctx, prefix: string): Promise<string[]> =>
  (await gitOr(ctx, 'for-each-ref', '--format=%(refname)', prefix))
    .split('\n')
    .map((line) => line.trim())
    .filter((ref) => ref && !ref.endsWith('/HEAD'))
    .map((ref) => ref.slice(prefix.length + 1));

const localBranches = (ctx: Ctx) => refNames(ctx, 'refs/heads');
const remoteBranches = (ctx: Ctx) => refNames(ctx, 'refs/remotes');

/** A name git would accept for a new branch, or a throw. */
async function checkNewBranchName(ctx: Ctx, name: string): Promise<string> {
  const clean = name.trim();
  if (!clean || clean.startsWith('-')) {
    throw new Error(`"${name}" is not a valid branch name.`);
  }
  const ok = (await gitOr(ctx, 'check-ref-format', '--branch', clean)).trim();
  if (ok !== clean) throw new Error(`"${name}" is not a valid branch name.`);
  if ((await protectedBranches(ctx)).has(clean)) {
    throw new Error(`${clean} is the default branch's name.`);
  }
  if ((await localBranches(ctx)).includes(clean)) {
    throw new Error(`A branch named ${clean} already exists.`);
  }
  return clean;
}

/** The branch a commit, merge, revert or push may land on: a real branch,
 *  and not the default one. */
async function writableBranch(ctx: Ctx, doing: string): Promise<string> {
  const branch = await currentBranch(ctx);
  if (!branch) throw new Error(`Check out a branch before you ${doing}.`);
  if ((await protectedBranches(ctx)).has(branch)) {
    throw new Error(
      `${branch} is the default branch. This panel does not ${doing} there: create a branch first.`
    );
  }
  return branch;
}

const resolveGitPath = async (ctx: Ctx, name: string): Promise<string> => {
  const p = (await gitOr(ctx, 'rev-parse', '--git-path', name)).trim();
  if (!p) return '';
  return p.startsWith('/') ? p : `${ctx.workdir.replace(/\/+$/, '')}/${p}`;
};

const exists = (ctx: Ctx, p: string): Promise<boolean> =>
  p
    ? ctx.target.run(['test', '-e', p]).then(
        () => true,
        () => false
      )
    : Promise.resolve(false);

/** What git left half done in this worktree. */
export async function readOperation(ctx: Ctx): Promise<BareGitOperation> {
  const checks: [string, BareGitOperation][] = [
    ['MERGE_HEAD', 'merge'],
    ['REVERT_HEAD', 'revert'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase']
  ];
  for (const [name, op] of checks) {
    if (await exists(ctx, await resolveGitPath(ctx, name))) return op;
  }
  return '';
}

/** Seconds since the epoch a file was last written, 0 when it is not there.
 *  GNU's spelling first, then BSD's (macOS): GNU `stat -f` is the file-system
 *  form, which prints the file system's details before it fails on `%m`, so
 *  trying BSD first on Linux read back that text, and 0. BSD `stat -c` fails
 *  without printing anything. */
async function mtime(ctx: Ctx, p: string): Promise<number> {
  if (!p) return 0;
  const out = await ctx.target
    .run([
      'sh',
      '-c',
      'stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0',
      '_',
      p
    ])
    .catch(() => '0');
  return Number(out.trim()) || 0;
}

/** The last fetch: this worktree's FETCH_HEAD or the clone's (the runner
 *  fetches there when a session starts), whichever is newer. */
async function lastFetched(ctx: Ctx): Promise<number> {
  const own = await resolveGitPath(ctx, 'FETCH_HEAD');
  const common = (await gitOr(ctx, 'rev-parse', '--git-common-dir')).trim();
  const shared = common
    ? `${common.startsWith('/') ? common : `${ctx.workdir}/${common}`}/FETCH_HEAD`
    : '';
  const seconds = Math.max(await mtime(ctx, own), await mtime(ctx, shared));
  return seconds * 1000;
}

type StashEntry = {
  sha: string;
  ref: string;
  subject: string;
  relative: string;
};

async function listStashes(ctx: Ctx): Promise<StashEntry[]> {
  const raw = await gitOr(
    ctx,
    'stash',
    'list',
    '--format=%H%x1f%gd%x1f%gs%x1f%cr'
  );
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha = '', ref = '', subject = '', relative = ''] =
        line.split('\x1f');
      return { sha, ref, subject, relative };
    });
}

const stashTag = (branch: string) => `${PANEL_STASH_TAG}${branch}`;

/** `git stash push -m msg` records "On <branch>: msg". */
const isPanelStashFor = (entry: StashEntry, branch: string) =>
  entry.subject.endsWith(`: ${stashTag(branch)}`);

async function panelStash(
  ctx: Ctx,
  branch: string
): Promise<BareGitStash | null> {
  if (!branch) return null;
  const entry = (await listStashes(ctx)).find((e) =>
    isPanelStashFor(e, branch)
  );
  return entry ? { sha: entry.sha, relative: entry.relative } : null;
}

/** A panel stash by sha, for the branch that is checked out: never anyone
 *  else's entry on the shared stack. */
async function findPanelStash(ctx: Ctx, sha: string): Promise<StashEntry> {
  const branch = await currentBranch(ctx);
  const entry = (await listStashes(ctx)).find(
    (e) => e.sha.startsWith(sha.toLowerCase()) && isPanelStashFor(e, branch)
  );
  if (!entry) throw new Error('That stash is gone.');
  return entry;
}

/** HEAD is on no remote: amending or undoing it rewrites nothing published. */
async function headIsLocal(ctx: Ctx): Promise<boolean> {
  const head = (
    await gitOr(ctx, 'rev-parse', '--verify', '--quiet', 'HEAD')
  ).trim();
  if (!head) return false;
  const local = (
    await gitOr(ctx, 'rev-list', '-n', '1', 'HEAD', '--not', '--remotes')
  ).trim();
  return local === head;
}

/** The top bar's and the commit box's facts. `access` is the caller's say on
 *  whether this workdir may be written at all. */
export async function readPanelInfo(
  target: ExecTarget,
  workdir: string,
  policy: GitPanelPolicy,
  access: { writable: boolean; reason: string; ownWorktree?: boolean }
): Promise<BareGitPanelInfo> {
  const ctx: Ctx = { target, workdir, policy };
  const branch = await currentBranch(ctx);
  const isProtected = !!branch && (await protectedBranches(ctx)).has(branch);
  const hasRemote =
    !!branch &&
    (await succeeds(
      ctx,
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/remotes/origin/${branch}`
    ));
  const counts = hasRemote
    ? parseLeftRight(
        await gitOr(
          ctx,
          'rev-list',
          '--left-right',
          '--count',
          `refs/remotes/origin/${branch}...HEAD`
        )
      )
    : null;
  const headLocal = await headIsLocal(ctx);
  return {
    root: workdir,
    writable: access.writable,
    readOnlyReason: access.writable ? '' : access.reason,
    ...(access.ownWorktree === undefined
      ? {}
      : { ownWorktree: access.ownWorktree }),
    defaultBranch: policy.defaultBranch || 'main',
    protectedBranch: isProtected,
    detached: !branch,
    remote: counts ? { name: `origin/${branch}`, ...counts } : null,
    lastFetched: await lastFetched(ctx),
    operation: await readOperation(ctx),
    stash: await panelStash(ctx, branch),
    headMessage: (await gitOr(ctx, 'log', '-1', '--format=%B')).trim(),
    headLocal
  };
}

/** One working-tree file's diffs, both sides of the index. */
export async function readFileDiffs(
  target: ExecTarget,
  workdir: string,
  path: string
): Promise<{ staged: string; unstaged: string }> {
  const [rel] = toRepoRelative([path]);
  if (!rel) throw new Error('That path is not in this workspace.');
  const ctx: Ctx = { target, workdir, policy: { defaultBranch: '' } };
  const diff = (...args: string[]) =>
    gitOr(
      ctx,
      '-c',
      'core.quotePath=false',
      'diff',
      '--no-color',
      ...args,
      '--',
      rel
    );
  return { staged: await diff('--cached'), unstaged: await diff() };
}

// ---- the changes list ------------------------------------------------------

/** The header lines a partial patch may carry: nothing that renames, copies,
 *  changes a mode or ships binary. */
const PATCH_HEADER =
  /^(diff --git |index |new file mode |deleted file mode |--- |\+\+\+ )/;

/** Every path a patch names must be inside the worktree. */
export function checkPatch(patch: string): void {
  let inHunk = false;
  let files = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      files++;
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!m || !safeRel(m[1]!) || !safeRel(m[2]!) || m[1] !== m[2]) {
        throw new Error('That patch names a path outside this workspace.');
      }
      continue;
    }
    if (line.startsWith('@@ ')) {
      inHunk = true;
      continue;
    }
    if (inHunk) {
      if (line === '' || /^[ +\-\\]/.test(line)) continue;
      throw new Error('That patch is not a plain text diff.');
    }
    if (!PATCH_HEADER.test(line)) {
      throw new Error('That patch is not a plain text diff.');
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const p = line.slice(4);
      if (p !== '/dev/null' && !safeRel(p.replace(/^[ab]\//, ''))) {
        throw new Error('That patch names a path outside this workspace.');
      }
    }
  }
  if (files === 0) throw new Error('That patch changes nothing.');
}

const safeRel = (p: string): boolean => {
  const [rel] = toRepoRelative([p]);
  return !!rel && rel === p;
};

async function applyPatch(ctx: Ctx, patch: string, reverse: boolean) {
  checkPatch(patch);
  // --cached: the index only, never a file on disk. --recount: the client's
  // hunk counts are a hint, git counts the lines itself.
  await ctx.target
    .runWithStdin(
      [
        'git',
        '-C',
        ctx.workdir,
        'apply',
        '--cached',
        '--recount',
        ...(reverse ? ['--reverse'] : []),
        '-'
      ],
      patch.endsWith('\n') ? patch : `${patch}\n`,
      'git apply'
    )
    .catch((err: unknown) => {
      throw gitError(err);
    });
}

type StatusEntry = { path: string; oldPath?: string; intentToAdd: boolean };

/** Every changed path once, with a rename's source and whether the index
 *  holds it only as intent-to-add (an untracked file the panel marked). */
async function changedEntries(ctx: Ctx): Promise<StatusEntry[]> {
  const raw = await git(
    ctx,
    '-c',
    'core.quotePath=false',
    'status',
    '--porcelain=v1',
    '--untracked-files=all'
  );
  const { staged, unstaged } = parseStatus(raw);
  const byPath = new Map<string, StatusEntry>();
  for (const file of staged) {
    byPath.set(file.path, {
      path: file.path,
      ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      intentToAdd: false
    });
  }
  for (const file of unstaged) {
    if (byPath.has(file.path)) continue;
    // ' A' and '??' both come back as an unstaged 'A': a file not in HEAD
    // whose index entry, if any, holds no content.
    byPath.set(file.path, { path: file.path, intentToAdd: file.code === 'A' });
  }
  return [...byPath.values()];
}

/** Of `paths`, the ones HEAD has. */
async function inHead(ctx: Ctx, paths: string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const out = await gitOr(
    ctx,
    '-c',
    'core.quotePath=false',
    'ls-tree',
    '-r',
    '--name-only',
    'HEAD',
    '--',
    ...paths
  );
  return new Set(out.split('\n').filter(Boolean));
}

/** Put paths back the way HEAD has them, staged and on disk. A path HEAD does
 *  not have is deleted. [] is every changed path. */
async function discard(ctx: Ctx, paths: string[]): Promise<void> {
  const wanted = paths.length ? new Set(toRepoRelative(paths)) : null;
  if (wanted && wanted.size === 0) {
    throw new Error('No path in that request was usable.');
  }
  const entries = (await changedEntries(ctx)).filter(
    (e) => !wanted || wanted.has(e.path) || (e.oldPath && wanted.has(e.oldPath))
  );
  if (entries.length === 0) throw new Error('Nothing to discard.');
  const all = entries.flatMap((e) =>
    e.oldPath ? [e.path, e.oldPath] : [e.path]
  );
  const tracked = await inHead(ctx, all);
  const fromHead = all.filter((p) => tracked.has(p));
  const created = all.filter((p) => !tracked.has(p));
  if (fromHead.length) {
    await git(
      ctx,
      'restore',
      '--source=HEAD',
      '--staged',
      '--worktree',
      '--',
      ...fromHead
    );
  }
  if (created.length) {
    await git(
      ctx,
      'rm',
      '--cached',
      '-q',
      '-r',
      '--ignore-unmatch',
      '--',
      ...created
    );
    const root = ctx.workdir.replace(/\/+$/, '');
    // Files only (`rm -f`, no -r): status names each file, never a folder.
    await ctx.target.run([
      'rm',
      '-f',
      '--',
      ...created.map((p) => `${root}/${p}`)
    ]);
  }
}

/** A .gitignore line matching exactly this path. */
export function gitignoreLine(rel: string): string {
  return `/${rel.replace(/([\\*?[\]!#])/g, '\\$1').replace(/ $/, '\\ ')}`;
}

/** GitHub Desktop's "Ignore file": a line in the root .gitignore, and an
 *  untracked file's intent-to-add marker taken back out of the index. A
 *  tracked file stays tracked, as git has it. */
async function ignore(ctx: Ctx, path: string): Promise<void> {
  const [rel] = toRepoRelative([path]);
  if (!rel) throw new Error('That path is not in this workspace.');
  const file = `${ctx.workdir.replace(/\/+$/, '')}/.gitignore`;
  const line = gitignoreLine(rel);
  // One sh, argv-passed: no value is ever spliced into the script. Skips a
  // line already there, and starts a new line when the file lacks a final one.
  await ctx.target.run([
    'sh',
    '-c',
    'f="$2"; if [ -f "$f" ] && grep -qxF -- "$1" "$f"; then exit 0; fi; ' +
      'if [ -s "$f" ] && [ -n "$(tail -c 1 "$f")" ]; then printf "\\n" >> "$f"; fi; ' +
      'printf "%s\\n" "$1" >> "$f"',
    '_',
    line,
    file
  ]);
  const entry = (await changedEntries(ctx)).find((e) => e.path === rel);
  if (entry?.intentToAdd) {
    await gitOr(ctx, 'rm', '--cached', '-q', '--ignore-unmatch', '--', rel);
  }
}

// ---- commits ---------------------------------------------------------------

async function commit(
  ctx: Ctx,
  op: Extract<BareGitOp, { kind: 'commit' }>
): Promise<void> {
  await writableBranch(ctx, 'commit');
  if (op.amend && !(await headIsLocal(ctx))) {
    throw new Error(
      'The last commit is already pushed. Amending it would need a force push, which this panel does not do.'
    );
  }
  const operation = await readOperation(ctx);
  const nothingStaged = await succeeds(ctx, 'diff', '--cached', '--quiet');
  if (
    nothingStaged &&
    !op.amend &&
    operation !== 'merge' &&
    operation !== 'revert'
  ) {
    throw new Error(
      'Nothing is included in this commit. Check the files to commit.'
    );
  }
  const summary = op.summary.trim();
  const description = op.description.trim();
  await git(
    ctx,
    'commit',
    ...(op.amend ? ['--amend'] : []),
    '-m',
    summary,
    ...(description ? ['-m', description] : [])
  );
}

/** The commit `sha` names, in full, or a throw. */
async function resolveCommit(ctx: Ctx, sha: string): Promise<string> {
  const full = (
    await gitOr(ctx, 'rev-parse', '--verify', '--quiet', `${sha}^{commit}`)
  ).trim();
  if (!full) throw new Error(`No commit ${sha} here.`);
  return full;
}

/** GitHub Desktop's Undo: the newest commit, if no remote has it, comes off
 *  the branch and its changes go back to being staged. */
async function undo(ctx: Ctx, sha: string): Promise<GitPanelOpResult> {
  const full = await resolveCommit(ctx, sha);
  const head = (await gitOr(ctx, 'rev-parse', 'HEAD')).trim();
  if (full !== head)
    throw new Error('Only the most recent commit can be undone.');
  if (!(await headIsLocal(ctx))) {
    throw new Error(
      'That commit is already pushed, so it cannot be undone here.'
    );
  }
  if (await readOperation(ctx)) {
    throw new Error('Finish or abort the operation in progress first.');
  }
  if (!(await succeeds(ctx, 'rev-parse', '--verify', '--quiet', 'HEAD^'))) {
    throw new Error('The first commit of a branch cannot be undone.');
  }
  const message = await git(ctx, 'log', '-1', '--format=%B');
  await git(ctx, 'reset', '--soft', 'HEAD^');
  return { draft: splitCommitMessage(message) };
}

async function revert(ctx: Ctx, sha: string): Promise<GitPanelOpResult> {
  await writableBranch(ctx, 'commit');
  const full = await resolveCommit(ctx, sha);
  if (!(await succeeds(ctx, 'merge-base', '--is-ancestor', full, 'HEAD'))) {
    throw new Error('That commit is not on this branch.');
  }
  const parents =
    (await gitOr(ctx, 'rev-list', '--parents', '-n', '1', full))
      .trim()
      .split(/\s+/).length - 1;
  try {
    await git(
      ctx,
      'revert',
      '--no-edit',
      ...(parents > 1 ? ['-m', '1'] : []),
      full
    );
  } catch (err) {
    if ((await readOperation(ctx)) === 'revert') {
      return {
        notice:
          'The revert stopped on conflicts. Resolve them, include the files, then commit - or abort the revert.'
      };
    }
    throw err;
  }
  return {};
}

// ---- branches --------------------------------------------------------------

async function createBranch(
  ctx: Ctx,
  name: string,
  from?: string
): Promise<GitPanelOpResult> {
  const clean = await checkNewBranchName(ctx, name);
  const start = from ? [await resolveCommit(ctx, from)] : [];
  await git(ctx, 'switch', '-c', clean, ...start);
  return {};
}

/** Uncommitted work: anything status lists. */
const isDirty = async (ctx: Ctx): Promise<boolean> =>
  (await changedEntries(ctx)).length > 0;

/** `git stash` refuses an index holding intent-to-add entries ("Entry not
 *  uptodate. Cannot merge"), which every panel read leaves. They hold no
 *  content, so taking them out loses nothing: the files are untracked again,
 *  and --include-untracked takes them. */
async function dropIntentToAdd(ctx: Ctx): Promise<void> {
  const marked = (await changedEntries(ctx))
    .filter((e) => e.intentToAdd)
    .map((e) => e.path);
  if (marked.length) {
    await gitOr(
      ctx,
      'rm',
      '--cached',
      '-q',
      '--ignore-unmatch',
      '--',
      ...marked
    );
  }
}

/** Switch to a local branch, or to a remote one through a local branch of the
 *  same name (made to track it when there is none). `leaveChanges` stashes the
 *  uncommitted work on the branch being left first, GitHub Desktop's "Leave
 *  my changes on <branch>"; without it git carries them over, or refuses when
 *  they would be overwritten. */
async function switchBranch(
  ctx: Ctx,
  branch: string,
  leaveChanges: boolean
): Promise<GitPanelOpResult> {
  if (await readOperation(ctx)) {
    throw new Error('Finish or abort the operation in progress first.');
  }
  const current = await currentBranch(ctx);
  const locals = await localBranches(ctx);
  let args: string[];
  let target = branch;
  if (locals.includes(branch)) {
    args = [branch];
  } else if ((await remoteBranches(ctx)).includes(branch)) {
    target = branch.slice(branch.indexOf('/') + 1);
    args = locals.includes(target) ? [target] : ['--track', branch];
  } else {
    throw new Error(`No branch named ${branch} here.`);
  }
  if (target === current) return {};

  let stashed: StashEntry | undefined;
  if (leaveChanges && (await isDirty(ctx))) {
    if (!current) throw new Error('Changes can only be left on a branch.');
    await dropIntentToAdd(ctx);
    await git(
      ctx,
      'stash',
      'push',
      '--include-untracked',
      '-m',
      stashTag(current)
    );
    stashed = (await listStashes(ctx)).find((e) => isPanelStashFor(e, current));
  }
  try {
    await git(ctx, 'switch', ...args);
  } catch (err) {
    // Put the changes back where they were rather than strand them.
    if (stashed) await restoreStashEntry(ctx, stashed).catch(() => {});
    throw err;
  }
  return stashed ? { notice: `Your changes are stashed on ${current}.` } : {};
}

async function renameBranch(
  ctx: Ctx,
  branch: string,
  name: string
): Promise<GitPanelOpResult> {
  if (!(await localBranches(ctx)).includes(branch)) {
    throw new Error(`No local branch named ${branch}.`);
  }
  if ((await protectedBranches(ctx)).has(branch)) {
    throw new Error(`${branch} is the default branch and keeps its name.`);
  }
  const clean = await checkNewBranchName(ctx, name);
  await git(ctx, 'branch', '-m', branch, clean);
  return {};
}

async function deleteBranch(
  ctx: Ctx,
  branch: string
): Promise<GitPanelOpResult> {
  if (!(await localBranches(ctx)).includes(branch)) {
    throw new Error(`No local branch named ${branch}.`);
  }
  if (branch === (await currentBranch(ctx))) {
    throw new Error('The checked-out branch cannot be deleted. Switch first.');
  }
  if ((await protectedBranches(ctx)).has(branch)) {
    throw new Error(
      `${branch} is the default branch and cannot be deleted here.`
    );
  }
  // git still refuses a branch another worktree has checked out.
  await git(ctx, 'branch', '-D', branch);
  return {};
}

async function merge(ctx: Ctx, branch: string): Promise<GitPanelOpResult> {
  const current = await writableBranch(ctx, 'merge');
  if (await readOperation(ctx)) {
    throw new Error('Finish or abort the operation in progress first.');
  }
  const known = [...(await localBranches(ctx)), ...(await remoteBranches(ctx))];
  if (!known.includes(branch) || branch === current) {
    throw new Error(`No other branch named ${branch} here.`);
  }
  try {
    const out = await git(ctx, 'merge', '--no-edit', branch);
    if (/Already up to date/i.test(out)) {
      return { notice: `${current} already has everything on ${branch}.` };
    }
  } catch (err) {
    if ((await readOperation(ctx)) === 'merge') {
      return {
        notice: `Merging ${branch} stopped on conflicts. Resolve them, include the files, then commit - or abort the merge.`
      };
    }
    throw err;
  }
  return {};
}

async function abort(ctx: Ctx): Promise<GitPanelOpResult> {
  const operation = await readOperation(ctx);
  if (!operation) throw new Error('Nothing is in progress.');
  await git(ctx, operation, '--abort');
  return {};
}

// ---- origin ----------------------------------------------------------------

async function pull(ctx: Ctx): Promise<GitPanelOpResult> {
  const branch = await currentBranch(ctx);
  if (!branch) throw new Error('Check out a branch before you pull.');
  if (await readOperation(ctx)) {
    throw new Error('Finish or abort the operation in progress first.');
  }
  // The default branch only fast-forwards: a merge there would be a commit
  // on it.
  const ffOnly = (await protectedBranches(ctx)).has(branch);
  try {
    await remote(
      ctx,
      'pull',
      '--no-rebase',
      '--no-edit',
      ...(ffOnly ? ['--ff-only'] : []),
      'origin',
      branch
    );
  } catch (err) {
    if ((await readOperation(ctx)) === 'merge') {
      return {
        notice:
          'The pull stopped on conflicts. Resolve them, include the files, then commit - or abort the merge.'
      };
    }
    throw err;
  }
  return {};
}

/** Push HEAD to the branch of the same name on origin, publishing it (and
 *  tracking it from then on) when origin has none. Never to the upstream a
 *  session branch starts out tracking (origin/main), never the default
 *  branch, never forced. */
async function push(ctx: Ctx): Promise<GitPanelOpResult> {
  const branch = await writableBranch(ctx, 'push');
  if (await readOperation(ctx)) {
    throw new Error('Finish or abort the operation in progress first.');
  }
  const published = await succeeds(
    ctx,
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/remotes/origin/${branch}`
  );
  try {
    await remote(
      ctx,
      'push',
      '--set-upstream',
      'origin',
      `HEAD:refs/heads/${branch}`
    );
  } catch (err) {
    const e = gitError(err);
    if (/rejected|non-fast-forward|fetch first/i.test(e.message)) {
      throw new Error(
        `origin/${branch} has commits this branch does not. Pull first, then push.`
      );
    }
    throw e;
  }
  return published ? {} : { notice: `Published ${branch} to origin.` };
}

// ---- the panel's stash -------------------------------------------------------

async function restoreStashEntry(ctx: Ctx, entry: StashEntry): Promise<void> {
  await git(ctx, 'stash', 'apply', entry.sha);
  await dropStashEntry(ctx, entry);
}

/** Drop by sha: the stack is shared, so an index read earlier can point at
 *  someone else's entry by now. */
async function dropStashEntry(ctx: Ctx, entry: StashEntry): Promise<void> {
  const now = (await listStashes(ctx)).find((e) => e.sha === entry.sha);
  if (now) await git(ctx, 'stash', 'drop', '-q', now.ref);
}

// ---- dispatch ----------------------------------------------------------------

/** Run one panel op in `workdir`. `rawOp` is parsed here, whatever the caller
 *  typed it as: it came over the wire. */
export async function runGitPanelOp(
  target: ExecTarget,
  workdir: string,
  policy: GitPanelPolicy,
  rawOp: unknown
): Promise<GitPanelOpResult> {
  const parsed = bareGitOpSchema.safeParse(rawOp);
  if (!parsed.success)
    throw new Error('That git action is not one the panel knows.');
  const op = parsed.data;
  const ctx: Ctx = { target, workdir, policy };
  switch (op.kind) {
    case 'stage':
      await stagePaths(target, workdir, op.paths).catch((err: unknown) => {
        throw gitError(err);
      });
      return {};
    case 'unstage':
      await unstagePaths(target, workdir, op.paths).catch((err: unknown) => {
        throw gitError(err);
      });
      return {};
    case 'applyPatch':
      await applyPatch(ctx, op.patch, op.reverse);
      return {};
    case 'discard':
      await discard(ctx, op.paths);
      return {};
    case 'ignore':
      await ignore(ctx, op.path);
      return {};
    case 'commit':
      await checkExpectedBranch(ctx, op.expectBranch);
      await commit(ctx, op);
      return {};
    case 'undo':
      return undo(ctx, op.sha);
    case 'revert':
      return revert(ctx, op.sha);
    case 'createBranch':
      return createBranch(ctx, op.name, op.from);
    case 'switchBranch':
      return switchBranch(ctx, op.branch, op.leaveChanges);
    case 'renameBranch':
      return renameBranch(ctx, op.branch, op.name);
    case 'deleteBranch':
      return deleteBranch(ctx, op.branch);
    case 'merge':
      return merge(ctx, op.branch);
    case 'abort':
      return abort(ctx);
    case 'fetch':
      await remote(ctx, 'fetch', 'origin', '--prune');
      return {};
    case 'pull':
      return pull(ctx);
    case 'push':
      await checkExpectedBranch(ctx, op.expectBranch);
      return push(ctx);
    case 'stashRestore':
      await restoreStashEntry(ctx, await findPanelStash(ctx, op.sha));
      return {};
    case 'stashDrop':
      await dropStashEntry(ctx, await findPanelStash(ctx, op.sha));
      return {};
  }
}
