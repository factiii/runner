import os from 'node:os';
import path from 'node:path';

// How the runner reaches the dev VM (.specs/dev-vm.md): plain `ssh`, with the
// config Lima writes for the instance, rather than `colima ssh` or
// `limactl shell`. Both of those log in only as the Lima user (who has sudo)
// and add a cd-to-the-host's-cwd step; ssh gives us the session user, real
// argv and stdio, `-R` for the narrow path's socket, and a ControlMaster so a
// command costs a few milliseconds instead of a handshake.

/** The VM's unprivileged user. Every session runs as this one: no sudo, not
 *  in the docker group, so it cannot lift the firewall or reach the docker
 *  socket. Admin work logs in as the Lima user and uses sudo. */
export const SESSION_USER = 'factiii';

/** Where the tokens pushed into the VM live: on /run, which is tmpfs, so they
 *  are never on the VM's disk (and the VM has no swap). */
export const VM_TOKEN_DIR = '/run/factiii-tokens';

/** In the VM, sources a space's token file and execs the rest. */
export const VM_ENV_BIN = '/usr/local/bin/factiii-vm-env';
/** In the VM, runs a command and takes it down when the ssh connection that
 *  started it goes (see guest.ts). */
export const VM_RUN_BIN = '/usr/local/bin/factiii-vm-run';

/** PATH inside the VM. The space's bin dir goes in front (agentEnv). */
export const VM_PATH =
  '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export type VmHandle = {
  profile: string;
  /** Lima's name for the instance: `colima`, or `colima-<profile>`. */
  instance: string;
  /** The ssh config Lima writes on every start (the port changes). */
  sshConfig: string;
  /** The Host alias in that config. */
  host: string;
  /** Our ControlMaster sockets: short, since a socket path is capped at 104
   *  bytes on macOS. */
  controlDir: string;
};

/** Lima's instance name for a Colima profile. */
export function limaInstance(profile: string): string {
  return profile === 'default' ? 'colima' : `colima-${profile}`;
}

/** Where Colima keeps Lima's instances. */
export function limaHome(env: NodeJS.ProcessEnv = process.env): string {
  const colimaHome =
    env.COLIMA_HOME?.trim() || path.join(os.homedir(), '.colima');
  return env.LIMA_HOME?.trim() || path.join(colimaHome, '_lima');
}

export function vmHandle(
  profile: string,
  opts: { limaHome?: string; controlDir: string }
): VmHandle {
  const instance = limaInstance(profile);
  const home = opts.limaHome ?? limaHome();
  return {
    profile,
    instance,
    sshConfig: path.join(home, instance, 'ssh.config'),
    host: `lima-${instance}`,
    controlDir: opts.controlDir
  };
}

/** One argument, quoted for a POSIX shell. */
export function shQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function shJoin(argv: string[]): string {
  return argv.map(shQuote).join(' ');
}

export type VmUser = 'admin' | 'session';

function baseArgv(vm: VmHandle, user: VmUser, mux = true): string[] {
  return [
    'ssh',
    '-F',
    vm.sshConfig,
    // Our own mux, keyed by user too (%C hashes local host, remote host,
    // port and user). Lima's config sets a ControlPath with no user in it,
    // which would hand a session command to the Lima user's master. ssh
    // takes the first value it is given, so this beats the config's.
    '-o',
    mux ? `ControlPath=${vm.controlDir}/%C` : 'ControlPath=none',
    '-o',
    'LogLevel=ERROR',
    ...(user === 'session' ? ['-l', SESSION_USER] : [])
  ];
}

/** The ssh argv up to and including `--`; the remote command follows. Uses
 *  the master when one is up (masterArgv) and never becomes one: a master
 *  forked from a session's ssh would sit in that session's process group,
 *  and ending the session (killTree) would take every other command down.
 *
 *  `mux: false` is for a long-lived process that must end with its ssh (an
 *  agent CLI): over the master, its parent in the VM is the master's sshd,
 *  which outlives every session, so VM_RUN_BIN could not tell the runner
 *  had let go. On a connection of its own, its parent goes with it. */
export function sshArgv(
  vm: VmHandle,
  user: VmUser,
  opts: { tty?: boolean; extra?: string[]; mux?: boolean } = {}
): string[] {
  return [
    ...baseArgv(vm, user, opts.mux ?? true),
    '-o',
    'ControlMaster=no',
    opts.tty ? '-tt' : '-T',
    ...(opts.extra ?? []),
    vm.host,
    '--'
  ];
}

/** Start the user's ControlMaster in the background (`-f -N`): its own
 *  process, which nothing a session does can kill. */
export function masterArgv(vm: VmHandle, user: VmUser): string[] {
  return [
    ...baseArgv(vm, user),
    '-o',
    'ControlMaster=yes',
    '-o',
    'ControlPersist=600',
    '-f',
    '-N',
    vm.host
  ];
}

/** Whether the user's master is up: `ssh -O check`. */
export function masterCheckArgv(vm: VmHandle, user: VmUser): string[] {
  return [...baseArgv(vm, user), '-O', 'check', vm.host];
}

/** Env names never carried into the VM: they describe this host, and a
 *  value from here is wrong (or a leak) there. */
const HOST_ONLY_ENV = new Set([
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'PWD',
  'OLDPWD',
  'SSH_AUTH_SOCK',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'XPC_SERVICE_NAME',
  'XPC_FLAGS',
  '__CF_USER_TEXT_ENCODING'
]);

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** What a command in the VM gets from an env built on this host. The space's
 *  directories are at the same paths in the VM, so values carry over as they
 *  are; PATH is the VM's own, with the space's bin dir kept in front when the
 *  caller put it there. */
export function vmEnv(
  env: Record<string, string> | undefined,
  bin: string
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!ENV_NAME.test(key) || HOST_ONLY_ENV.has(key)) continue;
    if (key === 'PATH') continue;
    out[key] = value;
  }
  const wantsBin = (env?.PATH ?? '').split(':').includes(bin);
  out.PATH = wantsBin ? `${bin}:${VM_PATH}` : VM_PATH;
  return out;
}

/**
 * The remote command line for argv, as the session user's shell runs it:
 * cd, then the space's tokens (VM_ENV_BIN), optionally the supervisor
 * (VM_RUN_BIN), then the env and argv. A cwd that does not exist in the VM
 * falls back to home rather than failing, as the host target does.
 */
export function remoteCommand(
  argv: string[],
  opts: {
    slug: string;
    cwd?: string;
    env?: Record<string, string>;
    supervise?: boolean;
    mergeStderr?: boolean;
  }
): string {
  const cd = opts.cwd
    ? `cd ${shQuote(opts.cwd)} 2>/dev/null || cd; `
    : 'cd; ';
  const env = Object.entries(opts.env ?? {}).map(
    ([key, value]) => `${key}=${value}`
  );
  const command = [
    VM_ENV_BIN,
    opts.slug,
    ...(opts.supervise ? [VM_RUN_BIN] : []),
    'env',
    ...env,
    ...argv
  ];
  return `${cd}exec ${shJoin(command)}${opts.mergeStderr ? ' 2>&1' : ''}`;
}
