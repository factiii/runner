import type {
  BoardAgentAction,
  CardAISessionSummary,
  RunnerGrants
} from '@shared/all/domains/electron';
import type {
  RunnerActivityView,
  RunnerJob,
  RunnerJobEngine,
  RunnerJobHistoryPage,
  RunnerJobLog,
  RunnerOllamaService
} from '@shared/all/domains/runnerActivity';
import type { VouchedScope } from '@shared/all/helpers/board-agent-core/runner-access';
import type { SessionStarter } from '@shared/all/helpers/board-agent-core/session';
import {
  runnerActivitySettingsSchema,
  runnerJobHistorySchema,
  runnerJobIdSchema
} from '@shared/all/validators';

import { personOf } from '../runnerConnections';
import {
  ACTIVITY_REFUSAL,
  ACTIVITY_SETTINGS_REFUSAL,
  mayOpenActivity,
  mayWatchJob,
  NO_SUCH_JOB
} from './access';
import { JobHistory } from './history';
import { type JobHandle, type JobStart, JobRegistry } from './registry';

// The runner's Activity in the daemon (.specs/runner.md "Activity"): the job
// registry and its History, the five actions the apps call, the terminal
// sessions folded in as `coding` jobs, and the daily purge. The daemon
// answers the actions before any board (RUNNER_ACTIVITY_ACTIONS); every job
// and log goes through mayWatchJob first.

const DAY_MS = 24 * 60 * 60_000;
/** A card run in one of these is over, though its record stays. */
const ENDED_PHASES = new Set(['complete', 'done', 'error']);
/** A terminal's phases: `bare-active` while it is open, `bare-review` once
 *  its changes wait for review. */
const TERMINAL_PHASES = new Set(['bare-active', 'bare-review']);
const STOPPED_FROM_ACTIVITY = "Stopped from the runner's Activity.";
const OLLAMA_PS_TIMEOUT_MS = 2_000;
const MB = 1024 * 1024;

/** One board's engine, as far as Activity reads it (engine.ts). */
export type ActivityBoard = {
  cardSessions(): Record<string, Partial<CardAISessionSummary>>;
  sessionStarter(postId: string): SessionStarter | undefined;
  /** The runner that started it through the server's relay, if one did. */
  sessionStartedByRunner?(postId: string): string | undefined;
  stopSession(postId: string, reason: string): Promise<boolean>;
};

export type ActivityDeps = {
  /** `<runner dir>/activity`. */
  dir: string;
  grants: () => RunnerGrants;
  /** The owner, for a session with no starter recorded (session.ts). */
  owner: () => { userId: string; name: string };
  boardName: (slug: string) => string;
  boards: () => Iterable<[string, ActivityBoard]>;
  ollama: () => Promise<RunnerOllamaService | null>;
  /** A job was stopped: tell its starter (the daemon's socket). */
  onStopped: (job: RunnerJob) => void;
  /** The owner turned "Allow sessions to be started from other runners" on
   *  or off: the server's directory says so at once. */
  onRemoteStartsChanged?: () => void;
  now?: () => number;
};

export type ActivityHost = {
  /** Register a piece of AI work; `end` it when it ends. */
  start(input: JobStart): JobHandle;
  handle(action: BoardAgentAction, payload: unknown, scope: VouchedScope): Promise<unknown>;
  /** Fold the boards' sessions in: a new one starts a `coding` job, a gone
   *  one ends it. On every session event and every read. */
  syncSessions(): void;
  /** Purge now and once a day after. Returns the stop. */
  startPurge(): () => void;
  /** "Allow sessions to be started from other runners", read now. */
  allowRemoteStarts(): boolean;
  registry: JobRegistry;
};

const sessionKey = (slug: string, postId: string) => `session:${slug}:${postId}`;

const sessionEngine = (s: Partial<CardAISessionSummary>): RunnerJobEngine | null =>
  s.chatCli ?? s.provider ?? null;

/** Whether a session's AI is at work now. A card run is until an ended
 *  phase. A terminal is only while it has a live turn (its CLI or its chat
 *  working, or waiting on a permission): an open terminal at rest, or in
 *  review, is no running job, so it keeps no board busy (sessionRelay.ts)
 *  and each turn is its own job. */
const sessionWorking = (s: Partial<CardAISessionSummary>): boolean => {
  const phase = s.phase ?? '';
  if (ENDED_PHASES.has(phase)) return false;
  if (!TERMINAL_PHASES.has(phase)) return true;
  return phase === 'bare-active' && (s.agentState === 'working' || s.agentState === 'blocked');
};

export function createActivityHost(deps: ActivityDeps): ActivityHost {
  const now = deps.now ?? Date.now;
  const history = new JobHistory(deps.dir, now);
  const registry = new JobRegistry({ history, now, onStopped: deps.onStopped });
  /** Sessions stopped from Activity: their record stays (stopSession), so
   *  they are not taken for new work until they are gone. */
  const stoppedSessions = new Set<string>();

  const syncSessions = () => {
    /** Each session's key, with its summary when its card run is over (or
     *  its terminal has no live turn) and null while it runs. */
    const seen = new Map<string, Partial<CardAISessionSummary> | null>();
    for (const [slug, board] of deps.boards()) {
      for (const [postId, summary] of Object.entries(board.cardSessions())) {
        const key = sessionKey(slug, postId);
        const over = !sessionWorking(summary);
        seen.set(key, over ? summary : null);
        if (over || stoppedSessions.has(key) || registry.keyed(key)) continue;
        const starter = board.sessionStarter(postId) ?? { ...deps.owner(), role: 'owner' as const };
        registry.start({
          key,
          type: 'coding',
          engine: sessionEngine(summary),
          title: summary.taskTitle || 'Terminal',
          board: slug,
          boardName: deps.boardName(slug),
          startedBy: personOf(starter),
          startedByRunner: board.sessionStartedByRunner?.(postId) ?? null,
          session: { spaceSlug: slug, postId },
          // A terminal's job is its turn, which starts now; its session
          // started when the terminal opened.
          startedAt:
            typeof summary.startedAt === 'number' && !TERMINAL_PHASES.has(summary.phase ?? '')
              ? summary.startedAt
              : undefined,
          stop: async () => {
            stoppedSessions.add(key);
            await board.stopSession(postId, STOPPED_FROM_ACTIVITY);
          }
        });
      }
    }
    // Gone, its card run is over, or its terminal's turn ended: the job ends.
    for (const key of registry.keys('session:')) {
      if (seen.get(key) === null) continue;
      const ended = seen.get(key);
      registry.endKeyed(key, ended?.phase === 'error' ? 'failed' : 'done', ended?.error);
    }
    // A stopped session may start again once it is gone.
    for (const key of [...stoppedSessions]) if (!seen.has(key)) stoppedSessions.delete(key);
  };

  const view = async (scope: VouchedScope): Promise<RunnerActivityView> => {
    syncSessions();
    const grants = deps.grants();
    const visible = (job: RunnerJob) => mayWatchJob(scope, grants, job);
    const ollama = await deps.ollama().catch(() => null);
    return {
      running: registry.running().filter(visible),
      recent: registry.recent().filter(visible),
      ollama,
      retentionDays: history.retentionDays(),
      allowRemoteStarts: history.allowRemoteStarts(),
      owner: scope.role === 'owner',
      at: now()
    };
  };

  /** A job the caller may see, else the same refusal as a missing one. */
  const visibleJob = (id: string, scope: VouchedScope): RunnerJob => {
    const job = registry.get(id);
    if (!job || !mayWatchJob(scope, deps.grants(), job)) throw new Error(NO_SUCH_JOB);
    return job;
  };

  const log = (id: string, scope: VouchedScope): RunnerJobLog => {
    const job = visibleJob(id, scope);
    if (job.vault) {
      return { text: '', note: 'A Vault job keeps no log: only its type, engine, times, status and item count.' };
    }
    if (job.session) return { text: '', note: 'A terminal keeps its own output: open its terminal.' };
    const text = registry.log(id);
    if (text === null) return { text: '', note: 'This job keeps no log, or its log was purged.' };
    return text ? { text } : { text, note: 'Nothing was written yet.' };
  };

  const purge = () => {
    try {
      registry.forget(history.purge());
    } catch (err) {
      console.error(`[activity] History purge failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handle = async (action: BoardAgentAction, payload: unknown, scope: VouchedScope): Promise<unknown> => {
    const grants = deps.grants();
    if (!mayOpenActivity(scope, grants)) throw new Error(ACTIVITY_REFUSAL);
    switch (action) {
      case 'runnerActivity':
        return view(scope);
      case 'runnerJobHistory': {
        const filter = runnerJobHistorySchema.parse(payload ?? {});
        return history.search(filter, (job) => mayWatchJob(scope, grants, job)) satisfies RunnerJobHistoryPage;
      }
      case 'runnerJobLog':
        return log(runnerJobIdSchema.parse(payload).id, scope);
      case 'runnerJobStop': {
        const { id } = runnerJobIdSchema.parse(payload);
        visibleJob(id, scope);
        return { stopped: await registry.stop(id, personOf(scope).name) };
      }
      case 'runnerActivitySettings': {
        if (scope.role !== 'owner') throw new Error(ACTIVITY_SETTINGS_REFUSAL);
        const settings = runnerActivitySettingsSchema.parse(payload);
        if (settings.retentionDays !== undefined) {
          history.setRetentionDays(settings.retentionDays);
          purge();
        }
        if (settings.allowRemoteStarts !== undefined) {
          history.setAllowRemoteStarts(settings.allowRemoteStarts);
          deps.onRemoteStartsChanged?.();
        }
        return view(scope);
      }
      default:
        throw new Error(`Unknown Activity action: ${String(action)}`);
    }
  };

  const startPurge = () => {
    purge();
    const timer = setInterval(purge, DAY_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  };

  return {
    start: (input) => registry.start(input),
    handle,
    syncSessions,
    startPurge,
    allowRemoteStarts: () => history.allowRemoteStarts(),
    registry
  };
}

/** The runner's one `ollama serve` (.specs/runner.md "Activity"): up or
 *  down, and what it has loaded with its memory (`/api/ps`). Null when
 *  Ollama is not on the machine. */
export async function readOllamaService(
  baseUrl: string,
  installed: () => Promise<boolean>,
  fetchImpl: typeof fetch = fetch
): Promise<RunnerOllamaService | null> {
  if (!(await installed().catch(() => false))) return null;
  try {
    const res = await fetchImpl(`${baseUrl}/api/ps`, { signal: AbortSignal.timeout(OLLAMA_PS_TIMEOUT_MS) });
    if (!res.ok) return { running: false, models: [] };
    const body = (await res.json()) as { models?: { name?: unknown; size?: unknown }[] };
    const models = (body.models ?? []).flatMap((m) =>
      typeof m.name === 'string'
        ? [{ name: m.name, memoryMb: typeof m.size === 'number' ? Math.round(m.size / MB) : 0 }]
        : []
    );
    return { running: true, models };
  } catch {
    return { running: false, models: [] };
  }
}
