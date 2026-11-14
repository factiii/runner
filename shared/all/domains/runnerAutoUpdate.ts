import type { RunnerFeature } from './runnerProtocol';

// Software > "Update automatically" (.specs/runner-setup.md "Install and
// update"): the runner's own automatic-update switch, the one
// `factiii-runner update auto on|off` writes, and the last update's outcome
// in plain words. The runner answers `autoUpdateGet` / `autoUpdateSet`
// (apps/runner/src/updateSafety.ts readAutoUpdateState); web, the desktop
// app (which renders web) and the phone show it the same way from here.

/** Why an update that was out was not installed. */
export type RunnerUpdateSkipReason =
  /** Automatic updates are off. */
  | 'off'
  /** Work an update would cut was running (sessions, jobs, AI requests). */
  | 'busy'
  /** That version failed to start here before and was rolled back. */
  | 'failed-before'
  /** The install itself did not go through. */
  | 'install-failed';

/** An update's outcome. `at` is ms since epoch. The last install or rollback
 *  is kept in `<runner dir>/updates/last.json`, the last skip apart in
 *  `last-skip.json`, so a look every few hours that skips a release never
 *  hides what the last update did. */
export type RunnerUpdateResult =
  | { kind: 'installed'; version: string; from: string; at: number }
  | {
      kind: 'rolled-back';
      version: string;
      from: string;
      at: number;
      reason: string;
    }
  | {
      kind: 'skipped';
      version: string;
      at: number;
      reason: RunnerUpdateSkipReason;
    };

/** What `autoUpdateGet` and `autoUpdateSet` answer. */
export type RunnerAutoUpdateState = {
  /** Whether the runner updates itself now (env override and saved
   *  setting together). */
  auto: boolean;
  /** `FACTIII_RUNNER_AUTO_UPDATE` turns it off on this machine: the switch
   *  cannot change it. */
  forcedByEnv: boolean;
  /** The runner Factiii Desktop carries: it updates with the app. */
  bundled: boolean;
  /** The last install or rollback. A runner from before `lastSkip` sends
   *  whichever outcome came last here, a skip included. */
  lastResult: RunnerUpdateResult | null;
  /** The last look that found a release and did not install it. Absent from
   *  a runner older than this field. */
  lastSkip?: RunnerUpdateResult | null;
};

/** The feature a runner announces when it answers the two actions; a runner
 *  without it gets no switch (.specs/versioning.md "Protocol"). */
export const AUTO_UPDATE_SETTING_FEATURE: RunnerFeature = 'autoUpdateSetting';

export const AUTO_UPDATE_LABEL = 'Update automatically';
export const AUTO_UPDATE_HINT =
  'Installs a new runner release when nothing is running, and goes back to the old one if it fails to start. On by default.';

/** The switch shows for the owner of a runner that has the actions. */
export const showAutoUpdateSwitch = (
  isOwner: boolean,
  features: readonly string[] | undefined
): boolean => isOwner && (features ?? []).includes(AUTO_UPDATE_SETTING_FEATURE);

/** Why the switch cannot be changed, or null when it can. */
export const autoUpdateLockReason = (
  state: Pick<RunnerAutoUpdateState, 'forcedByEnv' | 'bundled'>
): string | null => {
  if (state.bundled) {
    return 'This runner comes with Factiii Desktop and updates with the app.';
  }
  if (state.forcedByEnv) {
    return 'Turned off on this machine by FACTIII_RUNNER_AUTO_UPDATE. Remove it from the runner’s environment to use this switch.';
  }
  return null;
};

const SKIP_WORDS: Record<RunnerUpdateSkipReason, string> = {
  off: 'not installed because automatic updates are off.',
  busy: 'waiting until nothing is running; it tries again in 30 minutes.',
  'failed-before':
    'skipped because it failed to start here before. Use Update to install it anyway.',
  'install-failed': 'the install did not go through; it tries again later.'
};

const DAY_MS = 24 * 60 * 60_000;

const startOfDay = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "Today 3:00 PM", "Yesterday 3:00 PM", else "Nov 20, 3:00 PM". Kept here
 *  (not scheduledPostsView's) so the runner's CLI loads nothing else. */
const whenLabel = (at: number, now: Date, locale?: string): string => {
  const date = new Date(at);
  const time = date.toLocaleTimeString(locale, {
    hour: 'numeric',
    minute: '2-digit'
  });
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  const day = date.toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' })
  });
  return `${day}, ${time}`;
};

/** The last update's outcome, one sentence for the line under the switch. */
export const describeUpdateResult = (
  result: RunnerUpdateResult | null,
  now: Date = new Date(),
  locale?: string
): string => {
  if (!result) return 'No update has run on this runner yet.';
  const when = whenLabel(result.at, now, locale);
  if (result.kind === 'installed') {
    return `Updated to ${result.version} (from ${result.from}). ${when}.`;
  }
  if (result.kind === 'rolled-back') {
    return `${result.version} failed to start (${result.reason}), so the runner went back to ${result.from}. Automatic updates skip ${result.version}. ${when}.`;
  }
  return `${result.version} is out: ${SKIP_WORDS[result.reason]} ${when}.`;
};

/** The lines under the switch (web, the phone, `factiii-runner update
 *  status`): the last install or rollback, then the last skip when it came
 *  after it. A skip from before the last install is old news. */
export const describeUpdateLines = (
  state: Pick<RunnerAutoUpdateState, 'lastResult' | 'lastSkip'>,
  now: Date = new Date(),
  locale?: string
): string[] => {
  const { lastResult } = state;
  const lastSkip = state.lastSkip ?? null;
  const skipIsNews = !!lastSkip && (!lastResult || lastSkip.at > lastResult.at);
  const lines: string[] = [];
  if (lastResult || !skipIsNews)
    lines.push(describeUpdateResult(lastResult, now, locale));
  if (skipIsNews) lines.push(describeUpdateResult(lastSkip, now, locale));
  return lines;
};
