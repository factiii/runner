import type {
  RunnerNukePlan,
  RunnerNukeProgress,
  RunnerNukeStep
} from '../domains/electron';
import { RELAY_NUKE_REFUSAL } from './board-agent-core/runner-access';

// Nuke a runner (.specs/runner-setup.md "Nuke a runner"): the phrase, who may
// ask, and the words every surface shows. Shared by the runner (which
// decides), the CLI, and web, mobile and desktop (which only ask).

/** What the person types to erase a runner. Compared exactly: no trim, no
 *  case-folding, no paste shortcut on any surface. */
export const NUKE_PHRASE = 'ALL WILL BE DELETED';

/** Whether `typed` is the phrase, exactly as typed. */
export function nukePhraseMatches(typed: unknown): boolean {
  return typeof typed === 'string' && typed === NUKE_PHRASE;
}

export const NUKE_PHRASE_REFUSAL = `Type exactly "${NUKE_PHRASE}" to nuke this runner. Nothing was erased.`;
export const NUKE_OWNER_ONLY = 'Only the owner of this runner can nuke it.';
export const NUKE_RELAY_REFUSAL = RELAY_NUKE_REFUSAL;
export const NUKE_ALREADY_RUNNING = 'This runner is already being nuked.';

/** Said before the box, on every surface. */
export const NUKE_NO_RECOVERY =
  'Nothing can be recovered afterwards unless a secrets backup of each board exists somewhere else.';

/** The steps in the order they run, with what each says while it runs. */
const NUKE_STEPS: readonly { step: RunnerNukeStep; label: string }[] = [
  { step: 'plan', label: 'Reading what will go' },
  { step: 'unpair', label: 'Unpairing from Factiii' },
  { step: 'service', label: 'Stopping and deleting the service' },
  { step: 'sessions', label: 'Stopping sessions, the simulator and keep-awake' },
  { step: 'keychain', label: 'Erasing the keychain entries' },
  { step: 'secrets', label: 'Erasing every board’s secrets' },
  { step: 'folder', label: 'Erasing the runner folder' },
  { step: 'done', label: 'Done' }
];

function nukeStepLabel(step: RunnerNukeStep): string {
  return NUKE_STEPS.find((s) => s.step === step)?.label ?? step;
}

/**
 * Who may nuke, decided on the runner. The owner only, by id: the channel
 * saying "owner" is not enough without the runner's own pairing naming the
 * same person, unless the runner holds no pairing at all (then only its
 * owner, on the machine, could reach it). Never on the server relay. With
 * `confirm`, the phrase must match exactly. Returns the refusal, or null.
 */
export function nukeRefusal(opts: {
  role: 'owner' | 'member';
  actorUserId: string;
  ownerUserId: string | null;
  transport: 'webrtc' | 'socket';
  confirm?: boolean;
  phrase?: unknown;
}): string | null {
  if (opts.role !== 'owner') return NUKE_OWNER_ONLY;
  if (opts.ownerUserId !== null && String(opts.actorUserId) !== opts.ownerUserId) {
    return NUKE_OWNER_ONLY;
  }
  if (opts.transport === 'socket') return NUKE_RELAY_REFUSAL;
  if (opts.confirm && !nukePhraseMatches(opts.phrase)) return NUKE_PHRASE_REFUSAL;
  return null;
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** The plan as sentences, for the CLI and the confirm box: the boards, each
 *  worktree holding work no remote has (one by one), the secrets, the
 *  backups, what stays for the person to remove, and that nothing comes
 *  back. */
export function nukePlanLines(plan: RunnerNukePlan): string[] {
  const lines: string[] = [];
  lines.push(
    `Everything in ${plan.runnerDir} goes: ${plural(plan.boards.length, 'board')}${
      plan.boards.length ? ` (${plan.boards.map((b) => b.slug).join(', ')})` : ''
    }, with their workspaces, worktrees, vault, scratchpads, drops, backups, logs, jobs and audit log, and the runner's config and pairing.`
  );
  for (const board of plan.boards) {
    for (const tree of board.worktrees) {
      const what = [
        tree.dirty ? 'uncommitted changes' : '',
        tree.unpushed ? 'commits no remote has' : ''
      ].filter(Boolean);
      if (what.length) {
        lines.push(
          `${board.slug}/${tree.name} (${tree.branch || 'no branch'}) has ${what.join(' and ')}.`
        );
      }
    }
  }
  lines.push(
    `${plural(plan.secretsTotal, 'secret')} across every board's secrets store, and the runner's keychain entry.`
  );
  if (plan.backupsTotal) {
    lines.push(`${plural(plan.backupsTotal, 'backup')} in the boards' backups folders.`);
  }
  lines.push(
    `Every terminal and card session, the simulator stream and keep-awake stop${
      plan.service ? `, and the service ${plan.service} is deleted` : ''
    }.`
  );
  // Outside the runner and root's: it stays, and says where it goes.
  lines.push(...(plan.leftBehind ?? []));
  if (plan.paired) {
    lines.push(
      `${plan.runnerName || 'This runner'} is unpaired from Factiii first: it leaves every rail and its token stops working.`
    );
  }
  lines.push(NUKE_NO_RECOVERY);
  return lines;
}

/** The one line a progress frame shows. */
export function nukeProgressLine(progress: RunnerNukeProgress): string {
  const label = nukeStepLabel(progress.step);
  if (progress.state === 'failed') return `${label}: failed. ${progress.lines.join(' ')}`;
  if (progress.state === 'done' && progress.step === 'done') return 'Nuked. The runner is offline.';
  return progress.state === 'done' ? `${label}: done` : `${label}…`;
}
