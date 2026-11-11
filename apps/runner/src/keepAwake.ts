import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';

import type {
  RunnerKeepAwake,
  RunnerKeepAwakeWork
} from '@shared/all/domains/electron';
import type { RunnerSleepSnapshot } from '@shared/all/validators';

import type { LidBlock, LidHold } from './lidHold';

// Keep-awake (Runner Status > Ready to be a server): the runner's own
// `caffeinate`, so the owner can keep this Mac awake from a phone, until a
// time or until turned off. `-i -s`: no idle sleep, and none on power; `-d`
// keeps the screen on too. `-w <runner pid>` ends it with the runner, and
// the state is saved so a restarted runner (an update) takes it back up.
// Windows and Linux hold the same way with their own helper process (see
// holderFor); the lid and `pmset` readings below are the Mac's only.
// Lid closed is beyond caffeinate: that is `pmset disablesleep`, which needs
// an admin. Factiii Desktop sets it by hand (serverReadiness.ts), and sets
// up once the grant that lets the runner follow its own hold (`lid`,
// lidHold.ts): Automatic and While plugged in, on a laptop, set it while
// they hold and clear it when they let go, unless the battery is low
// (LID_LOW_BATTERY) or the Mac is hot.
//
// Automatic: the same hold, taken only while the runner has work (a card or
// terminal AI session working, a job or deploy running) and let go
// AUTO_GRACE_MS after the last of it stops, so the Mac can sleep. It looks
// every AUTO_POLL_MS (`tick`), and takes the hold back when work resumes.
//
// While plugged in: the same hold, taken only while the Mac draws from AC
// power (`pmset -g batt`, read every AUTO_POLL_MS) and let go on battery.
//
// Either one, just before it lets go, calls `onSleep` so the daemon can send
// the server its "going to sleep" frame (the runner then shows Asleep, not
// Offline); a hold taken again after that calls `onWake`.

const OFF: RunnerKeepAwake = { on: false, until: null, display: false };
/** Further out than this is a mistake, not a plan. */
const MAX_AHEAD_MS = 30 * 24 * 3_600_000;
/** Automatic: how long it holds after the last work stops. */
export const AUTO_GRACE_MS = 10 * 60_000;
/** Automatic: how often it looks at the runner's work. Well inside the
 *  grace, and inside any idle-sleep setting worth having. */
export const AUTO_POLL_MS = 30_000;
/** Lid closed: let go on battery below this charge (%). */
export const LID_LOW_BATTERY = 15;
/** ...and take it again only once the charge is this far above it, or on
 *  power, so it does not flap at the line. */
export const LID_BATTERY_HYSTERESIS = 5;

/** `pmset -g therm`: under thermal pressure (null: cannot tell). */
export type ThermalReader = () => Promise<boolean | null>;

/** Starts a keep-awake helper `command` with `args`; `onExit` when it
 *  ends, with the error when it could not start (the binary is missing).
 *  Returns a stop. */
export type SpawnHolder = (
  command: string,
  args: string[],
  onExit: (error?: Error) => void
) => () => void;

/** Starts caffeinate with `args`; `onExit` when it ends. Returns a stop.
 *  The Mac-only form of SpawnHolder, kept for callers that inject it. */
export type Caffeinate = (
  args: string[],
  onExit: (error?: Error) => void
) => () => void;

/** The runner's work right now, for automatic mode: sessions working and
 *  jobs running. The daemon reads its own session summaries and jobs. */
export type WorkReader = () => { sessions: number; jobs: number };

/** Calls `fn` every `ms`; returns a cancel. */
export type Every = (fn: () => void, ms: number) => () => void;

/** The Mac's power: on AC or not (null: cannot tell), and the battery's
 *  charge (null: no battery, or cannot tell). */
export type RunnerPower = NonNullable<RunnerSleepSnapshot['battery']>;

/** Reads the Mac's power. Never throws: what it cannot tell is null. */
export type PowerReader = () => Promise<RunnerPower>;

/** Why keep-awake let go: no work for the grace, or on battery. */
export type SleepReason = RunnerSleepSnapshot['reason'];

/** `pmset -g batt`'s answer: "Now drawing from 'AC Power'" (or 'Battery
 *  Power', or 'UPS Power', which is not the wall), then a line per battery
 *  with its charge. A desktop Mac has no battery line. */
export function parsePmsetBatt(output: string): RunnerPower {
  const source = /drawing from '([^']+)'/.exec(output)?.[1] ?? null;
  const charge = /(\d{1,3})%/.exec(output);
  const percent = charge ? Math.min(100, Number(charge[1])) : null;
  return { ac: source === null ? null : source === 'AC Power', percent };
}

const realPower: PowerReader = () =>
  new Promise((resolve) => {
    execFile(
      'pmset',
      ['-g', 'batt'],
      { encoding: 'utf-8', timeout: 5000 },
      (err, stdout) => {
        resolve(err ? { ac: null, percent: null } : parsePmsetBatt(stdout));
      }
    );
  });

/** One platform's way to hold the machine awake. `seconds` null: until
 *  stopped. Returns a stop; `onExit` when it ends by itself (with the error
 *  when its helper could not start). */
type Holder = (
  spec: { display: boolean; seconds: number | null },
  onExit: (error?: Error) => void
) => () => void;

const realSpawn: SpawnHolder = (command, args, onExit) => {
  const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
  // A missing binary emits 'error' (and maybe 'exit' too): end once.
  let ended = false;
  const end = (error?: Error) => {
    if (ended) return;
    ended = true;
    onExit(error);
  };
  child.on('exit', () => end());
  child.on('error', (error) => end(error));
  return () => {
    if (!ended) child.kill();
  };
};

/** Windows' SetThreadExecutionState flags. */
const ES_CONTINUOUS = 0x80000000;
const ES_SYSTEM_REQUIRED = 0x1;
const ES_DISPLAY_REQUIRED = 0x2;
/** Windows' helper: how often it looks for the runner's pid. */
const WIN_PID_POLL_SECONDS = 5;

/** The PowerShell the Windows helper runs: set the flags on its one thread,
 *  then stay alive until `seconds` pass (null: forever) or `pid` ends. */
export function windowsHoldScript(
  display: boolean,
  seconds: number | null,
  pid: number
): string {
  // Added, not OR'd: JS's `|` is signed, and 0x80000000 would go negative.
  const flags =
    ES_CONTINUOUS + ES_SYSTEM_REQUIRED + (display ? ES_DISPLAY_REQUIRED : 0);
  const until =
    seconds === null
      ? ''
      : `$end = (Get-Date).AddSeconds(${seconds}); `;
  const timeUp = seconds === null ? '' : ' -and (Get-Date) -lt $end';
  return (
    `$k = Add-Type -Name Power -Namespace FactiiiKeepAwake -PassThru ` +
    `-MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'; ` +
    `[void]$k::SetThreadExecutionState([uint32]${flags}); ` +
    until +
    `while ((Get-Process -Id ${pid} -ErrorAction SilentlyContinue)${timeUp}) ` +
    `{ Start-Sleep -Seconds ${WIN_PID_POLL_SECONDS} }`
  );
}

const realEvery: Every = (fn, ms) => {
  const timer = setInterval(fn, ms);
  // Never what keeps the runner's process alive.
  timer.unref();
  return () => clearInterval(timer);
};

/** The holder for this platform, or null where none is built. Each one is
 *  a helper process `spawn` starts and the stop kills; it ends by itself
 *  when its time is up or the runner's pid is gone. The timed and automatic
 *  logic above them is the same.
 *  - darwin: `caffeinate -i -s -w <pid>` (+ `-d` for display, `-t <s>`).
 *  - win32: PowerShell calling kernel32 SetThreadExecutionState
 *    (ES_CONTINUOUS | ES_SYSTEM_REQUIRED, + ES_DISPLAY_REQUIRED for
 *    display), then staying alive (windowsHoldScript), since the flag lives
 *    only as long as the thread that set it.
 *  - linux: `systemd-inhibit --what=idle:sleep --mode=block` around
 *    `tail --pid=<pid> -f /dev/null` (ends with the runner, as `-w`), under
 *    `timeout <s>` when timed. `idle` already covers screen blanking on most
 *    desktops, so display adds nothing. */
function holderFor(
  platform: NodeJS.Platform,
  spawnHolder: SpawnHolder
): Holder | null {
  const pid = process.pid;
  if (platform === 'darwin') {
    return ({ display, seconds }, onExit) => {
      const args = ['-i', '-s', '-w', String(pid)];
      if (display) args.push('-d');
      if (seconds !== null) args.push('-t', String(seconds));
      return spawnHolder('caffeinate', args, onExit);
    };
  }
  if (platform === 'win32') {
    return ({ display, seconds }, onExit) =>
      spawnHolder(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          windowsHoldScript(display, seconds, pid)
        ],
        onExit
      );
  }
  if (platform === 'linux') {
    return ({ seconds }, onExit) => {
      const wait = ['tail', `--pid=${pid}`, '-f', '/dev/null'];
      return spawnHolder(
        'systemd-inhibit',
        [
          '--what=idle:sleep',
          '--mode=block',
          '--who=factiii-runner',
          '--why=Factiii Runner keep-awake',
          ...(seconds === null ? wait : ['timeout', String(seconds), ...wait])
        ],
        onExit
      );
    };
  }
  return null;
}

export type KeepAwakeOptions = {
  /** Starts the platform's helper (caffeinate, powershell, systemd-inhibit).
   *  Tests inject it. */
  spawn?: SpawnHolder;
  /** The older, Mac-only injection: used for caffeinate when `spawn` is
   *  absent. */
  caffeinate?: Caffeinate;
  now?: () => number;
  platform?: NodeJS.Platform;
  /** Automatic mode's work signal. Absent: never any work. */
  work?: WorkReader;
  every?: Every;
  /** The Mac's power, for While plugged in and the sleep snapshot. */
  power?: PowerReader;
  /** Just before automatic or While plugged in lets go. */
  onSleep?: (reason: SleepReason) => void;
  /** A hold taken again after `onSleep`: the Mac did not sleep after all. */
  onWake?: () => void;
  /** Lid closed for Automatic and While plugged in. Absent: caffeinate
   *  only. */
  lid?: LidHold;
  /** Read on each look while the lid is held. */
  thermal?: ThermalReader;
  /** Where it says a helper could not start. Default: console, once. */
  log?: (line: string) => void;
};

export class KeepAwake {
  private stopCurrent: (() => void) | null = null;
  private current: RunnerKeepAwake = OFF;
  private stopTicks: (() => void) | null = null;
  /** Automatic: the last time `tick` saw work (or the hold began). */
  private lastWorkAt = 0;
  /** The last time any look saw work, for the sleep snapshot. */
  private workSeenAt: number | null = null;
  /** The last power reading, or null before the first. */
  private lastPower: RunnerPower | null = null;
  /** `onSleep` was called and no hold was taken since. */
  private sleepSent = false;
  /** Lid closed's watchdog: the battery went below LID_LOW_BATTERY. */
  private batteryLow = false;
  /** Lid closed's watchdog: the last thermal reading said hot. */
  private hot = false;
  private readonly lid: LidHold | null;
  private readonly readThermal: ThermalReader;
  private readonly holder: Holder | null;
  private readonly now: () => number;
  private readonly work: WorkReader;
  private readonly every: Every;
  private readonly readPower: PowerReader;
  private readonly onSleep: (reason: SleepReason) => void;
  private readonly onWake: () => void;
  private readonly log: (line: string) => void;
  /** A helper that could not start is said once, not every tick. */
  private spawnFailSaid = false;

  constructor(
    private file: string,
    options: KeepAwakeOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.work = options.work ?? (() => ({ sessions: 0, jobs: 0 }));
    this.every = options.every ?? realEvery;
    this.readPower = options.power ?? realPower;
    this.onSleep = options.onSleep ?? (() => {});
    this.onWake = options.onWake ?? (() => {});
    this.readThermal = options.thermal ?? (async () => null);
    this.log = options.log ?? ((line) => console.log(`[keep-awake] ${line}`));
    const spawnHolder = options.spawn ?? realSpawn;
    const { caffeinate } = options;
    this.holder = holderFor(
      options.platform ?? process.platform,
      caffeinate && !options.spawn
        ? (command, args, onExit) =>
            command === 'caffeinate'
              ? caffeinate(args, onExit)
              : spawnHolder(command, args, onExit)
        : spawnHolder
    );
    this.lid = this.holder ? (options.lid ?? null) : null;
    // A disablesleep 1 left from a runner that died goes off before the
    // saved hold is taken back up (the lid's changes run in order).
    void this.lid?.startup();
    if (this.holder) this.restore();
  }

  state(): RunnerKeepAwake {
    if (!this.lid || !this.followsLid()) return this.current;
    return { ...this.current, lid: this.lid.state() };
  }

  /** The runner is exiting: lid closed off now (caffeinate ends with it). */
  shutdown(): void {
    this.lid?.releaseNow();
  }

  /** The last power reading, or null before the first. */
  power(): RunnerPower | null {
    return this.lastPower;
  }

  /** The last time a look saw work (ms since epoch), or null for never. */
  lastWork(): number | null {
    return this.workSeenAt;
  }

  set(payload: {
    on: boolean;
    until: number | null;
    display?: boolean;
    auto?: boolean;
    ac?: boolean;
  }): RunnerKeepAwake {
    if (!this.holder) {
      throw new Error('Keep-awake runs on a Mac, Windows or Linux runner.');
    }
    const { until } = payload;
    if (typeof payload.on !== 'boolean') throw new Error('Say on or off.');
    const auto = payload.on && payload.auto === true;
    const ac = payload.on && !auto && payload.ac === true;
    const timed = payload.on && !auto && !ac;
    if (timed && until === undefined) {
      throw new Error('Say until when, or null for until turned off.');
    }
    if (timed && until !== null) {
      if (!Number.isFinite(until) || until <= this.now()) {
        throw new Error('That time has already passed.');
      }
      if (until - this.now() > MAX_AHEAD_MS) {
        throw new Error('Pick a time within the next 30 days.');
      }
    }
    this.stop();
    const display = payload.display === true;
    if (auto) {
      this.startAuto(display, false);
      this.save(this.current);
      return this.state();
    }
    if (ac) {
      this.startPlugged(display);
      this.save(this.current);
      return this.state();
    }
    const next = payload.on ? { on: true, until, display } : OFF;
    if (next.on) this.start(next);
    this.save(next);
    // A timed hold or off: the lid is not followed, so it goes off.
    this.syncLid();
    return this.state();
  }

  /** A fresh power reading, then a tick: what the timer runs. Tests call
   *  it directly. */
  async look(): Promise<void> {
    try {
      this.lastPower = await this.readPower();
    } catch {
      // Unreadable: the last reading stands.
    }
    if (this.lid?.holding()) {
      try {
        this.hot = (await this.readThermal()) === true;
      } catch {
        // Unreadable: as it was.
      }
    } else {
      this.hot = false;
    }
    this.tick();
  }

  /** Automatic: look at the work, and take or let go of the hold. While
   *  plugged in: the same, by the last power reading. The timer calls it
   *  (through `look`) every AUTO_POLL_MS; tests call it directly. */
  tick(): void {
    this.holdTick();
    this.syncLid();
  }

  private holdTick(): void {
    if (this.current.ac) {
      this.plugTick();
      return;
    }
    if (!this.current.auto) return;
    const reading = this.readWork();
    if (!reading) return;
    const { sessions, jobs } = reading;
    const now = this.now();
    if (sessions + jobs > 0) this.lastWorkAt = now;
    const releaseAt = this.lastWorkAt + AUTO_GRACE_MS;
    if (sessions + jobs > 0 && !this.stopCurrent) this.hold(this.current.display);
    if (sessions + jobs === 0 && this.stopCurrent && now >= releaseAt) {
      this.sleep('idle');
      this.letGo();
    }
    const holding = this.stopCurrent !== null;
    this.setWork({
      sessions,
      jobs,
      holding,
      releaseAt: holding && sessions + jobs === 0 ? releaseAt : null
    });
  }

  /** The work now, noting when any was last seen. Runs off a timer: a throw
   *  here would be uncaught in the daemon, so a reading that fails is null
   *  and leaves the hold as it is until the next one. */
  private readWork(): { sessions: number; jobs: number } | null {
    try {
      const reading = this.work();
      if (reading.sessions + reading.jobs > 0) this.workSeenAt = this.now();
      return reading;
    } catch {
      return null;
    }
  }

  /** While plugged in: hold on AC, let go on battery. Power it cannot read
   *  (`ac` null) holds: a desktop Mac is always on AC, and caffeinate's `-s`
   *  is honoured on AC only anyway. Before the first reading, nothing. */
  private plugTick(): void {
    this.readWork();
    if (!this.lastPower) return;
    const onAc = this.lastPower.ac !== false;
    if (onAc && !this.stopCurrent) this.hold(this.current.display);
    if (!onAc && this.stopCurrent) {
      this.sleep('battery');
      this.letGo();
    }
    this.current = {
      ...this.current,
      plugged: { ac: this.lastPower.ac, holding: this.stopCurrent !== null }
    };
  }

  /** Automatic or While plugged in, on a laptop (a battery reading): the
   *  modes the lid follows. A desktop Mac has no lid, and caffeinate holds
   *  it on power. */
  private followsLid(): boolean {
    const laptop = this.lastPower !== null && this.lastPower.percent !== null;
    return laptop && (this.current.auto === true || this.current.ac === true);
  }

  /** The watchdog's reason to let the lid go, if any. */
  private lidBlock(): LidBlock | null {
    const power = this.lastPower;
    if (power?.ac === false && power.percent !== null) {
      if (power.percent < LID_LOW_BATTERY) this.batteryLow = true;
      if (power.percent >= LID_LOW_BATTERY + LID_BATTERY_HYSTERESIS) {
        this.batteryLow = false;
      }
    } else {
      this.batteryLow = false;
    }
    if (this.batteryLow) return 'low-battery';
    return this.hot ? 'hot' : null;
  }

  /** Lid closed follows the hold: on while Automatic or While plugged in
   *  holds, off when it lets go or the mode ends. */
  private syncLid(): void {
    if (!this.lid) return;
    const want = this.followsLid() && this.stopCurrent !== null;
    void this.lid.sync(want, want ? this.lidBlock() : null);
  }

  /** Tell the daemon this Mac may sleep now, once per let-go. */
  private sleep(reason: SleepReason): void {
    this.sleepSent = true;
    try {
      this.onSleep(reason);
    } catch {
      // The frame is a courtesy: the Mac sleeps either way.
    }
  }

  /** A hold after a sleep notice: the server hears it is awake after all. */
  private wake(): void {
    if (!this.sleepSent) return;
    this.sleepSent = false;
    try {
      this.onWake();
    } catch {
      // As sleep(): a courtesy.
    }
  }

  private start(next: RunnerKeepAwake): void {
    this.wake();
    const seconds =
      next.until === null ? null : Math.ceil((next.until - this.now()) / 1000);
    const stop = this.holder!({ display: next.display, seconds }, (error) => {
      if (error) this.spawnFailed(error);
      // Ended by itself (its time came, or it failed): off. A stop() of
      // ours has already moved on.
      if (this.stopCurrent !== stop) return;
      this.stopCurrent = null;
      this.current = OFF;
      this.save(OFF);
    });
    this.stopCurrent = stop;
    this.current = next;
  }

  /** Automatic on. `held`: a restarted runner holds through one grace
   *  period, since its sessions report again only as they change. */
  private startAuto(display: boolean, held: boolean): void {
    this.current = { on: true, until: null, display, auto: true };
    this.lastWorkAt = held ? this.now() : 0;
    if (held) this.hold(display);
    // Each look reads the power too, for the sleep snapshot's battery.
    this.stopTicks = this.every(() => void this.look(), AUTO_POLL_MS);
    if (held) {
      this.setWork({
        sessions: 0,
        jobs: 0,
        holding: true,
        releaseAt: this.lastWorkAt + AUTO_GRACE_MS
      });
    } else {
      this.tick();
    }
  }

  /** While plugged in on: holds once the first power reading says AC. */
  private startPlugged(display: boolean): void {
    this.current = {
      on: true,
      until: null,
      display,
      ac: true,
      plugged: { ac: this.lastPower?.ac ?? null, holding: false }
    };
    this.stopTicks = this.every(() => void this.look(), AUTO_POLL_MS);
    void this.look();
  }

  /** Automatic's and While plugged in's hold. Ending by itself (the helper
   *  died, or could not start) leaves the mode on: the next tick that wants
   *  it takes it again. */
  private hold(display: boolean): void {
    this.wake();
    const stop = this.holder!({ display, seconds: null }, (error) => {
      if (error) this.spawnFailed(error);
      if (this.stopCurrent !== stop) return;
      this.stopCurrent = null;
      if (this.current.work) {
        this.setWork({ ...this.current.work, holding: false, releaseAt: null });
      }
      if (this.current.plugged) {
        this.current = {
          ...this.current,
          plugged: { ...this.current.plugged, holding: false }
        };
      }
    });
    this.stopCurrent = stop;
  }

  /** The helper could not start (its binary is missing): said once. */
  private spawnFailed(error: Error): void {
    if (this.spawnFailSaid) return;
    this.spawnFailSaid = true;
    this.log(`Could not hold the machine awake: ${error.message}`);
  }

  private letGo(): void {
    const stop = this.stopCurrent;
    this.stopCurrent = null;
    stop?.();
  }

  private setWork(work: RunnerKeepAwakeWork): void {
    this.current = { ...this.current, work };
  }

  private stop(): void {
    this.stopTicks?.();
    this.stopTicks = null;
    this.letGo();
    this.current = OFF;
  }

  private restore(): void {
    try {
      const saved = JSON.parse(
        fs.readFileSync(this.file, 'utf-8')
      ) as Partial<RunnerKeepAwake>;
      const until = typeof saved.until === 'number' ? saved.until : null;
      if (saved.on !== true) return;
      if (saved.auto === true) {
        this.startAuto(saved.display === true, true);
        return;
      }
      if (saved.ac === true) {
        this.startPlugged(saved.display === true);
        return;
      }
      if (until !== null && until <= this.now()) return;
      this.start({ on: true, until, display: saved.display === true });
    } catch {
      // None saved, or unreadable: off.
    }
  }

  private save(state: RunnerKeepAwake): void {
    // What it saw is not saved: a restart looks again.
    const kept: RunnerKeepAwake = {
      on: state.on,
      until: state.until,
      display: state.display,
      ...(state.auto ? { auto: true } : {}),
      ...(state.ac ? { ac: true } : {})
    };
    try {
      fs.writeFileSync(this.file, `${JSON.stringify(kept)}\n`, { mode: 0o600 });
    } catch {
      // Not saved: it still holds until this runner stops.
    }
  }
}
