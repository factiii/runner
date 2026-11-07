import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pairByCode, renderQr, startPairing, type StartPairing } from './auth';
import { ApiError, PROCEDURES, type Api } from './remote/api';

// Pairing by code (`factiii-runner setup`): the start call and the poll loop.

const START: StartPairing = {
  deviceCode: 'd'.repeat(43),
  userCode: 'ABCD-EF23',
  approveUrl: 'https://factiii.com/runners/connect?code=ABCD-EF23',
  interval: 3,
  expiresIn: 600
};

/** An Api whose mutations answer from a script, recording each call. */
function scriptedApi(answers: (unknown | Error)[]): { api: Api; calls: string[] } {
  const calls: string[] = [];
  const api: Api = {
    query: async () => {
      throw new Error('no queries here');
    },
    mutation: async <T>(path: string): Promise<T> => {
      calls.push(path);
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next as T;
    }
  };
  return { api, calls };
}

function fakeIo() {
  let clock = 0;
  const out: string[] = [];
  const opened: string[] = [];
  return {
    out,
    opened,
    io: {
      out: (text: string) => out.push(text),
      sleep: async (ms: number) => {
        clock += ms;
      },
      open: (url: string) => opened.push(url),
      now: () => clock
    }
  };
}

describe('startPairing', () => {
  it('sends the name and platform, and surfaces any other error', async () => {
    const { api, calls } = scriptedApi([START]);
    assert.deepEqual(await startPairing(api, 'mini', 'darwin'), START);
    assert.deepEqual(calls, [PROCEDURES.startPairing]);
    const failing = scriptedApi([new ApiError('Too many', 'TOO_MANY_REQUESTS', 429)]);
    await assert.rejects(startPairing(failing.api, 'mini', 'darwin'), /Too many/);
  });
});

describe('pairByCode', () => {
  it('prints the QR, the code and the link, opens the page, and polls until approved', async () => {
    const { api, calls } = scriptedApi([
      { status: 'pending' },
      new TypeError('fetch failed'),
      { status: 'pending' },
      { status: 'approved', token: 'jwt', refreshToken: 'frr_x' }
    ]);
    const { io, out, opened } = fakeIo();
    assert.deepEqual(await pairByCode(api, START, io), {
      token: 'jwt',
      refreshToken: 'frr_x'
    });
    assert.equal(calls.length, 4);
    assert.ok(calls.every((c) => c === PROCEDURES.pollPairing));
    assert.deepEqual(opened, [START.approveUrl]);
    const text = out.join('');
    assert.match(text, /Code: ABCD-EF23/);
    assert.ok(text.includes(START.approveUrl));
    assert.ok(text.includes(await renderQr(START.approveUrl)));
    // Said once, not on every failed poll.
    assert.equal(text.split('Could not reach the server').length, 2);
  });

  it('stops on a denial', async () => {
    const { api } = scriptedApi([{ status: 'denied' }]);
    await assert.rejects(pairByCode(api, START, fakeIo().io), /Pairing denied/);
  });

  it('stops when the server says the code expired', async () => {
    const { api } = scriptedApi([{ status: 'expired' }]);
    await assert.rejects(pairByCode(api, START, fakeIo().io), /expired/);
  });

  it('gives up at the deadline', async () => {
    const pending = Array.from({ length: 500 }, () => ({ status: 'pending' }));
    const { api, calls } = scriptedApi(pending);
    await assert.rejects(
      pairByCode(api, { ...START, expiresIn: 30, interval: 3 }, fakeIo().io),
      /expired/
    );
    assert.equal(calls.length, 10);
  });

  it('stops on a refusal that is not transient', async () => {
    const { api } = scriptedApi([new ApiError('Bad input', 'BAD_REQUEST', 400)]);
    await assert.rejects(pairByCode(api, START, fakeIo().io), /Bad input/);
  });
});

describe('renderQr', () => {
  it('draws a QR code in terminal characters', async () => {
    const qr = await renderQr(START.approveUrl);
    assert.ok(qr.split('\n').length > 10);
    assert.match(qr, /[▀▄█]/);
  });
});
