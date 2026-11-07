import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RUNNER_IP_CHALLENGE_REQUIRED } from '@shared/all/validators';

import { ApiError, isNewAddress, PROCEDURES, type Api } from './api';
import { confirmAddress, NO_TTY_HINT, withAddressCheck, type IpPinIo } from './ipPin';
import { EXIT } from './job';

const newAddress = () => new ApiError(RUNNER_IP_CHALLENGE_REQUIRED, 'FORBIDDEN', 403);

function fakeIo(answers: string[]): IpPinIo & { stderr: string; prompts: number } {
  const io = {
    stderr: '',
    prompts: 0,
    out: () => {},
    err: (t: string) => {
      io.stderr += t;
    },
    promptLine: async () => {
      io.prompts += 1;
      return answers.shift() ?? '';
    }
  };
  return io;
}

/** An api whose verifyIp answers from `verdicts` in order. */
function scriptedApi(verdicts: (Error | 'ok')[]): Api & { calls: { path: string; input: unknown }[] } {
  const calls: { path: string; input: unknown }[] = [];
  return {
    calls,
    async query<T>(path: string, input: unknown): Promise<T> {
      calls.push({ path, input });
      return {} as T;
    },
    async mutation<T>(path: string, input: unknown): Promise<T> {
      calls.push({ path, input });
      if (path === PROCEDURES.ipChallenge) return { challengeId: 'c1', ip: '203.0.113.9' } as T;
      if (path === PROCEDURES.verifyIp) {
        const v = verdicts.shift() ?? 'ok';
        if (v !== 'ok') throw v;
        return { ip: '203.0.113.9' } as T;
      }
      return {} as T;
    }
  };
}

describe('isNewAddress', () => {
  it('matches the server sentence and nothing else', () => {
    assert.equal(isNewAddress(newAddress()), true);
    assert.equal(isNewAddress(new ApiError('Not a member of this space', 'FORBIDDEN', 403)), false);
    assert.equal(isNewAddress(new Error(RUNNER_IP_CHALLENGE_REQUIRED)), false);
  });
});

describe('confirmAddress', () => {
  it('opens a challenge, sends the typed code and reports the new address', async () => {
    const api = scriptedApi(['ok']);
    const io = fakeIo(['123456']);
    assert.equal(await confirmAddress(api, io), true);
    assert.deepEqual(
      api.calls.map((c) => c.path),
      [PROCEDURES.ipChallenge, PROCEDURES.verifyIp]
    );
    assert.deepEqual(api.calls[1].input, { challengeId: 'c1', code: '123456' });
    assert.match(io.stderr, /new address \(203\.0\.113\.9\)/);
    assert.match(io.stderr, /Address confirmed/);
  });

  it('asks again after a wrong code, up to three times', async () => {
    const wrong = new ApiError('That code did not work', 'BAD_REQUEST', 400);
    const api = scriptedApi([wrong, 'ok']);
    const io = fakeIo(['000000', '123456']);
    assert.equal(await confirmAddress(api, io), true);
    assert.equal(io.prompts, 2);
    assert.match(io.stderr, /That code did not work/);
  });

  it('stops when the server spends the challenge', async () => {
    const spent = new ApiError('Too many wrong codes. Start again.', 'BAD_REQUEST', 400);
    const api = scriptedApi([spent]);
    const io = fakeIo(['000000', '123456']);
    assert.equal(await confirmAddress(api, io), false);
    assert.equal(io.prompts, 1);
  });

  it('names the command for a person when nobody is at a terminal', async () => {
    const api = scriptedApi([]);
    const io = fakeIo([]);
    assert.equal(await confirmAddress(api, io), false);
    assert.equal(io.stderr.includes(NO_TTY_HINT), true);
    assert.equal(api.calls.some((c) => c.path === PROCEDURES.verifyIp), false);
  });

  it('lets a refusal that is not a wrong code through', async () => {
    const other = new ApiError('Confirm from the terminal that asked', 'FORBIDDEN', 403);
    const api = scriptedApi([other]);
    await assert.rejects(confirmAddress(api, fakeIo(['123456'])), other);
  });
});

describe('withAddressCheck', () => {
  it('runs the body once when the address is pinned', async () => {
    let runs = 0;
    const code = await withAddressCheck(scriptedApi([]), fakeIo([]), async () => {
      runs += 1;
      return 0;
    });
    assert.equal(code, 0);
    assert.equal(runs, 1);
  });

  it('confirms the address and runs the body again', async () => {
    let runs = 0;
    const api = scriptedApi(['ok']);
    const code = await withAddressCheck(api, fakeIo(['123456']), async () => {
      runs += 1;
      if (runs === 1) throw newAddress();
      return 0;
    });
    assert.equal(code, 0);
    assert.equal(runs, 2);
  });

  it('exits 3 when the address could not be confirmed', async () => {
    let runs = 0;
    const code = await withAddressCheck(scriptedApi([]), fakeIo([]), async () => {
      runs += 1;
      throw newAddress();
    });
    assert.equal(code, EXIT.failedToStart);
    assert.equal(runs, 1);
  });

  it('passes any other error through untouched', async () => {
    const boom = new ApiError('Not a member of this space', 'FORBIDDEN', 403);
    await assert.rejects(
      withAddressCheck(scriptedApi([]), fakeIo([]), async () => {
        throw boom;
      }),
      boom
    );
  });
});
