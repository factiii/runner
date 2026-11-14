import fs from 'fs';
import os from 'os';
import path from 'path';

// Whether this machine's runner is connected to its server, as the daemon
// itself last said (`<runner dir>/online.json`, written on every connect and
// disconnect). Factiii Desktop's "Runner online" step reads it, so it never
// reads the runner's log text (.specs/runner-setup.md, "Set up this
// computer"). The file names the daemon's pid: a file left by a runner that
// died reads as offline once that pid is gone, and one written before the
// machine last started reads as offline whatever that pid is now.

export const RUNNER_ONLINE_FILE = 'online.json';

export type RunnerOnline = {
  pid: number;
  online: boolean;
  /** When it last changed (ISO). */
  at: string;
  runnerName: string;
};

export function parseRunnerOnline(raw: string): RunnerOnline | null {
  try {
    const parsed = JSON.parse(raw) as Partial<RunnerOnline>;
    if (
      typeof parsed.pid !== 'number' ||
      !Number.isSafeInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.online !== 'boolean' ||
      typeof parsed.at !== 'string' ||
      typeof parsed.runnerName !== 'string'
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      online: parsed.online,
      at: parsed.at,
      runnerName: parsed.runnerName
    };
  } catch {
    return null;
  }
}

/** The daemon's side: one small file, replaced whole (a reader never sees
 *  half of it). Never throws: a runner that cannot write it still runs. */
export function writeRunnerOnline(
  runnerDir: string,
  state: Omit<RunnerOnline, 'at'>,
  now: Date = new Date()
): void {
  const file = path.join(runnerDir, RUNNER_ONLINE_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(
      tmp,
      `${JSON.stringify({ ...state, at: now.toISOString() })}\n`,
      { mode: 0o600 }
    );
    fs.renameSync(tmp, file);
  } catch {
    fs.rmSync(tmp, { force: true });
  }
}

/** Whether `pid` is a live process this user may signal. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: alive, someone else's.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** When this machine last started (ms since epoch). */
export const bootedAt = (): number => Date.now() - os.uptime() * 1000;

/** Room for the clock being set just after boot (NTP), and for rounding. */
const BOOT_SLACK_MS = 60_000;

/** The runner as the file says, with a dead pid read as not running. A file
 *  written before this machine last started is a runner from before the
 *  restart, whatever its pid is now: after a reboot that pid can be any
 *  process (a root one answers EPERM, which reads as alive). */
export function readRunnerOnline(
  runnerDir: string,
  alive: (pid: number) => boolean = pidAlive,
  bootTime: number = bootedAt()
): { running: boolean; online: boolean; runnerName: string | null } {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(runnerDir, RUNNER_ONLINE_FILE), 'utf-8');
  } catch {
    return { running: false, online: false, runnerName: null };
  }
  const state = parseRunnerOnline(raw);
  const writtenAt = state ? Date.parse(state.at) : Number.NaN;
  if (
    !state ||
    // An unreadable time is no proof the runner is from this boot.
    Number.isNaN(writtenAt) ||
    writtenAt < bootTime - BOOT_SLACK_MS ||
    !alive(state.pid)
  ) {
    return { running: false, online: false, runnerName: null };
  }
  return { running: true, online: state.online, runnerName: state.runnerName };
}
