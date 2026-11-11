import path from 'node:path';

import type { RunnerMachineHealth } from '@shared/all/domains/electron';
import type { ToolPlan } from '@shared/all/helpers/board-agent-core';
import { ENVIRONMENT_TOOLS } from '@shared/all/helpers/board-agent-core/toolchain';
import {
  CLEANUP_SAFE_NOTE,
  diskLine,
  healthHeadline,
  memoryLine,
  processLine
} from '@shared/all/helpers/runnerHealthCopy';

import type { modelCheck } from './localAiModel';
import { VAULT_ENGINE_PACKAGE, VAULT_ENGINE_VERSION } from './vault/engine';
import {
  loginGuide,
  powerGuide,
  type ServicePlatform,
  type ServiceStatus
} from './service';

// The setup checklist: what this machine has, what each missing piece costs,
// and who may fix it. `factiii-runner setup` ends with it and
// `factiii-runner doctor` runs it again.
//
// Three kinds of fix, and the runner only ever performs the first:
//   install / folder  no root needed, so it offers to do it
//   command           needs root or is the owner's call: printed, never run
//   settings          only a person can tick the box: it names the pane and
//                     offers to open it
//
// The machine comes in through DoctorHost and the fixes through DoctorUi, so
// the list is tested without probing or changing anything.

type Fix =
  | { kind: 'install'; tool: string; command: string }
  | { kind: 'folder'; path: string }
  | { kind: 'command'; note: string[]; commands: string[] }
  | { kind: 'settings'; path: string; url: string };

type CheckStatus = {
  /** `unknown`: the runner cannot read it. Never counts against the machine. */
  state: 'met' | 'unmet' | 'unknown';
  detail: string;
  /** Depends on the host (brew installs without root, apt does not), so it is
   *  part of the answer rather than of the check. */
  fix?: Fix;
};

export type Check = {
  id: string;
  title: string;
  /** What stops working without it. */
  feature: string;
  required: boolean;
  check(): Promise<CheckStatus>;
};

export type DoctorHost = {
  platform: NodeJS.Platform;
  nodeVersion: string;
  runnerDir: string;
  user: string;
  /** Read-only: where each tool resolves and how this host installs it. */
  tools(): Promise<ToolPlan[]>;
  /** The Vault's database engine is installed (vault/engine.ts). */
  vaultEngine(): boolean;
  /** The Vault's embedder (vault/embedderInstall.ts). */
  vaultEmbedder(): 'ready' | 'missing' | 'unsupported';
  /** The Local AI model that fits this machine, and whether it is pulled
   *  (localAiModel.ts). */
  localAiModel(): ReturnType<typeof modelCheck>;
  /** Free disk where the runner writes, and memory pressure
   *  (machineHealth.ts). */
  health(): Promise<RunnerMachineHealth>;
  dirWritable(dir: string): boolean;
  /** A file is there (the Homebrew check's brew). */
  fileExists(file: string): boolean;
  keychain(): { ready: boolean; keyStore: string; problem: string; fix: string };
  paired(): boolean;
  /** The PATH a fresh login shell of this user starts with, before anything
   *  the runner adds to it (host-env.ts toolDirs). Null when the shell gave
   *  no answer. */
  loginPath(): Promise<string | null>;
  /** Run a read-only command, no shell. Never throws. */
  run(bin: string, args: string[]): Promise<{ code: number; output: string }>;
  /** Null where no service can be installed (a dev checkout). */
  service(): Promise<ServiceStatus | null>;
};

const MIN_NODE_MAJOR = 20;

const met = (detail: string): CheckStatus => ({ state: 'met', detail });

/** The checks for this host, and `refresh` to probe the tools again after
 *  one was installed. */
export function buildChecks(host: DoctorHost): {
  checks: Check[];
  refresh(): void;
} {
  let plans: Promise<ToolPlan[]> | null = null;
  const tools = () => (plans ??= host.tools());
  let healthRead: Promise<RunnerMachineHealth> | null = null;
  const health = () => (healthRead ??= host.health());
  const mac = host.platform === 'darwin';

  // Every tool is optional here: the connector needs none of them, and each
  // belongs to a part the owner adds (parts.ts). The board's Initialize still
  // requires the harness ones (ENVIRONMENT_TOOLS `required`).
  const tool = (
    bin: string,
    title: string,
    feature: string,
    manual = 'No package manager was found (brew, apt-get, dnf, pacman).'
  ): Check => ({
    id: bin,
    title,
    feature,
    required: false,
    async check() {
      const plan = (await tools()).find((t) => t.bin === bin);
      if (plan?.location) return met(plan.location);
      if (!plan?.install) return { state: 'unmet', detail: `Not found. ${manual}` };
      const { command, sudo } = plan.install;
      return {
        state: 'unmet',
        detail: 'Not found on the login PATH.',
        fix: sudo
          ? { kind: 'command', note: ['Needs an administrator:'], commands: [command] }
          : { kind: 'install', tool: bin, command }
      };
    }
  });

  const checks: Check[] = [
    {
      id: 'node-version',
      title: `Node ${MIN_NODE_MAJOR} or newer`,
      feature: 'the runner',
      required: true,
      async check() {
        const major = Number(host.nodeVersion.split('.')[0]);
        const detail = `Node ${host.nodeVersion}`;
        return major >= MIN_NODE_MAJOR
          ? met(detail)
          : {
              state: 'unmet',
              detail,
              fix: {
                kind: 'command',
                // The installer brings its own Node 24 when this one is too old.
                note: ['Install the runner again; this brings a newer Node:'],
                commands: ['curl -fsSL https://factiii.com/runner.sh | sh']
              }
            };
      }
    },
    {
      id: 'folder',
      title: 'Runner folder',
      feature: 'the runner',
      required: true,
      async check() {
        return host.dirWritable(host.runnerDir)
          ? met(host.runnerDir)
          : {
              state: 'unmet',
              detail: `${host.runnerDir} is missing or not writable.`,
              fix: { kind: 'folder', path: host.runnerDir }
            };
      }
    },
    {
      id: 'keychain',
      title: 'Keychain access',
      feature: 'the runner (its config is encrypted under a key kept here)',
      required: true,
      async check() {
        const store = host.keychain();
        if (!store.ready) {
          return {
            state: 'unmet',
            detail: store.problem,
            fix: { kind: 'command', note: store.fix.split('\n'), commands: [] }
          };
        }
        // Only the macOS path has been run end to end (README, Security notes).
        return met(
          mac
            ? store.keyStore
            : `${store.keyStore} (beta: implemented, not yet verified on this platform)`
        );
      }
    },
    {
      id: 'pairing',
      title: 'Paired with a Factiii account',
      feature: 'the runner',
      required: true,
      async check() {
        return host.paired()
          ? met('config.json is present')
          : {
              state: 'unmet',
              detail: 'This runner is not paired.',
              fix: { kind: 'command', note: [], commands: ['factiii-runner setup'] }
            };
      }
    },
    // The toolchain refuses Windows outright (toolchain.ts), so one line
    // stands in for seven tools that could never be found.
    ...(host.platform === 'win32'
      ? [wslCheck]
      : [
          // One table with the app's Environment list (toolchain.ts).
          ...ENVIRONMENT_TOOLS.map((t) =>
            tool(t.bin, t.title, t.purpose, t.manual)
          ),
          tool(
            'ollama',
            'Ollama',
            'local AI',
            'Install it from ollama.com, or install Homebrew and add the Local AI part.'
          ),
          {
            id: 'local-ai-model',
            title: 'Local AI model',
            feature: 'local AI',
            required: false,
            async check(): Promise<CheckStatus> {
              const model = await host.localAiModel();
              if (model.state === 'ready') return met(model.detail);
              // Nothing fits: the owner's call, so a line, never a fix.
              if (model.state === 'too-small') {
                return {
                  state: 'unmet',
                  detail: model.detail,
                  fix: { kind: 'command', note: [model.detail], commands: [] }
                };
              }
              return {
                state: 'unmet',
                detail: model.detail,
                fix: {
                  kind: 'install',
                  tool: 'local-ai-model',
                  command: `ollama pull ${model.model}`
                }
              };
            }
          } satisfies Check
        ]),
    {
      id: 'vault-engine',
      title: 'Vault database',
      feature: 'the Vault',
      required: false,
      async check() {
        return host.vaultEngine()
          ? met(`${VAULT_ENGINE_PACKAGE} ${VAULT_ENGINE_VERSION}`)
          : {
              state: 'unmet',
              detail: 'Not installed.',
              fix: {
                kind: 'install',
                tool: 'vault-engine',
                command: `npm install ${VAULT_ENGINE_PACKAGE}@${VAULT_ENGINE_VERSION} (into the runner's folder)`
              }
            };
      }
    },
    {
      id: 'vault-embedder',
      title: 'Vault search models',
      feature: 'the Vault',
      required: false,
      async check() {
        const state = host.vaultEmbedder();
        if (state === 'ready') {
          const runtime = process.platform === 'linux' ? 'ONNX Runtime' : 'Core ML';
          return met(`bge-base-en-v1.5 and MobileCLIP2-B on ${runtime}`);
        }
        // Never holds the Vault back where it cannot be built: its files are
        // then found by name only.
        if (state === 'unsupported') {
          return { state: 'unknown', detail: 'Needs a Mac with Apple silicon, or Linux.' };
        }
        return {
          state: 'unmet',
          detail: 'Not installed.',
          fix: {
            kind: 'install',
            tool: 'vault-embedder',
            command: 'Python 3.12 (uv) and the cloud’s search models, built into the runner’s folder'
          }
        };
      }
    },
    {
      id: 'disk-space',
      title: 'Free disk space',
      feature: 'adds, model pulls and vault uploads',
      required: false,
      async check(): Promise<CheckStatus> {
        const read = await health();
        const detail = read.disks.map(diskLine).join('. ');
        if (read.disks.every((d) => d.level === 'ok')) return met(detail);
        return {
          state: 'unmet',
          detail: `${healthHeadline({ ...read, memory: null })} ${detail}.`,
          fix: {
            kind: 'command',
            note: ['See what the runner can free, then confirm:', CLEANUP_SAFE_NOTE],
            commands: ['factiii-runner parts clean']
          }
        };
      }
    },
    {
      id: 'memory',
      title: 'Memory pressure',
      feature: 'local AI and the vault’s search',
      required: false,
      async check(): Promise<CheckStatus> {
        const { memory } = await health();
        if (!memory) return { state: 'unknown', detail: memoryLine(null) };
        return memory === 'ok'
          ? met(memoryLine(memory))
          : { state: 'unmet', detail: memoryLine(memory) };
      }
    },
    {
      id: 'processes',
      title: 'Process count',
      feature: 'SSH, login, jobs and the runner’s own update',
      required: false,
      async check(): Promise<CheckStatus> {
        const { processes } = await health();
        const line = processLine(processes);
        // Read on macOS only (processCount); elsewhere there is nothing to nag about.
        if (!processes || !line) return met('Not read on this system.');
        return processes.level === 'ok' ? met(line) : { state: 'unmet', detail: line };
      }
    }
  ];

  if (mac) {
    checks.push(
      homebrewPathCheck(host),
      {
        id: 'xcode',
        title: 'Xcode',
        feature: 'simulator panel',
        required: false,
        async check() {
          const res = await host.run('xcode-select', ['-p']);
          const dir = res.output.trim();
          // The Command Line Tools alone answer too, and carry no simulator.
          return res.code === 0 && dir.includes('.app/')
            ? met(dir)
            : {
                state: 'unmet',
                detail: 'Xcode is not installed, or the tools point somewhere else.',
                fix: {
                  kind: 'command',
                  note: ['Install Xcode from the App Store and open it once. Then:'],
                  commands: [
                    'sudo xcode-select -s /Applications/Xcode.app/Contents/Developer'
                  ]
                }
              };
        }
      },
      {
        id: 'simulator',
        title: 'An iOS simulator',
        feature: 'simulator panel',
        required: false,
        async check() {
          // After an Xcode update, every simctl call first runs `xcodebuild
          // -runFirstLaunch`, which asks for an admin password. This check
          // repeats, so each run stacked another password prompt on the
          // person's screen. Ask Xcode first (that call never prompts) and
          // leave simctl alone until its setup is done.
          const firstLaunch = await host.run('xcodebuild', ['-checkFirstLaunchStatus']);
          if (firstLaunch.code !== 0) {
            return {
              state: 'unmet',
              detail: 'Xcode needs to finish setting up after an update.',
              fix: {
                kind: 'command',
                note: ['Open Xcode once and let it install its components, or:'],
                commands: ['sudo xcodebuild -runFirstLaunch']
              }
            };
          }
          const res = await host.run('xcrun', [
            'simctl',
            'list',
            'devices',
            'available',
            '-j'
          ]);
          const count = res.code === 0 ? countSimulators(res.output) : 0;
          return count > 0
            ? met(`${count} available`)
            : {
                state: 'unmet',
                detail: 'No simulator is installed.',
                fix: {
                  kind: 'command',
                  note: ['Xcode > Settings > Components installs one, or:'],
                  commands: ['xcodebuild -downloadPlatform iOS']
                }
              };
        }
      }
    );
  }

  const platform = servicePlatform(host.platform);
  if (platform) {
    checks.push(
      {
        id: 'service',
        title: 'Starts at login, restarts after a crash',
        feature: 'always on',
        required: false,
        async check() {
          const status = await host.service();
          if (!status) {
            return {
              state: 'unknown',
              detail: 'Not offered from a source checkout.'
            };
          }
          if (status.installed === 'yes' && status.loaded) {
            return met(
              status.running
                ? `${status.name}, running${status.pid ? ` (pid ${status.pid})` : ''}`
                : `${status.name}, installed, not running now`
            );
          }
          return {
            state: 'unmet',
            detail:
              status.installed === 'foreign'
                ? `${status.file} exists and was not written by the runner.`
                : 'The runner stops when its terminal closes or the machine restarts.',
            fix: {
              kind: 'command',
              note: [],
              commands: ['factiii-runner service install']
            }
          };
        }
      },
      {
        id: 'login',
        title: mac ? 'Automatic login' : 'Starts with nobody logged in',
        feature: 'always on, after a restart with nobody at the machine',
        required: false,
        async check() {
          const fix: Fix = {
            kind: 'command',
            ...loginGuide({ platform, user: host.user })
          };
          if (platform === 'darwin') {
            const res = await host.run('defaults', [
              'read',
              '/Library/Preferences/com.apple.loginwindow',
              'autoLoginUser'
            ]);
            return res.code === 0 && res.output.trim()
              ? met(`logs in as ${res.output.trim()}`)
              : { state: 'unmet', detail: 'Off.', fix };
          }
          if (platform === 'linux') {
            const res = await host.run('loginctl', [
              'show-user',
              host.user,
              '--property=Linger'
            ]);
            return res.output.trim() === 'Linger=yes'
              ? met('lingering is on')
              : { state: 'unmet', detail: 'Lingering is off.', fix };
          }
          return { state: 'unknown', detail: 'The runner does not read this.', fix };
        }
      },
      {
        id: 'power',
        title: mac ? 'Stays awake, restarts after a power failure' : 'Stays awake',
        feature: 'always on',
        required: false,
        async check() {
          const fix: Fix = { kind: 'command', ...powerGuide(platform) };
          if (platform !== 'darwin') {
            return { state: 'unknown', detail: 'The runner does not read this.', fix };
          }
          const res = await host.run('pmset', ['-g']);
          if (res.code !== 0) {
            return { state: 'unknown', detail: 'pmset gave no answer.', fix };
          }
          const power = parsePmset(res.output);
          const detail = `sleep ${power.sleep ?? '?'}, autorestart ${power.autorestart ?? 'not offered on this Mac'}`;
          // A laptop has no autorestart line at all.
          return power.sleep === 0 && power.autorestart !== 0
            ? met(detail)
            : { state: 'unmet', detail, fix };
        }
      }
    );
  }

  return {
    checks,
    refresh() {
      plans = null;
      healthRead = null;
    }
  };
}

const wslCheck: Check = {
  id: 'wsl',
  title: 'WSL2',
  feature: 'boards, terminals and card AI',
  required: true,
  async check() {
    return {
      state: 'unmet',
      detail:
        'Windows has no build of tmux or redis, so a runner that hosts boards runs inside WSL2. Install the runner there.',
      fix: { kind: 'command', note: [], commands: ['wsl --install'] }
    };
  }
};

/** Homebrew on Apple silicon. An Intel Mac's /usr/local/bin is on every
 *  PATH already (/etc/paths), so only this prefix can go missing. */
const APPLE_BREW_BIN = '/opt/homebrew/bin';

/** The line Homebrew's own installer asks a person to add to ~/.zprofile. */
export const BREW_SHELLENV = `eval "$(${APPLE_BREW_BIN}/brew shellenv)"`;

/** Homebrew installed but on no login PATH: the runner still finds its tools
 *  (host-env.ts toolDirs), but the person's own terminal does not, and
 *  neither does anything else started from a login shell. mac-mini-m6
 *  crash-looped on exactly this on 2026-10-25. */
function homebrewPathCheck(host: DoctorHost): Check {
  return {
    id: 'homebrew-path',
    title: 'Homebrew on the login PATH',
    feature: 'every tool Homebrew installed, in your own terminal too',
    required: false,
    async check(): Promise<CheckStatus> {
      if (!host.fileExists(`${APPLE_BREW_BIN}/brew`)) {
        return met('No Homebrew in /opt/homebrew.');
      }
      const loginPath = await host.loginPath();
      if (loginPath === null) {
        return { state: 'unknown', detail: 'The login shell gave no PATH.' };
      }
      if (loginPath.split(path.posix.delimiter).includes(APPLE_BREW_BIN)) {
        return met(`${APPLE_BREW_BIN} is on it`);
      }
      return {
        state: 'unmet',
        detail: 'Homebrew is installed but not on your PATH.',
        fix: {
          kind: 'command',
          note: [
            'Add this line to ~/.zprofile, then open a new terminal:',
            `    ${BREW_SHELLENV}`,
            'Or append it with:'
          ],
          commands: [`echo '${BREW_SHELLENV}' >> ~/.zprofile`]
        }
      };
    }
  };
}

function servicePlatform(platform: NodeJS.Platform): ServicePlatform | null {
  return platform === 'darwin' || platform === 'linux' || platform === 'win32'
    ? platform
    : null;
}

/** `xcrun simctl list devices available -j`: `{ devices: { <runtime>: [...] } }`. */
export function countSimulators(json: string): number {
  try {
    const parsed = JSON.parse(json) as { devices?: Record<string, unknown[]> };
    return Object.values(parsed.devices ?? {}).reduce(
      (sum, list) => sum + (Array.isArray(list) ? list.length : 0),
      0
    );
  } catch {
    return 0;
  }
}

/** `pmset -g`: one ` name   value` a line. Null for a setting it does not list. */
export function parsePmset(output: string): {
  sleep: number | null;
  autorestart: number | null;
} {
  const value = (name: string) => {
    const found = new RegExp(`^\\s*${name}\\s+(\\d+)`, 'm').exec(output)?.[1];
    return found === undefined ? null : Number(found);
  };
  return { sleep: value('sleep'), autorestart: value('autorestart') };
}

// ── Running it ──

export type DoctorResult = Omit<Check, 'check'> & CheckStatus;

export type DoctorUi = {
  print(line: string): void;
  /** Null without a terminal: nothing is asked, so nothing is fixed. */
  confirm: ((question: string) => Promise<boolean>) | null;
  installTool(bin: string, onStatus: (line: string) => void): Promise<void>;
  makeDir(dir: string): void;
  openSettings(url: string): void;
};

const MARK = { met: '[ok]     ', unmet: '[missing]', unknown: '[  ?  ]  ' } as const;
const INDENT = ' '.repeat(MARK.met.length + 1);

/** One item of the report: what it is for, whether it is met, and the fix. */
export function renderResult(result: DoctorResult): string[] {
  const lines = [
    `${MARK[result.state]} ${result.title}  (${result.required ? 'required' : 'optional'}: ${result.feature})`,
    `${INDENT}${result.detail}`
  ];
  const fix = result.state === 'met' ? undefined : result.fix;
  if (fix?.kind === 'install') {
    lines.push(`${INDENT}The runner can install it: ${fix.command}`);
  } else if (fix?.kind === 'folder') {
    lines.push(`${INDENT}The runner can create it.`);
  } else if (fix?.kind === 'command') {
    for (const note of fix.note) lines.push(`${INDENT}${note}`);
    for (const command of fix.commands) lines.push(`${INDENT}    ${command}`);
    if (fix.commands.length) {
      lines.push(`${INDENT}Run that yourself. The runner never runs it.`);
    }
  } else if (fix?.kind === 'settings') {
    lines.push(`${INDENT}${fix.path}`);
  }
  return lines;
}

/** Run each check once, in order. */
export async function evaluate(checks: Check[]): Promise<DoctorResult[]> {
  const results: DoctorResult[] = [];
  for (const { check, ...about } of checks) {
    results.push({ ...about, ...(await check()) });
  }
  return results;
}

/**
 * Print the checklist, offer the fixes the runner may make, and answer with
 * the exit code: 1 while a required item is unmet, 0 otherwise.
 */
export async function runDoctor(
  session: { checks: Check[]; refresh(): void },
  ui: DoctorUi,
  opts: { fix: boolean }
): Promise<{ results: DoctorResult[]; exitCode: number }> {
  let results = await evaluate(session.checks);
  for (const result of results) {
    for (const line of renderResult(result)) ui.print(line);
  }

  const confirm = opts.fix ? ui.confirm : null;
  if (confirm) {
    let changed = false;
    for (const result of results) {
      const fix = result.state === 'unmet' ? result.fix : undefined;
      if (fix?.kind === 'install') {
        ui.print('');
        ui.print(`${result.title}: ${fix.command}`);
        if (!(await confirm('Fix it for me? [Y/n] '))) continue;
        try {
          await ui.installTool(fix.tool, (line) => ui.print(`  ${line}`));
        } catch (err) {
          ui.print(`  ${err instanceof Error ? err.message : String(err)}`);
        }
        changed = true;
      } else if (fix?.kind === 'folder') {
        ui.print('');
        ui.print(`${result.title}: create ${fix.path}`);
        if (!(await confirm('Fix it for me? [Y/n] '))) continue;
        ui.makeDir(fix.path);
        changed = true;
      } else if (fix?.kind === 'settings') {
        ui.print('');
        ui.print(`${result.title}: ${fix.path}`);
        if (await confirm('Open that pane now? [Y/n] ')) ui.openSettings(fix.url);
      }
    }
    if (changed) {
      const before = new Map(results.map((r) => [r.id, r.state]));
      session.refresh();
      results = await evaluate(session.checks);
      ui.print('');
      for (const result of results) {
        if (before.get(result.id) === result.state) continue;
        for (const line of renderResult(result)) ui.print(line);
      }
    }
  }

  const unmet = results.filter((r) => r.state === 'unmet');
  const blocking = unmet.filter((r) => r.required);
  ui.print('');
  if (blocking.length) {
    ui.print(`Not ready: ${blocking.map((r) => r.title).join(', ')}.`);
  } else if (unmet.length) {
    ui.print(
      `Ready. Optional and not set up: ${unmet.map((r) => r.title).join(', ')}.`
    );
  } else {
    ui.print('Ready. Nothing is missing.');
  }
  return { results, exitCode: blocking.length ? 1 : 0 };
}
