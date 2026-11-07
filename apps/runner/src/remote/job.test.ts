import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApiError, PROCEDURES, type Api } from './api';
import { cancelJob, EXIT, exitCodeFor, parseParams, printRunners, runJob, type JobIo, type JobStatus } from './job';

function fakeIo(opts: { interruptAfterSleeps?: number } = {}): JobIo & { stdout: string; stderr: string } {
  let handler: (() => void) | null = null;
  let sleeps = 0;
  const io = {
    stdout: '',
    stderr: '',
    out: (t: string) => {
      io.stdout += t;
    },
    err: (t: string) => {
      io.stderr += t;
    },
    sleep: async () => {
      sleeps += 1;
      if (opts.interruptAfterSleeps !== undefined && sleeps >= opts.interruptAfterSleeps) handler?.();
    },
    onInterrupt: (h: () => void) => {
      handler = h;
      return () => {
        handler = null;
      };
    }
  };
  return io;
}

function scriptedApi(statuses: JobStatus[], callError?: Error): Api & { calls: unknown[] } {
  const calls: unknown[] = [];
  let i = 0;
  return {
    calls,
    async mutation<T>(path: string, input: unknown): Promise<T> {
      calls.push({ path, input });
      if (callError) throw callError;
      assert.equal(path, PROCEDURES.call);
      return { callId: 'call-1' } as T;
    },
    async query<T>(path: string, input: unknown): Promise<T> {
      calls.push({ path, input });
      assert.equal(path, PROCEDURES.status);
      // A loop that misses a terminal state polls forever; fail it fast
      // (runJob gives up after its failure budget and exits 1).
      if (i > statuses.length + 100) throw new Error('polled past the end of the script');
      const s = statuses[Math.min(i, statuses.length - 1)];
      i += 1;
      return s as T;
    }
  };
}

const args = { spaceSlug: 'factiii-board', runnerId: 7, job: 'deploy-prod', params: {} };

describe('exitCodeFor', () => {
  it('maps terminal states to exit codes', () => {
    assert.equal(exitCodeFor({ state: 'done', exitCode: 0 }), 0);
    assert.equal(exitCodeFor({ state: 'done', exitCode: 5 }), 5);
    assert.equal(exitCodeFor({ state: 'done', exitCode: null }), 0);
    assert.equal(exitCodeFor({ state: 'denied', exitCode: null }), 77);
    assert.equal(exitCodeFor({ state: 'failed', exitCode: null }), 3);
    // A job that ran and failed keeps its own code; 3 only without one.
    assert.equal(exitCodeFor({ state: 'failed', exitCode: 9 }), 9);
    assert.equal(exitCodeFor({ state: 'failed', exitCode: 5 }), 5);
    assert.equal(exitCodeFor({ state: 'failed', exitCode: null }), 3);
    assert.equal(exitCodeFor({ state: 'failed', exitCode: -1 }), 3);
    assert.equal(exitCodeFor({ state: 'failed', exitCode: 0 }), 3);
    // A cancel is 130 whatever code the runner sends.
    assert.equal(exitCodeFor({ state: 'cancelled', exitCode: null }), 130);
    assert.equal(exitCodeFor({ state: 'cancelled', exitCode: -1 }), 130);
    assert.equal(exitCodeFor({ state: 'cancelled', exitCode: 0 }), 130);
  });
  it('refuses a live state', () => {
    assert.throws(() => exitCodeFor({ state: 'running', exitCode: null }));
  });
});

describe('runJob', () => {
  it('prints chunks once, in order, and exits with the job code', async () => {
    const api = scriptedApi([
      { state: 'queued', exitCode: null, chunks: [{ seq: 0, text: 'start\n' }] },
      { state: 'waiting-auth', exitCode: null, chunks: [{ seq: 1, text: 'a\n' }] },
      { state: 'waiting-auth', exitCode: null, chunks: [] },
      // Out of order, plus a repeat of seq 1: printed once, sorted.
      { state: 'running', exitCode: null, chunks: [{ seq: 3, text: 'c\n' }, { seq: 1, text: 'a\n' }, { seq: 2, text: 'b\n' }] },
      { state: 'done', exitCode: 4, chunks: [{ seq: 4, text: 'd\n' }] }
    ]);
    const io = fakeIo();
    const code = await runJob(api, args, io);
    assert.equal(code, 4);
    assert.equal(io.stdout, 'start\na\nb\nc\nd\n');
    assert.equal(io.stderr.split('waiting for approval on your phone').length - 1, 1);
    // afterSeq advances with what was printed.
    const polls = api.calls.filter((c) => (c as { path: string }).path === PROCEDURES.status);
    // The first poll asks from the start: seq 0 is a real chunk.
    assert.deepEqual((polls[0] as { input: unknown }).input, { callId: 'call-1', afterSeq: -1 });
    assert.deepEqual((polls[polls.length - 1] as { input: unknown }).input, { callId: 'call-1', afterSeq: 3 });
  });

  it('prints "approved" once when the gate opens, even when a poll misses running', async () => {
    const viaRunning = fakeIo();
    await runJob(
      scriptedApi([
        { state: 'waiting-auth', exitCode: null, chunks: [] },
        { state: 'waiting-auth', exitCode: null, chunks: [] },
        { state: 'running', exitCode: null, chunks: [] },
        { state: 'done', exitCode: 0, chunks: [] }
      ]),
      args,
      viaRunning
    );
    assert.equal(viaRunning.stderr.split('approved\n').length - 1, 1);

    const straightToDone = fakeIo();
    await runJob(
      scriptedApi([
        { state: 'waiting-auth', exitCode: null, chunks: [] },
        { state: 'done', exitCode: 0, chunks: [] }
      ]),
      args,
      straightToDone
    );
    assert.equal(straightToDone.stderr.split('approved\n').length - 1, 1);

    // A fast job that exits non-zero: waiting-auth -> failed (exit 5).
    const straightToFailed = fakeIo();
    const code = await runJob(
      scriptedApi([
        { state: 'waiting-auth', exitCode: null, chunks: [] },
        { state: 'failed', exitCode: 5, chunks: [] }
      ]),
      args,
      straightToFailed
    );
    assert.equal(code, 5);
    assert.equal(straightToFailed.stderr.split('approved\n').length - 1, 1);

    const cancelled = fakeIo();
    await runJob(
      scriptedApi([
        { state: 'waiting-auth', exitCode: null, chunks: [] },
        { state: 'cancelled', exitCode: null, chunks: [] }
      ]),
      args,
      cancelled
    );
    assert.doesNotMatch(cancelled.stderr, /approved/);

    const denied = fakeIo();
    await runJob(
      scriptedApi([
        { state: 'waiting-auth', exitCode: null, chunks: [] },
        { state: 'denied', exitCode: null, chunks: [] }
      ]),
      args,
      denied
    );
    assert.doesNotMatch(denied.stderr, /approved/);
    assert.match(denied.stderr, /denied by an approver/);
  });

  it('says a dangerous job call waits for the runner owner, then runs once approved', async () => {
    const io = fakeIo();
    const code = await runJob(
      scriptedApi([
        { state: 'waiting-owner', exitCode: null, chunks: [] },
        { state: 'waiting-owner', exitCode: null, chunks: [] },
        { state: 'running', exitCode: null, chunks: [{ seq: 1, text: 'row\n' }] },
        { state: 'done', exitCode: 0, chunks: [] }
      ]),
      { ...args, job: 'db-write' },
      io
    );
    assert.equal(code, 0);
    assert.equal(io.stderr.split('waiting for the runner owner').length - 1, 1);
    assert.equal(io.stderr.split('approved by the runner owner\n').length - 1, 1);
    assert.equal(io.stdout, 'row\n');
  });

  it('exits 77 when the runner owner does not approve a dangerous job call', async () => {
    const io = fakeIo();
    const code = await runJob(
      scriptedApi([
        { state: 'waiting-owner', exitCode: null, chunks: [] },
        { state: 'denied', exitCode: null, chunks: [] }
      ]),
      { ...args, job: 'db-write' },
      io
    );
    assert.equal(code, 77);
    assert.doesNotMatch(io.stderr, /approved by the runner owner\n/);
    assert.match(io.stderr, /db-write: not approved by the runner owner/);
  });

  it('exits 77 on a denied gate', async () => {
    const io = fakeIo();
    const code = await runJob(scriptedApi([{ state: 'denied', exitCode: null, chunks: [] }]), args, io);
    assert.equal(code, EXIT.denied);
    assert.equal(code, 77);
  });

  it('exits 3 and says so when the job fails to start', async () => {
    const io = fakeIo();
    assert.equal(await runJob(scriptedApi([{ state: 'failed', exitCode: null, chunks: [] }]), args, io), 3);
    assert.match(io.stderr, /deploy-prod: failed to start/);
  });

  it('exits with the code of a job that ran and failed, without "failed to start"', async () => {
    const io = fakeIo();
    const api = scriptedApi([
      { state: 'running', exitCode: null, chunks: [{ seq: 1, text: 'boom\n' }] },
      { state: 'failed', exitCode: 5, chunks: [] }
    ]);
    assert.equal(await runJob(api, args, io), 5);
    assert.doesNotMatch(io.stderr, /failed to start/);
  });

  it('prints the call id first, and sends only the job fields', async () => {
    const io = fakeIo();
    const api = scriptedApi([
      { state: 'waiting-auth', exitCode: null, chunks: [] },
      { state: 'done', exitCode: 0, chunks: [] }
    ]);
    await runJob(api, { ...args, cancelFlags: '--server http://x' }, io);
    assert.ok(io.stderr.startsWith('call call-1\n'), io.stderr);
    assert.ok(io.stderr.indexOf('waiting for approval on your phone') > 0);
    assert.deepEqual((api.calls[0] as { input: unknown }).input, {
      spaceSlug: 'factiii-board',
      runnerId: 7,
      job: 'deploy-prod',
      params: {}
    });
  });

  it('exits 130 for a cancelled call that reports exitCode -1', async () => {
    const io = fakeIo();
    assert.equal(await runJob(scriptedApi([{ state: 'cancelled', exitCode: -1, chunks: [] }]), args, io), 130);
    assert.match(io.stderr, /\ncancelled\n/);
  });

  it('exits 3 when the server refuses the call', async () => {
    const io = fakeIo();
    const api = scriptedApi([], new ApiError('No such job', 'NOT_FOUND', 404));
    assert.equal(await runJob(api, args, io), 3);
    assert.match(io.stderr, /No such job/);
  });

  it('rethrows an auth failure so the CLI can say to log in', async () => {
    const api = scriptedApi([], new ApiError('no', 'UNAUTHORIZED', 401));
    await assert.rejects(runJob(api, args, fakeIo()), ApiError);
  });

  it('on Ctrl-C stops polling and says the job keeps running', async () => {
    const io = fakeIo({ interruptAfterSleeps: 2 });
    const api = scriptedApi([{ state: 'running', exitCode: null, chunks: [] }]);
    const code = await runJob(api, args, io);
    assert.equal(code, EXIT.interrupted);
    assert.match(io.stderr, /keeps running on the runner/);
    assert.match(io.stderr, /To stop it: factiii-runner cancel call-1\n/);
  });

  it('puts a non-default --server into the printed cancel command', async () => {
    const io = fakeIo({ interruptAfterSleeps: 1 });
    const api = scriptedApi([{ state: 'running', exitCode: null, chunks: [] }]);
    await runJob(api, { ...args, cancelFlags: '--server http://localhost:5001' }, io);
    assert.match(io.stderr, /To stop it: factiii-runner cancel call-1 --server http:\/\/localhost:5001\n/);
  });

  it('prints "cancelled" and exits 130 when the call is cancelled', async () => {
    const io = fakeIo();
    const api = scriptedApi([
      { state: 'running', exitCode: null, chunks: [{ seq: 0, text: 'step 1\n' }] },
      { state: 'cancelled', exitCode: null, chunks: [] }
    ]);
    assert.equal(await runJob(api, args, io), 130);
    assert.equal(io.stdout, 'step 1\n');
    assert.match(io.stderr, /\ncancelled\n/);
  });
});

describe('cancelJob', () => {
  const cancelApi = (result: { cancelled: boolean } | Error, sent: unknown[]): Api => ({
    query: async () => {
      throw new Error('no queries');
    },
    async mutation<T>(path: string, input: unknown): Promise<T> {
      sent.push({ path, input });
      if (result instanceof Error) throw result;
      return result as T;
    }
  });

  it('exits 0 when cancelled, 1 when already ended, 3 on an error', async () => {
    const sent: unknown[] = [];
    const io = fakeIo();
    assert.equal(await cancelJob(cancelApi({ cancelled: true }, sent), 'call-1', io), 0);
    assert.deepEqual(sent, [{ path: 'runnerJobs.cancel', input: { callId: 'call-1' } }]);
    assert.equal(await cancelJob(cancelApi({ cancelled: false }, []), 'call-1', io), 1);
    assert.match(io.stdout, /already ended/);
    assert.equal(await cancelJob(cancelApi(new ApiError('The runner for this call is offline', 'SERVICE_UNAVAILABLE', 503), []), 'call-1', io), 3);
    assert.match(io.stderr, /offline/);
  });
});

describe('printRunners', () => {
  it('prints the id and the name --runner takes, whose it is and whether it is connected', () => {
    let text = '';
    const io = {
      out: (t: string) => {
        text += t;
      }
    };
    printRunners(
      [
        { runnerId: 4, name: 'mac-mini-office', owned: false, online: true },
        { runnerId: 12, name: 'laptop', owned: true, online: false }
      ],
      'factiii-board',
      io
    );
    assert.equal(text, '4   mac-mini-office  shared  online\n12  laptop           yours   offline\n');
    text = '';
    printRunners([], 'factiii-board', io);
    assert.equal(text, 'No runner is open to you on factiii-board.\n');
  });
});

describe('parseParams', () => {
  it('splits on the first =', () => {
    assert.deepEqual(parseParams(['ref=main', 'x=a=b']), { ref: 'main', x: 'a=b' });
  });
  it('refuses a pair with no key', () => {
    assert.throws(() => parseParams(['=v']));
    assert.throws(() => parseParams(['novalue']));
  });
});
