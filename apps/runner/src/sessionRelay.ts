import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  type RelayRunner,
  type RunnerOffers,
  SESSION_FILES_MAX_BYTES,
  SESSION_FILES_MAX_BYTES_CEILING,
  type SessionRelayAnswer
} from '@shared/all/domains/sessionRelay';
import { RUNNER_VAULT_BACKUP_DIR } from '@shared/all/helpers/runnerVaultBackup';
import type {
  HypervisorHost,
  HypervisorRemote
} from '@shared/all/helpers/board-agent-core/session-hypervisor';
import type {
  RunnerSessionsReport,
  SessionRelayRequest
} from '@shared/all/validators';

import { isVaultSealedFile } from './secureFile';

// This runner's side of sessions across runners (.specs/card-sessions.md
// "Across runners"): what it reports to the server's session directory, the
// relay its hypervisor tools reach other runners through, and what it
// offers. Everything goes over the socket the runner already holds to the
// server: no port, no connection to another runner. The calls the server
// carries in (`runner:session-op`) are answered by answerSessionOp
// (session-hypervisor.ts), wired in daemon.ts.

/** How often the directory report is looked at; sent only when it changed. */
export const SESSIONS_REPORT_MS = 10_000;
/** How long a relayed call may take: a start waits for the session to
 *  exist, and a read for its transcript and git state. */
export const RELAY_ACK_TIMEOUT_MS = 60_000;

/** The relay over `emit` (the socket's `runner:session-relay`, acked). Each
 *  refusal comes back as the thrown message, for the tool's answer. */
export function createRelayRemote(
  emit: (req: SessionRelayRequest) => Promise<SessionRelayAnswer>
): HypervisorRemote {
  const ask = async <K extends string>(
    req: SessionRelayRequest,
    key: K
  ): Promise<Record<K, unknown> & Record<string, unknown>> => {
    const res = (await emit(req)) as Record<string, unknown>;
    if (typeof res?.error === 'string') throw new Error(res.error);
    if (!res || !(key in res)) {
      throw new Error('The server gave no answer this runner understands.');
    }
    return res as Record<K, unknown> & Record<string, unknown>;
  };
  return {
    runners: async (origin) =>
      (await ask({ op: 'runners', ...origin }, 'runners'))
        .runners as RelayRunner[],
    sessions: async (origin, board) => {
      const res = await ask(
        { op: 'sessions', ...(board ? { board } : {}), ...origin },
        'sessions'
      );
      return res as unknown as Awaited<ReturnType<HypervisorRemote['sessions']>>;
    },
    read: async (origin, target) =>
      (await ask({ op: 'read', ...target, ...origin }, 'read')) as unknown as Awaited<
        ReturnType<HypervisorRemote['read']>
      >,
    message: async (origin, target) =>
      (await ask({ op: 'message', ...target, ...origin }, 'messageId')) as unknown as Awaited<
        ReturnType<HypervisorRemote['message']>
      >,
    start: async (origin, target) =>
      (await ask({ op: 'start', ...target, ...origin }, 'sessionId')) as unknown as Awaited<
        ReturnType<HypervisorRemote['start']>
      >,
    file: async (origin, target) =>
      (await ask(
        { op: 'file', ...target, ...origin },
        target.part === 'info' ? 'file' : 'chunk'
      )) as unknown as Awaited<ReturnType<NonNullable<HypervisorRemote['file']>>>
  };
}

const MB = 1024 * 1024;
/** A Vault envelope is a small JSON file: anything bigger is not one, and is
 *  not read whole to find out on every chunk. */
const ENVELOPE_MAX_BYTES = MB;

/** Whether a file is still sealed by the Vault (secureFile.ts). */
function sealedByVault(realPath: string): boolean {
  try {
    if (fs.statSync(realPath).size > ENVELOPE_MAX_BYTES) return false;
  } catch {
    return true;
  }
  return isVaultSealedFile(realPath);
}

/** Files between sessions on this runner (session-files.ts): the cap per
 *  call, FACTIII_SESSION_FILES_MAX_MB when set (never over the ceiling), and
 *  the folders nothing is ever sent from: the Vault's (`parts/vault`) and
 *  the phone vault's backups. A Vault-sealed file anywhere is refused too
 *  (`isVaultFile`, the daemon's secureFile check). */
export function sessionFilesConfig(
  runnerDir: string,
  env: NodeJS.ProcessEnv = process.env
): NonNullable<HypervisorHost['files']> {
  const mb = Number(env.FACTIII_SESSION_FILES_MAX_MB);
  const maxBytes =
    Number.isFinite(mb) && mb > 0
      ? Math.min(Math.floor(mb * MB), SESSION_FILES_MAX_BYTES_CEILING)
      : SESSION_FILES_MAX_BYTES;
  return {
    maxBytes,
    forbidden: [
      path.join(runnerDir, 'parts', 'vault'),
      path.join(runnerDir, RUNNER_VAULT_BACKUP_DIR)
    ],
    isVaultFile: sealedByVault
  };
}

/** What the directory gets: every board's sessions, what this runner
 *  offers, the owner's setting, and where work is running. Titles only,
 *  never a transcript. */
export function sessionsReport(
  host: HypervisorHost,
  offers: RunnerOffers,
  allowRemoteStarts: boolean,
  /** The boards of the Activity's running work (null: runner-wide). Names
   *  only where it runs, never what. */
  running: { board: string | null }[] = []
): RunnerSessionsReport {
  const boards = new Set<string>();
  for (const job of running) if (job.board !== null) boards.add(job.board);
  return {
    busy: {
      boards: [...boards].sort().slice(0, 200),
      runnerWide: running.some((job) => job.board === null)
    },
    boards: host.boards().map((spaceSlug) => ({
      spaceSlug,
      sessions: (host.board(spaceSlug)?.sessions() ?? []).map((s) => ({
        id: s.id,
        title: s.title.slice(0, 200),
        state: s.state,
        mode: s.mode,
        card: s.cardId
      }))
    })),
    offers,
    allowRemoteStarts
  };
}

/** Send the report on a timer when it changed, and at once on `now()` (a
 *  connect, the setting turned on or off). `reset()` on a disconnect: the
 *  next connection knows nothing, so the next look sends it whatever it
 *  was, even when the drop was shorter than one look. */
export function createSessionsReporter(opts: {
  report: () => RunnerSessionsReport;
  send: (report: RunnerSessionsReport) => void;
  connected: () => boolean;
  intervalMs?: number;
}): { now: () => void; reset: () => void; stop: () => void } {
  let last = '';
  const tick = (force: boolean) => {
    if (!opts.connected()) {
      // A reconnect starts a new connection, which knows nothing yet.
      last = '';
      return;
    }
    let report: RunnerSessionsReport;
    try {
      report = opts.report();
    } catch {
      return;
    }
    const text = JSON.stringify(report);
    if (!force && text === last) return;
    last = text;
    opts.send(report);
  };
  const timer = setInterval(() => tick(false), opts.intervalMs ?? SESSIONS_REPORT_MS);
  timer.unref?.();
  return {
    now: () => tick(true),
    reset: () => {
      last = '';
    },
    stop: () => clearInterval(timer)
  };
}

/** Whether `cmd` is on PATH. */
const onPath = (cmd: string): Promise<boolean> =>
  new Promise((resolve) => {
    execFile('sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', cmd], (err) => resolve(!err));
  });

/** What list_runners says this runner offers, probed once at start. `has`
 *  is the PATH check (a test passes its own). */
export async function probeRunnerOffers(
  has: (cmd: string) => Promise<boolean> = onPath,
  platform: NodeJS.Platform = process.platform,
  arch: string = os.arch()
): Promise<RunnerOffers> {
  const mac = platform === 'darwin';
  const [tart, xcrun, nvidia] = await Promise.all([
    has('tart'),
    mac ? has('xcrun') : Promise.resolve(false),
    has('nvidia-smi')
  ]);
  return {
    os: `${platform} ${arch}`,
    tart,
    simulator: mac && xcrun,
    // Apple silicon's GPU is every arm64 Mac's.
    gpu: (mac && arch === 'arm64') || nvidia
  };
}
