import { randomUUID } from 'node:crypto';

import {
  type RunnerJob,
  type RunnerJobEngine,
  type RunnerJobPerson,
  type RunnerJobType,
  RUNNER_JOB_TYPE_LABELS
} from '@shared/all/domains/runnerActivity';

import type { JobHistory } from './history';

// The runner's job registry (.specs/runner.md "Activity"): every piece of AI
// work on the runner registers here when it starts and closes when it ends,
// whatever started it (a terminal session, Ask Board, Oakbox Ask, Categorize,
// Findings, a model download, an `aiPrompt`). Live jobs are held in memory;
// a finished one goes to History (history.ts) with its log.
//
// Vault jobs keep metadata only - type, engine, times, status, item count -
// and that is enforced here, not in the UI: a Vault job's title is its
// type's label whatever the caller passed, its log takes nothing, and its
// error is dropped. A type that only ever runs over the Vault is a Vault job
// even when the caller forgot to say so.

/** Types whose work only ever reads the Vault (or Runner Cloud). */
const VAULT_JOB_TYPES: ReadonlySet<RunnerJobType> = new Set<RunnerJobType>([
  'research',
  'tagging',
  'findings'
]);

/** A log is a prompt and its streamed answer: kept up to this, then cut. */
export const JOB_LOG_MAX_CHARS = 256 * 1024;
const LOG_CUT = '\n[The log stops here: it reached 256 KB.]\n';
/** Finished jobs shown under Recent. */
export const RECENT_JOBS = 20;
/** The longest title kept. */
const TITLE_MAX = 200;
const ERROR_MAX = 500;

export type JobStart = {
  type: RunnerJobType;
  engine?: RunnerJobEngine | null;
  title?: string;
  board?: string | null;
  boardName?: string | null;
  startedBy?: RunnerJobPerson | null;
  startedByRunner?: string | null;
  /** Work over the Vault: metadata only. */
  vault?: boolean;
  /** A terminal session, which its row opens. */
  session?: { spaceSlug: string; postId: string } | null;
  /** It keeps a log (a background job's prompt and answer). */
  log?: boolean;
  /** When it began, if before now (a session found already running). */
  startedAt?: number;
  /** Cancels its process or request. Absent: it cannot be stopped. */
  stop?: () => void | Promise<void>;
  /** One job per key while it runs: a second start returns the first. */
  key?: string;
};

export type JobHandle = {
  readonly id: string;
  log(text: string): void;
  setEngine(engine: RunnerJobEngine | null): void;
  setItems(items: number): void;
  /** Close it. A job stopped from Activity ends `stopped` whatever this
   *  says. Safe to call twice. */
  end(status: 'done' | 'failed', error?: string): void;
};

/** How a part of the runner registers its work (the daemon hands it in). */
export type StartJob = (input: JobStart) => JobHandle;

type Live = {
  job: RunnerJob;
  log: string;
  key: string | null;
  stop?: () => void | Promise<void>;
  /** Stop was asked for, by this name. */
  stopping: string | null;
};

export type JobRegistryOptions = {
  /** Where finished jobs go. Null: memory only (tests). */
  history: JobHistory | null;
  now?: () => number;
  /** A job was stopped from Activity: its starter is told (daemon). */
  onStopped?: (job: RunnerJob) => void;
};

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export class JobRegistry {
  private readonly live = new Map<string, Live>();
  private readonly byKey = new Map<string, string>();
  private recentJobs: RunnerJob[];
  private readonly now: () => number;

  constructor(private readonly options: JobRegistryOptions) {
    this.now = options.now ?? Date.now;
    this.recentJobs = options.history?.recent(RECENT_JOBS) ?? [];
  }

  start(input: JobStart): JobHandle {
    const existing = input.key ? this.byKey.get(input.key) : undefined;
    if (existing && this.live.has(existing)) return this.handle(existing);
    const vault = input.vault === true || VAULT_JOB_TYPES.has(input.type);
    const id = randomUUID();
    const job: RunnerJob = {
      id,
      type: input.type,
      engine: input.engine ?? null,
      // A Vault job's title is its type: a question or a file name is Vault
      // text.
      title: vault
        ? RUNNER_JOB_TYPE_LABELS[input.type]
        : clip(input.title?.trim() || RUNNER_JOB_TYPE_LABELS[input.type], TITLE_MAX),
      board: input.board ?? null,
      boardName: input.boardName ?? input.board ?? null,
      startedBy: input.startedBy ?? null,
      startedByRunner: input.startedByRunner ?? null,
      startedAt: input.startedAt ?? this.now(),
      endedAt: null,
      status: 'running',
      error: null,
      items: null,
      vault,
      session: vault ? null : (input.session ?? null),
      hasLog: !vault && input.log === true,
      stoppable: Boolean(input.stop),
      stoppedBy: null
    };
    this.live.set(id, { job, log: '', key: input.key ?? null, stop: input.stop, stopping: null });
    if (input.key) this.byKey.set(input.key, id);
    return this.handle(id);
  }

  private handle(id: string): JobHandle {
    return {
      id,
      log: (text) => this.append(id, text),
      setEngine: (engine) => {
        const entry = this.live.get(id);
        if (entry) entry.job = { ...entry.job, engine };
      },
      setItems: (items) => {
        const entry = this.live.get(id);
        if (entry && Number.isFinite(items)) entry.job = { ...entry.job, items: Math.max(0, Math.floor(items)) };
      },
      end: (status, error) => this.end(id, status, error)
    };
  }

  private append(id: string, text: string): void {
    const entry = this.live.get(id);
    // A Vault job has no log at all: nothing it is handed is kept.
    if (!entry || !entry.job.hasLog || !text) return;
    if (entry.log.length >= JOB_LOG_MAX_CHARS) return;
    const room = JOB_LOG_MAX_CHARS - entry.log.length;
    entry.log += text.length > room ? text.slice(0, room) + LOG_CUT : text;
  }

  private end(id: string, status: 'done' | 'failed', error?: string): void {
    const entry = this.live.get(id);
    if (!entry) return;
    this.live.delete(id);
    if (entry.key && this.byKey.get(entry.key) === id) this.byKey.delete(entry.key);
    const stopped = entry.stopping !== null;
    const job: RunnerJob = {
      ...entry.job,
      endedAt: this.now(),
      status: stopped ? 'stopped' : status,
      error: !stopped && status === 'failed' && !entry.job.vault && error ? clip(error, ERROR_MAX) : null,
      stoppable: false,
      stoppedBy: entry.stopping
    };
    this.recentJobs = [job, ...this.recentJobs].slice(0, RECENT_JOBS);
    try {
      this.options.history?.add(job, job.hasLog ? entry.log : null);
    } catch (err) {
      console.error(`[activity] could not keep a job in History: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (stopped) this.options.onStopped?.(job);
  }

  /** Stop a running job by `by` (a person's name). It ends `stopped` once
   *  its process or request has gone. False: not running, or not stoppable. */
  async stop(id: string, by: string): Promise<boolean> {
    const entry = this.live.get(id);
    if (!entry || !entry.stop || entry.stopping !== null) return false;
    entry.stopping = by;
    try {
      await entry.stop();
    } catch (err) {
      console.error(`[activity] stopping ${entry.job.title}: ${err instanceof Error ? err.message : String(err)}`);
    }
    // A stop that ended nothing on its own (a kill whose job does not report
    // back) closes the row here.
    this.end(id, 'done');
    return true;
  }

  /** The job running under `key`, if one is. */
  keyed(key: string): string | undefined {
    const id = this.byKey.get(key);
    return id && this.live.has(id) ? id : undefined;
  }

  /** Keys of every running keyed job under `prefix`, for a sweep. */
  keys(prefix: string): string[] {
    return [...this.byKey.keys()].filter((key) => key.startsWith(prefix));
  }

  /** End the job running under `key`, if one is. */
  endKeyed(key: string, status: 'done' | 'failed', error?: string): void {
    const id = this.keyed(key);
    if (id) this.end(id, status, error);
  }

  running(): RunnerJob[] {
    return [...this.live.values()].map((e) => e.job).sort((a, b) => b.startedAt - a.startedAt);
  }

  recent(): RunnerJob[] {
    return this.recentJobs;
  }

  /** A job by id: running, recent, or in History. */
  get(id: string): RunnerJob | null {
    return (
      this.live.get(id)?.job ??
      this.recentJobs.find((j) => j.id === id) ??
      this.options.history?.get(id) ??
      null
    );
  }

  /** A job's log: a running one's so far, else what History kept. */
  log(id: string): string | null {
    const entry = this.live.get(id);
    if (entry) return entry.job.hasLog ? entry.log : null;
    return this.options.history?.log(id) ?? null;
  }

  /** Recent loses what History purged. */
  forget(ids: ReadonlySet<string>): void {
    if (ids.size > 0) this.recentJobs = this.recentJobs.filter((j) => !ids.has(j.id));
  }
}
