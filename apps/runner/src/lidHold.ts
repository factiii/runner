import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';

import type { RunnerLidHoldState } from '@shared/all/domains/electron';
import {
  lidPmsetArgs,
  parsePmsetTherm,
  SUDO_BIN
} from '@shared/all/helpers/lidGrant';
import {
  LID_AWAKE_FILE,
  parsePmsetSettings
} from '@shared/all/helpers/serverReadiness';

// Lid closed while keep-awake holds (.specs/runner-keep-awake.md "Lid
// closed"). When Automatic or While plugged in takes its hold on a laptop,
// the runner sets `pmset -a disablesleep 1` itself with `sudo -n`, through
// the one grant Factiii Desktop sets up (shared/all/helpers/lidGrant.ts),
// and sets 0 when it lets go. No Desktop round trip, so it works with the
// Wi-Fi gone. `sudo -n` never prompts: with no grant it fails at once, the
// hold is caffeinate only (as before), and Status says "needs setup".
//
// disablesleep is a machine-wide setting that outlives the process, so the
// runner only turns off what it turned on (`owned`), leaves alone one set
// from Factiii Desktop's own Lid closed (`by-hand`), and has watchdogs for
// it outliving its reason:
// - runner start: on, and not the desktop's own (LID_AWAKE_FILE), and no
//   hold of ours: off (`startup`).
// - runner exit: off, synchronously (`releaseNow`), from the daemon's
//   SIGINT/SIGTERM/update cleanup.
// - runner killed or crashed: a detached watcher shell, started at the
//   first take, waits on the runner's pid and then sets 0 if the marker
//   file still names that pid (`lidWatchScript`).
// - battery low, Mac hot: KeepAwake asks for it off (`blocked`).

/** Runs a command; never throws. */
export type LidExec = (
  bin: string,
  args: string[]
) => Promise<{ code: number; output: string }>;

/** Starts the dead-man watcher; detached, so it outlives this process. */
export type LidSpawnWatch = (script: string) => void;

/** With no grant, how long before `sudo -n` is tried again: each refusal
 *  is a line in the system's auth log. */
export const NO_GRANT_RETRY_MS = 5 * 60_000;
/** The watcher's look at the runner's pid, in seconds. */
const WATCH_EVERY_S = 10;

const realExec: LidExec = (bin, args) =>
  new Promise((resolve) => {
    execFile(
      bin,
      args,
      { encoding: 'utf-8', timeout: 10_000 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, output: `${stdout ?? ''}${stderr ?? ''}` });
      }
    );
  });

const realSpawnWatch: LidSpawnWatch = (script) => {
  const child = spawn('/bin/sh', ['-c', script], {
    detached: true,
    stdio: 'ignore'
  });
  child.on('error', () => {
    // No watcher: start and exit still turn it off.
  });
  child.unref();
};

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The dead-man: once `pid` is gone, `disablesleep 0` if `marker` still
 *  names it (a runner that let go removed it; a new runner that took it
 *  wrote its own pid). */
export function lidWatchScript(opts: {
  pid: number;
  marker: string;
  sudo?: string;
  everyS?: number;
}): string {
  const sudo = opts.sudo ?? SUDO_BIN;
  const marker = sq(opts.marker);
  const off = lidPmsetArgs(false).join(' ');
  return [
    `while kill -0 ${opts.pid} 2>/dev/null; do sleep ${opts.everyS ?? WATCH_EVERY_S}; done`,
    `[ "$(cat ${marker} 2>/dev/null)" = "${opts.pid}" ] || exit 0`,
    `${sq(sudo)} -n ${off} && rm -f ${marker}`
  ].join('; ');
}

/** Pressure that makes the watchdog let go. */
export type LidBlock = 'low-battery' | 'hot';

export type LidHoldOptions = {
  /** `<runner dir>/lid-hold`: this runner's pid while it holds. */
  marker: string;
  exec?: LidExec;
  spawnWatch?: LidSpawnWatch;
  now?: () => number;
  pid?: number;
  /** The desktop's own Lid closed timer file. */
  lidAwakeFile?: string;
  log?: (line: string) => void;
};

export class LidHold {
  private owned = false;
  private current: RunnerLidHoldState = 'off';
  private noGrantAt: number | null = null;
  private watching = false;
  /** A `disablesleep 1` is on its way and not yet answered. */
  private taking = false;
  /** Every change runs after the last: sudo calls never interleave. */
  private queue: Promise<void> = Promise.resolve();
  private readonly exec: LidExec;
  private readonly spawnWatch: LidSpawnWatch;
  private readonly now: () => number;
  private readonly pid: number;
  private readonly lidAwakeFile: string;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: LidHoldOptions) {
    this.exec = opts.exec ?? realExec;
    this.spawnWatch = opts.spawnWatch ?? realSpawnWatch;
    this.now = opts.now ?? Date.now;
    this.pid = opts.pid ?? process.pid;
    this.lidAwakeFile = opts.lidAwakeFile ?? LID_AWAKE_FILE;
    this.log = opts.log ?? ((line) => console.log(`[keep-awake] ${line}`));
  }

  state(): RunnerLidHoldState {
    return this.current;
  }

  /** disablesleep 1 is ours to turn off. */
  holding(): boolean {
    return this.owned;
  }

  /** Resolves when every change asked for so far has run. */
  settled(): Promise<void> {
    return this.queue;
  }

  /** Runner start: a disablesleep 1 nobody holds goes off. The desktop's
   *  own Lid closed (its file is there) is left as the owner set it. */
  startup(): Promise<void> {
    return this.enqueue(async () => {
      const on = await this.readOn();
      const desktops = fs.existsSync(this.lidAwakeFile);
      if (on && !desktops && !this.owned) {
        const res = await this.pmset(false);
        if (res.code === 0) this.log('Lid closed was left on with nothing holding it: turned it off.');
        else this.log('Lid closed was left on with nothing holding it, and sudo -n refused to turn it off.');
      }
      this.clearMarker();
    });
  }

  /** Bring the lid in line: `want` while keep-awake holds, unless
   *  `blocked`. */
  sync(want: boolean, blocked: LidBlock | null): Promise<void> {
    return this.enqueue(() =>
      want && !blocked ? this.take() : this.release(blocked)
    );
  }

  /** Off now, synchronously: the runner is exiting. A take still waiting on
   *  sudo counts as held: the exit comes before it could mark it ours, and
   *  no watcher would turn it off after. */
  releaseNow(): void {
    if (!this.owned && !this.taking) return;
    try {
      execFileSync(SUDO_BIN, ['-n', ...lidPmsetArgs(false)], {
        stdio: 'ignore',
        timeout: 5000
      });
      this.owned = false;
      this.clearMarker();
    } catch {
      // The watcher turns it off once this process is gone.
    }
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const next = this.queue.then(fn).catch(() => {
      // A step that threw leaves the state as it was; the next sync tries again.
    });
    this.queue = next;
    return next;
  }

  private async take(): Promise<void> {
    if (this.owned) {
      this.current = 'holding';
      return;
    }
    if (this.noGrantAt !== null && this.now() - this.noGrantAt < NO_GRANT_RETRY_MS) {
      this.current = 'needs-setup';
      return;
    }
    if (await this.readOn()) {
      // On already, and not by us: the desktop's Lid closed, or by hand.
      this.current = 'by-hand';
      return;
    }
    this.taking = true;
    const res = await this.pmset(true).finally(() => {
      this.taking = false;
    });
    if (res.code !== 0) {
      if (noGrant(res.output)) {
        if (this.current !== 'needs-setup') {
          this.log('Lid closed needs setup in Factiii Desktop (sudo -n refused); holding with caffeinate only.');
        }
        this.noGrantAt = this.now();
        this.current = 'needs-setup';
      } else {
        this.current = 'failed';
      }
      return;
    }
    this.noGrantAt = null;
    this.owned = true;
    this.current = 'holding';
    this.writeMarker();
    if (!this.watching) {
      this.watching = true;
      this.spawnWatch(lidWatchScript({ pid: this.pid, marker: this.opts.marker }));
    }
  }

  private async release(blocked: LidBlock | null): Promise<void> {
    if (this.owned) {
      const res = await this.pmset(false);
      if (res.code !== 0) {
        // Still on: the next sync tries again.
        this.current = 'failed';
        return;
      }
      this.owned = false;
      this.clearMarker();
      if (blocked) this.log(`Lid closed let go: ${blocked === 'hot' ? 'the Mac is hot' : 'the battery is low'}.`);
    }
    if (blocked) this.current = blocked;
    else if (this.current !== 'needs-setup') this.current = 'off';
  }

  private pmset(on: boolean) {
    return this.exec(SUDO_BIN, ['-n', ...lidPmsetArgs(on)]);
  }

  private async readOn(): Promise<boolean> {
    const res = await this.exec('pmset', ['-g']);
    return res.code === 0 && parsePmsetSettings(res.output).sleepDisabled;
  }

  private writeMarker(): void {
    try {
      fs.writeFileSync(this.opts.marker, String(this.pid), { mode: 0o600 });
    } catch {
      // No marker: the watcher does nothing, and start still turns it off.
    }
  }

  private clearMarker(): void {
    try {
      fs.rmSync(this.opts.marker, { force: true });
    } catch {
      // Gone already.
    }
  }
}

/** sudo's answers when the user has no password-free rule for it. */
const noGrant = (output: string): boolean =>
  /password is required|not allowed to execute|may not run sudo|not in the sudoers/i.test(
    output
  );

/** `pmset -g therm`: is the Mac under thermal pressure (null: unreadable). */
export async function readThermal(exec: LidExec = realExec): Promise<boolean | null> {
  const res = await exec('pmset', ['-g', 'therm']);
  return res.code === 0 ? parsePmsetTherm(res.output) : null;
}
