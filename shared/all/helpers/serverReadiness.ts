import type {
  RunnerKeepAwake,
  RunnerReadinessCheck,
  RunnerServerReadiness
} from '../domains/electron';
import type { RunnerSleepSnapshot } from '../validators/runnerParts';

// "Ready to be a server": what an always-on Mac needs, read by the runner
// (serverReadinessIo.ts) and by the desktop app on its own Mac, and the
// commands the desktop app runs behind macOS's admin prompt to fix it. The
// runner reads only; nothing here runs with more than the user's rights
// except through that prompt.

/** `pmset -g`, the settings a server cares about. Null: not listed (a
 *  laptop has no autorestart; some Macs no womp). */
type PmsetReading = {
  sleep: number | null;
  autorestart: number | null;
  womp: number | null;
  /** `pmset -a disablesleep 1`: no sleep at all, lid closed included. */
  sleepDisabled: boolean;
};

export function parsePmsetSettings(output: string): PmsetReading {
  const value = (name: string) => {
    const found = new RegExp(`^\\s*${name}\\s+(\\d+)`, 'm').exec(output)?.[1];
    return found === undefined ? null : Number(found);
  };
  return {
    sleep: value('sleep'),
    autorestart: value('autorestart'),
    womp: value('womp'),
    sleepDisabled: value('SleepDisabled') === 1
  };
}

/** `sysadminctl -screenLock status`: seconds before the screen locks once
 *  the display sleeps, 'off', or null when it gave no answer. */
export function parseScreenLock(output: string): number | 'off' | null {
  if (/screenLock is off/i.test(output)) return 'off';
  if (/screenLock delay is immediate/i.test(output)) return 0;
  const seconds = /screenLock delay is (\d+) seconds/i.exec(output)?.[1];
  return seconds === undefined ? null : Number(seconds);
}

/** `ioreg -n Root -d1`: the console session's lock, or null when unknown. */
export function parseScreenLocked(output: string): boolean | null {
  const m = /"CGSSessionScreenIsLocked"=(Yes|No)/.exec(output);
  return m ? m[1] === 'Yes' : null;
}

/** This Mac's Tailscale address (100.64.0.0/10) from `ifconfig`, or null. */
export function parseTailscaleIp(output: string): string | null {
  const m =
    /inet (100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/.exec(
      output
    );
  return m ? m[1] : null;
}

/** Reaching the Mac from elsewhere: what Screen Sharing over Tailscale
 *  needs. Null fields are left out of the list. */
type RemoteReading = {
  screenLock: number | 'off' | null;
  /** Something answers on 5900 (macOS Screen Sharing). */
  screenSharing: boolean | null;
  tailscaleIp: string | null;
};

/** The checklist, from what the machine said. */
export function readinessChecks(input: {
  pmset: PmsetReading | null;
  /** `autoLoginUser`, or null when automatic login is off. */
  autoLoginUser: string | null;
  /** Null when `fdesetup status` gave no answer. */
  fileVault: boolean | null;
  remote?: RemoteReading;
}): RunnerReadinessCheck[] {
  return [...powerChecks(input), ...remoteChecks(input.remote)];
}

function remoteChecks(
  remote: RemoteReading | undefined
): RunnerReadinessCheck[] {
  if (!remote) return [];
  const checks: RunnerReadinessCheck[] = [];
  if (remote.screenLock !== null) {
    const off = remote.screenLock === 'off';
    checks.push({
      id: 'screenlock',
      ok: off,
      detail: off
        ? 'Never locks by itself'
        : `Locks ${remote.screenLock === 0 ? 'as soon as' : `${Math.round(Number(remote.screenLock) / 60)} min after`} the display sleeps`
    });
  }
  if (remote.screenSharing !== null) {
    checks.push({
      id: 'screensharing',
      ok: remote.screenSharing,
      detail: remote.screenSharing ? 'On' : 'Off'
    });
  }
  checks.push({
    id: 'tailscale',
    ok: remote.tailscaleIp !== null,
    detail: remote.tailscaleIp
      ? `Connected as ${remote.tailscaleIp}`
      : 'Not connected'
  });
  return checks;
}

function powerChecks(input: {
  pmset: PmsetReading | null;
  autoLoginUser: string | null;
  fileVault: boolean | null;
}): RunnerReadinessCheck[] {
  const { pmset, autoLoginUser, fileVault } = input;
  const setting = (n: number | null | undefined) =>
    n === null || n === undefined ? null : n === 1;
  const sleepOk = pmset ? pmset.sleep === 0 || pmset.sleepDisabled : null;
  let sleepDetail = 'Unknown';
  if (pmset?.sleepDisabled) sleepDetail = 'Sleep is off for the whole Mac';
  else if (pmset) sleepDetail = `Sleeps after ${pmset.sleep ?? '?'} min`;
  const onOff = (n: number | null | undefined) =>
    n === null ? 'Not offered on this Mac' : `Turned ${n === 1 ? 'on' : 'off'}`;
  return [
    {
      id: 'login',
      ok: Boolean(autoLoginUser),
      detail: autoLoginUser ? `Logs in as ${autoLoginUser}` : 'Off'
    },
    {
      id: 'filevault',
      ok: fileVault === null ? null : !fileVault,
      detail: fileVault ? 'On: it stops automatic login' : 'Off'
    },
    { id: 'sleep', ok: sleepOk, detail: sleepDetail },
    {
      id: 'autorestart',
      ok: setting(pmset?.autorestart),
      detail: onOff(pmset?.autorestart)
    },
    { id: 'womp', ok: setting(pmset?.womp), detail: onOff(pmset?.womp) }
  ];
}

/** What each check is called and how it is fixed by hand. */
export const READINESS_COPY: Record<
  RunnerReadinessCheck['id'],
  { title: string; fix: string }
> = {
  login: {
    title: 'Logs in by itself after a restart',
    fix: 'System Settings > Users & Groups > Automatically log in as. The runner starts when its user logs in, so without this it stays off after a restart until someone signs in at the Mac.'
  },
  filevault: {
    title: 'FileVault lets it log in by itself',
    fix: 'With FileVault on, macOS asks for a password at startup and automatic login cannot work. Turning it off leaves the disk unencrypted: only do it for a Mac kept somewhere secure.'
  },
  sleep: {
    title: 'Never sleeps on power',
    fix: 'sudo pmset -c sleep 0 disksleep 0'
  },
  autorestart: {
    title: 'Starts again after a power cut',
    fix: 'sudo pmset -a autorestart 1'
  },
  womp: {
    title: 'Wakes for network access',
    fix: 'sudo pmset -a womp 1'
  },
  screenlock: {
    title: 'The screen does not lock by itself',
    fix: 'System Settings > Lock Screen > "Require password after screen saver begins or display is turned off": Never. Screen Sharing still works at the lock screen, but you sign in there first. Only for a Mac kept somewhere secure.'
  },
  // The two below come only from an older runner, which had the desktop
  // view (removed 2026-10-25). Kept so its checks still have a title.
  'screen-recording': {
    title: 'Desktop view can see the screen',
    fix: 'System Settings > Privacy & Security > Screen & System Audio Recording > Factiii Screen. Only someone at the Mac can turn it on, and macOS asks again about once a month.'
  },
  accessibility: {
    title: 'Desktop view can click and type',
    fix: 'System Settings > Privacy & Security > Accessibility > Factiii Screen.'
  },
  screensharing: {
    title: 'Screen Sharing is on (the way in when Factiii is down)',
    fix: 'System Settings > General > Sharing > Screen Sharing. Over Tailscale it works even at the lock screen and the login window.'
  },
  tailscale: {
    title: 'Reachable over Tailscale',
    fix: 'Install Tailscale on this Mac with the Factiii desktop app (or from tailscale.com) and sign in. Then install it on the phone or computer you reach it from.'
  }
};

/** The checks fixed in System Settings (or a download page): where the
 *  desktop app's button opens. */
export const SETTINGS_FIXES: Partial<
  Record<RunnerReadinessCheck['id'], string>
> = {
  login: 'x-apple.systempreferences:com.apple.Users-Groups-Settings.extension',
  screenlock:
    'x-apple.systempreferences:com.apple.Lock-Screen-Settings.extension',
  'screen-recording':
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screensharing:
    'x-apple.systempreferences:com.apple.Sharing-Settings.extension',
  tailscale: 'https://tailscale.com/download'
};

/** macOS Screen Sharing over Tailscale: opens the Mac's own VNC from a Mac
 *  (Screen Sharing.app) or a phone with a VNC app. */
export const screenSharingUrl = (tailscaleIp: string): string =>
  `vnc://${tailscaleIp}`;

/** The Screen Sharing panel's how-to (web rail, mobile header): the way to
 *  see and use the runner's Mac, now that the runner has no desktop view of
 *  its own (removed 2026-10-25). */
export const SCREEN_SHARING_STEPS = [
  'On the Mac, turn on System Settings > General > Sharing > Screen Sharing.',
  'Join the Mac and the device you watch from to the same tailnet in Tailscale.',
  'Open the link. A Mac opens it in Screen Sharing; on an iPhone or iPad, use a VNC app.'
] as const;

/** The panel with no Tailscale address to link to. */
export const SCREEN_SHARING_NO_ADDRESS =
  'This Mac has no Tailscale address. Install Tailscale on it (tailscale.com/download, or from the Factiii desktop app), sign in, and the link shows here.';

/** The checks the desktop app can fix itself, behind the admin prompt. */
export const ADMIN_FIXES: Partial<Record<RunnerReadinessCheck['id'], string>> =
  {
    sleep: 'pmset -c sleep 0 disksleep 0',
    autorestart: 'pmset -a autorestart 1',
    womp: 'pmset -a womp 1'
  };

/** Every check met (one the runner cannot tell is not held against it). */
export const serverReady = (server: RunnerServerReadiness): boolean =>
  server.checks.every((c) => c.ok !== false);

// Lid closed: macOS sleeps on closing the lid whatever caffeinate says, so
// keep-awake with the lid closed is `pmset -a disablesleep 1`, which needs an
// admin. The desktop app runs these as root behind macOS's prompt. A timer is
// a root `sleep` that turns it back off; its end time is written to
// LID_AWAKE_FILE so the runner (not root) can show it. It lives in a folder
// only root can write: in a world-writable one (/tmp) another user could put
// a symlink there and have root overwrite any file.

const LID_AWAKE_DIR = '/Library/Application Support/Factiii';
export const LID_AWAKE_FILE = `${LID_AWAKE_DIR}/lid-awake`;
/** Quoted for the shell: the path has a space. */
const LID_FILE_SH = `"${LID_AWAKE_FILE}"`;
/** In the timer's command line, to find it again. The pattern is written
 *  `awak[e]` so pkill does not match the shell running the pkill. */
const LID_TIMER_TAG = 'factiii-lid-awake-timer';
const LID_TIMER_PATTERN = 'factiii-lid-awak[e]-timer';
const MIN_TIMER_S = 60;

export function lidAwakeOnScript(until: number | null, now: number): string {
  const steps = [
    `pkill -f '${LID_TIMER_PATTERN}' || true`,
    'pmset -a disablesleep 1',
    `mkdir -p "${LID_AWAKE_DIR}"`,
    `chmod 755 "${LID_AWAKE_DIR}"`,
    `rm -f ${LID_FILE_SH}`,
    `echo ${until ?? 'none'} > ${LID_FILE_SH}`
  ];
  if (until !== null) {
    const seconds = Math.max(MIN_TIMER_S, Math.ceil((until - now) / 1000));
    steps.push(
      `nohup /bin/sh -c 'sleep ${seconds}; pmset -a disablesleep 0; rm -f ${LID_FILE_SH}' ${LID_TIMER_TAG} >/dev/null 2>&1 &`
    );
  }
  return steps.join('; ');
}

export const lidAwakeOffScript = (): string =>
  `pkill -f '${LID_TIMER_PATTERN}' || true; pmset -a disablesleep 0; rm -f ${LID_FILE_SH}`;

/** LID_AWAKE_FILE's end time, or null (none, or no timer). */
export function parseLidAwakeFile(text: string | null): number | null {
  const until = Number(text?.trim());
  return Number.isFinite(until) && until > 0 ? until : null;
}

// Keep-awake's timer, as the controls offer it.

const KEEP_AWAKE_HOURS = [1, 2, 4, 8];
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const untilInHours = (hours: number, now: number): number =>
  now + hours * HOUR_MS;

/** The next time the clock reads `hhmm` ("08:00"): today if still ahead,
 *  else tomorrow. Null for a time that does not parse. */
export function untilAtClock(hhmm: string, now: Date): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const at = new Date(now);
  at.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at.getTime();
}

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** "8:00 AM", "8:00 AM tomorrow", or a date further out. */
function whenLine(until: number, now: number): string {
  const day = (ms: number) => new Date(ms).toDateString();
  if (day(until) === day(now)) return clock(until);
  if (day(until) === day(now + DAY_MS)) return `${clock(until)} tomorrow`;
  const date = new Date(until).toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  });
  return `${clock(until)} ${date}`;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** Automatic keep-awake's one line: holding for what, or idle. */
function autoLine(keep: RunnerKeepAwake, now: number): string {
  const work = keep.work;
  if (!work?.holding) return 'Automatic · idle, Mac can sleep.';
  const parts = [
    work.sessions > 0 ? `${plural(work.sessions, 'session')} working` : '',
    work.jobs > 0 ? `${plural(work.jobs, 'job')} running` : ''
  ].filter(Boolean);
  if (parts.length > 0) return `Automatic · holding (${parts.join(', ')}).`;
  if (work.releaseAt === null) return 'Automatic · holding.';
  const mins = Math.max(1, Math.ceil((work.releaseAt - now) / 60_000));
  return `Automatic · holding, Mac can sleep in ${mins} min.`;
}

/** While plugged in's one line: holding on power, or on battery. */
function pluggedLine(keep: RunnerKeepAwake): string {
  const plugged = keep.plugged;
  if (plugged?.ac === false)
    return 'While plugged in · on battery, Mac can sleep.';
  if (plugged?.holding) return 'While plugged in · holding (on power).';
  return 'While plugged in · checking the power.';
}

/** Keep-awake's one line. */
export function keepAwakeLine(keep: RunnerKeepAwake, now: number): string {
  if (!keep.on) return 'Off: the Mac sleeps as its settings say.';
  if (keep.auto) return autoLine(keep, now);
  if (keep.ac) return pluggedLine(keep);
  const screen = keep.display ? ', screen on' : '';
  if (keep.until === null) return `Awake until turned off${screen}.`;
  return `Awake until ${whenLine(keep.until, now)}${screen}.`;
}

/** Lid-closed keep-awake's one line. */
export function lidAwakeLine(
  lid: RunnerServerReadiness['lidAwake'],
  now: number
): string {
  if (!lid.on) return 'Off: closing the lid puts the Mac to sleep.';
  if (lid.until !== null && lid.until <= now) {
    // Its timer is a process: a restart ended it before it could switch
    // this back off, and pmset keeps the setting.
    return 'Awake with the lid closed, and its timer did not run (the Mac restarted). Turn it off.';
  }
  if (lid.until === null) return 'Awake with the lid closed, until turned off.';
  return `Awake with the lid closed until ${whenLine(lid.until, now)}.`;
}

/** The keep-awake controls' choices: hours, a clock time, open-ended,
 *  automatic (while terminals or jobs run), or while plugged in (on AC
 *  power). The last two are keep-awake only, not the lid. */
export type UntilChoice =
  | 'h1'
  | 'h2'
  | 'h4'
  | 'h8'
  | 'clock'
  | 'forever'
  | 'auto'
  | 'plugged';

/** The choices that are a mode, not a time: keep-awake only. */
export const MODE_CHOICES: UntilChoice[] = ['auto', 'plugged'];

/** The choice a control starts on, from what holds now. */
export const choiceFor = (keep: RunnerKeepAwake): UntilChoice => {
  if (keep.on && keep.auto) return 'auto';
  if (keep.on && keep.ac) return 'plugged';
  return 'h2';
};

/** keepAwakeSet's mode flags for a choice. */
export const modeFlags = (
  choice: UntilChoice
): { auto: boolean; ac: boolean } => ({
  auto: choice === 'auto',
  ac: choice === 'plugged'
});

export const UNTIL_CHOICES: { id: UntilChoice; label: string }[] = [
  ...KEEP_AWAKE_HOURS.map((h) => ({
    id: `h${h}` as UntilChoice,
    label: `For ${h} ${h === 1 ? 'hour' : 'hours'}`
  })),
  { id: 'clock', label: 'Until a time…' },
  { id: 'forever', label: 'Until turned off' },
  { id: 'auto', label: 'Automatic (while terminals or jobs run)' },
  { id: 'plugged', label: 'While plugged in (lets go on battery)' }
];

/** When a choice ends: a time, null (until turned off, or automatic), or
 *  'invalid' for a clock time that does not parse. */
export function untilFor(
  choice: UntilChoice,
  clockText: string,
  now: Date
): number | null | 'invalid' {
  if (choice === 'forever' || MODE_CHOICES.includes(choice)) return null;
  if (choice === 'clock') return untilAtClock(clockText, now) ?? 'invalid';
  return untilInHours(Number(choice.slice(1)), now.getTime());
}

// Asleep, not Offline: what the apps show for a runner that said it was
// going to sleep (runnerSleepSnapshotSchema) and then dropped.

/** "Asleep · since 10:42" (with the day, for an older one). */
export const asleepLine = (since: number, now: number): string =>
  `Asleep · since ${whenLine(since, now)}`;

const SESSION_STATE_WORDS: Record<string, string> = {
  working: 'working',
  blocked: 'waiting on you',
  idle: 'idle'
};

/** One session of the snapshot: its title and what it was doing. */
export function asleepSessionLine(
  session: RunnerSleepSnapshot['sessions'][number]
): string {
  const state =
    (session.agentState && SESSION_STATE_WORDS[session.agentState]) ||
    session.phase.replace(/-/g, ' ');
  return state ? `${session.title} · ${state}` : session.title;
}

/** The snapshot's rows, for an asleep runner's status: why it slept, when it
 *  last had work, its battery, and jobs still running. Its sessions are
 *  listed apart (asleepSessionLine). */
export function asleepRows(
  snapshot: RunnerSleepSnapshot,
  now: number
): [string, string][] {
  const rows: [string, string][] = [
    [
      'Why',
      snapshot.reason === 'battery'
        ? 'On battery (While plugged in)'
        : 'No work left (Automatic)'
    ]
  ];
  if (snapshot.lastWorkAt !== null) {
    rows.push(['Last work', whenLine(snapshot.lastWorkAt, now)]);
  }
  const battery = snapshot.battery;
  if (battery && (battery.percent !== null || battery.ac !== null)) {
    const charge = battery.percent === null ? '' : `${battery.percent}%`;
    let source = '';
    if (battery.ac === true) source = 'on power';
    if (battery.ac === false) source = 'on battery';
    rows.push(['Battery', [charge, source].filter(Boolean).join(', ')]);
  }
  if (snapshot.jobs > 0) {
    rows.push(['Jobs running', String(snapshot.jobs)]);
  }
  return rows;
}

type ReadRun = (
  bin: string,
  args: string[]
) => Promise<{ code: number; output: string }>;

/** Reads RemoteReading and the lock with four quick commands, none of which
 *  needs admin or starts anything. Shared by the runner and the desktop app. */
export async function readRemoteAccess(
  run: ReadRun
): Promise<RemoteReading & { screenLocked: boolean | null }> {
  const [lock, ioreg, ifconfig, vnc] = await Promise.all([
    run('sysadminctl', ['-screenLock', 'status']),
    run('ioreg', ['-n', 'Root', '-d1']),
    run('ifconfig', []),
    run('nc', ['-z', '-G', '1', '127.0.0.1', '5900'])
  ]);
  return {
    screenLock: parseScreenLock(lock.output),
    screenLocked: parseScreenLocked(ioreg.output),
    screenSharing: vnc.code === 0,
    tailscaleIp: parseTailscaleIp(ifconfig.output)
  };
}
