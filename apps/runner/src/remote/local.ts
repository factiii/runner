import net from 'net';

import type { RunnerJobInfo, RunnerJobTargetWait } from '@shared/all/domains/electron';

import { boardLabel } from '../boardRegistry';

import { sessionBoard } from './api';
import { cancelCommand, EXIT, leftGateApproved, printJobs, reportCancel, targetWaitLine, type JobIo } from './job';

// LOCAL mode for `factiii-runner job`: on the runner itself (a Deploy-button
// run, a card or terminal session) there is no CLI login, but the session has
// the space's secrets socket. When FACTIII_SECRETS_SOCK and
// FACTIII_SECRETS_TOKEN are both set, `job` talks to that socket and ignores
// --space and the login. Wire: NDJSON, one request line per connection, and
// the runner closes the connection after its final reply. Server side:
// shared/all/helpers/board-agent-core/secrets-bridge.ts (handleJobOp).

export type LocalBridge = { sock: string; token: string };

type BridgeMessage =
  | { type: 'jobs'; jobs: RunnerJobInfo[] }
  | { type: 'job-accepted'; callId: string }
  | { type: 'status'; text: string; wait?: RunnerJobTargetWait }
  | { type: 'output'; chunk: string }
  | { type: 'exit'; code: number }
  | { type: 'denied' }
  | { type: 'cancelled'; cancelled?: boolean }
  | { type: 'error'; message: string };

/** The session's bridge, when both variables are set. */
export function localBridge(env: NodeJS.ProcessEnv = process.env): LocalBridge | null {
  const sock = env.FACTIII_SECRETS_SOCK;
  const token = env.FACTIII_SECRETS_TOKEN;
  return sock && token ? { sock, token } : null;
}

/**
 * Send one request and feed each reply line to `onMessage` until the runner
 * closes the connection. Returns a handle whose `done` settles on close, and
 * `close()` to hang up early (Ctrl-C).
 */
function bridgeRequest(
  sock: string,
  request: Record<string, unknown>,
  onMessage: (msg: BridgeMessage) => void
): { done: Promise<void>; close: () => void } {
  const conn = net.createConnection(sock);
  const done = new Promise<void>((resolve, reject) => {
    let buffer = '';
    conn.on('connect', () => conn.write(`${JSON.stringify(request)}\n`));
    conn.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          try {
            onMessage(JSON.parse(line) as BridgeMessage);
          } catch {
            // A line that is not JSON is not ours to act on.
          }
        }
        newline = buffer.indexOf('\n');
      }
    });
    conn.on('error', (err) => reject(err));
    conn.on('close', () => resolve());
  });
  return { done, close: () => conn.destroy() };
}

function describe(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ECONNREFUSED') {
    return 'The runner secrets socket is not answering (FACTIII_SECRETS_SOCK). Is the runner still running this session?';
  }
  return err instanceof Error ? err.message : String(err);
}

export async function localListJobs(
  bridge: LocalBridge,
  io: Pick<JobIo, 'out' | 'err'>
): Promise<number> {
  let jobs: RunnerJobInfo[] | null = null;
  let error = '';
  try {
    await bridgeRequest(bridge.sock, { op: 'job-list', token: bridge.token }, (msg) => {
      if (msg.type === 'jobs') jobs = msg.jobs;
      if (msg.type === 'error') error = msg.message;
    }).done;
  } catch (err) {
    error = describe(err);
  }
  if (!jobs) {
    io.err(`Could not list jobs: ${error || 'the runner closed the connection without an answer.'}\n`);
    return EXIT.failedToStart;
  }
  const board = sessionBoard();
  printJobs(jobs, board ? boardLabel(board, board.slug) : 'this space', io);
  return 0;
}

/** `job-cancel` over the bridge: 0 cancelled, 1 already ended, 3 error. */
export async function localCancelJob(
  bridge: LocalBridge,
  callId: string,
  io: Pick<JobIo, 'out' | 'err'>
): Promise<number> {
  let cancelled: boolean | null = null;
  let error = '';
  try {
    await bridgeRequest(bridge.sock, { op: 'job-cancel', token: bridge.token, callId }, (msg) => {
      if (msg.type === 'cancelled') cancelled = msg.cancelled === true;
      if (msg.type === 'error') error = msg.message;
    }).done;
  } catch (err) {
    error = describe(err);
  }
  if (cancelled === null) {
    io.err(`Could not cancel ${callId}: ${error || 'the runner closed the connection without an answer.'}\n`);
    return EXIT.failedToStart;
  }
  return reportCancel(cancelled, callId, io);
}

/** Call a job over the bridge with `follow: true` and stream it. */
export async function localRunJob(
  bridge: LocalBridge,
  args: { job: string; params: Record<string, string> },
  io: Pick<JobIo, 'out' | 'err' | 'onInterrupt'>
): Promise<number> {
  let callId = '';
  let result: number | null = null;
  let error = '';
  let waitingShown = false;
  let lastStatus: string | null = null;
  let lastWaitKey = '';

  const request = bridgeRequest(
    bridge.sock,
    { op: 'job-call', token: bridge.token, job: args.job, params: args.params, follow: true },
    (msg) => {
      switch (msg.type) {
        case 'job-accepted':
          callId = msg.callId;
          // `cancel` needs this id, so say it before anything else happens.
          io.err(`call ${callId}\n`);
          break;
        case 'status':
          if (msg.text === 'waiting-auth' && !waitingShown) {
            waitingShown = true;
            io.err('\nwaiting for approval on your phone\n');
          } else if (leftGateApproved(lastStatus, msg.text)) {
            io.err('approved\n');
          }
          if (msg.text === 'waiting-target') {
            const wait = targetWaitLine(msg.wait, lastWaitKey);
            if (wait) {
              lastWaitKey = wait.key;
              io.err(wait.line);
            }
          }
          lastStatus = msg.text;
          break;
        case 'output':
          io.out(msg.chunk);
          break;
        case 'exit':
          // The bridge already maps a failure with no code to 3.
          result = msg.code & 0xff;
          break;
        case 'denied':
          io.err(`\n${args.job}: denied by an approver\n`);
          result = EXIT.denied;
          break;
        case 'cancelled':
          io.err('\ncancelled\n');
          result = EXIT.interrupted;
          break;
        case 'error':
          error = msg.message;
          break;
      }
    }
  );

  let interrupted = false;
  const removeInterrupt = io.onInterrupt(() => {
    interrupted = true;
    request.close();
  });
  try {
    await request.done;
  } catch (err) {
    if (!interrupted) error = error || describe(err);
  } finally {
    removeInterrupt();
  }

  if (interrupted && result === null) {
    io.err(
      `\nStopped watching. The job keeps running on the runner.\n` +
        (callId ? `To stop it: ${cancelCommand(callId)}\n` : '')
    );
    return EXIT.interrupted;
  }
  if (result !== null) return result;
  io.err(
    `\n${callId ? `${args.job} (call ${callId})` : `Could not start ${args.job}`}: ${
      error || 'the runner closed the connection without an exit code.'
    }\n`
  );
  return EXIT.failedToStart;
}
