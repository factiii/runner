import type {
  BareGitCommit,
  BareGitFileStatus,
  BareGitPanelInfo,
  BareGitUpstream,
  BoardAgentActionMap
} from '../../domains/electron';

// Normalising a bareGitStatus answer is identical on web and mobile, and the
// version skew below is the kind of rule that must not drift between them.

/** What a fetch, pull or push says when it failed and the board has no
 *  GitHub connection: git's own "could not read Username" says nothing about
 *  the fix. The runner sends it; here so both apps can match the words. */
export const NO_GITHUB_REMOTE =
  'This board has no GitHub connection, so the runner cannot reach origin. Connect GitHub in the board’s Settings (General), then try again.';

/** One side of the working tree: the paths, and the diff they came out of. */
export type GitPanelGroup = { files: BareGitFileStatus[]; diff: string };

/** What a source-control panel renders, once the runner's answer is normalised. */
export type GitPanelView = {
  branch: string;
  staged: GitPanelGroup;
  unstaged: GitPanelGroup;
  /** New files git does not track yet, split out of `unstaged` the way GitHub
   *  Desktop lists them. Shares the unstaged diff, which holds their text. */
  untracked: GitPanelGroup;
  /** Newest first. */
  commits: BareGitCommit[];
  /** Null when HEAD tracks no upstream, or the runner is too old to say. */
  upstream: BareGitUpstream | null;
  /** Index and working tree against HEAD: one file's whole change, for the
   *  changes list's line counts. */
  combined: string;
  /** What the panel may write. Null from a runner older than the write
   *  actions, which is read only. */
  panel: BareGitPanelInfo | null;
};

export const EMPTY_GIT_GROUP: GitPanelGroup = { files: [], diff: '' };

/**
 * The runner marks untracked files intent-to-add so their text reaches the
 * diff, and git reports such an entry as an addition on the working-tree side
 * (" A"). Nothing else lands there as 'A': a real `git add` is index-side. So
 * an unstaged 'A' is exactly an untracked file.
 */
function splitUntracked(unstaged: GitPanelGroup): {
  unstaged: GitPanelGroup;
  untracked: GitPanelGroup;
} {
  return {
    unstaged: {
      files: unstaged.files.filter((file) => file.code !== 'A'),
      diff: unstaged.diff
    },
    untracked: {
      files: unstaged.files.filter((file) => file.code === 'A'),
      diff: unstaged.diff
    }
  };
}

/**
 * A runner too old to split the index from the working tree still answers with
 * the combined diff and nothing else. Show all of it as unstaged rather than an
 * empty panel - the rows are still true, they are just not split.
 */
export function toGitPanelView(
  res: BoardAgentActionMap['bareGitStatus']['result']
): GitPanelView {
  const unstaged =
    res.unstaged ??
    (res.staged
      ? EMPTY_GIT_GROUP
      : {
          files: res.changedFiles.map((path) => ({ path, code: 'M' })),
          diff: res.diff
        });
  return {
    branch: res.branch ?? '',
    staged: res.staged ?? EMPTY_GIT_GROUP,
    ...splitUntracked(unstaged),
    commits: res.commits ?? [],
    upstream: res.upstream ?? null,
    combined: res.diff,
    panel: res.panel ?? null
  };
}

/** How much of a file the next commit includes: GitHub Desktop's checkbox,
 *  ticked, empty, or partly ticked when only some of its lines are staged. */
export type Inclusion = 'all' | 'none' | 'partial';

/** One row of the changes list: every changed path once. */
export type ChangedFile = BareGitFileStatus & { inclusion: Inclusion };

/**
 * The changes list GitHub Desktop shows: one row per path, whichever side of
 * the index it sits on. A path only in the index is included, one only in the
 * working tree is not, one in both is partly included. Its status letter is
 * the index's when it has one (a staged rename stays a rename), else the
 * working tree's.
 */
export function changedFiles(
  view: Pick<GitPanelView, 'staged' | 'unstaged' | 'untracked'>
): ChangedFile[] {
  const rows = new Map<string, ChangedFile>();
  for (const file of view.staged.files) {
    rows.set(file.path, { ...file, inclusion: 'all' });
  }
  for (const file of [...view.unstaged.files, ...view.untracked.files]) {
    const row = rows.get(file.path);
    if (row) row.inclusion = 'partial';
    else rows.set(file.path, { ...file, inclusion: 'none' });
  }
  return [...rows.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** The paths an action on a row should name: a staged rename is two. */
export const rowPaths = (file: BareGitFileStatus): string[] =>
  file.oldPath ? [file.path, file.oldPath] : [file.path];

/** The header checkbox's state over every row. */
export function overallInclusion(rows: ChangedFile[]): Inclusion {
  if (rows.length === 0) return 'none';
  if (rows.every((row) => row.inclusion === 'all')) return 'all';
  if (rows.every((row) => row.inclusion === 'none')) return 'none';
  return 'partial';
}

/** What GitHub Desktop's one remote button says and does, from the branch's
 *  state against its namesake on origin. */
export type RemoteButton = {
  kind: 'fetch' | 'pull' | 'push' | 'publish';
  label: string;
  /** ↓ for pull, ↑ for push. 0 hides it. */
  count: number;
  /** Why it cannot be pressed, '' when it can. */
  blocked: string;
};

export function remoteButton(
  panel: BareGitPanelInfo | null,
  branch: string
): RemoteButton {
  const fetch: RemoteButton = {
    kind: 'fetch',
    label: 'Fetch origin',
    count: 0,
    blocked: ''
  };
  if (!panel)
    return {
      ...fetch,
      blocked: 'This runner is too old to fetch from the panel.'
    };
  if (!panel.writable) return { ...fetch, blocked: panel.readOnlyReason };
  if (panel.detached || !branch) return fetch;
  const noPush = panel.protectedBranch
    ? `${branch} is the default branch. Pushing to it is not done from here.`
    : '';
  if (!panel.remote) {
    // The default branch is always on origin; one that is not is not ours
    // to create.
    if (noPush) return fetch;
    return { kind: 'publish', label: 'Publish branch', count: 0, blocked: '' };
  }
  if (panel.remote.behind > 0) {
    return {
      kind: 'pull',
      label: 'Pull origin',
      count: panel.remote.behind,
      blocked: ''
    };
  }
  if (panel.remote.ahead > 0) {
    return {
      kind: 'push',
      label: 'Push origin',
      count: panel.remote.ahead,
      blocked: noPush
    };
  }
  return fetch;
}

/** "Last fetched 5 minutes ago", in GitHub Desktop's words. */
export function lastFetchedLabel(ms: number, now: number): string {
  if (!ms) return 'Never fetched';
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return 'Last fetched just now';
  const units: [number, string][] = [
    [60 * 60 * 24, 'day'],
    [60 * 60, 'hour'],
    [60, 'minute']
  ];
  for (const [size, unit] of units) {
    if (seconds >= size) {
      const n = Math.floor(seconds / size);
      return `Last fetched ${n} ${unit}${n === 1 ? '' : 's'} ago`;
    }
  }
  return 'Last fetched just now';
}

/** A commit message as the commit box holds it: the first line, then the
 *  rest. */
export function splitCommitMessage(message: string): {
  summary: string;
  description: string;
} {
  const [summary = '', ...rest] = message.trim().split('\n');
  return { summary: summary.trim(), description: rest.join('\n').trim() };
}

/** What a status letter means, for a badge's tooltip. */
export const GIT_STATUS_LABEL: Record<string, string> = {
  A: 'Added',
  M: 'Modified',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  U: 'Conflicted',
  T: 'Type changed'
};

/**
 * Where the two sides of a file's diff live, so the diff pane can fetch the
 * bytes of either (an image's before and after) with bareGitBlob. Each is a
 * ref that call accepts: HEAD, INDEX, WORKTREE, or a commit id (with `^` for
 * its parent).
 */
export type GitDiffSource = { oldRef: string; newRef: string };

/** Staged: what the next commit would change, HEAD -> index. */
export const STAGED_DIFF_SOURCE: GitDiffSource = {
  oldRef: 'HEAD',
  newRef: 'INDEX'
};

/** Unstaged and untracked: the index -> the file on disk. */
export const UNSTAGED_DIFF_SOURCE: GitDiffSource = {
  oldRef: 'INDEX',
  newRef: 'WORKTREE'
};

/** One commit's own change: its first parent -> it. */
export const commitDiffSource = (sha: string): GitDiffSource => ({
  oldRef: `${sha}^`,
  newRef: sha
});

/** A branch comparison: the merge base -> the branch tip. Null from a runner
 *  too old to say which commits those are. */
export const compareDiffSource = (
  mergeBase: string | undefined,
  headSha: string | undefined
): GitDiffSource | null =>
  mergeBase && headSha ? { oldRef: mergeBase, newRef: headSha } : null;

/**
 * The branch picker's list: local branches first, then remote ones, each
 * narrowed to the names holding every word of `query` (case ignored), so
 * "card fix" finds `factiii/card-12-fix`.
 */
export function filterBranches(
  branches: string[],
  remoteBranches: string[],
  query: string
): { local: string[]; remote: string[] } {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const remoteSet = new Set(remoteBranches);
  const local: string[] = [];
  const remote: string[] = [];
  for (const name of branches) {
    const lower = name.toLowerCase();
    if (!words.every((word) => lower.includes(word))) continue;
    (remoteSet.has(name) ? remote : local).push(name);
  }
  return { local, remote };
}
