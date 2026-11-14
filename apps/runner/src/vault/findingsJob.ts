import type { FindingsRun } from './engagement';

// Findings as a scheduled job on the analytics runner (.specs/analytics.md
// "Findings"): the tests run here, over every device's intervals in the
// Vault, and devices read the result with `engagementQuery { kind:
// 'findings' }` instead of each working it out over its own rows.
//
// When it runs: a few minutes after a push brought rows (pushes come in
// bursts, so one run follows them), and once a day, since the 90-day window
// slides even when no row arrives. A run whose rows, zone and Tone list are
// what the last run saw stores nothing new (engagement.ts `runFindings`).
//
// It needs the Vault open. A locked Vault is not unlocked for it: the run is
// skipped and the next tick tries again. A device's push is itself Vault
// activity, so the run after a push finds it open.
//
// Where it shows: the runner's Running jobs rows (the board engines'
// ActivityTracker, kind `findings`), working while it runs and an error row
// when it fails; and the runner's Activity (card 9b50ee2e, activity/), where
// each run is a `findings` job: a Vault job, so metadata only (daemon.ts).

/** Once a day, even without a push. */
export const FINDINGS_JOB_EVERY_MS = 24 * 60 * 60_000;
/** After a push, this long for the burst to settle. */
export const FINDINGS_AFTER_PUSH_MS = 5 * 60_000;

/** One run's outcome: the store's, or why there was none. */
export type FindingsJobOutcome =
  | FindingsRun
  | { state: 'locked' }
  | { state: 'absent' }
  | { state: 'failed'; error: string };

/** The Running jobs row: working, an error, or none (null clears it). */
export type FindingsJobActivity = { state: 'working' | 'error' | null; detail: string };

type Timer = ReturnType<typeof setTimeout>;

export type FindingsJobOptions = {
  /** One run over the Vault (daemonVault.ts `findings`). */
  run: () => Promise<FindingsJobOutcome>;
  onActivity: (activity: FindingsJobActivity) => void;
  everyMs?: number;
  afterPushMs?: number;
};

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class FindingsJob {
  private daily: ReturnType<typeof setInterval> | null = null;
  private afterPush: Timer | null = null;
  private running: Promise<FindingsJobOutcome> | null = null;

  constructor(private readonly options: FindingsJobOptions) {}

  /** The daily tick. Unref'd, so it never keeps the process up. */
  start(): void {
    if (this.daily) return;
    this.daily = setInterval(() => void this.runNow(), this.options.everyMs ?? FINDINGS_JOB_EVERY_MS);
    this.daily.unref?.();
  }

  stop(): void {
    if (this.daily) clearInterval(this.daily);
    if (this.afterPush) clearTimeout(this.afterPush);
    this.daily = null;
    this.afterPush = null;
  }

  /** A push brought rows: run once the burst settles (one timer, moved
   *  back by each push). */
  pushed(): void {
    if (this.afterPush) clearTimeout(this.afterPush);
    this.afterPush = setTimeout(() => {
      this.afterPush = null;
      void this.runNow();
    }, this.options.afterPushMs ?? FINDINGS_AFTER_PUSH_MS);
    this.afterPush.unref?.();
  }

  /** Run now; a run already going is joined, not started twice. */
  runNow(): Promise<FindingsJobOutcome> {
    this.running ??= this.once().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async once(): Promise<FindingsJobOutcome> {
    const { onActivity } = this.options;
    onActivity({ state: 'working', detail: 'Testing what goes together in your reading' });
    try {
      const outcome = await this.options.run();
      onActivity({ state: null, detail: '' });
      return outcome;
    } catch (err) {
      const detail = message(err);
      console.error(`[vault] findings: ${detail}`);
      onActivity({ state: 'error', detail });
      return { state: 'failed', error: detail };
    }
  }
}
