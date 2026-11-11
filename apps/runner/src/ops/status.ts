import fs from 'node:fs';

import { opsClient } from './client';
import { readBoardToken } from './serve';
import { OPS_SERVICE_LABEL } from './servers';
import { opsRunPaths, readOpsSettings } from './settings';
import { servicePidFile } from './updaterMac';

// `factiii-runner ops status` as data (.specs/ops-user.md, "Owner commands").
// The text form prints it; `--json` hands it to Factiii Desktop, which shows
// "Repair this computer" when `healthy` is false and "Remove old copies"
// once every moved board has had a job end well on the ops half.

export type OpsBoardStatus = {
  slug: string;
  /** The ops service minted a token for it: it serves this board. */
  served: boolean;
  answers: boolean;
  unlocked: boolean;
  promptWaiting: boolean;
  /** A job ended with exit 0 on the ops half (its audit log). */
  jobSucceeded: boolean;
  error: string | null;
};

export type OpsStatusReport = {
  enabled: boolean;
  runDir: string;
  daemonInstalled: boolean;
  socket: boolean;
  /** The pid `ops serve` wrote is a live process (another user's: a
   *  signal 0 answers EPERM, which is alive). */
  serviceAlive: boolean;
  boards: OpsBoardStatus[];
  /** The service runs, its socket is there, and every board it serves
   *  answers. With no board yet, the first two are all there is to check. */
  healthy: boolean;
};

/** Whether `pid` (from the run dir's pid file) is a running process. */
export function pidAlive(file: string, kill: (pid: number) => void = (pid) => process.kill(pid, 0)): boolean {
  let pid: number;
  try {
    pid = Number(fs.readFileSync(file, 'utf-8').trim());
  } catch {
    return false;
  }
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    kill(pid);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export const OPS_DAEMON_PLIST = `/Library/LaunchDaemons/${OPS_SERVICE_LABEL}.plist`;

type ClientFor = (slug: string, token: string) => Pick<ReturnType<typeof opsClient>, 'call'>;

export async function opsStatusReport(opts: {
  configDir: string;
  slugs: string[];
  /** For tests: the socket client per board. */
  clientFor?: ClientFor;
  exists?: (file: string) => boolean;
  alive?: (pidFile: string) => boolean;
}): Promise<OpsStatusReport> {
  const settings = readOpsSettings(opts.configDir);
  const run = opsRunPaths(settings.runDir);
  const exists = opts.exists ?? fs.existsSync;
  const clientFor: ClientFor =
    opts.clientFor ??
    ((slug, token) =>
      opsClient({ socketPath: run.socket, peerDir: run.peerDir, board: slug, token: () => token, timeoutMs: 10_000 }));
  const socket = exists(run.socket);
  const boards = await Promise.all(
    opts.slugs.map(async (slug): Promise<OpsBoardStatus> => {
      const token = readBoardToken(settings.runDir, slug);
      const base = { slug, served: token !== '', answers: false, unlocked: false, promptWaiting: false, jobSucceeded: false, error: null };
      if (!token) return base;
      try {
        const client = clientFor(slug, token);
        const gate = await client.call('gate-state');
        const audit = await client.call('audit-read', { limit: 200 }).catch(() => ({ entries: [] }));
        const entries = Array.isArray(audit.entries) ? (audit.entries as unknown[]) : [];
        return {
          ...base,
          answers: true,
          unlocked: Boolean(gate.unlocked),
          promptWaiting: Boolean(gate.pending),
          jobSucceeded: entries.some(isGoodJobEnd)
        };
      } catch (err) {
        return { ...base, error: err instanceof Error ? err.message : String(err) };
      }
    })
  );
  const served = boards.filter((b) => b.served);
  const serviceAlive = (opts.alive ?? pidAlive)(servicePidFile(settings.runDir));
  return {
    enabled: settings.enabled,
    runDir: settings.runDir,
    daemonInstalled: exists(OPS_DAEMON_PLIST),
    socket,
    serviceAlive,
    boards,
    healthy: socket && serviceAlive && served.every((b) => b.answers)
  };
}

function isGoodJobEnd(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as { action?: unknown; exitCode?: unknown; detail?: unknown };
  return e.action === 'job-end' && e.exitCode === 0 && e.detail === 'done';
}

export function printOpsStatus(report: OpsStatusReport, out: (line: string) => void = console.log): void {
  out(`Setting: ${report.enabled ? 'ON' : 'off'} (run dir ${report.runDir})`);
  out(`Service: ${report.daemonInstalled ? OPS_DAEMON_PLIST : 'not installed'}`);
  out(`Socket: ${report.socket ? opsRunPaths(report.runDir).socket : 'none'}${report.serviceAlive ? '' : ' (the service is not running)'}`);
  for (const b of report.boards) {
    if (!b.served) out(`  ${b.slug}: no token (not served by the ops user)`);
    else if (!b.answers) out(`  ${b.slug}: ${b.error ?? 'does not answer'}`);
    else
      out(
        `  ${b.slug}: answers, ${b.unlocked ? 'unlocked' : 'locked'}${b.promptWaiting ? ', a prompt is waiting' : ''}${b.jobSucceeded ? ', a job has run' : ''}`
      );
  }
  out(`Healthy: ${report.healthy ? 'yes' : 'no'}`);
}
