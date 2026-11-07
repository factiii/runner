import type {
  BareGitBlob,
  BareGitCommit,
  BareGitFileStatus,
  BareGitUpstream,
  SessionGitSummary
} from '../../domains/electron';
import type { ExecTarget } from './exec';
import { worktreeFor } from './spacePaths';
import { slugifyWorkName } from './workName';

/** The clone URL every `origin` is set to: the repository's plain https URL,
 *  never a credential in it. The token goes per command (githubAuth) and, for
 *  sessions, through the credential helper (sessionCredentialConfig). */
export function buildCloneUrl(repoUrl: string): string {
  const url = new URL(repoUrl);
  url.username = '';
  url.password = '';
  if (!url.pathname.endsWith('.git')) {
    url.pathname += '.git';
  }
  return url.toString();
}

/** The only host the GitHub connection's token is ever offered to. */
const GITHUB_ORIGIN = 'https://github.com';

/** The env var the one-shot helper below reads the token from. */
const GIT_TOKEN_ENV = 'FACTIII_GIT_TOKEN';

/** Answers git's `get` with the token in $FACTIII_GIT_TOKEN, and nothing for
 *  `store`/`erase` or when the variable is empty. */
const ONE_SHOT_HELPER = `!f() { test "$1" = get && test -n "$${GIT_TOKEN_ENV}" && printf 'username=x-access-token\npassword=%s\n' "$${GIT_TOKEN_ENV}"; }; f`;

/**
 * Auth for one of the runner's own git commands (clone, fetch, push,
 * ls-remote): config args to put before the subcommand, and env to run it
 * with.
 *
 * A one-shot credential helper that echoes an env var, not an
 * `http.extraheader` in GIT_CONFIG_*: argv holds only the helper's text (argv
 * is what `ps` shows every user), the token sits in the env of this one git
 * process and its children (readable by the same user only), and nothing
 * writes it to disk. git asks the helper only when GitHub asks for auth, and
 * only for github.com; a header would ride every request. The empty
 * `credential.helper` first drops every other helper (osxkeychain would pop a
 * dialog and keep a copy; the clone's own session helper would call the
 * socket), and it leaves the session `GIT_CONFIG_*` alone.
 */
export function githubAuth(githubToken: string): {
  args: string[];
  env: Record<string, string>;
} {
  return {
    args: [
      '-c',
      'credential.helper=',
      '-c',
      `credential.${GITHUB_ORIGIN}.helper=${ONE_SHOT_HELPER}`
    ],
    env: {
      GIT_TERMINAL_PROMPT: '0',
      ...(githubToken ? { [GIT_TOKEN_ENV]: githubToken } : {})
    }
  };
}

/**
 * The local config of a clone sessions push from: no other helper (the empty
 * value clears osxkeychain and any global one, which come earlier), then
 * `factiii-secrets git-credential`, which asks the runner for the board's
 * GitHub token as it is now. Worktrees read their clone's config, so every
 * card and terminal gets it.
 *
 * By absolute path, not by name: a login shell (an authorized command) does
 * not have `<space>/bin` on PATH, and a plugin copy of `factiii-secrets`
 * from another runner version can sit earlier on an agent's PATH.
 */
export function sessionCredentialConfig(
  secretsBin: string
): [string, string][] {
  const quoted = `'${secretsBin.split("'").join(`'\\''`)}'`;
  return [
    ['credential.helper', ''],
    [`credential.${GITHUB_ORIGIN}.helper`, `!${quoted} git-credential`]
  ];
}

/** Write sessionCredentialConfig into the primary clone. --replace-all, so a
 *  second run changes nothing and an extra value cannot make it fail. */
export async function setSessionCredentialHelper(
  target: ExecTarget,
  secretsBin: string
): Promise<void> {
  for (const [key, value] of sessionCredentialConfig(secretsBin)) {
    await gitInDir(
      target,
      target.paths.repo,
      'config',
      '--replace-all',
      key,
      value
    );
  }
}

/** A clone URL with its credentials taken out: what `origin` is set back to
 *  when the GitHub connection is removed. Not parsed as a URL, so whatever git
 *  handed back comes out otherwise unchanged. */
export function stripCloneUrlCredentials(cloneUrl: string): string {
  return cloneUrl.replace(/\/\/[^@/]*@/, '//');
}

/** Run a git command in a specific workdir on the session's exec target. */
export async function gitInDir(
  target: ExecTarget,
  workdir: string,
  ...args: string[]
): Promise<string> {
  return target.run(['git', '-C', workdir, ...args]);
}

/** Whether `dir` is inside a git checkout (`rev-parse --is-inside-work-tree`).
 *  False for a missing folder or no git, never a throw: it decides only
 *  whether the IDE offers its git panel. */
export async function isGitCheckout(
  target: ExecTarget,
  dir: string
): Promise<boolean> {
  if (!dir) return false;
  const out = await gitInDir(
    target,
    dir,
    'rev-parse',
    '--is-inside-work-tree'
  ).catch(() => '');
  return out.trim() === 'true';
}

/** gitInDir for a command that talks to origin: the target's GitHub token
 *  goes with this one command (githubAuth). */
export async function gitRemote(
  target: ExecTarget,
  workdir: string,
  ...args: string[]
): Promise<string> {
  const auth = githubAuth(target.githubToken?.() ?? '');
  return target.run(['git', ...auth.args, '-C', workdir, ...args], {
    env: auth.env
  });
}

/** The two AI session types that open a worktree; a terminal is not a card. */
export type WorkKind = 'card' | 'terminal';

/** These land in the user's own repo, so they carry no product name. */
const WORK_BRANCH_PREFIXES: Record<WorkKind, string> = {
  card: 'card/',
  terminal: 'terminal/'
};

const ALL_WORK_BRANCH_PREFIXES = Object.values(WORK_BRANCH_PREFIXES).sort(
  (a, b) => b.length - a.length
);

/** Branch name from a work name (card task id / terminal title) and its kind. */
function workBranch(workName: string, kind: WorkKind): string {
  return `${WORK_BRANCH_PREFIXES[kind]}${workName.replace(/[^a-zA-Z0-9._-]/g, '-')}`;
}

/** The work name a branch encodes, or null when it is not a work branch. */
function workNameFromBranch(branch: string): string | null {
  for (const prefix of ALL_WORK_BRANCH_PREFIXES) {
    if (branch.startsWith(prefix)) return branch.slice(prefix.length);
  }
  return null;
}

/** Every worktree name in use: the dirs on disk plus the branches they sit on,
 *  since a dir can be gone while its branch lives. Feeds the launcher's
 *  duplicate check as well as `claimWorkName`.
 *
 *  A branch with no worktree only holds its name while it holds work: commits
 *  that are on no remote. One that is all pushed or merged is a leftover of a
 *  session that ended, `addWorktree` resets it with nothing to lose, and
 *  counting it locked the name of every ended session for good. */
export async function listWorkNames(target: ExecTarget): Promise<string[]> {
  const dirs = await target
    .sh(
      `ls -1 '${target.paths.worktrees.replace(/'/g, `'\\''`)}' 2>/dev/null || true`
    )
    .catch(() => '');
  const branches = await gitInDir(
    target,
    target.paths.repo,
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads/'
  ).catch(() => '');
  const checkedOut = await gitInDir(
    target,
    target.paths.repo,
    'worktree',
    'list',
    '--porcelain'
  )
    .then(
      (out) =>
        new Set(
          out
            .split('\n')
            .filter((line) => line.startsWith('branch refs/heads/'))
            .map((line) => line.slice('branch refs/heads/'.length).trim())
        )
    )
    // Unknown is not "none": with no list to check against, every work branch
    // keeps its name.
    .catch(() => null);
  const names = new Set(dirs.split('\n').map((line) => line.trim()));
  for (const line of branches.split('\n')) {
    const branch = line.trim();
    const workName = workNameFromBranch(branch);
    if (!workName || names.has(workName)) continue;
    if (
      checkedOut &&
      !checkedOut.has(branch) &&
      !(await hasUnpublishedCommits(target, branch))
    ) {
      continue;
    }
    names.add(workName);
  }
  names.delete('');
  return [...names];
}

/** True when `branch` has a commit no remote has, or when that cannot be told:
 *  the callers discard on a false, so doubt has to read as work. */
async function hasUnpublishedCommits(
  target: ExecTarget,
  branch: string
): Promise<boolean> {
  return gitInDir(
    target,
    target.paths.repo,
    'rev-list',
    '--max-count=1',
    `refs/heads/${branch}`,
    '--not',
    '--remotes'
  )
    .then((out) => out.trim() !== '')
    .catch(() => true);
}

/** The worktree name for `desired`, proven free. Throws rather than picking a
 *  variant: the name is the user's, and `addWorktree` clears a same-named tree,
 *  so a silent fallback would cost them a live session. `extraTaken` carries
 *  names claimed but not yet on disk. */
export async function claimWorkName(
  target: ExecTarget,
  desired: string,
  extraTaken: Iterable<string> = []
): Promise<string> {
  const name = slugifyWorkName(desired);
  if (!name) throw new Error('Name this terminal before starting it.');
  const taken = new Set([...(await listWorkNames(target)), ...extraTaken]);
  if (taken.has(name)) {
    throw new Error(`"${name}" is already in use. Pick another name.`);
  }
  return name;
}

/** Point an existing primary clone's `origin` at `cloneUrl`, and nothing else:
 *  no fetch, no checkout, so it is safe under running sessions. Worktrees share
 *  the clone's config, so this one write reaches all of them. False when there
 *  is no clone to rewrite. */
export async function setPrimaryCloneOrigin(
  target: ExecTarget,
  cloneUrl: string
): Promise<boolean> {
  const repo = target.paths.repo;
  try {
    await target.sh(`test -d ${repo}/.git`);
  } catch {
    // not cloned yet
    return false;
  }
  await gitInDir(target, repo, 'remote', 'set-url', 'origin', cloneUrl);
  return true;
}

/** Ensure the primary clone exists and is fresh at `paths.repo`: clone on first
 *  use, else set-url + fetch. The set-url also takes a token an older runner
 *  put in `origin` back out. Never checked out to a branch. */
export async function ensurePrimaryClone(
  target: ExecTarget,
  cloneUrl: string,
  branch: string
): Promise<void> {
  const repo = target.paths.repo;

  if (await setPrimaryCloneOrigin(target, cloneUrl)) {
    await gitRemote(target, repo, 'fetch', 'origin', '--prune');
    // Keep worktree bookkeeping tidy: drop refs for worktrees whose dirs are
    // gone (crashed runs), so `worktree add` never trips over stale entries.
    await gitInDir(target, repo, 'worktree', 'prune').catch(() => {});
    return;
  }

  const auth = githubAuth(target.githubToken?.() ?? '');
  await target.run(
    ['git', ...auth.args, 'clone', '--branch', branch, cloneUrl, repo],
    { cwd: target.paths.root, env: auth.env }
  );
  await target.sh(`mkdir -p ${target.paths.worktrees}`);
}

/** Create a fresh worktree named `workName` on its own branch off `baseBranch`
 *  (a distinct branch per worktree, so git's same-branch-checkout ban never
 *  bites). Cards pass their task id; terminals pass `claimWorkName(name)`. */
export async function addWorktree(
  target: ExecTarget,
  workName: string,
  baseBranch: string,
  kind: WorkKind
): Promise<{ path: string; branch: string }> {
  const path = worktreeFor(target.paths, workName);
  const branch = workBranch(workName, kind);
  // The clone is only fetched when a space is provisioned, so `origin/<branch>`
  // can be hours old by the time work starts here. Fetch first, or the worktree
  // begins from a stale base. Offline is not fatal: fall back to what is local.
  await gitRemote(
    target,
    target.paths.repo,
    'fetch',
    'origin',
    baseBranch
  ).catch(() => {});
  // Best-effort clear of a same-named leftover from a prior run on this name.
  await removeWorktree(target, path).catch(() => {});
  await gitInDir(
    target,
    target.paths.repo,
    'worktree',
    'add',
    '-B',
    branch,
    path,
    `origin/${baseBranch}`
  );
  return { path, branch };
}

/** Remove a card's worktree and its bookkeeping, and make sure the directory
 *  is gone. git refuses some removals (a nested repo, a file it cannot unlink,
 *  a worktree it has lost track of), and every caller swallows the error, so a
 *  refused removal used to leave the whole directory behind, `node_modules`
 *  and all: several GB per ended session. Only a path under
 *  `paths.worktrees` is ever deleted by hand. */
export async function removeWorktree(
  target: ExecTarget,
  path: string
): Promise<void> {
  const refused = await gitInDir(
    target,
    target.paths.repo,
    'worktree',
    'remove',
    '--force',
    path
  ).then(
    () => null,
    (err: unknown) => err
  );
  const inside =
    isWorktreePath(target, path) && !path.split('/').includes('..');
  if (refused && inside) {
    await target.run(['rm', '-rf', '--', path]);
    await pruneWorktrees(target);
    return;
  }
  if (refused) throw refused;
}

/** Remove a worktree and the branch it sat on. Being under `paths.worktrees` is
 *  what makes the branch disposable, not its name — a prefix check would
 *  silently stop deleting the day a prefix changes.
 *
 *  The terminal branch named after the directory goes too. HEAD is not always
 *  it: a `git switch` inside the terminal leaves the branch the session was
 *  created on behind, and a directory that is already gone has no HEAD to ask.
 *  Either way the name stayed claimed after End. */
export async function removeWorktreeAndBranch(
  target: ExecTarget,
  path: string
): Promise<void> {
  const head = await gitInDir(target, path, 'rev-parse', '--abbrev-ref', 'HEAD')
    .then((out) => out.trim())
    .catch(() => '');
  // A directory removed by hand fails this, and must not keep the branches.
  // Prune drops the bookkeeping that would otherwise still hold them checked
  // out.
  await removeWorktree(target, path).catch(() => pruneWorktrees(target));
  const own = workBranch(path.slice(path.lastIndexOf('/') + 1), 'terminal');
  const branches = new Set<string>();
  if (head && head !== 'HEAD') branches.add(head);
  // End discards what the session had checked out; that is what its
  // confirmation says. A branch left behind by a `git switch` was not on
  // screen, so it goes only when it holds nothing a remote lacks.
  // `listWorkNames` keeps its name claimed for the same reason.
  if (own === head || !(await hasUnpublishedCommits(target, own))) {
    branches.add(own);
  }
  for (const branch of branches) {
    // git refuses a branch another worktree has checked out, so this cannot
    // take one out from under a live session.
    await gitInDir(target, target.paths.repo, 'branch', '-D', branch).catch(
      () => {}
    );
  }
}

/** What a removal left standing at `path`, as sentences for the user: the
 *  directory, and for a terminal the branch that holds its name. Empty when it
 *  is all gone. A terminal branch kept for its unpublished commits is reported
 *  rather than deleted: End is not the place to bin work nobody saw. */
export async function worktreeLeftovers(
  target: ExecTarget,
  path: string,
  kind: WorkKind
): Promise<string[]> {
  const left: string[] = [];
  const dirStays = await target.run(['test', '-e', path]).then(
    () => true,
    () => false
  );
  if (dirStays) left.push(`its folder ${path} could not be removed`);
  if (kind === 'terminal') {
    const own = workBranch(path.slice(path.lastIndexOf('/') + 1), kind);
    const branchStays = await gitInDir(
      target,
      target.paths.repo,
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${own}`
    ).then(
      () => true,
      () => false
    );
    if (branchStays) {
      left.push(
        (await hasUnpublishedCommits(target, own))
          ? `the branch ${own} holds commits no remote has, so it was kept`
          : `the branch ${own} could not be deleted`
      );
    }
  }
  return left;
}

/** Terminal worktrees: the directories under `paths.worktrees` whose checkout
 *  sits on a `terminal/` branch. Read per directory rather than off `git
 *  worktree list`, which prints resolved paths (`/private/var/…` for
 *  `/var/…`) that would never match the ones sessions and records hold. A
 *  directory git cannot read, or one that is detached, is not listed. */
export async function listTerminalWorktrees(
  target: ExecTarget
): Promise<{ path: string; branch: string }[]> {
  const dirs = await target
    .sh(
      `ls -1 '${target.paths.worktrees.replace(/'/g, `'\\''`)}' 2>/dev/null || true`
    )
    .catch(() => '');
  const trees: { path: string; branch: string }[] = [];
  for (const line of dirs.split('\n')) {
    const name = line.trim();
    if (!name) continue;
    const tree = `${target.paths.worktrees}/${name}`;
    const branch = await worktreeBranch(target, tree);
    if (!branch.startsWith(WORK_BRANCH_PREFIXES.terminal)) continue;
    trees.push({ path: tree, branch });
  }
  return trees;
}

/** An ignored file that is still someone's work: a hand-made `.env`. Build
 *  output and node_modules, also ignored, are not. */
const KEPT_IGNORED = /(^|\/)\.env[^/]*$/;

/** True only when removing this worktree and its branch loses nothing: no
 *  uncommitted or untracked file, no ignored `.env*`, no commit a remote
 *  lacks. Any doubt (git failing, a missing directory) reads as work. */
export async function isDisposableWorktree(
  target: ExecTarget,
  path: string,
  branch: string
): Promise<boolean> {
  if (await hasUncommittedWork(target, path)) return false;
  return !(await hasUnpublishedCommits(target, branch));
}

/** What a worktree holds that no remote has, for a plan that names it before
 *  erasing it (a runner nuke): the branch, uncommitted work (as
 *  isDisposableWorktree reads it) and unpushed commits. Doubt reads as work. */
export async function worktreeWorkState(
  target: ExecTarget,
  path: string
): Promise<{ branch: string; dirty: boolean; unpushed: boolean }> {
  const branch = await worktreeBranch(target, path);
  const dirty = await hasUncommittedWork(target, path);
  const unpushed =
    branch && branch !== 'HEAD'
      ? await hasUnpublishedCommits(target, branch)
      : // Detached or unreadable: whatever HEAD holds that no remote has.
        await gitInDir(
          target,
          path,
          'rev-list',
          '--max-count=1',
          'HEAD',
          '--not',
          '--remotes'
        )
          .then((out) => out.trim() !== '')
          .catch(() => true);
  return { branch, dirty, unpushed };
}

/** An uncommitted or untracked file, or an ignored `.env*`, in `path`. */
async function hasUncommittedWork(
  target: ExecTarget,
  path: string
): Promise<boolean> {
  return gitInDir(target, path, 'status', '--porcelain', '--ignored=matching')
    .then((out) =>
      out
        .split('\n')
        .filter(Boolean)
        .some(
          (line) =>
            !line.startsWith('!! ') || KEPT_IGNORED.test(line.slice(3).trim())
        )
    )
    .catch(() => true);
}

/** The branch a worktree has checked out, or '' when git cannot say. */
export async function worktreeBranch(
  target: ExecTarget,
  path: string
): Promise<string> {
  return gitInDir(target, path, 'rev-parse', '--abbrev-ref', 'HEAD')
    .then((out) => out.trim())
    .catch(() => '');
}

/** True when the folder itself changed in the last `minutes` - a worktree a
 *  terminal is creating right now, before anything records it. Any doubt
 *  reads as recent. */
export async function touchedWithin(
  target: ExecTarget,
  path: string,
  minutes: number
): Promise<boolean> {
  return target
    .run(['find', path, '-maxdepth', '0', '-mmin', `-${minutes}`])
    .then(
      (out) => String(out).trim() !== '',
      () => true
    );
}

/** Prune worktree refs whose directories are gone (crashed-run cleanup). */
export async function pruneWorktrees(target: ExecTarget): Promise<void> {
  await gitInDir(target, target.paths.repo, 'worktree', 'prune').catch(
    () => {}
  );
}

/** True when this path is a per-card worktree rather than a shared workspace. */
export function isWorktreePath(target: ExecTarget, path: string): boolean {
  return path.startsWith(`${target.paths.worktrees}/`);
}

/** Set git author identity on ONE repo. Never --global: that was container-local
 *  before, but on the host it would rewrite the owner's own ~/.gitconfig, and
 *  per-space identities would clobber each other. */
export async function setGitIdentity(
  target: ExecTarget,
  name?: string,
  email?: string,
  workdir: string = target.paths.workspace
): Promise<void> {
  if (name) await gitInDir(target, workdir, 'config', 'user.name', name);
  if (email) await gitInDir(target, workdir, 'config', 'user.email', email);
}

/** Extract diff and changed file list from a working tree. */
export async function extractDiff(
  target: ExecTarget,
  workdir: string = target.paths.workspace
): Promise<{ diff: string; changedFiles: string[] }> {
  // `git diff HEAD` only shows tracked files. Mark untracked files with
  // intent-to-add (respects .gitignore) so they appear in the diff as new
  // file additions and in --name-only output. commitAndPush later runs a
  // real `git add .` which supersedes the intent-to-add markers.
  await gitInDir(target, workdir, 'add', '--intent-to-add', '.');
  const diff = await gitInDir(target, workdir, 'diff', 'HEAD');
  const changedFilesRaw = (
    await gitInDir(target, workdir, 'diff', 'HEAD', '--name-only')
  ).trim();
  return {
    diff,
    changedFiles: changedFilesRaw ? changedFilesRaw.split('\n') : []
  };
}

/** Everything the source-control panel renders for a workspace. */
export type GitPanelState = {
  branch: string;
  staged: { files: BareGitFileStatus[]; diff: string };
  unstaged: { files: BareGitFileStatus[]; diff: string };
  /** Newest first. */
  commits: BareGitCommit[];
  /** The branch HEAD tracks and how far apart the two are. Absent when it
   *  tracks none (a fresh terminal branch nobody has pushed). */
  upstream?: BareGitUpstream;
  /** Index + working tree against HEAD, for callers that want one blob. */
  diff: string;
  changedFiles: string[];
};

// %x1f is the ASCII unit separator: it cannot appear in a name, a date or a
// commit subject, so no quoting is needed to split the fields back apart.
const LOG_FORMAT = '%H%x1f%h%x1f%an%x1f%aI%x1f%ar%x1f%s';
const LOG_FIELD_SEP = '\x1f';

/** Split porcelain v1 output into the index side (X) and the working-tree side
 *  (Y). A path can land in both: git stages a snapshot, not a file. */
export function parseStatus(raw: string): {
  staged: BareGitFileStatus[];
  unstaged: BareGitFileStatus[];
} {
  const staged: BareGitFileStatus[] = [];
  const unstaged: BareGitFileStatus[] = [];
  for (const line of raw.split('\n')) {
    if (line.length < 4) continue;
    const x = line[0]!;
    const y = line[1]!;
    // A rename reads "R  old -> new". The new path is the one to open.
    const rest = line.slice(3);
    const arrow = rest.indexOf(' -> ');
    const path = arrow === -1 ? rest : rest.slice(arrow + 4);
    // The source of a rename, so an action on the row (unstage, discard) can
    // take both halves of it.
    const from = arrow === -1 ? {} : { oldPath: rest.slice(0, arrow) };
    // '??' is an untracked file the intent-to-add below has not reached yet
    // (it is .gitignore'd, or the marking failed). Either way it is not staged.
    if (x === '?' || y === '?') {
      unstaged.push({ path, code: 'A' });
      continue;
    }
    if (x !== ' ') staged.push({ path, code: x, ...from });
    if (y !== ' ') unstaged.push({ path, code: y });
  }
  return { staged, unstaged };
}

export function parseLog(raw: string, localShas: Set<string>): BareGitCommit[] {
  const commits: BareGitCommit[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const [sha, shortSha, author, date, relative, ...subject] =
      line.split(LOG_FIELD_SEP);
    if (!sha || !shortSha) continue;
    commits.push({
      sha,
      shortSha,
      author: author ?? '',
      date: date ?? '',
      relative: relative ?? '',
      // A subject holding the separator would split into extra fields; joining
      // the tail back puts it together again.
      subject: subject.join(LOG_FIELD_SEP) || '(no commit message)',
      local: localShas.has(sha)
    });
  }
  return commits;
}

/**
 * Read the whole git picture for a workspace in one pass: staged paths,
 * unstaged paths, the diffs behind them, and recent history. One read rather
 * than three calls from the panel, so the three sections can never disagree
 * with each other mid-edit.
 */
export async function readGitPanel(
  target: ExecTarget,
  workdir: string,
  logLimit = 40
): Promise<GitPanelState> {
  // A panel read is a poll, not an operation: a git command that fails (an
  // empty repo has no HEAD to diff) leaves its section empty instead of
  // blanking the panel.
  const git = (...args: string[]): Promise<string> =>
    gitInDir(target, workdir, ...args).catch(() => '');

  // Untracked files are invisible to `git diff` until the index knows them.
  // --intent-to-add respects .gitignore and stages no content - git reports
  // such an entry on the working-tree side (" A"), never as staged - and
  // commitAndPush resets the markers before it commits.
  await git('add', '--intent-to-add', '.');
  // --no-optional-locks: a poll must never take index.lock out from under a
  // command the user is running in the terminal beside it.
  const { staged, unstaged } = parseStatus(
    await git(
      '--no-optional-locks',
      '-c',
      'core.quotePath=false',
      'status',
      '--porcelain=v1',
      '--untracked-files=all'
    )
  );
  const stagedDiff = await git('diff', '--cached', '--no-color');
  const unstagedDiff = await git('diff', '--no-color');
  const diff = await git('diff', 'HEAD', '--no-color');
  // Commits on this branch that no remote ref contains - the work done in this
  // workspace and not pushed anywhere yet.
  const localShas = new Set(
    (
      await git(
        'rev-list',
        '-n',
        String(logLimit),
        'HEAD',
        '--not',
        '--remotes'
      )
    )
      .split('\n')
      .map((sha) => sha.trim())
      .filter(Boolean)
  );
  const commits = parseLog(
    await git('log', '-n', String(logLimit), `--format=${LOG_FORMAT}`),
    localShas
  );
  const branch = (await git('rev-parse', '--abbrev-ref', 'HEAD')).trim();
  const upstream = await readUpstream(git);

  return {
    branch,
    staged: { files: staged, diff: stagedDiff },
    unstaged: { files: unstaged, diff: unstagedDiff },
    commits,
    ...(upstream ? { upstream } : {}),
    diff,
    // The union of both sides, which is what `git diff HEAD --name-only`
    // reports - one call cheaper.
    changedFiles: [
      ...new Set([...staged, ...unstaged].map((file) => file.path))
    ]
  };
}

/** `git rev-list --left-right --count A...B` -> how far B is ahead of and
 *  behind A. Zeroes for an empty answer (a failed read), never NaN. */
export function parseLeftRight(raw: string): {
  ahead: number;
  behind: number;
} {
  const [behind = 0, ahead = 0] = raw
    .trim()
    .split(/\s+/)
    .map((n) => Number(n) || 0);
  return { ahead, behind };
}

/** The upstream HEAD tracks, for the header's ahead/behind. As fresh as the
 *  last fetch: the panel only reads, it never fetches. */
async function readUpstream(
  git: (...args: string[]) => Promise<string>
): Promise<BareGitUpstream | null> {
  const name = (
    await git(
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{upstream}'
    )
  ).trim();
  if (!name) return null;
  return {
    name,
    ...parseLeftRight(
      await git('rev-list', '--left-right', '--count', '@{upstream}...HEAD')
    )
  };
}

/** Client paths arrive `/`-prefixed and repo-relative, the way bareFsList
 *  emits them. Git wants them relative to the worktree - and wants nothing
 *  outside it, so a path that climbs is dropped rather than passed on. */
export function toRepoRelative(paths: string[]): string[] {
  const clean: string[] = [];
  for (const raw of paths) {
    const rel = raw.trim().replace(/^\/+/, '');
    if (!rel || rel === '.') continue;
    if (rel.split('/').includes('..')) continue;
    clean.push(rel);
  }
  return clean;
}

/** The git arguments for a staging call. An empty `paths` means the whole tree
 *  - that is the section header's + and -. A `paths` that had entries but lost
 *  all of them to the safety check must NOT mean that: falling through to '.'
 *  would turn one rejected path into "stage everything". */
function stageTargets(paths: string[]): string[] {
  if (paths.length === 0) return ['.'];
  const rel = toRepoRelative(paths);
  if (rel.length === 0) throw new Error('No path in that request was usable.');
  return rel;
}

/** Move paths into the index. An empty list stages the whole tree. */
export async function stagePaths(
  target: ExecTarget,
  workdir: string,
  paths: string[]
): Promise<void> {
  // `--` so a file named like a flag is still read as a path.
  await gitInDir(target, workdir, 'add', '--', ...stageTargets(paths));
}

/** Take paths back out of the index, leaving the working tree untouched. An
 *  empty list unstages everything. */
export async function unstagePaths(
  target: ExecTarget,
  workdir: string,
  paths: string[]
): Promise<void> {
  const targets = stageTargets(paths);
  try {
    await gitInDir(target, workdir, 'restore', '--staged', '--', ...targets);
  } catch {
    // Before the first commit there is no HEAD to restore an index entry from.
    // Dropping the entry is the same thing when there is nothing to go back to.
    await gitInDir(
      target,
      workdir,
      'rm',
      '--cached',
      '-r',
      '--quiet',
      '--',
      ...targets
    );
  }
}

/** The patch one commit introduced. --first-parent -m so a merge reads as the
 *  change it brought in rather than as nothing at all. */
export async function readCommitDiff(
  target: ExecTarget,
  workdir: string,
  sha: string
): Promise<{
  diff: string;
  changedFiles: string[];
  files: BareGitFileStatus[];
}> {
  if (!/^[0-9a-f]{4,40}$/i.test(sha)) {
    throw new Error(`Not a commit id: ${sha}`);
  }
  const show = (...args: string[]): Promise<string> =>
    gitInDir(
      target,
      workdir,
      'show',
      '--first-parent',
      '-m',
      ...args,
      sha
    ).catch(() => '');
  const diff = await show('--no-color', '--format=', '--patch');
  // --name-status rather than --name-only, so each row can say what happened
  // to its file. The paths are the same ones --name-only printed.
  const files = parseNameStatus(await show('--format=', '--name-status'));
  return {
    diff,
    changedFiles: files.map((file) => file.path),
    files
  };
}

/** `git diff --name-status` rows: a status letter, a tab, the path. A rename
 *  or copy carries a score and two paths ("R087\told\tnew"); the new one is
 *  the path the diff names and the one to open. */
export function parseNameStatus(raw: string): BareGitFileStatus[] {
  const files: BareGitFileStatus[] = [];
  for (const line of raw.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const path = line.slice(line.lastIndexOf('\t') + 1).trim();
    if (path) files.push({ path, code: line[0]! });
  }
  return files;
}

export type BranchCompare = {
  base: string;
  branches: string[];
  files: BareGitFileStatus[];
  diff: string;
  ahead: number;
  behind: number;
  /** The checked-out branch, which `branches` leaves out. */
  current: string;
  /** Which of `branches` are remote-tracking, for a picker that groups them:
   *  a local branch can hold a '/' too, so the name alone cannot say. */
  remoteBranches: string[];
  /** The branch that was compared: `head` as asked, '' for HEAD. */
  head: string;
  /** What `head` has that `base` does not, newest first: a PR's commits. */
  commits: BareGitCommit[];
  /** The two commits the diff runs between, so a viewer can fetch either
   *  side of a file (an image's before and after). '' with nothing chosen. */
  mergeBase: string;
  headSha: string;
};

// A branch holds more history than a sidebar should list; past this the list
// says so rather than shipping every commit.
const COMPARE_LOG_LIMIT = 100;

/**
 * What `head` (HEAD unless named) changed since it diverged from `base`
 * (three-dot: the merge base, so work that landed on `base` meanwhile is not
 * shown as this branch undoing it), plus the branches there are to pick from.
 * Naming `head` is how the panel *views* a branch it has not checked out.
 *
 * `base` and `head` must be one of those branches (or the current one). That
 * is the whole of the validation: a name is only ever handed to git after git
 * itself listed it, so nothing typed by a client reaches a command line as a
 * ref or a flag. With no `base`, the first of `preferred` that exists is used.
 *
 * Reads only, and never fetches: a remote branch is as fresh as the last fetch
 * the workspace did.
 */
export async function readBranchCompare(
  target: ExecTarget,
  workdir: string,
  base: string | undefined,
  preferred: string[],
  head?: string
): Promise<BranchCompare> {
  const git = (...args: string[]): Promise<string> =>
    gitInDir(target, workdir, '--no-optional-locks', ...args).catch(() => '');
  const current = (await git('rev-parse', '--abbrev-ref', 'HEAD')).trim();
  // Full ref names, shortened here: `%(refname:short)` prints a remote's HEAD
  // pointer as the bare remote name, which nothing could tell from a local
  // branch called the same.
  const branches: string[] = [];
  const remoteBranches: string[] = [];
  const refs = await git(
    'for-each-ref',
    '--format=%(refname)',
    'refs/heads',
    'refs/remotes'
  );
  for (const line of refs.split('\n')) {
    const ref = line.trim();
    const name = ref.replace(/^refs\/(heads|remotes)\//, '');
    // A remote's HEAD is a pointer to another entry in this list.
    if (!name || name === ref || ref.endsWith('/HEAD')) continue;
    if (name === current) continue;
    branches.push(name);
    if (ref.startsWith('refs/remotes/')) remoteBranches.push(name);
  }
  // The checked-out branch is HEAD: naming it is the same as naming nothing.
  const tip = head && head !== current ? head : '';
  if (tip && !branches.includes(tip)) {
    throw new Error(`No branch named ${tip} here.`);
  }
  const empty = {
    branches,
    files: [],
    diff: '',
    ahead: 0,
    behind: 0,
    current,
    remoteBranches,
    head: tip,
    commits: [],
    mergeBase: '',
    headSha: ''
  };
  // A viewed branch may be compared with the checked-out one, so the current
  // branch is a valid base once another branch is the head.
  const bases = tip
    ? [...branches.filter((b) => b !== tip), current]
    : branches;
  if (base !== undefined && !bases.includes(base)) {
    throw new Error(`No branch named ${base} here.`);
  }
  const chosen = base ?? preferred.find((name) => bases.includes(name));
  if (!chosen) return { base: '', ...empty };

  const headRef = tip || 'HEAD';
  const range = `${chosen}...${headRef}`;
  const files = parseNameStatus(
    await git(
      '-c',
      'core.quotePath=false',
      'diff',
      '--name-status',
      '--no-renames',
      range
    )
  );
  const diff = await git('diff', '--no-color', '--no-renames', range);
  const { ahead, behind } = parseLeftRight(
    await git('rev-list', '--left-right', '--count', range)
  );
  const localShas = new Set(
    (
      await git(
        'rev-list',
        '-n',
        String(COMPARE_LOG_LIMIT),
        headRef,
        '--not',
        '--remotes'
      )
    )
      .split('\n')
      .map((sha) => sha.trim())
      .filter(Boolean)
  );
  const commits = parseLog(
    await git(
      'log',
      '-n',
      String(COMPARE_LOG_LIMIT),
      `--format=${LOG_FORMAT}`,
      `${chosen}..${headRef}`
    ),
    localShas
  );
  const mergeBase = (await git('merge-base', chosen, headRef)).trim();
  const headSha = (await git('rev-parse', '--verify', headRef)).trim();
  return {
    ...empty,
    base: chosen,
    files,
    diff,
    ahead,
    behind,
    commits,
    mergeBase,
    headSha
  };
}

// A before/after preview is a picture, not an archive: past this the viewer
// says the file is too large instead of moving it over the wire.
export const GIT_BLOB_MAX_BYTES = 5 * 1024 * 1024;

const SHA_REF = /^[0-9a-f]{4,40}\^?$/i;

/** One path's bytes at one revision, base64, for the diff pane's image
 *  before/after. `ref` is HEAD, INDEX (the staged copy), WORKTREE (the file on
 *  disk), or a commit id with an optional `^` for its parent - nothing a
 *  client could turn into a flag or an arbitrary rev expression. */
export async function readGitBlob(
  target: ExecTarget,
  workdir: string,
  ref: string,
  path: string
): Promise<BareGitBlob> {
  const [rel] = toRepoRelative([path]);
  if (!rel) throw new Error('That path is not in this workspace.');
  if (ref !== 'HEAD' && ref !== 'INDEX' && ref !== 'WORKTREE') {
    if (!SHA_REF.test(ref)) throw new Error(`Not a revision: ${ref}`);
  }
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
  const dir = q(workdir);
  if (ref === 'WORKTREE') {
    const file = q(`${workdir.replace(/\/+$/, '')}/${rel}`);
    // Unquoted `$(wc -c)` on purpose: BSD wc pads its count with spaces.
    const size = Number(
      (await target.sh(`[ -f ${file} ] && wc -c < ${file} || echo -1`)).trim()
    );
    if (size < 0) throw new Error('Not in the working tree.');
    if (size > GIT_BLOB_MAX_BYTES) return { content: '', size, tooLarge: true };
    // `base64 -w 0` is GNU-only, so strip the wrapping with tr instead.
    const content = (await target.sh(`base64 < ${file} | tr -d '\\n'`)).trim();
    return { content, size };
  }
  // `:path` is the index's copy; `rev:path` is that revision's.
  const object = q(`${ref === 'INDEX' ? '' : ref}:${rel}`);
  const sizeRaw = await target
    .sh(`git -C ${dir} cat-file -s ${object}`)
    .catch(() => '');
  const size = Number(sizeRaw.trim());
  if (!sizeRaw.trim() || !Number.isFinite(size)) {
    throw new Error('Not in that version.');
  }
  if (size > GIT_BLOB_MAX_BYTES) return { content: '', size, tooLarge: true };
  const content = (
    await target.sh(
      `git -C ${dir} cat-file blob ${object} | base64 | tr -d '\\n'`
    )
  ).trim();
  return { content, size };
}

/** `git diff --shortstat` -> lines added and removed. Either half is absent
 *  when it is zero, and the whole line is empty for no change. */
export function parseShortstat(raw: string): {
  added: number;
  removed: number;
} {
  const added = /(\d+) insertion/.exec(raw)?.[1];
  const removed = /(\d+) deletion/.exec(raw)?.[1];
  return { added: Number(added ?? 0), removed: Number(removed ?? 0) };
}

/**
 * The counts the sessions rail shows under a terminal: how far the worktree is
 * from the branch it was cut from, and what is not yet committed or pushed.
 * Counts only — the diffs stay with the git panel, which asks for them.
 *
 * Reads only, like readBranchCompare, and never takes index.lock. The base is
 * the first of `preferred` that resolves; with none, only the local counts.
 */
export async function readGitSummary(
  target: ExecTarget,
  workdir: string,
  preferred: string[]
): Promise<SessionGitSummary> {
  const git = (...args: string[]): Promise<string> =>
    gitInDir(target, workdir, '--no-optional-locks', ...args).catch(() => '');
  let base = '';
  for (const name of preferred) {
    if ((await git('rev-parse', '--verify', '--quiet', name)).trim()) {
      base = name;
      break;
    }
  }
  // All reads, so they can run together: none takes a lock.
  const [status, unpushed, counts, mergeBase] = await Promise.all([
    git('status', '--porcelain=v1', '--untracked-files=all'),
    git('rev-list', '--count', 'HEAD', '--not', '--remotes'),
    base
      ? git('rev-list', '--left-right', '--count', `${base}...HEAD`)
      : Promise.resolve(''),
    base ? git('merge-base', base, 'HEAD') : Promise.resolve('')
  ]);
  const [behind = 0, ahead = 0] = counts
    .trim()
    .split(/\s+/)
    .map((n) => Number(n) || 0);
  // Against the merge base and the working tree, so the count covers the
  // commits made here plus the edits not committed yet — and not the work that
  // landed on the base meanwhile. With no base, just the uncommitted edits.
  const { added, removed } = parseShortstat(
    await git('diff', '--shortstat', mergeBase.trim() || 'HEAD')
  );
  return {
    ahead,
    behind,
    added,
    removed,
    dirty: status.split('\n').filter((line) => line.length > 3).length,
    unpushed: Number(unpushed.trim()) || 0
  };
}

/** A worktree's work as an agent asking about it (or ending it) needs to
 *  see: the branch, every path with work on it, and the counts. */
export type WorkState = SessionGitSummary & {
  branch: string;
  /** Paths with uncommitted work, untracked included, and an ignored
   *  `.env*` (someone's hand-made config, which a removal would lose). */
  dirtyFiles: string[];
};

/** readGitSummary plus the branch and the dirty paths themselves, for the
 *  board MCP's read_session and end_session (session-hypervisor.ts). The
 *  paths count what isDisposableWorktree counts: an ignored `.env*` is work. */
export async function readWorkState(
  target: ExecTarget,
  workdir: string,
  preferred: string[]
): Promise<WorkState> {
  const [summary, branch, status] = await Promise.all([
    readGitSummary(target, workdir, preferred),
    worktreeBranch(target, workdir),
    gitInDir(
      target,
      workdir,
      '--no-optional-locks',
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--ignored=matching'
    )
  ]);
  const dirtyFiles = status
    .split('\n')
    .filter((line) => line.length > 3)
    .filter(
      (line) =>
        !line.startsWith('!! ') || KEPT_IGNORED.test(line.slice(3).trim())
    )
    .map((line) => line.slice(3).trim());
  return { ...summary, branch, dirtyFiles };
}

/** List remote branches from a repo dir. */
export async function listRemoteBranches(
  target: ExecTarget,
  workdir: string = target.paths.workspace
): Promise<string[]> {
  try {
    const stdout = await gitRemote(
      target,
      workdir,
      'ls-remote',
      '--heads',
      'origin'
    );
    const trimmed = stdout.trim();
    return trimmed
      ? trimmed.split('\n').map((line) => line.replace(/.*refs\/heads\//, ''))
      : [];
  } catch {
    return [];
  }
}

/** Thrown by commitAndPush when the workspace has nothing to commit. */
export class NoChangesError extends Error {
  readonly code = 'NO_CHANGES' as const;
  constructor(message = 'No changes to commit.') {
    super(message);
    this.name = 'NoChangesError';
  }
}

export type CommitAndPushResult = {
  pushedSha: string;
  remoteSha: string;
  branch: string;
};

/**
 * Commit and push to a branch (existing or new).
 * Throws NoChangesError when there is nothing to commit, and Error when the
 * post-push verification proves the remote did not advance.
 */
export async function commitAndPush(
  target: ExecTarget,
  branchName: string,
  commitMessage: string,
  gitConfig?: { gitName?: string; gitEmail?: string },
  workdir: string = target.paths.workspace
): Promise<CommitAndPushResult> {
  if (gitConfig?.gitName)
    await gitInDir(target, workdir, 'config', 'user.name', gitConfig.gitName);
  if (gitConfig?.gitEmail)
    await gitInDir(target, workdir, 'config', 'user.email', gitConfig.gitEmail);

  // `git status --porcelain` reports modifications, additions, deletions, and
  // untracked files. The previous `git diff HEAD` check missed untracked
  // files, so an agent that only created new files would silently no-op here.
  const status = (
    await gitInDir(target, workdir, 'status', '--porcelain')
  ).trim();
  if (!status) throw new NoChangesError();

  // extractDiff marks new files intent-to-add for the review diff, and stash
  // cannot handle i-t-a index entries ("Entry not uptodate. Cannot merge").
  // Unstage everything - files stay on disk; `git add -A` below re-stages.
  await gitInDir(target, workdir, 'reset', '--quiet');

  // If the name is already taken on origin (an earlier proposal), push a
  // fresh dated branch instead of touching the existing one's history.
  let targetBranch = branchName;
  try {
    await gitRemote(
      target,
      workdir,
      'ls-remote',
      '--exit-code',
      '--heads',
      'origin',
      branchName
    );
    const stamp = new Date()
      .toISOString()
      .slice(0, 16)
      .replace(/[-:]/g, '')
      .replace('T', '-');
    targetBranch = `${branchName}-${stamp}`;
  } catch {
    // name is free
  }

  await gitInDir(target, workdir, 'checkout', '-B', targetBranch);
  await gitInDir(target, workdir, 'add', '-A');
  await gitInDir(target, workdir, 'commit', '-m', commitMessage);
  await gitRemote(target, workdir, 'push', 'origin', targetBranch);

  // `git push` exits 0 even when nothing was pushed ("Everything up-to-date"),
  // so a clean exit is not proof that the remote advanced. Fetch the remote
  // ref we just wrote and assert it matches our local HEAD.
  await gitRemote(target, workdir, 'fetch', 'origin', targetBranch);
  const remoteSha = (
    await gitInDir(target, workdir, 'rev-parse', `origin/${targetBranch}`)
  ).trim();
  const localSha = (
    await gitInDir(target, workdir, 'rev-parse', 'HEAD')
  ).trim();
  if (remoteSha !== localSha) {
    throw new Error(
      `Push verification failed: local HEAD ${localSha.slice(0, 8)} does not match origin/${targetBranch} ${remoteSha.slice(0, 8)}`
    );
  }

  return { pushedSha: localSha, remoteSha, branch: targetBranch };
}
