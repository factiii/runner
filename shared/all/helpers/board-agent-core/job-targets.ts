import type { RunnerJobTargetWait } from '../../domains/electron';

// Cross-board waits on a job's `target` (.specs/runner-secrets-gate.md "One
// job at a time per space"). Each board already runs its own jobs one at a
// time; a job that names a target (say "factiii-server") also waits while a
// job with the same target runs on ANY board of this runner, so two boards
// cannot deploy the same production app at once. FIFO per target. In memory
// only: a runner restart drops every hold and every wait.
//
// Pure (no node imports), so web and mobile can import the wait line too.

type Holder = {
  callId: string;
  job: string;
  board: string;
  callerName: string;
  startedAt: number;
};

type Waiter = Holder & {
  grant: (release: () => void) => void;
  onWait: (wait: RunnerJobTargetWait) => void;
};

export class JobTargets {
  private holders = new Map<string, Holder>();
  private waiters = new Map<string, Waiter[]>();

  constructor(private now: () => number = Date.now) {}

  /**
   * Take `target` for one call. Resolves with the release once the call
   * holds it: at once when the target is free and nobody is ahead, else after
   * every call ahead released it. While waiting, `onWait` hears the holder and
   * the call's place in line (1 = next), again on each change. Rejects with
   * 'Cancelled.' when `signal` aborts first, and frees its place in line. The
   * release is idempotent.
   */
  acquire(
    target: string,
    who: { callId: string; job: string; board: string; callerName: string },
    signal: AbortSignal,
    onWait: (wait: RunnerJobTargetWait) => void
  ): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new Error('Cancelled.'));
    const now = this.tryAcquire(target, who);
    if (now) return Promise.resolve(now);
    const line = this.waiters.get(target) ?? [];
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const queue = this.waiters.get(target) ?? [];
        const at = queue.indexOf(waiter);
        if (at === -1) return;
        queue.splice(at, 1);
        if (!queue.length) this.waiters.delete(target);
        reject(new Error('Cancelled.'));
        this.announce(target);
      };
      const waiter: Waiter = {
        ...who,
        startedAt: 0,
        grant: (release) => {
          signal.removeEventListener('abort', onAbort);
          resolve(release);
        },
        onWait
      };
      line.push(waiter);
      this.waiters.set(target, line);
      signal.addEventListener('abort', onAbort, { once: true });
      this.announce(target);
    });
  }

  /** Take `target` now when it is free and nobody waits for it: the
   *  release, else null (the caller then waits with `acquire`). */
  tryAcquire(
    target: string,
    who: { callId: string; job: string; board: string; callerName: string }
  ): (() => void) | null {
    if (this.holders.has(target) || this.waiters.has(target)) return null;
    this.holders.set(target, { ...who, startedAt: this.now() });
    return this.releaser(target, who.callId);
  }

  /** Who holds `target` now, or null. */
  holder(target: string): Holder | null {
    return this.holders.get(target) ?? null;
  }

  private releaser(target: string, callId: string): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (this.holders.get(target)?.callId !== callId) return;
      this.holders.delete(target);
      const queue = this.waiters.get(target) ?? [];
      const next = queue.shift();
      if (!queue.length) this.waiters.delete(target);
      if (!next) return;
      this.holders.set(target, {
        callId: next.callId,
        job: next.job,
        board: next.board,
        callerName: next.callerName,
        startedAt: this.now()
      });
      next.grant(this.releaser(target, next.callId));
      this.announce(target);
    };
  }

  /** Tell each call still in line who holds the target and its place. */
  private announce(target: string): void {
    const holder = this.holders.get(target);
    if (!holder) return;
    const queue = this.waiters.get(target) ?? [];
    queue.forEach((waiter, i) =>
      waiter.onWait({
        target,
        holder: {
          job: holder.job,
          board: holder.board,
          callerName: holder.callerName,
          startedAt: new Date(holder.startedAt).toISOString()
        },
        position: i + 1
      })
    );
  }
}

/** Every board of this runner process shares this one: the cross-board hold. */
export const runnerJobTargets = new JobTargets();

const MINUTE_MS = 60_000;
const HOUR_MIN = 60;

function ago(fromIso: string, now: number): string {
  const min = Math.max(0, Math.floor((now - Date.parse(fromIso)) / MINUTE_MS));
  if (!Number.isFinite(min) || min < 1) return 'just now';
  if (min < HOUR_MIN) return `${min} min ago`;
  const h = Math.floor(min / HOUR_MIN);
  const m = min % HOUR_MIN;
  return m ? `${h} h ${m} min ago` : `${h} h ago`;
}

/** "Waiting: deploy-prod-server on factiii-board, run by Jon, started 4 min
 *  ago. You're #2." The CLI, web and mobile print this same line. */
export function jobTargetWaitLine(
  wait: RunnerJobTargetWait,
  now: number = Date.now()
): string {
  const { holder } = wait;
  return `Waiting: ${holder.job} on ${holder.board}, run by ${holder.callerName}, started ${ago(holder.startedAt, now)}. You're #${wait.position}.`;
}
