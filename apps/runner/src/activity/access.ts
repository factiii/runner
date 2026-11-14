import type { RunnerGrants } from '@shared/all/domains/electron';
import type { RunnerJob } from '@shared/all/domains/runnerActivity';
import {
  channelLevel,
  type VouchedScope
} from '@shared/all/helpers/board-agent-core/runner-access';

// Who sees the runner's Activity (.specs/runner.md "Activity", decided
// 2026-11-11): the owner, every job; a member with full access (Shell) on a
// board, that board's jobs only; nobody else sees a job or a log. Work that
// belongs to no board (Findings, a model download, an `aiPrompt`, Oakbox
// Ask) is the owner's alone. The levels are the runner's own
// (.specs/runner-member-access.md): read at each ask, so a change counts for
// the member's next one.

export const ACTIVITY_REFUSAL =
  'Only the owner of this runner and members with full access (Shell) can see its Activity.';
export const ACTIVITY_SETTINGS_REFUSAL =
  'Only the owner of this runner can change how long History keeps jobs, or whether other runners may start sessions here.';
/** What a job the caller may not see reads as: the same as one that is gone,
 *  so a member cannot probe ids. */
export const NO_SUCH_JOB = 'That job is not on this runner.';

/** Whether `scope` may see (and stop) `job`. */
export function mayWatchJob(
  scope: VouchedScope,
  grants: RunnerGrants,
  job: Pick<RunnerJob, 'board'>
): boolean {
  if (scope.role === 'owner') return true;
  if (job.board === null) return false;
  return channelLevel(scope, grants, job.board) === 'shell';
}

/** Whether `scope` may open Activity at all: the owner, or a member at
 *  Shell on some board the server named for them. */
export function mayOpenActivity(scope: VouchedScope, grants: RunnerGrants): boolean {
  if (scope.role === 'owner') return true;
  return scope.spaceSlugs.some((slug) => channelLevel(scope, grants, slug) === 'shell');
}
