import type {
  SecretsSessionWindow,
  SecretsUnlockWindow
} from '../../domains/electron';

// The unlock window of a shared runner (.specs/runner-secrets-gate.md "Unlock
// window"): the age key, unwrapped by a password holder, kept in THIS process's
// memory until it expires, someone locks it, or the runner restarts. Nothing
// here ever touches the disk - surviving a restart is exactly what the window
// must not do.
//
// `UnlockWindow` covers JOB spawns only; callers ask its `identity()` only on
// the job path. A free `factiii-secrets run` from a terminal or a card session
// has its own, narrower kind, `SessionWindows` below: one session, the keys
// approved in that one prompt (runner-secrets-gate.md "Session window").

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
  // An answer from an app that predates the free command's window carries
  // no duration for one, so absent stays "this spawn only" there.
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

/** The names one request asks for, apart: a key and a file may share a name
 *  in the store, and approving one must not cover the other. */
export type WindowScope = { keys: string[]; files: string[] };

type SessionGrant = {
  /** Its own copy of the identity, so dropping one grant wipes its bytes
   *  without touching another's or the job window's. */
  key: Buffer;
  keys: Set<string>;
  files: Set<string>;
  until: number;
  by: WindowActor;
  origin: string;
  session: string;
  timer: ReturnType<typeof setTimeout>;
};

/** What a free command running under a session window is told: the key, and
 *  the window to name on its audit line. */
export type SessionCover = {
  identity: string;
  by: WindowActor;
  until: number;
};

/** How often grants whose session has ended are looked for. A run token is
 *  dropped at once (SecretsGate.revokeToken); a terminal tab's token lives
 *  in its tmux session, which the runner hears no close for. */
const SESSION_SWEEP_MS = 60_000;

/**
 * Free-command windows (.specs/runner-secrets-gate.md "Session window"). A
 * password holder who approves a session's `factiii-secrets run` may keep it
 * open for a while, scoped tight:
 * - to the session's secrets token: no other session, and nothing once the
 *   token is dead (revoked, its tab closed);
 * - to the keys and files approved in THAT prompt: a later request is covered
 *   only when everything it names is in one grant, so asking for anything
 *   else prompts again;
 * - in memory only, ended by expiry, Lock now (`lockAll`), the session
 *   ending or the runner restarting.
 * A session may hold more than one grant (two prompts, two key sets); each
 * keeps its own expiry, and none widens another.
 */
export class SessionWindows {
  /** token -> its open grants. */
  private grants = new Map<string, SessionGrant[]>();
  private listeners = new Set<() => void>();
  private sweeper: ReturnType<typeof setInterval> | null = null;
  /** Bumped by every `lockAll`. A prompt notes it before it waits, and its
   *  grant opens only if no Lock now or password change happened meanwhile. */
  private lockCount = 0;

  constructor(
    private now: () => number = Date.now,
    /** Whether a token still belongs to a live session. Absent = only
     *  expiry, `drop` and `lockAll` end a grant. */
    private alive?: (token: string) => Promise<boolean>
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  /** The lock count to pass back to `open`, read before the prompt waits. */
  generation(): number {
    return this.lockCount;
  }

  /** Hold `identity` for `token`'s session, for `scope` only. Returns the
   *  grant's expiry, or null when none opened: no duration, or a lock since
   *  `generation` was read (the key may predate a password change). */
  open(
    token: string,
    identity: string,
    minutes: number,
    grant: {
      scope: WindowScope;
      by: WindowActor;
      origin: string;
      session: string;
      generation?: number;
    }
  ): number | null {
    if (minutes <= 0 || !token) return null;
    if (grant.generation !== undefined && grant.generation !== this.lockCount) {
      return null;
    }
    const ms = minutes * 60_000;
    const entry: SessionGrant = {
      key: Buffer.from(identity, 'utf-8'),
      keys: new Set(grant.scope.keys),
      files: new Set(grant.scope.files),
      until: this.now() + ms,
      by: { userId: grant.by.userId, name: grant.by.name },
      origin: grant.origin,
      session: grant.session,
      timer: setTimeout(() => this.expire(), ms)
    };
    // A runner waiting on nothing but this timer must still be able to exit.
    (entry.timer as { unref?: () => void }).unref?.();
    this.grants.set(token, [...(this.grants.get(token) ?? []), entry]);
    this.startSweeper();
    this.changed();
    // The session may have ended while its prompt waited: its revoke found
    // nothing to drop then, so check now rather than at the next sweep.
    if (this.alive) {
      void this.alive(token)
        .catch(() => false)
        .then((ok) => {
          if (!ok) this.drop(token);
        });
    }
    return entry.until;
  }

  /** The key, when one open grant of `token` covers every name in `scope`;
   *  else null. Checks the clock as well as the timers, like UnlockWindow. */
  cover(token: string, scope: WindowScope): SessionCover | null {
    if (!token) return null;
    this.expire();
    const hit = (this.grants.get(token) ?? []).find(
      (g) =>
        scope.keys.every((k) => g.keys.has(k)) &&
        scope.files.every((f) => g.files.has(f))
    );
    return hit
      ? { identity: hit.key.toString('utf-8'), by: hit.by, until: hit.until }
      : null;
  }

  /** Every open grant, for the apps' unlock line. Never the key. */
  state(): SecretsSessionWindow[] {
    this.expire();
    return [...this.grants.values()].flat().map((g) => ({
      origin: g.origin,
      session: g.session,
      keys: [...g.keys, ...g.files],
      until: new Date(g.until).toISOString(),
      byUserId: g.by.userId,
      byName: g.by.name
    }));
  }

  /** End `token`'s grants (its session ended). Returns whether any were open. */
  drop(token: string): boolean {
    const list = this.grants.get(token);
    if (!list) return false;
    for (const g of list) wipeGrant(g);
    this.grants.delete(token);
    this.afterRemoval();
    return true;
  }

  /** End every grant (Lock now, a password change). Returns whether any were
   *  open, so a lock can be audited honestly. */
  lockAll(): boolean {
    this.lockCount++;
    if (this.grants.size === 0) return false;
    for (const list of this.grants.values()) for (const g of list) wipeGrant(g);
    this.grants.clear();
    this.afterRemoval();
    return true;
  }

  /** Drop grants past their expiry. */
  private expire(): void {
    const now = this.now();
    let removed = false;
    for (const [token, list] of this.grants) {
      const keep = list.filter((g) => {
        if (now < g.until) return true;
        wipeGrant(g);
        return false;
      });
      if (keep.length === list.length) continue;
      removed = true;
      if (keep.length) this.grants.set(token, keep);
      else this.grants.delete(token);
    }
    if (removed) this.afterRemoval();
  }

  /** Drop the grants of tokens whose session has ended. */
  async sweep(): Promise<void> {
    if (!this.alive) return;
    for (const token of [...this.grants.keys()]) {
      if (!(await this.alive(token).catch(() => false))) this.drop(token);
    }
  }

  private startSweeper(): void {
    if (this.sweeper || !this.alive) return;
    this.sweeper = setInterval(() => void this.sweep(), SESSION_SWEEP_MS);
    (this.sweeper as { unref?: () => void }).unref?.();
  }

  private afterRemoval(): void {
    if (this.grants.size === 0 && this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
    this.changed();
  }

  destroy(): void {
    this.lockAll();
    this.listeners.clear();
  }
}

function wipeGrant(grant: SessionGrant): void {
  clearTimeout(grant.timer);
  grant.key.fill(0);
}
