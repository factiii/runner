import type {
  AgentProvider,
  BareFsChange,
  CardAILogEntry as LogEntry,
  CardAIMode,
  CardAISessionPhase as SessionPhase,
  CardAISessionSummary as SessionSummary,
  CardAITodo,
  ExposedPort,
  RunnerActivity,
  RunnerActivityKind,
  RunnerActivityState,
  SecureStoreStatus,
  SessionGitSummary
} from '../../domains/electron';
import type { AgentState } from '../terminal-ai/agentState';

export type { LogEntry, SessionPhase, SessionSummary };

/** The person a session acts for: who started it by hand, or, for one an
 *  agent started through the board MCP (session-hypervisor.ts), the person
 *  that agent's own session acts for. Server-vouched (the channel's scope).
 *  What the session's agent may do through the session tools is what this
 *  person could do by hand (runner-access.ts). */
export type SessionStarter = {
  userId: string;
  name: string;
  role: 'owner' | 'member';
};

/** Fields common to every session: every `SessionSummary` wire field lives
 *  here, and each mode extends it with its own runtime-only state. */
export type BaseSession = {
  taskId: string;
  postId: string;
  phase: SessionPhase;
  mode: CardAIMode;
  step: 1 | 2 | 3;
  logs: LogEntry[];
  diff: string;
  changedFiles: string[];
  commitMessage: string;
  previewUrl: string;
  previewRunning: boolean;
  reproSteps: string;
  pendingQuestion: string;
  error: string;
  startedAt: number;
  /** What the CLI is doing, as the factiii plugin's hooks report it. Absent
   *  until the first hook fires, or forever if the plugin is not installed. */
  agentState?: AgentState;
  /** See SessionSummary.agentLive. Terminal mode only. */
  agentLive?: boolean;
  /** Live tunnels this session's terminals opened. Terminal mode only. */
  exposed?: ExposedPort[];
  /** See SessionSummary.agentActivity. Terminal mode only. */
  agentActivity?: string;
  /** See SessionSummary.git. Terminal mode only. */
  git?: SessionGitSummary;
  taskTitle: string;
  targetBranch: string;
  effort: string;
  todos: CardAITodo[];
  /** Per-job CLI agent for this card. Chosen at spin-up, defaulting to the
   *  space config; the mode engines read this, not the config accessor. */
  provider: AgentProvider;
  /** Working dir the agent runs in: the card's worktree, or empty for a
   *  no-git card, which runs from the workspace root. */
  workspacePath: string;
  /** Provider CLI conversation id. Claude mode fills this in as phases run;
   *  terminal mode fills it in once its chat has run a turn (chatRun.ts),
   *  and leaves it empty until then. */
  agentSessionId: string;
  /** See SessionSummary.cardId. Terminal mode only. */
  cardId?: string;
  /** See SessionSummary.workPath. Terminal mode only; not kept across a
   *  restart, since the agent's next step says it again. */
  workPath?: string;
  /** `workPath` is a git checkout, so the git panel can follow it too. */
  workPathGit?: boolean;
  /** The folder the agent's conversation last said it was in, as the
   *  follower read it: workPath moves when this does, so a set_work_path
   *  holds until the agent moves again. */
  followedPath?: string;
  /** Who the session acts for. Absent from a session started before this
   *  was recorded: it counts as the runner owner's, as every session on the
   *  runner did for jobs (space-core.ts). */
  startedBy?: SessionStarter;
  /** Set when an agent started this session through the board MCP's
   *  start_session: the starting session's id. What the per-board cap
   *  counts (MCP_SESSION_CAP). */
  startedVia?: string;
};

export function toSummary(session: BaseSession): SessionSummary {
  return {
    taskId: session.taskId,
    postId: session.postId,
    phase: session.phase,
    mode: session.mode,
    step: session.step,
    diff: session.diff,
    changedFiles: session.changedFiles,
    commitMessage: session.commitMessage,
    previewUrl: session.previewUrl,
    previewRunning: session.previewRunning,
    reproSteps: session.reproSteps,
    pendingQuestion: session.pendingQuestion,
    error: session.error,
    startedAt: session.startedAt,
    agentState: session.agentState,
    agentLive: session.agentLive,
    exposed: session.exposed,
    agentActivity: session.agentActivity,
    git: session.git,
    targetBranch: session.targetBranch,
    taskTitle: session.taskTitle,
    todos: session.todos,
    agentSessionId: session.agentSessionId,
    // Carry the session's own provider so a terminal resumes with the CLI that
    // actually ran it, not the space default (they can differ per job).
    provider: session.provider,
    cardId: session.cardId,
    workPath: session.workPath,
    workPathGit: session.workPathGit
  };
}

/** Platform-agnostic event sink: Electron IPC on desktop, WebRTC data channel
 *  in the runner daemon. */
export interface AgentEventSink {
  emitSessionUpdate(session: BaseSession): void;
  emitSessionRemoved(postId: string): void;
  emitLog(session: BaseSession, entry: LogEntry): void;
  addLog(session: BaseSession, type: LogEntry['type'], content: string): void;
  appendTextLog(session: BaseSession, text: string): void;
  emitSetupStatus(message: string): void;
  /** One-click Claude sign-in outcome (see claude-login.ts). */
  emitClaudeAuth(payload: {
    status: 'complete' | 'error';
    message?: string;
  }): void;
  /** One-click Codex sign-in outcome (see codex-login.ts). */
  emitCodexAuth(payload: {
    status: 'complete' | 'error';
    message?: string;
  }): void;
  /** GitHub device-code sign-in outcome (see github-auth.ts). */
  emitGithubAuth(payload: {
    status: 'complete' | 'expired' | 'declined' | 'error';
    message?: string;
    login?: string;
  }): void;
  /** Deploy skill creator settled (drafted/failed); reopened modals refetch. */
  emitDeployCreator(payload: {
    phase: 'review' | 'error';
    error?: string;
  }): void;
  /** Deploy run transitioned; clients refetch deployRunState. */
  emitDeployRun(payload: { phase: string }): void;
  /** Env check/fix settled; clients refetch deployEnvState. */
  emitDeployEnv(payload: { phase: 'done' | 'error' }): void;
  /** A command is waiting on the owner's store password, or has stopped
   *  waiting. Carries only whether something is pending - the command, its
   *  keys and its origin come from secretsAuthState, so a stale broadcast can
   *  never leave a prompt on screen for a request that is already answered. */
  emitSecretsAuth(payload: { pending: boolean }): void;
  /** A bare session's working tree changed outside the editor. Per-card so an
   *  open modal only wakes for its own workspace. */
  emitBareFsChange(postId: string, change: BareFsChange): void;
  /** The space's scratchpad changed on disk. Space-wide on purpose: every
   *  session on the board draws on the same surface. */
  emitScratchpad(payload: { at: number }): void;
  /** A write changed which keys the space's secrets store holds. Carries no
   *  names: a client re-asks `attention` (the missing-secrets badge). */
  emitSecretsChanged(payload: { at: number }): void;
  /** Space-level work that isn't a card session. See ActivityTracker. */
  emitActivityUpdate(activity: RunnerActivity): void;
}

/**
 * The runner's non-session work, so the Running jobs panel can show everything
 * the machine is doing rather than cards alone.
 *
 * Live activities are held here as well as emitted, because a client that
 * connects mid-deploy would otherwise see nothing until the next transition —
 * the same replay problem sessions solve in the daemon.
 */
export class ActivityTracker {
  private readonly live = new Map<string, RunnerActivity>();

  constructor(private readonly emitter: AgentEventSink) {}

  /** Start or update one activity. Re-calling with the same id replaces the
   *  row, which is how a step label advances (`setup` → "installing node"). */
  set(
    kind: RunnerActivityKind,
    state: RunnerActivityState,
    label: string,
    detail = '',
    /** Discriminator for kinds that can run more than one at a time — only
     *  sign-ins, where GitHub and Claude can both be pending. */
    key = ''
  ): void {
    const id = key ? `${kind}:${key}` : kind;
    const activity: RunnerActivity = {
      id,
      kind,
      state,
      label,
      detail,
      // Keep the original start so a step change doesn't reset the clock.
      startedAt: this.live.get(id)?.startedAt ?? Date.now()
    };
    this.live.set(id, activity);
    this.emitter.emitActivityUpdate(activity);
  }

  /** Retire an activity. Safe to call for one that never started. */
  clear(kind: RunnerActivityKind, key = ''): void {
    const id = key ? `${kind}:${key}` : kind;
    const existing = this.live.get(id);
    if (!existing) return;
    this.live.delete(id);
    this.emitter.emitActivityUpdate({ ...existing, state: null });
  }

  /** One live activity by its row id (`kind` or `kind:key`). */
  get(id: string): RunnerActivity | undefined {
    return this.live.get(id);
  }

  /** Everything live right now, for the replay a fresh channel needs. */
  list(): RunnerActivity[] {
    return [...this.live.values()];
  }

  /** Runner shutdown: nothing survives the process, so drop the rows. */
  destroy(): void {
    for (const id of [...this.live.keys()]) {
      const existing = this.live.get(id)!;
      this.live.delete(id);
      this.emitter.emitActivityUpdate({ ...existing, state: null });
    }
  }
}

/** Platform-agnostic config provider: Electron safeStorage on desktop, a local
 *  encrypted file in the runner daemon. */

export interface CardAIConfig {
  repoUrl: string;
  mainBranch: string;
  gitName: string;
  gitEmail: string;
  githubToken: string;
  /** CLI agent running this space's AI work. Defaults to 'claude' when
   *  absent (back-compat for existing configs). */
  provider?: AgentProvider;
}

export interface ConfigProvider {
  readConfig(spaceSlug: string): CardAIConfig;
  writeConfig(spaceSlug: string, config: CardAIConfig): void;
  /** Per-space environment root, guaranteed to exist: workspace/, backups/,
   *  builds/, secrets/. The deploy skill contract assumes this layout. */
  spaceDir(spaceSlug: string): string;
  /** Whether this host encrypts stored connection tokens at rest. Optional, so
   *  a provider without the notion reports unencrypted rather than lying. */
  tokensEncrypted?(): boolean;
  /** Why this space's stored settings cannot be read right now (no keychain,
   *  or a file still locked behind an old connection password), or null when
   *  they can. readConfig degrades to empty in that state so the settings
   *  panel still renders; this lets a caller that then finds no repository
   *  say the real reason instead of "not connected". */
  configProblem?(spaceSlug: string): string | null;
  /** The detail behind tokensEncrypted: key store, optional password layer,
   *  lock state, and the remedy when the store is unusable. */
  secureStore?(): SecureStoreStatus;
}

/** Default AgentEventSink implementation that handles log accumulation. */
export function createEventSink(
  send: (event: string, data: unknown) => void,
  spaceSlug: string,
  notify?: (title: string, body: string, silent: boolean) => void
): AgentEventSink {
  const PHASE_LABELS: Partial<Record<SessionPhase, string>> = {
    research: 'Research started',
    'awaiting-input': 'Input required',
    implement: 'Implementation started',
    review: 'Review started',
    complete: 'Task complete',
    error: 'Task failed'
  };

  const channel = (event: string) => `board-agent:${spaceSlug}:${event}`;

  return {
    emitSessionUpdate(session: BaseSession): void {
      send(channel('session-update'), toSummary(session));

      const label = PHASE_LABELS[session.phase];
      if (label && notify) {
        notify(
          `Board AI - ${label}`,
          `${session.taskTitle || 'Card'} (step ${session.step}/3)`,
          session.phase !== 'complete' &&
            session.phase !== 'error' &&
            session.phase !== 'awaiting-input'
        );
      }
    },

    emitSessionRemoved(postId: string): void {
      send(channel('session-update'), {
        postId,
        phase: null,
        mode: 'claude',
        step: 1,
        taskId: '',
        diff: '',
        changedFiles: [],
        commitMessage: '',
        previewUrl: '',
        previewRunning: false,
        reproSteps: '',
        pendingQuestion: '',
        error: '',
        startedAt: 0,
        targetBranch: '',
        taskTitle: '',
        todos: [],
        agentSessionId: ''
      });
    },

    emitLog(session: BaseSession, entry: LogEntry): void {
      send(channel(`log:${session.postId}`), entry);
    },

    addLog(
      session: BaseSession,
      type: LogEntry['type'],
      content: string
    ): void {
      const entry: LogEntry = { time: Date.now(), type, content };
      session.logs.push(entry);
      this.emitLog(session, entry);
    },

    appendTextLog(session: BaseSession, text: string): void {
      const last = session.logs[session.logs.length - 1];
      if (last && last.type === 'text') {
        last.content += text;
        this.emitLog(session, {
          time: last.time,
          type: 'text-append',
          content: text
        });
      } else {
        const entry: LogEntry = {
          time: Date.now(),
          type: 'text',
          content: text
        };
        session.logs.push(entry);
        this.emitLog(session, entry);
      }
    },

    emitSetupStatus(message: string): void {
      send(channel('setup-status'), message);
    },

    emitClaudeAuth(payload): void {
      send(channel('claude-auth'), payload);
    },

    emitCodexAuth(payload): void {
      send(channel('codex-auth'), payload);
    },

    emitGithubAuth(payload): void {
      send(channel('github-auth'), payload);
    },

    emitDeployCreator(payload): void {
      send(channel('deploy-creator'), payload);
    },

    emitDeployRun(payload): void {
      send(channel('deploy-run'), payload);
    },

    emitDeployEnv(payload): void {
      send(channel('deploy-env'), payload);
    },

    emitSecretsAuth(payload): void {
      send(channel('secrets-auth'), payload);
    },

    emitBareFsChange(postId, change): void {
      send(channel(`bare-fs:${postId}`), change);
    },

    emitScratchpad(payload): void {
      send(channel('scratchpad'), payload);
    },

    emitSecretsChanged(payload): void {
      send(channel('secrets-changed'), payload);
    },

    emitActivityUpdate(activity): void {
      send(channel('activity-update'), activity);
    }
  };
}
