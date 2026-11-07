import path from 'path';

// The per-space directory layout on the runner host, rooted at the space dir
// (apps/runner/src/paths.ts `spaceDirPath`). Code that needs "the primary
// clone" asks its ExecTarget for `paths.repo` rather than hardcoding a path.

export type SpacePaths = {
  /** Root the rest hang off: the space dir. */
  root: string;
  /** Primary clone of the space repo. Never checked out to a branch: it is
   *  the host for the per-card worktrees below. */
  repo: string;
  /** Parent dir holding one worktree per card. */
  worktrees: string;
  /** Deploy's full checkout of the default branch. Distinct from `repo`
   *  because deploy resets and `git clean -fd`s it, which would blow away
   *  worktree bookkeeping if they shared a clone. */
  workspace: string;
  /** Skills' own worktree off `repo`. Outside `worktrees` so a terminal can
   *  never claim the same name, and outside `workspace` so deploy's
   *  `git clean -fd` cannot delete it. */
  skills: string;
  /** Redis AOF. Its own dir so a `git clean` in a worktree cannot reach it. */
  state: string;
  /** Persistent agent filesystem (DB dumps etc), survives teardown. */
  backups: string;
  /** Build artifacts the deploy skill produces. */
  builds: string;
  /** Helper executables staged for the agent (frpc + the factiii-expose
   *  scripts). On the agent's PATH via ExecTarget.agentEnv. */
  bin: string;
  /** The space's scratchpad: files an agent drops here are drawn in the
   *  terminal window's right-hand panel. On the agent's env as SCRATCHPAD.
   *  See .specs/scratchpad.md. */
  scratchpad: string;
  /** Files the user drops into a session (and Ask images), outside every
   *  worktree. On the agent's env as DROPS_DIR. Untrusted uploads. */
  drops: string;
};

/** The tree for one space. `spaceEnv` derives WORKSPACE/BACKUPS_DIR/BUILDS_DIR
 *  from these, so the deploy contract and the code cannot drift. */
export function hostSpacePaths(spaceDir: string): SpacePaths {
  return {
    root: spaceDir,
    repo: path.join(spaceDir, 'repo'),
    worktrees: path.join(spaceDir, 'worktrees'),
    workspace: path.join(spaceDir, 'workspace'),
    skills: path.join(spaceDir, 'skills'),
    state: path.join(spaceDir, 'state'),
    backups: path.join(spaceDir, 'backups'),
    builds: path.join(spaceDir, 'builds'),
    bin: path.join(spaceDir, 'bin'),
    scratchpad: path.join(spaceDir, 'scratchpad'),
    drops: path.join(spaceDir, 'drops')
  };
}

/** A worktree dir, by work name (a card's task id, a terminal's slugged title). */
export function worktreeFor(paths: SpacePaths, workName: string): string {
  return `${paths.worktrees}/${workName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
}
