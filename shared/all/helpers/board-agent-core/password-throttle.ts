// Limits on runner-password guesses (.specs/runner-secrets-store.md
// "Layout"). The password unwraps the age key, and every road to it - a gate
// answer, an inbox approval, a secrets change, a rotation - ends in one
// decrypt. Each wrong answer is cheap for the guesser, so after a few free
// tries every attempt waits out a doubling backoff. A throttled attempt is
// refused WITHOUT trying the password, so a guess sent during the wait is
// never tested.
//
// The count lives in the runner process, keyed by the config dir that holds
// the wrapped key. A restart clears it; the audit line for each failure (the
// callers write it) is what survives.

export const FREE_ATTEMPTS = 5;
export const BASE_DELAY_MS = 2_000;
export const MAX_DELAY_MS = 15 * 60_000;

export class PasswordThrottledError extends Error {
  constructor(public readonly retryInMs: number) {
    super(
      `Too many wrong passwords. Try again in ${Math.ceil(retryInMs / 1000)}s.`
    );
    this.name = 'PasswordThrottledError';
  }
}

export class PasswordThrottle {
  private failures = 0;
  private lockedUntil = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Throws PasswordThrottledError while a backoff is running. */
  check(): void {
    const wait = this.lockedUntil - this.now();
    if (wait > 0) throw new PasswordThrottledError(wait);
  }

  /** A wrong password: after FREE_ATTEMPTS, each one starts a backoff that
   *  doubles, up to MAX_DELAY_MS. */
  fail(): void {
    this.failures += 1;
    const over = this.failures - FREE_ATTEMPTS;
    if (over < 0) return;
    const delay = Math.min(
      MAX_DELAY_MS,
      BASE_DELAY_MS * 2 ** Math.min(over, 20)
    );
    this.lockedUntil = this.now() + delay;
  }

  succeed(): void {
    this.failures = 0;
    this.lockedUntil = 0;
  }
}

const throttles = new Map<string, PasswordThrottle>();

/** The throttle for the wrapped key in `configDir`. */
export function throttleFor(configDir: string): PasswordThrottle {
  let t = throttles.get(configDir);
  if (!t) {
    t = new PasswordThrottle();
    throttles.set(configDir, t);
  }
  return t;
}

/** Run one password check under the throttle: refused during a backoff,
 *  counted as a failure when it throws 'Wrong password.', reset on success. */
export async function throttledPasswordCheck<T>(
  configDir: string,
  check: () => T | Promise<T>
): Promise<T> {
  const t = throttleFor(configDir);
  t.check();
  try {
    const result = await check();
    t.succeed();
    return result;
  } catch (err) {
    if (isWrongPassword(err)) t.fail();
    throw err;
  }
}

function isWrongPassword(err: unknown): boolean {
  return err instanceof Error && err.message === 'Wrong password.';
}

/** A failed password attempt, for the audit log: a wrong password, or one
 *  refused by the backoff. */
export function isFailedPasswordAttempt(err: unknown): boolean {
  return isWrongPassword(err) || err instanceof PasswordThrottledError;
}
