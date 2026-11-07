import type { SecretsUnlockWindow } from '../../domains/electron';

// The unlock window of a shared runner (.specs/runner-secrets-gate.md "Unlock
// window"): the age key, unwrapped by a password holder, kept in THIS process's
// memory until it expires, someone locks it, or the runner restarts. Nothing
// here ever touches the disk - surviving a restart is exactly what the window
// must not do.
//
// It covers JOB spawns only. A free `factiii-secrets run` from a terminal or a
// card session still prompts every time (runner-secrets-gate.md), so callers ask
// `identity()` only on the job path; the free path never reads it.

/** Minutes a window stays open when the answer does not say. */
export const DEFAULT_UNLOCK_MINUTES = 120;
/** The longest window a password holder can open. */
export const MAX_UNLOCK_MINUTES = 720;

export type WindowActor = { userId: string; name: string };

/**
 * Minutes to hold the key for, from a client's `unlockFor`.
 *
 * `forJob` decides what "absent" means: a job answer without a duration gets
 * the default window, a free command answer gets none (one spawn only). An
 * explicit 0 is always "this spawn only". Anything past the ceiling is cut to
 * it rather than refused: the password holder meant "long", not "fail".
 */
export function unlockMinutes(
  requested: number | undefined,
  forJob: boolean
): number {
  if (requested === undefined || requested === null) {
    return forJob ? DEFAULT_UNLOCK_MINUTES : 0;
  }
  if (!Number.isFinite(requested) || requested <= 0) return 0;
  return Math.min(Math.floor(requested), MAX_UNLOCK_MINUTES);
}

export class UnlockWindow {
  /** The unwrapped identity. A Buffer rather than a string so lock() can
   *  overwrite the bytes: a string is immutable and lingers until GC. */
  private key: Buffer | null = null;
  private until = 0;
  private by: WindowActor | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();

  constructor(private now: () => number = Date.now) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  /** Hold `identity` for `minutes`. A second open replaces the first (a new
   *  holder, a new expiry), wiping the old bytes before it lets go of them. */
  open(identity: string, minutes: number, by: WindowActor): void {
    if (minutes <= 0) return;
    this.wipe();
    this.key = Buffer.from(identity, 'utf-8');
    this.until = this.now() + minutes * 60_000;
    this.by = { userId: by.userId, name: by.name };
    this.timer = setTimeout(() => this.lock(), minutes * 60_000);
    // A runner waiting on nothing but this timer must still be able to exit.
    (this.timer as { unref?: () => void }).unref?.();
    this.changed();
  }

  /** The identity while the window is open, else null. Checks the clock as
   *  well as the timer: a suspended laptop can wake past the expiry before the
   *  timer fires, and the window must be closed by then, not a tick later. */
  identity(): string | null {
    if (!this.key) return null;
    if (this.now() >= this.until) {
      this.lock();
      return null;
    }
    return this.key.toString('utf-8');
  }

  /** Who opened the open window, for the audit line of each spawn it covers. */
  holder(): WindowActor | null {
    return this.identity() === null ? null : this.by;
  }

  state(): SecretsUnlockWindow | null {
    if (this.identity() === null || !this.by) return null;
    return {
      until: new Date(this.until).toISOString(),
      byUserId: this.by.userId,
      byName: this.by.name
    };
  }

  /** Close the window: overwrite the key's bytes and forget who held it.
   *  Returns whether anything was open, so a lock can be audited honestly. */
  lock(): boolean {
    const wasOpen = this.key !== null;
    this.wipe();
    if (wasOpen) this.changed();
    return wasOpen;
  }

  private wipe(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.key?.fill(0);
    this.key = null;
    this.until = 0;
    this.by = null;
  }

  /** Test seam: the live buffer, so a test can prove lock() zeroed it. */
  peekBuffer(): Buffer | null {
    return this.key;
  }

  destroy(): void {
    this.lock();
    this.listeners.clear();
  }
}
