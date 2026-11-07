import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { RunnerConfig } from './config';
import {
  applyRefreshedToken,
  configToStore,
  createTokenKeeper,
  heartbeatIntervalMs,
  isUsableRefresh,
  RUNNER_HEARTBEAT_INTERVAL_MS,
  RUNNER_TOKEN_REFRESH_AFTER_MS,
  RUNNER_TOKEN_REFRESH_BUSY_RETRY_MS,
  RUNNER_TOKEN_REFRESH_RETRY_MS,
  storedTokensMatch,
  takeRefreshToken,
  tokenRefreshDue,
  tokenTimes
} from './runnerToken';

// When the runner asks for a new pair of tokens, what answer it accepts, what
// it stores, when it tells the server the refresh token is saved, and that the
// refresh token stays out of everything a session can see (.specs/
// runner-link.md, "Runner token"). The server signs the real thing; here a
// token only needs a readable payload.

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 1);

const fakeToken = (claims: Record<string, unknown>) =>
  [
    Buffer.from('{"alg":"HS256"}').toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
    'signature'
  ].join('.');

const base = { type: 'runner', runnerId: 3, userId: 7 };
/** What every runner paired before expiry holds. */
const legacy = fakeToken({ ...base, iat: T0 / 1000 });
const expiring = (lifetimeMs: number, extra: Record<string, unknown> = {}) =>
  fakeToken({
    ...base,
    iat: T0 / 1000,
    exp: (T0 + lifetimeMs) / 1000,
    ...extra
  });

describe('tokenTimes', () => {
  it('reads iat and exp, and reports a legacy token as never ending', () => {
    assert.deepEqual(tokenTimes(expiring(30 * DAY)), {
      issuedAt: T0,
      expiresAt: T0 + 30 * DAY
    });
    assert.deepEqual(tokenTimes(legacy), { issuedAt: T0, expiresAt: null });
  });

  it('is null for something that is not a JWT', () => {
    assert.equal(tokenTimes('fake.pairing'), null);
    assert.equal(tokenTimes('a.!!!.c'), null);
    assert.equal(tokenTimes(''), null);
  });
});

describe('tokenRefreshDue', () => {
  it('asks at once for a legacy token, so a new server can replace it', () => {
    assert.equal(tokenRefreshDue(legacy, T0), true);
    assert.equal(tokenRefreshDue(legacy, T0 + 400 * DAY), true);
  });

  it('leaves a fresh expiring token alone for a day, then asks', () => {
    const token = expiring(30 * DAY);
    assert.equal(tokenRefreshDue(token, T0), false);
    assert.equal(
      tokenRefreshDue(token, T0 + RUNNER_TOKEN_REFRESH_AFTER_MS - 1),
      false
    );
    assert.equal(
      tokenRefreshDue(token, T0 + RUNNER_TOKEN_REFRESH_AFTER_MS),
      true
    );
  });

  it('asks at half life when the lifetime is short (a test lifetime)', () => {
    const token = expiring(20_000);
    assert.equal(tokenRefreshDue(token, T0 + 9_000), false);
    assert.equal(tokenRefreshDue(token, T0 + 10_000), true);
  });

  it('asks for a token past its end', () => {
    assert.equal(tokenRefreshDue(expiring(30 * DAY), T0 + 31 * DAY), true);
  });

  it('takes the refresh age as a parameter', () => {
    const token = expiring(30 * DAY);
    assert.equal(tokenRefreshDue(token, T0 + 5_000, 4_000), true);
    assert.equal(tokenRefreshDue(token, T0 + 3_000, 4_000), false);
  });

  it('never asks for a token it cannot read', () => {
    assert.equal(tokenRefreshDue('fake.pairing.token', T0), false);
  });
});

describe('isUsableRefresh', () => {
  const current = expiring(30 * DAY);
  const next = expiring(30 * DAY, { iat: T0 / 1000 + 60 });
  const refreshToken = 'frr_next';

  it('accepts an expiring token for the same runner and owner, with a refresh token', () => {
    assert.equal(
      isUsableRefresh(
        { token: next, expiresAt: 1, refreshToken, reconnect: false },
        current
      ),
      true
    );
    // A legacy token is traded for an expiring one the same way.
    assert.equal(isUsableRefresh({ token: next, refreshToken }, legacy), true);
  });

  it('refuses an answer with no refresh token, or one that is not one', () => {
    assert.equal(isUsableRefresh({ token: next }, current), false);
    assert.equal(isUsableRefresh({ token: next, refreshToken: 7 }, current), false);
    assert.equal(
      isUsableRefresh({ token: next, refreshToken: 'something' }, current),
      false
    );
  });

  it('refuses a refusal, a timeout value and garbage', () => {
    assert.equal(isUsableRefresh({ error: 'runner revoked or invalid' }, current), false);
    assert.equal(isUsableRefresh(undefined, current), false);
    assert.equal(isUsableRefresh({ token: 42, refreshToken }, current), false);
    assert.equal(isUsableRefresh({ token: 'not-a-jwt', refreshToken }, current), false);
  });

  it('refuses a token for another runner or another owner', () => {
    const otherRunner = expiring(30 * DAY, { runnerId: 4 });
    const otherOwner = expiring(30 * DAY, { userId: 8 });
    assert.equal(isUsableRefresh({ token: otherRunner, refreshToken }, current), false);
    assert.equal(isUsableRefresh({ token: otherOwner, refreshToken }, current), false);
  });

  it('refuses a token with no exp; takes the same access token back with a new refresh token', () => {
    assert.equal(isUsableRefresh({ token: legacy, refreshToken }, current), false);
    // Two access tokens signed in one second are equal. The refresh token
    // that came with it is new and must be stored.
    assert.equal(isUsableRefresh({ token: current, refreshToken }, current), true);
  });
});

describe('the stored config across a refresh', () => {
  const paired: RunnerConfig = {
    serverUrl: 'http://localhost:5001',
    authToken: legacy,
    runnerName: 'box'
  };

  it('swaps in the new access token on every refresh', () => {
    const first = applyRefreshedToken(paired, expiring(30 * DAY));
    assert.equal(first.authToken, expiring(30 * DAY));

    const second = applyRefreshedToken(first, expiring(31 * DAY));
    assert.equal(second.authToken, expiring(31 * DAY));
    // Everything else rides along untouched.
    assert.equal(second.serverUrl, paired.serverUrl);
    assert.equal(second.runnerName, paired.runnerName);
  });

  it('does not change the config it was given', () => {
    applyRefreshedToken(paired, expiring(30 * DAY));
    assert.equal(paired.authToken, legacy);
  });
});

describe('heartbeatIntervalMs', () => {
  it('is five minutes unless an env var shortens it', () => {
    assert.equal(heartbeatIntervalMs({}), RUNNER_HEARTBEAT_INTERVAL_MS);
    assert.equal(RUNNER_HEARTBEAT_INTERVAL_MS, 5 * 60 * 1000);
    assert.equal(
      heartbeatIntervalMs({ FACTIII_RUNNER_HEARTBEAT_SECONDS: '2' }),
      2000
    );
    assert.equal(
      heartbeatIntervalMs({ FACTIII_RUNNER_HEARTBEAT_SECONDS: 'soon' }),
      RUNNER_HEARTBEAT_INTERVAL_MS
    );
    assert.equal(
      heartbeatIntervalMs({ FACTIII_RUNNER_HEARTBEAT_SECONDS: '0' }),
      RUNNER_HEARTBEAT_INTERVAL_MS
    );
  });
});

describe('the refresh token stays off the config object', () => {
  const onDisk = (): RunnerConfig => ({
    serverUrl: 'http://localhost:5001',
    authToken: expiring(30 * DAY),
    runnerName: 'box',
    refreshToken: 'frr_secret'
  });

  it('takeRefreshToken removes it, so nothing that gets the config has it', () => {
    const config = onDisk();
    assert.equal(takeRefreshToken(config), 'frr_secret');
    assert.equal('refreshToken' in config, false);
    assert.equal(JSON.stringify(config).includes('frr_'), false);
    // A config from before refresh tokens.
    assert.equal(takeRefreshToken(config), null);
  });

  it('applyRefreshedToken never returns one, even from a config that had one', () => {
    const next = applyRefreshedToken(onDisk(), expiring(31 * DAY));
    assert.equal('refreshToken' in next, false);
  });

  it('configToStore puts it back for the file only', () => {
    const config = onDisk();
    const secret = takeRefreshToken(config);
    assert.equal(configToStore(config, 'frr_new').refreshToken, 'frr_new');
    assert.equal('refreshToken' in configToStore(config, null), false);
    assert.equal('refreshToken' in config, false);
    assert.equal(secret, 'frr_secret');
  });

  it('storedTokensMatch needs both tokens in the file', () => {
    const config = onDisk();
    const secret = takeRefreshToken(config);
    assert.equal(storedTokensMatch(onDisk(), config, secret), true);
    assert.equal(storedTokensMatch(null, config, secret), false);
    assert.equal(storedTokensMatch({ ...config }, config, secret), false);
    assert.equal(
      storedTokensMatch({ ...onDisk(), authToken: legacy }, config, secret),
      false
    );
    assert.equal(storedTokensMatch(onDisk(), config, null), false);
  });

  it('the daemon takes it off before any other use, and never reads it from config', () => {
    const source = fs.readFileSync(path.join(__dirname, 'daemon.ts'), 'utf-8');
    const body = source.slice(source.indexOf('export async function startDaemon('));
    const firstUse = body.search(/\bconfig\./);
    const taken = body.indexOf('takeRefreshToken(config)');
    assert.ok(taken !== -1 && taken < firstUse);
    assert.equal(source.includes('config.refreshToken'), false);
    // What a session, a client link and the server's heartbeat row receive.
    assert.ok(source.includes("runnerToken: () => config.authToken"));
    assert.ok(
      source.includes("JSON.stringify({ type: 'runner-info', version: currentVersion() })")
    );
    assert.ok(
      source.includes("socket.emit('runner:heartbeat', { version: currentVersion() })")
    );
  });
});

describe('token keeper', () => {
  /** A fake file, a fake server and the keeper between them. */
  const setup = (opts: {
    authToken: string;
    refreshToken?: string;
    /** Answers to `runner:token-refresh`, in order. 'none' = no ack. */
    refreshAnswers?: unknown[];
    savedAnswers?: unknown[];
  }) => {
    let file: RunnerConfig | null = {
      serverUrl: 'http://localhost:5001',
      authToken: opts.authToken,
      runnerName: 'box',
      ...(opts.refreshToken ? { refreshToken: opts.refreshToken } : {})
    };
    const config: RunnerConfig = { ...file };
    const world = {
      now: T0,
      writeFails: false,
      writeLies: false,
      refreshCalls: [] as { refreshToken?: string }[],
      savedCalls: [] as { refreshToken: string }[],
      refreshed: [] as boolean[],
      logs: [] as string[],
      writes: 0
    };
    const refreshAnswers = [...(opts.refreshAnswers ?? [])];
    const savedAnswers = [...(opts.savedAnswers ?? [])];
    const answer = (queue: unknown[]) => {
      const res = queue.length ? queue.shift() : 'none';
      return res === 'none'
        ? Promise.reject(new Error('operation has timed out'))
        : Promise.resolve(res);
    };
    const keeper = createTokenKeeper({
      config,
      refreshToken: takeRefreshToken(config),
      requestRefresh: (data) => {
        world.refreshCalls.push(data);
        return answer(refreshAnswers);
      },
      requestSaved: (data) => {
        world.savedCalls.push(data);
        return answer(savedAnswers);
      },
      write: (c) => {
        world.writes++;
        if (world.writeFails) throw new Error('EACCES: config.json');
        if (!world.writeLies) file = { ...c };
      },
      read: () => file,
      onRefreshed: (reconnect) => world.refreshed.push(reconnect),
      log: (line) => world.logs.push(line),
      now: () => world.now
    });
    return { keeper, config, world, file: () => file };
  };

  const pair = (n: number, reconnect = false) => ({
    token: expiring(30 * DAY, { iat: T0 / 1000 + n }),
    expiresAt: 1,
    refreshToken: `frr_token${n}`,
    reconnect
  });
  const noTokenIn = (lines: string[]) => {
    for (const line of lines) {
      assert.equal(line.includes('frr_'), false, line);
      assert.equal(line.includes('eyJ'), false, line);
    }
  };

  it('upgrades a legacy runner: asks with no refresh token, saves, reads back, confirms', async () => {
    const t = setup({
      authToken: legacy,
      refreshAnswers: [pair(1)],
      savedAnswers: [{ ok: true }]
    });
    await t.keeper.run(false);
    assert.deepEqual(t.world.refreshCalls, [{}]);
    assert.equal(t.config.authToken, pair(1).token);
    assert.equal(t.file()?.authToken, pair(1).token);
    assert.equal(t.file()?.refreshToken, 'frr_token1');
    assert.deepEqual(t.world.savedCalls, [{ refreshToken: 'frr_token1' }]);
    assert.deepEqual(t.keeper.state(), {
      saved: true,
      confirmed: true,
      hasRefreshToken: true
    });
    // What every engine, tunnel and the index service read from.
    assert.equal(JSON.stringify(t.config).includes('frr_'), false);
    assert.deepEqual(t.world.refreshed, [false]);
    noTokenIn(t.world.logs);
  });

  it('sends the refresh token it holds, and stores the one that replaces it', async () => {
    const t = setup({
      authToken: expiring(30 * DAY),
      refreshToken: 'frr_token0',
      refreshAnswers: [pair(1)],
      savedAnswers: [{ ok: true }]
    });
    t.world.now = T0 + 2 * DAY;
    await t.keeper.run(false);
    assert.deepEqual(t.world.refreshCalls, [{ refreshToken: 'frr_token0' }]);
    assert.equal(t.file()?.refreshToken, 'frr_token1');
  });

  it('save failed: no confirm, token used from memory, write tried again, no second refresh', async () => {
    const t = setup({
      authToken: legacy,
      refreshAnswers: [pair(1), pair(2)],
      savedAnswers: [{ ok: true }]
    });
    t.world.writeFails = true;
    await t.keeper.run(false);
    assert.equal(t.config.authToken, pair(1).token);
    assert.equal(t.file()?.authToken, legacy);
    assert.equal(t.file()?.refreshToken, undefined);
    assert.deepEqual(t.world.savedCalls, []);
    assert.equal(t.keeper.state().saved, false);

    // Due again, the file still broken: the write is tried, the unsaved
    // refresh token is not spent.
    t.world.now = T0 + 3 * DAY;
    await t.keeper.run(false);
    assert.equal(t.world.writes, 2);
    assert.equal(t.world.refreshCalls.length, 1);
    assert.deepEqual(t.world.savedCalls, []);

    // The disk works again: saved, confirmed, and only then refreshed.
    t.world.writeFails = false;
    await t.keeper.run(false);
    assert.deepEqual(t.world.savedCalls[0], { refreshToken: 'frr_token1' });
    assert.deepEqual(t.world.refreshCalls[1], { refreshToken: 'frr_token1' });
    assert.equal(t.file()?.refreshToken, 'frr_token2');
    assert.equal(t.keeper.state().confirmed, true);
    noTokenIn(t.world.logs);
  });

  it('a write that did not land (read-back differs) is not confirmed', async () => {
    const t = setup({ authToken: legacy, refreshAnswers: [pair(1)] });
    t.world.writeLies = true;
    await t.keeper.run(false);
    assert.deepEqual(t.world.savedCalls, []);
    assert.equal(t.keeper.state().saved, false);
  });

  it('an expired access token forces a refresh even while a save is pending', async () => {
    const t = setup({
      authToken: legacy,
      refreshAnswers: [pair(1), pair(2, true)]
    });
    t.world.writeFails = true;
    await t.keeper.run(false);
    await t.keeper.run(true);
    assert.deepEqual(t.world.refreshCalls[1], { refreshToken: 'frr_token1' });
    assert.deepEqual(t.world.refreshed, [false, false, true]);
  });

  it('an expired token said while a pass is going is refreshed when it ends, not dropped', async () => {
    const t = setup({
      authToken: expiring(30 * DAY),
      refreshToken: 'frr_token0',
      refreshAnswers: [pair(1)],
      savedAnswers: [{ ok: true }, { ok: true }]
    });
    // Not due by this clock: the connect's pass only confirms, and is still
    // waiting on that when the server says the token expired.
    const pass = t.keeper.run(false);
    await t.keeper.run(true);
    await pass;
    assert.deepEqual(t.world.refreshCalls, [{ refreshToken: 'frr_token0' }]);
    assert.equal(t.config.authToken, pair(1).token);
  });

  it('a pass that refreshed answers a force asked meanwhile: no second refresh', async () => {
    const t = setup({
      authToken: expiring(30 * DAY),
      refreshToken: 'frr_token0',
      refreshAnswers: [pair(1), pair(2)],
      savedAnswers: [{ ok: true }, { ok: true }]
    });
    t.world.now = T0 + 2 * DAY;
    const pass = t.keeper.run(false);
    await t.keeper.run(true);
    await pass;
    assert.equal(t.world.refreshCalls.length, 1);
    assert.equal(t.file()?.refreshToken, 'frr_token1');
  });

  it('restart after a save that was never confirmed: confirms once, without a refresh', async () => {
    const t = setup({
      authToken: expiring(30 * DAY),
      refreshToken: 'frr_token0',
      savedAnswers: [{ ok: true }]
    });
    await t.keeper.run(false);
    await t.keeper.run(false);
    assert.deepEqual(t.world.savedCalls, [{ refreshToken: 'frr_token0' }]);
    assert.deepEqual(t.world.refreshCalls, []);
    assert.equal(t.world.writes, 0);
  });

  it('old server: no answer to the refresh, the legacy token stays, nothing is confirmed', async () => {
    const t = setup({ authToken: legacy });
    await t.keeper.run(false);
    assert.equal(t.config.authToken, legacy);
    assert.equal(t.world.writes, 0);
    assert.deepEqual(t.world.savedCalls, []);
    // Not asked again until the retry time.
    t.world.now += RUNNER_TOKEN_REFRESH_RETRY_MS - 1;
    await t.keeper.run(false);
    assert.equal(t.world.refreshCalls.length, 1);
    t.world.now += 1;
    await t.keeper.run(false);
    assert.equal(t.world.refreshCalls.length, 2);
  });

  it('a refusal changes nothing; "retry" asks again soon', async () => {
    const t = setup({
      authToken: expiring(30 * DAY),
      refreshToken: 'frr_token0',
      refreshAnswers: [
        { error: 'refresh in progress', retry: true },
        { error: 'refresh token required' }
      ],
      savedAnswers: [{ ok: true }]
    });
    t.world.now = T0 + 2 * DAY;
    await t.keeper.run(false);
    assert.equal(t.config.authToken, expiring(30 * DAY));
    t.world.now += RUNNER_TOKEN_REFRESH_BUSY_RETRY_MS;
    await t.keeper.run(false);
    assert.equal(t.world.refreshCalls.length, 2);
    t.world.now += RUNNER_TOKEN_REFRESH_BUSY_RETRY_MS;
    await t.keeper.run(false);
    assert.equal(t.world.refreshCalls.length, 2);
    assert.equal(t.file()?.refreshToken, 'frr_token0');
    noTokenIn(t.world.logs);
  });

  it('a confirm the server refuses is tried again later, not every tick', async () => {
    const t = setup({
      authToken: expiring(30 * DAY),
      refreshToken: 'frr_token0',
      savedAnswers: [{ error: 'refresh token mismatch' }, { ok: true }]
    });
    await t.keeper.run(false);
    await t.keeper.run(false);
    assert.equal(t.world.savedCalls.length, 1);
    t.world.now += RUNNER_TOKEN_REFRESH_RETRY_MS;
    await t.keeper.run(false);
    assert.equal(t.keeper.state().confirmed, true);
  });
});
