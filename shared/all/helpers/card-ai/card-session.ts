import type { ExecTarget } from '../board-agent-core/exec';
import {
  isDisposableWorktree,
  touchedWithin,
  isWorktreePath,
  listTerminalWorktrees,
  removeWorktree,
  removeWorktreeAndBranch,
  worktreeLeftovers
} from '../board-agent-core/git';
import type { BaseSession } from '../board-agent-core/session';
import {
  type CardRecord,
  deleteCard,
  putCard
} from '../board-agent-core/state';
import {
  killTerminalSessions,
  killTmuxSessions,
  safeTmuxName,
  tmuxPanePaths
} from '../board-agent-core/tmux';

// Space-session helpers shared by both mode engines (claude pipeline +
// terminal) and the orchestrator. State is mirrored to the space's redis so a
// runner restart can rehydrate it.

/** What a teardown needs: a live session, or the card record standing in for
 *  one the engine no longer holds in memory. */
type TeardownSubject = Pick<
  BaseSession,
  'postId' | 'mode' | 'workspacePath'
>;

/** Git card: runs in its own worktree. */
export function isWorktreeSession(
  s: Pick<BaseSession, 'workspacePath'>,
  target: ExecTarget
): boolean {
  return isWorktreePath(target, s.workspacePath);
}

/** A session as a durable CardRecord. `prompt` is claude-only (empty for bare);
 *  `pendingQuestion` rides along from the session. */
function sessionToRecord(s: BaseSession, prompt = ''): CardRecord {
  return {
    postId: s.postId,
    taskId: s.taskId,
    mode: s.mode,
    phase: s.phase,
    provider: s.provider,
    worktreePath: s.workspacePath,
    agentSessionId: s.agentSessionId,
    cardId: s.cardId,
    startedBy: s.startedBy,
    startedVia: s.startedVia,
    taskTitle: s.taskTitle,
    targetBranch: s.targetBranch,
    startedAt: s.startedAt,
    prompt,
    pendingQuestion: s.pendingQuestion
  };
}

/** Persist a session's record. Best-effort: a redis failure must never fail
 *  the run. */
export async function putSessionCard(
  s: BaseSession,
  target: ExecTarget,
  prompt = ''
): Promise<void> {
  try {
    await putCard(target, sessionToRecord(s, prompt));
  } catch {
    // best-effort bookkeeping
  }
}

// Tear a card down: drop its worktree and its state row. The space workspace
// stays up - it is shared by every card in the space.
//
// Terminals also lose their branch: it is the only place their work lives, End
// says so, and leaving it behind is what stranded branches on every runner. A
// card's branch survives - discarding a card is not meant to bin commits the
// agent made but never pushed, and that path has no confirmation.
//
// Returns what it could not remove, as sentences for the user (empty when all
// of it went), so End can say so instead of closing on a name still taken.
//
// `keepBranch` keeps a terminal's branch too, as a card's is kept: the board
// MCP's end_session does by default (session-hypervisor.ts), so an agent
// ending another agent's session never bins its commits. The app's End does
// not pass it.
export async function teardownSession(
  s: TeardownSubject,
  target: ExecTarget,
  opts: { keepBranch?: boolean } = {}
): Promise<string[]> {
  // Before the worktree: a live process holding it open can fail the removal,
  // and a shell killed afterwards writes into a directory that is gone.
  //
  // Here rather than in the callers because every teardown path runs through
  // this one function — per-caller, `cardKill` reaped terminals and
  // `cardDismiss` did not, so ending a session left its `claude` running.
  await killTerminalSessions(target, s.postId).catch(() => {});
  let left: string[] = [];
  if (isWorktreeSession(s, target)) {
    const dropsBranch = s.mode === 'bare' && !opts.keepBranch;
    const drop = dropsBranch ? removeWorktreeAndBranch : removeWorktree;
    await drop(target, s.workspacePath).catch(() => {});
    left = await worktreeLeftovers(
      target,
      s.workspacePath,
      // A card (or a kept branch) keeps its branch on purpose; only its
      // folder is checked.
      dropsBranch ? 'terminal' : 'card'
    ).catch(() => []);
  }
  await deleteCard(target, s.postId).catch(() => {});
  return left;
}

/** True when `dir` is `root` or inside it. */
function within(dir: string, root: string): boolean {
  return dir === root || dir.startsWith(`${root}/`);
}

/** The launcher terminal's worktree, read off where its tmux panes sit, for an
 *  End that has neither a session in memory nor a card record to say. Only a
 *  launcher terminal (`bare-…`): its worktree is its own, and End discards it.
 *  A tree some other session or record holds is never returned - a pane can
 *  `cd` anywhere. */
export async function orphanWorkspaceFromPanes(
  target: ExecTarget,
  postId: string,
  claimedPaths: Iterable<string>
): Promise<string> {
  if (!postId.startsWith('bare-')) return '';
  const claimed = new Set(claimedPaths);
  const prefix = `terminal-${safeTmuxName(postId)}-`;
  const base = `${target.paths.worktrees}/`;
  for (const [name, dir] of await tmuxPanePaths(target)) {
    if (!name.startsWith(prefix) || !dir.startsWith(base)) continue;
    const tree = base + dir.slice(base.length).split('/')[0];
    if (tree !== base && !claimed.has(tree)) return tree;
  }
  return '';
}

/** What a startup sweep must leave alone: every card record and every session
 *  in memory, by postId and by worktree (a starting terminal has a worktree
 *  before it has a record). */
type ClaimedWork = { postIds: Set<string>; paths: Set<string> };

/** A worktree this new is a terminal still starting, not a leftover: it can
 *  exist before anything records it (QA 2026-10-25). */
const SWEEP_MIN_AGE_MIN = 10;

/** Remove what ended sessions left behind with nothing to say they were ever
 *  there: terminal worktrees (and their branches) no record or live session
 *  holds, and the `terminal-bare-*` tmux sessions sitting in them. A runner
 *  that lost a session from memory used to leave both, and the leftover
 *  worktree kept the name "already in use" for good.
 *
 *  Conservative by design: a worktree with any uncommitted or untracked file,
 *  an ignored `.env*`, a commit no remote has, or a change in the last
 *  SWEEP_MIN_AGE_MIN minutes stays. `claimed` is asked again right before each
 *  removal, since terminals can start while the sweep runs. Only tmux sessions
 *  inside a worktree being removed are killed: one tmux server serves every
 *  space on the host, and a shell elsewhere holds no name. */
export async function sweepLeftoverTerminals(
  target: ExecTarget,
  claimed: () => ClaimedWork
): Promise<{ removedWorktrees: string[]; killedSessions: string[] }> {
  const removedWorktrees: string[] = [];
  const killedSessions: string[] = [];
  const isClaimed = (path: string) => claimed().paths.has(path);
  for (const { path, branch } of await listTerminalWorktrees(target)) {
    if (isClaimed(path)) continue;
    if (await touchedWithin(target, path, SWEEP_MIN_AGE_MIN)) continue;
    if (!(await isDisposableWorktree(target, path, branch))) continue;
    if (isClaimed(path)) continue;

    const owned = [...claimed().postIds].map(
      (id) => `terminal-${safeTmuxName(id)}-`
    );
    const shells = [...(await tmuxPanePaths(target))]
      .filter(
        ([name, dir]) =>
          name.startsWith('terminal-bare-') &&
          !owned.some((prefix) => name.startsWith(prefix)) &&
          within(dir, path)
      )
      .map(([name]) => name);
    // Shells first, as in teardownSession: a live process can hold a worktree
    // open and fail its removal.
    await killTmuxSessions(target, shells);
    killedSessions.push(...shells);
    await removeWorktreeAndBranch(target, path).catch(() => {});
    removedWorktrees.push(path);
  }
  return { removedWorktrees, killedSessions };
}
