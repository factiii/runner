import type {
  EnvironmentFeature,
  EnvironmentFix,
  EnvironmentItem
} from '../../domains/electron';
import { execFileSync } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import type { ExecTarget } from './exec';
import {
  addBinDirs,
  ensureExtraBinDirs,
  invalidatePathCache,
  NPM_PREFIX
} from './host-env';

// Harness dependencies only: what must exist before any agent can run. What
// the WORK needs is the repo's business (check-environment.sh, fixEnvironment).
//
// Where a tool is found, in order (host-env.ts toolDirs): Factiii Desktop's
// tools folder when FACTIII_TOOLS_DIR names one, then /opt/homebrew/bin and
// /usr/local/bin, then the login shell's PATH. Every probe here runs
// `command -v` in a login shell that has those dirs in front, and every host
// spawn takes its PATH from the same shell (hostEnv), so a tool found here is
// the one that runs.

type Tool = {
  bin: string;
  /** Package name per host package manager, when it differs from `bin`. */
  pkg?: { brew?: string; apt?: string; dnf?: string; pacman?: string };
  /** Installed with npm instead of a system package manager. */
  npm?: string;
  /** The only managers that package it, when not all of them do. */
  managers?: PackageManager[];
  /** A Homebrew cask (an app), not a formula. */
  cask?: boolean;
  /** Installed by its own script instead of a package manager, on a Mac
   *  only: a signed release no manager carries in a state that installs. */
  script?: {
    install: string;
    uninstall: string;
    /** What the install does, in one line, wherever a command is shown. */
    summary: string;
    /** Whether this host can run it at all; when not, the row says to
     *  install it by hand instead of offering a button that always fails. */
    supported: () => boolean;
  };
};

// The basics: what Initialize installs, and all a board needs to run a card.
// node lands before the npm CLI. Claude only: Codex is the other provider's
// CLI, added when a board picks it or its sign-in starts (PROVIDER_TOOLS).
// Pins apply to a FRESH install only - an existing CLI is left untouched.
const TOOLS: Tool[] = [
  { bin: 'git' },
  { bin: 'tmux' },
  // Allocates the pty tmux runs on (see tmux.ts). Base-system everywhere in
  // practice; without the probe a stripped image fails as "terminal won't open".
  {
    bin: 'script',
    pkg: { apt: 'bsdutils', dnf: 'util-linux', pacman: 'util-linux' }
  },
  {
    bin: 'node',
    pkg: { brew: 'node', apt: 'nodejs', dnf: 'nodejs', pacman: 'nodejs' }
  },
  { bin: 'claude', npm: '@anthropic-ai/claude-code@~2.1.0' }
];

// A provider CLI past Claude. Initialize adds it for a board whose provider
// it is, and its sign-in installs it first, so nobody installs it by hand.
const PROVIDER_TOOLS: Tool[] = [{ bin: 'codex', npm: '@openai/codex@~0.144.1' }];

/** Tart's signed release, pinned like the npm CLIs. The repo moved from
 *  cirruslabs/tart to openai/tart; both serve the same build. */
const TART_VERSION = '2.41.1';
/** The team that signs Tart.app. A download signed by anyone else is refused. */
const TART_TEAM_ID = '9M2P8L4D89';

/** The hardware, not the process: `uname -m` and `process.arch` both say
 *  x86_64 under Rosetta, and an x64 Node is common on an Apple silicon Mac. */
const APPLE_SILICON_PROBE = 'sysctl -n hw.optional.arm64';

function isAppleSilicon(): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    return (
      execFileSync('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], {
        encoding: 'utf-8'
      }).trim() === '1'
    );
  } catch {
    // An Intel Mac has no such key, and sysctl exits non-zero.
    return false;
  }
}

// Into ~/Applications, linked into ~/.local/bin (one of EXTRA_BIN_DIRS), so
// it needs no root. Apple silicon only: Tart runs on Virtualization.framework,
// which virtualizes macOS on Apple silicon alone.
const TART_SCRIPT = {
  install: [
    'set -e',
    `[ "$(${APPLE_SILICON_PROBE} 2>/dev/null)" = 1 ] || { echo "Tart needs a Mac with Apple silicon."; exit 1; }`,
    'd="$(mktemp -d)"',
    'trap \'rm -rf "$d"\' EXIT',
    `curl -fsSL https://github.com/openai/tart/releases/download/${TART_VERSION}/tart.tar.gz -o "$d/tart.tar.gz"`,
    'tar -xzf "$d/tart.tar.gz" -C "$d"',
    'codesign --verify --deep --strict "$d/tart.app"',
    `codesign -dv "$d/tart.app" 2>&1 | grep -qx 'TeamIdentifier=${TART_TEAM_ID}' || { echo "Tart.app is not signed by Cirrus Labs."; exit 1; }`,
    'mkdir -p "$HOME/Applications" "$HOME/.local/bin"',
    // Copied in beside the old app, then swapped, so a copy cut short (a
    // full disk) leaves the old one working rather than nothing at all.
    'rm -rf "$HOME/Applications/.tart.app.new"',
    'cp -R "$d/tart.app" "$HOME/Applications/.tart.app.new"',
    'rm -rf "$HOME/Applications/tart.app"',
    'mv "$HOME/Applications/.tart.app.new" "$HOME/Applications/tart.app"',
    'ln -sf "$HOME/Applications/tart.app/Contents/MacOS/tart" "$HOME/.local/bin/tart"'
  ].join('\n'),
  // Its VMs stay in ~/.tart: removing the tool is not deleting the machines.
  uninstall: 'rm -f "$HOME/.local/bin/tart" && rm -rf "$HOME/Applications/tart.app"',
  summary: `Download Tart ${TART_VERSION} from GitHub, signed by Cirrus Labs, into ~/Applications`,
  supported: isAppleSilicon
};

// Extras the owner adds one at a time from the Environment list: a board runs
// without them. Redis carries live agent status in terminals (agentState.ts);
// OrbStack runs containers, for a repo whose dev stack is a compose file.
// Tailscale, the way in when Factiii is down, is only looked for: installing
// it needs root and a tailnet sign-in, which belong to Factiii Desktop, not to
// an npm package (npm pulled 0.28.0 and 0.33.0 as malware; see CHANGELOG).
const EXTRA_TOOLS: Tool[] = [
  {
    bin: 'redis-server',
    pkg: { brew: 'redis', apt: 'redis-server', dnf: 'redis', pacman: 'redis' }
  },
  // `orb` is OrbStack's own CLI; it also puts `docker` on the PATH. A Mac
  // app, so Homebrew alone: elsewhere Docker is installed by hand.
  { bin: 'orb', pkg: { brew: 'orbstack' }, cask: true, managers: ['brew'] },
  // No managers: probed for the Environment list and Ready to be a server,
  // never installed by the runner.
  { bin: 'tailscale', managers: [] },
  // Tart runs macOS VMs: a fresh Mac to try the desktop app or a runner on.
  // Its Homebrew tap no longer installs (it fails Homebrew's own checks).
  { bin: 'tart', managers: ['brew'], script: TART_SCRIPT }
];

// Not harness dependencies: a space initializes without them, and the secrets
// store names them itself when it is first used (host-secrets.ts). Here so
// `factiii-runner doctor` installs them the way it installs the rest.
const SECRETS_TOOLS: Tool[] = [
  // Debian, Ubuntu and Fedora do not package sops.
  { bin: 'sops', managers: ['brew', 'pacman'] },
  // The binary the secrets store probes; the package is `age`.
  {
    bin: 'age-keygen',
    pkg: { brew: 'age', apt: 'age', dnf: 'age', pacman: 'age' }
  }
];

// A runner part's own tools (apps/runner parts.ts): installed only when the
// owner adds that part. Ollama is packaged by Homebrew alone; elsewhere it is
// installed by hand.
const PART_TOOLS: Tool[] = [{ bin: 'ollama', managers: ['brew'] }];

/** Every tool the runner knows how to install. */
const ALL_TOOLS = [
  ...TOOLS,
  ...PROVIDER_TOOLS,
  ...EXTRA_TOOLS,
  ...SECRETS_TOOLS,
  ...PART_TOOLS
];

/** Which system package manager this host has, or null when none is usable. */
async function detectPackageManager(
  target: ExecTarget
): Promise<PackageManager | null> {
  for (const mgr of ['brew', 'apt-get', 'dnf', 'pacman'] as const) {
    try {
      await target.sh(`command -v ${mgr}`);
      return mgr === 'apt-get' ? 'apt' : mgr;
    } catch {
      // try the next one
    }
  }
  return null;
}

type PackageManager = 'brew' | 'apt' | 'dnf' | 'pacman';

const MINUTE = 60_000;
const NPM_TIMEOUT_MS = 15 * MINUTE;
const PACKAGE_TIMEOUT_MS = 30 * MINUTE;
// On a macOS release Homebrew has stopped bottling, every formula and its
// dependencies compile from source, which outlasts any short timeout on a slow
// machine. Silence cannot stand in for a hang either: a source build prints
// nothing for minutes at a stretch, even under HOMEBREW_VERBOSE.
const BREW_TIMEOUT_MS = 3 * 60 * MINUTE;
// Downloads Command Line Tools on a clean Mac.
const BREW_BOOTSTRAP_TIMEOUT_MS = 60 * MINUTE;

function installTimeout(tool: Tool, mgr: PackageManager): number {
  if (tool.npm || tool.script) return NPM_TIMEOUT_MS;
  return mgr === 'brew' ? BREW_TIMEOUT_MS : PACKAGE_TIMEOUT_MS;
}

/** Install command for one tool. Linux managers go through `sudo -n` so a
 *  missing credential fails fast instead of hanging on a prompt. */
function installCommand(tool: Tool, mgr: PackageManager): string {
  // --prefix keeps this out of npm's root-owned global prefix; see NPM_PREFIX.
  if (tool.npm) return `npm install -g --prefix "${NPM_PREFIX}" ${tool.npm}`;
  if (tool.script) return tool.script.install;
  const pkg = tool.pkg?.[mgr] ?? tool.bin;
  switch (mgr) {
    case 'brew':
      return `brew install ${tool.cask ? '--cask ' : ''}${pkg}`;
    case 'apt':
      return `sudo -n apt-get install -y ${pkg}`;
    case 'dnf':
      return `sudo -n dnf install -y ${pkg}`;
    case 'pacman':
      return `sudo -n pacman -S --noconfirm ${pkg}`;
  }
}

async function isInstalled(target: ExecTarget, bin: string): Promise<boolean> {
  try {
    await target.sh(`command -v ${bin}`);
  } catch {
    return false;
  }
  return !(await isGitStub(target, bin));
}

async function isGitStub(target: ExecTarget, bin: string): Promise<boolean> {
  // macOS ships a /usr/bin/git STUB that pops a GUI dialog when invoked, so
  // Command Line Tools being present is the real test.
  if (bin === 'git' && process.platform === 'darwin') {
    try {
      await target.sh('xcode-select -p');
    } catch {
      return true;
    }
  }
  return false;
}

/** Last line of a login shell's output, which is the answer once shell-init
 *  noise is dropped. Empty when the command failed. */
async function probe(target: ExecTarget, cmd: string): Promise<string> {
  try {
    const out = await target.sh(cmd);
    return out.trim().split('\n').pop()?.trim() ?? '';
  } catch {
    return '';
  }
}

/** Put npm's OWN configured prefix on PATH too. Setting `prefix` in .npmrc is
 *  the usual way to dodge the root-owned default, so on such a host that dir
 *  holds the agent CLIs - and the shell line that exports it is typically in
 *  .zshrc, which a login shell never reads. Found at runtime because the dir
 *  is the user's choice (~/.npm-global, ~/.node, ...), not a fixed path. */
async function addNpmPrefixBin(target: ExecTarget): Promise<void> {
  const prefix = await probe(target, 'npm config get prefix');
  if (prefix.startsWith('/')) addBinDirs([`${prefix}/bin`]);
}

const BREW_INSTALL =
  'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';

export type ToolPlan = {
  bin: string;
  /** Where it resolves on the login PATH. Empty when it is missing. */
  location: string;
  /** How this host installs it, and whether that needs root. Null when the
   *  runner knows no package for it here. */
  install: { command: string; sudo: boolean } | null;
};

function installPlan(
  tool: Tool,
  mgr: PackageManager | null
): ToolPlan['install'] {
  // provision() refuses Windows for the same reason.
  if (process.platform === 'win32') return null;
  // Looked for only (Tailscale): nothing here installs it.
  if (tool.managers?.length === 0) return null;
  if (tool.npm) return { command: installCommand(tool, 'brew'), sudo: false };
  // Its own script, so no package manager to bootstrap first.
  if (tool.script) {
    return tool.script.supported()
      ? { command: tool.script.summary, sudo: false }
      : null;
  }
  if (!mgr) {
    if (process.platform !== 'darwin') return null;
    // For a person to paste: Homebrew's installer asks for the password.
    const brew = BREW_INSTALL.replace('NONINTERACTIVE=1 ', '');
    return {
      command: `${brew} && ${installCommand(tool, 'brew')}`,
      sudo: true
    };
  }
  if (tool.managers && !tool.managers.includes(mgr)) return null;
  return {
    command: installCommand(tool, mgr).replace('sudo -n ', 'sudo '),
    sudo: mgr !== 'brew'
  };
}

/** Where every tool `factiii-runner doctor` lists actually resolves, and how
 *  this host would install it. An environment failure cannot distinguish "not
 *  installed" from "installed somewhere off the login PATH", and that is the
 *  difference between a real fix and a wasted reinstall. Read-only, and reads
 *  the same TOOLS as the installer. */
export async function planTools(target: ExecTarget): Promise<ToolPlan[]> {
  ensureExtraBinDirs();
  await addNpmPrefixBin(target);
  const mgr = await detectPackageManager(target);
  const plans: ToolPlan[] = [];
  for (const tool of ALL_TOOLS) {
    const found = await probe(target, `command -v ${tool.bin}`);
    const location = found && !(await isGitStub(target, tool.bin)) ? found : '';
    plans.push({ bin: tool.bin, location, install: installPlan(tool, mgr) });
  }
  return plans;
}

/** What each tool is for. One table for `factiii-runner doctor` and for the
 *  app's Environment list (`environmentStatus`). `required` is what a board's
 *  Initialize needs (TOOLS); the rest are extras the owner adds. The doctor
 *  lists every tool as optional, by the runner part that needs it (apps/runner
 *  parts.ts). Every `bin` is in ALL_TOOLS. */
export const ENVIRONMENT_TOOLS: {
  bin: string;
  title: string;
  feature: EnvironmentFeature;
  /** What stops working without it, in the doctor's words. */
  purpose: string;
  required: boolean;
  /** What to do where the runner knows no package for it. */
  manual?: string;
}[] = [
  {
    bin: 'git',
    title: 'git',
    feature: 'boards',
    purpose: 'boards (cloning the repository)',
    required: true
  },
  {
    bin: 'tmux',
    title: 'tmux',
    feature: 'terminals',
    purpose: 'terminals',
    required: true
  },
  {
    bin: 'script',
    title: 'script',
    feature: 'terminals',
    purpose: 'terminals (it gives tmux its pty)',
    required: true
  },
  {
    bin: 'redis-server',
    title: 'redis',
    feature: 'terminals',
    purpose: 'live agent status in terminals (working, idle, waiting on you)',
    required: false
  },
  {
    bin: 'node',
    title: 'node on the login PATH',
    feature: 'card-ai',
    purpose: 'card AI (the agent CLIs are Node programs)',
    required: true
  },
  {
    bin: 'claude',
    title: 'claude CLI',
    feature: 'card-ai',
    purpose: 'card AI',
    required: true
  },
  {
    bin: 'codex',
    title: 'codex CLI',
    feature: 'card-ai',
    purpose: 'card AI with Codex (its sign-in installs it)',
    required: false
  },
  {
    bin: 'sops',
    title: 'sops',
    feature: 'secrets',
    purpose: 'secrets',
    required: false,
    manual:
      'Download it from https://github.com/getsops/sops/releases and put it on PATH.'
  },
  {
    bin: 'age-keygen',
    title: 'age',
    feature: 'secrets',
    purpose: 'secrets',
    required: false
  },
  {
    bin: 'orb',
    title: 'OrbStack',
    feature: 'containers',
    purpose: 'containers (a repository’s docker compose stack)',
    required: false,
    manual: 'Install Docker for this system, or OrbStack on a Mac (orbstack.dev).'
  },
  {
    bin: 'tailscale',
    title: 'Tailscale',
    feature: 'remote',
    purpose:
      'remote access (Screen Sharing and SSH over your tailnet, even when Factiii is down)',
    required: false,
    manual:
      'Install Tailscale with the Factiii desktop app, or from https://tailscale.com/download, and sign in.'
  },
  {
    bin: 'tart',
    title: 'Tart',
    feature: 'vms',
    purpose: 'macOS virtual machines (a fresh Mac to test the desktop app on)',
    required: false,
    manual:
      'Tart runs on a Mac with Apple silicon. Download it from https://github.com/openai/tart/releases.'
  }
];

/** Who installs a missing tool on this host, as the app's list says it.
 *  Initialize installs the basic TOOLS: with npm and brew as they are, with
 *  apt, dnf or pacman through `sudo -n`, after asking for the password when
 *  sudo is not passwordless. Every other tool is an extra its own Install
 *  button adds (`installExtra`), the same way. Neither can install what this
 *  host has no package for. The extra's `command` is for an app from before
 *  `install`, which shows it as a command to paste. */
export function environmentFix(
  bin: string,
  install: ToolPlan['install'],
  passwordlessSudo: boolean
): EnvironmentFix {
  if (!install) return { by: 'hand' };
  const password = install.sudo && !passwordlessSudo;
  if (TOOLS.some((tool) => tool.bin === bin)) {
    return { by: 'initialize', password };
  }
  return { by: 'install', password, command: install.command };
}

/** The environment tool by tool, for the app: what is on the login PATH, and
 *  who installs the rest. One probe pass (`planTools`), nothing written, and
 *  no real sudo command: `sudo -n true` only asks whether one would need a
 *  password, once, and only when an answer depends on it. Empty on Windows,
 *  where the toolchain cannot exist outside WSL. */
export async function environmentStatus(
  target: ExecTarget
): Promise<EnvironmentItem[]> {
  if (process.platform === 'win32') return [];
  const plans = await planTools(target);
  const missing = plans.filter((plan) => !plan.location);
  const passwordlessSudo = missing.some((plan) => plan.install?.sudo)
    ? await target.sh('sudo -n true').then(
        () => true,
        () => false
      )
    : false;
  return ENVIRONMENT_TOOLS.map((tool) => {
    const plan = plans.find((p) => p.bin === tool.bin);
    const present = Boolean(plan?.location);
    return {
      id: tool.bin,
      title: tool.title,
      feature: tool.feature,
      required: tool.required,
      state: present ? 'ok' : 'missing',
      fix: present
        ? null
        : environmentFix(tool.bin, plan?.install ?? null, passwordlessSudo)
    };
  });
}

/** Install one tool the way Initialize would. Only where that needs no root:
 *  the doctor prints the command for the rest and never runs it. */
export async function installTool(
  target: ExecTarget,
  bin: string,
  onStatus: (line: string) => void
): Promise<void> {
  const tool = ALL_TOOLS.find((t) => t.bin === bin);
  if (!tool) throw new Error(`Unknown tool: ${bin}`);
  const mgr = await detectPackageManager(target);
  const plan = installPlan(tool, mgr);
  if (!plan || plan.sudo) {
    throw new Error(`${bin} cannot be installed here without an administrator.`);
  }
  const failure = await installOne(target, tool, mgr ?? 'brew', onStatus);
  if (failure) throw new Error(failure);
}

/** `@scope/name@~1.2.0` without its version pin; a scope's leading @ stays. */
export function npmPackageName(spec: string): string {
  const at = spec.lastIndexOf('@');
  return at > 0 ? spec.slice(0, at) : spec;
}

/** Uninstall one tool the runner installed (`factiii-runner parts remove`).
 *  Only where that needs no root: npm into the runner's prefix, or Homebrew.
 *  Otherwise it throws with the command for a person to run. */
export async function uninstallTool(
  target: ExecTarget,
  bin: string,
  onStatus: (line: string) => void
): Promise<void> {
  const tool = ALL_TOOLS.find((t) => t.bin === bin);
  if (!tool) throw new Error(`Unknown tool: ${bin}`);
  const mgr =
    tool.npm || tool.script ? 'brew' : await detectPackageManager(target);
  if (!tool.npm && mgr !== 'brew') {
    const pkg = (mgr && tool.pkg?.[mgr]) ?? tool.bin;
    throw new Error(
      `${bin} needs an administrator to remove. Run it yourself if you want it gone, e.g. sudo apt-get remove ${pkg}`
    );
  }
  let cmd = `brew uninstall ${tool.pkg?.brew ?? tool.bin}`;
  if (tool.npm) {
    cmd = `npm uninstall -g --prefix "${NPM_PREFIX}" ${npmPackageName(tool.npm)}`;
  }
  if (tool.script) cmd = tool.script.uninstall;
  onStatus(`Removing ${bin}…`);
  await runStreaming(target, cmd, onStatus, installTimeout(tool, 'brew'));
  invalidatePathCache();
  if (await isInstalled(target, bin)) {
    throw new Error(`${bin} is still on the PATH: another copy is installed.`);
  }
  onStatus(`Removed ${bin}.`);
}

/** Install whatever of the basics is missing, plus `providers` (a board's
 *  provider CLI past Claude, e.g. `codex`), reporting each step through
 *  `onStatus`. Throws only if a tool is still absent after its install ran
 *  twice. */
export async function ensureToolchain(
  target: ExecTarget,
  onStatus: (line: string) => void,
  requestSudo?: RequestSudo,
  providers: readonly string[] = []
): Promise<void> {
  // Probing costs a login shell per tool, so only do it once per process
  // and set of tools. Cleared on failure so a retry re-probes.
  const key = [...providers].sort().join(',');
  let run = ensured.get(key);
  if (!run) {
    run = provision(target, onStatus, requestSudo, providers).catch(
      (err: unknown) => {
        ensured.delete(key);
        throw err;
      }
    );
    ensured.set(key, run);
  }
  return run;
}

const ensured = new Map<string, Promise<void>>();

/** Install one extra from the app's Environment list (its Install button), or
 *  a provider CLI before its sign-in. Like Initialize, it bootstraps Homebrew
 *  on a Mac that has none and asks for the password where the install needs
 *  root. A tool already on the PATH is left as it is. */
export async function installExtra(
  target: ExecTarget,
  bin: string,
  onStatus: (line: string) => void,
  requestSudo?: RequestSudo
): Promise<void> {
  const tool = ALL_TOOLS.find((t) => t.bin === bin);
  if (!tool) throw new Error(`Unknown tool: ${bin}`);
  if (process.platform === 'win32') {
    throw new Error(`${bin} installs inside WSL2 on Windows, not here.`);
  }
  if (tool.managers?.length === 0) {
    throw new Error(
      `The runner does not install ${bin}. Install it with the Factiii desktop app, or by hand.`
    );
  }
  ensureExtraBinDirs();
  await addNpmPrefixBin(target);
  if (await isInstalled(target, bin)) return;
  await installTools(target, [tool], onStatus, requestSudo);
}

/** Ask the owner for their sudo password. Resolves null when they decline. */
export type RequestSudo = (reason: string) => Promise<string | null>;

/** sudo, primed: `ok` once installs needing root can run unattended.
 *  `password` is kept only for Homebrew's installer, whose own sudo calls
 *  cannot see the timestamp `sudo -v` left (see bootstrapBrew). */
type SudoGrant = { ok: boolean; password: string | null };

/** Prime sudo once so the installs run unattended. Password rides stdin, never
 *  argv where `ps` would show it, and is dropped once the install ends. */
async function primeSudo(
  target: ExecTarget,
  requestSudo: RequestSudo | undefined,
  onStatus: (line: string) => void
): Promise<SudoGrant> {
  try {
    await target.sh('sudo -n true');
    // already passwordless or still cached
    return { ok: true, password: null };
  } catch {
    // needs a password
  }
  if (!requestSudo) return { ok: false, password: null };
  const password = await requestSudo(
    'Installing system packages needs your password.'
  );
  if (!password) return { ok: false, password: null };
  try {
    // -S reads the password from stdin; -v only refreshes the timestamp.
    await target.runWithStdin(
      ['sudo', '-S', '-v'],
      `${password}\n`,
      'sudo authentication'
    );
  } catch {
    onStatus('Password was not accepted.');
    return { ok: false, password: null };
  }
  return { ok: true, password };
}

/** Install Homebrew on a Mac that has none. macOS keeps sudo's timestamp per
 *  terminal, and with no terminal per parent process, so the one `sudo -v`
 *  left is invisible to the installer's own sudo calls: given the password,
 *  it answers them through SUDO_ASKPASS, a 0700 script in a private temp dir
 *  that is removed the moment the installer exits. Throws the installer's own
 *  words when it fails (most often: this account is not an administrator),
 *  rather than the "no package manager" that would follow. */
async function bootstrapBrew(
  target: ExecTarget,
  password: string | null,
  onStatus: (line: string) => void
): Promise<void> {
  onStatus('Homebrew not found');
  onStatus('Installing Homebrew…');
  const dir = password
    ? await fs.mkdtemp(path.join(os.tmpdir(), 'factiii-askpass-'))
    : null;
  try {
    let env: Record<string, string> | undefined;
    if (dir && password) {
      const askpass = path.join(dir, 'askpass');
      // Single-quoted for sh, with each ' closed, escaped and reopened.
      const quoted = `'${password.replace(/'/g, `'\\''`)}'`;
      await fs.writeFile(askpass, `#!/bin/sh\nprintf '%s\\n' ${quoted}\n`, {
        mode: 0o700
      });
      env = { SUDO_ASKPASS: askpass };
    }
    const result = await runStep(
      target,
      BREW_INSTALL,
      onStatus,
      BREW_BOOTSTRAP_TIMEOUT_MS,
      env
    );
    invalidatePathCache();
    if (!result.ok) {
      throw new Error(
        `Homebrew did not install. Homebrew needs an administrator account on this Mac.\n\n${result.output.slice(-2000)}`
      );
    }
  } finally {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
  onStatus('Installed Homebrew.');
}

async function provision(
  target: ExecTarget,
  onStatus: (line: string) => void,
  requestSudo: RequestSudo | undefined,
  providers: readonly string[]
): Promise<void> {
  if (process.platform === 'win32') {
    throw new Error(
      'Windows is not supported directly: the runner needs tmux, which has no Windows build. Install the runner inside WSL2 instead.'
    );
  }
  // Before the first probe, or a CLI installed under .zshrc's PATH reads as
  // missing and gets reinstalled over the top of itself.
  ensureExtraBinDirs();
  await addNpmPrefixBin(target);

  // Probe everything first so the log leads with what is actually missing
  // instead of interleaving checks and installs.
  const wanted = [
    ...TOOLS,
    ...PROVIDER_TOOLS.filter((tool) => providers.includes(tool.bin))
  ];
  const missing: Tool[] = [];
  for (const tool of wanted) {
    if (!(await isInstalled(target, tool.bin))) missing.push(tool);
  }
  if (!missing.length) return;
  await installTools(target, missing, onStatus, requestSudo);
}

/** Install `missing`, bootstrapping Homebrew on a Mac without it and asking
 *  for the password once when anything needs root. */
async function installTools(
  target: ExecTarget,
  missing: Tool[],
  onStatus: (line: string) => void,
  requestSudo: RequestSudo | undefined
): Promise<void> {
  let mgr = await detectPackageManager(target);
  // npm-only tools ride on node, which is in TOOLS, so a host with node but no
  // package manager can still install the agent CLIs.
  const needsManager = missing.some((t) => !t.npm && !t.script);

  // One prompt fronts everything needing root. brew installs need no sudo, so
  // a Mac that already has brew is never asked.
  const needsRoot =
    needsManager &&
    (mgr === 'apt' || mgr === 'dnf' || mgr === 'pacman' || mgr === null);
  const sudo = needsRoot
    ? await primeSudo(target, requestSudo, onStatus)
    : { ok: false, password: null };

  // A clean Mac has no package manager, so bootstrap one. The installer writes
  // brew onto the login shell's PATH, which execLogin re-reads.
  if (!mgr && needsManager && process.platform === 'darwin') {
    if (!sudo.ok) {
      throw new Error(
        `Installing ${missing.map((t) => t.bin).join(', ')} needs Homebrew, and installing Homebrew needs this computer’s password. Try again and enter it when asked.`
      );
    }
    await bootstrapBrew(target, sudo.password, onStatus);
    mgr = await detectPackageManager(target);
  }

  if (!mgr && needsManager) {
    throw new Error(
      `Missing tools (${missing.map((t) => t.bin).join(', ')}) and no package manager was found on this runner. Install your distro's package manager, then try again.`
    );
  }
  // Skips what this host has no package for (OrbStack off a Mac): its row
  // says to install it by hand.
  const unpackaged = missing.filter((t) => !installPlan(t, mgr));
  if (unpackaged.length) {
    throw new Error(
      `No package for ${unpackaged.map((t) => t.bin).join(', ')} here. Install it by hand.`
    );
  }

  const manager = mgr ?? 'brew';
  // One tool failing must not cost the rest their install, so each pass runs
  // every tool and collects the failures instead of stopping at the first.
  const installAll = async (tools: Tool[]): Promise<Failure[]> => {
    const failures: Failure[] = [];
    for (const tool of tools) {
      const message = await installOne(target, tool, manager, onStatus);
      if (message) failures.push({ tool, message });
    }
    return failures;
  };

  let failed = await installAll(missing);
  if (failed.length) {
    // A second pass picks up what the first left behind: a build cut off
    // partway keeps the dependencies it finished, and an npm CLI that failed
    // for want of node now has it.
    onStatus(`Retrying ${failed.map((f) => f.tool.bin).join(', ')}…`);
    failed = await installAll(failed.map((f) => f.tool));
  }
  if (failed.length) {
    throw new Error(failed.map((f) => f.message).join('\n\n'));
  }
}

type Failure = { tool: Tool; message: string };

/** Install one tool. Resolves the failure message, or null once it is on PATH. */
async function installOne(
  target: ExecTarget,
  tool: Tool,
  mgr: PackageManager,
  onStatus: (line: string) => void
): Promise<string | null> {
  onStatus(`${tool.bin} not found`);
  const cmd = installCommand(tool, mgr);
  onStatus(`Installing ${tool.bin}…`);
  const output = await runStreaming(
    target,
    cmd,
    onStatus,
    installTimeout(tool, mgr)
  );
  // The new binary is only on PATH for shells started after this point.
  invalidatePathCache();

  // `command -v` is the real check: brew exits 0 on "already installed" and
  // some installers exit 0 having done nothing useful.
  if (await isInstalled(target, tool.bin)) {
    onStatus(`Installed ${tool.bin}.`);
    return null;
  }
  onStatus(`Could not install ${tool.bin}.`);
  // The PATH goes in the message because the usual cause is a binary that
  // installed fine but landed off the login shell's PATH - unreadable from
  // the installer output alone, and the first thing to check by hand.
  const searched = await target
    .sh('printf %s "$PATH"')
    .catch(() => '<unavailable>');
  return `Failed to install ${tool.bin} with \`${cmd}\`.\n\nSearched PATH: ${searched.trim()}\n\n${output.slice(-2000)}`;
}

/** Run an installer, forwarding each new line. These take minutes, and a
 *  frozen "Installing…" line reads as a hang. */
async function runStreaming(
  target: ExecTarget,
  cmd: string,
  onStatus: (line: string) => void,
  timeoutMs: number
): Promise<string> {
  return (await runStep(target, cmd, onStatus, timeoutMs)).output;
}

/** runStreaming, with whether the command succeeded, for a caller whose next
 *  step would otherwise hide the failure. */
export async function runStep(
  target: ExecTarget,
  cmd: string,
  onStatus: (line: string) => void,
  timeoutMs: number,
  env?: Record<string, string>
): Promise<{ ok: boolean; output: string }> {
  let seen = 0;
  const started = Date.now();
  let lastLine = started;
  // A build that has gone quiet still has to look alive.
  const beat = setInterval(() => {
    if (Date.now() - lastLine < MINUTE) return;
    const minutes = Math.round((Date.now() - started) / MINUTE);
    onStatus(`Still working… (${minutes} min)`);
  }, MINUTE);
  try {
    const result = await target.step(cmd, {
      timeoutMs,
      env,
      onOutput: (combined) => {
        const fresh = combined.slice(seen);
        seen = combined.length;
        for (const line of fresh.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          lastLine = Date.now();
          onStatus(trimmed);
        }
      }
    });
    return { ok: result.ok, output: result.stdout };
  } finally {
    clearInterval(beat);
  }
}
