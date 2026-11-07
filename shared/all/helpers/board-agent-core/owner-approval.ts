import crypto from 'crypto';

import type { PendingDangerousApproval } from '../../domains/electron';

// The runner owner's yes for one member's call of a dangerous job
// (.specs/runner-member-access.md "Dangerous jobs"). A job marked `dangerous`
// in jobs.json (one the owner wants to see each call of); a member the owner
// has not given the Dangerous jobs permission does not get refused, their
// call waits here until the OWNER approves that one call. No password: the
// engine checks that whoever answers is the runner's owner by id. A no, a
// withdrawn call (cancelled, the space going down) or 10 minutes without an
// answer all end the call as denied. Nothing approves a later call: each one
// asks again.

/** How long a call waits for the owner before it ends as denied. */
export const OWNER_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

export type OwnerApprovalAnswerer = {
  by: { userId: string; name: string };
  via: 'api' | 'data-channel' | 'owner-terminal';
};

export type OwnerApprovalResult =
  | ({ approved: true } & OwnerApprovalAnswerer)
  | ({ approved: false; reason: 'denied' } & OwnerApprovalAnswerer)
  | { approved: false; reason: 'timeout' | 'withdrawn' };

type Waiting = {
  request: PendingDangerousApproval;
  resolve: (result: OwnerApprovalResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** What changed, for the space's activity row and the owner's push. */
export type OwnerApprovalChange =
  | { opened: PendingDangerousApproval }
  | { closed: string };

export class OwnerApprovals {
  private waiting = new Map<string, Waiting>();
  private listeners = new Set<(change: OwnerApprovalChange) => void>();

  constructor(
    private timeoutMs = OWNER_APPROVAL_TIMEOUT_MS,
    private now: () => number = Date.now
  ) {}

  subscribe(listener: (change: OwnerApprovalChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: OwnerApprovalChange): void {
    for (const listener of this.listeners) listener(change);
  }

  /** Every call waiting on the owner, oldest first. */
  pending(): PendingDangerousApproval[] {
    return [...this.waiting.values()]
      .map((w) => w.request)
      .sort((a, b) => a.requestedAt - b.requestedAt);
  }

  /** Hold one call until the owner answers, the time runs out, or `signal`
   *  aborts (the call was cancelled). Resolves, never rejects. */
  request(
    ask: Omit<PendingDangerousApproval, 'id' | 'requestedAt' | 'expiresAt'>,
    signal?: AbortSignal
  ): Promise<OwnerApprovalResult> {
    return new Promise<OwnerApprovalResult>((resolve) => {
      if (signal?.aborted) {
        resolve({ approved: false, reason: 'withdrawn' });
        return;
      }
      const requestedAt = this.now();
      const request: PendingDangerousApproval = {
        ...ask,
        id: crypto.randomUUID(),
        requestedAt,
        expiresAt: requestedAt + this.timeoutMs
      };
      const onAbort = () =>
        this.settle(request.id, { approved: false, reason: 'withdrawn' });
      const timer = setTimeout(
        () => this.settle(request.id, { approved: false, reason: 'timeout' }),
        this.timeoutMs
      );
      // A runner that only waits on this must still be able to exit.
      timer.unref?.();
      this.waiting.set(request.id, {
        request,
        timer,
        resolve: (result) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(result);
        }
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.emit({ opened: request });
    });
  }

  /** The owner's answer. The caller has checked that it IS the owner. False
   *  when `id` is not waiting any more (answered, timed out, withdrawn). */
  answer(id: string, approve: boolean, answerer: OwnerApprovalAnswerer): boolean {
    return this.settle(
      id,
      approve
        ? { approved: true, ...answerer }
        : { approved: false, reason: 'denied', ...answerer }
    );
  }

  private settle(id: string, result: OwnerApprovalResult): boolean {
    const waiting = this.waiting.get(id);
    if (!waiting) return false;
    this.waiting.delete(id);
    clearTimeout(waiting.timer);
    waiting.resolve(result);
    this.emit({ closed: id });
    return true;
  }

  /** The space is going down: nothing waiting may run. */
  destroy(): void {
    for (const id of [...this.waiting.keys()]) {
      this.settle(id, { approved: false, reason: 'withdrawn' });
    }
    this.listeners.clear();
  }
}
