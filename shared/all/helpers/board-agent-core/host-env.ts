import { type ChildProcess, spawn } from 'child_process';
import os from 'os';
import path from 'path';

import { runnerDir } from './runner-dir';

// The daemon's env is frozen at launch but the machine's isn't, so host
// execs resolve PATH at spawn time. stdin is always closed so shell-init
// prompts hit EOF instead of hanging a headless runner.

const isWindows = process.platform === 'win32';

/** Where this runner npm-installs the agent CLIs. npm's own global prefix on a
 *  system Node is /usr/local, which is root-owned, so `npm install -g` there
 *  dies with EACCES on an unprivileged runner. This dir is always the user's.
 *  Mirrors apps/runner/src/paths.ts CONFIG_DIR; the desktop app uses it too. */
export const NPM_PREFIX = path.join(runnerDir(), 'npm');

// Every host exec runs through a LOGIN shell, and zsh reads .zprofile but
// never .zshrc there. Anything a user put on PATH in .zshrc - nvm, and the
// ~/.local/bin the claude and codex native installers use - is therefore
// invisible, and the toolchain concludes a CLI that is plainly installed is
// missing. These dirs cover that gap.
const EXTRA_BIN_DIRS = [
  path.join(os.homedir(), '.local', 'bin'),
  `${NPM_PREFIX}/bin`
];

/** Factiii Desktop's own tools folder, when it hands the runner one: the
 *  absolute path of a dir of binaries it installed and keeps up to date.
 *  Unset today (no such folder ships yet); this env var is the one hook for
 *  it. Searched before anything else (see toolDirs). */
export const TOOLS_DIR_ENV = 'FACTIII_TOOLS_DIR';

/** Where Homebrew puts its commands: /opt/homebrew on Apple silicon,
 *  /usr/local on an Intel Mac (also the usual home of a hand-installed
 *  binary). On 2026-10-25 mac-mini-m6 crash-looped because Homebrew was
 *  installed but /opt/homebrew/bin was on neither the login shell's PATH nor
 *  the launchd service's, so redis-cli read as missing. */
const HOMEBREW_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

/** Where a tool is looked for BEFORE the PATH, in order: Factiii Desktop's
 *  tools folder (TOOLS_DIR_ENV) when one is set, then Homebrew's dirs. Every
 *  host exec gets them (withAddedBinDirs), so the toolchain's probes and the
 *  spawns that follow resolve a tool the same way, whatever PATH the login
 *  shell or the service manager handed over. None on Windows. */
export function toolDirs(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string[] {
  if (platform === 'win32') return [];
  const desktop = env[TOOLS_DIR_ENV]?.trim();
  const dirs = desktop && path.posix.isAbsolute(desktop) ? [desktop] : [];
  return [...dirs, ...HOMEBREW_BIN_DIRS];
}

/** Append toolDirs to this process's own PATH, for the spawns that read
 *  process.env directly rather than a login shell's PATH. Appended, never put
 *  first: the service puts its own node's dir first so a self-update runs the
 *  npm that installed the runner (service.ts servicePath), and that must hold.
 *  Not recorded for withAddedBinDirs, which puts these dirs first itself. */
export function addToolDirs(): void {
  const current = (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean);
  const missing = toolDirs().filter((dir) => !current.includes(dir));
  if (!missing.length) return;
  process.env.PATH = [...current, ...missing].join(path.delimiter);
  invalidatePathCache();
}

// Every dir addBinDirs was handed, so execLogin can put them back once the
// profile has run (see withAddedBinDirs).
const addedBinDirs: string[] = [];

/** Append `dirs` to this process's own PATH. Every host exec either reads
 *  process.env directly or starts a login shell that inherits it (macOS
 *  path_helper keeps inherited entries; where the profile does not, execLogin
 *  re-adds them), so one mutation reaches all of them.
 *  Idempotent, and safe before a dir exists - PATH ignores missing entries. */
export function addBinDirs(dirs: string[]): void {
  for (const dir of dirs) {
    if (dir && !addedBinDirs.includes(dir)) addedBinDirs.push(dir);
  }
  const current = (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean);
  const missing = dirs.filter((dir) => dir && !current.includes(dir));
  if (!missing.length) return;
  process.env.PATH = [...current, ...missing].join(path.delimiter);
  invalidatePathCache();
}

/** Fold the dirs above into PATH, and toolDirs behind them. */
export function ensureExtraBinDirs(): void {
  addBinDirs(EXTRA_BIN_DIRS);
  addToolDirs();
}

/** Prefix `command` so the dirs above are on PATH AFTER the profile has run.
 *  Inheriting them is not enough: Debian's /etc/profile assigns PATH outright,
 *  which drops everything this process added, and a CLI npm just installed
 *  under NPM_PREFIX then reads as missing. Ubuntu and macOS keep inherited
 *  entries, so there this only repeats them.
 *  toolDirs go in front of the profile's PATH and the added dirs behind it,
 *  which is the lookup order: Desktop's tools, Homebrew, then the PATH. */
function withAddedBinDirs(command: string): string {
  const quote = (dirs: string[]) =>
    dirs.map((dir) => `'${dir.replace(/'/g, `'\\''`)}'`).join(path.delimiter);
  const first = toolDirs();
  if (!first.length && !addedBinDirs.length) return command;
  const before = first.length ? `${quote(first)}${path.delimiter}` : '';
  const after = addedBinDirs.length
    ? `${path.delimiter}${quote(addedBinDirs)}`
    : '';
  return `export PATH=${before}"$PATH"${after}; ${command}`;
}

export type LoginExecResult = { code: number; output: string };

/** Kill a host process and everything it started. Host spawns are `detached`
 *  so the child leads its own group and a negative pid reaps the tree. Never
 *  call proc.kill directly: nothing else reaps orphans on a host. */
export function killTree(
  proc: ChildProcess,
  signal: NodeJS.Signals = 'SIGKILL'
): void {
  const pid = proc.pid;
  if (pid === undefined) return;
  if (isWindows) {
    // Windows has no signalable process groups; taskkill /T walks the tree.
    // A missing taskkill is an 'error' event, not a throw, and one nobody
    // hears kills the runner; it falls back to the direct kill as below.
    const directKill = () => {
      try {
        proc.kill(signal);
      } catch {
        // already exited
      }
    };
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore'
      }).on('error', directKill);
    } catch {
      // taskkill missing is not recoverable here; the direct kill is the only
      // remaining option.
      directKill();
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // No group (child already reaped, or spawn failed before the fork):
    // fall back to the direct child.
    try {
      proc.kill(signal);
    } catch {
      // already exited
    }
  }
}

/** Run a command line the way a fresh terminal of this user would, stdin
 *  closed, output capped, time-boxed. Resolves (never rejects) with exit
 *  code + combined output. */
export function execLogin(
  command: string,
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    /** Absolute ceiling. With `idleTimeout` set this is the backstop, not the
     *  normal reaper: a long build that keeps printing should die of silence,
     *  never of duration. */
    timeout: number;
    /** Kill after this long with no output at all. Optional: without it, only
     *  `timeout` applies. */
    idleTimeout?: number;
    maxBuffer?: number;
    /** Fired per chunk with the capped output so far, for live step logs. */
    onOutput?: (combined: string) => void;
    /** Fired per chunk with just that chunk, for a caller that forwards a
     *  stream (a shared runner's job log) rather than re-reading the whole. */
    onChunk?: (text: string) => void;
    /** Hands over the child once spawned, for a caller that must kill it (a
     *  job cancelled by the space going down). */
    onSpawn?: (proc: ChildProcess) => void;
  }
): Promise<LoginExecResult> {
  const [bin, args] = isWindows
    ? ['bash', ['-c', command]]
    : [process.env.SHELL || '/bin/bash', ['-lc', withAddedBinDirs(command)]];
  const cap = opts.maxBuffer ?? 4 * 1024 * 1024;

  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    // Declared before `done` because a synchronous `spawn` throw (macOS raises
    // `E2BIG` right here when the command line is past ARG_MAX) calls `done`
    // before the timer is armed. As a `const` below, that read was a TDZ
    // ReferenceError that replaced the real spawn error with
    // "Cannot access 'timer' before initialization".
    let timer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const done = (code: number, extra = '') => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      resolve({ code, output: (output + extra).slice(-cap) });
    };

    let proc;
    try {
      proc = spawn(bin, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group so the timeout below can reap the whole tree.
        // Not unref'd: the parent still holds the pipes and waits for close.
        detached: true
      });
    } catch (err) {
      done(-1, err instanceof Error ? err.message : String(err));
      return;
    }
    timer = setTimeout(() => {
      killTree(proc);
      done(-1, `\n[timed out after ${Math.round(opts.timeout / 1000)}s]`);
    }, opts.timeout);
    // A process that is still printing is still working. Restart the idle
    // window on every chunk so a long build is reaped for going quiet, not for
    // taking its time.
    const idleMs = opts.idleTimeout;
    const bumpIdle = () => {
      if (!idleMs) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        killTree(proc);
        const secs = Math.round(idleMs / 1000);
        done(-1, `\n[no output for ${secs}s - timed out]`);
      }, idleMs);
    };
    bumpIdle();

    // Trim only once the buffer is well past the cap, not on every chunk: a
    // long installer log would otherwise re-copy `cap` bytes per chunk.
    opts.onSpawn?.(proc);
    const collect = (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      output += text;
      opts.onChunk?.(text);
      if (output.length > cap * 2) output = output.slice(-cap);
      bumpIdle();
      opts.onOutput?.(output);
    };
    proc.stdout.on('data', collect);
    proc.stderr.on('data', collect);
    proc.on('error', (err) => done(-1, `\n${err.message}`));
    proc.on('close', (code) => done(code ?? -1));
  });
}

// Reading PATH costs a login shell, and every host spawn wants it. The machine's
// PATH only changes when something is installed, so cache it and let the
// installer invalidate (see toolchain.ts).
let cachedPath: Promise<string> | null = null;

/** Drop the cached PATH. Call after installing anything that adds a binary. */
export function invalidatePathCache(): void {
  cachedPath = null;
}

export function freshPath(): Promise<string> {
  cachedPath ??= readLoginPath().catch((err: unknown) => {
    cachedPath = null;
    throw err;
  });
  return cachedPath;
}

async function readLoginPath(): Promise<string> {
  // Windows PATH changes land in the registry, not shell init; the process
  // env is the practical truth there.
  if (isWindows) return process.env.PATH || '';
  const { code, output } = await execLogin('printf %s "$PATH"', {
    timeout: 10_000
  });
  // Shell-init noise can precede the PATH; take the last line.
  const last = output.trim().split('\n').pop() || '';
  if (code === 0 && last.includes('/')) return last;
  // No login shell answer: this process's PATH, still searched after the
  // tool dirs, as the login shell's would have been (withAddedBinDirs).
  const rest = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return [...new Set([...toolDirs(), ...rest])].join(path.delimiter);
}

/** process.env with a login-shell-fresh PATH - the base env for host spawns. */
export async function hostEnv(): Promise<NodeJS.ProcessEnv> {
  return { ...process.env, PATH: await freshPath() };
}
