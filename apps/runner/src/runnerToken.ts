
import type { RunnerTokenRefresh } from '@shared/all/domains/socket';

import type { RunnerConfig } from './config';

// The runner's side of its two tokens (.specs/runner-link.md, "Runner token"):
// when to ask the server for a new pair, what a usable answer looks like, what
// changes in the stored config, and how the refresh token is kept apart from
// everything a session can see. Pure, so the rules are tested without a
// socket; the daemon does the sending and the saving.

/** How often the runner sends `runner:heartbeat`, and looks at whether its
 *  token is due for a refresh. */
export const RUNNER_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

/** A token older than this is traded for a new one. One day against a 30-day
 *  lifetime: a tunnel's frpc, the one thing that takes the token when it
 *  starts and keeps it, always gets one with at least 29 days left. (A
 *  session holds no copy, and the index service is sent each new one.) */
export const RUNNER_TOKEN_REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

/** How long to wait for the server's answer to `runner:token-refresh`. */
export const RUNNER_TOKEN_REFRESH_ACK_TIMEOUT_MS = 15 * 1000;

/** After a refresh that got no usable answer (a server from before the event
 *  never acks), wait this long before the next try on the same connection. */
export const RUNNER_TOKEN_REFRESH_RETRY_MS = 60 * 60 * 1000;

/** After a refusal that says "try again" (another refresh for this runner
 *  was in flight on the server), the wait before the next try. */
export const RUNNER_TOKEN_REFRESH_BUSY_RETRY_MS = 10 * 1000;

/** How every refresh token starts (helpers/runnerToken.ts on the server). */
const REFRESH_TOKEN_PREFIX = 'frr_';

/** The heartbeat interval in effect. `FACTIII_RUNNER_HEARTBEAT_SECONDS`
 *  shortens it for a local test run. */
export function heartbeatIntervalMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  const seconds = Number(env.FACTIII_RUNNER_HEARTBEAT_SECONDS);
  return Number.isFinite(seconds) && seconds > 0
    ? Math.floor(seconds * 1000)
    : RUNNER_HEARTBEAT_INTERVAL_MS;
}

type TokenClaims = {
  runnerId?: unknown;
  userId?: unknown;
  iat?: unknown;
  exp?: unknown;
};

/** The token's payload, unverified: it is the runner's own credential, not a
 *  claim from a caller (same reasoning as ownerIdFromRunnerToken). */
function readClaims(token: string): TokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const json: unknown = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf-8')
    );
    return json && typeof json === 'object' ? (json as TokenClaims) : null;
  } catch {
    return null;
  }
}

/** When the token was issued and when it ends, in ms. `expiresAt` is null for
 *  a legacy token, which has no `exp`. Null when the token is not a JWT. */
export function tokenTimes(
  token: string
): { issuedAt: number | null; expiresAt: number | null } | null {
  const claims = readClaims(token);
  if (!claims) return null;
  return {
    issuedAt: typeof claims.iat === 'number' ? claims.iat * 1000 : null,
    expiresAt: typeof claims.exp === 'number' ? claims.exp * 1000 : null
  };
}

/**
 * Should the runner ask for a new token now?
 *
 * - A legacy token (no `exp`): yes. A server that can refresh answers with an
 *   expiring one; a server that cannot never answers, and the token stays.
 * - An expiring token: once it is `refreshAfterMs` old, or half its lifetime
 *   old when the lifetime is shorter than twice that (a test lifetime of
 *   seconds), or past its end.
 * - Not a JWT: no. There is nothing to reason about.
 */
export function tokenRefreshDue(
  token: string,
  nowMs: number,
  refreshAfterMs: number = RUNNER_TOKEN_REFRESH_AFTER_MS
): boolean {
  const times = tokenTimes(token);
  if (!times) return false;
  if (times.expiresAt === null) return true;
  if (nowMs >= times.expiresAt) return true;
  if (times.issuedAt === null) return true;
  const lifetime = times.expiresAt - times.issuedAt;
  return nowMs >= times.issuedAt + Math.min(refreshAfterMs, lifetime / 2);
}

/**
 * Is this a refresh answer the runner should store?
 *
 * The new access token must be a JWT with an `exp`, for the same runner and
 * the same owner as the one it replaces. A different runner id would make this
 * machine someone else's runner, so that answer is dropped and the old token
 * stays. A refresh token must come with it: the one that was sent is spent.
 */
export function isUsableRefresh(
  res: unknown,
  currentToken: string
): res is RunnerTokenRefresh {
  if (!res || typeof res !== 'object') return false;
  const { token, refreshToken } = res as {
    token?: unknown;
    refreshToken?: unknown;
  };
  // The same access token back is fine (two issued in one second are equal):
  // what must be stored is the new refresh token that came with it.
  if (typeof token !== 'string') return false;
  if (
    typeof refreshToken !== 'string' ||
    !refreshToken.startsWith(REFRESH_TOKEN_PREFIX)
  ) {
    return false;
  }
  const next = readClaims(token);
  const current = readClaims(currentToken);
  if (!next || !current) return false;
  return (
    typeof next.exp === 'number' &&
    typeof next.runnerId === 'number' &&
    next.runnerId === current.runnerId &&
    next.userId === current.userId
  );
}

/** Why the server refused, for a log line, and whether it said to ask again
 *  soon. The text is the server's own short reason; it never holds a token. */
function refreshRefusal(res: unknown): {
  reason: string;
  retry: boolean;
} {
  if (res && typeof res === 'object' && 'error' in res) {
    const { error, retry } = res as { error: unknown; retry?: unknown };
    return { reason: String(error).slice(0, 120), retry: retry === true };
  }
  return { reason: 'unusable answer', retry: false };
}

/**
 * Take the refresh token off the config object, and return it.
 *
 * The daemon calls this once, before anything else reads the config. From then
 * on the object that the engines, the index service and the handshake read has
 * no refresh token on it, so none of them can pass it on by accident.
 */
export function takeRefreshToken(config: RunnerConfig): string | null {
  const refreshToken = config.refreshToken;
  delete config.refreshToken;
  return typeof refreshToken === 'string' && refreshToken ? refreshToken : null;
}

/** What goes to disk: the config, with the refresh token put back. */
export function configToStore(
  config: RunnerConfig,
  refreshToken: string | null
): RunnerConfig {
  const { refreshToken: _never, ...rest } = config;
  return refreshToken ? { ...rest, refreshToken } : rest;
}

/** Does the file hold exactly the pair the daemon has in memory? Read after a
 *  write, before the runner tells the server the token is saved. */
export function storedTokensMatch(
  onDisk: RunnerConfig | null,
  config: RunnerConfig,
  refreshToken: string | null
): boolean {
  return (
    onDisk !== null &&
    refreshToken !== null &&
    onDisk.refreshToken === refreshToken &&
    onDisk.authToken === config.authToken
  );
}

/** The in-memory config after a refresh: the new access token. Never the
 *  refresh token: that lives
 *  beside the config, not on it (takeRefreshToken). */
export function applyRefreshedToken(
  config: RunnerConfig,
  token: string
): RunnerConfig {
  return {
    ...configToStore(config, null),
    authToken: token
  };
}

// ── The keeper: refresh, save, confirm ──

export type TokenKeeperDeps = {
  /** The daemon's config object. Changed IN PLACE on a refresh: the engines
   *  and the next handshake read the access token from it.
   *  It must already be without its refresh token (takeRefreshToken). */
  config: RunnerConfig;
  /** The refresh token that was on disk at start, or null. */
  refreshToken: string | null;
  /** Emit `runner:token-refresh` and wait for the ack. Rejects when no answer
   *  came (a server from before the event never acks). */
  requestRefresh: (data: { refreshToken?: string }) => Promise<unknown>;
  /** Emit `runner:token-saved` and wait for the ack. Rejects on no answer. */
  requestSaved: (data: { refreshToken: string }) => Promise<unknown>;
  write: (config: RunnerConfig) => void;
  read: () => RunnerConfig | null;
  /** A new access token is in `config`. `reconnect`: the connection was
   *  refresh-only, so connect again to come online. */
  onRefreshed: (reconnect: boolean) => void;
  /** A line for the runner log. No call ever passes a token. */
  log: (line: string) => void;
  now?: () => number;
};

/**
 * The order of work on one tick, and after a restart:
 *
 * 1. A pair that is in memory but not in the file is written again.
 * 2. A refresh token that is in the file, and that the server has not yet
 *    acknowledged as saved in this process, is confirmed
 *    (`runner:token-saved`). The server then retires this runner's legacy
 *    access token. Never sent while the file does not hold the token.
 * 3. When the access token is due, the refresh token is traded for a new pair,
 *    which is written, read back and confirmed the same way.
 *
 * A refresh spends the refresh token, and the server keeps only the last two.
 * So the runner does not refresh while its newest token is not in the file: a
 * restart would come back with a token two steps old, which the server reads
 * as theft. The one exception is `force` (the server says the access token
 * expired): staying offline is worse.
 */
export function createTokenKeeper(deps: TokenKeeperDeps): {
  run: (force: boolean) => Promise<void>;
  /** For tests and for the log: where the keeper stands. Never the token. */
  state: () => { saved: boolean; confirmed: boolean; hasRefreshToken: boolean };
} {
  const { config, log } = deps;
  const now = deps.now ?? Date.now;
  let refreshToken = deps.refreshToken;
  // What is in memory at start came from the file.
  let saved = true;
  let confirmed = false;
  let busy = false;
  /** A forced run asked for while `busy`: run when the pass going ends. */
  let forcePending = false;
  let refreshRetryAt = 0;
  let confirmRetryAt = 0;

  const save = (): boolean => {
    try {
      deps.write(configToStore(config, refreshToken));
      if (storedTokensMatch(deps.read(), config, refreshToken)) return true;
      log('[token] The saved config does not hold the new token. Will write it again.');
      return false;
    } catch (err) {
      log(
        `[token] Could not save the new token: ${
          err instanceof Error ? err.message : String(err)
        }. It is used from memory; the write is tried again.`
      );
      return false;
    }
  };

  const confirm = async (): Promise<void> => {
    if (!refreshToken || !saved || confirmed) return;
    if (now() < confirmRetryAt) return;
    let res: unknown;
    try {
      res = await deps.requestSaved({ refreshToken });
    } catch {
      // No answer: a server from before the event, or a dropped connection.
      confirmRetryAt = now() + RUNNER_TOKEN_REFRESH_RETRY_MS;
      return;
    }
    if (res && typeof res === 'object' && (res as { ok?: unknown }).ok === true) {
      confirmed = true;
      return;
    }
    log(
      `[token] The server did not record the saved token: ${refreshRefusal(res).reason}.`
    );
    confirmRetryAt = now() + RUNNER_TOKEN_REFRESH_RETRY_MS;
  };

  /** One pass: save, confirm, and refresh when due (or forced). True when
   *  it traded the refresh token for a new pair. */
  const once = async (force: boolean): Promise<boolean> => {
    try {
      if (!saved) saved = save();
      await confirm();

      if (!force) {
        if (now() < refreshRetryAt) return false;
        if (!tokenRefreshDue(config.authToken, now())) return false;
        if (!saved) return false;
      }
      let res: unknown;
      try {
        res = await deps.requestRefresh(refreshToken ? { refreshToken } : {});
      } catch {
        // No answer: a server from before the event, or a dropped connection.
        refreshRetryAt = now() + RUNNER_TOKEN_REFRESH_RETRY_MS;
        return false;
      }
      if (!isUsableRefresh(res, config.authToken)) {
        const refusal = refreshRefusal(res);
        log(`[token] The server did not refresh the token: ${refusal.reason}.`);
        refreshRetryAt =
          now() +
          (refusal.retry
            ? RUNNER_TOKEN_REFRESH_BUSY_RETRY_MS
            : RUNNER_TOKEN_REFRESH_RETRY_MS);
        return false;
      }
      // In place: see `config` above. The refresh token stays in this closure.
      Object.assign(config, applyRefreshedToken(config, res.token));
      refreshToken = res.refreshToken;
      refreshRetryAt = 0;
      deps.onRefreshed(false);
      saved = save();
      await confirm();
      // The end is read from the token itself, not from the answer's number.
      const endsAt = tokenTimes(config.authToken)?.expiresAt ?? null;
      log(
        `[token] Refreshed. The new token ends in ${
          endsAt === null ? '?' : Math.round((endsAt - now()) / 3_600_000)
        } h.`
      );
      if (res.reconnect) deps.onRefreshed(true);
      return true;
    } catch (err) {
      // Never let a refresh take the daemon down: it is called unawaited.
      log(
        `[token] Refresh failed: ${err instanceof Error ? err.message : String(err)}`
      );
      refreshRetryAt = now() + RUNNER_TOKEN_REFRESH_RETRY_MS;
      return false;
    }
  };

  const run = async (force: boolean): Promise<void> => {
    if (busy) {
      // The server said the token expired while a pass was going (one the
      // heartbeat or the connect started): kept for when it ends, not
      // dropped.
      if (force) forcePending = true;
      return;
    }
    busy = true;
    try {
      const refreshed = await once(force);
      // Not after a pass that refreshed: the new token is the answer, and
      // forcing again would spend the refresh token it just got.
      if (forcePending && !refreshed) {
        forcePending = false;
        await once(true);
      }
    } finally {
      forcePending = false;
      busy = false;
    }
  };

  return {
    run,
    state: () => ({ saved, confirmed, hasRefreshToken: refreshToken !== null })
  };
}
