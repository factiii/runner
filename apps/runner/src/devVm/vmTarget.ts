import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';

import type {
  ExecOpts,
  ExecTarget,
  StepExecResult,
  StepOpts
} from '@shared/all/helpers/board-agent-core/exec';
import { killTree } from '@shared/all/helpers/board-agent-core/host-env';

import { remoteCommand, shJoin, sshArgv, type VmHandle, vmEnv } from './ssh';

// A space's ExecTarget with every command run inside the dev VM, as the
// session user (.specs/dev-vm.md). The space's directories are at the same
// paths in the VM (the repo, worktrees, scratchpad, drops and bin are mounts;
// the rest is the VM's own), so `paths` is the host's and a path a caller
// built means the same thing on both sides.
//
// Fail closed: `ready` runs before anything starts in the VM, and when it
// throws (the VM is down, the firewall did not apply) nothing falls back to
// this Mac. That fallback is exactly the thing the VM exists to prevent.

export type SpawnFn = (
  command: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; detached: boolean }
) => ChildProcess;

export type VmTargetDeps = {
  vm: VmHandle;
  /** The space's safe slug: which token file the VM sources. */
  slug: string;
  /** Resolves once the VM is up, isolated and holds this space's tokens
   *  (devVm.ts). Called before every command; cheap when nothing changed. */
  ready: () => Promise<void>;
  /** Told when a session starts (a tab, an agent run), so the tokens are
   *  pushed fresh for it. */
  onSessionStart?: () => Promise<void>;
  spawn?: SpawnFn;
};

const MAX_BUFFER = 10 * 1024 * 1024;

type Captured = { code: number; stdout: string; stderr: string };

export function vmTarget(host: ExecTarget, deps: VmTargetDeps): ExecTarget {
  const paths = host.paths;
  const spawnFn: SpawnFn =
    deps.spawn ??
    ((command, args, opts) =>
      nodeSpawn(command, args, { ...opts, stdio: 'pipe' }));

  const sshSpawn = (remote: string, tty: boolean, mux = true): ChildProcess => {
    const [bin, ...args] = [
      ...sshArgv(deps.vm, 'session', { tty, mux }),
      remote
    ];
    const proc = spawnFn(bin, args, { env: process.env, detached: true });
    // As the host target: a missing ssh is an event, and an unheard one
    // kills the runner.
    proc.on('error', () => {});
    return proc;
  };

  const remote = (
    argv: string[],
    opts: ExecOpts | undefined,
    extra: { supervise?: boolean; mergeStderr?: boolean } = {}
  ) =>
    remoteCommand(argv, {
      slug: deps.slug,
      cwd: opts?.cwd ?? paths.root,
      env: vmEnv(opts?.env, paths.bin),
      ...extra
    });

  /** Run to completion, capturing output; never throws. */
  const capture = async (
    command: string,
    opts: {
      input?: string;
      timeoutMs?: number;
      onOutput?: (combined: string) => void;
    } = {}
  ): Promise<Captured> => {
    await deps.ready();
    const proc = sshSpawn(command, false);
    return await new Promise<Captured>((resolve) => {
      let stdout = '';
      let stderr = '';
      let combined = '';
      let settled = false;
      const timer = opts.timeoutMs
        ? setTimeout(() => {
            stderr += `\nTimed out after ${opts.timeoutMs}ms.`;
            killTree(proc);
          }, opts.timeoutMs)
        : null;
      const take = (into: 'out' | 'err') => (d: Buffer) => {
        const text = d.toString('utf-8');
        if (into === 'out') stdout += text;
        else stderr += text;
        combined += text;
        if (stdout.length + stderr.length > MAX_BUFFER) killTree(proc);
        opts.onOutput?.(combined);
      };
      proc.stdout?.on('data', take('out'));
      proc.stderr?.on('data', take('err'));
      const done = (code: number) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({ code, stdout, stderr });
      };
      proc.on('error', (err) => {
        stderr += err.message;
        done(127);
      });
      proc.on('close', (code) => done(code ?? 1));
      proc.stdin?.on('error', () => {});
      if (opts.input !== undefined) proc.stdin?.write(opts.input);
      proc.stdin?.end();
    });
  };

  const fail = (what: string, res: Captured): Error =>
    new Error(
      `${what} failed in the dev VM (exit ${res.code}): ${(res.stderr || res.stdout).trim()}`
    );

  return {
    paths,
    githubToken: host.githubToken,

    stateEnv() {
      return host.stateEnv();
    },

    agentEnv() {
      // vmEnv sees the bin dir here and keeps it first on the VM's PATH.
      return { ...this.stateEnv(), PATH: `${paths.bin}:${process.env.PATH ?? ''}` };
    },

    async run(argv, opts) {
      const res = await capture(remote(argv, opts), { timeoutMs: 10 * 60_000 });
      if (res.code !== 0) throw fail(argv[0] ?? 'Command', res);
      return res.stdout;
    },

    async sh(cmd, opts) {
      // A login shell with both streams in one capture, as the host's sh().
      const res = await capture(
        remote(['bash', '-lc', cmd], opts, { mergeStderr: true }),
        { timeoutMs: 10 * 60_000 }
      );
      if (res.code !== 0) {
        throw new Error(`Command failed (exit ${res.code}): ${res.stdout}${res.stderr}`);
      }
      return res.stdout;
    },

    async runWithStdin(argv, input, label) {
      const res = await capture(remote(argv, undefined), { input });
      if (res.code !== 0) throw new Error(`${label}: ${res.stderr.trim()}`);
    },

    async writeFile(filePath, content) {
      const res = await capture(
        remote(
          ['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', filePath],
          undefined
        ),
        { input: content }
      );
      if (res.code !== 0) throw fail(`Writing ${filePath}`, res);
    },

    async step(cmd, opts?: StepOpts): Promise<StepExecResult> {
      const res = await capture(
        remote(['bash', '-lc', cmd], { cwd: opts?.cwd ?? paths.workspace, env: opts?.env }, {
          mergeStderr: true
        }),
        { timeoutMs: opts?.timeoutMs ?? 20 * 60_000, onOutput: opts?.onOutput }
      );
      return {
        ok: res.code === 0,
        stdout: res.stdout,
        stderr: res.code === 0 ? '' : res.stdout + res.stderr || 'Command failed'
      };
    },

    async spawn(argv, opts) {
      await deps.ready();
      await deps.onSessionStart?.();
      // Its own connection, so the supervisor in the VM sees it end.
      return sshSpawn(remote(argv, opts, { supervise: true }), false, false);
    },

    async spawnPty(argv, size, opts) {
      await deps.ready();
      await deps.onSessionStart?.();
      // ssh -tt gives the remote end a terminal, so nothing like script(1)
      // is needed there, and closing the connection hangs it up: the tmux
      // client goes with its ssh, the tmux server (and the tab) stays.
      const sized = [
        'sh',
        '-c',
        `stty rows ${size.rows} cols ${size.cols} 2>/dev/null; exec ${shJoin(argv)}`
      ];
      return sshSpawn(remote(sized, opts), true);
    }
  };
}
