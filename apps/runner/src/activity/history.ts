import fs from 'node:fs';
import path from 'node:path';

import {
  RUNNER_ACTIVITY_RETENTION_DEFAULT_DAYS,
  RUNNER_ACTIVITY_RETENTION_MAX_DAYS,
  RUNNER_ACTIVITY_RETENTION_MIN_DAYS,
  type RunnerJob,
  type RunnerJobHistoryPage,
  RUNNER_JOB_ENGINE_LABELS,
  RUNNER_JOB_TYPE_LABELS
} from '@shared/all/domains/runnerActivity';
import type { RunnerJobHistoryPayload } from '@shared/all/validators';

// The runner's History of finished jobs (.specs/runner.md "Activity"): one
// JSON line per job in `<runner dir>/activity/history.jsonl`, each
// background job's log beside it in `logs/<id>.log`, and the setting (how
// many days to keep, and whether other runners may start sessions here) in
// `settings.json`. Owner-only files (0600 in a 0700
// folder): a log holds prompts. A daily purge drops what is older than the
// setting, logs with it.

const DAY_MS = 24 * 60 * 60_000;
const PAGE_DEFAULT = 30;
/** Ids are the registry's own uuids: anything else names no file. */
const ID_RE = /^[A-Za-z0-9-]{1,128}$/;

/** `allowRemoteStarts`: "Allow sessions to be started from other runners"
 *  (.specs/card-sessions.md "Across runners"), off unless the owner turned
 *  it on. */
type Settings = { retentionDays: number; allowRemoteStarts?: boolean };

const clampDays = (days: unknown): number =>
  typeof days === 'number' && Number.isFinite(days)
    ? Math.min(RUNNER_ACTIVITY_RETENTION_MAX_DAYS, Math.max(RUNNER_ACTIVITY_RETENTION_MIN_DAYS, Math.floor(days)))
    : RUNNER_ACTIVITY_RETENTION_DEFAULT_DAYS;

/** A line off disk as a job, or null when it is not one. */
function parseJob(line: string): RunnerJob | null {
  try {
    const job = JSON.parse(line) as Partial<RunnerJob>;
    if (typeof job.id !== 'string' || !ID_RE.test(job.id)) return null;
    if (typeof job.startedAt !== 'number' || typeof job.type !== 'string') return null;
    return job as RunnerJob;
  } catch {
    return null;
  }
}

/** Whether a finished job matches the History search. */
export function jobMatches(job: RunnerJob, filter: RunnerJobHistoryPayload): boolean {
  if (filter.type && job.type !== filter.type) return false;
  if (filter.engine && job.engine !== filter.engine) return false;
  if (filter.board && job.board !== filter.board) return false;
  if (filter.starter) {
    const starter = filter.starter.toLowerCase();
    const name = job.startedBy?.name.toLowerCase() ?? '';
    const id = job.startedBy?.userId === null || !job.startedBy ? '' : String(job.startedBy.userId);
    if (!name.includes(starter) && id !== starter) return false;
  }
  if (filter.query) {
    const query = filter.query.toLowerCase();
    const haystack = [
      job.title,
      job.board,
      job.boardName,
      job.startedBy?.name,
      job.startedByRunner,
      RUNNER_JOB_TYPE_LABELS[job.type],
      job.engine ? RUNNER_JOB_ENGINE_LABELS[job.engine] : null
    ]
      .filter((part): part is string => typeof part === 'string')
      .join('\n')
      .toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  return true;
}

const endOf = (job: RunnerJob) => job.endedAt ?? job.startedAt;

export class JobHistory {
  private readonly file: string;
  private readonly logs: string;
  private readonly settingsFile: string;

  constructor(
    dir: string,
    private readonly now: () => number = Date.now
  ) {
    this.file = path.join(dir, 'history.jsonl');
    this.logs = path.join(dir, 'logs');
    this.settingsFile = path.join(dir, 'settings.json');
  }

  private ensureDir(): void {
    fs.mkdirSync(this.logs, { recursive: true, mode: 0o700 });
  }

  /** Every job kept, oldest first (the file's order). */
  private all(): RunnerJob[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf-8');
    } catch {
      return [];
    }
    return raw.split('\n').flatMap((line) => {
      const job = line.trim() ? parseJob(line) : null;
      return job ? [job] : [];
    });
  }

  add(job: RunnerJob, log: string | null): void {
    if (!ID_RE.test(job.id)) return;
    this.ensureDir();
    // A Vault job keeps no log, whatever it was handed.
    if (log && !job.vault) {
      fs.writeFileSync(path.join(this.logs, `${job.id}.log`), log, { mode: 0o600 });
    }
    fs.appendFileSync(this.file, `${JSON.stringify(job)}\n`, { mode: 0o600 });
  }

  get(id: string): RunnerJob | null {
    if (!ID_RE.test(id)) return null;
    return this.all().find((job) => job.id === id) ?? null;
  }

  log(id: string): string | null {
    const job = this.get(id);
    if (!job || job.vault || !job.hasLog) return null;
    try {
      return fs.readFileSync(path.join(this.logs, `${job.id}.log`), 'utf-8');
    } catch {
      return null;
    }
  }

  /** The newest `count`, for Recent after a restart. */
  recent(count: number): RunnerJob[] {
    return this.all()
      .sort((a, b) => endOf(b) - endOf(a))
      .slice(0, count);
  }

  /** One page, newest first, of the jobs that match `filter` and that
   *  `visible` lets the caller see. */
  search(filter: RunnerJobHistoryPayload, visible: (job: RunnerJob) => boolean): RunnerJobHistoryPage {
    const limit = filter.limit ?? PAGE_DEFAULT;
    const before = filter.before ?? Infinity;
    const matches = this.all()
      .filter((job) => endOf(job) < before && visible(job) && jobMatches(job, filter))
      .sort((a, b) => endOf(b) - endOf(a));
    const jobs = matches.slice(0, limit);
    const last = jobs[jobs.length - 1];
    return { jobs, next: matches.length > limit && last ? endOf(last) : null };
  }

  private readSettings(): Partial<Settings> {
    try {
      return JSON.parse(fs.readFileSync(this.settingsFile, 'utf-8')) as Partial<Settings>;
    } catch {
      return {};
    }
  }

  private writeSettings(next: Settings): void {
    this.ensureDir();
    fs.writeFileSync(this.settingsFile, JSON.stringify(next satisfies Settings), { mode: 0o600 });
  }

  retentionDays(): number {
    const days = this.readSettings().retentionDays;
    return days === undefined ? RUNNER_ACTIVITY_RETENTION_DEFAULT_DAYS : clampDays(days);
  }

  setRetentionDays(days: number): number {
    const retentionDays = clampDays(days);
    this.writeSettings({ ...this.readSettings(), retentionDays });
    return retentionDays;
  }

  /** Off unless the owner turned it on: a file from before it, or none. */
  allowRemoteStarts(): boolean {
    return this.readSettings().allowRemoteStarts === true;
  }

  setAllowRemoteStarts(allow: boolean): void {
    this.writeSettings({ ...this.readSettings(), retentionDays: this.retentionDays(), allowRemoteStarts: allow });
  }

  /** Drop every job that ended more than the setting's days ago, and its
   *  log. Returns the ids dropped. */
  purge(): Set<string> {
    const cutoff = this.now() - this.retentionDays() * DAY_MS;
    const all = this.all();
    const dropped = new Set(all.filter((job) => endOf(job) < cutoff).map((job) => job.id));
    if (dropped.size === 0) return dropped;
    const kept = all.filter((job) => !dropped.has(job.id));
    this.ensureDir();
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, kept.map((job) => `${JSON.stringify(job)}\n`).join(''), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    for (const id of dropped) fs.rmSync(path.join(this.logs, `${id}.log`), { force: true });
    return dropped;
  }
}
