// A runner's Activity (.specs/runner.md "Activity"): every piece of AI work on
// it, terminal or not, with its type and engine, live, stoppable, and kept in
// a searchable History that the runner purges after a set number of days.
// The registry is the runner daemon's (apps/runner/src/activity/); these are
// the shapes it answers with and the copy both apps draw.

/** What a job is. A new kind of AI work is one entry here, its label below,
 *  and the place in the runner that registers it. */
export const RUNNER_JOB_TYPES = [
  /** A terminal session (Chat or Code, or a card's): it opens its terminal. */
  'coding',
  /** Ask Board ("Ask AI · <board>"). */
  'ask',
  /** Oakbox Ask over the Vault or Runner Cloud. A Vault job. */
  'research',
  /** A recording's work on the runner: a screen recording saved into one
   *  of its stores, with its trim (vault/service.ts). A Vault job when the
   *  store is the Vault. */
  'recording',
  /** Categorize: sorting and tagging the Vault's files. A Vault job. */
  'tagging',
  /** The analytics runner's Findings over the viewing data in the Vault
   *  (vault/findingsJob.ts). A Vault job. */
  'findings',
  /** An Ollama model pulled onto the runner (localAiTags.ts). */
  'model-download',
  /** One `aiPrompt`: a title, Pitch AI, the ontology, Dark Patterns. */
  'ai-request'
] as const;

export type RunnerJobType = (typeof RUNNER_JOB_TYPES)[number];

export const RUNNER_JOB_TYPE_LABELS: Record<RunnerJobType, string> = {
  coding: 'Coding',
  ask: 'Ask AI',
  research: 'Research',
  recording: 'Recording',
  tagging: 'Sorting and tagging',
  findings: 'Findings',
  'model-download': 'Model download',
  'ai-request': 'AI request'
};

export const RUNNER_JOB_ENGINES = ['claude', 'codex', 'ollama'] as const;
export type RunnerJobEngine = (typeof RUNNER_JOB_ENGINES)[number];

export const RUNNER_JOB_ENGINE_LABELS: Record<RunnerJobEngine, string> = {
  claude: 'Claude',
  codex: 'Codex',
  ollama: 'Ollama'
};

export type RunnerJobStatus = 'running' | 'done' | 'failed' | 'stopped';

/** Who started a job, as the server vouched for the link it came on. */
export type RunnerJobPerson = {
  /** Null for the owner's own context, which names no id. */
  userId: number | null;
  name: string;
  role: 'owner' | 'member';
};

export type RunnerJob = {
  id: string;
  type: RunnerJobType;
  /** Null when no AI engine is behind it yet (a model download). */
  engine: RunnerJobEngine | null;
  /** The row's line. A Vault job's is its type's label, never Vault text. */
  title: string;
  /** The board's slug, or null for runner-wide work. */
  board: string | null;
  /** How the runner names the board (its space name). */
  boardName: string | null;
  startedBy: RunnerJobPerson | null;
  /** The runner that asked for it, when another runner did (cross-runner
   *  sessions, card 6336db91). Null: started on this runner. */
  startedByRunner: string | null;
  startedAt: number;
  endedAt: number | null;
  status: RunnerJobStatus;
  /** Why it failed. Never set on a Vault job. */
  error: string | null;
  /** A Vault job's count of items (files tagged). Null when not counted. */
  items: number | null;
  /** A Vault job: metadata only, no log, no text. */
  vault: boolean;
  /** A terminal session's board and card: the row opens it. */
  session: { spaceSlug: string; postId: string } | null;
  /** It keeps a read-only log (prompt and streamed answer). */
  hasLog: boolean;
  /** Running, and the runner can stop it. */
  stoppable: boolean;
  /** Who stopped it, when it was stopped. */
  stoppedBy: string | null;
};

/** The runner's one background `ollama serve`: a service, not a job. */
export type RunnerOllamaService = {
  running: boolean;
  /** The models loaded now, with their memory. */
  models: { name: string; memoryMb: number }[];
};

export type RunnerActivityView = {
  running: RunnerJob[];
  recent: RunnerJob[];
  /** Null when Ollama is not on the runner. */
  ollama: RunnerOllamaService | null;
  /** Days a finished job stays in History (a runner setting). */
  retentionDays: number;
  /** "Allow sessions to be started from other runners" (a runner setting,
   *  off by default; .specs/card-sessions.md "Across runners"). */
  allowRemoteStarts: boolean;
  /** The viewer is the runner's owner: they may change the setting and see
   *  runner-wide work. */
  owner: boolean;
  at: number;
};

export type RunnerJobHistoryPage = {
  jobs: RunnerJob[];
  /** Pass back as `before` for the next page; null at the end. */
  next: number | null;
};

export type RunnerJobLog = {
  text: string;
  /** Why there is nothing to show (a Vault job, a terminal, a purged log). */
  note?: string;
};

/** Default and bounds of the History setting, in days. */
export const RUNNER_ACTIVITY_RETENTION_DEFAULT_DAYS = 30;
export const RUNNER_ACTIVITY_RETENTION_MIN_DAYS = 1;
export const RUNNER_ACTIVITY_RETENTION_MAX_DAYS = 365;
/** A History page, at most. */
export const RUNNER_JOB_HISTORY_PAGE_MAX = 100;

/** The row's second line: type and engine, the board, who started it. */
export function runnerJobMeta(job: RunnerJob): string {
  return [
    RUNNER_JOB_TYPE_LABELS[job.type],
    job.engine ? RUNNER_JOB_ENGINE_LABELS[job.engine] : null,
    job.boardName ?? job.board,
    job.startedBy ? job.startedBy.name : null,
    job.startedByRunner ? `started by ${job.startedByRunner}` : null
  ]
    .filter(Boolean)
    .join(' · ');
}

/** How long a job ran (or has run), as "3m 12s". */
export function runnerJobDuration(job: RunnerJob, now: number): string {
  const ms = Math.max(0, (job.endedAt ?? now) - job.startedAt);
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export const RUNNER_JOB_STATUS_LABELS: Record<RunnerJobStatus, string> = {
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped'
};

/** The row's right side: how long, how it ended, its items, who stopped it. */
export function runnerJobTail(job: RunnerJob, now: number): string {
  return [
    runnerJobDuration(job, now),
    job.status === 'running' ? null : RUNNER_JOB_STATUS_LABELS[job.status],
    job.items !== null
      ? `${job.items} item${job.items === 1 ? '' : 's'}`
      : null,
    job.stoppedBy ? `by ${job.stoppedBy}` : null
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Each status's dot (helpers/statusDot.ts), on web and the phone. */
export const RUNNER_JOB_STATUS_DOT: Record<
  RunnerJobStatus,
  'busy' | 'offline' | 'error' | 'warning'
> = {
  running: 'busy',
  done: 'offline',
  failed: 'error',
  stopped: 'warning'
};

/** The socket message the starter of a stopped job gets (server-relayed). */
export type RunnerJobStoppedMessage = {
  runnerId: number;
  runnerName: string;
  jobId: string;
  title: string;
  stoppedBy: string;
};
