import type { ChildProcess } from 'node:child_process';

import { SESSION_USER, type VmHandle } from './ssh';
import type { SpawnFn } from './vmTarget';

// The narrow path's carrier (.specs/dev-vm.md): one ssh connection from the
// Mac INTO the VM, as the session user, that forwards each space's narrow
// path socket (narrowPath.ts) to the path sessions use in the VM
// (`<space>/state/secrets.sock`). Into, not out of: the VM opens nothing to
// the Mac, so the firewall needs no hole, and the socket in the VM is the
// session user's (sshd creates it 0600 as the user it logged in).
//
// Its own connection (no ControlMaster), so a forward lives and dies with
// this process, and restarted with a backoff when it drops.

export type Forward = { vmPath: string; hostPath: string };

export function tunnelArgv(vm: VmHandle, forwards: Forward[]): string[] {
  return [
    'ssh',
    '-F',
    vm.sshConfig,
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'LogLevel=ERROR',
    '-l',
    SESSION_USER,
    '-N',
    '-T',
    ...forwards.flatMap((f) => ['-R', `${f.vmPath}:${f.hostPath}`]),
    vm.host
  ];
}

const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000];

export class NarrowTunnel {
  private proc: ChildProcess | null = null;
  private stopped = true;
  private failures = 0;
  private timer: NodeJS.Timeout | null = null;
  private forwards: Forward[] = [];

  constructor(
    private readonly vm: VmHandle,
    private readonly spawn: SpawnFn,
    private readonly log: (line: string) => void = () => {}
  ) {}

  get running(): boolean {
    return this.proc !== null;
  }

  /** Start, or restart with a new set of forwards. */
  start(forwards: Forward[]): void {
    this.forwards = forwards;
    this.stopped = false;
    this.failures = 0;
    this.kill();
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.kill();
  }

  private kill(): void {
    const proc = this.proc;
    this.proc = null;
    proc?.kill('SIGTERM');
  }

  private open(): void {
    if (this.stopped || this.forwards.length === 0) return;
    const [bin, ...args] = tunnelArgv(this.vm, this.forwards);
    const proc = this.spawn(bin, args, { env: process.env, detached: false });
    this.proc = proc;
    const opened = Date.now();
    proc.on('error', () => {});
    proc.stderr?.on('data', (d: Buffer) =>
      this.log(`dev VM narrow path: ${d.toString('utf-8').trim()}`)
    );
    proc.on('close', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      if (this.stopped) return;
      // A connection that held a while was not a failure to start.
      this.failures = Date.now() - opened > 60_000 ? 0 : this.failures + 1;
      const wait = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)]!;
      this.log(`dev VM narrow path dropped (exit ${code}); reconnecting in ${wait / 1000}s`);
      this.timer = setTimeout(() => this.open(), wait);
      this.timer.unref?.();
    });
  }
}
