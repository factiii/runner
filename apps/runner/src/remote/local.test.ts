import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import type { JobIo } from './job';
import { localBridge, localCancelJob, localListJobs, localRunJob, type LocalBridge } from './local';

const TOKEN = 'session-token-1';

type Script = (request: Record<string, unknown>, conn: net.Socket) => void;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** A fake secrets bridge: records each request line and runs `script`. */
async function fakeBridge(script: Script): Promise<{ bridge: LocalBridge; requests: Record<string, unknown>[] }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcli-'));
  const sock = path.join(dir, 's.sock');
  const requests: Record<string, unknown>[] = [];
  const live = new Set<net.Socket>();
  const server = net.createServer((conn) => {
    live.add(conn);
    conn.on('close', () => live.delete(conn));
    conn.on('error', () => {});
    let buffer = '';
    conn.on('data', (c: Buffer) => {
      buffer += c.toString();
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      const request = JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>;
      requests.push(request);
      script(request, conn);
    });
  });
  await new Promise<void>((resolve) => server.listen(sock, resolve));
  cleanups.push(async () => {
    for (const c of live) c.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { bridge: { sock, token: TOKEN }, requests };
}

const send = (conn: net.Socket, msg: unknown): boolean => conn.write(`${JSON.stringify(msg)}\n`);

function fakeIo(onInterruptSet?: (h: () => void) => void): JobIo & { stdout: string; stderr: string } {
  const io = {
    stdout: '',
    stderr: '',
    out: (t: string) => {
      io.stdout += t;
    },
    err: (t: string) => {
      io.stderr += t;
    },
    sleep: async () => {},
    onInterrupt: (h: () => void) => {
      onInterruptSet?.(h);
      return () => {};
    }
  };
  return io;
}

/** Replies a followed job call: accepted, the given messages, then close. */
const followed =
  (...messages: unknown[]): Script =>
  (_req, conn) => {
    send(conn, { type: 'job-accepted', callId: 'c-1' });
    for (const m of messages) send(conn, m);
    conn.end();
  };

describe('localBridge', () => {
  it('needs both the socket and the token', () => {
    assert.equal(localBridge({}), null);
    assert.equal(localBridge({ FACTIII_SECRETS_SOCK: '/s' }), null);
    assert.equal(localBridge({ FACTIII_SECRETS_TOKEN: 't' }), null);
    assert.deepEqual(localBridge({ FACTIII_SECRETS_SOCK: '/s', FACTIII_SECRETS_TOKEN: 't' }), { sock: '/s', token: 't' });
  });
});

describe('local job --list', () => {
  it('sends job-list with the token and prints the jobs', async () => {
    const { bridge, requests } = await fakeBridge((_req, conn) => {
      send(conn, { type: 'jobs', jobs: [{ name: 'deploy-staging', description: 'Ship staging', keys: ['EXPO_TOKEN'], files: [], params: { branch: '^[a-z-]+$' } }] });
      conn.end();
    });
    const io = fakeIo();
    assert.equal(await localListJobs(bridge, io), 0);
    assert.deepEqual(requests, [{ op: 'job-list', token: TOKEN }]);
    assert.match(io.stdout, /deploy-staging\s+Ship staging/);
    assert.match(io.stdout, /secrets: EXPO_TOKEN/);
    assert.match(io.stdout, /--param branch=/);
  });

  it('exits 3 on an error reply', async () => {
    const { bridge } = await fakeBridge((_req, conn) => {
      send(conn, { type: 'error', message: 'This runner serves no jobs here.' });
      conn.end();
    });
    const io = fakeIo();
    assert.equal(await localListJobs(bridge, io), 3);
    assert.match(io.stderr, /serves no jobs here/);
  });
});

describe('local job <name>', () => {
  it('sends a followed job-call and streams output, one approval line, and the exit code', async () => {
    const { bridge, requests } = await fakeBridge((_req, conn) => {
      send(conn, { type: 'job-accepted', callId: 'c-1' });
      send(conn, { type: 'status', text: 'queued' });
      send(conn, { type: 'status', text: 'waiting-auth' });
      send(conn, { type: 'status', text: 'waiting-auth' });
      send(conn, { type: 'status', text: 'running' });
      // One message split across two writes: the reader must join them.
      const line = `${JSON.stringify({ type: 'output', chunk: 'building\n' })}\n`;
      conn.write(line.slice(0, 10));
      setTimeout(() => {
        conn.write(line.slice(10));
        send(conn, { type: 'output', chunk: 'done\n' });
        send(conn, { type: 'exit', code: 5 });
        conn.end();
      }, 20);
    });
    const io = fakeIo();
    const code = await localRunJob(bridge, { job: 'deploy-staging', params: { branch: 'x' } }, io);
    assert.equal(code, 5);
    assert.deepEqual(requests, [{ op: 'job-call', token: TOKEN, job: 'deploy-staging', params: { branch: 'x' }, follow: true }]);
    assert.equal(io.stdout, 'building\ndone\n');
    assert.ok(io.stderr.startsWith('call c-1\n'), io.stderr);
    assert.equal(io.stderr.split('waiting for approval on your phone').length - 1, 1);
  });

  it('prints "approved" once when the gate opens, including straight to done', async () => {
    const run = async (...messages: unknown[]): Promise<string> => {
      const { bridge } = await fakeBridge(followed(...messages));
      const io = fakeIo();
      await localRunJob(bridge, { job: 'deploy-prod', params: {} }, io);
      return io.stderr;
    };
    const viaRunning = await run(
      { type: 'status', text: 'waiting-auth' },
      { type: 'status', text: 'running' },
      { type: 'status', text: 'done' },
      { type: 'exit', code: 0 }
    );
    assert.equal(viaRunning.split('approved\n').length - 1, 1);
    const straight = await run({ type: 'status', text: 'waiting-auth' }, { type: 'status', text: 'done' }, { type: 'exit', code: 0 });
    assert.equal(straight.split('approved\n').length - 1, 1);
    const failed = await run({ type: 'status', text: 'waiting-auth' }, { type: 'status', text: 'failed' }, { type: 'exit', code: 5 });
    assert.equal(failed.split('approved\n').length - 1, 1);
    const cancelled = await run(
      { type: 'status', text: 'waiting-auth' },
      { type: 'status', text: 'cancelled' },
      { type: 'cancelled', cancelled: true }
    );
    assert.doesNotMatch(cancelled, /approved/);
    const denied = await run({ type: 'status', text: 'waiting-auth' }, { type: 'status', text: 'denied' }, { type: 'denied' });
    assert.doesNotMatch(denied, /approved/);
    assert.match(denied, /denied by an approver/);
  });

  it('exits 77 when denied', async () => {
    const { bridge } = await fakeBridge(followed({ type: 'status', text: 'waiting-auth' }, { type: 'denied' }));
    assert.equal(await localRunJob(bridge, { job: 'deploy-prod', params: {} }, fakeIo()), 77);
  });

  it('passes the bridge code through, 3 for a job that failed without one', async () => {
    const { bridge } = await fakeBridge(followed({ type: 'exit', code: 3 }));
    assert.equal(await localRunJob(bridge, { job: 'deploy-prod', params: {} }, fakeIo()), 3);
    const ok = await fakeBridge(followed({ type: 'exit', code: 0 }));
    assert.equal(await localRunJob(ok.bridge, { job: 'deploy-prod', params: {} }, fakeIo()), 0);
  });

  it('prints "cancelled" and exits 130 when the call is cancelled', async () => {
    const { bridge } = await fakeBridge(
      followed({ type: 'output', chunk: 'step 1\n' }, { type: 'status', text: 'cancelled' }, { type: 'cancelled', cancelled: true })
    );
    const io = fakeIo();
    assert.equal(await localRunJob(bridge, { job: 'deploy-prod', params: {} }, io), 130);
    assert.equal(io.stdout, 'step 1\n');
    assert.match(io.stderr, /\ncancelled\n/);
  });

  it('exits 3 on an error reply before the call is accepted', async () => {
    const { bridge } = await fakeBridge((_req, conn) => {
      send(conn, { type: 'error', message: 'Unknown job "nope".' });
      conn.end();
    });
    const io = fakeIo();
    assert.equal(await localRunJob(bridge, { job: 'nope', params: {} }, io), 3);
    assert.match(io.stderr, /Could not start nope: Unknown job "nope"\./);
  });

  it('exits 3 when the runner hangs up without an exit', async () => {
    const { bridge } = await fakeBridge(followed({ type: 'status', text: 'running' }));
    const io = fakeIo();
    assert.equal(await localRunJob(bridge, { job: 'deploy-prod', params: {} }, io), 3);
    assert.match(io.stderr, /without an exit code/);
  });

  it('exits 3 when nothing listens on the socket', async () => {
    const io = fakeIo();
    const bridge = { sock: path.join(os.tmpdir(), `fcli-missing-${process.pid}.sock`), token: TOKEN };
    assert.equal(await localRunJob(bridge, { job: 'deploy-prod', params: {} }, io), 3);
    assert.match(io.stderr, /not answering/);
  });

  it('on Ctrl-C hangs up, says the job keeps running, and exits 130', async () => {
    let interrupt: (() => void) | null = null;
    const { bridge } = await fakeBridge((_req, conn) => {
      send(conn, { type: 'job-accepted', callId: 'c-9' });
      send(conn, { type: 'status', text: 'running' });
      // Never ends on its own; the Ctrl-C below hangs up.
      setTimeout(() => interrupt?.(), 30);
    });
    const io = fakeIo((h) => {
      interrupt = h;
    });
    assert.equal(await localRunJob(bridge, { job: 'deploy-prod', params: {} }, io), 130);
    assert.match(io.stderr, /keeps running on the runner/);
    assert.match(io.stderr, /To stop it: factiii-runner cancel c-9\n/);
  });
});

describe('local cancel', () => {
  const answer =
    (msg: unknown): Script =>
    (_req, conn) => {
      send(conn, msg);
      conn.end();
    };

  it('sends job-cancel with the token; exits 0 cancelled, 1 already ended, 3 on an error', async () => {
    const yes = await fakeBridge(answer({ type: 'cancelled', cancelled: true }));
    const io = fakeIo();
    assert.equal(await localCancelJob(yes.bridge, 'c-1', io), 0);
    assert.deepEqual(yes.requests, [{ op: 'job-cancel', token: TOKEN, callId: 'c-1' }]);
    const no = await fakeBridge(answer({ type: 'cancelled', cancelled: false }));
    assert.equal(await localCancelJob(no.bridge, 'c-1', io), 1);
    assert.match(io.stdout, /already ended/);
    const bad = await fakeBridge(answer({ type: 'error', message: 'Unknown call.' }));
    assert.equal(await localCancelJob(bad.bridge, 'c-1', io), 3);
    assert.match(io.stderr, /Could not cancel c-1: Unknown call\./);
    const gone = { sock: path.join(os.tmpdir(), `fcli-missing-${process.pid}.sock`), token: TOKEN };
    assert.equal(await localCancelJob(gone, 'c-1', io), 3);
  });
});

describe('factiii-runner job in a runner session', () => {
  it('uses the socket and needs neither --space nor a login', async () => {
    const { bridge, requests } = await fakeBridge((_req, conn) => {
      send(conn, { type: 'jobs', jobs: [{ name: 'logs-prod', description: 'Tail prod logs', keys: [], files: [], params: {} }] });
      conn.end();
    });
    const runnerDir = path.resolve(__dirname, '..', '..');
    const env: NodeJS.ProcessEnv = { ...process.env, FACTIII_SECRETS_SOCK: bridge.sock, FACTIII_SECRETS_TOKEN: TOKEN };
    delete env.FACTIII_SPACE;
    // An unreachable server proves no login or API call is made.
    env.FACTIII_API_URL = 'http://127.0.0.1:9';
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(runnerDir, 'src', 'cli.ts'), 'job', '--list'], {
      cwd: runnerDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    assert.equal(code, 0, stderr);
    assert.match(stdout, /logs-prod\s+Tail prod logs/);
    assert.deepEqual(requests, [{ op: 'job-list', token: TOKEN }]);
  });
});
