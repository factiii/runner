import { type ChildProcess, execFile, spawn } from 'child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';

import { agentHomeEnv } from './agent-homes';
import { execLogin, hostEnv } from './host-env';
import {
  allocateBoardPorts,
  claimBoardPorts,
  PORTS_PER_BLOCK
} from './port-blocks';
import { hostSpacePaths, type SpacePaths } from './spacePaths';

const execFileAsync = promisify(execFile);

// One handle for "run something for this space": where its directories are,
// how to run a command there, how to reach the agent CLIs' state.

export type ExecOpts = {
  cwd?: string;
  env?: Record<string, string>;
};

export type StepExecResult = { ok: boolean; stdout: string; stderr: string };

export type StepOpts = ExecOpts & {
  timeoutMs?: number;
  /** Fired per chunk with the full interleaved stdout+stderr so far. */
  onOutput?: (combined: string) => void;
};

export type ExecTarget = {
  /** Where this target's per-space directories live. */
  readonly paths: SpacePaths;
  /** Space env (the board's ports, the directories an agent may write to,
   *  MCP token, the runner's CLI homes). No PATH, for callers that must keep
   *  the one they already have (a tmux session's login shell). */
  stateEnv(): Record<string, string>;
  /** stateEnv plus the staged-helper bin dir on PATH, for spawning a CLI. */
  agentEnv(): Record<string, string>;
  /** The board's GitHub token as it is now, for the runner's own git calls
   *  to origin (gitRemote). Absent = none. Never put in an env a session
   *  gets: sessions ask the runner through the credential helper. */
  githubToken?: () => string;
  /** Run argv (no shell), resolve stdout, throw on nonzero. */
  run(argv: string[], opts?: ExecOpts): Promise<string>;
  /** Run a shell command line, resolve stdout, throw on nonzero. */
  sh(cmd: string, opts?: ExecOpts): Promise<string>;
  /** Run argv with `input` streamed over stdin, for payloads too large for an
   *  arg (big diffs, redis values). `label` names the op in the error. */
  runWithStdin(argv: string[], input: string, label: string): Promise<void>;
  /** Write a file, creating parent dirs. */
  writeFile(filePath: string, content: string): Promise<void>;
  /** Deploy-step exec: never throws, enforces a timeout, streams output. */
  step(cmd: string, opts?: StepOpts): Promise<StepExecResult>;
  /** Spawn a long-lived process for streaming stdio (the agent CLIs). */
  spawn(argv: string[], opts?: ExecOpts): Promise<ChildProcess>;
};

const MAX_BUFFER = 10 * 1024 * 1024;

// Ports a board-level shell may bind (board jobs, setup: anything with no
// session). Allocated at provision time and recorded beside the space dir.
// Each session has a block of its own (port-blocks.ts), laid over this one
// in its env; the shared registry keeps the two from overlapping.
const PORTS_FILE = '.ports';

function portsFilePath(spaceDir: string): string {
  return path.join(spaceDir, PORTS_FILE);
}

/** Reserve PORTS_PER_BLOCK free TCP ports for this board's own shells and
 *  record them. A recorded block is kept unless it overlaps another board's
 *  or a session's (two boards allocated before the registry existed could get
 *  the same ports): then it is replaced. */
export async function allocateSpacePorts(spaceDir: string): Promise<number[]> {
  const existing = readSpacePorts(spaceDir);
  await fs.mkdir(spaceDir, { recursive: true });
  if (
    existing.length === PORTS_PER_BLOCK &&
    claimBoardPorts(spaceDir, existing)
  ) {
    return existing;
  }
  const ports = await allocateBoardPorts(spaceDir);
  await fs.writeFile(portsFilePath(spaceDir), ports.join(','), 'utf-8');
  return ports;
}

const SECRET_FILE = '.secret';

/**
 * This space's long-lived secret, behind the token every terminal carries for
 * `factiii-secrets`. On disk because it must outlive the process handing it
 * out: tmux is its own server, so a terminal survives a runner update or the
 * desktop app quitting, and keeps the token it was spawned with.
 *
 * Random and 0600, not derived from a path: anything a local process can
 * recompute is not a secret, and this is what separates a session the host
 * spawned from anything else that found the socket. Sync like readSpacePorts.
 */
export function spaceSecret(spaceDir: string): string {
  return fileSecret(spaceDir, SECRET_FILE);
}

/** A random secret kept in `name` under the space dir, minted on first read. */
function fileSecret(spaceDir: string, name: string): string {
  const file = path.join(spaceDir, name);
  try {
    const existing = readFileSync(file, 'utf-8').trim();
    if (existing) return existing;
  } catch {
    // Not minted yet, or gone. Either way the next lines write one.
  }
  const secret = randomBytes(24).toString('hex');
  try {
    mkdirSync(spaceDir, { recursive: true });
    writeFileSync(file, secret, { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // Unwritable: good for this process, which is what it replaces.
  }
  return secret;
}

const SESSION_KEY_FILE = '.session-key';

/**
 * The secret one session of this space carries as FACTIII_SESSION_TOKEN, so
 * the board MCP's session tools know which session is asking
 * (session-card-tools.ts): FACTIII_SESSION alone is the agent's own word, and
 * a session naming another would act for that one's person.
 *
 * An HMAC of the session id under a key of its own (`.session-key`, 0600, in
 * no session's env, unlike `.secret`), so it is different for every session,
 * cannot be worked out from the id or from the space token, and needs no
 * record: every spawn of the session (each tab, each chat run, after a runner
 * restart too) gets the same one. Never logged.
 */
export function sessionToken(spaceDir: string, sessionId: string): string {
  return createHmac('sha256', fileSecret(spaceDir, SESSION_KEY_FILE))
    .update(sessionId)
    .digest('hex');
}

/** Whether `token` is the one `sessionToken` gives `sessionId`. */
export function isSessionToken(
  spaceDir: string,
  sessionId: string,
  token: string
): boolean {
  const expected = Buffer.from(sessionToken(spaceDir, sessionId));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The board-level block recorded for this space, or [] when none was
 *  allocated yet. A session's own is readSessionPorts (port-blocks.ts). Sync
 *  because agentEnv() is, and the file is a few bytes. */
export function readSpacePorts(spaceDir: string): number[] {
  try {
    return readFileSync(portsFilePath(spaceDir), 'utf-8')
      .split(',')
      .map((p) => Number(p.trim()))
      .filter((p) => Number.isInteger(p) && p > 0);
  } catch {
    return [];
  }
}

/** A cwd only when it exists: `spawn` throws ENOENT otherwise, and the space
 *  dir is absent on a fresh machine. */
function usableCwd(dir: string | undefined): string | undefined {
  return dir && existsSync(dir) ? dir : undefined;
}

/** Run everything for this space on the host. PATH comes from `hostEnv()`, so
 *  a toolchain installed after startup is found. `extraEnv` is read per call. */
export function hostTarget(
  spaceDir: string,
  extraEnv?: () => Record<string, string>,
  githubToken?: () => string
): ExecTarget {
  const paths = hostSpacePaths(spaceDir);

  // execLogin derives PATH from the profile itself, so handing it one would
  // spawn a second shell for nothing.
  const spawnEnv = async (opts?: ExecOpts) => ({
    ...(await hostEnv()),
    ...opts?.env
  });
  const shellEnv = (opts?: ExecOpts) => ({ ...process.env, ...opts?.env });

  return {
    paths,
    githubToken,

    stateEnv() {
      const env: Record<string, string> = {};
      // The board's block. A session's env lays its own over this
      // (terminal.ts sessionEnv, port-blocks.ts sessionPortsEnv).
      const ports = readSpacePorts(spaceDir);
      if (ports.length) env.FACTIII_PORTS = ports.join(',');
      // Where an agent draws for the user (.specs/scratchpad.md). Set on the
      // tmux session, so a shell that predates it reads stale until it is
      // restarted - which is exactly what the terminal digest asks about.
      env.SCRATCHPAD = paths.scratchpad;
      // Where files the user drops into a session land, so an agent can find
      // and name them without a typed-out path.
      env.DROPS_DIR = paths.drops;
      // The rest of the tree an agent may write to, by the names the deploy
      // contract already uses (`spaceEnv`), so every session can be told to
      // put build output and dumps there instead of in its worktree - and can
      // check (`echo $BUILDS_DIR`) rather than trust the prose the plugin's
      // SessionStart hook (bin/session-context.sh) prints. A deploy run
      // overrides WORKSPACE per run.
      env.WORKSPACE = paths.workspace;
      env.BACKUPS_DIR = paths.backups;
      env.BUILDS_DIR = paths.builds;
      // The runner's own CLI homes (agent-homes.ts). Already in process.env,
      // which every spawn inherits; named here too because a tmux server can
      // outlive the runner that started it and keep an older env, and a
      // session set on it would then read the person's default homes. Also
      // moves the terminal digest, so a terminal from before is reported stale.
      Object.assign(env, agentHomeEnv());
      return { ...env, ...extraEnv?.() };
    },

    agentEnv() {
      // Staged helpers (factiii-expose) resolve by bare name.
      return {
        ...this.stateEnv(),
        PATH: `${paths.bin}:${process.env.PATH ?? ''}`
      };
    },

    async run(argv, opts) {
      const [bin, ...rest] = argv;
      const { stdout } = await execFileAsync(bin, rest, {
        cwd: usableCwd(opts?.cwd ?? paths.root),
        env: await spawnEnv(opts),
        encoding: 'utf-8',
        maxBuffer: MAX_BUFFER
      });
      return stdout;
    },

    async sh(cmd, opts) {
      const res = await execLogin(cmd, {
        cwd: usableCwd(opts?.cwd ?? paths.root),
        env: shellEnv(opts),
        timeout: 10 * 60_000,
        maxBuffer: MAX_BUFFER
      });
      if (res.code !== 0) {
        throw new Error(`Command failed (exit ${res.code}): ${res.output}`);
      }
      return res.output;
    },

    async runWithStdin(argv, input, label) {
      const [bin, ...rest] = argv;
      const env = await spawnEnv();
      return new Promise<void>((resolve, reject) => {
        const proc = spawn(bin, rest, { cwd: usableCwd(paths.root), env });
        let stderr = '';
        proc.stderr?.on('data', (d: Buffer) => {
          stderr += d.toString();
        });
        proc.on('error', reject);
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`${label}: ${stderr.trim()}`));
        });
        // A process dying mid-write emits EPIPE on stdin; without a listener
        // that is an uncaught exception. 'close' still fires nonzero.
        proc.stdin?.on('error', () => {});
        proc.stdin?.write(input);
        proc.stdin?.end();
      });
    },

    async writeFile(filePath, content) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, 'utf-8');
    },

    async step(cmd, opts) {
      const res = await execLogin(cmd, {
        cwd: usableCwd(opts?.cwd ?? paths.workspace),
        env: shellEnv(opts),
        timeout: opts?.timeoutMs ?? 20 * 60_000,
        maxBuffer: 32 * 1024 * 1024,
        onOutput: opts?.onOutput
      });
      // execLogin interleaves both streams into one capture; no caller diffs
      // stdout against stderr.
      return {
        ok: res.code === 0,
        stdout: res.output,
        stderr: res.code === 0 ? '' : res.output || 'Command failed'
      };
    },

    async spawn(argv, opts) {
      const [bin, ...rest] = argv;
      const proc = spawn(bin, rest, {
        cwd: usableCwd(opts?.cwd ?? paths.root),
        env: await spawnEnv(opts),
        // Own process group so `kill` below reaps the tree. Nothing reaps
        // orphans on a host the way a dying container did.
        detached: true
      });
      // A missing binary is an 'error' event, and one nobody listens to kills
      // the runner: `redis-cli` on a Mac without redis crash-looped mac-mini-m6
      // on 2026-10-25. Callers that care add their own listener; 'close'
      // still fires either way.
      proc.on('error', () => {});
      return proc;
    }
  };
}
