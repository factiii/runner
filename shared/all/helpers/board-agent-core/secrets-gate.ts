import crypto from 'crypto';

import type { PendingSecretsAuth } from '../../domains/electron';

// The authorization gate behind `factiii-secrets run`, for the WHOLE space
// rather than one deploy run (see .specs/runner-secrets-gate.md
// "Free commands: `factiii-secrets run`").
//
// The socket takes any connection from this user and a request carries no
// identity, so tokens are what separate a session the runner spawned from
// anything else that found the node: a prompt the owner cannot attribute looks
// exactly like a real one. One pending slot, not a queue - the bridge
// serialises its callers. No secret value passes through here.

/** Re-exported from the wire contract: this is exactly what the client
 *  renders, so there is one definition rather than two that can drift. */
export type { PendingSecretsAuth };

export type SecretsAuthResult =
  | {
      password: string;
      /** Minutes the answer asks the runner to stay unlocked for jobs.
       *  Absent = the caller's default (see secrets-window.ts). */
      unlockFor?: number;
      /** Who answered, server-vouched, for the window and the audit log. */
      by?: { userId: string; name: string };
      /** The road the ANSWER took (not the request's), for the unlock line. */
      via?: 'api' | 'data-channel' | 'owner-terminal';
    }
  | {
      denied: true;
      /** Who pressed Deny, when a person did (absent for a withdrawal). */
      by?: { userId: string; name: string };
      via?: 'api' | 'data-channel' | 'owner-terminal';
    }
  /** An unlock window opened while this (queued) job request waited: nobody
   *  answered it, and the caller reads the key from the window instead. */
  | { windowed: true };

type Waiting = {
  request: PendingSecretsAuth;
  resolve: (result: SecretsAuthResult) => void;
  /** Wait for the slot instead of taking it. A job or an inbox write is not
   *  a session re-asking after a wrong password, so it must neither deny the
   *  request on screen nor be denied by the next one - it queues. */
  queued: boolean;
  /** The caller's own handle on this request (a job's call id), so it can
   *  withdraw it without knowing the id on screen. Never sent to clients. */
  tag?: string;
};

/** The deploy run's origin label. A constant because two places compare
 *  against it: host-run stamps it, and the engine projects only ITS requests
 *  onto the deploy modal's phase. */
export const DEPLOY_ORIGIN = 'Deploy run';

/** Thrown at the caller when a request carries no token this runner issued. */
export const UNATTRIBUTED =
  'This runner did not start the session that asked, so the request was refused. `factiii-secrets` only works inside a session the runner spawned.';

export class SecretsGate {
  /** token -> origin label. Lives as long as the session that holds it. */
  private tokens = new Map<string, string>();
  private waiting: Waiting | null = null;
  /** Queued requests (jobs, inbox writes) waiting for the slot, oldest first. */
  private deferred: Waiting[] = [];

  /** Notified on appearance, replacement AND clearing, so a modal that opened
   *  on one request closes when it is answered elsewhere. More than one,
   *  because the space publishes the change and the deploy run separately
   *  projects its own requests onto the release timeline. */
  private listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private onChange(): void {
    for (const listener of this.listeners) listener();
  }

  // ── Who is asking ──

  /** Mint a token for one session, labelled with what the owner should see on
   *  the prompt - the label is most of the decision, so name the session. */
  issueToken(origin: string): string {
    const token = crypto.randomBytes(24).toString('hex');
    this.tokens.set(token, origin);
    return token;
  }

  /** Register a durable token the caller already holds, instead of minting a
   *  fresh one. For the space token: terminals outlive this process, so a
   *  minted one leaves them unattributed after a restart. Idempotent. */
  adoptToken(token: string, origin: string): string {
    this.tokens.set(token, origin);
    return token;
  }

  /** Drop a session's token when it ends, so a leaked one stops working. */
  revokeToken(token: string): void {
    this.tokens.delete(token);
  }

  /** The origin for a token, or null when this runner never issued it. */
  originFor(token: string): string | null {
    return this.tokens.get(token) ?? null;
  }

  // ── The pending request ──

  pending(): PendingSecretsAuth | null {
    return this.waiting?.request ?? null;
  }

  /** Open the gate for one command and block until the owner answers. A second
   *  request denies the older one rather than dropping it: that caller is
   *  blocked on the promise and would otherwise hang forever.
   *
   *  `queued` requests (a job, an inbox write) are the exception on both
   *  sides: one waits behind whatever is on screen, and one on screen steps
   *  back into the queue rather than being denied by a session's request. */
  request(opts: {
    command: string;
    keys: string[];
    origin: string;
    error?: string;
    caller?: { userId: string; name: string };
    job?: string;
    inbox?: PendingSecretsAuth['inbox'];
    queued?: boolean;
    tag?: string;
  }): Promise<SecretsAuthResult> {
    return new Promise<SecretsAuthResult>((resolve) => {
      const next: Waiting = {
        request: {
          id: crypto.randomUUID(),
          command: opts.command,
          keys: opts.keys,
          origin: opts.origin,
          error: opts.error ?? '',
          requestedAt: Date.now(),
          ...(opts.caller ? { caller: opts.caller } : {}),
          ...(opts.job ? { job: opts.job } : {}),
          ...(opts.inbox ? { inbox: opts.inbox } : {})
        },
        resolve,
        queued: opts.queued ?? false,
        ...(opts.tag ? { tag: opts.tag } : {})
      };
      const current = this.waiting;
      if (current) {
        if (next.queued) {
          this.deferred.push(next);
          return;
        }
        if (current.queued) this.deferred.unshift(current);
        else current.resolve({ denied: true });
      }
      this.waiting = next;
      this.onChange();
    });
  }

  /** Put the next queued request on screen. It gets a fresh id: an answer
   *  typed against it before it stepped back must not land now. */
  private advance(): void {
    const next = this.deferred.shift() ?? null;
    if (next) {
      next.request = {
        ...next.request,
        id: crypto.randomUUID(),
        requestedAt: Date.now()
      };
    }
    this.waiting = next;
  }

  /** Resolve every request `pick` answers, without asking: the queued ones
   *  AND the one on screen. The unlock window uses this: a job waiting behind
   *  the request that opened the window, or already moved on screen by that
   *  answer (an inbox approval with a duration), no longer needs a password.
   *  Leaving the on-screen one would park the job on a prompt a client hides
   *  because the runner is unlocked. */
  settleQueued(
    pick: (request: PendingSecretsAuth) => SecretsAuthResult | null
  ): void {
    const keep: Waiting[] = [];
    for (const item of this.deferred) {
      const result = pick(item.request);
      if (result) item.resolve(result);
      else keep.push(item);
    }
    this.deferred = keep;
    const waiting = this.waiting;
    const result = waiting ? pick(waiting.request) : null;
    if (waiting && result) {
      this.advance();
      waiting.resolve(result);
      this.onChange();
    }
  }

  /** Deny the requests `match` picks, on screen or queued, without an id.
   *  For a request that was settled some other way (an inbox item approved
   *  from its own list) and must stop asking. */
  withdraw(match: (request: PendingSecretsAuth) => boolean): void {
    const keep: Waiting[] = [];
    for (const item of this.deferred) {
      if (match(item.request)) item.resolve({ denied: true });
      else keep.push(item);
    }
    this.deferred = keep;
    const waiting = this.waiting;
    if (waiting && match(waiting.request)) {
      this.advance();
      waiting.resolve({ denied: true });
      this.onChange();
    }
  }

  /** Deny the request carrying `tag`, on screen or queued (a cancelled job). */
  withdrawTag(tag: string): void {
    const keep: Waiting[] = [];
    for (const item of this.deferred) {
      if (item.tag === tag) item.resolve({ denied: true });
      else keep.push(item);
    }
    this.deferred = keep;
    const waiting = this.waiting;
    if (waiting?.tag === tag) {
      this.advance();
      waiting.resolve({ denied: true });
      this.onChange();
    }
  }

  /** Answer the pending request. `id` must match what the client was shown: a
   *  wrong-password re-prompt replaces the request, and an answer aimed at the
   *  previous one must not resolve its successor with a stale password. */
  answer(id: string, result: SecretsAuthResult): { success: boolean } {
    const waiting = this.waiting;
    if (!waiting || waiting.request.id !== id) return { success: false };
    this.advance();
    waiting.resolve(result);
    this.onChange();
    return { success: true };
  }

  /** Deny whatever is waiting, without needing to know its id. The run was
   *  cancelled, or the space is going down: nothing may stay blocked. */
  cancel(): void {
    const waiting = this.waiting;
    if (!waiting) return;
    this.advance();
    waiting.resolve({ denied: true });
    this.onChange();
  }

  destroy(): void {
    for (const item of this.deferred) item.resolve({ denied: true });
    this.deferred = [];
    this.cancel();
    this.tokens.clear();
    this.listeners.clear();
  }
}
