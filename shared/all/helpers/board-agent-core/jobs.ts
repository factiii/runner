import type { ChildProcess } from 'child_process';
import crypto from 'crypto';
import { z } from 'zod';

import type {
  RunnerJobEndState,
  RunnerJobInfo,
  RunnerJobState,
  RunnerJobTargetWait
} from '../../domains/electron';
import {
  RUNNER_JOB_NAME_REGEX,
  RUNNER_JOB_PARAM_NAME_REGEX,
  RUNNER_NO_SUCH_JOB_CALL
} from '../../validators/runnerJobs';
import type { AuditLog } from './audit';
import { killTree } from './host-env';
import type { JobTargets } from './job-targets';
import { needsOwnerApproval } from './runner-access';
import type { AuditVia, AuthorizedRunResult } from './secrets-run';
import type { WindowActor } from './secrets-window';

// Jobs on a shared runner (.specs/runner-secrets-gate.md "Job allowlist"). A
// caller names a JOB, never a command: the command comes from
// `.agents/skills/deploy/jobs.json` on the default branch, so "who can merge
// to main" is part of the gate. A call carries the job's name and a map of
// params, and each param reaches the command ONLY as `JOB_PARAM_<NAME>` in
// its environment - never spliced into the command line, so no value can be
// read as shell.
//
// One job runs at a time per space; the rest queue. A job that names a
// `target` also waits, across every board of the runner, while another job
// with that target runs (job-targets.ts). State and the redacted log stay in
// memory, bounded, for the caller to poll.

export const JOBS_PATH = '.agents/skills/deploy/jobs.json';

/** Chunks kept per call. The oldest go first: a live tail matters more than
 *  the first lines of a two-hour build. */
const MAX_CHUNKS = 5000;
/** How long a finished call stays readable. */
const KEEP_MS = 24 * 60 * 60_000;
/** Calls kept at all, finished or not, so a flood cannot grow the map. */
const MAX_CALLS = 200;
const MAX_PARAM_LENGTH = 1000;
const DEFAULT_TIMEOUT_MIN = 60;
const MAX_TIMEOUT_MIN = 24 * 60;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Shared with the server's schemas, so both refuse the same names.
const JOB_NAME = RUNNER_JOB_NAME_REGEX;
const PARAM_NAME = RUNNER_JOB_PARAM_NAME_REGEX;

/** A param pattern must be anchored at both ends: `branch: "[a-z]+"` would
 *  otherwise accept any value with one letter in it. */
const anchoredPattern = z
  .string()
  .refine((p) => p.startsWith('^') && p.endsWith('$'), {
    message: 'a param pattern must start with ^ and end with $'
  })
  .refine(
    (p) => {
      try {
        new RegExp(p);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'not a valid regular expression' }
  );

const jobSchema = z.object({
  name: z.string().regex(JOB_NAME),
  description: z.string().default(''),
  command: z.string().trim().min(1),
  keys: z.array(z.string().regex(ENV_NAME)).default([]),
  files: z.array(z.string().regex(ENV_NAME)).default([]),
  params: z.record(z.string().regex(PARAM_NAME), anchoredPattern).default({}),
  timeoutMin: z
    .number()
    .positive()
    .max(MAX_TIMEOUT_MIN)
    .default(DEFAULT_TIMEOUT_MIN),
  /** The owner wants to see each call of it. A member below
   *  the Shell level then waits for the runner owner
   *  to approve each call (owner-approval.ts). Absent = not dangerous. */
  dangerous: z.boolean().optional(),
  /** What the job changes, e.g. "factiii-server": while one job with this
   *  target runs on any board of this runner, another waits for it
   *  ('waiting-target', FIFO). Same shape as a job name. Absent = no
   *  cross-board wait. */
  target: z.string().regex(JOB_NAME).optional()
});

const jobsFileSchema = z.object({ jobs: z.array(jobSchema) });

export type JobDef = z.infer<typeof jobSchema>;

/** Parse jobs.json. Throws with the reason on a malformed file, rather than
 *  quietly offering the jobs that did parse: a half-read allowlist is not the
 *  one that was merged. */
export function parseJobs(raw: string): JobDef[] {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`${JOBS_PATH} is not valid JSON.`);
  }
  const parsed = jobsFileSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `${JOBS_PATH} is invalid at ${issue?.path.join('.') || 'the top level'}: ${issue?.message ?? 'unknown problem'}`
    );
  }
  const seen = new Set<string>();
  for (const job of parsed.data.jobs) {
    if (seen.has(job.name)) {
      throw new Error(`${JOBS_PATH} declares the job "${job.name}" twice.`);
    }
    seen.add(job.name);
    const clash = job.files.find((f) => job.keys.includes(f));
    if (clash) {
      throw new Error(
        `Job "${job.name}" names ${clash} as both a key and a file.`
      );
    }
  }
  return parsed.data.jobs;
}

/** What a caller may see of a job: never its command. */
function describeJob(def: JobDef): RunnerJobInfo {
  return {
    name: def.name,
    description: def.description,
    keys: [...def.keys],
    files: [...def.files],
    params: { ...def.params },
    dangerous: def.dangerous === true
  };
}

/** The env var a param arrives in. */
export function paramEnvName(name: string): string {
  return `JOB_PARAM_${name.toUpperCase()}`;
}

/**
 * Check a call against its job and build the param env. Refuses an unknown
 * job, an undeclared param, and a value its pattern rejects. A declared param
 * the caller left out is tested as '' - so a pattern that rejects the empty
 * string makes that param required.
 */
function resolveCall(
  defs: JobDef[],
  job: string,
  params: Record<string, unknown> = {}
): { def: JobDef; env: Record<string, string> } {
  const def = defs.find((d) => d.name === job);
  if (!def) throw new Error(`"${job}" is not a job on this runner.`);
  for (const name of Object.keys(params)) {
    if (!(name in def.params)) {
      throw new Error(`Job "${job}" takes no param "${name}".`);
    }
  }
  const env: Record<string, string> = {};
  for (const [name, pattern] of Object.entries(def.params)) {
    const raw = params[name] ?? '';
    if (typeof raw !== 'string') {
      throw new Error(`Param "${name}" must be a string.`);
    }
    if (raw.length > MAX_PARAM_LENGTH || !new RegExp(pattern).test(raw)) {
      throw new Error(`Param "${name}" does not match ${pattern}.`);
    }
    env[paramEnvName(name)] = raw;
  }
  return { def, env };
}

/** A value that reads the same with or without quotes in a shell word. */
const SAFE_WORD = /^[A-Za-z0-9_./:=@%+-]+$/;

/** One value as a whole shell word outside quotes: bare when it is a plain
 *  token, else single-quoted ('' for empty), with each ' as '\''. */
function shellWord(value: string): string {
  if (SAFE_WORD.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** One value inside a double-quoted string: \ " $ ` escaped. */
function inDoubleQuotes(value: string): string {
  return value.replace(/[\\"$`]/g, (c) => `\\${c}`);
}

/** The index of the `}` closing a `${` whose body starts at `from`, or -1. */
function closingBrace(src: string, from: number): number {
  let depth = 1;
  let dq = false;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      i++;
    } else if (c === "'" && !dq) {
      const end = src.indexOf("'", i + 1);
      if (end === -1) return -1;
      i = end;
    } else if (c === '"') {
      dq = !dq;
    } else if (c === '$' && src[i + 1] === '{') {
      depth++;
      i++;
    } else if (c === '}' && !dq && --depth === 0) {
      return i;
    }
  }
  return -1;
}

const PARAM_EXPANSION = /^([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])([\s\S]*))?$/;

/** Fill each expansion of a var in `env` within `src`, scanning quote state
 *  from `dq`. Names it expanded (or could have) go in `used`. */
function fillParams(
  src: string,
  env: Record<string, string>,
  dq: boolean,
  used: Set<string>
): string {
  const quote = (value: string, inDq: boolean) =>
    inDq ? inDoubleQuotes(value) : shellWord(value);
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      out += src.slice(i, i + 2);
      i++;
    } else if (c === "'" && !dq) {
      // Nothing expands inside single quotes.
      const end = src.indexOf("'", i + 1);
      const stop = end === -1 ? src.length : end + 1;
      out += src.slice(i, stop);
      i = stop - 1;
    } else if (c === '"') {
      dq = !dq;
      out += c;
    } else if (c === '$' && src[i + 1] === '{') {
      const close = closingBrace(src, i + 2);
      const match =
        close === -1 ? null : PARAM_EXPANSION.exec(src.slice(i + 2, close));
      const name = match?.[1];
      if (!match || !name || !(name in env)) {
        // Not a param (or a form we do not fill): as written.
        const stop = close === -1 ? src.length : close + 1;
        out += src.slice(i, stop);
        i = stop - 1;
        continue;
      }
      used.add(name);
      const value = env[name] ?? '';
      const op = match[2];
      const word = match[3] ?? '';
      // A declared param is always set, so only the `:` forms test for empty.
      const useWord =
        (op === ':-' && value === '') ||
        op === '+' ||
        (op === ':+' && value !== '');
      const filledWord = fillParams(word, env, dq, used);
      if (useWord) out += filledWord;
      else if (op !== ':+' && op !== '+') out += quote(value, dq);
      i = close;
    } else if (c === '$' && /[A-Za-z_]/.test(src[i + 1] ?? '')) {
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i + 1))?.[0] ?? '';
      if (name in env) {
        used.add(name);
        out += quote(env[name] ?? '', dq);
      } else {
        out += `$${name}`;
      }
      i += name.length;
    } else {
      out += c;
    }
  }
  return out;
}

/**
 * The command a call will run, as one line for the owner's approval and the
 * audit log: `def.command` with each param expansion filled in, and quoted
 * for where it sits - `$JOB_PARAM_X`, `${JOB_PARAM_X}`, `${…:-default}` (the
 * default when the value is empty), `${…-default}`, `${…:?msg}` / `${…?msg}`
 * (the value), and `${…:+word}` / `${…+word}`. Inside double quotes a value
 * has \ " $ ` escaped; outside quotes it is one single-quoted word unless it
 * is a plain token; inside single quotes nothing is filled. Other `$VARS`
 * stay as written.
 *
 * A declared param the command does not expand (a script reads it from its
 * env) goes in front as `JOB_PARAM_X='…'`, in jobs.json order - only when
 * its value is not empty. Values are never cut; a newline stays inside its
 * quotes. Display only: the runner still passes params as env, never spliced.
 */
export function filledCommand(
  def: Pick<JobDef, 'command' | 'params'>,
  env: Record<string, string>
): string {
  const used = new Set<string>();
  const command = fillParams(def.command, env, false, used);
  const assignments = Object.keys(def.params)
    .map(paramEnvName)
    .filter((name) => !used.has(name) && (env[name] ?? '') !== '')
    .map((name) => `${name}=${shellWord(env[name] ?? '')}`);
  return [...assignments, command].join(' ');
}

/** Everything a job needs from its space, injected so the runner is testable
 *  without a repo or a remote. */
export type JobHost = {
  /** The jobs on the default branch, fresh each call. */
  load: () => Promise<JobDef[]>;
  /** Reset the workspace to the default branch and return where to run. */
  prepare: () => Promise<string>;
  /** Authorize and run (authorizeAndRun with the space's gate and window).
   *  `signal` aborts on cancel; `callId` tags the gate request. */
  execute: (args: {
    callId: string;
    signal: AbortSignal;
    def: JobDef;
    env: Record<string, string>;
    cwd: string;
    caller: WindowActor;
    via: AuditVia;
    onChunk: (text: string) => void;
    onSpawn: (proc: ChildProcess) => void;
    onPhase: (phase: 'waiting-auth' | 'running') => void;
  }) => Promise<AuthorizedRunResult>;
  /** The runner-wide target holds (job-targets.ts) and this board's name
   *  for the wait line. Absent = `target` is ignored. */
  targets?: { store: JobTargets; board: string };
  /** Hold a member's call of a dangerous job until the runner owner
   *  answers (owner-approval.ts). True = run this one call. Absent = nobody
   *  can approve, so such a call ends as denied. */
  askOwner?: (args: {
    callId: string;
    signal: AbortSignal;
    def: JobDef;
    env: Record<string, string>;
    caller: WindowActor;
    via: AuditVia;
  }) => Promise<boolean>;
  audit?: AuditLog;
  /** Progress for the server, which relays it to the caller. */
  onLog?: (callId: string, seq: number, text: string) => void;
  onEnd?: (
    callId: string,
    state: RunnerJobEndState,
    exitCode: number | null
  ) => void;
  /** Each phase a call enters before it ends, with the road it came by, so
   *  the server can show "waiting for approval" on a call it relayed. */
  onState?: (
    callId: string,
    state:
      | 'queued'
      | 'waiting-owner'
      | 'waiting-target'
      | 'waiting-auth'
      | 'running',
    via: AuditVia,
    /** Set with 'waiting-target', again each time the holder or the place
     *  in line moves. */
    wait?: RunnerJobTargetWait
  ) => void;
};

/** Where a call is. Only 'waiting-target' carries a wait (who holds the
 *  target, the call's place in line), so the state and the wait can never
 *  disagree. */
type CallPhase =
  | { state: 'waiting-target'; wait: RunnerJobTargetWait }
  | { state: Exclude<RunnerJobState, 'waiting-target'> };

/** The wait to report beside a call's state: only while it waits on a
 *  target. */
function phaseWait(phase: CallPhase): { wait?: RunnerJobTargetWait } {
  return phase.state === 'waiting-target' ? { wait: phase.wait } : {};
}

type Call = {
  callId: string;
  job: string;
  phase: CallPhase;
  exitCode: number | null;
  chunks: { seq: number; text: string }[];
  nextSeq: number;
  createdAt: number;
  endedAt: number | null;
  proc: ChildProcess | null;
  /** Who started it, for the cancel check and the audit lines. */
  caller: WindowActor;
  abort: AbortController;
  /** Frees the target this call holds; called once, when it ends. */
  release: (() => void) | null;
};

export class JobRunner {
  private calls = new Map<string, Call>();
  /** The space's queue: each call starts when the one before it settles. */
  private chain: Promise<void> = Promise.resolve();
  private destroyed = false;
  /** Aborts every target wait when the space shuts down. */
  private shutdown = new AbortController();

  constructor(
    private host: JobHost,
    private now: () => number = Date.now
  ) {}

  async list(): Promise<RunnerJobInfo[]> {
    return (await this.host.load()).map(describeJob);
  }

  /**
   * Accept a call and queue it. Resolves once the call is checked (known job,
   * params match), not when it finishes: the caller polls `status` or
   * listens for `onEnd`. `callId` is the server's when it minted one, so both
   * sides key the call the same way. A dangerous job from a caller below
   * Shell is accepted too, as 'waiting-owner': it joins the queue
   * only once the runner owner approves it, so the wait holds up nobody else.
   */
  async call(opts: {
    job: string;
    params?: Record<string, unknown>;
    caller: WindowActor;
    via: AuditVia;
    callId?: string;
    /** Value-free context for the audit line, e.g. which session on this
     *  runner made the call. */
    from?: string;
    /** Whether the caller runs a job marked `dangerous` without the owner's
     *  approval: the owner, a member at Shell on this board
     *  (runsDangerousJobs), or a session on this runner while the ops user
     *  is off (sessionRunsDangerousJobs). Checked here, on the
     *  definition that runs, whichever road the call took. Absent = the call
     *  waits for the owner. */
    mayRunDangerous?: boolean;
  }): Promise<{ callId: string }> {
    if (this.destroyed) throw new Error('This space is shutting down.');
    const { def, env } = resolveCall(
      await this.host.load(),
      opts.job,
      opts.params
    );
    const askOwner = needsOwnerApproval(def, opts.mayRunDangerous === true);
    const callId = opts.callId || crypto.randomUUID();
    if (this.calls.has(callId)) {
      throw new Error('That call id is already in use.');
    }
    this.prune();
    const call: Call = {
      callId,
      job: def.name,
      phase: { state: askOwner ? 'waiting-owner' : 'queued' },
      exitCode: null,
      chunks: [],
      nextSeq: 1,
      createdAt: this.now(),
      endedAt: null,
      proc: null,
      caller: opts.caller,
      abort: new AbortController(),
      release: null
    };
    this.calls.set(callId, call);
    void this.host.audit?.append({
      actor: opts.caller,
      via: opts.via,
      action: 'job',
      job: def.name,
      keys: [...def.keys, ...def.files],
      command: def.command,
      exitCode: null,
      durationMs: null,
      unlockedBy: null,
      detail:
        [opts.from ? `from: ${opts.from}` : '', describeParams(env) ?? '']
          .filter(Boolean)
          .join('; ') || undefined
    });
    if (askOwner) {
      this.host.onState?.(callId, 'waiting-owner', opts.via);
      void this.waitForOwner(call, def, env, opts);
    } else {
      this.host.onState?.(callId, 'queued', opts.via);
      this.enqueue(call, def, env, opts);
    }
    return { callId };
  }

  /** Join the space's queue, first taking the job's target when it names
   *  one. A call waiting on its target is outside the queue, so it holds up
   *  nobody on its own board; it joins the queue once it holds the target,
   *  and keeps it until it ends. */
  private enqueue(
    call: Call,
    def: JobDef,
    env: Record<string, string>,
    opts: { caller: WindowActor; via: AuditVia }
  ): void {
    const targets = this.host.targets;
    if (def.target && targets) {
      const who = {
        callId: call.callId,
        job: def.name,
        board: targets.board,
        callerName: opts.caller.name
      };
      const release = targets.store.tryAcquire(def.target, who);
      if (!release) {
        void this.waitForTarget(call, def, env, opts, def.target, who);
        return;
      }
      call.release = release;
    }
    this.chain = this.chain.then(() => this.run(call, def, env, opts));
  }

  /** Wait in line for `target` (job-targets.ts), then queue. Cancelled
   *  while waiting: it ends unrun. The space shutting down: it fails. */
  private async waitForTarget(
    call: Call,
    def: JobDef,
    env: Record<string, string>,
    opts: { caller: WindowActor; via: AuditVia },
    target: string,
    who: { callId: string; job: string; board: string; callerName: string }
  ): Promise<void> {
    const started = this.now();
    const store = this.host.targets?.store;
    if (!store) return;
    try {
      call.release = await store.acquire(
        target,
        who,
        AbortSignal.any([call.abort.signal, this.shutdown.signal]),
        (wait) => {
          call.phase = { state: 'waiting-target', wait };
          this.host.onState?.(call.callId, 'waiting-target', opts.via, wait);
        }
      );
    } catch {
      const cancelled = call.abort.signal.aborted;
      if (!cancelled) {
        this.push(call, '\nThis space is shutting down.\n');
      }
      await this.end(
        call,
        def,
        opts,
        cancelled ? 'cancelled' : 'failed',
        null,
        null,
        started
      );
      return;
    }
    if (call.phase.state === 'waiting-target') {
      call.phase = { state: 'queued' };
      this.host.onState?.(call.callId, 'queued', opts.via);
    }
    this.chain = this.chain.then(() => this.run(call, def, env, opts));
  }

  /** Hold a dangerous job call for the owner, outside the queue. Approved:
   *  it queues like any other call. Anything else ends it unrun: denied, or
   *  cancelled when its caller or the owner cancelled the wait. */
  private async waitForOwner(
    call: Call,
    def: JobDef,
    env: Record<string, string>,
    opts: { caller: WindowActor; via: AuditVia }
  ): Promise<void> {
    const started = this.now();
    let approved = false;
    try {
      approved =
        (await this.host.askOwner?.({
          callId: call.callId,
          signal: call.abort.signal,
          def,
          env,
          caller: opts.caller,
          via: opts.via
        })) === true;
    } catch {
      approved = false;
    }
    if (approved && !call.abort.signal.aborted && !this.destroyed) {
      call.phase = { state: 'queued' };
      this.host.onState?.(call.callId, 'queued', opts.via);
      this.enqueue(call, def, env, opts);
      return;
    }
    if (!call.abort.signal.aborted) {
      this.push(call, `\n${def.name}: the runner owner did not approve this call.\n`);
    }
    await this.end(
      call,
      def,
      opts,
      call.abort.signal.aborted ? 'cancelled' : 'denied',
      null,
      null,
      started
    );
  }

  private async run(
    call: Call,
    def: JobDef,
    env: Record<string, string>,
    opts: { caller: WindowActor; via: AuditVia }
  ): Promise<void> {
    const started = this.now();
    let state: RunnerJobEndState = 'failed';
    let exitCode: number | null = null;
    let unlockedBy: string | null = null;
    try {
      if (this.destroyed) throw new Error('This space is shutting down.');
      if (call.abort.signal.aborted) throw new Error('Cancelled.');
      const cwd = await this.host.prepare();
      if (call.abort.signal.aborted) throw new Error('Cancelled.');
      const res = await this.host.execute({
        callId: call.callId,
        signal: call.abort.signal,
        def,
        env,
        cwd,
        caller: opts.caller,
        via: opts.via,
        onChunk: (text) => this.push(call, text),
        onSpawn: (proc) => {
          call.proc = proc;
        },
        onPhase: (phase) => {
          if (call.phase.state === phase) return;
          call.phase = { state: phase };
          this.host.onState?.(call.callId, phase, opts.via);
        }
      });
      if ('denied' in res) {
        state = 'denied';
      } else {
        exitCode = res.code;
        unlockedBy = res.unlockedBy;
        state = res.code === 0 ? 'done' : 'failed';
      }
    } catch (err) {
      // The reason is ours, not the command's output, and holds no value.
      this.push(
        call,
        `\n${err instanceof Error ? err.message : String(err)}\n`
      );
      state = 'failed';
    }
    // Whatever the command returned after a cancel (a denial for a withdrawn
    // prompt, 143 for a killed process), the call ended because it was
    // cancelled.
    if (call.abort.signal.aborted) {
      state = 'cancelled';
      // A killed command's -1 or 143 is not an exit code the job chose.
      exitCode = null;
    }
    await this.end(call, def, opts, state, exitCode, unlockedBy, started);
  }

  /** Settle a call: its final state, the job-end audit line, and onEnd. It
   *  frees the call's target first, so the next in line starts at once. */
  private async end(
    call: Call,
    def: JobDef,
    opts: { caller: WindowActor; via: AuditVia },
    state: RunnerJobEndState,
    exitCode: number | null,
    unlockedBy: string | null,
    started: number
  ): Promise<void> {
    call.release?.();
    call.release = null;
    call.proc = null;
    call.phase = { state };
    call.exitCode = exitCode;
    call.endedAt = this.now();
    await this.host.audit?.append({
      actor: opts.caller,
      via: opts.via,
      action: 'job-end',
      job: def.name,
      keys: [...def.keys, ...def.files],
      command: def.command,
      exitCode,
      durationMs: call.endedAt - started,
      unlockedBy,
      detail: state
    });
    this.host.onEnd?.(call.callId, state, exitCode);
  }

  private push(call: Call, text: string): void {
    if (!text) return;
    const seq = call.nextSeq;
    call.nextSeq += 1;
    call.chunks.push({ seq, text });
    if (call.chunks.length > MAX_CHUNKS) {
      call.chunks.splice(0, call.chunks.length - MAX_CHUNKS);
    }
    this.host.onLog?.(call.callId, seq, text);
  }

  /**
   * Cancel a call. Only the actor who started it or the runner owner may
   * (`byOwner`). Waiting on the owner: the approval is withdrawn. Waiting on
   * a target: it leaves the line. Queued: it never starts. Waiting on the gate: its prompt is
   * withdrawn. Running: its process group gets SIGTERM, then SIGKILL after
   * the grace period. It ends as 'cancelled' through the normal end path, so
   * temp files are wiped and onEnd fires. False when it had already ended.
   */
  async cancel(
    callId: string,
    by: WindowActor,
    via: AuditVia,
    byOwner: boolean
  ): Promise<{ cancelled: boolean }> {
    const call = this.calls.get(callId);
    if (!call) throw new Error(RUNNER_NO_SUCH_JOB_CALL);
    if (!byOwner && String(by.userId) !== String(call.caller.userId)) {
      throw new Error(
        'Only the member who started this job, or the runner owner, can cancel it.'
      );
    }
    if (call.endedAt !== null || call.abort.signal.aborted) {
      return { cancelled: false };
    }
    const was = call.phase.state;
    call.abort.abort();
    await this.host.audit?.append({
      actor: by,
      via,
      action: 'job-cancel',
      job: call.job,
      keys: [],
      exitCode: null,
      durationMs: null,
      unlockedBy: null,
      detail: `was ${was}; started by ${call.caller.name}`
    });
    return { cancelled: true };
  }

  /** Calls that have not ended, oldest first. `onlyUserId` narrows them to
   *  the ones that actor started (a member sees only its own). */
  active(onlyUserId?: string): {
    callId: string;
    job: string;
    state: RunnerJobState;
    actor: { userId: string; name: string };
    startedAt: string;
    wait?: RunnerJobTargetWait;
  }[] {
    return [...this.calls.values()]
      .filter((c) => c.endedAt === null)
      .filter(
        (c) =>
          onlyUserId === undefined ||
          String(c.caller.userId) === String(onlyUserId)
      )
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((c) => ({
        callId: c.callId,
        job: c.job,
        state: c.phase.state,
        actor: { userId: c.caller.userId, name: c.caller.name },
        startedAt: new Date(c.createdAt).toISOString(),
        ...phaseWait(c.phase)
      }));
  }

  /** A call is queued, waiting on the gate, or running. */
  busy(): boolean {
    for (const call of this.calls.values()) {
      if (call.endedAt === null) return true;
    }
    return false;
  }

  /** A call's state and log after `afterSeq`. `viewer` is set for a member
   *  asking over a data channel: the same rule as cancel, and anyone else is
   *  told the call does not exist. The server path checks its own
   *  (canSeeCall) and passes no viewer. */
  status(
    callId: string,
    afterSeq = 0,
    viewer?: { by: WindowActor; byOwner: boolean }
  ): {
    state: RunnerJobState;
    exitCode: number | null;
    chunks: { seq: number; text: string }[];
    wait?: RunnerJobTargetWait;
  } {
    const call = this.calls.get(callId);
    if (
      !call ||
      (viewer &&
        !viewer.byOwner &&
        String(viewer.by.userId) !== String(call.caller.userId))
    ) {
      throw new Error(RUNNER_NO_SUCH_JOB_CALL);
    }
    return {
      state: call.phase.state,
      exitCode: call.exitCode,
      chunks: call.chunks.filter((c) => c.seq > afterSeq),
      ...phaseWait(call.phase)
    };
  }

  /** Drop finished calls past their day, then the oldest finished ones past
   *  the count cap. A queued or running call is never dropped. */
  private prune(): void {
    const cutoff = this.now() - KEEP_MS;
    for (const [id, call] of this.calls) {
      if (call.endedAt !== null && call.endedAt < cutoff) this.calls.delete(id);
    }
    if (this.calls.size < MAX_CALLS) return;
    const finished = [...this.calls.values()]
      .filter((c) => c.endedAt !== null)
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    for (const call of finished) {
      if (this.calls.size < MAX_CALLS) break;
      this.calls.delete(call.callId);
    }
  }

  /** Kill what is running; queued calls fail as they come up, and calls
   *  waiting on a target fail now. */
  destroy(): void {
    this.destroyed = true;
    this.shutdown.abort();
    for (const call of this.calls.values()) {
      if (call.proc) killTree(call.proc);
    }
  }
}

/** What the engine uses of a space's jobs: the in-process JobRunner, or the
 *  ops user's runner seen through the ops socket (.specs/ops-user.md,
 *  apps/runner/src/ops/link.ts), which mirrors calls so `status` and
 *  `active` stay synchronous. */
export type JobsApi = Pick<
  JobRunner,
  'list' | 'call' | 'cancel' | 'active' | 'busy' | 'status' | 'destroy'
>;

/** `branch=main, env=prod` for the audit line: param values are validated,
 *  caller-chosen text and never secret, so they are what makes the line
 *  useful. Capped so one long value cannot bloat the log. */
function describeParams(env: Record<string, string>): string | undefined {
  const parts = Object.entries(env).map(
    ([k, v]) =>
      `${k.replace(/^JOB_PARAM_/, '').toLowerCase()}=${v.slice(0, 100)}`
  );
  return parts.length ? `params: ${parts.join(', ')}` : undefined;
}
