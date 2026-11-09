import path from 'path';

import type { CodexAccess } from '../../domains/electron';
import type { SpacePaths } from './spacePaths';

// What Codex may do in a session on this runner: the sandbox it runs in and
// when it stops to ask. One builder for the terminal tab (`codex`, interactive)
// and the headless runs (`codex exec`), so the two cannot drift apart.
// (.specs/codex-permissions.md)
//
// Two levels, picked per board in Settings > General and saved in the board's
// config, so a restarted runner or a reopened tab launches the same way:
// - standard: Codex's workspace-write sandbox, plus what routine work needs
//   that the sandbox blocks by default: the network (installs, git fetch and
//   push, preview checks), the repository's shared .git (a worktree's commits
//   land there, outside the worktree), and the runner's own folders a session
//   is told to write to ($BUILDS_DIR, $SCRATCHPAD, $BACKUPS_DIR). Codex still
//   asks before anything else outside the sandbox.
// - full: no sandbox and no prompts (`danger-full-access` with approvals
//   `never`), the same reach Claude has in a terminal. Codex documents these
//   two settings together as its full-access mode.

export type { CodexAccess };

export const CODEX_ACCESS_DEFAULT: CodexAccess = 'standard';

/** A stored or sent value as an access level; anything else is standard, so a
 *  config from before the setting (or a bad value) never widens access. */
export function resolveCodexAccess(value: unknown): CodexAccess {
  return value === 'full' ? 'full' : CODEX_ACCESS_DEFAULT;
}

/** Folders outside the session's own directory that standard access may write. */
export function codexWritableRoots(paths: SpacePaths): string[] {
  return [
    // Every worktree's index, refs and objects live in the clone's .git, so a
    // commit from a worktree writes there.
    path.join(paths.repo, '.git'),
    paths.builds,
    paths.scratchpad,
    paths.backups
  ];
}

/** A TOML array of strings. JSON's string escapes are valid TOML basic
 *  strings, so JSON.stringify quotes each path correctly. */
const tomlStrings = (values: string[]): string =>
  `[${values.map((v) => JSON.stringify(v)).join(', ')}]`;

export type CodexPermissionLevel = CodexAccess | 'read-only';

/**
 * Codex's sandbox and approval flags for one launch. They go BEFORE any
 * `resume` subcommand: `codex exec resume` rejects `--sandbox`, while the
 * same flags ahead of it apply to the resumed thread too.
 *
 * `interactive` is the terminal tab, where someone can answer a prompt; a
 * headless `exec` never asks (a question there would hang the run), so a
 * blocked command fails back to the model instead.
 */
export function codexPermissionArgs(opts: {
  level: CodexPermissionLevel;
  interactive: boolean;
  paths?: SpacePaths;
}): string[] {
  const approval = (policy: 'never' | 'on-request') => [
    '-c',
    `approval_policy="${policy}"`
  ];
  if (opts.level === 'full') {
    return ['--sandbox', 'danger-full-access', ...approval('never')];
  }
  if (opts.level === 'read-only') {
    return ['--sandbox', 'read-only', ...approval('never')];
  }
  const args = [
    '--sandbox',
    'workspace-write',
    '-c',
    'sandbox_workspace_write.network_access=true'
  ];
  if (opts.paths) {
    args.push(
      '-c',
      `sandbox_workspace_write.writable_roots=${tomlStrings(codexWritableRoots(opts.paths))}`
    );
  }
  args.push(...approval(opts.interactive ? 'on-request' : 'never'));
  return args;
}

/** One argument as a single-quoted shell word, for the terminal's init script. */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}
