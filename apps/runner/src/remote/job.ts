import type {
  RunnerJobInfo,
  RunnerJobState
} from '@shared/all/domains/electron';

import { ApiError, describeSpace, isNewAddress, PROCEDURES, type Api, type OpenRunner } from './api';

/** Exit codes the CLI owns. A finished job exits with its own code. */
export const EXIT = {
  /** Bad flags, no login, or lost contact with the server. */
  usage: 1,
  /** The call never started: unknown job, runner offline, not a member. */
  failedToStart: 3,
  /** An approver denied the secrets gate, or the runner owner did not
   *  approve a dangerous job call (a no, or 10 minutes without one). */
  denied: 77,
  /** Ctrl-C: the CLI stopped watching; the job keeps running. Also a job
   *  that someone cancelled, the same code a shell gives an interrupted one. */
  interrupted: 130,
  /** `cancel`: the call had already ended, so there was nothing to cancel. */
  nothingToCancel: 1
} as const;

export type JobStatus = {
  state: RunnerJobState;
  exitCode: number | null;
  chunks: { seq: number; text: string }[];
};

export type JobIo = {
  out: (text: string) => void;
  err: (text: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** Registers the Ctrl-C handler; returns a function that removes it. */
  onInterrupt: (handler: () => void) => () => void;
};

const POLL_MS = 1000;
/** Consecutive failed polls before the CLI gives up watching (~1 min). */
const MAX_POLL_FAILURES = 60;

/** Map a terminal state to the process exit code. */
export function exitCodeFor(status: Pick<JobStatus, 'state' | 'exitCode'>): number {
  switch (status.state) {
    case 'done':
      // A job's code is an 8-bit process status; a missing one means success
      // was reported without a code.
      return status.exitCode === null ? 0 : status.exitCode & 0xff;
    case 'denied':
      return EXIT.denied;
    case 'failed':
      // A job that ran and failed exits with its own code. 3 is only for a
      // job with no code: it never started.
      return ranWithCode(status) ? (status.exitCode as number) : EXIT.failedToStart;
    case 'cancelled':
      // Whatever code the runner reports (it has sent -1): a cancel is 130.
      return EXIT.interrupted;
    default:
      throw new Error(`exitCodeFor called on a live state: ${status.state}`);
  }
}

/** True when a call left the gate because it was approved: it went on to
 *  run, or ended any way but denied or cancelled. A poll can miss `running`
 *  entirely (waiting-auth -> done, or -> failed for a fast job that exits
 *  non-zero). A denial prints its own "denied by an approver" line. */
export function leftGateApproved(prev: string | null, next: string): boolean {
  return prev === 'waiting-auth' && (next === 'running' || next === 'done' || next === 'failed');
}

/** The same for the runner owner's approval of a dangerous job call: it
 *  went on to queue, the gate or a run. A poll can miss every step between. */
function leftOwnerApproved(prev: string | null, next: string): boolean {
  return (
    prev === 'waiting-owner' &&
    next !== 'waiting-owner' &&
    next !== 'denied' &&
    next !== 'cancelled'
  );
}

/** A failed call that carries a real process status (1-255). */
function ranWithCode(status: Pick<JobStatus, 'exitCode'>): boolean {
  const code = status.exitCode;
  return code !== null && Number.isInteger(code) && code > 0 && code <= 255;
}

function isTerminal(state: RunnerJobState): boolean {
  return state === 'done' || state === 'denied' || state === 'failed' || state === 'cancelled';
}

/** The exact command that cancels a call, for the Ctrl-C message. */
export function cancelCommand(callId: string, flags = ''): string {
  return `factiii-runner cancel ${callId}${flags ? ` ${flags.trim()}` : ''}`;
}

/** Cancel a call through the server: 0 cancelled, 1 already ended, 3 error. */
export async function cancelJob(
  api: Api,
  callId: string,
  io: Pick<JobIo, 'out' | 'err'>
): Promise<number> {
  try {
    const { cancelled } = await api.mutation<{ cancelled: boolean }>(PROCEDURES.cancel, { callId });
    return reportCancel(cancelled, callId, io);
  } catch (err) {
    if (isNewAddress(err)) throw err;
    io.err(`Could not cancel ${callId}: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.failedToStart;
  }
}

export function reportCancel(cancelled: boolean, callId: string, io: Pick<JobIo, 'out'>): number {
  io.out(cancelled ? `Cancelled ${callId}.\n` : `Nothing to cancel: ${callId} already ended.\n`);
  return cancelled ? 0 : EXIT.nothingToCancel;
}

/** Parse repeated `--param k=v` flags. */
export function parseParams(pairs: string[]): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new Error(`--param needs key=value, got "${pair}".`);
    params[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return params;
}

export async function listJobs(
  api: Api,
  spaceSlug: string,
  runnerId: number,
  io: Pick<JobIo, 'out'>
): Promise<number> {
  const { jobs } = await api.query<{ jobs: RunnerJobInfo[] }>(PROCEDURES.list, {
    spaceSlug,
    runnerId
  });
  printJobs(jobs, describeSpace(spaceSlug), io);
  return 0;
}

/** One line per runner open to the caller: its id, its name, whose it is and
 *  whether it is connected. The id or the name is what `--runner` takes. */
export function printRunners(runners: OpenRunner[], where: string, io: Pick<JobIo, 'out'>): void {
  if (!runners.length) {
    io.out(`No runner is open to you on ${where}.\n`);
    return;
  }
  const idWidth = Math.max(...runners.map((r) => String(r.runnerId).length));
  const nameWidth = Math.max(...runners.map((r) => r.name.length));
  for (const r of runners) {
    io.out(
      `${String(r.runnerId).padEnd(idWidth)}  ${r.name.padEnd(nameWidth)}  ${
        r.owned ? 'yours ' : 'shared'
      }  ${r.online ? 'online' : 'offline'}\n`
    );
  }
}

/** One line per job, then its secret names and params. */
export function printJobs(jobs: RunnerJobInfo[], where: string, io: Pick<JobIo, 'out'>): void {
  if (!jobs.length) {
    io.out(`No jobs on the runner for ${where}.\n`);
    return;
  }
  const width = Math.max(...jobs.map((j) => j.name.length));
  for (const job of jobs) {
    io.out(`${job.name.padEnd(width)}  ${job.description}\n`);
    const needs = [...job.keys, ...job.files.map((f) => `file:${f}`)];
    if (needs.length) io.out(`${' '.repeat(width)}  secrets: ${needs.join(', ')}\n`);
    const params = Object.keys(job.params);
    if (params.length) {
      io.out(`${' '.repeat(width)}  params: ${params.map((p) => `--param ${p}=...`).join(' ')}\n`);
    }
  }
}

/** Call a job, stream its log in order, and return the exit code. */
export async function runJob(
  api: Api,
  args: {
    spaceSlug: string;
    runnerId: number;
    job: string;
    params: Record<string, string>;
    /** Flags for the printed cancel command (a non-default --server). */
    cancelFlags?: string;
  },
  io: JobIo
): Promise<number> {
  let callId: string;
  let startState: string | undefined;
  try {
    ({ callId, state: startState } = await api.mutation<{
      callId: string;
      state?: string;
    }>(PROCEDURES.call, {
      spaceSlug: args.spaceSlug,
      runnerId: args.runnerId,
      job: args.job,
      params: args.params
    }));
  } catch (err) {
    // A dead login and a new address are the caller's to handle (index.ts
    // re-logs or confirms the address and calls again), not a failed start.
    if (err instanceof ApiError && err.code === 'UNAUTHORIZED') throw err;
    if (isNewAddress(err)) throw err;
    io.err(`Could not start ${args.job}: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.failedToStart;
  }

  // `cancel` needs this id, so say it before anything else happens.
  io.err(`call ${callId}\n`);
  if (startState === 'unknown') {
    // The server never heard back, so the job may be running. Follow it;
    // calling again could start it twice.
    io.err(
      'The runner did not confirm the start. Following its reports - do not call the job again.\n'
    );
  }
  const cancel = cancelCommand(callId, args.cancelFlags);
  const stopHint = (): string => `To stop it: ${cancel}\n`;

  let interrupted = false;
  const removeInterrupt = io.onInterrupt(() => {
    interrupted = true;
  });

  try {
    // The server numbers chunks from 0 and returns those after afterSeq.
    let afterSeq = -1;
    let lastState: RunnerJobState | null = null;
    // Still held for the runner owner's approval of a dangerous job call.
    let ownerWait = false;
    let failures = 0;

    for (;;) {
      if (interrupted) break;
      let status: JobStatus;
      try {
        status = await api.query<JobStatus>(PROCEDURES.status, { callId, afterSeq });
        failures = 0;
      } catch (err) {
        if (err instanceof ApiError && err.code === 'UNAUTHORIZED') throw err;
        failures += 1;
        if (failures >= MAX_POLL_FAILURES) {
          io.err(
            `\nLost contact with the server. The job keeps running on the runner.\n${stopHint()}`
          );
          return EXIT.usage;
        }
        await io.sleep(POLL_MS);
        continue;
      }

      // The server returns chunks after afterSeq; sort and de-duplicate
      // anyway, so a retried poll never prints a line twice or out of order.
      const fresh = status.chunks
        .filter((c) => c.seq > afterSeq)
        .sort((a, b) => a.seq - b.seq);
      for (const chunk of fresh) {
        if (chunk.seq <= afterSeq) continue;
        io.out(chunk.text);
        afterSeq = chunk.seq;
      }

      if (status.state !== lastState) {
        if (leftOwnerApproved(lastState, status.state)) {
          io.err('approved by the runner owner\n');
        }
        // Kept through the end, so a denial can say whose it was.
        if (!isTerminal(status.state)) {
          ownerWait = status.state === 'waiting-owner';
        }
        if (status.state === 'waiting-owner') {
          io.err(
            `\n${args.job} is a dangerous job: waiting for the runner owner to approve this call (up to 10 minutes)\n`
          );
        } else if (status.state === 'waiting-auth') {
          io.err('\nwaiting for approval on your phone\n');
        } else if (leftGateApproved(lastState, status.state)) {
          io.err('approved\n');
        }
        lastState = status.state;
      }

      if (isTerminal(status.state)) {
        const code = exitCodeFor(status);
        if (status.state === 'denied') {
          io.err(
            ownerWait
              ? `\n${args.job}: not approved by the runner owner (denied, or no answer within 10 minutes)\n`
              : `\n${args.job}: denied by an approver\n`
          );
        }
        if (status.state === 'failed' && !ranWithCode(status)) {
          io.err(`\n${args.job}: failed to start\n`);
        }
        if (status.state === 'cancelled') io.err('\ncancelled\n');
        return code;
      }
      await io.sleep(POLL_MS);
    }

    io.err(
      `\nStopped watching. The job keeps running on the runner.\n${stopHint()}`
    );
    return EXIT.interrupted;
  } finally {
    removeInterrupt();
  }
}
