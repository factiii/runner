import type { ChildProcess } from 'child_process';
import { basename, dirname, join } from 'path';
import { z } from 'zod';

import type {
  BoardAgentActionMap,
  PendingDangerousApproval,
  RunnerCleanup,
  RunnerPartsState,
  RunnerServiceOutcome,
  RunnerServiceState,
  SecureStoreStatus
} from '../../domains/electron';
import {
  activityDismissable,
  SETUP_AUTH_PREFIX,
  SETUP_EXTRA_PREFIX,
  SETUP_LOG_PREFIX
} from '../../domains/electron';
import {
  isWorktreeSession,
  orphanWorkspaceFromPanes,
  sweepLeftoverTerminals,
  teardownSession
} from '../card-ai/card-session';
import { ClaudeModeEngine } from '../card-ai/claude-mode';
import { listConversations } from '../terminal-ai/chatHistory';
import { findAgentPane } from '../terminal-ai/chatPane';
import { ChatRuns } from '../terminal-ai/chatRun';
import { terminalInterrupt } from '../terminal-ai/chatTerminal';
import {
  readChatTranscript,
  readWorkPath,
  resolveWorkPath
} from '../terminal-ai/chatTranscript';
import { codexInterrupt } from '../terminal-ai/codexPane';
import { tmuxName } from '../terminal-ai/terminal';
import { TerminalModeEngine } from '../terminal-ai/terminal-mode';
import { signOut, spawnAgent } from './agent';
import {
  boardTerminalKey,
  isCardPostId,
  sessionCardId,
  sessionProvider
} from './boardTerminal';
import { ClaudeLoginFlow } from './claude-login';
import { CodexLoginFlow } from './codex-login';
import type { ExecTarget } from './exec';
import {
  commitAndPush,
  isDisposableWorktree,
  NoChangesError,
  readWorkState,
  worktreeBranch
} from './git';
import {
  fetchGithubIdentity,
  type GithubRevokeOutcome,
  type GithubTokenRevoker,
  isGithubOAuthAppToken,
  listGithubBranches,
  listGithubRepos,
  pollGithubDeviceCode,
  startGithubDeviceCode
} from './github-auth';
import {
  approveDeploySkill,
  cachedOriginFiles,
  checkDeployStatus,
  discardDeploySkill,
  ensureWorkspaceClone,
  fixEnvironment,
  generateDeploySkill,
  hostGit,
  listReleaseBranches,
  loadSkillDraft,
  REQUIRED_VARIABLES_PATH,
  requiredVariableKeys,
  reviseDeploySkill,
  runEnvironmentCheck,
  spaceEnv,
  withSpaceGit
} from './host-deploy';
import { killTree } from './host-env';
import {
  DEPLOY_SKILL,
  isDeploySkill,
  runOrigin,
  type RunSkill,
  startSkillRun
} from './host-run';
import {
  checkMergedSkill,
  prepareSkillUpdate,
  type SkillLibraryUpdate
} from './host-skill-update';
import {
  adoptRunnerKey,
  changeSpacePassword,
  initSecrets,
  listSecretKeys,
  readSecretMeta,
  runnerRecipient,
  secretFileEnvKeys,
  secretsInitialized,
  setSecret,
  setSecretFile,
  setSecretFileEnvKey,
  setSecretMeta,
  spaceKeyDir,
  storedSecretFiles,
  storedSecretKeys,
  unsetSecret,
  unsetSecretFile,
  unsetSecretFileEnvKey
} from './host-secrets';
import {
  deleteGlobalSkill,
  listSkills,
  migrateSkills,
  proposeRepoSkill,
  readSkill,
  writeGlobalSkill
} from './host-skills';
import {
  filledCommand,
  type JobDef,
  JobRunner,
  JOBS_PATH,
  parseJobs
} from './jobs';
import type { ModeEngine } from './mode';
import {
  OWNER_APPROVAL_TIMEOUT_MS,
  type OwnerApprovalResult,
  OwnerApprovals
} from './owner-approval';
import { isFailedPasswordAttempt } from './password-throttle';
import { allocateSessionPorts, pruneSessionPorts } from './port-blocks';
import { buildPrompt } from './prompt';
import prompts from './prompts.json';
import { type AgentProvider, resolveProvider } from './providers';
import { ScratchpadStore } from './scratchpad-store';
import {
  applySecretsBackupImport,
  exportSecretsBackup,
  openSecretsBackup,
  planSecretsBackupImport,
  storeKeyFor
} from './secrets-backup';
import { type InboxSubmit, SecretsInbox } from './secrets-inbox';
import {
  type AuditVia,
  authorizeAndRun,
  GITHUB_TOKEN_KEYS
} from './secrets-run';
import type {
  ActivityTracker,
  AgentEventSink,
  BaseSession,
  SessionStarter,
  SessionSummary
} from './session';
import type { HypervisorBoard, HypervisorSession } from './session-hypervisor';
import { SimulatorStore } from './simulator-store';
import { SpaceCore, type SpaceCoreOptions } from './space-core';
import {
  type CardRecord,
  ensureRedis,
  getCard,
  listCards,
  patchCard
} from './state';
import { captureTmuxPane } from './tmux';
import { environmentStatus, installExtra } from './toolchain';
import { slugifyWorkName } from './workName';

/** How long a sign-in row may wait on the user. Device codes (GitHub, Codex)
 *  expire after 15 minutes; the margin covers a slow last poll. */
const SIGNIN_TTL_MS = 20 * 60 * 1000;

function sanitizeTaskId(taskId: string): string {
  const sanitized = String(taskId).replace(/[^a-zA-Z0-9_.-]/g, '');
  if (!sanitized) throw new Error('Invalid taskId');
  return sanitized;
}

// Shape the cardMergeContent one-shot must return; caps match posts.merge.
const mergedCardSchema = z.object({
  title: z.string().trim().min(1).max(255),
  content: z.string().max(5000)
});

export type BoardAgentEngineOptions = SpaceCoreOptions & {
  /** Directory holding the simulator helpers' Objective-C sources, which the
   *  runner resolves against its own install. Shared code cannot find them: it
   *  has no `__dirname` and also compiles for web and mobile. Empty disables
   *  the simulator panel, which is the right answer off a Mac. */
  nativeDir?: string;
  /** Where simulator frames go. The runner points this at the peer
   *  connection's video track; anything without one leaves it unset and the
   *  panel simply never receives video. */
  onSimulatorFrame?: (accessUnit: Uint8Array, capturedAt: number) => void;
  /** Fired before this space starts encoding, so the host can stop any other
   *  space that is. One engine cannot see another; the runner holds them all. */
  onSimulatorAttach?: () => void;
  /** Asks the Factiii server to revoke one GitHub token at GitHub, when a
   *  board disconnects GitHub. Set on the headless runner, which can prove to
   *  the server who it is; unset on desktop, where a disconnect forgets the
   *  token locally and says it was not revoked. */
  revokeGithubToken?: GithubTokenRevoker;
  /** A job's redacted output, as it arrives, for the server relay. */
  onJobLog?: (callId: string, seq: number, text: string) => void;
  /** A job's phase changed before it ended, for the server relay. */
  onJobState?: (
    callId: string,
    state: 'queued' | 'waiting-owner' | 'waiting-auth' | 'running',
    via: AuditVia
  ) => void;
  /** The runner owner's user id, from the runner's own pairing token. Only
   *  this id may answer a dangerous job approval; unset = nobody can, so
   *  every such call ends denied. */
  runnerOwnerId?: string | null;
  /** A member's dangerous job call started waiting on the owner, so the
   *  runner can ask the server to push the owner. Names only. */
  onDangerousApproval?: (request: PendingDangerousApproval) => void;
  /** The runner's always-on service (start at login). Set by the headless
   *  runner only: the desktop app starts itself, so it has none, and the
   *  actions answer "not supported". */
  runnerService?: RunnerServiceHost;
  /** The runner's installable parts (apps/runner partsManager.ts). Set by the
   *  headless runner only: the desktop app answers "not supported". */
  runnerParts?: RunnerPartsHost;
  /** This board signed a CLI in or out. Every board on the runner shares
   *  the one CLI home, so the host passes it to the other boards' cached
   *  sign-in (signinChanged); without it they kept saying signed in. */
  onSigninChanged?: (provider: AgentProvider, signedIn: boolean) => void;
  /** A job settled, for the server relay. */
  onJobEnd?: (
    callId: string,
    state: 'done' | 'denied' | 'failed' | 'cancelled',
    exitCode: number | null
  ) => void;
};

/** What the host does for the service actions (apps/runner runnerService.ts). */
export type RunnerServiceHost = {
  status(): Promise<RunnerServiceState>;
  install(): Promise<RunnerServiceOutcome>;
  remove(): Promise<RunnerServiceOutcome>;
};

/** What the host does for the parts actions (apps/runner partsManager.ts). */
export type RunnerPartsHost = {
  list(): Promise<RunnerPartsState>;
  act(payload: unknown): Promise<RunnerPartsState>;
  /** Free up space: a dry run unless the payload confirms. */
  cleanup(payload: unknown): Promise<RunnerCleanup>;
};

const NO_PARTS: RunnerPartsState = {
  supported: false,
  reason: 'Only the installed runner (factiii-runner) has parts to add.',
  parts: []
};

const NO_CLEANUP: RunnerCleanup = {
  items: [],
  bytes: 0,
  ran: false,
  lines: ['Only the installed runner (factiii-runner) frees up space.']
};

/** The answer where there is no service to manage. */
const NO_SERVICE: RunnerServiceState = {
  supported: false,
  reason: 'Only the installed runner (factiii-runner) can start by itself.',
  name: '',
  installed: 'no',
  loaded: false,
  thisRunner: false
};

/**
 * Who is acting, for the actions that care: the unlock window records who
 * opened it, and the audit log names every actor. `actor` is server-vouched
 * (the offer scope, or the server's own event); `via` says which road the
 * action took. Absent = the runner owner's own channel (older callers).
 */
export type ActionContext = {
  actor: { userId: string; name: string };
  via: AuditVia;
  /** Whether the actor is the runner owner: the owner may cancel and see any
   *  call, a member only its own. Absent = owner (older callers). */
  role?: 'owner' | 'member';
  /** Whether a member runs dangerous jobs on
   *  this board without the owner's approval per call: the owner gave them
   *  the permission. Ignored for the owner. Absent = each call waits for the
   *  owner. */
  dangerous?: boolean;
};

const OWNER_CONTEXT: ActionContext = {
  actor: { userId: '', name: 'Owner' },
  via: 'data-channel',
  role: 'owner'
};

const isOwnerContext = (ctx: ActionContext) => ctx.role !== 'member';

/** Who a session started on this channel acts for (BaseSession.startedBy). */
const starterOf = (ctx: ActionContext): SessionStarter => ({
  userId: String(ctx.actor.userId),
  name: ctx.actor.name,
  role: isOwnerContext(ctx) ? 'owner' : 'member'
});

/** How long start_session's opening message waits for the workspace (a
 *  first clone can take minutes), and how often it looks. */
const SEND_WHEN_READY_MS = 10 * 60_000;
const SEND_WHEN_READY_POLL_MS = 1000;

/** A terminal session's state as list_sessions says it. */
function hypervisorState(
  s: BaseSession,
  chatRunning: boolean
): HypervisorSession['state'] {
  if (s.phase === 'starting') return 'starting';
  if (s.phase === 'error') return 'error';
  if (s.agentState === 'blocked') return 'needs you';
  if (s.agentState === 'working' || chatRunning) return 'working';
  return 'idle';
}

const DANGEROUS_APPROVAL_OWNER_ONLY =
  'Only the owner of this runner can see or answer a dangerous job approval.';

/** How a dangerous job approval ended, for its audit line. */
function ownerAnswerText(result: OwnerApprovalResult): string {
  if (result.approved) return 'approved this call';
  if (result.reason === 'denied') return 'denied';
  if (result.reason === 'timeout') {
    return `no answer in ${OWNER_APPROVAL_TIMEOUT_MS / 60_000} minutes`;
  }
  return 'withdrawn (cancelled)';
}

/** The largest file secret the app may upload: a signing certificate or a
 *  whole server .env is kilobytes; anything near this is a mistake. */
const MAX_FILE_SECRET_BYTES = 5 * 1024 * 1024;

/** Base64 from the app to bytes, refusing text that is not base64 (Buffer
 *  would silently skip it) and anything over the cap. Name validation is
 *  host-secrets' (env-style, as it becomes the variable holding the path). */
export function decodeFileSecret(contentBase64: string): Buffer {
  const clean = contentBase64.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) {
    throw new Error('The file did not arrive as base64.');
  }
  // 4 base64 chars per 3 bytes: refuse before decoding a huge payload.
  if ((clean.length * 3) / 4 > MAX_FILE_SECRET_BYTES + 3) {
    throw new Error('A file secret can be at most 5 MB.');
  }
  const data = Buffer.from(clean, 'base64');
  if (data.length > MAX_FILE_SECRET_BYTES) {
    data.fill(0);
    throw new Error('A file secret can be at most 5 MB.');
  }
  if (data.length === 0) throw new Error('The file is empty.');
  return data;
}

const errText = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** Wires the shared space core to the two mode engines (claude pipeline +
 *  terminal). Owns no session state of its own. */

/** The actions that change which keys or files a board's secrets store
 *  holds: after one, the runner emits `secrets-changed` (dispatch). */
const SECRETS_STORE_WRITES: ReadonlySet<string> = new Set([
  'deploySecretsInit',
  'deploySecretsSet',
  'deploySecretsUnset',
  'deploySecretsSetFile',
  'deploySecretsUnsetFile',
  'secretFileEnvSet',
  'secretFileEnvUnset',
  'secretsImportBackupApply',
  'secretsInboxAnswer'
]);

/** How often each session's IDE checks where its agent is working. */
const WORK_PATH_POLL_MS = 5000;

export class BoardAgentEngine {
  private core: SpaceCore;
  private claude: ClaudeModeEngine;
  private terminal: TerminalModeEngine;
  /** Each terminal session's chat: its own headless Claude (chatRun.ts). */
  private chatRuns: ChatRuns;
  private workPathTimer: ReturnType<typeof setInterval>;
  private followingWorkPaths = false;
  private emitter: AgentEventSink;
  /** The space's display surface. Owned here rather than by either mode: both
   *  of them draw on it, and it outlives every session on the board. */
  private scratchpad: ScratchpadStore;
  private simulator: SimulatorStore;
  /** Told before this space attaches, so the host can stop any other space's
   *  encoder. Held because `options` is not. */
  private onSimulatorAttach?: () => void;
  private onJobLog?: BoardAgentEngineOptions['onJobLog'];
  private onJobEnd?: BoardAgentEngineOptions['onJobEnd'];
  private onSigninChanged?: BoardAgentEngineOptions['onSigninChanged'];
  private onJobState?: BoardAgentEngineOptions['onJobState'];
  private revokeGithubToken?: GithubTokenRevoker;
  private runnerService?: RunnerServiceHost;
  private runnerParts?: RunnerPartsHost;
  private jobRunner: JobRunner | null = null;
  private inbox: SecretsInbox | null = null;
  /** Members' dangerous job calls waiting on the runner owner. */
  private approvals = new OwnerApprovals();
  /** Sessions whose port block is being reserved: not in memory yet, so the
   *  startup prune must be told they are live. */
  private reservingPorts = new Set<string>();
  private runnerOwnerId: string | null;
  /** Board AI questions being answered right now, across conversations. */
  private asksInFlight = 0;

  /** Everything the runner does for this space that isn't a card session, so
   *  the Running jobs panel can report the whole machine. Owned by the core,
   *  which the setup path also drives. */
  get activity(): ActivityTracker {
    return this.core.activity;
  }

  constructor(options: BoardAgentEngineOptions) {
    this.core = new SpaceCore({
      ...options,
      // Only the runner's own toolchain commands can reach this; the agent
      // protocol has no path to sudo, deliberately.
      requestSudo: (reason) => this.askSudo(reason)
    });
    this.emitter = options.emitter;
    this.claude = new ClaudeModeEngine(this.core, this.emitter);
    this.terminal = new TerminalModeEngine(this.core, this.emitter);
    this.core.sessionLinks = {
      card: (id) => {
        const session = this.terminal.get(id);
        return session ? sessionCardId(session) : undefined;
      },
      link: (id, cardId) => this.terminal.setCardId(id, cardId),
      workPath: async (id, dir) => {
        const target = this.core.target();
        const root = target.paths.root;
        const work = await resolveWorkPath(target, dir);
        if (!work) throw new Error(`${dir} is not a folder on this runner.`);
        if (work.path !== root && !work.path.startsWith(`${root}/`)) {
          throw new Error(`Only folders inside this board's space (${root}).`);
        }
        this.terminal.setWorkPath(id, work.path, work.git);
        return work;
      }
    };
    // The IDE follows each session's agent wherever it works.
    this.workPathTimer = setInterval(
      () => void this.followWorkPaths(),
      WORK_PATH_POLL_MS
    );
    this.workPathTimer.unref?.();
    this.chatRuns = new ChatRuns({
      target: (id) => this.getCardTarget(id),
      cwd: (id) =>
        this.getCardWorkspacePath(id) || this.core.target().paths.workspace,
      stored: (id) => this.terminal.get(id)?.agentSessionId || undefined,
      store: (id, conversation) =>
        this.terminal.setAgentSessionId(id, conversation),
      // The rail's dot: a chat turn is work, as list_sessions already says
      onRunning: (id, running) => this.terminal.setChatRunning(id, running)
    });
    this.scratchpad = new ScratchpadStore(
      () => this.core.target(),
      (payload) => this.emitter.emitScratchpad(payload)
    );
    this.simulator = new SimulatorStore(
      () => this.core.target(),
      (unit, at) => options.onSimulatorFrame?.(unit, at),
      options.nativeDir ?? ''
    );
    this.onSimulatorAttach = options.onSimulatorAttach;
    this.onJobLog = options.onJobLog;
    this.onJobEnd = options.onJobEnd;
    this.onSigninChanged = options.onSigninChanged;
    this.onJobState = options.onJobState;
    this.runnerOwnerId = options.runnerOwnerId || null;
    this.revokeGithubToken = options.revokeGithubToken;
    this.runnerService = options.runnerService;
    this.runnerParts = options.runnerParts;
    // One activity row per waiting call: the owner's app opens its approval
    // popup on it, wherever the owner is in the app.
    const onDangerousApproval = options.onDangerousApproval;
    this.approvals.subscribe((change) => {
      if ('opened' in change) {
        const req = change.opened;
        this.activity.set(
          'dangerous-approval',
          'awaiting-input',
          'Dangerous job needs your approval',
          `${req.caller.name}: ${req.job}`,
          req.id
        );
        onDangerousApproval?.(req);
      } else {
        this.activity.clear('dangerous-approval', change.closed);
      }
    });
    // Sessions on this runner call jobs through the secrets bridge.
    this.core.localJobs = {
      list: async () => (await this.jobsList()).jobs,
      call: (job, params, actor, from) =>
        this.jobs().call({
          job,
          params,
          caller: actor,
          via: 'owner-terminal',
          from,
          // A session here is a shell as the runner user, which can read the
          // job's keys anyway; the permission gates the API road, not this.
          mayRunDangerous: true
        }),
      status: (callId, afterSeq) => this.jobStatus({ callId, afterSeq }),
      cancel: (callId, actor) =>
        this.jobCancel(
          { callId },
          { actor, via: 'owner-terminal', role: 'owner' }
        )
    };
    // The space publishes the change and keeps the activity row; this is only
    // the deploy run's own view of it.
    this.gate.subscribe(() => this.projectGateOntoRun());
  }

  /** The space's gate (space-core.ts). Reached through here because most of
   *  what uses it - the bridge, the deploy run - lives on the engine. */
  private get gate() {
    return this.core.gate;
  }

  /** Mirror the gate onto the deploy run's phase, for clients older than the
   *  global modal - they know a password is needed only from `awaiting-auth`. */
  private projectGateOntoRun(): void {
    const pending = this.gate.pending();
    // Only while a run is live, and only for its own commands: a terminal
    // asking for secrets must not make the deploy modal claim it is blocked.
    const runLive =
      this.runState.phase === 'running' ||
      this.runState.phase === 'awaiting-auth';
    if (runLive && pending?.origin === runOrigin(this.runSkill())) {
      this.setRun({
        phase: 'awaiting-auth',
        pendingCommand: pending.command,
        pendingKeys: pending.keys,
        error: pending.error
      });
    } else if (this.runState.phase === 'awaiting-auth') {
      this.setRun({ phase: 'running', pendingCommand: '', pendingKeys: [] });
    }
  }

  // ── Secrets authorization (see secrets-gate.ts + .specs/runner-secrets-gate.md) ──

  /** What the global authorization modal renders. Null when nothing is
   *  waiting, which is also how an answered prompt tells clients to close. */
  secretsAuthState(): BoardAgentActionMap['secretsAuthState']['result'] {
    return {
      pending: this.gate.pending(),
      unlocked: this.core.window.state()
    };
  }

  secretsAuthAnswer(
    payload: BoardAgentActionMap['secretsAuthAnswer']['payload'],
    ctx: ActionContext = OWNER_CONTEXT
  ): { success: boolean } {
    return this.gate.answer(
      payload.id,
      payload.password === undefined
        ? { denied: true, by: ctx.actor, via: ctx.via }
        : {
            password: payload.password,
            unlockFor: payload.unlockFor,
            by: ctx.actor,
            via: ctx.via
          }
    );
  }

  /** End the unlock window now. Anyone who may answer the gate may lock it:
   *  locking only ever takes access away. */
  async secretsLock(ctx: ActionContext = OWNER_CONTEXT): Promise<{
    success: boolean;
  }> {
    const holder = this.core.window.holder();
    if (this.core.window.lock()) {
      await this.core.audit.append({
        actor: ctx.actor,
        via: ctx.via,
        action: 'lock',
        job: null,
        keys: [],
        exitCode: null,
        durationMs: null,
        unlockedBy: holder?.name ?? null
      });
    }
    return { success: true };
  }

  /** Run one password check from Runner Settings and put a failed attempt
   *  (wrong, or refused by the guess limit) on the audit log, the same way the
   *  gate and the inbox do. The limit itself is in host-secrets.ts. */
  private async auditPasswordFailure<T>(
    ctx: ActionContext,
    what: string,
    keys: string[],
    run: () => Promise<T>
  ): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (isFailedPasswordAttempt(err)) {
        await this.core.audit.append({
          actor: ctx.actor,
          via: ctx.via,
          action: 'auth-failed',
          job: null,
          keys,
          exitCode: null,
          durationMs: null,
          unlockedBy: null,
          detail: `${err instanceof Error ? err.message : String(err)} (${what})`
        });
      }
      throw err;
    }
  }

  /** Change this board's password. It re-keys the board too
   *  (changeSpacePassword), so the old password opens nothing here afterwards,
   *  and the open window is locked: it holds the old key, which no longer
   *  opens the store, and a password change is how someone is cut off (spec
   *  "Removing a member"). Other boards on the runner are untouched. */
  async secretsChangePassword(
    payload: BoardAgentActionMap['secretsChangePassword']['payload'],
    ctx: ActionContext = OWNER_CONTEXT
  ): Promise<{ success: boolean }> {
    let result: { success: boolean };
    try {
      result = await this.auditPasswordFailure(ctx, 'password change', [], () =>
        changeSpacePassword(
          this.secretsDirs().spaceDir,
          payload.oldPassword,
          payload.newPassword
        )
      );
    } catch (err) {
      // Past the password check the key may already be replaced, and the
      // window's copy opens nothing; a wrong guess changed nothing.
      if (!isFailedPasswordAttempt(err)) this.core.window.lock();
      throw err;
    }
    this.core.window.lock();
    await this.core.audit.append({
      actor: ctx.actor,
      via: ctx.via,
      action: 'password-rotate',
      job: null,
      keys: [],
      exitCode: null,
      durationMs: null,
      unlockedBy: null
    });
    return result;
  }

  /** The owner's offline backup of this board's secrets (secrets-backup.ts).
   *  A wrong board password counts against the guess limit and is logged like
   *  any other; a backup that was made is logged too, because a copy of the
   *  store leaving the machine is something the log should be able to say. */
  async secretsExportBackup(
    payload: BoardAgentActionMap['secretsExportBackup']['payload'],
    ctx: ActionContext = OWNER_CONTEXT
  ): Promise<BoardAgentActionMap['secretsExportBackup']['result']> {
    const { spaceDir } = this.secretsDirs();
    const board = basename(spaceDir);
    const bundle = await this.auditPasswordFailure(
      ctx,
      'secrets backup',
      [],
      () =>
        exportSecretsBackup({
          spaceDir,
          board,
          password: payload.password,
          passphrase: payload.passphrase
        })
    );
    await this.core.audit.append({
      actor: ctx.actor,
      via: ctx.via,
      action: 'backup-export',
      job: null,
      keys: [],
      exitCode: null,
      durationMs: null,
      unlockedBy: null
    });
    return {
      filename: `${board}-secrets-${new Date().toISOString().slice(0, 10)}.factiii-backup`,
      bundle
    };
  }

  /** The owner reading a backup file's secrets (secrets-backup.ts). The file
   *  may be of any board and opens with its passphrase alone, so no board
   *  password and no guess limit are involved. An open is logged with the
   *  names it showed: it is the one time values leave the runner. */
  async secretsOpenBackup(
    payload: BoardAgentActionMap['secretsOpenBackup']['payload'],
    ctx: ActionContext = OWNER_CONTEXT
  ): Promise<BoardAgentActionMap['secretsOpenBackup']['result']> {
    const opened = openSecretsBackup({
      bundle: payload.bundle,
      passphrase: payload.passphrase
    });
    await this.core.audit.append({
      actor: ctx.actor,
      via: ctx.via,
      action: 'backup-open',
      job: null,
      keys: [
        ...opened.secrets.map((s) => s.name),
        ...opened.files.map((f) => f.name)
      ],
      exitCode: null,
      durationMs: null,
      unlockedBy: null,
      detail: `${opened.board} backup of ${opened.createdAt.slice(0, 10)}`
    });
    return opened;
  }

  /** Whether this board has a store for an import to open. As
   *  deploySecretsStatus does, a store from before per-board keys gets its
   *  key first, so it is never taken for a board with no store. */
  private async importHasStore(): Promise<boolean> {
    const { configDir, spaceDir } = this.secretsDirs();
    await adoptRunnerKey(dirname(spaceDir), spaceDir).catch(() => false);
    return secretsInitialized(configDir);
  }

  /** What importing a backup file into this board would do: the backup's
   *  secrets beside the board's own, as masked tails. Reading the board's
   *  own takes its password. Writes nothing, so it is not logged; a wrong
   *  password is. */
  async secretsImportBackupPlan(
    payload: BoardAgentActionMap['secretsImportBackupPlan']['payload'],
    ctx: ActionContext = OWNER_CONTEXT
  ): Promise<BoardAgentActionMap['secretsImportBackupPlan']['result']> {
    const { spaceDir } = this.secretsDirs();
    const hasStore = await this.importHasStore();
    return this.auditPasswordFailure(ctx, 'import backup', [], () =>
      planSecretsBackupImport({
        bundle: payload.bundle,
        passphrase: payload.passphrase,
        spaceDir,
        // A board with no store has nothing to read, so no password is tried.
        targetKey: hasStore
          ? storeKeyFor(spaceDir, payload.targetPassword, true)
          : null
      })
    );
  }

  /** Import the picked secrets of a backup file into this board's store,
   *  under this board's password. A board with no store gets one under the
   *  typed password. One line on this board's log names what was written and
   *  where it came from; no value is in the log or the answer. */
  async secretsImportBackupApply(
    payload: BoardAgentActionMap['secretsImportBackupApply']['payload'],
    ctx: ActionContext = OWNER_CONTEXT
  ): Promise<BoardAgentActionMap['secretsImportBackupApply']['result']> {
    const { spaceDir } = this.secretsDirs();
    const hasStore = await this.importHasStore();
    const result = await this.auditPasswordFailure(
      ctx,
      'import backup',
      [],
      () =>
        applySecretsBackupImport({
          bundle: payload.bundle,
          passphrase: payload.passphrase,
          spaceDir,
          targetKey: storeKeyFor(spaceDir, payload.targetPassword, hasStore),
          secrets: payload.secrets,
          files: payload.files
        })
    );
    const count = (n: number, one: string) =>
      `${n} ${one}${n === 1 ? '' : 's'}`;
    await this.core.audit.append({
      actor: ctx.actor,
      via: ctx.via,
      action: 'backup-import',
      job: null,
      keys: [...result.secrets, ...result.files],
      exitCode: null,
      durationMs: null,
      unlockedBy: null,
      detail: `import from ${result.board} backup of ${result.createdAt.slice(0, 10)}: ${count(result.secrets.length, 'key')}, ${count(result.files.length, 'file')}${hasStore ? '' : '; new store'}`
    });
    return { secrets: result.secrets, files: result.files };
  }

  // ── Jobs (jobs.ts), the inbox (secrets-inbox.ts), the audit log ──

  /** The jobs.json on the default branch. A repo with none has no jobs. */
  private async loadJobs(): Promise<JobDef[]> {
    const config = this.core.readConfig();
    if (!config.repoUrl || !config.githubToken) {
      throw this.core.notConnectedError(
        'This space has no repository connected.'
      );
    }
    const { workspace, branch } = await ensureWorkspaceClone({
      spaceDir: this.core.spaceDir(),
      repoUrl: config.repoUrl,
      mainBranch: config.mainBranch,
      githubToken: config.githubToken
    });
    let raw: string;
    try {
      raw = await hostGit(
        workspace,
        'cat-file',
        '-p',
        `origin/${branch}:${JOBS_PATH}`
      );
    } catch {
      return [];
    }
    return parseJobs(raw);
  }

  /**
   * The checkout a job runs in: `<space>/jobs`, a detached worktree of the
   * workspace clone, reset to the default branch for every job.
   *
   * Not `$WORKSPACE` itself: a Deploy-button run moves that to the release
   * branch and then calls jobs from inside it, so resetting it would wreck
   * the run, and running from it would take the job's command from the
   * release branch instead of the default one. A worktree shares the clone's
   * fetch and never touches the other checkout.
   */
  private async prepareJobWorkspace(): Promise<string> {
    const config = this.core.readConfig();
    const { workspace, branch } = await ensureWorkspaceClone({
      spaceDir: this.core.spaceDir(),
      repoUrl: config.repoUrl,
      mainBranch: config.mainBranch,
      githubToken: config.githubToken
    });
    const jobsDir = join(this.core.spaceDir(), 'jobs');
    const ref = `origin/${branch}`;
    // The worktree shares the clone's .git: hold the space's git lock so a
    // fetch for a job list cannot run in the middle of this reset.
    return withSpaceGit(this.core.spaceDir(), async () => {
      let exists = true;
      try {
        await hostGit(jobsDir, 'rev-parse', '--git-dir');
      } catch {
        exists = false;
      }
      if (!exists) {
        // A dir deleted by hand leaves its worktree registered; prune first or
        // `worktree add` refuses the path.
        await hostGit(workspace, 'worktree', 'prune');
        await hostGit(
          workspace,
          'worktree',
          'add',
          '--detach',
          '--force',
          jobsDir,
          ref
        );
      } else {
        await hostGit(jobsDir, 'checkout', '--detach', '--force', ref);
      }
      // Untracked leftovers of the last job go; ignored files (node_modules)
      // stay, so `pnpm install` in a job is not a cold install every time.
      await hostGit(jobsDir, 'clean', '-fd');
      return jobsDir;
    });
  }

  private jobs(): JobRunner {
    this.jobRunner ??= new JobRunner({
      load: () => this.loadJobs(),
      prepare: () => this.prepareJobWorkspace(),
      execute: ({
        callId,
        signal,
        def,
        env,
        cwd,
        caller,
        via,
        onChunk,
        onSpawn,
        onPhase
      }) => {
        const { configDir, spaceDir } = this.secretsDirs();
        return authorizeAndRun({
          configDir,
          spaceDir,
          cwd,
          command: def.command,
          keys: def.keys,
          files: def.files,
          githubToken: this.core.readConfig().githubToken || undefined,
          origin: `Job ${def.name} · ${caller.name}`,
          gate: this.gate,
          window: this.core.window,
          job: def.name,
          caller,
          // $WORKSPACE names the checkout the job runs in, not the deploy
          // run's. BACKUPS_DIR / BUILDS_DIR come from spaceEnv unchanged.
          env: { ...env, WORKSPACE: cwd },
          timeoutMs: def.timeoutMin * 60_000,
          audit: this.core.audit,
          via,
          onChunk,
          onSpawn,
          onPhase,
          signal,
          tag: callId
        });
      },
      askOwner: ({ signal, def, env, caller, via }) =>
        this.askOwner(def, env, caller, via, signal),
      audit: this.core.audit,
      onLog: (callId, seq, text) => this.onJobLog?.(callId, seq, text),
      onEnd: (callId, state, exitCode) =>
        this.onJobEnd?.(callId, state, exitCode),
      onState: (callId, state, via) => this.onJobState?.(callId, state, via)
    });
    return this.jobRunner;
  }

  /** Hold one member's dangerous job call for the runner owner, and put
   *  the answer on the audit log with the filled command that would run. */
  private async askOwner(
    def: JobDef,
    env: Record<string, string>,
    caller: { userId: string; name: string },
    via: AuditVia,
    signal: AbortSignal
  ): Promise<boolean> {
    const command = filledCommand(def, env);
    const result = await this.approvals.request(
      {
        job: def.name,
        command,
        caller: { userId: String(caller.userId), name: caller.name },
        spaceSlug: this.core.spaceSlug
      },
      signal
    );
    const answered = 'by' in result;
    await this.core.audit.append({
      actor: answered ? result.by : caller,
      via: answered ? result.via : via,
      action: result.approved ? 'dangerous-approve' : 'dangerous-deny',
      job: def.name,
      keys: [...def.keys, ...def.files],
      command,
      exitCode: null,
      durationMs: null,
      unlockedBy: null,
      detail: `${ownerAnswerText(result)}; caller: ${caller.name} (${caller.userId})`
    });
    return result.approved;
  }

  /** Whether `ctx` is the runner's owner by id, not by the channel's word
   *  alone: a dangerous job approval needs exactly that. */
  private isRunnerOwner(ctx: ActionContext): boolean {
    return (
      isOwnerContext(ctx) &&
      this.runnerOwnerId !== null &&
      String(ctx.actor.userId) === this.runnerOwnerId
    );
  }

  /** The members' dangerous job calls waiting on the owner (owner only). */
  dangerousApprovalState(
    ctx: ActionContext = OWNER_CONTEXT
  ): BoardAgentActionMap['dangerousApprovalState']['result'] {
    if (!this.isRunnerOwner(ctx))
      throw new Error(DANGEROUS_APPROVAL_OWNER_ONLY);
    return { pending: this.approvals.pending() };
  }

  /** The owner's yes or no to one waiting call. Approve runs that call once;
   *  the next call asks again. */
  dangerousApprovalAnswer(
    payload: BoardAgentActionMap['dangerousApprovalAnswer']['payload'],
    ctx: ActionContext = OWNER_CONTEXT
  ): BoardAgentActionMap['dangerousApprovalAnswer']['result'] {
    if (!this.isRunnerOwner(ctx))
      throw new Error(DANGEROUS_APPROVAL_OWNER_ONLY);
    const id = typeof payload?.id === 'string' ? payload.id : '';
    return {
      success: this.approvals.answer(id, payload?.approve === true, {
        by: { userId: String(ctx.actor.userId), name: ctx.actor.name },
        via: ctx.via
      })
    };
  }

  private secretsInbox(): SecretsInbox {
    if (!this.inbox) {
      const { configDir, spaceDir } = this.secretsDirs();
      this.inbox = new SecretsInbox({
        configDir,
        spaceDir,
        gate: this.gate,
        audit: this.core.audit,
        // The server opened a row per submit; it closes on this.
        onEnd: (submitId, state) => this.onJobEnd?.(submitId, state, null)
      });
    }
    return this.inbox;
  }

  async jobsList(): Promise<BoardAgentActionMap['jobsList']['result']> {
    return { jobs: await this.jobs().list() };
  }

  /**
   * What needs the owner here (the attention badge). Cheap by rule, since a
   * client asks on every reconnect: no fetch and no decrypt. The contract and
   * jobs.json come from the clone as last fetched, the stored names from the
   * store's cleartext (sops leaves key names in clear, host-secrets.ts).
   */
  async attention(): Promise<BoardAgentActionMap['attention']['result']> {
    const config = this.core.readConfig();
    const spaceDir = this.core.spaceDir();
    const repoConnected = Boolean(config.repoUrl && config.githubToken);
    const files = repoConnected
      ? await cachedOriginFiles(spaceDir, config.mainBranch, [
          REQUIRED_VARIABLES_PATH,
          JOBS_PATH
        ])
      : null;
    let jobs: JobDef[] = [];
    try {
      jobs = files?.[1] ? parseJobs(files[1]) : [];
    } catch {
      // A malformed jobs.json offers no jobs (loadJobs throws the reason).
    }
    const keys = new Set(await storedSecretKeys(spaceDir));
    // The GitHub connection answers for GH_TOKEN / GITHUB_TOKEN when the
    // store holds neither (authorizeAndRun), so neither is missing then.
    if (config.githubToken) for (const k of GITHUB_TOKEN_KEYS) keys.add(k);
    const fileSecrets = new Set(await storedSecretFiles(spaceDir));
    const missingOf = (job: JobDef) => [
      ...job.keys.filter((k) => !keys.has(k)),
      ...job.files.filter((f) => !fileSecrets.has(f))
    ];
    const missing = new Set([
      // A declared file is held under files/, never in the env store.
      ...requiredVariableKeys(files?.[0] ?? '')
        .filter((v) => !(v.kind === 'file' ? fileSecrets : keys).has(v.key))
        .map((v) => v.key),
      ...jobs.flatMap(missingOf)
    ]);
    return {
      missingSecrets: files ? [...missing].sort() : null,
      blockedJobs: jobs
        .filter((j) => missingOf(j).length > 0)
        .map((j) => j.name),
      jobsCount: jobs.length,
      secretsLocked: this.core.window.state() === null,
      repoConnected
    };
  }

  // The runner's always-on service (service.ts). Runner-wide, owner only
  // (OWNER_ONLY_ACTIONS); every board's engine answers for the same service.
  serviceStatus(): Promise<RunnerServiceState> {
    return this.runnerService?.status() ?? Promise.resolve(NO_SERVICE);
  }
  serviceInstall(): Promise<RunnerServiceOutcome> {
    return (
      this.runnerService?.install() ??
      Promise.resolve({ ok: false, lines: [], state: NO_SERVICE })
    );
  }
  serviceRemove(): Promise<RunnerServiceOutcome> {
    return (
      this.runnerService?.remove() ??
      Promise.resolve({ ok: false, lines: [], state: NO_SERVICE })
    );
  }

  // The runner's parts (parts.ts in apps/runner). Runner-wide, owner only;
  // the host validates the payload.
  partsList(): Promise<RunnerPartsState> {
    return this.runnerParts?.list() ?? Promise.resolve(NO_PARTS);
  }
  partsAct(payload: unknown): Promise<RunnerPartsState> {
    return this.runnerParts?.act(payload) ?? Promise.resolve(NO_PARTS);
  }
  machineCleanup(payload: unknown): Promise<RunnerCleanup> {
    return this.runnerParts?.cleanup(payload) ?? Promise.resolve(NO_CLEANUP);
  }

  /** Call a job by name. `callId` is the server's, when the call came
   *  through it, so both sides key the call the same way. */
  jobsCall(
    payload: BoardAgentActionMap['jobsCall']['payload'],
    ctx: ActionContext = OWNER_CONTEXT,
    callId?: string
  ): Promise<{ callId: string }> {
    return this.jobs().call({
      job: payload.job,
      params: payload.params,
      caller: ctx.actor,
      via: ctx.via,
      callId,
      mayRunDangerous: isOwnerContext(ctx) || ctx.dangerous === true
    });
  }

  /** Cancel a call; the starter or the owner only (jobs.ts cancel). */
  jobCancel(
    payload: BoardAgentActionMap['jobCancel']['payload'],
    ctx: ActionContext = OWNER_CONTEXT
  ): Promise<{ cancelled: boolean }> {
    return this.jobs().cancel(
      payload.callId,
      ctx.actor,
      ctx.via,
      isOwnerContext(ctx)
    );
  }

  /** Unfinished calls from every path; a member sees only its own. */
  jobsActive(
    ctx: ActionContext = OWNER_CONTEXT
  ): BoardAgentActionMap['jobsActive']['result'] {
    return {
      calls: this.jobs().active(
        isOwnerContext(ctx) ? undefined : ctx.actor.userId
      )
    };
  }

  /** A call's state and log. A member channel sees only its own calls;
   *  the owner, a session here and the server path (which checks its own
   *  rule) see any. */
  jobStatus(
    payload: BoardAgentActionMap['jobStatus']['payload'],
    ctx: ActionContext = OWNER_CONTEXT
  ): BoardAgentActionMap['jobStatus']['result'] {
    return this.jobs().status(payload.callId, payload.afterSeq ?? 0, {
      by: ctx.actor,
      byOwner: isOwnerContext(ctx)
    });
  }

  auditRead(
    payload: BoardAgentActionMap['auditRead']['payload']
  ): Promise<BoardAgentActionMap['auditRead']['result']> {
    return this.core.audit.read(payload ?? {});
  }

  auditClear(
    ctx: ActionContext = OWNER_CONTEXT
  ): Promise<BoardAgentActionMap['auditClear']['result']> {
    return this.core.audit.clear(ctx.actor, ctx.via);
  }

  async secretsInboxList(): Promise<
    BoardAgentActionMap['secretsInboxList']['result']
  > {
    return { items: await this.secretsInbox().list() };
  }

  secretsInboxAnswer(
    payload: BoardAgentActionMap['secretsInboxAnswer']['payload'],
    ctx: ActionContext = OWNER_CONTEXT
  ): Promise<{ success: boolean }> {
    return this.secretsInbox().answer(payload, ctx.actor, ctx.via);
  }

  /** An encrypted update relayed by the server (`runner:secret-submit`). */
  secretsInboxSubmit(item: InboxSubmit): Promise<{ accepted: true }> {
    return this.secretsInbox().submit(item);
  }

  /** Write a runner event (a member's level on this space) into this space's
   *  log, so each space's audit stands on its own. */
  auditRunnerEvent(
    action: 'shared-change',
    detail: string,
    ctx: ActionContext
  ): Promise<void> {
    return this.core.audit.append({
      actor: ctx.actor,
      via: ctx.via,
      action,
      job: null,
      keys: [],
      exitCode: null,
      durationMs: null,
      unlockedBy: null,
      detail
    });
  }

  /** Space events a newly connected client needs at once, because they are
   *  only ever pushed on change: today the secrets prompt. The modal opens on
   *  `secrets-auth` and only then fetches secretsAuthState, so a client that
   *  connects (or reloads) while a prompt waits would never see it. Sent with
   *  pending false too, so a stale modal closes. */
  connectReplay(): { event: string; payload: unknown }[] {
    return [
      {
        event: 'secrets-auth',
        payload: { pending: this.gate.pending() !== null }
      }
    ];
  }

  /** Whether this space knows a job call, for a status request that names
   *  only the call id. */
  hasJobCall(callId: string): boolean {
    try {
      this.jobs().status(callId);
      return true;
    } catch {
      return false;
    }
  }

  /** The public age recipient a laptop CLI encrypts updates to: this
   *  board's, which changes whenever its password does. */
  async secretsRecipient(): Promise<string> {
    const { configDir, spaceDir } = this.secretsDirs();
    await adoptRunnerKey(dirname(spaceDir), spaceDir).catch(() => false);
    if (!(await secretsInitialized(configDir))) {
      throw new Error(
        'This board has no secrets password yet. Set one in Runner Settings > Secrets first.'
      );
    }
    return runnerRecipient(configDir);
  }

  /** How this host protects stored credentials. Read-only: the daemon answers
   *  unlock and password changes itself (SECURE_ACTIONS in daemon.ts). */
  secureStatus(): SecureStoreStatus {
    const reported = this.core.configProvider.secureStore?.();
    if (reported) return reported;
    // A provider that predates the field: say what little we can prove rather
    // than claim a protection or a problem we can't observe.
    const encrypted = this.core.configProvider.tokensEncrypted?.() ?? false;
    return {
      backend: 'electron-safe-storage',
      keyStore: 'electron-safe-storage',
      ready: encrypted,
      passwordSupported: false,
      passwordEnabled: false,
      unlocked: encrypted,
      missingTool: '',
      problem: encrypted
        ? ''
        : 'This host does not encrypt stored credentials.',
      fix: ''
    };
  }

  /** The mode engine that currently owns this postId, if any. */
  private owner(postId: string): ModeEngine | null {
    if (this.claude.has(postId)) return this.claude;
    if (this.terminal.has(postId)) return this.terminal;
    return null;
  }

  // ── Config / setup (→ core) ──

  getConfig() {
    return this.core.getConfig();
  }
  setConfig(partial: Parameters<SpaceCore['setConfig']>[0]) {
    const result = this.core.setConfig(partial);
    // A pasted token is a connect too (see refreshGithubOrigin).
    if (partial.githubToken) void this.refreshGithubOrigin();
    return result;
  }
  clearToken(key: Parameters<SpaceCore['clearToken']>[0]) {
    return this.core.clearToken(key);
  }
  setupStatus() {
    return this.core.setupStatus();
  }
  /** Read-only: probes the login PATH, installs nothing. */
  environmentStatus() {
    return environmentStatus(this.core.target());
  }
  /** One extra's Install button. Its log and any password request ride the
   *  setup status channel, as Initialize's do, marked SETUP_EXTRA_PREFIX. */
  async environmentInstall(p: { id: string }): Promise<{ success: boolean }> {
    const target = this.core.target();
    this.activity.set('setup', 'working', 'Installing', p.id);
    try {
      await installExtra(
        target,
        p.id,
        (line) =>
          this.emitter.emitSetupStatus(
            `${SETUP_EXTRA_PREFIX}${SETUP_LOG_PREFIX}${line}`
          ),
        (reason) => this.askSudo(reason, SETUP_EXTRA_PREFIX)
      );
      // Live agent status starts now, not at the next restart.
      if (p.id === 'redis-server') await ensureRedis(target).catch(() => {});
      this.activity.clear('setup');
    } catch (err) {
      this.activity.set(
        'setup',
        'error',
        `Could not install ${p.id}`,
        err instanceof Error ? err.message : String(err)
      );
      throw err;
    }
    return { success: true };
  }
  ensureSetup() {
    return this.core.ensureSetup();
  }
  cardRemoteBranches() {
    return this.core.cardRemoteBranches();
  }
  bareWorkNames() {
    return this.core.bareWorkNames();
  }
  // Deploy button entry: is the repo's deploy contract (SKILL.md +
  // required-variables.json) on the default branch? See .specs/deploy.md.
  async deployStatus() {
    const config = this.core.readConfig();
    if (!config.repoUrl || !config.githubToken) {
      throw this.core.notConnectedError(
        'Set the repository URL and GitHub token first.'
      );
    }
    return checkDeployStatus({
      spaceDir: this.core.spaceDir(),
      repoUrl: config.repoUrl,
      mainBranch: config.mainBranch,
      githubToken: config.githubToken
    });
  }
  // What the Deploy modal's release picker offers: branches on origin that
  // could ship, newest first. See listReleaseBranches.
  async deployBranches() {
    const config = this.core.readConfig();
    if (!config.repoUrl || !config.githubToken) {
      throw this.core.notConnectedError(
        'Set the repository URL and GitHub token first.'
      );
    }
    return listReleaseBranches({
      spaceDir: this.core.spaceDir(),
      repoUrl: config.repoUrl,
      mainBranch: config.mainBranch,
      githubToken: config.githubToken
    });
  }
  // ── Agent skills (SKILL.md) ──
  // Repo opts are optional here, unlike deploy: the global roots are readable
  // with no repo configured, and listSkills reports repoAvailable: false.
  private skillOpts() {
    const config = this.core.readConfig();
    return {
      spaceDir: this.core.spaceDir(),
      repoUrl: config.repoUrl,
      mainBranch: config.mainBranch,
      githubToken: config.githubToken
    };
  }

  skillsList() {
    return listSkills(this.skillOpts());
  }

  skillRead(payload: BoardAgentActionMap['skillRead']['payload']) {
    return readSkill({ ...this.skillOpts(), ...payload });
  }

  skillWriteGlobal(
    payload: BoardAgentActionMap['skillWriteGlobal']['payload']
  ) {
    return writeGlobalSkill(payload);
  }

  skillDeleteGlobal(
    payload: BoardAgentActionMap['skillDeleteGlobal']['payload']
  ) {
    return deleteGlobalSkill(payload);
  }

  skillMigrate(payload: BoardAgentActionMap['skillMigrate']['payload']) {
    const config = this.core.readConfig();
    return migrateSkills({
      ...this.skillOpts(),
      ...payload,
      gitName: config.gitName,
      gitEmail: config.gitEmail
    });
  }

  skillProposeRepo(
    payload: BoardAgentActionMap['skillProposeRepo']['payload']
  ) {
    const config = this.core.readConfig();
    return proposeRepoSkill({
      ...this.skillOpts(),
      ...payload,
      gitName: config.gitName,
      gitEmail: config.gitEmail
    });
  }

  // In-flight creator session, memory-only (the repo is the source of truth
  // once merged). Survives modal reopen via deployCreatorState.
  private skillCreatorSessionId: string | null = null;
  // Which CLI produced that session. A resume id belongs to ONE provider, so
  // switching the picker between drafting and revising has to start fresh
  // rather than hand a claude session id to codex.
  private skillCreatorProvider: AgentProvider | null = null;
  // Set when the draft was resumed from a pushed deploy-skill branch:
  // approve commits onto that branch instead of cutting a new one.
  private skillDraftBranch: string | null = null;
  private creatorState: BoardAgentActionMap['deployCreatorState']['result'] = {
    phase: 'idle',
    logs: [],
    draft: null,
    error: ''
  };

  deployCreatorState() {
    return this.creatorState;
  }

  async deployLoadSkillBranch(
    payload: BoardAgentActionMap['deployLoadSkillBranch']['payload']
  ) {
    const { sendLog: _unused, ...opts } = this.deployCreatorOpts(() => {});
    const draft = await loadSkillDraft({ ...opts, branch: payload.branch });
    // The generation session is long gone; revise starts a fresh one.
    this.skillCreatorSessionId = null;
    this.skillCreatorProvider = null;
    this.skillDraftBranch = payload.branch;
    this.creatorState = { phase: 'review', logs: [], draft, error: '' };
    return draft;
  }

  // Env check/fix state (engine memory, like creatorState/runState): a
  // reopened modal reattaches to a running fix instead of losing it.
  private envState: BoardAgentActionMap['deployEnvState']['result'] = {
    phase: 'idle',
    logs: [],
    result: null,
    error: ''
  };

  deployEnvState() {
    return this.envState;
  }

  private async runEnvPass(
    phase: 'checking' | 'fixing',
    work: () => Promise<BoardAgentActionMap['deployCheckEnvironment']['result']>
  ) {
    if (this.envState.phase === 'fixing') {
      throw new Error('An environment fix is already running.');
    }
    this.envState = { phase, logs: [], result: null, error: '' };
    this.activity.set(
      'deploy-env',
      'working',
      phase === 'fixing'
        ? 'Fixing deploy environment'
        : 'Checking deploy environment'
    );
    try {
      const result = await work();
      this.envState = {
        phase: 'done',
        logs: this.envState.logs,
        result,
        error: ''
      };
      this.emitter.emitDeployEnv({ phase: 'done' });
      this.activity.clear('deploy-env');
      return result;
    } catch (err) {
      this.envState = {
        phase: 'done',
        logs: this.envState.logs,
        result: null,
        error: errText(err)
      };
      this.emitter.emitDeployEnv({ phase: 'error' });
      this.activity.set(
        'deploy-env',
        'error',
        'Deploy environment failed',
        errText(err)
      );
      throw err;
    }
  }

  deployFixEnvironment(
    sendLog: (entry: { type: string; content: string }) => void,
    provider?: AgentProvider
  ) {
    const opts = this.deployCreatorOpts(sendLog, provider);
    return this.runEnvPass('fixing', () =>
      fixEnvironment({
        ...opts,
        sendLog: BoardAgentEngine.bufferLogs(this.envState.logs, sendLog)
      })
    );
  }

  // ── Deploy run (host executor; see host-run.ts + .specs/deploy.md) ──
  // Memory-only: reopened clients reattach, a restart loses the run and says so.

  private runState: BoardAgentActionMap['deployRunState']['result'] = {
    provider: 'claude',
    phase: 'idle',
    todos: [],
    logs: [],
    question: '',
    pendingCommand: '',
    pendingKeys: [],
    error: '',
    summary: '',
    startedAt: 0,
    finishedAt: 0
  };
  /** The skill the current or last run follows. */
  private runSkill(): RunSkill {
    return this.runState.skill ?? DEPLOY_SKILL;
  }

  private runResolvers: {
    human?: (answer: string) => void;
  } = {};
  private runProc: ChildProcess | null = null;
  private runCancelled = false;
  private sudoResolver: ((password: string | null) => void) | null = null;

  /** Pause Initialize (or an extra's install, `prefix` SETUP_EXTRA_PREFIX)
   *  and ask the owner for their sudo password, over the setup-status
   *  channel. A second request cancels the pending one. */
  private askSudo(reason: string, prefix = ''): Promise<string | null> {
    this.sudoResolver?.(null);
    return new Promise((resolve) => {
      this.sudoResolver = resolve;
      this.emitter.emitSetupStatus(`${prefix}${SETUP_AUTH_PREFIX}${reason}`);
    });
  }

  /** Answer a pending sudo request. An empty password denies it, so setup
   *  fails with a message rather than hanging. */
  setupAuthorize(p: { password: string }): { success: boolean } {
    const resolve = this.sudoResolver;
    if (!resolve) return { success: false };
    this.sudoResolver = null;
    resolve(p.password || null);
    return { success: true };
  }

  deployRunState() {
    return this.runState;
  }

  private setRun(
    partial: Partial<BoardAgentActionMap['deployRunState']['result']>
  ) {
    this.runState = { ...this.runState, ...partial };
    this.emitter.emitDeployRun({ phase: this.runState.phase });
    this.syncRunActivity();
  }

  /** Mirror the deploy run's phase onto the Running jobs panel. A deploy can
   *  sit on `awaiting-input` for hours, which is exactly the state worth
   *  seeing without opening the modal. */
  private syncRunActivity() {
    const { phase, question, pendingCommand, pendingKeys, error } =
      this.runState;
    const skill = this.runSkill();
    // Deploy keeps its words; any other run names its skill.
    const what = isDeploySkill(skill) ? 'Deploy' : `Skill ${skill.name}`;
    switch (phase) {
      case 'running':
        return this.activity.set(
          'deploy-run',
          'working',
          isDeploySkill(skill) ? 'Deploying' : `Running ${skill.name}`
        );
      case 'awaiting-input':
        return this.activity.set(
          'deploy-run',
          'awaiting-input',
          `${what} needs your answer`,
          question
        );
      case 'awaiting-auth':
        return this.activity.set(
          'deploy-run',
          'awaiting-input',
          `${what} needs authorization`,
          pendingKeys.length
            ? `${pendingCommand} (${pendingKeys.join(', ')})`
            : pendingCommand
        );
      case 'failed':
        return this.activity.set(
          'deploy-run',
          'error',
          `${what} failed`,
          error
        );
      // success / idle: the run is over and the modal holds the report.
      default:
        return this.activity.clear('deploy-run');
    }
  }

  deployRunStart(
    sendLog: (entry: { type: string; content: string }) => void,
    provider?: AgentProvider,
    releaseBranch?: string,
    skill: RunSkill = DEPLOY_SKILL,
    /** Update this copy of a library skill instead of running it. */
    update?: SkillLibraryUpdate
  ): {
    started: boolean;
  } {
    if (
      this.runState.phase === 'running' ||
      this.runState.phase === 'awaiting-input' ||
      this.runState.phase === 'awaiting-auth'
    ) {
      // One run per space, deploy or not: they share the console and the
      // workspace checkout.
      throw new Error(
        `A run of ${this.runSkill().name} is already in progress.`
      );
    }
    // A job and a release on one space at once would both deploy. The run's
    // own jobs start after this, so they are never refused by it.
    if (this.jobRunner?.busy()) {
      throw new Error(
        'A job is running on this space. Start the run when it ends.'
      );
    }
    const opts = this.deployCreatorOpts(sendLog, provider);
    this.runCancelled = false;
    this.runState = {
      skill,
      provider: opts.provider,
      phase: 'running',
      todos: [],
      logs: [],
      question: '',
      pendingCommand: '',
      pendingKeys: [],
      error: '',
      summary: '',
      startedAt: Date.now(),
      finishedAt: 0
    };
    this.emitter.emitDeployRun({ phase: 'running' });
    this.syncRunActivity();

    const bufferLog = (entry: { type: string; content: string }) => {
      const logs = this.runState.logs;
      const last = logs[logs.length - 1];
      if (entry.type === 'text-append' && last?.type === 'text') {
        last.content += entry.content;
      } else if (entry.type === 'thinking' && last?.type === 'thinking') {
        last.content = entry.content;
      } else {
        logs.push({
          time: Date.now(),
          type: entry.type === 'text-append' ? 'text' : (entry.type as never),
          content: entry.content
        });
        if (logs.length > 500) logs.splice(0, logs.length - 500);
      }
      sendLog(entry);
    };

    // A command the run authorizes goes through the space's bridge now, so the
    // release timeline has to be reachable from there to still receive it.
    this.core.deployLog = bufferLog;
    // Filled in by the update's task once the checkout is reset; read after
    // the run to check and save what it wrote.
    let merge: { mergedPath: string; uuid: string } | null = null;
    void startSkillRun({
      ...(update && !isDeploySkill(skill)
        ? {
            task: async (workspace: string) => {
              const prepared = await prepareSkillUpdate({
                skill,
                spaceDir: opts.spaceDir,
                workspace,
                update
              });
              merge = prepared;
              return prepared.task;
            }
          }
        : {}),
      skill,
      spaceDir: opts.spaceDir,
      repoUrl: opts.repoUrl,
      mainBranch: opts.mainBranch,
      githubToken: opts.githubToken,
      provider: opts.provider,
      releaseBranch,
      gate: this.gate,
      hooks: {
        sendLog: bufferLog,
        onTodos: (todos) => this.setRun({ todos }),
        requestHuman: (question) =>
          new Promise((resolve) => {
            this.runResolvers.human = resolve;
            this.setRun({ phase: 'awaiting-input', question });
          }),
        isCancelled: () => this.runCancelled,
        registerProc: (proc) => {
          this.runProc = proc;
        }
      }
    })
      .finally(() => {
        this.core.deployLog = null;
      })
      .then(async ({ shipped, summary }) => {
        const saved =
          shipped && update && merge
            ? await this.saveSkillUpdate(skill, merge, update.version)
            : '';
        if (shipped) {
          this.setRun({
            phase: 'success',
            summary: [summary, saved].filter(Boolean).join('\n\n'),
            finishedAt: Date.now()
          });
        } else {
          this.setRun({
            phase: 'failed',
            error: `${isDeploySkill(skill) ? 'Deploy' : skill.name} stopped: ${summary.split('\n')[0].trim()}`,
            summary,
            finishedAt: Date.now()
          });
        }
      })
      .catch((err: unknown) => {
        this.setRun({
          phase: 'failed',
          error: err instanceof Error ? err.message : String(err),
          finishedAt: Date.now()
        });
      });
    return { started: true };
  }

  /** Save an approved library update the way the Skills tab saves an edit:
   *  straight to this machine, or a branch to merge for the repo. Throws, so
   *  the run fails, when the merge is missing or lost its origin. */
  private async saveSkillUpdate(
    skill: RunSkill,
    merge: { mergedPath: string; uuid: string },
    version: string
  ): Promise<string> {
    const content = await checkMergedSkill({
      ...merge,
      name: skill.name,
      version
    });
    if (skill.scope === 'global') {
      await this.skillWriteGlobal({ name: skill.name, content });
      return `Saved ${skill.name} on this machine.`;
    }
    const { branch } = await this.skillProposeRepo({
      name: skill.name,
      content
    });
    return `Pushed ${skill.name} to ${branch}. Merge it to use the update from the repo.`;
  }

  deployRunAnswer(payload: BoardAgentActionMap['deployRunAnswer']['payload']): {
    success: boolean;
  } {
    const resolve = this.runResolvers.human;
    if (!resolve || this.runState.phase !== 'awaiting-input') {
      throw new Error('No step is awaiting input.');
    }
    this.runResolvers.human = undefined;
    this.setRun({ phase: 'running', question: '', error: '' });
    resolve(payload.answer);
    return { success: true };
  }

  deployRunCancel(): { success: boolean } {
    this.runCancelled = true;
    // killTree, not proc.kill: the deploy CLI's Bash children (builds,
    // uploads) outlive a signal aimed at the CLI alone.
    if (this.runProc) killTree(this.runProc, 'SIGTERM');
    // Unblock any pending gate so the loop observes the cancel.
    this.runResolvers.human?.('cancel');
    // Only the run's own: the gate is space-wide now, so cancelling a deploy
    // must not deny a terminal session's prompt that happens to be open.
    if (this.gate.pending()?.origin === runOrigin(this.runSkill())) {
      this.gate.cancel();
    }
    this.runResolvers = {};
    return { success: true };
  }

  deployRunDismiss(): { success: boolean } {
    if (
      this.runState.phase === 'running' ||
      this.runState.phase === 'awaiting-input' ||
      this.runState.phase === 'awaiting-auth'
    ) {
      throw new Error('A run is still in progress.');
    }
    this.runState = {
      // Unread while idle - the next run sets its own. Carried rather than
      // reset so nothing has to invent a provider that means nothing yet.
      provider: this.runState.provider,
      phase: 'idle',
      todos: [],
      logs: [],
      question: '',
      pendingCommand: '',
      pendingKeys: [],
      error: '',
      summary: '',
      startedAt: 0,
      finishedAt: 0
    };
    return { success: true };
  }

  deployCheckEnvironment() {
    const config = this.core.readConfig();
    if (!config.repoUrl || !config.githubToken) {
      throw this.core.notConnectedError(
        'Set the repository URL and GitHub token first.'
      );
    }
    return this.runEnvPass('checking', () =>
      runEnvironmentCheck({
        spaceDir: this.core.spaceDir(),
        repoUrl: config.repoUrl,
        mainBranch: config.mainBranch,
        githubToken: config.githubToken
      })
    );
  }

  // Buffer log entries (capped) into an engine-held list alongside live
  // streaming, so a reopened modal replays what it missed.
  private static bufferLogs(
    logs: BoardAgentActionMap['deployCreatorState']['result']['logs'],
    sendLog: (entry: { type: string; content: string }) => void
  ) {
    return (entry: { type: string; content: string }) => {
      const last = logs[logs.length - 1];
      if (entry.type === 'text-append' && last?.type === 'text') {
        last.content += entry.content;
      } else if (entry.type === 'thinking' && last?.type === 'thinking') {
        last.content = entry.content;
      } else {
        logs.push({
          time: Date.now(),
          type: entry.type === 'text-append' ? 'text' : (entry.type as never),
          content: entry.content
        });
        if (logs.length > 500) logs.splice(0, logs.length - 500);
      }
      sendLog(entry);
    };
  }

  // Buffer every creator log entry (capped) alongside live streaming, so a
  // reopened modal replays what it missed.
  private creatorLogger(
    sendLog: (entry: { type: string; content: string }) => void
  ) {
    return (entry: { type: string; content: string }) => {
      const logs = this.creatorState.logs;
      const last = logs[logs.length - 1];
      if (entry.type === 'text-append' && last?.type === 'text') {
        last.content += entry.content;
      } else if (entry.type === 'thinking' && last?.type === 'thinking') {
        last.content = entry.content;
      } else {
        logs.push({
          time: Date.now(),
          type: entry.type === 'text-append' ? 'text' : (entry.type as never),
          content: entry.content
        });
        if (logs.length > 500) logs.splice(0, logs.length - 500);
      }
      sendLog(entry);
    };
  }

  private async runCreatorPass(
    work: () => Promise<BoardAgentActionMap['deployCreateSkill']['result']>
  ) {
    this.creatorState = { phase: 'working', logs: [], draft: null, error: '' };
    this.activity.set('deploy-skill', 'working', 'Writing deploy skill');
    try {
      const draft = await work();
      this.creatorState = {
        phase: 'review',
        logs: this.creatorState.logs,
        draft,
        error: ''
      };
      this.emitter.emitDeployCreator({ phase: 'review' });
      // The draft is waiting on the owner to approve it, which is worth a row.
      this.activity.set(
        'deploy-skill',
        'awaiting-input',
        'Deploy skill ready to review'
      );
      return draft;
    } catch (err) {
      const error = errText(err);
      this.creatorState = {
        ...this.creatorState,
        phase: this.creatorState.draft ? 'review' : 'idle',
        error
      };
      this.emitter.emitDeployCreator({ phase: 'error', error });
      this.activity.set('deploy-skill', 'error', 'Deploy skill failed', error);
      throw err;
    }
  }

  private deployCreatorOpts(
    sendLog: (entry: { type: string; content: string }) => void,
    /** Per-run pick from the deploy modal. Absent means the space setting,
     *  which is what every caller predating the picker sends. */
    provider?: AgentProvider
  ) {
    const config = this.core.readConfig();
    if (!config.repoUrl || !config.githubToken) {
      throw this.core.notConnectedError(
        'Set the repository URL and GitHub token first.'
      );
    }
    return {
      spaceDir: this.core.spaceDir(),
      repoUrl: config.repoUrl,
      mainBranch: config.mainBranch,
      githubToken: config.githubToken,
      // resolveProvider coerces anything unknown to claude, so it can only be
      // asked about a value that is actually there.
      provider: provider
        ? resolveProvider(provider)
        : this.core.agentProvider(),
      sendLog
    };
  }

  deployCreateSkill(
    payload: BoardAgentActionMap['deployCreateSkill']['payload'],
    sendLog: (entry: { type: string; content: string }) => void
  ) {
    this.skillDraftBranch = null;
    return this.runCreatorPass(async () => {
      const opts = this.deployCreatorOpts(
        this.creatorLogger(sendLog),
        payload.provider
      );
      const { sessionId, ...draft } = await generateDeploySkill({
        ...opts,
        instructions: payload.instructions
      });
      this.skillCreatorSessionId = sessionId || null;
      this.skillCreatorProvider = opts.provider;
      return draft;
    });
  }

  deployReviseSkill(
    payload: BoardAgentActionMap['deployReviseSkill']['payload'],
    sendLog: (entry: { type: string; content: string }) => void
  ) {
    return this.runCreatorPass(async () => {
      const opts = this.deployCreatorOpts(
        this.creatorLogger(sendLog),
        payload.provider
      );
      const resumable = this.skillCreatorProvider === opts.provider;
      const { sessionId, ...draft } = await reviseDeploySkill({
        ...opts,
        feedback: payload.feedback,
        // A different CLI than drafted this: its session id means nothing to
        // the new one, so the revision starts from the files on disk.
        resumeSessionId: resumable
          ? (this.skillCreatorSessionId ?? undefined)
          : undefined
      });
      this.skillCreatorSessionId = sessionId || this.skillCreatorSessionId;
      this.skillCreatorProvider = opts.provider;
      return draft;
    });
  }

  // ── Runner secrets store (AI-safe contract; see host-secrets.ts) ──

  private secretsDirs() {
    const spaceDir = this.core.spaceDir();
    // One age key per board: the identity lives in the space's own secrets/
    // folder, so this board's password opens this board's store only.
    return { configDir: spaceKeyDir(spaceDir), spaceDir };
  }

  async deploySecretsStatus() {
    const { configDir, spaceDir } = this.secretsDirs();
    // Space start adopts too; this covers a store written since then by a
    // runner from before per-board keys.
    await adoptRunnerKey(dirname(spaceDir), spaceDir).catch(() => false);
    return { initialized: await secretsInitialized(configDir) };
  }

  deploySecretsInit(
    payload: BoardAgentActionMap['deploySecretsInit']['payload']
  ) {
    return initSecrets(this.secretsDirs().configDir, payload.password);
  }

  async deploySecretsList(
    payload: BoardAgentActionMap['deploySecretsList']['payload'],
    ctx: ActionContext = OWNER_CONTEXT
  ) {
    const { configDir, spaceDir } = this.secretsDirs();
    // The password proves the caller can open the store; the sidecar needs no
    // proof of its own (it holds no values) but rides along so the panel
    // renders names and purposes in one round trip.
    return {
      keys: await this.auditPasswordFailure(ctx, 'list secrets', [], () =>
        listSecretKeys(configDir, spaceDir, payload.password)
      ),
      meta: await readSecretMeta(spaceDir),
      files: await storedSecretFiles(spaceDir),
      // With GitHub connected, the connection answers for these when the
      // store has no value, so they are not "missing".
      provided: this.core.readConfig().githubToken ? [...GITHUB_TOKEN_KEYS] : []
    };
  }

  async deploySecretsSet(
    payload: BoardAgentActionMap['deploySecretsSet']['payload'],
    ctx: ActionContext = OWNER_CONTEXT
  ) {
    const { configDir, spaceDir } = this.secretsDirs();
    const result = await this.auditPasswordFailure(
      ctx,
      'set secret',
      [payload.key],
      () =>
        setSecret(
          configDir,
          spaceDir,
          payload.password,
          payload.key,
          payload.value
        )
    );
    await this.core.audit.append({
      actor: ctx.actor,
      via: ctx.via,
      action: 'secret-set',
      job: null,
      keys: [payload.key],
      exitCode: null,
      durationMs: null,
      unlockedBy: null,
      detail: 'runner settings'
    });
    return result;
  }

  /** Store a file secret from the app (Runner Settings > Secrets). */
  async deploySecretsSetFile(
    payload: BoardAgentActionMap['deploySecretsSetFile']['payload'],
    ctx: ActionContext = OWNER_CONTEXT
  ): Promise<{ success: boolean }> {
    const data = decodeFileSecret(payload.contentBase64);
    const { configDir, spaceDir } = this.secretsDirs();
    try {
      await this.auditPasswordFailure(
        ctx,
        'set file secret',
        [payload.name],
        () =>
          setSecretFile(
            configDir,
            spaceDir,
            payload.password,
            payload.name,
            data
          )
      );
    } finally {
      data.fill(0);
    }
    await this.core.audit.append({
      actor: ctx.actor,
      via: ctx.via,
      action: 'secret-set',
      job: null,
      keys: [payload.name],
      exitCode: null,
      durationMs: null,
      unlockedBy: null,
      detail: 'file; runner settings'
    });
    return { success: true };
  }

  async deploySecretsUnsetFile(
    payload: BoardAgentActionMap['deploySecretsUnsetFile']['payload'],
    ctx: ActionContext = OWNER_CONTEXT
  ): Promise<{ success: boolean }> {
    const { configDir, spaceDir } = this.secretsDirs();
    await this.auditPasswordFailure(
      ctx,
      'remove file secret',
      [payload.name],
      () => unsetSecretFile(configDir, spaceDir, payload.password, payload.name)
    );
    await this.core.audit.append({
      actor: ctx.actor,
      via: ctx.via,
      action: 'secret-unset',
      job: null,
      keys: [payload.name],
      exitCode: null,
      durationMs: null,
      unlockedBy: null,
      detail: 'file; runner settings'
    });
    return { success: true };
  }

  /** The keys inside an env file secret, for its owner: names and masked
   *  tails. `env: false` for a file that is not an env file. */
  async secretFileEnvKeys(
    payload: BoardAgentActionMap['secretFileEnvKeys']['payload'],
    ctx: ActionContext = OWNER_CONTEXT
  ): Promise<BoardAgentActionMap['secretFileEnvKeys']['result']> {
    const { configDir, spaceDir } = this.secretsDirs();
    const keys = await this.auditPasswordFailure(
      ctx,
      'list file secret keys',
      [payload.name],
      () =>
        secretFileEnvKeys(configDir, spaceDir, payload.password, payload.name)
    );
    return keys ? { env: true, keys } : { env: false };
  }

  /** Change one key inside an env file secret. The log names the file and
   *  the key; the value is in neither the log nor the answer. */
  async secretFileEnvSet(
    payload: BoardAgentActionMap['secretFileEnvSet']['payload'],
    ctx: ActionContext = OWNER_CONTEXT
  ): Promise<BoardAgentActionMap['secretFileEnvSet']['result']> {
    if (typeof payload.key !== 'string' || typeof payload.value !== 'string') {
      throw new Error('A key and a value are needed.');
    }
    const { configDir, spaceDir } = this.secretsDirs();
    const result = await this.auditPasswordFailure(
      ctx,
      'set file secret key',
      [payload.name],
      () =>
        setSecretFileEnvKey(configDir, spaceDir, payload.password, {
          name: payload.name,
          key: payload.key,
          value: payload.value,
          maxBytes: MAX_FILE_SECRET_BYTES
        })
    );
    await this.core.audit.append({
      actor: ctx.actor,
      via: ctx.via,
      action: 'secret-set',
      job: null,
      keys: [payload.name],
      exitCode: null,
      durationMs: null,
      unlockedBy: null,
      // The key name passed envKeyNameProblem to get here.
      detail: `file key ${payload.key}; runner settings`
    });
    return { success: true, ...result };
  }

  async secretFileEnvUnset(
    payload: BoardAgentActionMap['secretFileEnvUnset']['payload'],
    ctx: ActionContext = OWNER_CONTEXT
  ): Promise<BoardAgentActionMap['secretFileEnvUnset']['result']> {
    if (typeof payload.key !== 'string') throw new Error('A key is needed.');
    const { configDir, spaceDir } = this.secretsDirs();
    const result = await this.auditPasswordFailure(
      ctx,
      'remove file secret key',
      [payload.name],
      () =>
        unsetSecretFileEnvKey(configDir, spaceDir, payload.password, {
          name: payload.name,
          key: payload.key,
          maxBytes: MAX_FILE_SECRET_BYTES
        })
    );
    await this.core.audit.append({
      actor: ctx.actor,
      via: ctx.via,
      action: 'secret-unset',
      job: null,
      keys: [payload.name],
      exitCode: null,
      durationMs: null,
      unlockedBy: null,
      detail: `file key ${payload.key}; runner settings`
    });
    return { success: true, ...result };
  }

  deploySecretsSetMeta(
    payload: BoardAgentActionMap['deploySecretsSetMeta']['payload']
  ) {
    const { key, ...patch } = payload;
    return setSecretMeta(this.secretsDirs().spaceDir, key, patch);
  }

  async deploySecretsUnset(
    payload: BoardAgentActionMap['deploySecretsUnset']['payload'],
    ctx: ActionContext = OWNER_CONTEXT
  ) {
    const { configDir, spaceDir } = this.secretsDirs();
    const result = await this.auditPasswordFailure(
      ctx,
      'remove secret',
      [payload.key],
      () => unsetSecret(configDir, spaceDir, payload.password, payload.key)
    );
    await this.core.audit.append({
      actor: ctx.actor,
      via: ctx.via,
      action: 'secret-unset',
      job: null,
      keys: [payload.key],
      exitCode: null,
      durationMs: null,
      unlockedBy: null,
      detail: 'runner settings'
    });
    return result;
  }

  deployApproveSkill() {
    const config = this.core.readConfig();
    const onBranch = this.skillDraftBranch ?? undefined;
    this.skillCreatorSessionId = null;
    this.skillCreatorProvider = null;
    this.skillDraftBranch = null;
    this.creatorState = { phase: 'idle', logs: [], draft: null, error: '' };
    this.activity.clear('deploy-skill');
    return approveDeploySkill({
      spaceDir: this.core.spaceDir(),
      githubToken: config.githubToken,
      gitName: config.gitName,
      gitEmail: config.gitEmail,
      onBranch
    });
  }

  deployDiscardSkill() {
    this.skillCreatorSessionId = null;
    this.skillCreatorProvider = null;
    this.skillDraftBranch = null;
    this.creatorState = { phase: 'idle', logs: [], draft: null, error: '' };
    this.activity.clear('deploy-skill');
    return discardDeploySkill({ spaceDir: this.core.spaceDir() });
  }
  // ── GitHub device-code auth (see github-auth.ts) ──
  // The token lands in `githubToken`, the same field a pasted PAT used.

  async githubStartDeviceCode(
    p: BoardAgentActionMap['githubStartDeviceCode']['payload']
  ): Promise<BoardAgentActionMap['githubStartDeviceCode']['result']> {
    const start = await startGithubDeviceCode(p.clientId);
    console.log(
      `[github] device-code started: userCode=${start.userCode} expiresIn=${start.expiresIn}s interval=${start.interval}s`
    );
    this.trackSignin(
      'github',
      'GitHub sign-in',
      this.pollGithubUntilDone(
        p.clientId,
        start.deviceCode,
        start.interval,
        start.expiresIn
      )
    );
    return {
      userCode: start.userCode,
      verificationUri: start.verificationUri,
      expiresIn: start.expiresIn
    };
  }

  private async pollGithubUntilDone(
    clientId: string,
    deviceCode: string,
    interval: number,
    expiresIn: number
  ): Promise<void> {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const deadline = Date.now() + expiresIn * 1000;
    let wait = Math.max(interval, 5);
    while (Date.now() < deadline) {
      await sleep(wait * 1000);
      let res;
      try {
        res = await pollGithubDeviceCode(clientId, deviceCode);
      } catch (err) {
        console.log(`[github] poll threw (will retry): ${String(err)}`);
        continue; // transient; keep trying until the code expires
      }
      if (res.status === 'pending') continue;
      if (res.status === 'slow_down') {
        wait += 5;
        continue;
      }
      if (res.status === 'complete') {
        try {
          // Seed the git author too, so a fresh space needs no manual
          // name/email. Not fatal: the token is what matters.
          let login = '';
          const patch: Parameters<SpaceCore['setConfig']>[0] = {
            githubToken: res.accessToken
          };
          try {
            const id = await fetchGithubIdentity(res.accessToken);
            login = id.login;
            const existing = this.core.readConfig();
            if (!existing.gitName) patch.gitName = id.name;
            if (!existing.gitEmail) patch.gitEmail = id.email;
          } catch (err) {
            console.log(`[github] identity lookup failed: ${String(err)}`);
          }
          this.core.setConfig(patch);
          console.log('[github] token saved locally');
          // Before the UI hears "complete", so a push made right after it
          // goes through a plain origin (see refreshGithubOrigin).
          await this.refreshGithubOrigin();
          this.emitter.emitGithubAuth({ status: 'complete', login });
        } catch (err) {
          console.log(`[github] saving the token failed: ${String(err)}`);
          this.emitter.emitGithubAuth({
            status: 'error',
            message: 'Failed to store the GitHub token on the host.'
          });
        }
        return;
      }
      this.emitter.emitGithubAuth({
        status: res.status,
        message: res.status === 'error' ? res.message : undefined
      });
      return;
    }
    console.log('[github] device code reached deadline without completion');
    this.emitter.emitGithubAuth({ status: 'expired' });
  }

  /** A reconnect is used at once without this: sessions ask the runner for
   *  the token per push. It only takes out a token an older runner left in
   *  the primary clone's `origin`. */
  private async refreshGithubOrigin(): Promise<void> {
    if (!(await this.core.refreshOriginToken())) {
      console.log(
        '[github] origin not checked in the existing clone; the next workspace setup retries'
      );
    }
  }

  /** Disconnect = revoke at GitHub, then forget here, then take any token an
   *  older runner left out of the clones. Once forgotten, the socket's
   *  `git-credential` answers no token, so git fails at once in every session.
   *  The local half happens whatever GitHub said: a token that could not be
   *  revoked is still one this board must stop using, and `revoked: false`
   *  lets the UI send the owner to github.com to finish. */
  async githubDisconnect(): Promise<
    BoardAgentActionMap['githubDisconnect']['result']
  > {
    const { githubToken } = this.core.readConfig();
    const outcome = githubToken
      ? await this.revokeGithubUpstream(githubToken)
      : 'revoked';
    if (outcome !== 'revoked') {
      console.log(`[github] token not revoked at GitHub (${outcome})`);
    }
    this.core.clearToken('githubToken');
    if (!(await this.core.stripOriginToken())) {
      console.log(
        '[github] origin may still carry a token an older runner wrote'
      );
    }
    return { success: true, revoked: outcome === 'revoked' };
  }

  /** Never throws: the disconnect goes on either way. */
  private async revokeGithubUpstream(
    token: string
  ): Promise<GithubRevokeOutcome> {
    // A pasted personal access token is not the OAuth App's to revoke, and
    // GitHub would answer for it as for a dead token (isGithubOAuthAppToken).
    if (!this.revokeGithubToken || !isGithubOAuthAppToken(token)) {
      return 'not-configured';
    }
    try {
      return await this.revokeGithubToken(token);
    } catch {
      // The reason is dropped: it could quote the token.
      return 'failed';
    }
  }

  async githubIdentity(): Promise<
    BoardAgentActionMap['githubIdentity']['result']
  > {
    const { githubToken } = this.core.readConfig();
    if (!githubToken) return null;
    try {
      return await fetchGithubIdentity(githubToken);
    } catch {
      // An expired or revoked token reads as "not connected" rather than
      // erroring the whole settings view.
      return null;
    }
  }

  async githubListRepos(): Promise<
    BoardAgentActionMap['githubListRepos']['result']
  > {
    const { githubToken } = this.core.readConfig();
    if (!githubToken)
      throw this.core.notConnectedError('Connect GitHub first.');
    return listGithubRepos(githubToken);
  }

  async githubListBranches(
    p: BoardAgentActionMap['githubListBranches']['payload']
  ): Promise<BoardAgentActionMap['githubListBranches']['result']> {
    const { githubToken } = this.core.readConfig();
    if (!githubToken)
      throw this.core.notConnectedError('Connect GitHub first.');
    return listGithubBranches(githubToken, p.fullName);
  }

  /** A device-code sign-in is blocked on the user until the code expires, so
   *  it reports as awaiting-input rather than working. Keyed so GitHub and
   *  Claude can both be pending without overwriting each other. */
  private beginSignin(key: string, label: string) {
    this.activity.set(
      'signin',
      'awaiting-input',
      label,
      'Waiting for you to finish signing in',
      key
    );
    // The row clears when the flow reports back. A CLI that never exits
    // never reports, and the row sat in Running jobs for days with nothing
    // to close it. Every code these flows show is dead by now, so the
    // sign-in is over either way.
    clearTimeout(this.signinExpiry.get(key));
    const timer = setTimeout(() => {
      this.signinExpiry.delete(key);
      void this.endSignin(key);
    }, SIGNIN_TTL_MS);
    timer.unref?.();
    this.signinExpiry.set(key, timer);
  }

  private readonly signinExpiry = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  /** Cancel a sign-in's flow, where it has one to cancel, and drop its row. */
  private async endSignin(key: string): Promise<void> {
    clearTimeout(this.signinExpiry.get(key));
    this.signinExpiry.delete(key);
    if (key === 'codex') await this.codexLogin?.cancel();
    if (key === 'claude') await this.claudeLogin?.cancel();
    this.activity.clear('signin', key);
  }

  /** The X on a Running jobs row (`activityDismissable`). Live work is not
   *  dismissable: it is stopped from its own modal, not hidden. */
  async activityDismiss(p: { id: string }): Promise<{ success: boolean }> {
    const row = this.activity.get(p.id);
    // Already cleared: its clear is on the way to the client.
    if (!row) return { success: true };
    if (!activityDismissable(row)) {
      throw new Error(`${row.label} is still running and can't be dismissed.`);
    }
    if (row.kind === 'signin') {
      await this.endSignin(p.id.slice('signin:'.length));
    } else {
      this.activity.clear(row.kind);
    }
    return { success: true };
  }

  /** Same, for the two flows whose completion is a settled promise rather
   *  than a callback. Neither poller rejects; both end on their own deadline. */
  private trackSignin(key: string, label: string, poll: Promise<void>) {
    this.beginSignin(key, label);
    void poll.finally(() => this.activity.clear('signin', key));
  }

  // ── One-click sign-in (see claude-login.ts / codex-login.ts) ──

  private claudeLogin: ClaudeLoginFlow | null = null;
  private codexLogin: CodexLoginFlow | null = null;

  async claudeLoginStart(): Promise<{ url: string }> {
    if (!this.core.isReady()) {
      throw new Error('Initialize the environment first, then sign in.');
    }
    this.claudeLogin ??= new ClaudeLoginFlow(
      this.core.spaceSlug,
      this.core.target(),
      (result) => {
        if (result.status === 'complete') {
          this.core.setLoggedIn('claude', true);
          this.onSigninChanged?.('claude', true);
        }
        this.activity.clear('signin', 'claude');
        this.emitter.emitClaudeAuth(result);
      }
    );
    // Same stranded-flow reclaim as codexLoginStart above.
    if (this.claudeLogin.active) await this.claudeLogin.cancel();
    const started = await this.claudeLogin.start();
    this.beginSignin('claude', 'Claude sign-in');
    return started;
  }

  claudeLoginCode(p: { code: string }): { success: boolean } {
    if (!this.claudeLogin) throw new Error('No Claude sign-in in progress.');
    return this.claudeLogin.submitCode(p.code);
  }

  async claudeLoginCancel(): Promise<{ success: boolean }> {
    await this.claudeLogin?.cancel();
    this.activity.clear('signin', 'claude');
    return { success: true };
  }

  async codexLoginStart(): Promise<{ url: string; code: string }> {
    if (!this.core.isReady()) {
      throw new Error('Initialize the environment first, then sign in.');
    }
    // Codex is not one of the basics: its sign-in installs it (npm, no root).
    await installExtra(this.core.target(), 'codex', () => {});
    this.codexLogin ??= new CodexLoginFlow(
      this.core.spaceSlug,
      this.core.target(),
      (result) => {
        if (result.status === 'complete') {
          this.core.setLoggedIn('codex', true);
          this.onSigninChanged?.('codex', true);
        }
        this.activity.clear('signin', 'codex');
        this.emitter.emitCodexAuth(result);
      }
    );
    // Reclaim a stale flow: only Cancel releases the guard, so a closed modal
    // stranded it as `active`. Connect again means "give me a new code".
    if (this.codexLogin.active) await this.codexLogin.cancel();
    const started = await this.codexLogin.start();
    this.beginSignin('codex', 'Codex sign-in');
    return started;
  }

  async codexLoginCancel(): Promise<{ success: boolean }> {
    await this.codexLogin?.cancel();
    this.activity.clear('signin', 'codex');
    return { success: true };
  }

  async claudeLogout(): Promise<{ success: boolean }> {
    return this.logout('claude');
  }

  async codexLogout(): Promise<{ success: boolean }> {
    return this.logout('codex');
  }

  /** A sign-in or sign-out made with no board (Oakbox's, the daemon's
   *  runner-wide one): the same CLI home, so this board's cached state
   *  follows it. */
  signinChanged(provider: AgentProvider, signedIn: boolean): void {
    this.core.setLoggedIn(provider, signedIn);
  }

  private async logout(provider: AgentProvider): Promise<{ success: boolean }> {
    if (!this.core.isReady()) {
      throw new Error('Initialize the environment first.');
    }
    await signOut(this.core.target(), provider);
    this.core.setLoggedIn(provider, false);
    this.onSigninChanged?.(provider, false);
    return { success: true };
  }

  // ── Ask Board + claude-only controls (→ claude) ──

  async ask(
    params: BoardAgentActionMap['ask']['payload'],
    sendLog: (entry: { type: string; content: string }) => void
  ) {
    // Ask runs a headless agent with no card behind it, so nothing else would
    // report it. Without this the board's busiest job is the invisible one.
    this.activity.set(
      'ask',
      'working',
      'Ask Board',
      params.question.slice(0, 80)
    );
    // Conversations answer in parallel and share the one row, so it only
    // retires when the last of them settles.
    this.asksInFlight += 1;
    try {
      const answer = await this.claude.ask(params, sendLog);
      if (this.asksInFlight === 1) this.activity.clear('ask');
      return answer;
    } catch (err) {
      // The error row stays up: a failed Ask is worth seeing from the panel.
      this.activity.set('ask', 'error', 'Ask Board', errText(err));
      throw err;
    } finally {
      this.asksInFlight -= 1;
    }
  }
  resetBoardSession() {
    return this.claude.resetBoardSession();
  }
  boardSession(payload: BoardAgentActionMap['boardSession']['payload']) {
    // A void payload arrives as null over the wire.
    const { conversationId } = (payload ?? {}) as { conversationId?: string };
    return this.claude.boardSession(conversationId);
  }
  async boardSessions(): Promise<
    BoardAgentActionMap['boardSessions']['result']
  > {
    return { conversations: await this.claude.boardSessions() };
  }
  boardSessionUpdate(
    payload: BoardAgentActionMap['boardSessionUpdate']['payload']
  ) {
    return this.claude.boardSessionUpdate(payload);
  }
  boardSessionDelete(
    payload: BoardAgentActionMap['boardSessionDelete']['payload']
  ) {
    return this.claude.boardSessionDelete(payload.conversationId);
  }
  cardStartPreview(payload: { postId: string }) {
    return this.claude.cardStartPreview(payload);
  }
  cardAnswerQuestion(payload: { postId: string; answer: string }) {
    this.claude.cardAnswerQuestion(payload);
  }
  cardFeedback(payload: { postId: string; feedback: string }) {
    this.claude.cardFeedback(payload);
  }

  // ── Terminal ops (→ terminal) ──

  bareFsList(p: BoardAgentActionMap['bareFsList']['payload']) {
    return this.terminal.bareFsList(p);
  }
  bareFsSearch(p: BoardAgentActionMap['bareFsSearch']['payload']) {
    return this.terminal.bareFsSearch(p);
  }
  bareFsRead(p: BoardAgentActionMap['bareFsRead']['payload']) {
    return this.terminal.bareFsRead(p);
  }
  bareFsWrite(p: BoardAgentActionMap['bareFsWrite']['payload']) {
    return this.terminal.bareFsWrite(p);
  }
  terminalDropImage(p: BoardAgentActionMap['terminalDropImage']['payload']) {
    return this.terminal.terminalDropImage(p);
  }
  terminalDropFile(p: BoardAgentActionMap['terminalDropFile']['payload']) {
    return this.terminal.terminalDropFile(p);
  }
  bareFsUpload(p: BoardAgentActionMap['bareFsUpload']['payload']) {
    return this.terminal.bareFsUpload(p);
  }
  bareFsDelete(p: BoardAgentActionMap['bareFsDelete']['payload']) {
    return this.terminal.bareFsDelete(p);
  }
  bareFsMkdir(p: BoardAgentActionMap['bareFsMkdir']['payload']) {
    return this.terminal.bareFsMkdir(p);
  }
  bareReview(p: BoardAgentActionMap['bareReview']['payload']) {
    return this.terminal.bareReview(p);
  }
  bareGitStatus(p: BoardAgentActionMap['bareGitStatus']['payload']) {
    return this.terminal.bareGitStatus(p);
  }
  bareGitCommitDiff(p: BoardAgentActionMap['bareGitCommitDiff']['payload']) {
    return this.terminal.bareGitCommitDiff(p);
  }
  bareGitCompare(p: BoardAgentActionMap['bareGitCompare']['payload']) {
    return this.terminal.bareGitCompare(p);
  }
  bareGitBlob(p: BoardAgentActionMap['bareGitBlob']['payload']) {
    return this.terminal.bareGitBlob(p);
  }
  bareGitStage(p: BoardAgentActionMap['bareGitStage']['payload']) {
    return this.terminal.bareGitStage(p);
  }
  bareGitUnstage(p: BoardAgentActionMap['bareGitUnstage']['payload']) {
    return this.terminal.bareGitUnstage(p);
  }
  bareGitFileDiff(p: BoardAgentActionMap['bareGitFileDiff']['payload']) {
    return this.terminal.bareGitFileDiff(p);
  }
  bareGitAct(p: BoardAgentActionMap['bareGitAct']['payload']) {
    return this.terminal.bareGitAct(p);
  }
  bareListProcesses(p: BoardAgentActionMap['bareListProcesses']['payload']) {
    return this.terminal.bareListProcesses(p);
  }
  bareKillProcess(p: BoardAgentActionMap['bareKillProcess']['payload']) {
    return this.terminal.bareKillProcess(p);
  }
  bareListTerminals(p: BoardAgentActionMap['bareListTerminals']['payload']) {
    // Claude cards can have live tabs too (the shell attaches by exec target),
    // and the terminal engine only knows its own map.
    return this.terminal.bareListTerminals(
      p,
      this.getCardTarget(String(p.postId)) ?? undefined
    );
  }
  bareTerminalHealth(p: BoardAgentActionMap['bareTerminalHealth']['payload']) {
    return this.terminal.bareTerminalHealth(p);
  }
  bareAckTerminalDigest() {
    return this.terminal.bareAckTerminalDigest();
  }
  async bareChatTranscript(
    p: BoardAgentActionMap['bareChatTranscript']['payload']
  ) {
    const id = String(p.postId);
    const target = this.getCardTarget(id);
    if (!target) return { found: false, sessionId: '', events: [], offset: 0 };
    // Where tabs start, for while no tab is running Claude: what the
    // terminal bridge starts them in.
    const workspace = this.getCardWorkspacePath(id) || target.paths.workspace;
    const read = await readChatTranscript(
      target,
      id,
      workspace,
      typeof p.sessionId === 'string' ? p.sessionId : '',
      Number(p.offset),
      this.chatRuns.conversation(id)
    );
    return {
      ...read,
      running: this.chatRuns.running(id),
      error: this.chatRuns.error(id),
      turns: this.chatRuns.turns(id)
    };
  }
  bareChatSend(p: BoardAgentActionMap['bareChatSend']['payload']) {
    this.chatRuns.send(String(p.postId), p.text);
  }
  async bareChatInterrupt(
    p: BoardAgentActionMap['bareChatInterrupt']['payload']
  ) {
    const id = String(p.postId);
    if (this.chatRuns.stop(id)) return;
    // No turn of the chat's own: a turn started in the terminal, which the
    // chat shows. Stopped as there, with Esc.
    const target = this.getCardTarget(id);
    if (!target) throw new Error('No active session for this card.');
    // Neither Claude open there: a Codex session's, stopped the same way.
    if (!(await terminalInterrupt(target, id)))
      await codexInterrupt(target, id);
  }
  bareChatToTerminal(p: BoardAgentActionMap['bareChatToTerminal']['payload']) {
    return this.chatRuns.toTerminal(String(p.postId));
  }
  async bareChatConversations(
    p: BoardAgentActionMap['bareChatConversations']['payload']
  ): Promise<BoardAgentActionMap['bareChatConversations']['result']> {
    const id = String(p.postId);
    const target = this.getCardTarget(id);
    if (!target) return { cwd: '', current: '', conversations: [] };
    // Where the session's agents start, as the transcript read takes it.
    const pane = await findAgentPane(target, id).catch(() => null);
    const cwd =
      pane?.cwd ?? (this.getCardWorkspacePath(id) || target.paths.workspace);
    return {
      cwd,
      current: pane?.sessionId ?? this.chatRuns.conversation(id) ?? '',
      conversations: await listConversations(target, cwd)
    };
  }
  bareChatResume(p: BoardAgentActionMap['bareChatResume']['payload']) {
    return this.chatRuns.resume(
      String(p.postId),
      p.provider === 'codex' ? 'codex' : 'claude',
      String(p.conversationId)
    );
  }
  async bareChatCommand(
    p: BoardAgentActionMap['bareChatCommand']['payload']
  ): Promise<BoardAgentActionMap['bareChatCommand']['result']> {
    const id = String(p.postId);
    if (!['clear', 'model', 'compact'].includes(p.command)) {
      throw new Error('Not a chat command.');
    }
    const provider = this.terminal.get(id)?.provider ?? 'claude';
    const message = await this.chatRuns.command(
      id,
      provider,
      p.command,
      typeof p.arg === 'string' ? p.arg : ''
    );
    return { message };
  }
  /** Point each terminal session's IDE at where its agent is working: the
   *  last folder its conversation records (the terminal Claude's, else the
   *  chat's own), up to that folder's project, inside the space. */
  private async followWorkPaths(): Promise<void> {
    if (this.followingWorkPaths) return;
    this.followingWorkPaths = true;
    try {
      const target = this.core.target();
      const root = target.paths.root;
      for (const id of Object.keys(this.terminal.listSummaries())) {
        const pane = await findAgentPane(target, id).catch(() => null);
        const conversation = pane?.sessionId ?? this.chatRuns.conversation(id);
        if (!conversation) continue;
        const cwd =
          pane?.cwd ??
          (this.getCardWorkspacePath(id) || target.paths.workspace);
        const work = await readWorkPath(target, cwd, conversation);
        // Moves only when the agent did: a set_work_path holds till then.
        if (!work || work.path === this.terminal.followed(id)) continue;
        this.terminal.setFollowed(id, work.path);
        // Inside the space: never a folder of the person's own.
        if (work.path !== root && !work.path.startsWith(`${root}/`)) continue;
        this.terminal.setWorkPath(id, work.path, work.git);
      }
    } catch {
      // The next tick tries again.
    } finally {
      this.followingWorkPaths = false;
    }
  }
  bareLinkCard(p: BoardAgentActionMap['bareLinkCard']['payload']) {
    const cardId = String(p.cardId ?? '');
    if (cardId && !isCardPostId(cardId)) throw new Error('Not a card id.');
    if (!this.terminal.setCardId(String(p.postId), cardId)) {
      throw new Error('No active session for this card.');
    }
  }
  bareRestartStaleTerminals(
    p: BoardAgentActionMap['bareRestartStaleTerminals']['payload']
  ) {
    return this.terminal.bareRestartStaleTerminals(p);
  }
  bareEditorState(p: BoardAgentActionMap['bareEditorState']['payload']) {
    return this.terminal.bareEditorState(p);
  }
  bareOpenFile(p: BoardAgentActionMap['bareOpenFile']['payload']) {
    this.terminal.bareOpenFile(p);
  }
  bareCloseFile(p: BoardAgentActionMap['bareCloseFile']['payload']) {
    this.terminal.bareCloseFile(p);
  }
  bareBufferSet(p: BoardAgentActionMap['bareBufferSet']['payload']) {
    this.terminal.bareBufferSet(p);
  }
  bareExpose(p: BoardAgentActionMap['bareExpose']['payload']) {
    return this.terminal.bareExpose(p);
  }
  bareUnexpose(p: BoardAgentActionMap['bareUnexpose']['payload']) {
    return this.terminal.bareUnexpose(p);
  }
  bareListExposed(p: BoardAgentActionMap['bareListExposed']['payload']) {
    return this.terminal.bareListExposed(p);
  }

  // ── Scratchpad (→ the space's display surface) ──

  scratchpadList() {
    return this.scratchpad.list();
  }
  scratchpadRead(p: BoardAgentActionMap['scratchpadRead']['payload']) {
    return this.scratchpad.read(p.name);
  }
  scratchpadReadChunk(
    p: BoardAgentActionMap['scratchpadReadChunk']['payload']
  ) {
    return this.scratchpad.readChunk(p.name, p.offset, p.length);
  }
  scratchpadDelete(p: BoardAgentActionMap['scratchpadDelete']['payload']) {
    return this.scratchpad.remove(p.name);
  }
  scratchpadClear() {
    return this.scratchpad.clear();
  }

  simulatorList() {
    return this.simulator.list();
  }
  simulatorStatus() {
    return this.simulator.status();
  }
  simulatorAttach(p: BoardAgentActionMap['simulatorAttach']['payload']) {
    this.onSimulatorAttach?.();
    return this.simulator.attach(p);
  }
  simulatorDetach() {
    this.simulator.detach();
  }
  simulatorInput(p: BoardAgentActionMap['simulatorInput']['payload']) {
    return this.simulator.input(p);
  }

  // ── Cross-mode coordinators ──

  /** `origin`: who the session acts for (the channel's actor), and the
   *  session that started it when an agent did (start_session). */
  async cardExecute(
    payload: BoardAgentActionMap['cardExecute']['payload'],
    origin: { startedBy?: SessionStarter; startedVia?: string } = {}
  ): Promise<{ taskId: string; postId: string }> {
    const {
      postId: rawPostId,
      prompt,
      baseBranch,
      targetBranch,
      taskTitle,
      effort,
      mode,
      worktree
    } = payload;
    const postId = String(rawPostId);

    if (this.claude.isRunning(postId) || this.terminal.isRunning(postId)) {
      throw new Error('A session is already running for this card.');
    }

    // Per-job provider, defaulting to the space config. A synthetic terminal
    // has no agent but the chat's Claude, whatever the default.
    const config = this.core.readConfig();
    const provider = sessionProvider(
      postId,
      payload.provider ?? resolveProvider(config.provider)
    );

    // Silent replace: drop the stale session, but do NOT emit
    // session-removed - the new session's emitSessionUpdate supersedes it.
    const stale = this.owner(postId);
    if (stale) stale.remove(postId);

    // A terminal session started again on its card (the window reopened on
    // it after a runner restart) keeps the conversation its chat ran
    // (chatRun.ts): starting over would cut the chat off from it.
    const prior =
      mode === 'bare'
        ? await getCard(this.core.target(), postId).catch(() => null)
        : null;

    const taskId = sanitizeTaskId(`${postId}-${Date.now()}`);
    const base = {
      taskId,
      postId,
      phase: 'starting' as const,
      mode,
      step: 1 as const,
      logs: [],
      diff: '',
      changedFiles: [],
      commitMessage: '',
      previewUrl: '',
      previewRunning: false,
      reproSteps: '',
      pendingQuestion: '',
      error: '',
      startedAt: Date.now(),
      taskTitle: taskTitle || '',
      targetBranch: targetBranch || '',
      effort: effort || 'high',
      todos: [],
      provider,
      // Claude mode overwrites this once the CLI reports its conversation id.
      agentSessionId: prior?.mode === 'bare' ? prior.agentSessionId : '',
      // Filled in by the git claude pipeline once its worktree is created.
      workspacePath: '',
      startedBy: origin.startedBy,
      startedVia: origin.startedVia
    };

    await this.reserveSessionPorts(postId);
    if (mode === 'bare') {
      this.terminal.start(base, {
        baseBranch: baseBranch ?? '',
        worktree: worktree !== false
      });
    } else {
      this.claude.start(base, {
        prompt,
        baseBranch: baseBranch ?? ''
      });
    }

    return { taskId, postId };
  }

  /** One-shot agent call combining the selected cards' text into the merged
   *  card. The server never talks to a model. */
  async cardMergeContent(
    payload: BoardAgentActionMap['cardMergeContent']['payload']
  ): Promise<BoardAgentActionMap['cardMergeContent']['result']> {
    const spaceDir = this.core.spaceDir();
    const cards = payload.cards
      .map(
        (c) =>
          `### ${c.title.trim() || '(untitled)'}\n${c.content.trim() || '(no description)'}`
      )
      .join('\n\n');
    const { result } = await spawnAgent(
      this.core.agentProvider(),
      this.core.target(),
      {
        cwd: spaceDir,
        prompt: buildPrompt(prompts.mergeCards, { cards }),
        allowedTools: '',
        model: 'claude-sonnet-4-6',
        env: spaceEnv(spaceDir),
        callbacks: {}
      }
    );
    const { text } = await result;
    const raw = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    let json: unknown = null;
    try {
      json = JSON.parse(raw);
    } catch {
      // Falls through to the schema failure below.
    }
    const parsed = mergedCardSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error('The merge model returned an unusable card.');
    }
    return parsed.data;
  }

  /** Merge follow-up: capture the source sessions' diffs, tear them down, and
   *  start a session on the merged card that reconciles those diffs. */
  async cardMergeSessions(
    payload: BoardAgentActionMap['cardMergeSessions']['payload']
  ): Promise<{ taskId: string; postId: string }> {
    const primaryPostId = String(payload.primaryPostId);
    const sourcePostIds = [...new Set(payload.sourcePostIds.map(String))];

    if (
      this.claude.isRunning(primaryPostId) ||
      this.terminal.isRunning(primaryPostId)
    ) {
      throw new Error('A session is already running for the primary card.');
    }

    // Only 'complete' sessions contribute; the cards are already deleted,
    // so aborting on a stale one would strand every remaining diff.
    const sources: { title: string; diff: string; targetBranch: string }[] = [];
    for (const id of sourcePostIds) {
      const s = this.claude.get(id);
      if (s && s.phase === 'complete' && s.diff.trim()) {
        sources.push({
          title: s.taskTitle,
          diff: s.diff,
          targetBranch: s.targetBranch
        });
      }
    }
    // The merged session pushes to the first source's branch when it had one.
    const targetBranch = sources[0]?.targetBranch || '';

    // Tear down every source session, even with nothing to merge, so none
    // outlives its now-deleted card.
    await Promise.all(
      sourcePostIds
        .filter((id) => this.claude.has(id))
        .map((id) => this.claude.kill(id))
    );

    // Every completed session had an empty diff - nothing to reconcile.
    if (sources.length === 0) {
      return { taskId: '', postId: primaryPostId };
    }

    const taskId = sanitizeTaskId(`${primaryPostId}-${Date.now()}`);
    await this.reserveSessionPorts(primaryPostId);
    this.claude.startMerge(
      {
        taskId,
        postId: primaryPostId,
        phase: 'starting' as const,
        mode: 'claude',
        step: 1 as const,
        logs: [],
        diff: '',
        changedFiles: [],
        commitMessage: '',
        previewUrl: '',
        previewRunning: false,
        reproSteps: '',
        pendingQuestion: '',
        error: '',
        startedAt: Date.now(),
        taskTitle: payload.taskTitle || '',
        targetBranch,
        effort: 'high',
        todos: [],
        // Merge reconciles diffs on a worktree; the provider is the space default.
        provider: resolveProvider(this.core.readConfig().provider),
        // The merge starts a brand-new thread; the sources' ids died with
        // their sessions above.
        agentSessionId: '',
        // Merge runs on its own worktree (set by runMergePipeline via
        // addWorktree).
        workspacePath: ''
      },
      { sources: sources.map(({ title, diff }) => ({ title, diff })) }
    );

    return { taskId, postId: primaryPostId };
  }

  /** Exec target for the terminal bridge, by postId. Errored sessions resolve
   *  too: a crashed run is when a shell is worth the most. */
  getCardTarget(postId: string): ExecTarget | null {
    const id = String(postId);
    // The board-level Ask terminal has no card: resolve its key to the space
    // target directly so the postId-keyed bridge can attach it.
    if (id === boardTerminalKey(this.core.spaceSlug)) {
      return this.core.target();
    }
    const session = this.claude.get(id) ?? this.terminal.get(id);
    if (!session) return null;
    return this.core.target();
  }

  /** The card's agent cwd (its worktree) for the terminal bridge
   *  to resume in; null when there's no session or it never got a cwd. */
  getCardWorkspacePath(postId: string): string | null {
    const id = String(postId);
    if (id === boardTerminalKey(this.core.spaceSlug)) {
      return this.claude.boardTerminalTarget().cwd;
    }
    const session = this.claude.get(id) ?? this.terminal.get(id);
    return session?.workspacePath || null;
  }

  /** The session's own FACTIII_PORTS block (port-blocks.ts), before anything
   *  of it spawns; teardownSession frees it. Kept when it already has one, so
   *  a resumed session keeps its ports. Best effort: without one the session
   *  runs on the board's block, as every session did before blocks were per
   *  session. The board's own Ask terminal is board-level and keeps that. */
  private async reserveSessionPorts(postId: string): Promise<void> {
    if (postId === boardTerminalKey(this.core.spaceSlug)) return;
    this.reservingPorts.add(postId);
    try {
      await allocateSessionPorts(this.core.spaceDir(), postId);
    } catch {
      // No free block: the board's ports are what it had before.
    } finally {
      this.reservingPorts.delete(postId);
    }
  }

  /** Tear a card down. See card-session.teardownSession. */
  private teardownSession(session: BaseSession): Promise<string[]> {
    return teardownSession(session, this.core.target());
  }

  cardSessions(): Record<string, SessionSummary> {
    return { ...this.terminal.listSummaries(), ...this.claude.listSummaries() };
  }

  /** Who started a session (BaseSession.startedBy), for the runner owner's
   *  eyes only (apps/runner daemon.ts). Undefined for a session started
   *  before this was recorded, which counts as the owner's, and for one that
   *  is gone. */
  sessionStarter(postId: string): SessionStarter | undefined {
    return this.owner(String(postId))?.get(String(postId))?.startedBy;
  }

  /** This board's terminals with who started each, for the runner owner's
   *  Remote connections (apps/runner runnerConnections.ts). */
  terminalSessions(): {
    summary: SessionSummary;
    startedBy?: SessionStarter;
  }[] {
    return Object.entries(this.terminal.listSummaries()).map(
      ([postId, summary]) => ({
        summary,
        startedBy: this.terminal.get(postId)?.startedBy
      })
    );
  }

  /** A terminal tab's screen and up to `lines` lines of scrollback (tmux),
   *  for the runner owner's log view. No `tabId`: the session's first tab.
   *  Null when the session or the tab is gone. */
  async captureTerminalTab(
    postId: string,
    tabId: string | undefined,
    lines: number
  ): Promise<{ tabId: string; text: string } | null> {
    const target = this.getCardTarget(postId);
    if (!target) return null;
    const tabs = await this.bareListTerminals({ postId });
    const tab =
      tabId === undefined ? tabs[0] : tabs.find((t) => t.id === tabId);
    if (!tab) return null;
    const text = await captureTmuxPane(
      target,
      tmuxName(`${postId}-${tab.id}`),
      lines
    );
    return { tabId: tab.id, text };
  }

  /** Reattach this space's workspace (if any) and rebuild its sessions from
   *  the card store. Best-effort; fired when the engine is first created after
   *  a restart. */
  async reattachAndHydrate(): Promise<void> {
    // Updates parked before a restart get their prompt back, and the 24-hour
    // sweep starts. Independent of the workspace, so first.
    void this.secretsInbox()
      .resume()
      .catch(() => undefined);
    try {
      const attached = await this.core.reattachSpaceWorkspace();
      if (!attached) return;
      const records = await listCards(this.core.target());
      if (records.length) {
        // Each engine ignores records that aren't its mode, so both see the
        // full list and claim their own (claude cards vs bare sessions).
        this.claude.hydrate(records);
        this.terminal.hydrate(records);
      }
      // Blocks held by sessions nothing holds any more (lost without an End)
      // go back to the pool. Every session that came back keeps its block, or
      // gets one when it predates them: its running tabs keep the board's
      // ports until restarted, new tabs and restarts get its own.
      const live = this.claimedWork(records).postIds;
      try {
        pruneSessionPorts(
          this.core.spaceDir(),
          (id) => live.has(id) || this.reservingPorts.has(id)
        );
      } catch {
        // Unwritable registry: the blocks stay held, which is safe.
      }
      for (const r of records) await this.reserveSessionPorts(r.postId);
      // After hydrate, so every record is a session the sweep can see.
      await this.sweepLeftovers(records);
    } catch {
      // Card store unreadable: the board still works; a later card run
      // provisions the workspace fresh.
    }
  }

  /** Everything a session or record holds, for the sweep and for an End that
   *  has to find a lost session's worktree without taking someone else's. */
  private claimedWork(records: CardRecord[]): {
    postIds: Set<string>;
    paths: Set<string>;
  } {
    const postIds = new Set(Object.keys(this.cardSessions()));
    const paths = new Set(this.terminal.claimedWorkspaces());
    for (const id of postIds) {
      const path = this.claude.get(id)?.workspacePath;
      if (path) paths.add(path);
    }
    for (const r of records) {
      postIds.add(r.postId);
      if (r.worktreePath) paths.add(r.worktreePath);
    }
    return { postIds, paths };
  }

  /** Startup: remove terminal worktrees and `terminal-bare-*` tmux sessions
   *  that nothing holds and that hold no work. See sweepLeftoverTerminals. */
  private async sweepLeftovers(records: CardRecord[]): Promise<void> {
    // A function, not a snapshot: terminals can start while the sweep runs
    // (dispatch is not blocked on reattach), so each removal asks again.
    await sweepLeftoverTerminals(this.core.target(), () =>
      this.claimedWork(records)
    ).catch(() => undefined);
  }

  /** The stable board id this engine runs, if the caller provided one. */
  get spaceId(): number | null {
    return this.core.spaceId;
  }

  cardSession({ postId }: { postId: string }) {
    return (
      this.claude.sessionWithLogs(String(postId)) ??
      this.terminal.sessionWithLogs(String(postId))
    );
  }

  /** End a session and free everything it held: tmux, worktree, branch,
   *  record. Throws when some of it could not go, so End can say so instead
   *  of closing on a name that is still "already in use". `keepBranch` keeps
   *  a terminal's branch (end_session, session-hypervisor.ts). */
  async cardDismiss({
    postId: rawPostId,
    keepBranch
  }: BoardAgentActionMap['cardDismiss']['payload']): Promise<void> {
    const left = await this.endSession(String(rawPostId), {
      keepBranch: keepBranch === true
    });
    if (left.length) {
      throw new Error(`Session ended, but ${left.join(', and ')}.`);
    }
  }

  /** cardDismiss's work: resolves with what could not be removed, as
   *  sentences, where cardDismiss throws them. */
  private async endSession(
    postId: string,
    opts: { keepBranch: boolean }
  ): Promise<string[]> {
    const owner = this.owner(postId);
    let left: string[];
    if (owner) {
      left = await teardownSession(
        owner.get(postId)!,
        this.core.target(),
        opts
      );
      owner.remove(postId);
    } else {
      left = await this.dismissLost(postId, opts);
    }
    this.emitter.emitSessionRemoved(postId);
    return left;
  }

  /** This board for the board MCP's hypervisor tools (session-hypervisor.ts):
   *  its Chat and Code sessions, and the same actions the app uses on them.
   *  The rules (levels, the cap, refusing to lose work) are the
   *  hypervisor's; this only does what it is told. */
  hypervisorBoard(): HypervisorBoard {
    const boardKey = boardTerminalKey(this.core.spaceSlug);
    const sessions = (): BaseSession[] =>
      Object.keys(this.terminal.listSummaries())
        .filter((id) => id !== boardKey)
        .map((id) => this.terminal.get(id))
        .filter((s): s is BaseSession => !!s);
    const view = (s: BaseSession): HypervisorSession => {
      const code = isWorktreeSession(s, this.core.target());
      return {
        id: s.postId,
        title: s.taskTitle,
        state: hypervisorState(s, this.chatRuns.running(s.postId)),
        mode: code ? 'Code' : 'Chat',
        cardId: sessionCardId(s),
        worktree: code ? s.workspacePath : '',
        startedBy: s.startedBy,
        startedVia: s.startedVia
      };
    };
    return {
      sessions: () => sessions().map(view),
      hasRepo: () => {
        const config = this.core.readConfig();
        return Boolean(config.repoUrl && config.githubToken);
      },
      start: async (args) => {
        if (args.code) {
          // Checked before anything starts, as the launcher does: the
          // runner would otherwise fail the session after it was made.
          const name = slugifyWorkName(args.title);
          if (!name) throw new Error('Use letters or numbers in the title.');
          if ((await this.core.bareWorkNames()).includes(name)) {
            throw new Error(`"${name}" is already in use on this board.`);
          }
        }
        const postId = `bare-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        await this.cardExecute(
          {
            postId,
            prompt: '',
            baseBranch: args.baseBranch,
            targetBranch: '',
            taskTitle: args.title,
            effort: 'high',
            mode: 'bare',
            worktree: args.code
          },
          { startedBy: args.startedBy, startedVia: args.startedVia }
        );
        if (args.cardId) this.terminal.setCardId(postId, args.cardId);
        void this.sendWhenReady(postId, args.message);
        return postId;
      },
      send: (id, text) => this.chatRuns.send(id, text),
      transcript: async (id) =>
        (
          await this.bareChatTranscript({
            postId: id,
            sessionId: '',
            offset: 0
          })
        ).events,
      work: async (id) => {
        const session = this.terminal.get(id);
        if (!session || !isWorktreeSession(session, this.core.target())) {
          return null;
        }
        const cut = session.targetBranch;
        return readWorkState(this.core.target(), session.workspacePath, [
          ...(cut ? [`origin/${cut}`, cut] : []),
          'origin/main',
          'origin/master',
          'main',
          'master'
        ]);
      },
      end: (id, { deleteBranch }) =>
        this.endSession(id, { keepBranch: !deleteBranch }),
      audit: (entry) =>
        this.core.audit.append({
          actor: { userId: entry.actor.userId, name: entry.actor.name },
          via: 'mcp',
          action: entry.action,
          job: null,
          keys: [],
          exitCode: null,
          durationMs: null,
          unlockedBy: null,
          detail: entry.detail
        })
    };
  }

  /** start_session's opening message: into the chat once the session's
   *  workspace is ready, since a chat turn before then would run outside
   *  its worktree. Gives up when the session ends or errors first, or after
   *  SEND_WHEN_READY_MS, and says so in the session's log. */
  private async sendWhenReady(postId: string, text: string): Promise<void> {
    const deadline = Date.now() + SEND_WHEN_READY_MS;
    for (;;) {
      const session = this.terminal.get(postId);
      if (!session || session.phase === 'error') return;
      if (session.phase === 'bare-active') {
        try {
          this.chatRuns.send(postId, text);
        } catch (err) {
          this.emitter.addLog(
            session,
            'error',
            `The opening message could not be sent: ${errText(err)}`
          );
        }
        return;
      }
      if (Date.now() > deadline) {
        this.emitter.addLog(
          session,
          'error',
          'The opening message was not sent: the workspace was not ready in time.'
        );
        return;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, SEND_WHEN_READY_POLL_MS)
      );
    }
  }

  /** End for a session this engine no longer holds in memory (a restart that
   *  did not hydrate it, say). Returning early here is what left the worktree,
   *  the branch and the tmux sessions behind, and the name taken. The stored
   *  record says what to tear down; with none, the session's own tmux panes
   *  point at its worktree. The tmux sessions go by postId either way. */
  private async dismissLost(
    postId: string,
    opts: { keepBranch: boolean }
  ): Promise<string[]> {
    const target = this.core.target();
    const record = await getCard(target, postId).catch(() => null);
    if (record) {
      return teardownSession(
        {
          postId,
          mode: record.mode,
          workspacePath: record.worktreePath
        },
        target,
        opts
      );
    }
    const records = await listCards(target).catch((): CardRecord[] => []);
    const workspacePath = await orphanWorkspaceFromPanes(
      target,
      postId,
      this.claimedWork(records).paths
    ).catch(() => '');
    // Read off a pane, which may have `cd`'d into some other leftover: only a
    // tree that holds no work is taken on that evidence. One that does stays,
    // and End says so.
    if (
      workspacePath &&
      !(await isDisposableWorktree(
        target,
        workspacePath,
        await worktreeBranch(target, workspacePath)
      ))
    ) {
      await teardownSession(
        { postId, mode: 'bare', workspacePath: '' },
        target
      );
      return [`${workspacePath} holds work, so it was kept`];
    }
    return teardownSession(
      { postId, mode: 'bare', workspacePath },
      target,
      opts
    );
  }

  async cardFinalize({
    postId: rawPostId,
    apply,
    branchName,
    commitMessage
  }: {
    postId: string;
    apply: boolean;
    branchName?: string;
    commitMessage?: string;
  }): Promise<{ applied: boolean; branchName: string }> {
    const postId = String(rawPostId);
    const owner = this.owner(postId);
    if (!owner) throw new Error('No active session for this card.');
    const session = owner.get(postId)!;
    const config = this.core.readConfig();

    // No git worktree: apply settles into done, dismiss tears the session down.
    if (!session.workspacePath) {
      if (apply) {
        session.phase = 'done';
        this.emitter.emitSessionUpdate(session);
        return { applied: true, branchName: '' };
      }
      await this.teardownSession(session);
      owner.remove(postId);
      this.emitter.emitSessionRemoved(postId);
      return { applied: false, branchName: '' };
    }

    if (apply && branchName) {
      const doPush = () =>
        commitAndPush(
          this.core.target(),
          branchName,
          commitMessage || `Board AI: ${branchName}`,
          {
            gitName: config.gitName,
            gitEmail: config.gitEmail
          },
          session.workspacePath || undefined
        );

      let pushResult;
      try {
        pushResult = await doPush();
      } catch (err) {
        if (err instanceof NoChangesError) {
          this.emitter.addLog(
            session,
            'system',
            'No changes to push - worktree kept for inspection.'
          );
          this.emitter.emitSessionUpdate(session);
          throw err;
        }
        const msg = err instanceof Error ? err.message : String(err);
        // Claude sessions get one AI recovery pass (fetch/rebase, conflict
        // resolution) before giving up; then a single retry of the push.
        if (owner !== this.claude) {
          this.emitter.addLog(session, 'error', `Push failed: ${msg}`);
          this.emitter.emitSessionUpdate(session);
          throw err;
        }
        this.emitter.addLog(session, 'error', `Push failed: ${msg}`);
        try {
          await this.claude.resolvePushIssue(postId, branchName, msg);
          pushResult = await doPush();
        } catch (retryErr) {
          // Keep the worktree on failure so the user can inspect the
          // workspace, retry, or pull the diff manually.
          this.emitter.addLog(
            session,
            'error',
            `Push failed after recovery: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`
          );
          this.emitter.emitSessionUpdate(session);
          throw retryErr;
        }
      }

      session.phase = 'done';
      // Keep the worktree for inspection;
      // just mirror the settled phase to the card store.
      if (isWorktreeSession(session, this.core.target())) {
        void patchCard(this.core.target(), postId, {
          phase: 'done',
          targetBranch: pushResult.branch
        }).catch(() => {});
      }
      this.emitter.addLog(
        session,
        'system',
        `Pushed ${pushResult.pushedSha.slice(0, 8)} to origin/${pushResult.branch}`
      );
      this.emitter.emitSessionUpdate(session);

      return { applied: true, branchName: pushResult.branch };
    }

    await this.teardownSession(session);
    owner.remove(postId);
    this.emitter.emitSessionRemoved(postId);

    return { applied: apply, branchName: branchName || '' };
  }

  async cardKill({ postId: rawPostId }: { postId: string }): Promise<void> {
    const postId = String(rawPostId);
    // Owned-by-postId is the common path; otherwise let both modes try their
    // taskId fallback (the non-owner no-ops).
    if (this.claude.has(postId)) return this.claude.kill(postId);
    if (this.terminal.has(postId)) return this.terminal.kill(postId);
    await this.claude.kill(postId);
    await this.terminal.kill(postId);
  }

  /** Stop a card's headless agent so a terminal can take over its thread
   *  (no-op for a bare session, which has no headless agent). */
  async cardHandoff({ postId }: { postId: string }): Promise<void> {
    await this.claude.handoff(String(postId));
  }

  /** Stop the Ask process and return its resume id + provider; the client then
   *  opens a terminal on the board key that resumes it. */
  async boardHandoff(
    payload?: BoardAgentActionMap['boardHandoff']['payload']
  ): Promise<{
    sessionId: string | null;
    provider: AgentProvider;
  }> {
    const res = await this.claude.boardHandoff(payload?.conversationId);
    // Register the Ask conversation as a bare session under the board key so the
    // standard bare terminal modal opens and resumes it via its agentSessionId.
    const t = this.claude.boardTerminalTarget();
    this.terminal.adoptBoardSession({
      postId: boardTerminalKey(this.core.spaceSlug),
      agentSessionId: res.sessionId ?? '',
      provider: res.provider,
      workspacePath: t.cwd,
      taskTitle: 'Ask Board'
    });
    return res;
  }

  // ── Lifecycle ──

  destroy(): void {
    clearInterval(this.workPathTimer);
    this.approvals.destroy();
    this.jobRunner?.destroy();
    this.inbox?.destroy();
    void this.claudeLogin?.cancel();
    void this.codexLogin?.cancel();
    for (const timer of this.signinExpiry.values()) clearTimeout(timer);
    this.signinExpiry.clear();
    this.claude.destroy();
    this.terminal.destroy();
    this.scratchpad.destroy();
    this.simulator.destroy();
    this.core.destroy();
  }

  /** Route one action/payload to the right engine method, for both transports.
   *  `askLogSender` takes the streaming lines from a Board AI `ask`. A write
   *  that changes which keys the store holds tells every client after it
   *  lands, so a "N secrets missing" badge on another device (or the window
   *  that did not make the change) asks again. */
  async dispatch<A extends keyof BoardAgentActionMap>(
    action: A,
    payload: BoardAgentActionMap[A]['payload'],
    askLogSender?: (entry: { type: string; content: string }) => void,
    ctx: ActionContext = OWNER_CONTEXT
  ): Promise<BoardAgentActionMap[A]['result']> {
    const result = await this.route(action, payload, askLogSender, ctx);
    if (SECRETS_STORE_WRITES.has(action)) {
      this.emitter.emitSecretsChanged({ at: Date.now() });
    }
    return result;
  }

  private async route<A extends keyof BoardAgentActionMap>(
    action: A,
    payload: BoardAgentActionMap[A]['payload'],
    askLogSender:
      | ((entry: { type: string; content: string }) => void)
      | undefined,
    ctx: ActionContext
  ): Promise<BoardAgentActionMap[A]['result']> {
    switch (action) {
      case 'getConfig':
        return (await this.getConfig()) as BoardAgentActionMap[A]['result'];
      case 'setConfig':
        return this.setConfig(
          payload as BoardAgentActionMap['setConfig']['payload']
        ) as BoardAgentActionMap[A]['result'];
      case 'clearToken': {
        const p = payload as BoardAgentActionMap['clearToken']['payload'];
        return this.clearToken(p.key) as BoardAgentActionMap[A]['result'];
      }
      case 'ask':
        return (await this.ask(
          payload as BoardAgentActionMap['ask']['payload'],
          askLogSender ?? (() => {})
        )) as BoardAgentActionMap[A]['result'];
      case 'resetBoardSession':
        await this.resetBoardSession();
        return undefined as BoardAgentActionMap[A]['result'];
      case 'boardSession':
        return (await this.boardSession(
          payload as BoardAgentActionMap['boardSession']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'boardSessions':
        return (await this.boardSessions()) as BoardAgentActionMap[A]['result'];
      case 'boardSessionUpdate':
        await this.boardSessionUpdate(
          payload as BoardAgentActionMap['boardSessionUpdate']['payload']
        );
        return undefined as BoardAgentActionMap[A]['result'];
      case 'boardSessionDelete':
        await this.boardSessionDelete(
          payload as BoardAgentActionMap['boardSessionDelete']['payload']
        );
        return undefined as BoardAgentActionMap[A]['result'];
      case 'cardExecute':
        return (await this.cardExecute(
          payload as BoardAgentActionMap['cardExecute']['payload'],
          { startedBy: starterOf(ctx) }
        )) as BoardAgentActionMap[A]['result'];
      case 'cardStartPreview':
        return (await this.cardStartPreview(
          payload as { postId: string }
        )) as BoardAgentActionMap[A]['result'];
      case 'cardMergeContent':
        return (await this.cardMergeContent(
          payload as BoardAgentActionMap['cardMergeContent']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'cardMergeSessions':
        return (await this.cardMergeSessions(
          payload as BoardAgentActionMap['cardMergeSessions']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'cardSessions':
        return this.cardSessions() as BoardAgentActionMap[A]['result'];
      case 'cardSession':
        return this.cardSession(
          payload as { postId: string }
        ) as BoardAgentActionMap[A]['result'];
      case 'cardDismiss':
        await this.cardDismiss(
          payload as BoardAgentActionMap['cardDismiss']['payload']
        );
        return undefined as BoardAgentActionMap[A]['result'];
      case 'setupAuthorize':
        return this.setupAuthorize(
          payload as BoardAgentActionMap['setupAuthorize']['payload']
        ) as BoardAgentActionMap[A]['result'];
      case 'setupStatus':
        return this.setupStatus() as BoardAgentActionMap[A]['result'];
      case 'environmentStatus':
        return (await this.environmentStatus()) as BoardAgentActionMap[A]['result'];
      case 'environmentInstall':
        return (await this.environmentInstall(
          payload as BoardAgentActionMap['environmentInstall']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'ensureSetup':
        return (await this.ensureSetup()) as BoardAgentActionMap[A]['result'];
      case 'cardRemoteBranches':
        return (await this.cardRemoteBranches()) as BoardAgentActionMap[A]['result'];
      case 'bareWorkNames':
        return (await this.bareWorkNames()) as BoardAgentActionMap[A]['result'];
      case 'deployStatus':
        return (await this.deployStatus()) as BoardAgentActionMap[A]['result'];
      case 'deployBranches':
        return (await this.deployBranches()) as BoardAgentActionMap[A]['result'];
      case 'skillsList':
        return (await this.skillsList()) as BoardAgentActionMap[A]['result'];
      case 'skillRead':
        return (await this.skillRead(
          payload as BoardAgentActionMap['skillRead']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'skillWriteGlobal':
        return (await this.skillWriteGlobal(
          payload as BoardAgentActionMap['skillWriteGlobal']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'skillDeleteGlobal':
        return (await this.skillDeleteGlobal(
          payload as BoardAgentActionMap['skillDeleteGlobal']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'skillMigrate':
        return (await this.skillMigrate(
          payload as BoardAgentActionMap['skillMigrate']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'skillProposeRepo':
        return (await this.skillProposeRepo(
          payload as BoardAgentActionMap['skillProposeRepo']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'deployCreateSkill':
        return (await this.deployCreateSkill(
          payload as BoardAgentActionMap['deployCreateSkill']['payload'],
          askLogSender ?? (() => {})
        )) as BoardAgentActionMap[A]['result'];
      case 'deployReviseSkill':
        return (await this.deployReviseSkill(
          payload as BoardAgentActionMap['deployReviseSkill']['payload'],
          askLogSender ?? (() => {})
        )) as BoardAgentActionMap[A]['result'];
      case 'deployCreatorState':
        return this.deployCreatorState() as BoardAgentActionMap[A]['result'];
      case 'deployLoadSkillBranch':
        return (await this.deployLoadSkillBranch(
          payload as BoardAgentActionMap['deployLoadSkillBranch']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'deployCheckEnvironment':
        return (await this.deployCheckEnvironment()) as BoardAgentActionMap[A]['result'];
      case 'deployFixEnvironment':
        return (await this.deployFixEnvironment(
          askLogSender ?? (() => {}),
          (payload as BoardAgentActionMap['deployFixEnvironment']['payload'])
            ?.provider
        )) as BoardAgentActionMap[A]['result'];
      case 'deployEnvState':
        return this.deployEnvState() as BoardAgentActionMap[A]['result'];
      case 'deployRunStart':
        return this.deployRunStart(
          askLogSender ?? (() => {}),
          (payload as BoardAgentActionMap['deployRunStart']['payload'])
            ?.provider,
          (payload as BoardAgentActionMap['deployRunStart']['payload'])?.branch
        ) as BoardAgentActionMap[A]['result'];
      case 'skillRunStart': {
        const run = payload as BoardAgentActionMap['skillRunStart']['payload'];
        return this.deployRunStart(
          askLogSender ?? (() => {}),
          run?.provider,
          undefined,
          {
            scope: run?.scope === 'global' ? 'global' : 'repo',
            name: run?.name ?? ''
          },
          run?.libraryUpdate
        ) as BoardAgentActionMap[A]['result'];
      }
      case 'deployRunState':
        return this.deployRunState() as BoardAgentActionMap[A]['result'];
      case 'deployRunAnswer':
        return this.deployRunAnswer(
          payload as BoardAgentActionMap['deployRunAnswer']['payload']
        ) as BoardAgentActionMap[A]['result'];
      case 'deployRunCancel':
        return this.deployRunCancel() as BoardAgentActionMap[A]['result'];
      case 'deployRunDismiss':
        return this.deployRunDismiss() as BoardAgentActionMap[A]['result'];
      case 'deployApproveSkill':
        return (await this.deployApproveSkill()) as BoardAgentActionMap[A]['result'];
      case 'secretsAuthState':
        return this.secretsAuthState() as BoardAgentActionMap[A]['result'];
      case 'secretsAuthAnswer':
        return this.secretsAuthAnswer(
          payload as BoardAgentActionMap['secretsAuthAnswer']['payload'],
          ctx
        ) as BoardAgentActionMap[A]['result'];
      case 'secretsLock':
        return (await this.secretsLock(
          ctx
        )) as BoardAgentActionMap[A]['result'];
      case 'dangerousApprovalState':
        return this.dangerousApprovalState(
          ctx
        ) as BoardAgentActionMap[A]['result'];
      case 'dangerousApprovalAnswer':
        return this.dangerousApprovalAnswer(
          payload as BoardAgentActionMap['dangerousApprovalAnswer']['payload'],
          ctx
        ) as BoardAgentActionMap[A]['result'];
      case 'secretsExportBackup':
        return (await this.secretsExportBackup(
          payload as BoardAgentActionMap['secretsExportBackup']['payload'],
          ctx
        )) as BoardAgentActionMap[A]['result'];
      case 'secretsOpenBackup':
        return (await this.secretsOpenBackup(
          payload as BoardAgentActionMap['secretsOpenBackup']['payload'],
          ctx
        )) as BoardAgentActionMap[A]['result'];
      case 'secretsImportBackupPlan':
        return (await this.secretsImportBackupPlan(
          payload as BoardAgentActionMap['secretsImportBackupPlan']['payload'],
          ctx
        )) as BoardAgentActionMap[A]['result'];
      case 'secretsImportBackupApply':
        return (await this.secretsImportBackupApply(
          payload as BoardAgentActionMap['secretsImportBackupApply']['payload'],
          ctx
        )) as BoardAgentActionMap[A]['result'];
      case 'secretsChangePassword':
        return (await this.secretsChangePassword(
          payload as BoardAgentActionMap['secretsChangePassword']['payload'],
          ctx
        )) as BoardAgentActionMap[A]['result'];
      case 'jobsList':
        return (await this.jobsList()) as BoardAgentActionMap[A]['result'];
      case 'attention':
        return (await this.attention()) as BoardAgentActionMap[A]['result'];
      case 'serviceStatus':
        return (await this.serviceStatus()) as BoardAgentActionMap[A]['result'];
      case 'serviceInstall':
        return (await this.serviceInstall()) as BoardAgentActionMap[A]['result'];
      case 'serviceRemove':
        return (await this.serviceRemove()) as BoardAgentActionMap[A]['result'];
      case 'partsList':
        return (await this.partsList()) as BoardAgentActionMap[A]['result'];
      case 'partsAct':
        return (await this.partsAct(
          payload
        )) as BoardAgentActionMap[A]['result'];
      case 'machineCleanup':
        return (await this.machineCleanup(
          payload
        )) as BoardAgentActionMap[A]['result'];
      case 'jobsCall':
        return (await this.jobsCall(
          payload as BoardAgentActionMap['jobsCall']['payload'],
          ctx
        )) as BoardAgentActionMap[A]['result'];
      case 'jobCancel':
        return (await this.jobCancel(
          payload as BoardAgentActionMap['jobCancel']['payload'],
          ctx
        )) as BoardAgentActionMap[A]['result'];
      case 'jobsActive':
        return this.jobsActive(ctx) as BoardAgentActionMap[A]['result'];
      case 'jobStatus':
        return this.jobStatus(
          payload as BoardAgentActionMap['jobStatus']['payload'],
          ctx
        ) as BoardAgentActionMap[A]['result'];
      case 'auditRead':
        return (await this.auditRead(
          payload as BoardAgentActionMap['auditRead']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'auditClear':
        return (await this.auditClear(ctx)) as BoardAgentActionMap[A]['result'];
      case 'secretsInboxList':
        return (await this.secretsInboxList()) as BoardAgentActionMap[A]['result'];
      case 'secretsInboxAnswer':
        return (await this.secretsInboxAnswer(
          payload as BoardAgentActionMap['secretsInboxAnswer']['payload'],
          ctx
        )) as BoardAgentActionMap[A]['result'];
      case 'deploySecretsStatus':
        return (await this.deploySecretsStatus()) as BoardAgentActionMap[A]['result'];
      case 'deploySecretsInit':
        return (await this.deploySecretsInit(
          payload as BoardAgentActionMap['deploySecretsInit']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'deploySecretsList':
        return (await this.deploySecretsList(
          payload as BoardAgentActionMap['deploySecretsList']['payload'],
          ctx
        )) as BoardAgentActionMap[A]['result'];
      case 'deploySecretsSet':
        return (await this.deploySecretsSet(
          payload as BoardAgentActionMap['deploySecretsSet']['payload'],
          ctx
        )) as BoardAgentActionMap[A]['result'];
      case 'deploySecretsSetMeta':
        return (await this.deploySecretsSetMeta(
          payload as BoardAgentActionMap['deploySecretsSetMeta']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'deploySecretsSetFile':
        return (await this.deploySecretsSetFile(
          payload as BoardAgentActionMap['deploySecretsSetFile']['payload'],
          ctx
        )) as BoardAgentActionMap[A]['result'];
      case 'deploySecretsUnsetFile':
        return (await this.deploySecretsUnsetFile(
          payload as BoardAgentActionMap['deploySecretsUnsetFile']['payload'],
          ctx
        )) as BoardAgentActionMap[A]['result'];
      case 'secretFileEnvKeys':
        return (await this.secretFileEnvKeys(
          payload as BoardAgentActionMap['secretFileEnvKeys']['payload'],
          ctx
        )) as BoardAgentActionMap[A]['result'];
      case 'secretFileEnvSet':
        return (await this.secretFileEnvSet(
          payload as BoardAgentActionMap['secretFileEnvSet']['payload'],
          ctx
        )) as BoardAgentActionMap[A]['result'];
      case 'secretFileEnvUnset':
        return (await this.secretFileEnvUnset(
          payload as BoardAgentActionMap['secretFileEnvUnset']['payload'],
          ctx
        )) as BoardAgentActionMap[A]['result'];
      case 'deploySecretsUnset':
        return (await this.deploySecretsUnset(
          payload as BoardAgentActionMap['deploySecretsUnset']['payload'],
          ctx
        )) as BoardAgentActionMap[A]['result'];
      case 'deployDiscardSkill':
        return (await this.deployDiscardSkill()) as BoardAgentActionMap[A]['result'];
      case 'githubStartDeviceCode':
        return (await this.githubStartDeviceCode(
          payload as BoardAgentActionMap['githubStartDeviceCode']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'githubDisconnect':
        return (await this.githubDisconnect()) as BoardAgentActionMap[A]['result'];
      case 'githubIdentity':
        return (await this.githubIdentity()) as BoardAgentActionMap[A]['result'];
      case 'githubListRepos':
        return (await this.githubListRepos()) as BoardAgentActionMap[A]['result'];
      case 'githubListBranches':
        return (await this.githubListBranches(
          payload as BoardAgentActionMap['githubListBranches']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'claudeLoginStart':
        return (await this.claudeLoginStart()) as BoardAgentActionMap[A]['result'];
      case 'claudeLoginCode':
        return this.claudeLoginCode(
          payload as BoardAgentActionMap['claudeLoginCode']['payload']
        ) as BoardAgentActionMap[A]['result'];
      case 'claudeLoginCancel':
        return (await this.claudeLoginCancel()) as BoardAgentActionMap[A]['result'];
      case 'claudeLogout':
        return (await this.claudeLogout()) as BoardAgentActionMap[A]['result'];
      case 'codexLoginStart':
        return (await this.codexLoginStart()) as BoardAgentActionMap[A]['result'];
      case 'codexLoginCancel':
        return (await this.codexLoginCancel()) as BoardAgentActionMap[A]['result'];
      case 'codexLogout':
        return (await this.codexLogout()) as BoardAgentActionMap[A]['result'];
      case 'activityDismiss':
        return (await this.activityDismiss(
          payload as BoardAgentActionMap['activityDismiss']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'cardFinalize':
        return (await this.cardFinalize(
          payload as BoardAgentActionMap['cardFinalize']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'cardAnswerQuestion':
        this.cardAnswerQuestion(payload as { postId: string; answer: string });
        return undefined as BoardAgentActionMap[A]['result'];
      case 'cardFeedback':
        this.cardFeedback(payload as { postId: string; feedback: string });
        return undefined as BoardAgentActionMap[A]['result'];
      case 'cardKill':
        await this.cardKill(payload as { postId: string });
        return undefined as BoardAgentActionMap[A]['result'];
      case 'cardHandoff':
        await this.cardHandoff(payload as { postId: string });
        return undefined as BoardAgentActionMap[A]['result'];
      case 'boardHandoff':
        return (await this.boardHandoff(
          payload as BoardAgentActionMap['boardHandoff']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'bareFsList':
        return (await this.bareFsList(
          payload as BoardAgentActionMap['bareFsList']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'bareFsSearch':
        return (await this.bareFsSearch(
          payload as BoardAgentActionMap['bareFsSearch']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'bareFsRead':
        return (await this.bareFsRead(
          payload as BoardAgentActionMap['bareFsRead']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'bareFsWrite':
        await this.bareFsWrite(
          payload as BoardAgentActionMap['bareFsWrite']['payload']
        );
        return undefined as BoardAgentActionMap[A]['result'];
      case 'terminalDropImage':
        return (await this.terminalDropImage(
          payload as BoardAgentActionMap['terminalDropImage']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'terminalDropFile':
        return (await this.terminalDropFile(
          payload as BoardAgentActionMap['terminalDropFile']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'bareFsUpload':
        await this.bareFsUpload(
          payload as BoardAgentActionMap['bareFsUpload']['payload']
        );
        return undefined as BoardAgentActionMap[A]['result'];
      case 'bareFsDelete':
        await this.bareFsDelete(
          payload as BoardAgentActionMap['bareFsDelete']['payload']
        );
        return undefined as BoardAgentActionMap[A]['result'];
      case 'bareFsMkdir':
        await this.bareFsMkdir(
          payload as BoardAgentActionMap['bareFsMkdir']['payload']
        );
        return undefined as BoardAgentActionMap[A]['result'];
      case 'bareReview':
        return (await this.bareReview(
          payload as BoardAgentActionMap['bareReview']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'bareGitStatus':
        return (await this.bareGitStatus(
          payload as BoardAgentActionMap['bareGitStatus']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'bareGitCommitDiff':
        return (await this.bareGitCommitDiff(
          payload as BoardAgentActionMap['bareGitCommitDiff']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'bareGitCompare':
        return (await this.bareGitCompare(
          payload as BoardAgentActionMap['bareGitCompare']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'bareGitBlob':
        return (await this.bareGitBlob(
          payload as BoardAgentActionMap['bareGitBlob']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'bareGitStage':
        return (await this.bareGitStage(
          payload as BoardAgentActionMap['bareGitStage']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'bareGitUnstage':
        return (await this.bareGitUnstage(
          payload as BoardAgentActionMap['bareGitUnstage']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'bareGitFileDiff':
        return (await this.bareGitFileDiff(
          payload as BoardAgentActionMap['bareGitFileDiff']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'bareGitAct':
        return (await this.bareGitAct(
          payload as BoardAgentActionMap['bareGitAct']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'bareListProcesses':
        return (await this.bareListProcesses(
          payload as BoardAgentActionMap['bareListProcesses']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'bareKillProcess':
        await this.bareKillProcess(
          payload as BoardAgentActionMap['bareKillProcess']['payload']
        );
        return undefined as BoardAgentActionMap[A]['result'];
      case 'bareListTerminals':
        return (await this.bareListTerminals(
          payload as BoardAgentActionMap['bareListTerminals']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'bareTerminalHealth':
        return (await this.bareTerminalHealth(
          payload as BoardAgentActionMap['bareTerminalHealth']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'bareChatTranscript':
        return (await this.bareChatTranscript(
          payload as BoardAgentActionMap['bareChatTranscript']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'bareChatSend':
        this.bareChatSend(
          payload as BoardAgentActionMap['bareChatSend']['payload']
        );
        return undefined as BoardAgentActionMap[A]['result'];
      case 'bareChatToTerminal':
        return (await this.bareChatToTerminal(
          payload as BoardAgentActionMap['bareChatToTerminal']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'bareChatConversations':
        return (await this.bareChatConversations(
          payload as BoardAgentActionMap['bareChatConversations']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'bareChatResume':
        return (await this.bareChatResume(
          payload as BoardAgentActionMap['bareChatResume']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'bareChatCommand':
        return (await this.bareChatCommand(
          payload as BoardAgentActionMap['bareChatCommand']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'bareLinkCard':
        this.bareLinkCard(
          payload as BoardAgentActionMap['bareLinkCard']['payload']
        );
        return undefined as BoardAgentActionMap[A]['result'];
      case 'bareChatInterrupt':
        await this.bareChatInterrupt(
          payload as BoardAgentActionMap['bareChatInterrupt']['payload']
        );
        return undefined as BoardAgentActionMap[A]['result'];
      case 'bareAckTerminalDigest':
        await this.bareAckTerminalDigest();
        return undefined as BoardAgentActionMap[A]['result'];
      case 'bareRestartStaleTerminals':
        return (await this.bareRestartStaleTerminals(
          payload as BoardAgentActionMap['bareRestartStaleTerminals']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'bareEditorState':
        return this.bareEditorState(
          payload as BoardAgentActionMap['bareEditorState']['payload']
        ) as BoardAgentActionMap[A]['result'];
      case 'bareOpenFile':
        this.bareOpenFile(
          payload as BoardAgentActionMap['bareOpenFile']['payload']
        );
        return undefined as BoardAgentActionMap[A]['result'];
      case 'bareCloseFile':
        this.bareCloseFile(
          payload as BoardAgentActionMap['bareCloseFile']['payload']
        );
        return undefined as BoardAgentActionMap[A]['result'];
      case 'bareBufferSet':
        this.bareBufferSet(
          payload as BoardAgentActionMap['bareBufferSet']['payload']
        );
        return undefined as BoardAgentActionMap[A]['result'];
      case 'bareExpose':
        return (await this.bareExpose(
          payload as BoardAgentActionMap['bareExpose']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'bareUnexpose':
        await this.bareUnexpose(
          payload as BoardAgentActionMap['bareUnexpose']['payload']
        );
        return undefined as BoardAgentActionMap[A]['result'];
      case 'bareListExposed':
        return (await this.bareListExposed(
          payload as BoardAgentActionMap['bareListExposed']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'scratchpadList':
        return (await this.scratchpadList()) as BoardAgentActionMap[A]['result'];
      case 'scratchpadRead':
        return (await this.scratchpadRead(
          payload as BoardAgentActionMap['scratchpadRead']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'scratchpadReadChunk':
        return (await this.scratchpadReadChunk(
          payload as BoardAgentActionMap['scratchpadReadChunk']['payload']
        )) as BoardAgentActionMap[A]['result'];
      case 'scratchpadDelete':
        await this.scratchpadDelete(
          payload as BoardAgentActionMap['scratchpadDelete']['payload']
        );
        return undefined as BoardAgentActionMap[A]['result'];
      case 'scratchpadClear':
        await this.scratchpadClear();
        return undefined as BoardAgentActionMap[A]['result'];
      case 'simulatorList':
        return (await this.simulatorList()) as BoardAgentActionMap[A]['result'];
      case 'simulatorStatus':
        return (await this.simulatorStatus()) as BoardAgentActionMap[A]['result'];
      case 'simulatorAttach':
        await this.simulatorAttach(
          payload as BoardAgentActionMap['simulatorAttach']['payload']
        );
        return undefined as BoardAgentActionMap[A]['result'];
      case 'simulatorDetach':
        this.simulatorDetach();
        return undefined as BoardAgentActionMap[A]['result'];
      case 'simulatorInput':
        await this.simulatorInput(
          payload as BoardAgentActionMap['simulatorInput']['payload']
        );
        return undefined as BoardAgentActionMap[A]['result'];
      case 'secureStatus':
        return this.secureStatus() as BoardAgentActionMap[A]['result'];
      case 'runnerConnections':
      case 'runnerLogs':
        // Runner-wide, answered by the installed runner's daemon before any
        // engine (apps/runner runnerConnections.ts).
        throw new Error(
          'Only an installed runner (factiii-runner) can show its connections.'
        );
      case 'runnerNuke':
        // The installed runner's daemon answers a nuke before any engine
        // (apps/runner daemonNuke.ts). An engine that hears it is the desktop
        // app's own, which has no runner home to erase.
        throw new Error(
          'Only an installed runner (factiii-runner) can be nuked.'
        );
      default:
        throw new Error(`Unknown board-agent action: ${String(action)}`);
    }
  }
}
