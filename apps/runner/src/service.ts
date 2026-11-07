import crypto from 'node:crypto';
import path from 'node:path';

import {
  TOOLS_DIR_ENV,
  toolDirs
} from '@shared/all/helpers/board-agent-core/host-env';

// `factiii-runner service install | status | remove`: start the runner at
// login and restart it after a crash, with the operating system's own service
// manager. A LaunchAgent on macOS, a systemd user service on Linux, a
// scheduled task on Windows: all three belong to the user, so none needs root.
//
// The service runs `factiii-runner start`, which is the supervisor
// (supervisor.ts). A self-update is therefore unchanged: the worker exits 75,
// the supervisor relaunches it, and the service manager sees one process that
// never stopped. The service manager only acts when the supervisor itself
// exits, and only on a failure: a runner that stops on purpose (disconnected
// from the account in Settings, exit 0) must stay down.
//
// Everything that touches the machine comes in through ServiceIo, so the
// files and commands below are tested as strings.

export type ServicePlatform = 'darwin' | 'linux' | 'win32';

export type ServiceSpec = {
  platform: ServicePlatform;
  home: string;
  /** `DOMAIN\name` on Windows. */
  user: string;
  uid: number;
  node: string;
  entry: string;
  runnerDir: string;
  /** False for ~/.factiii-runner. Another dir is another runner: it gets its
   *  own service name, and FACTIII_RUNNER_DIR in the service's environment. */
  customDir: boolean;
  /** PATH for the service. A service manager starts a job with a bare one. */
  path: string;
  shell?: string;
  lang?: string;
  /** Factiii Desktop's tools folder (host-env.ts TOOLS_DIR_ENV), when the
   *  runner installing the service was handed one. */
  toolsDir?: string;
};

/** In every file `install` writes. `install` and `remove` leave a file
 *  without it alone. No character that XML or a batch file escapes. */
export const SERVICE_MARKER = 'Written by factiii-runner service install';

const MARKER_LINE = `${SERVICE_MARKER}. factiii-runner service remove deletes it.`;

/** launchd waits this long between restarts, so a runner that cannot start
 *  retries twice a minute instead of spinning. */
const RESTART_DELAY_SECONDS = 30;

const BOOTOUT_POLLS = 20;
const BOOTOUT_POLL_MS = 500;

function paths(platform: ServicePlatform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * The node and the script the service runs.
 *
 * `process.execPath` has its symlinks resolved, and under Homebrew that is a
 * versioned Cellar path which `brew upgrade` deletes. So the `node` beside the
 * command the user typed is used when it is the same node: /opt/homebrew/bin
 * survives the upgrade. The script is resolved, because the bin symlink can
 * move while the package stays where npm installs it (a self-update writes to
 * that same place).
 */
export function resolveProgram(opts: {
  execPath: string;
  /** `process.argv[1]`: the command as typed, symlink and all. */
  invoked: string;
  platform: ServicePlatform;
  realpath: (file: string) => string | null;
}): { node: string; entry: string } {
  const p = paths(opts.platform);
  const beside = p.join(
    p.dirname(opts.invoked),
    opts.platform === 'win32' ? 'node.exe' : 'node'
  );
  const node =
    opts.realpath(beside) === opts.execPath ? beside : opts.execPath;
  return { node, entry: opts.realpath(opts.invoked) ?? opts.invoked };
}

/** PATH for the service: this node's own dir first, so the `npm` a
 *  self-update runs is the one that installed this runner, then the dir of
 *  the `factiii-runner` command itself (~/.npm-global/bin when npm's prefix
 *  was moved there), then the PATH of the terminal `service install` ran in,
 *  which is where the tools were found. Last, the tool dirs (host-env.ts
 *  toolDirs: Factiii Desktop's tools folder, /opt/homebrew/bin,
 *  /usr/local/bin) wherever that terminal lacked them: launchd starts a job
 *  with a bare PATH, and a Mac whose Homebrew was on neither crash-looped on
 *  a missing redis-cli (2026-10-25). Behind the terminal's PATH, not in
 *  front, so the order a person chose there is kept; host execs put them
 *  first anyway (host-env.ts withAddedBinDirs). */
export function servicePath(
  node: string,
  envPath: string,
  platform: ServicePlatform,
  runnerBin?: string,
  tools: string[] = toolDirs(process.env, platform)
): string {
  const p = paths(platform);
  const dirs = [
    p.dirname(node),
    ...(runnerBin ? [p.dirname(runnerBin)] : []),
    ...envPath.split(p.delimiter),
    ...tools
  ].filter(Boolean);
  return [...new Set(dirs)].join(p.delimiter);
}

function nameSuffix(spec: ServiceSpec): string {
  if (!spec.customDir) return '';
  return crypto
    .createHash('sha256')
    .update(spec.runnerDir)
    .digest('hex')
    .slice(0, 8);
}

/** The launchd label, the systemd unit, or the task name. */
export function serviceName(spec: ServiceSpec): string {
  const suffix = nameSuffix(spec);
  switch (spec.platform) {
    case 'darwin':
      return suffix ? `com.factiii.runner.${suffix}` : 'com.factiii.runner';
    case 'linux':
      return `factiii-runner${suffix ? `-${suffix}` : ''}.service`;
    case 'win32':
      return `FactiiiRunner${suffix ? `-${suffix}` : ''}`;
  }
}

export type ServiceFiles = {
  /** The plist, the unit, or the task XML. */
  definition: string;
  /** Windows only: the batch file the task runs. */
  launcher: string | null;
  log: string;
};

/** Where the service's output goes. The runner limits its size (logLimit.ts). */
export function serviceLogFile(
  runnerDir: string,
  p: path.PlatformPath = path
): string {
  return p.join(runnerDir, 'logs', 'runner.log');
}

export function serviceFiles(spec: ServiceSpec): ServiceFiles {
  const p = paths(spec.platform);
  const log = serviceLogFile(spec.runnerDir, p);
  switch (spec.platform) {
    case 'darwin':
      return {
        definition: p.join(
          spec.home,
          'Library',
          'LaunchAgents',
          `${serviceName(spec)}.plist`
        ),
        launcher: null,
        log
      };
    case 'linux':
      return {
        definition: p.join(
          spec.home,
          '.config',
          'systemd',
          'user',
          serviceName(spec)
        ),
        launcher: null,
        log
      };
    case 'win32':
      return {
        definition: p.join(spec.runnerDir, 'service', 'task.xml'),
        launcher: p.join(spec.runnerDir, 'service', 'run.cmd'),
        log
      };
  }
}

function serviceEnv(spec: ServiceSpec): [string, string][] {
  const env: [string, string][] = [['PATH', spec.path]];
  // Host commands run through a login shell (host-env.ts). Without SHELL that
  // is bash, which never reads the zsh profile that puts Homebrew on PATH.
  if (spec.shell) env.push(['SHELL', spec.shell]);
  // tmux draws non-ASCII as underscores without a UTF-8 locale.
  if (spec.lang) env.push(['LANG', spec.lang]);
  if (spec.customDir) env.push(['FACTIII_RUNNER_DIR', spec.runnerDir]);
  // The service's runner looks there first too, as the one that installed it.
  if (spec.toolsDir) env.push([TOOLS_DIR_ENV, spec.toolsDir]);
  return env;
}

function xml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function renderLaunchAgent(spec: ServiceSpec): string {
  const { log } = serviceFiles(spec);
  const env = serviceEnv(spec)
    .map(([key, value]) => `    <key>${key}</key><string>${xml(value)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ${MARKER_LINE} -->
<plist version="1.0">
<dict>
  <key>Label</key><string>${serviceName(spec)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(spec.node)}</string>
    <string>${xml(spec.entry)}</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>WorkingDirectory</key><string>${xml(spec.home)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>${RESTART_DELAY_SECONDS}</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

/** One systemd word. `%` is a specifier everywhere, `$` a variable in Exec lines. */
function systemdQuote(text: string, exec = false): string {
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/%/g, '%%');
  return `"${exec ? escaped.replace(/\$/g, '$$$$') : escaped}"`;
}

export function renderSystemdUnit(spec: ServiceSpec): string {
  const { log } = serviceFiles(spec);
  const env = serviceEnv(spec)
    .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`)
    .join('\n');
  // KillMode=process: tmux and the terminals in it are in this unit's control
  // group, and the default would end them with every restart. ExecStop signals
  // the supervisor's process group instead, which is the supervisor and its
  // worker and nothing that detached from them.
  return `# ${MARKER_LINE}
[Unit]
Description=Factiii Runner

[Service]
ExecStart=${systemdQuote(spec.node, true)} ${systemdQuote(spec.entry, true)} start
${env}
WorkingDirectory=~
Restart=on-failure
RestartSec=10
KillMode=process
ExecStop=/bin/kill -TERM -- -\${MAINPID}
StandardOutput=append:${log.replace(/%/g, '%%')}
StandardError=append:${log.replace(/%/g, '%%')}

[Install]
WantedBy=default.target
`;
}

function batch(text: string): string {
  return text.replace(/%/g, '%%');
}

/** The batch file the Windows task runs: a task has no place for an
 *  environment or a log file of its own. */
export function renderWindowsLauncher(spec: ServiceSpec): string {
  const { log } = serviceFiles(spec);
  const lines = [
    '@echo off',
    `rem ${MARKER_LINE}`,
    // Not the whole PATH: a task already gets the user's own from the registry.
    `set "PATH=${batch(path.win32.dirname(spec.node))};%PATH%"`,
    ...(spec.customDir
      ? [`set "FACTIII_RUNNER_DIR=${batch(spec.runnerDir)}"`]
      : []),
    `"${batch(spec.node)}" "${batch(spec.entry)}" start >> "${batch(log)}" 2>&1`,
    'exit /b %ERRORLEVEL%'
  ];
  return `${lines.join('\r\n')}\r\n`;
}

export function renderWindowsTask(spec: ServiceSpec): string {
  const launcher = serviceFiles(spec).launcher ?? '';
  // InteractiveToken: the task runs in the user's own session, which is the
  // only place DPAPI will unwrap the runner's key.
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Factiii Runner. ${MARKER_LINE}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(spec.user)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(spec.user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>cmd.exe</Command>
      <Arguments>/d /s /c ""${xml(launcher)}""</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/** Every file `install` writes, with its content. `remove` deletes these. */
export function renderService(spec: ServiceSpec): { file: string; content: string }[] {
  const files = serviceFiles(spec);
  switch (spec.platform) {
    case 'darwin':
      return [{ file: files.definition, content: renderLaunchAgent(spec) }];
    case 'linux':
      return [{ file: files.definition, content: renderSystemdUnit(spec) }];
    case 'win32':
      return [
        { file: files.launcher ?? '', content: renderWindowsLauncher(spec) },
        { file: files.definition, content: renderWindowsTask(spec) }
      ];
  }
}

// ── The machine ──

export type ServiceIo = {
  /** Run a command, no shell. Never throws: a command that is not there is a
   *  non-zero code. */
  run(bin: string, args: string[]): Promise<{ code: number; output: string }>;
  /** Null when the file is not there. */
  read(file: string): string | null;
  /** Creates the parent dirs. */
  write(file: string, content: string): void;
  remove(file: string): void;
};

export type ServiceStatus = {
  name: string;
  file: string;
  /** `foreign`: a file or task of that name that `install` did not write. */
  installed: 'yes' | 'no' | 'foreign';
  /** Known to the service manager, so it starts at the next login. */
  loaded: boolean;
  running: boolean;
  pid: number | null;
  /** What the installed service runs. Empty when it is not installed. */
  command: string;
  log: string;
};

/** `launchctl print gui/<uid>/<label>`. */
export function parseLaunchctlPrint(output: string): {
  running: boolean;
  pid: number | null;
} {
  const state = /^\s*state = (.+)$/m.exec(output)?.[1].trim();
  const pid = /^\s*pid = (\d+)$/m.exec(output)?.[1];
  return { running: state === 'running', pid: pid ? Number(pid) : null };
}

/** `systemctl --user show <unit> --property=...`: one `Key=value` a line. */
export function parseSystemctlShow(output: string): {
  loaded: boolean;
  running: boolean;
  pid: number | null;
} {
  const value = (key: string) =>
    new RegExp(`^${key}=(.*)$`, 'm').exec(output)?.[1].trim() ?? '';
  const pid = Number(value('MainPID'));
  return {
    loaded: value('UnitFileState') === 'enabled',
    running: value('ActiveState') === 'active',
    pid: pid > 0 ? pid : null
  };
}

/** `schtasks /Query /TN <name> /FO CSV /NH`: name, next run, status. The
 *  status word is in the language of the Windows install. */
export function parseSchtasksCsv(output: string): { running: boolean } {
  const status = output.trim().split('\n').pop()?.split('","')[2] ?? '';
  return { running: status.replace(/"/g, '').trim() === 'Running' };
}

function launchdTarget(spec: ServiceSpec): string {
  return `gui/${spec.uid}/${serviceName(spec)}`;
}

/** The command line in an installed file, for `status`. */
function installedCommand(spec: ServiceSpec, io: ServiceIo): string {
  const files = serviceFiles(spec);
  if (spec.platform === 'darwin') {
    const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(
      io.read(files.definition) ?? ''
    )?.[1];
    return [...(args ?? '').matchAll(/<string>(.*?)<\/string>/g)]
      .map((match) =>
        match[1]
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&')
      )
      .join(' ');
  }
  if (spec.platform === 'linux') {
    return /^ExecStart=(.*)$/m.exec(io.read(files.definition) ?? '')?.[1] ?? '';
  }
  const launcher = io.read(files.launcher ?? '') ?? '';
  return launcher.split('\r\n').find((line) => line.includes('" start >> ')) ?? '';
}

export async function serviceStatus(
  spec: ServiceSpec,
  io: ServiceIo
): Promise<ServiceStatus> {
  const files = serviceFiles(spec);
  const name = serviceName(spec);
  const base = { name, file: files.definition, log: files.log };
  const marked = (text: string | null) => {
    if (text === null) return 'no';
    return text.includes(SERVICE_MARKER) ? 'yes' : 'foreign';
  };

  if (spec.platform === 'win32') {
    // The task is what a foreign owner would hold, not the files in our dir.
    const task = await io.run('schtasks', ['/Query', '/TN', name, '/XML']);
    const installed = marked(task.code === 0 ? task.output : null);
    const query =
      installed === 'no'
        ? null
        : await io.run('schtasks', ['/Query', '/TN', name, '/FO', 'CSV', '/NH']);
    return {
      ...base,
      installed,
      loaded: installed !== 'no',
      running: query ? parseSchtasksCsv(query.output).running : false,
      pid: null,
      command: installed === 'yes' ? installedCommand(spec, io) : ''
    };
  }

  const installed = marked(io.read(files.definition));
  const command = installed === 'yes' ? installedCommand(spec, io) : '';
  if (spec.platform === 'darwin') {
    const print = await io.run('launchctl', ['print', launchdTarget(spec)]);
    const loaded = print.code === 0;
    const state = loaded
      ? parseLaunchctlPrint(print.output)
      : { running: false, pid: null };
    return { ...base, installed, loaded, ...state, command };
  }
  const show = await io.run('systemctl', [
    '--user',
    'show',
    name,
    '--property=UnitFileState,ActiveState,MainPID'
  ]);
  const state =
    show.code === 0
      ? parseSystemctlShow(show.output)
      : { loaded: false, running: false, pid: null };
  return { ...base, installed, ...state, command };
}

/** Pids of a `start` of this same runner, from `ps -A -o pid=,args=` (or the
 *  Windows equivalent): a number, then the command line. */
export function runnerPids(
  processList: string,
  scripts: string[],
  selfPid: number
): number[] {
  const pids: number[] = [];
  for (const line of processList.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line.trimEnd());
    if (!match) continue;
    const [, pid, command] = match;
    if (Number(pid) === selfPid) continue;
    if (!/\sstart"?$/.test(command)) continue;
    if (scripts.some((script) => command.includes(script))) pids.push(Number(pid));
  }
  return pids;
}

/** A runner someone started by hand, or under another process manager. */
async function runningByHand(
  spec: ServiceSpec,
  io: ServiceIo,
  opts: InstallOptions
): Promise<number | null> {
  const list =
    spec.platform === 'win32'
      ? await io.run('powershell', [
          '-NoProfile',
          '-Command',
          'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }'
        ])
      : await io.run('ps', ['-A', '-o', 'pid=,args=']);
  if (list.code !== 0) return null;
  const scripts = [spec.entry, opts.invoked].filter(Boolean);
  return runnerPids(list.output, scripts, opts.selfPid)[0] ?? null;
}

export type InstallOptions = {
  /** `process.argv[1]`: how a runner started by hand shows up in `ps`. */
  invoked: string;
  selfPid: number;
};

export type ServiceOutcome = {
  ok: boolean;
  lines: string[];
  /** `install` only: the service is running the runner now. */
  started?: boolean;
};

const failed = (
  lines: string[],
  what: string,
  output: string
): ServiceOutcome => ({
  ok: false,
  lines: [...lines, `${what} failed:`, `  ${output.trim() || '(no output)'}`]
});

async function unload(spec: ServiceSpec, io: ServiceIo): Promise<void> {
  const name = serviceName(spec);
  if (spec.platform === 'darwin') {
    await io.run('launchctl', ['bootout', launchdTarget(spec)]);
    // bootout returns before the job is gone, and a bootstrap that races it
    // fails with "Input/output error".
    for (let tries = 0; tries < BOOTOUT_POLLS; tries += 1) {
      const print = await io.run('launchctl', ['print', launchdTarget(spec)]);
      if (print.code !== 0) break;
      await new Promise((resolve) => setTimeout(resolve, BOOTOUT_POLL_MS));
    }
  } else if (spec.platform === 'linux') {
    await io.run('systemctl', ['--user', 'disable', '--now', name]);
  } else {
    await io.run('schtasks', ['/End', '/TN', name]);
    await io.run('schtasks', ['/Delete', '/TN', name, '/F']);
  }
}

/**
 * Write the service and load it. Running it twice changes nothing; running it
 * after the node or the runner moved rewrites the file and restarts the
 * service. A file of the same name that this command did not write is left
 * alone, and so is a runner that is already running: a second one on the same
 * pairing would fight the first for every job.
 */
export async function installService(
  spec: ServiceSpec,
  io: ServiceIo,
  opts: InstallOptions
): Promise<ServiceOutcome> {
  const status = await serviceStatus(spec, io);
  const name = serviceName(spec);
  if (status.installed === 'foreign') {
    return {
      ok: false,
      lines: [
        spec.platform === 'win32'
          ? `A scheduled task named ${name} exists and this command did not create it.`
          : `${status.file} exists and this command did not write it.`,
        'Nothing was changed. Remove it yourself, or move it away, then run this again.'
      ]
    };
  }

  const wanted = renderService(spec);
  const current = wanted.every(({ file, content }) => io.read(file) === content);
  if (current && status.installed === 'yes' && status.loaded) {
    return {
      ok: true,
      lines: [`Already installed: ${name}. Nothing was changed.`],
      started: status.running
    };
  }

  const other = status.running ? null : await runningByHand(spec, io, opts);
  // A changed file under a loaded service: the old one has to go first.
  if (!current && status.loaded) await unload(spec, io);
  for (const { file, content } of wanted) io.write(file, content);
  const lines = wanted.map(({ file }) => `Wrote ${file}`);
  const files = serviceFiles(spec);

  if (spec.platform === 'linux') {
    const reload = await io.run('systemctl', ['--user', 'daemon-reload']);
    if (reload.code !== 0) return failed(lines, 'systemctl --user daemon-reload', reload.output);
    const enable = await io.run('systemctl', [
      '--user',
      'enable',
      ...(other ? [] : ['--now']),
      name
    ]);
    if (enable.code !== 0) return failed(lines, 'systemctl --user enable', enable.output);
  } else if (spec.platform === 'win32') {
    const create = await io.run('schtasks', [
      '/Create',
      '/TN',
      name,
      '/XML',
      files.definition,
      '/F'
    ]);
    if (create.code !== 0) return failed(lines, 'schtasks /Create', create.output);
    if (!other) {
      const run = await io.run('schtasks', ['/Run', '/TN', name]);
      if (run.code !== 0) return failed(lines, 'schtasks /Run', run.output);
    }
  } else if (!other) {
    // RunAtLoad starts it. Left unloaded, launchd still picks the file up at
    // the next login.
    const load = await io.run('launchctl', [
      'bootstrap',
      `gui/${spec.uid}`,
      files.definition
    ]);
    if (load.code !== 0) return failed(lines, 'launchctl bootstrap', load.output);
  }

  if (other) {
    lines.push(
      `A runner is already running here (pid ${other}), so the service was not started: two runners on one pairing fight over every job.`,
      'The service starts at the next login. To switch now, stop that runner (Ctrl-C in its terminal), then run "factiii-runner service install" again.'
    );
  } else {
    lines.push(`Installed and started: ${name}`);
  }
  lines.push(`Log: ${files.log}`);
  return { ok: true, lines, started: !other };
}

/** Take the service off the next login without stopping what it runs now:
 *  a launchd job stays loaded until logout once its file is gone, a disabled
 *  systemd unit keeps running, a deleted task leaves its process alone. */
async function forget(spec: ServiceSpec, io: ServiceIo): Promise<void> {
  const name = serviceName(spec);
  if (spec.platform === 'linux') {
    await io.run('systemctl', ['--user', 'disable', name]);
  } else if (spec.platform === 'win32') {
    await io.run('schtasks', ['/Delete', '/TN', name, '/F']);
  }
}

/** Unload the service and delete the files `install` wrote. The log stays:
 *  the runner wrote it, and it is what explains a runner that stopped.
 *  `keepRunning` (the app's Remove, sent through the runner the service
 *  runs): delete without stopping it, so the runner answering the app does
 *  not cut its own link, and stays down after the next restart. */
export async function removeService(
  spec: ServiceSpec,
  io: ServiceIo,
  opts: { keepRunning?: boolean } = {}
): Promise<ServiceOutcome> {
  const status = await serviceStatus(spec, io);
  if (status.installed === 'no') {
    return { ok: true, lines: ['Not installed. Nothing was changed.'] };
  }
  if (status.installed === 'foreign') {
    return {
      ok: false,
      lines: [
        `${status.name} was not installed by this command. Nothing was changed.`
      ]
    };
  }
  if (opts.keepRunning) await forget(spec, io);
  else await unload(spec, io);
  const lines: string[] = [];
  for (const { file } of renderService(spec)) {
    io.remove(file);
    lines.push(`Removed ${file}`);
  }
  if (spec.platform === 'linux') {
    await io.run('systemctl', ['--user', 'daemon-reload']);
  }
  if (opts.keepRunning) {
    lines.push('The runner keeps running until the next restart, and does not start after it.');
  }
  lines.push(`Kept the log: ${status.log} (and ${status.log}.1, if there is one)`);
  return { ok: true, lines };
}

// ── What only the owner may do: printed, never run ──

export type Guide = { note: string[]; commands: string[] };

/** Keep the machine awake, and bring it back after a power cut. */
export function powerGuide(platform: ServicePlatform): Guide {
  switch (platform) {
    case 'darwin':
      return {
        note: [
          'A sleeping Mac runs nothing. These keep it awake on mains power and start it again after a power failure (the display may still sleep):'
        ],
        commands: ['sudo pmset -c sleep 0 disksleep 0', 'sudo pmset -a autorestart 1']
      };
    case 'linux':
      return {
        note: ['A suspended machine runs nothing. This stops it suspending:'],
        commands: [
          'sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target'
        ]
      };
    case 'win32':
      return {
        note: ['A sleeping PC runs nothing. These stop it sleeping on mains power:'],
        commands: [
          'powercfg /change standby-timeout-ac 0',
          'powercfg /change hibernate-timeout-ac 0'
        ]
      };
  }
}

/** What stands between a restart and the service starting with nobody there. */
export function loginGuide(spec: Pick<ServiceSpec, 'platform' | 'user'>): Guide {
  switch (spec.platform) {
    case 'darwin':
      return {
        note: [
          `The service starts when ${spec.user} logs in, and the key that opens the runner's config is in the login keychain, which is locked until then.`,
          'A Mac nobody logs in to after a restart needs automatic login:',
          '  System Settings > Users & Groups > Automatically log in as',
          'That is a security trade, and yours to make: anyone who can reach the Mac gets a logged-in session, and macOS does not offer it while FileVault is on.',
          'The runner never changes this setting.'
        ],
        commands: []
      };
    case 'linux':
      return {
        note: [
          "The key that opens the runner's config is in the login keyring, so a machine nobody logs in to needs that keyring unlocked at boot.",
          `A user service starts when ${spec.user} logs in. Lingering starts it at boot instead; it needs an administrator on most systems:`
        ],
        commands: [`sudo loginctl enable-linger ${spec.user}`]
      };
    case 'win32':
      return {
        note: [
          `The task starts when ${spec.user} logs on, and the runner's key only opens in that user's session.`,
          'A PC nobody logs on to after a restart needs automatic logon (run "netplwiz", or Sysinternals Autologon).',
          'That is a security trade, and yours to make: anyone who can reach the PC gets a logged-on session.',
          'The runner never changes this setting.'
        ],
        commands: []
      };
  }
}

/** The key a board password unwraps lives only in the running runner's memory
 *  (secrets-window.ts), so no service can carry an unlock over a restart. */
export const SECRETS_AFTER_RESTART =
  "The board password is never stored. After a restart the runner comes back by itself, but each board's secrets stay locked until someone unlocks them from the app.";
