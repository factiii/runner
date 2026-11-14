// The automatic update (.specs/runner-setup.md "Updates"): on by default, a
// runner looks for a newer release a while after it starts, within a minute of
// the server announcing one (`runner:release`, `soon`), and once a day in case
// that announcement never came; it installs it when nothing is running. A version that failed to
// start here before (rolled back, updateSafety.ts) is skipped until a newer
// one is out; the owner can still install it with Update. Each look that
// finds a release it does not install records why (`record`: the Software
// tab's last-outcome line).

import type { RunnerUpdateResult } from '@shared/all/domains/runnerAutoUpdate';

/** The first look, after the runner has settled. */
export const AUTO_UPDATE_FIRST_CHECK_MS = 10 * 60_000;
/** Then this often: the fallback for a release whose announcement this runner
 *  missed (offline, or a server that did not send it). */
export const AUTO_UPDATE_EVERY_MS = 24 * 60 * 60_000;
/** A runner busy with work looks again this soon. */
export const AUTO_UPDATE_BUSY_RETRY_MS = 30 * 60_000;
/** An announced release is looked for at a random point within this, so the
 *  runners told at once do not all ask GitHub and npm in the same second. */
export const AUTO_UPDATE_ANNOUNCED_SPREAD_MS = 60_000;

export type AutoUpdateOutcome =
  | 'off'
  | 'busy'
  | 'none'
  | 'skipped-failed'
  | 'updating';

export type AutoUpdateDeps = {
  /** The owner's setting (updateSafety.ts readUpdateSettings). */
  enabled: () => boolean;
  /** Work an update would cut: sessions working, jobs, AI requests, a nuke. */
  busy: () => boolean;
  /** The version an update would install, or null (selfUpdate.ts
   *  latestAvailable). */
  latest: () => Promise<string | null>;
  /** That version failed to start here before. */
  failed: (version: string) => boolean;
  /** Install and restart (the daemon's applyUpdateAndRestart). */
  apply: (version: string) => Promise<void>;
  log: (line: string) => void;
  /** The last outcome (updateSafety.ts recordLastUpdate). */
  record?: (result: RunnerUpdateResult) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
  clearTimer?: (timer: unknown) => void;
  /** [0, 1), for the spread of an announced release's look. */
  random?: () => number;
};

/** One look: what it found, and the update started when there was one.
 *  The release is looked up first, so a look that skips it can say which
 *  one and why: off, a version that failed here, or work running. */
export async function checkForAutoUpdate(
  deps: AutoUpdateDeps
): Promise<AutoUpdateOutcome> {
  const skipped = (
    version: string,
    reason: 'off' | 'busy' | 'failed-before'
  ) =>
    deps.record?.({
      kind: 'skipped',
      version,
      reason,
      at: (deps.now ?? Date.now)()
    });
  const enabled = deps.enabled();
  // Off and nobody to tell: no network round trip.
  if (!enabled && !deps.record) return 'off';
  const version = await deps.latest();
  if (!enabled) {
    if (version) skipped(version, 'off');
    return 'off';
  }
  if (!version) return 'none';
  if (deps.failed(version)) {
    deps.log(
      `[update] ${version} failed to start here before; not updating to it automatically.`
    );
    skipped(version, 'failed-before');
    return 'skipped-failed';
  }
  // After the look, which took a network round trip.
  if (deps.busy()) {
    skipped(version, 'busy');
    return 'busy';
  }
  deps.log(`[update] ${version} is out; updating automatically.`);
  await deps.apply(version);
  return 'updating';
}

/** Look on a schedule until stopped; `soon` looks within the minute, for a
 *  release the server announced. */
export function startAutoUpdate(deps: AutoUpdateDeps): {
  stop: () => void;
  soon: () => void;
} {
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number) => setTimeout(fn, ms) as { unref?: () => void });
  const clearTimer =
    deps.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const random = deps.random ?? Math.random;
  let timer: unknown = null;
  let stopped = false;
  // One look at a time: an announcement during a look (which may have read
  // the release list before the release) asks for another once it is done.
  let looking = false;
  let announced = false;
  const spread = () => Math.floor(random() * AUTO_UPDATE_ANNOUNCED_SPREAD_MS);
  const schedule = (ms: number) => {
    if (stopped) return;
    if (timer) clearTimer(timer);
    const t = setTimer(() => void tick(), ms);
    t.unref?.();
    timer = t;
  };
  const tick = async () => {
    timer = null;
    looking = true;
    let outcome: AutoUpdateOutcome;
    try {
      outcome = await checkForAutoUpdate(deps);
    } catch (err) {
      deps.log(`[update] automatic check failed: ${err instanceof Error ? err.message : String(err)}`);
      outcome = 'none';
    } finally {
      looking = false;
    }
    if (announced && outcome !== 'busy') {
      announced = false;
      schedule(spread());
      return;
    }
    announced = false;
    schedule(outcome === 'busy' ? AUTO_UPDATE_BUSY_RETRY_MS : AUTO_UPDATE_EVERY_MS);
  };
  schedule(AUTO_UPDATE_FIRST_CHECK_MS);
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimer(timer);
    },
    soon: () => {
      if (stopped) return;
      if (looking) {
        announced = true;
        return;
      }
      schedule(spread());
    }
  };
}
