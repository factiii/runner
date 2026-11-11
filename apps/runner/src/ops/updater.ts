// The ops service's release updater (.specs/ops-user.md, "Updates"). With
// the ops user on, /Applications/Factiii.app belongs to factiii-ops, so the
// app's own updater (the normal user) cannot replace it: this loop does,
// from the ops service. On a schedule and on "Update now" (Factiii Desktop's
// Check for Updates): look up the newest signed release, wait until no job
// runs, then download, verify and hand the swap to the helper that restarts
// the service and rolls back on a failed health check (installRelease).
//
// The decisions are a pure function (nextStep) and the loop takes every
// effect as a dependency, so both are tested without a network or a bundle.

export type Release = { version: string; url: string; sha512: string };

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'waiting-for-jobs'
  | 'installing'
  | 'refused'
  | 'failed';

export type UpdateState = {
  current: string;
  phase: UpdatePhase;
  latest: string | null;
  lastCheckAt: string | null;
  message: string | null;
};

export type OpsUpdaterHandle = {
  state: () => UpdateState;
  /** Check now, and install if there is something newer and no job runs. */
  updateNow: () => Promise<UpdateState>;
};

export type StageResult = { ok: true; staged: string } | { ok: false; reason: string };

export type UpdaterDeps = {
  current: string;
  /** Between scheduled checks. */
  intervalMs: number;
  now: () => number;
  fetchLatest: () => Promise<Release | null>;
  /** Jobs running or queued on every board. */
  activeJobs: () => number;
  /** Download, check the hash, unpack and verify the signature. A refused
   *  download is deleted by stage itself. */
  stage: (release: Release) => Promise<StageResult>;
  /** Hand the verified release to the swap helper. The service is
   *  restarted by it, so this resolves once the helper is started. */
  apply: (staged: string, release: Release) => Promise<void>;
  log?: (line: string) => void;
};

/** -1 / 0 / 1 over dotted numeric versions (a pre-release tag sorts as its
 *  numbers). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export type Step = 'busy' | 'check' | 'wait-for-jobs' | 'install' | 'sleep';

/**
 * What the loop does next.
 * - Busy while a check or an install is in flight.
 * - A newer release known: install it, or wait while a job runs. Not one
 *   that was refused, unless the person asked again (a fixed release under
 *   the same version is a new upload, worth one more try).
 * - Otherwise check when asked, or when the last check is a period old.
 */
export function nextStep(input: {
  phase: UpdatePhase;
  current: string;
  latest: string | null;
  refused: string | null;
  manual: boolean;
  activeJobs: number;
  now: number;
  lastCheckAt: number | null;
  intervalMs: number;
}): Step {
  if (input.phase === 'checking' || input.phase === 'installing') return 'busy';
  const newer = input.latest !== null && compareVersions(input.latest, input.current) > 0;
  if (newer && (input.latest !== input.refused || input.manual)) {
    return input.activeJobs > 0 ? 'wait-for-jobs' : 'install';
  }
  if (input.manual) return 'check';
  if (input.lastCheckAt === null || input.now - input.lastCheckAt >= input.intervalMs) return 'check';
  return 'sleep';
}

export type OpsUpdater = OpsUpdaterHandle & {
  /** One pass of the loop; the service calls it every minute. */
  tick: (manual?: boolean) => Promise<UpdateState>;
};

export function createOpsUpdater(deps: UpdaterDeps): OpsUpdater {
  const log = deps.log ?? (() => undefined);
  let phase: UpdatePhase = 'idle';
  let latest: Release | null = null;
  let refused: string | null = null;
  let lastCheckAt: number | null = null;
  let message: string | null = null;

  const state = (): UpdateState => ({
    current: deps.current,
    phase,
    latest: latest?.version ?? null,
    lastCheckAt: lastCheckAt === null ? null : new Date(lastCheckAt).toISOString(),
    message
  });

  const step = (manual: boolean) =>
    nextStep({
      phase,
      current: deps.current,
      latest: latest?.version ?? null,
      refused,
      manual,
      activeJobs: deps.activeJobs(),
      now: deps.now(),
      lastCheckAt,
      intervalMs: deps.intervalMs
    });

  const check = async () => {
    phase = 'checking';
    lastCheckAt = deps.now();
    try {
      latest = await deps.fetchLatest();
      const newer = latest !== null && compareVersions(latest.version, deps.current) > 0;
      phase = newer ? 'idle' : 'up-to-date';
      message = latest ? null : 'No release could be read.';
    } catch (err) {
      phase = 'failed';
      message = `Could not check for a release: ${err instanceof Error ? err.message : String(err)}`;
    }
  };

  const install = async (release: Release) => {
    phase = 'installing';
    message = `Installing ${release.version}`;
    try {
      const staged = await deps.stage(release);
      if (!staged.ok) {
        phase = 'refused';
        refused = release.version;
        message = `Refused ${release.version}: ${staged.reason}`;
        log(`update refused: ${staged.reason}`);
        return;
      }
      log(`installing ${release.version}`);
      await deps.apply(staged.staged, release);
    } catch (err) {
      phase = 'failed';
      message = `The update failed: ${err instanceof Error ? err.message : String(err)}`;
      log(message);
    }
  };

  const tick = async (manual = false): Promise<UpdateState> => {
    let next = step(manual);
    if (next === 'check') {
      await check();
      if (phase === 'failed') return state();
      next = step(manual);
      // Checked just now: only an install or a wait can follow.
      if (next === 'check') next = 'sleep';
    }
    if (next === 'wait-for-jobs') {
      phase = 'waiting-for-jobs';
      message = `Waiting for the running jobs to end before installing ${latest?.version ?? ''}`.trim();
    } else if (next === 'install' && latest) {
      await install(latest);
    }
    return state();
  };

  return { state, tick, updateNow: () => tick(true) };
}
