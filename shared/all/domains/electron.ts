// Type-only edges out of this file. `secret-descriptions.ts` owns what
// a stored secret's description IS (and the rule for resolving one), and it
// imports nothing itself - so naming it here adds no runtime dependency and no
// cycle, where redefining the shape would let the wire and the resolver drift.
import type { SecretMeta } from '../helpers/board-agent-core/secret-descriptions';
import type {
  LocalAiMachine,
  LocalAiModelFit,
  LocalAiModelId
} from '../helpers/localAiModels';
import type { RunnerChatCommand } from '../helpers/terminal-ai/chatCommands';
import type { ChatConversations } from '../helpers/terminal-ai/chatHistory';
import type {
  ChatHold,
  ChatTerminalState
} from '../helpers/terminal-ai/chatRun';
import type { ChatTranscript } from '../helpers/terminal-ai/chatTranscript';
import type {
  AiPromptPayload,
  CliAskSettings
} from '../validators/oakboxBackend';
import type { BareGitOp } from '../validators/runnerGit';
import type {
  LocalAiActPayload,
  LocalAiSearchPayload,
  MachineCleanupPayload,
  RunnerModuleAction,
  RunnerModuleId,
  RunnerNukePayload,
  RunnerPartAction,
  RunnerPartId,
  RunnerPartsActPayload
} from '../validators/runnerParts';
import type {
  RunnerCategorizePayload,
  RunnerCategoryTree
} from '../validators/runnerVault';

export type {
  LocalAiActPayload,
  LocalAiSearchPayload,
  MachineCleanupPayload,
  RunnerCategorizePayload,
  RunnerModuleAction,
  RunnerModuleId,
  RunnerNukePayload,
  RunnerPartAction,
  RunnerPartId,
  RunnerPartsActPayload
};

// ── Board sync broadcast payload ──
// Multi-device sync: clients broadcast one of these after a mutation, and every
// other client connected to the same runner invalidates its query caches.
export type BoardUpdatePayload =
  | { scope: 'factiiis' }
  | { scope: 'posts'; factiiiId: number }
  | { scope: 'all' };

// ── Session types (shared with renderer) ──

/** CLI agent a space runs for AI work (ask, cards, deploy, one-shots).
 *  Per-space config: the runner's default board seeds it, boards override. */
export type AgentProvider = 'claude' | 'codex';

/** 'claude' here means the AI pipeline mode (runs the space's configured
 *  provider), as opposed to the user-driven 'bare' terminal mode. */
export type CardAIMode = 'claude' | 'bare';

/** What a CLI is doing, as the factiii plugin's hooks report it: `working` on
 *  UserPromptSubmit, `idle` on Stop, `blocked` on a permission request. */
export type AgentState = 'working' | 'idle' | 'blocked';

export type CardAISessionPhase =
  | 'starting'
  | 'research'
  | 'awaiting-input'
  | 'implement'
  | 'review'
  | 'complete'
  | 'error'
  | 'done'
  | 'bare-active'
  | 'bare-review';

export type CardAITodo = {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
};

// ── Agent skills (SKILL.md) ──

/** State of the one symlink Claude Code needs: `.claude/skills` must point at
 *  `.agents/skills`. `blocked` means a real directory sits there, so the skills
 *  inside it must move before a link can replace it. */
export type SkillLinkState = 'linked' | 'missing' | 'blocked';

/** `global` = the runner host's own home dir, shared by every space it drives.
 *  `repo` = committed to the space's repo, changeable only through a merge. */
export type SkillScope = 'global' | 'repo';

/** A repo skill's state relative to the default branch. Global skills are
 *  always `live`: writing one applies it immediately. */
export type SkillStatus =
  | 'live' // on the default branch: what the agents actually load
  | 'pending-new' // exists only on an unmerged skill/* branch
  | 'pending-edit'; // on both, and they differ

export type SkillSummary = {
  name: string;
  scope: SkillScope;
  description: string;
  /** Absolute for global skills, repo-relative for repo skills. */
  dir: string;
  status: SkillStatus;
  /** The unmerged branch carrying it, when status is not `live`. */
  pendingBranch: string;
  /** Frontmatter problems. The skill still opens so it can be fixed. */
  errors: string[];
  /** The jobs it calls and the names it may hand off to (skillMentions,
   *  helpers/skillConnections.ts). Older runners omit it. */
  uses?: { jobs: string[]; skills: string[] };
  /** The library skill it was added from and the version it records
   *  (librarySkill.ts libraryOriginOf). Absent when it was not added from the
   *  library, and from runners older than library versions. */
  origin?: { uuid: string; version: string };
  /** A repo skill kept in `.agents/skills-on-request`: the CLIs never list it,
   *  so an AI reads it only when told to (card 39b89977). Run from the Skills
   *  tab, it is read from that folder instead of invoked by name. Absent on
   *  every other skill, and from older runners. */
  onRequest?: boolean;
};

export type CardAILogEntry = {
  time: number;
  type: 'system' | 'text' | 'tool' | 'error' | 'text-append' | 'thinking';
  content: string;
  /** On a Board AI log line: the conversation it streams into. Several can
   *  answer at once on the one board log channel. Absent from a runner older
   *  than conversations, and from every other log. */
  conversationId?: string;
};

/** A session's worktree, counted against the branch it was cut from. Cheap
 *  enough to keep on every summary: counts only, never a diff. */
export type SessionGitSummary = {
  /** Commits on HEAD that the base does not have. */
  ahead: number;
  /** Commits on the base since the work branched off. */
  behind: number;
  /** Lines added and removed since the merge base, uncommitted edits
   *  included. Untracked files are not counted until git knows them. */
  added: number;
  removed: number;
  /** Paths with uncommitted changes, untracked included. */
  dirty: number;
  /** Commits no remote has. */
  unpushed: number;
};

export type CardAISessionSummary = {
  taskId: string;
  postId: string;
  phase: CardAISessionPhase | null;
  mode: CardAIMode;
  step: 1 | 2 | 3;
  diff: string;
  changedFiles: string[];
  commitMessage: string;
  previewUrl: string;
  previewRunning: boolean;
  reproSteps: string;
  pendingQuestion: string;
  error: string;
  startedAt: number;
  /** Absent when the plugin is not installed or has not fired yet, in which
   *  case the dot falls back to "alive". */
  agentState?: AgentState;
  /** An agent CLI is running in one of this session's terminal tabs now (its
   *  hooks have reported and it has not ended). Absent from an older runner
   *  and for anything that is not a terminal. */
  agentLive?: boolean;
  /** The chat's own headless Claude has the conversation (chatRun.ts): a turn
   *  is running ('turn'), or Claude is being opened in a tab after it
   *  ('opening'). '' once Claude is in a tab, or idle. The terminal shows a
   *  plain shell meanwhile and says why. Absent from an older runner and for
   *  anything that is not a terminal. */
  chatHold?: ChatHold;
  /** The CLI the chat runs for this terminal session: its own, Claude Code
   *  or Codex (chatRun.ts, chatCli.ts). Absent from a runner whose chat ran
   *  Claude only (there a Codex session's chat is the map and the commands),
   *  and for anything that is not a terminal. */
  chatCli?: AgentProvider;
  /** The public links this terminal opened (`factiii-expose`), so the sessions
   *  list can show each beside the terminal that made it. Absent from a runner
   *  too old to report them, and for anything that is not a terminal. */
  exposed?: ExposedPort[];
  /** One line of what the CLI is doing, from the factiii plugin's hooks: the
   *  tool it is about to run, or the first line of its last reply. Absent
   *  until a hook fires, and from a runner too old to report it. */
  agentActivity?: string;
  /** How far the work in this terminal's worktree has got. Absent until the
   *  first read, for a session with no worktree, and from an older runner. */
  git?: SessionGitSummary;
  /** A terminal's kind: `code` works in its own worktree and branch, `chat`
   *  in the board's workspace. Absent for card AI runs and from an older
   *  runner. */
  kind?: 'chat' | 'code';
  /** A Code session's worktree folder, which names its branch
   *  (`terminal/<name>`). Absent for Chat and from an older runner. */
  worktree?: string;
  targetBranch: string;
  taskTitle: string;
  todos: CardAITodo[];
  /**
   * The provider CLI's own conversation id (claude session UUID / codex
   * thread id), threaded across the research→implement→review spawns. Each
   * spawn is headless `-p` print mode and exits, so there's no live process
   * to attach to — but this id resumes the thread interactively from a shell
   * in the same workspace and cwd. Empty until the first spawn reports one.
   */
  agentSessionId: string;
  /** The CLI that ran this session (per-job; may differ from the space
   *  default). A terminal must resume with THIS provider, not config's. */
  provider: AgentProvider;
  /** The card a terminal session is linked to, by its postId: set and
   *  cleared at any time, from the app or by an agent through the board MCP
   *  (link_card / unlink_card). Absent: the session's own card when it was
   *  started on one, else none. '' : unlinked on purpose. */
  cardId?: string;
  /** Where a terminal session's agent is working now: the project (git top)
   *  of the folder it last worked in, which the IDE follows. Absent until
   *  the runner has seen it work. */
  workPath?: string;
  /** `workPath` is a git checkout: the IDE shows Source Control for it. */
  workPathGit?: boolean;
  /** Who started it, as the server vouched for the link it was started on.
   *  Sent to the runner's owner only (runnerConnections); absent elsewhere and
   *  from an older runner. */
  startedBy?: RunnerPerson;
};

export type CardAISessionFull = CardAISessionSummary & {
  logs: CardAILogEntry[];
};

// ── Runner activity (everything the runner does that ISN'T a card session) ──

/**
 * Long-running space-level work: Ask Board, deploys, setup, sign-ins.
 * Sessions are card-keyed and open a terminal; these are not, and each belongs
 * to its own modal — so they ride their own channel rather than being bent
 * into `CardAISessionSummary`.
 */
export type RunnerActivityKind =
  | 'ask'
  | 'deploy-run'
  | 'deploy-skill'
  | 'deploy-env'
  | 'setup'
  | 'secrets-auth'
  /** A member's call of a dangerous job waiting on the runner owner's yes
   *  (owner-approval.ts). One row per request, keyed by its id. */
  | 'dangerous-approval'
  | 'signin';

/** One command waiting on the owner's store password, as the global
 *  authorization modal renders it. No secret value ever appears here: a
 *  command string, the key NAMES it will receive, and which session asked. */
export type PendingSecretsAuth = {
  /** Identifies this prompt across the wire, so a stale client cannot answer
   *  a request that has already been replaced by the next one. */
  id: string;
  command: string;
  /** The keys this command will receive, and nothing else in the store. */
  keys: string[];
  /** Which session asked - "Deploy run", "Terminal · <card>". Never blank:
   *  an unattributed request is refused before it ever becomes a prompt. */
  origin: string;
  /** A previous attempt's failure (wrong password), shown on the re-prompt. */
  error: string;
  requestedAt: number;
  /** Who asked, server-vouched (a job call or an inbox write on a shared
   *  runner). Absent for a free command from the owner's own session. */
  caller?: { userId: string; name: string };
  /** The job this spawn belongs to. Only a job may be covered by an unlock
   *  window, so the prompt offers a duration only when this is set. */
  job?: string;
  /** Set when approving writes a secret from the inbox rather than running a
   *  command: which key, env value or file blob, and whether it replaces one. */
  inbox?: { id: string; key: string; kind: 'env' | 'file'; replaces: boolean };
};

/** One member's call of a dangerous job that
 *  waits for the runner owner to approve it, because the owner has not given
 *  that member the Dangerous jobs permission. Everything the owner needs to
 *  decide, in full: the one command line that will run, with every param
 *  filled in. A param is a validated, caller-chosen string, never a secret,
 *  so it may be shown whole (an SQL statement, say). */
export type PendingDangerousApproval = {
  /** Identifies this request across the wire. */
  id: string;
  job: string;
  /** The job's `command` from jobs.json with each param filled in and
   *  quoted, plus any param the command reads only from its env as a leading
   *  `JOB_PARAM_X='…'` (jobs.ts filledCommand). Never cut. */
  command: string;
  /** Who asked, server-vouched. */
  caller: { userId: string; name: string };
  /** The board the call runs on. */
  spaceSlug: string;
  requestedAt: number;
  /** When it ends as denied if nobody answers (epoch ms). */
  expiresAt: number;
};

/** Who opened the current unlock window and until when (ISO). */
export type SecretsUnlockWindow = {
  until: string;
  byUserId: string;
  byName: string;
};

/** One line of the runner's append-only audit log
 *  (`~/.factiii-runner/<space>/audit.jsonl`). Names only - never a value, the
 *  password, or a decrypted file path. `prev` is the sha256 of the line before
 *  it, so an edited or deleted line breaks the chain. */
export type AuditEntry = {
  ts: string;
  actor: { userId: string; name: string };
  /** `mcp`: an agent did it through the board MCP's session tools
   *  (session-hypervisor.ts), for `actor`; `detail` names the session. */
  via: 'api' | 'data-channel' | 'owner-terminal' | 'mcp';
  action:
    | 'job'
    | 'job-end'
    | 'job-cancel'
    /** A free `factiii-secrets run` from a session on the runner. */
    | 'run'
    | 'unlock'
    | 'lock'
    | 'secret-set'
    | 'secret-unset'
    | 'password-rotate'
    /** The owner took an offline backup of the board's secrets folder. */
    | 'backup-export'
    /** The owner read a backup file's secrets in the app. `keys` names them. */
    | 'backup-open'
    /** The owner imported secrets from a backup file into this board. `keys`
     *  names what was written. */
    | 'backup-import'
    | 'shared-change'
    /** A wrong runner password, or one refused while the guess limit's
     *  backoff runs (password-throttle.ts). `actor` is who typed it. */
    | 'auth-failed'
    | 'denied'
    /** The runner owner approved one member's call of a dangerous job, or
     *  denied it (or nobody answered in time: `detail` says which). `command`
     *  is the filled command line the owner saw, params and all
     *  (jobs.ts filledCommand); `detail` names the caller. */
    | 'dangerous-approve'
    | 'dangerous-deny'
    /** The owner cleared the log: the first line of a new chain. The old
     *  file is kept beside it on the runner; `detail` says how many entries
     *  it held and its name. */
    | 'audit-clear'
    /** An agent started, messaged or ended a session through the board
     *  MCP (session-hypervisor.ts). `via` is `mcp`; `detail` names the
     *  session acted on and the session that asked. */
    | 'session-start'
    | 'session-message'
    | 'session-end';
  job: string | null;
  /** Key names (and file-blob names) only. */
  keys: string[];
  /** The resolved command from the job definition, never its output. */
  command: string | null;
  exitCode: number | null;
  durationMs: number | null;
  /** Who opened the window this ran in, when it ran inside one. */
  unlockedBy: string | null;
  /** Free-form, value-free context (e.g. "inbox", "shared=true"). */
  detail?: string;
  prev: string;
};

/** One key inside an env file secret, as the app may see it. */
export type SecretFileEnvKey = {
  name: string;
  /** Never the value: its last four characters, or only dots for a short
   *  one (`maskedSecret`). */
  masked: string;
  /** False for a value with line breaks (a private key): the app does not
   *  change or remove it, the whole file is replaced. */
  editable: boolean;
};

export type RunnerJobInfo = {
  name: string;
  description: string;
  keys: string[];
  files: string[];
  /** Param name -> the regex its value must match. */
  params: Record<string, string>;
  /** The owner wants to see each call (jobs.json marks it): a member without
   *  the owner's Dangerous jobs permission waits for the runner owner to
   *  approve each call (owner-approval.ts). Absent from an older runner,
   *  which does not gate on it. */
  dangerous?: boolean;
};

/** The runner's answer to `attention`. Names and booleans only. */
export type RunnerAttention = {
  /** Keys the deploy contract or a job needs that the store does not hold.
   *  Null when the runner cannot tell (no repository, or no clone yet). */
  missingSecrets: string[] | null;
  /** Jobs that would fail for a missing key or file. */
  blockedJobs: string[];
  jobsCount: number;
  /** No unlock window is open. Locked is the store's resting state. */
  secretsLocked: boolean;
  repoConnected: boolean;
};

/** The runner's own always-on service (`factiii-runner service`), as Runner
 *  Settings > Setup shows it. Names and booleans, no path. */
export type RunnerServiceState = {
  /** False where this runner cannot install a service: `reason` says why. */
  supported: boolean;
  reason?: string;
  /** The launchd label, systemd unit or task name. */
  name: string;
  /** `foreign`: a file of that name that the runner did not write. */
  installed: 'yes' | 'no' | 'foreign';
  /** Known to the service manager, so it starts at the next login. */
  loaded: boolean;
  /** The service is what runs this runner now. Removing it from the app then
   *  leaves this runner running until the next restart. */
  thisRunner: boolean;
};

/** What `serviceInstall` / `serviceRemove` did, and the state after it. */
export type RunnerServiceOutcome = {
  ok: boolean;
  lines: string[];
  state: RunnerServiceState;
};

/** A part action the runner is doing, or did last, in the background. */
export type RunnerPartJob = {
  action: RunnerPartAction;
  state: 'running' | 'done' | 'failed';
  /** The newest lines of its output, oldest first. */
  lines: string[];
  startedAt: number;
};

/** One installable part of the runner (`factiii-runner parts`), as
 *  the runner's Status > Features shows it. Names, numbers and command lines; no
 *  path, port or key. */
export type RunnerPart = {
  id: RunnerPartId;
  title: string;
  description: string;
  /** Every requirement is met on this machine. Detected, not stored. */
  installed: boolean;
  /** Null for a part with nothing to run. */
  running: boolean | null;
  /** Titles of the requirements that are not met. */
  missing: string[];
  /** What only a person can do for a missing requirement: a command that
   *  needs an administrator, or a settings pane. */
  manual: string[];
  /** Estimates, in MB: on disk once installed, and in memory while used. */
  diskMb: number;
  memoryMb: number;
  /** Measured now, for a part whose process is running. */
  memoryNowMb: number | null;
  /** The connector: always there, never removed. */
  core: boolean;
  actions: RunnerPartAction[];
  job: RunnerPartJob | null;
};

/** A whole module's add or remove: its sub-parts one at a time, in order. */
export type RunnerModuleJob = {
  action: RunnerModuleAction;
  state: 'running' | 'done' | 'failed';
  /** The sub-part being worked on, or the one that failed. Its own `job`
   *  carries the lines. */
  partId: RunnerPartId | null;
  startedAt: number;
};

/** A group of parts installed together or one by one (Bare, Coding, Private
 *  vault for Oakbox, Local AI). Defined once in the runner (parts.ts). */
export type RunnerPartsModule = {
  id: RunnerModuleId;
  title: string;
  description: string;
  /** Bare: the connector, never removed. */
  core: boolean;
  /** Its sub-parts on this machine, in install order. */
  parts: RunnerPart[];
  actions: RunnerModuleAction[];
  job: RunnerModuleJob | null;
};

export type RunnerPartsState = {
  /** False where parts cannot be managed (the desktop app). */
  supported: boolean;
  reason?: string;
  /** The flat list, for apps from before modules: only the part ids those
   *  apps know (the Vault as one part). */
  parts: RunnerPart[];
  /** Absent from a runner from before modules: the app then shows `parts`. */
  modules?: RunnerPartsModule[];
  /** The Local AI module's model: the machine, the pick and why. Absent
   *  from an older runner and where Local AI is not offered. */
  localAi?: RunnerLocalAi;
  /** Free disk and memory pressure. Absent from an older runner. */
  health?: RunnerMachineHealth;
};

/** `warn` comes before `critical`: at critical, adds, model pulls and vault
 *  uploads are refused. */
export type RunnerHealthLevel = 'ok' | 'warn' | 'critical';

/** One disk the runner writes to. Names what it holds, never a path. */
export type RunnerDiskHealth = {
  /** "Runner folder", "Vault", "Ollama models": the ones on this disk. */
  uses: string[];
  freeGb: number;
  totalGb: number;
  level: RunnerHealthLevel;
};

/** The machine's free disk and memory pressure, read on every list. */
export type RunnerMachineHealth = {
  /** The worst of the disks and the memory. */
  level: RunnerHealthLevel;
  disks: RunnerDiskHealth[];
  /** Null where the runner cannot read the pressure. */
  memory: RunnerHealthLevel | null;
  /** Processes the runner's OS user has against the OS's per-user limit.
   *  At the limit nothing new starts: no SSH, no login, no job, no update.
   *  Absent from a runner older than this field; null where it cannot read
   *  the limit. */
  processes?: RunnerProcessHealth | null;
  /** CPU load. Absent from an older runner; null where it cannot read it. */
  cpu?: RunnerCpuHealth | null;
  /** Memory in use, for the Status tab's reading beside the pressure
   *  level. Absent from an older runner; null where it cannot read it. */
  memoryUse?: RunnerMemoryUse | null;
  /** What is running on the machine for every board: Docker containers,
   *  pm2 processes, login agents and servers listening on a port. Absent
   *  from an older runner. */
  services?: RunnerService[];
  /** Whether this machine is ready to be an always-on server, and its
   *  keep-awake. Absent from an older runner; null off macOS. */
  server?: RunnerServerReadiness | null;
  /** The disk levels, in GB free: below `warnGb` warns, below
   *  `criticalGb` refuses. */
  warnGb: number;
  criticalGb: number;
};

/** What a runner tells the server about its machine for alerts (card
 *  b78a269a, .specs/runner-setup.md "Low disk and memory alerts"): the
 *  overall level and what drives it. No path, no service list. Sent on
 *  connect and whenever it changes; the server shows its owner a banner at
 *  warn and pushes them at critical. */
export type RunnerHealthAlert = {
  /** The worst of the disk, memory and process levels. */
  level: RunnerHealthLevel;
  /** The disk with the least free, of those the runner writes to. Null
   *  where none could be read. */
  disk: { freeGb: number; level: RunnerHealthLevel } | null;
  /** Memory pressure. Null where the runner cannot read it. */
  memory: RunnerHealthLevel | null;
  /** The per-user process limit, as a level. Null where it is not read. */
  processes: RunnerHealthLevel | null;
};

/** One thing an always-on Mac needs. `ok` null: the runner cannot tell. */
export type RunnerReadinessCheck = {
  id:
    | 'login'
    | 'filevault'
    | 'sleep'
    | 'autorestart'
    | 'womp'
    | 'screenlock'
    // The desktop view's two macOS grants. Only an older runner, from before
    // the desktop view was removed (2026-10-25), still sends these.
    | 'screen-recording'
    | 'accessibility'
    | 'screensharing'
    | 'tailscale';
  ok: boolean | null;
  /** What the machine says now ("logs in as jon", "sleep 10"). */
  detail: string;
};

/** Keep-awake, the runner's own `caffeinate`: no sleep while it holds,
 *  lid open. Off by itself at `until`. */
export type RunnerKeepAwake = {
  on: boolean;
  /** When it ends (ms since epoch), or null: until turned off. */
  until: number | null;
  /** The screen stays on too, not only the machine. */
  display: boolean;
  /** Automatic: holds only while terminals or jobs are working, and lets go
   *  a grace period after they stop (`until` is then null). Absent from an
   *  older runner or saved file: a timed or open-ended hold. */
  auto?: boolean;
  /** Automatic only: what the runner saw on its last look. */
  work?: RunnerKeepAwakeWork;
  /** While plugged in: holds only while the Mac is on power and lets go on
   *  battery (`until` is then null). Absent from an older runner. */
  ac?: boolean;
  /** While plugged in only: the power on the runner's last look (`ac` null:
   *  it could not tell), and whether it holds now. */
  plugged?: { ac: boolean | null; holding: boolean };
  /** Lid closed, while Automatic or While plugged in holds on a laptop:
   *  `pmset -a disablesleep` through the grant Factiii Desktop sets up
   *  (lidGrant.ts). Absent when the runner does not follow the lid (an
   *  older runner, a desktop Mac, a timed hold). */
  lid?: RunnerLidHoldState;
};

/** The runner's lid-closed hold: `holding` (disablesleep 1, set by the
 *  runner), `off` (set up, nothing to hold), `needs-setup` (`sudo -n`
 *  refused: no grant), `low-battery` / `hot` (let go by the watchdog),
 *  `by-hand` (already on from Factiii Desktop's Lid closed: left alone),
 *  `failed` (pmset itself failed). */
export type RunnerLidHoldState =
  | 'off'
  | 'holding'
  | 'needs-setup'
  | 'low-battery'
  | 'hot'
  | 'by-hand'
  | 'failed';

/** Automatic keep-awake's last look at the runner's work. */
export type RunnerKeepAwakeWork = {
  /** Card and terminal AI sessions working now. */
  sessions: number;
  /** Jobs, deploys and other runner work running now. */
  jobs: number;
  /** The machine is held awake now. */
  holding: boolean;
  /** Nothing working and still holding: when it lets go (ms since epoch). */
  releaseAt: number | null;
};

/** The desktop app's own reading of its Mac (Status > Ready to be a server,
 *  in the desktop app): the same checks, plus whether the npm runner is
 *  installed, paired and kept running here. */
export type DesktopServerStatus = {
  host: string;
  platform: string;
  laptop: boolean;
  checks: RunnerReadinessCheck[];
  tailscaleIp: string | null;
  screenLocked: boolean | null;
  lidAwake: { on: boolean; until: number | null };
  /** The lid-closed grant (/etc/sudoers.d/factiii-pmset) lets this user
   *  run `pmset -a disablesleep 0|1` without a password. Absent from a
   *  desktop app older than the grant. */
  lidGrant?: boolean;
  runner: {
    installed: boolean;
    version: string | null;
    /** Has a config.json: it has been paired with an account. */
    paired: boolean;
    /** The login service: running, installed but not running, or none. */
    service: 'running' | 'installed' | 'off';
    /** The runner id it was paired as (its config.json), so the app can show
     *  that runner's connections and servers under Local. Null unpaired, and
     *  absent from an older desktop app. */
    runnerId?: number | null;
  };
};

/** What a desktop server-mode action did. */
export type DesktopServerResult = { ok: boolean; message: string };

/** The runner's launchd job as Factiii Desktop last read it
 *  (`launchctl print gui/<uid>/<label>`, desktop helpers/launchd.ts). */
export type DesktopRunnerJob = {
  label: string;
  /** launchd's word for it: `running`, `spawn scheduled`, `not running`. */
  state: string;
  pid: number | null;
  /** How many times launchd has started it since it was loaded. Null when
   *  only `launchctl list` answered, which does not say. */
  runs: number | null;
  /** The last exit code. Null when it never exited or a signal ended it. */
  lastExitCode: number | null;
  /** The signal that last ended it ("Terminated: 15"), if one did. */
  lastSignal: string | null;
};

/** The runner service keeps dying and launchd keeps starting it again. */
export type DesktopRunnerCrashLoop = {
  exitCode: number;
  /** Restarts counted inside the window. */
  restarts: number;
  windowMinutes: number;
  /** When the desktop app first saw it (ms since epoch). */
  since: number;
  /** The service's log file, from `factiii-runner service status`. */
  log: string | null;
};

/** One doctor item that is not met, with its fix as lines to show. */
export type DesktopDoctorItem = {
  id: string;
  title: string;
  feature: string;
  required: boolean;
  detail: string;
  fix: string[];
};

/** What Factiii Desktop watches on its own Mac's runner, on timers
 *  (desktop ipc/runner-monitor.ts): the launchd job, a crash loop, and
 *  `factiii-runner doctor --json` re-run on a schedule. */
export type DesktopRunnerMonitor = {
  /** Null: no runner service is loaded on this Mac. */
  job: DesktopRunnerJob | null;
  crashLoop: DesktopRunnerCrashLoop | null;
  /** Null until doctor has answered once (or the runner is not installed). */
  doctor: {
    checkedAt: number;
    ready: boolean;
    missing: DesktopDoctorItem[];
  } | null;
};

/** Ready to be a server: what is set, what is not, and keep-awake. */
export type RunnerServerReadiness = {
  /** The machine's name, so the desktop app can tell it is on this Mac. */
  host: string;
  /** Has a battery and a lid: lid-closed keep-awake applies. */
  laptop: boolean;
  checks: RunnerReadinessCheck[];
  /** This Mac's Tailscale address, for Screen Sharing over it. */
  tailscaleIp: string | null;
  /** The screen is locked now: Screen Sharing opens on the lock screen. */
  screenLocked: boolean | null;
  keepAwake: RunnerKeepAwake;
  /** Sleep is off for the whole machine, lid closed included (`pmset
   *  disablesleep`, set from the desktop app). `until` from its timer, or
   *  null when nothing will turn it back on. */
  lidAwake: { on: boolean; until: number | null };
  /** The runner can set `pmset -a disablesleep` without a password (the
   *  grant Factiii Desktop sets up): lid-closed follows keep-awake. Absent
   *  from an older runner. */
  lidGrant?: boolean;
};

/** The 1-minute load average against the core count. */
export type RunnerCpuHealth = {
  /** The 1-minute load average divided by the cores, as a share (1 = every
   *  core busy). */
  load: number;
  cores: number;
  level: RunnerHealthLevel;
};

/** Memory in use (what the OS would have to free for a new program), in GB. */
export type RunnerMemoryUse = {
  usedGb: number;
  totalGb: number;
};

/** One thing running on the runner's machine that every board shares. */
export type RunnerService = {
  /** `docker`: a container. `pm2`: a process pm2 keeps up (the embedder, its
   *  tunnel). `launchd`: a login agent of the runner's user, kept up or run
   *  on a schedule (macOS). `port`: any other process of the runner's user
   *  listening on a TCP port (a dev server, Redis, Postgres run outside
   *  Docker). */
  kind: 'docker' | 'port' | 'pm2' | 'launchd';
  /** The container's, pm2 process's or agent's name, or the listening
   *  command ("node", "redis-server"). */
  name: string;
  /** The image and its status ("postgres:16 · Up 3 days"), the pm2 state
   *  ("online · up 8 days · 0 restarts"), the agent's state, or the address
   *  ("127.0.0.1:6379"). */
  detail: string;
  running: boolean;
  /** The TCP ports it serves, lowest first. */
  ports: number[];
  /** What its own health check says, for a service the runner knows how to
   *  ask ("Model loaded · Neural Engine"). Absent when it has none. */
  health?: string;
  /** Something is wrong: crashed, keeps restarting, last run failed, or its
   *  health check fails. Absent when fine, and from an older runner. */
  level?: RunnerHealthLevel;
};

/** The runner user's process count against the OS's per-user cap. */
export type RunnerProcessHealth = {
  used: number;
  max: number;
  level: RunnerHealthLevel;
};

/** One thing Free up space would remove: something the runner made and can
 *  make again. Never a vault file, a secret or a model in use. */
export type RunnerCleanupItem = {
  id: string;
  title: string;
  /** Under the runner folder ("factiii-board/builds/59374f079"), the
   *  Ollama model's name, or where a tool's cache is ("~/.npm/_cacache"). */
  path: string;
  bytes: number;
  /** `cache`: a tool's cache, cleared by that tool's own command (npm, pnpm,
   *  Homebrew, Xcode's build output, the container build cache). Absent: what
   *  the runner made. */
  kind?: 'cache';
  /** A prune: `bytes` is what the cache holds, and only what no project
   *  uses goes, so it frees up to that. */
  upTo?: boolean;
};

/** One of the biggest folders on the machine, for the owner to see. A
 *  reading: Free up space never removes these by their path. */
export type RunnerDiskUse = {
  /** What it is ("Tart virtual machines", "factiii-board: worktrees (one per session)"). */
  label: string;
  /** Where, under the home folder ("~/.tart"). */
  path: string;
  bytes: number;
};

/** A dry run (`ran: false`) or what a confirmed run did, and what is left. */
export type RunnerCleanup = {
  items: RunnerCleanupItem[];
  bytes: number;
  ran: boolean;
  lines: string[];
  /** The biggest folders, answered to a dry run with `usage` (then `items`
   *  is empty). Absent otherwise, and from an older runner. */
  usage?: RunnerDiskUse[];
};

/** One worktree a nuke would erase, with the work in it that no remote has
 *  (git.ts worktreeWorkState). Doubt reads as work. */
type RunnerNukeWorktree = {
  name: string;
  branch: string;
  /** Uncommitted or untracked files, or a hand-made `.env`. */
  dirty: boolean;
  /** Commits no remote has. */
  unpushed: boolean;
};

/** One board folder a nuke would erase. */
export type RunnerNukeBoard = {
  slug: string;
  worktrees: RunnerNukeWorktree[];
  /** Keys in the board's secrets store, and its secret files. */
  secrets: number;
  secretFiles: number;
  /** Entries in the board's backups folder. */
  backups: number;
};

/** What "Nuke this runner" would erase (.specs/runner-setup.md "Nuke a
 *  runner"). Read before the confirm box, and again by the run itself. */
export type RunnerNukePlan = {
  runnerDir: string;
  runnerName: string;
  boards: RunnerNukeBoard[];
  /** Every board's keys and secret files, together. */
  secretsTotal: number;
  backupsTotal: number;
  /** Whether the runner holds a pairing, so the server is asked to unpair. */
  paired: boolean;
  /** The service the runner would stop and delete, or null with none. */
  service: string | null;
  /** What the nuke cannot remove itself, each with where the person removes
   *  it (the lid-closed grant, root's file). Absent from a runner from
   *  before this. */
  leftBehind?: string[];
};

/** The steps of a nuke, in the order they run. */
export type RunnerNukeStep =
  | 'plan'
  | 'unpair'
  | 'service'
  | 'sessions'
  | 'keychain'
  | 'secrets'
  | 'folder'
  | 'done';

/** One progress frame of a nuke (`{ type: 'runner-nuke', progress }` on
 *  every link of the runner, until it exits). */
export type RunnerNukeProgress = {
  step: RunnerNukeStep;
  state: 'running' | 'done' | 'failed';
  lines: string[];
};

/** The answer to `runnerNuke`: the plan, and whether the erase started. A
 *  started erase reports through `runner-nuke` frames, then the runner exits
 *  and stays offline. */
export type RunnerNukeResult = {
  plan: RunnerNukePlan;
  started: boolean;
};

/** What Local AI read off the machine, the model it picked and why, and
 *  every model in the table with whether it fits. */
export type RunnerLocalAi = {
  machine: LocalAiMachine;
  /** The largest model that fits; null when the machine is too small. */
  recommended: LocalAiModelId | null;
  /** The owner's pick, else the recommended one. */
  picked: LocalAiModelId | null;
  /** "16 GB unified memory (Apple M3 Pro), so an 8B model at 4-bit, about
   *  4.9 GB." Or that the machine is too small, pointing to Claude/Codex. */
  reason: string;
  /** The picked model is in Ollama on this machine. */
  pulled: boolean;
  models: LocalAiModelFit[];
};

/** A pull or a remove of one Ollama model, from Oakbox > Account > Backend. */
export type RunnerLocalAiJob = {
  action: LocalAiActPayload['action'];
  tag: string;
  state: 'running' | 'done' | 'failed';
  /** The newest lines of its output, oldest first. */
  lines: string[];
  startedAt: number;
};

/** A runner's models as Oakbox > Account > Backend manages them
 *  (.specs/runner-vault-ask.md "Oakbox's backend: setup, sign-ins, models"). Names and numbers only. */
export type RunnerLocalAiModels = {
  /** Ollama is installed. Without it nothing can be pulled. */
  ollama: boolean;
  /** Every model Ollama holds, as `ollama list` names it. */
  installed: string[];
  /** Null when the machine could not be read. */
  machine: LocalAiMachine | null;
  recommended: LocalAiModelId | null;
  /** The fixed table, each with whether it fits this machine. */
  models: LocalAiModelFit[];
  health: RunnerMachineHealth | null;
  /** The last pull or remove, kept until the next one. */
  job: RunnerLocalAiJob | null;
};

/** One model in ollama.com's search, as the runner read it off the page. */
export type OllamaLibraryModel = {
  /** `name`, or `namespace/name` for someone's own model. */
  name: string;
  description: string;
  /** "tools", "thinking", "vision", "embedding"… */
  capabilities: string[];
  /** Its parameter sizes: "0.6b", "8b"… */
  sizes: string[];
  /** Runs on Ollama's cloud, not on the machine. */
  cloud: boolean;
  downloads: number | null;
};

/** One tag of a model on ollama.com, with whether it fits this runner. Tags
 *  that are the same file are one, with the others as `aliases`. */
export type OllamaLibraryTag = {
  tag: string;
  aliases: string[];
  /** Its download size; null for a cloud tag. */
  sizeGb: number | null;
  /** "40K", "128K". */
  context: string | null;
  /** "Text", "Text, Image". */
  input: string | null;
  cloud: boolean;
  fits: boolean;
  /** Why it does not fit, or null. */
  blocker: string | null;
};

/** One CLI's sign-in on a runner, runner-wide (`cliSignins`). */
export type RunnerCliSignin = {
  /** On the runner's PATH. */
  installed: boolean;
  signedIn: boolean;
  /** The last sign-in started from Oakbox: running until the CLI settles,
   *  then how it ended. Null when none was started since the runner did. */
  flow: {
    state: 'running' | 'complete' | 'error';
    message: string | null;
  } | null;
};

export type RunnerCliSignins = Record<'claude' | 'codex', RunnerCliSignin>;

/** What `localAiSearch` answers: a query's models, or one model's tags. */
export type RunnerLocalAiSearch =
  | { kind: 'models'; query: string; models: OllamaLibraryModel[] }
  | { kind: 'tags'; name: string; tags: OllamaLibraryTag[] };

export type RunnerJobState =
  | 'queued'
  // A member's call of a dangerous job, held until the runner owner
  // approves it; denied on a no or after 10 minutes without an answer.
  | 'waiting-owner'
  | 'waiting-auth'
  | 'running'
  // Server only: the runner got the call but did not confirm it in time, so
  // it may be running. Its later reports still move the row, cancel still
  // reaches it, and nothing sends it again on its own.
  | 'unknown'
  | 'done'
  | 'denied'
  | 'failed'
  | 'cancelled';

export type SecretsInboxItem = {
  id: string;
  key: string;
  kind: 'env' | 'file';
  replaces: boolean;
  byUserId: string;
  byName: string;
  at: string;
};

/** 'working' spins; the other two are stationary and want attention. */
export type RunnerActivityState = 'working' | 'awaiting-input' | 'error';

export type RunnerActivity = {
  /** Stable per space+kind (+ discriminator for sign-ins, which can overlap),
   *  so an update replaces its row instead of stacking another one. */
  id: string;
  kind: RunnerActivityKind;
  /** null means finished — the client drops the row. */
  state: RunnerActivityState | null;
  /** The row's one line, e.g. "Ask Board" or "Deploying". */
  label: string;
  /** Current step, shown in the tooltip, e.g. "cloning repo". */
  detail: string;
  startedAt: number;
};

/** Rows the user may close from Running jobs or the session rail: a sign-in
 *  (closing it cancels the flow) and an Ask that failed. Everything else is
 *  live work, which is stopped from its own modal rather than hidden. */
export function activityDismissable(
  activity: Pick<RunnerActivity, 'kind' | 'state'>
): boolean {
  return (
    activity.kind === 'signin' ||
    (activity.kind === 'ask' && activity.state === 'error')
  );
}

// ── IPC action map (mirrors desktop/src/types.ts) ──

/**
 * How the host that stores this space's credentials is doing at protecting
 * them. There is no unencrypted mode: a host that cannot encrypt reports
 * `ready: false` and refuses to read or write secrets at all, carrying the
 * problem and its remedy so the UI can print them verbatim.
 */
export type SecureStoreStatus = {
  backend: 'runner-keychain' | 'electron-safe-storage';
  /** Which OS facility holds the machine key. Informational, drives UI copy. */
  keyStore: 'macos-keychain' | 'libsecret' | 'dpapi' | 'electron-safe-storage';
  /** Reads and writes of credentials will succeed right now. */
  ready: boolean;
  /** Whether the client should show a password box. No host offers a password
   *  to set any more; a runner reports true only while connection files from
   *  before the password was removed are still locked behind it, which is when
   *  an unlock box is needed. Runners older than that report true always. */
  passwordSupported: boolean;
  /** Whether a connection password from an older runner still exists. It is
   *  removed by the unlock, or at start when nothing needs it. */
  passwordEnabled: boolean;
  /** Whether the key is available in the host process right now. */
  unlocked: boolean;
  /** Missing binary, when that's the cause. Empty otherwise. */
  missingTool: string;
  /** One-line problem statement. Empty when ready. */
  problem: string;
  /** Copy-pasteable remedy, possibly multi-line. Empty when ready. */
  fix: string;
};

export type ConfigResponse = {
  repoUrl: string;
  mainBranch: string;
  gitName: string;
  gitEmail: string;
  // The CLI agent this space runs. Older runners omit this (claude).
  provider: AgentProvider;
  // How much Codex may do in this board's sessions. Older runners omit this
  // (standard).
  codexAccess?: CodexAccess;
  // Which of the runner's Git connections (Status > Git) this board uses.
  // '' is none; absent from a runner older than root connections, whose
  // board holds its own token. See .specs/runner-setup.md "Git connections".
  gitConnectionId?: string;
  // The runner's Git connections a board may pick from, by name only (never
  // a token). Sent to the runner's owner only; absent elsewhere and from an
  // older runner.
  gitConnections?: GitConnectionChoice[];
  // What a new terminal on this board starts. Absent from an older runner,
  // whose new terminals open a plain shell.
  terminalDefault?: TerminalDefault;
  // The command a new terminal runs when terminalDefault is 'command'.
  terminalCommand?: string;
  // True when the runner's Claude CLI is signed in - the only Claude auth.
  // One sign-in per runner, in its own CLI home (agent-homes.ts), shared by
  // every board and by Oakbox. Older runners omit this.
  claudeLoggedIn: boolean;
  // True when the runner's Codex CLI is signed in (auth.json in its CLI
  // home), likewise per runner. Older runners omit this.
  codexLoggedIn: boolean;
  hasGithubToken: boolean;
  githubTokenHint: string;
  // Whether this host can encrypt connection tokens at rest right now. False
  // means it reported back that it CANNOT - a machine with no usable keychain,
  // or one still holding connection files locked behind an old connection
  // password (unlocked once, then never again). Such a runner stores nothing
  // rather than falling back to plaintext.
  //
  // Undefined is a THIRD state, not a synonym for false: a runner too old to
  // know about this field omits it. Such a runner is certainly not encrypting,
  // but the reason is "old build", not "no keychain" - and the UI must not
  // assert a cause it can't observe. Keep the distinction; don't `?? false`.
  tokensEncrypted?: boolean;
  // The detail behind tokensEncrypted: which key store, whether an old
  // connection password still needs entering, and the exact fix when the
  // store is not usable. Omitted by runners that predate the secure-store
  // rework.
  secureStore?: SecureStoreStatus;
};

/** How much Codex may do in a board's sessions (board-agent-core/
 *  codex-permissions.ts). 'standard': its workspace sandbox with the network
 *  and the runner's own folders, asking before anything else. 'full': no
 *  sandbox and no approval prompts. */
export type CodexAccess = 'standard' | 'full';

export type SetConfigPayload = {
  repoUrl?: string;
  mainBranch?: string;
  /** Older clients only: a board's identity is its Git connection's now. */
  gitName?: string;
  gitEmail?: string;
  /** Older clients only: a token is saved as a runner Git connection and
   *  the board pointed at it (.specs/runner-setup.md "Git connections"). */
  githubToken?: string;
  provider?: AgentProvider;
  /** Owner only: the daemon drops it from anyone else. */
  codexAccess?: CodexAccess;
  /** Owner only (the daemon drops it from anyone else): which runner Git
   *  connection this board uses; '' for none. */
  gitConnectionId?: string;
  terminalDefault?: TerminalDefault;
  terminalCommand?: string;
};

/** What a new terminal on a board starts: a CLI the runner is signed in to,
 *  the board's own command, or a plain shell. Only a default for NEW
 *  terminals: a running one keeps what it started with. */
export type TerminalDefault = 'claude' | 'codex' | 'command' | 'shell';

/** A runner Git connection as a board's picker shows it. */
export type GitConnectionChoice = {
  id: string;
  label: string;
  /** The GitHub account, '' while unknown (offline at save). */
  login: string;
};

/** One of the runner's Git connections, for its owner's Status > Git. The
 *  token never leaves the runner; `tokenHint` is its last four characters. */
export type GitConnectionView = GitConnectionChoice & {
  gitName: string;
  gitEmail: string;
  tokenHint: string;
  /** 'oauth': signed in with GitHub here (revoked on remove); 'token': a
   *  pasted personal access token. */
  source: 'oauth' | 'token';
  /** Slugs of the boards that use it. */
  boards: string[];
  createdAt: number;
};

/** A GitHub sign-in started from Status > Git. Polled with gitConnections:
 *  a runner-wide link gets no events. */
export type GitConnectionSignin =
  | { status: 'idle' }
  | {
      status: 'pending';
      userCode: string;
      verificationUri: string;
      expiresAt: number;
    }
  | { status: 'complete'; connectionId: string; login: string }
  | { status: 'expired' | 'declined' | 'error'; message?: string };

export type GitConnectionsState = {
  connections: GitConnectionView[];
  signin: GitConnectionSignin;
};

export type GitConnectionActPayload =
  | { op: 'signinStart'; clientId: string }
  | { op: 'signinCancel' }
  | { op: 'addToken'; token: string }
  | {
      op: 'update';
      id: string;
      label?: string;
      gitName?: string;
      gitEmail?: string;
    }
  | { op: 'remove'; id: string };

/** One path in a bare workspace's git status, tagged with the porcelain letter
 *  that put it there: 'M' modified, 'A' added, 'D' deleted, 'R' renamed, 'U'
 *  unmerged. The same path can appear staged AND unstaged - git tracks the
 *  index and the working tree separately, and so does the panel. */
export type BareGitFileStatus = {
  path: string;
  code: string;
  /** A staged rename's source path, so unstaging or discarding the row takes
   *  both halves of it. Absent for everything else, and from an older runner. */
  oldPath?: string;
};

/** The panel's stash: changes the branch switch left behind on a branch
 *  ("leave them on <branch>"), shown as "Stashed changes" when that branch is
 *  checked out again. */
export type BareGitStash = {
  sha: string;
  /** Git's own phrasing ("5 minutes ago"). */
  relative: string;
};

/** What a git operation left half done, which the panel offers to abort. */
export type BareGitOperation =
  | ''
  | 'merge'
  | 'revert'
  | 'cherry-pick'
  | 'rebase';

/**
 * What the git panel may do in this workspace, and what its top bar reads.
 * Absent from a runner older than the panel's write actions, which a client
 * reads as "read only".
 */
export type BareGitPanelInfo = {
  /** The workspace's absolute path, for "Copy file path". */
  root: string;
  /** Writes are allowed only in the session's own worktree. */
  writable: boolean;
  /** Why not, in a sentence, when `writable` is false. */
  readOnlyReason: string;
  /** The session has a worktree of its own (a Code session). False for a
   *  Chat in the board's shared checkout, where the read-only banner offers
   *  a Code session instead. Absent from an older runner. */
  ownWorktree?: boolean;
  /** The repository's default branch: never committed or pushed to here. */
  defaultBranch: string;
  /** HEAD is on the default branch. Commit, merge, revert and push refuse. */
  protectedBranch: boolean;
  /** HEAD is on no branch. Commit and push refuse. */
  detached: boolean;
  /** The branch of the same name on origin, as of the last fetch. Null when
   *  the branch is not published, which the top bar reads as "Publish
   *  branch". Distinct from `upstream`: a session branch is cut from
   *  origin/main and tracks it, and pushing there is what this must never do. */
  remote: BareGitUpstream | null;
  /** When this workspace last fetched, ms since the epoch; 0 for never. */
  lastFetched: number;
  operation: BareGitOperation;
  /** The panel's stash for the checked-out branch, newest. */
  stash: BareGitStash | null;
  /** HEAD's full message, for Amend's prefill. '' with no commit. */
  headMessage: string;
  /** HEAD is on no remote, so it can be amended or undone without a force
   *  push. False with no commit. */
  headLocal: boolean;
};

/** One commit on the workspace's branch, for the panel's history list. */
export type BareGitCommit = {
  sha: string;
  shortSha: string;
  author: string;
  /** ISO-8601 author date. */
  date: string;
  /** Git's own phrasing ("3 hours ago"), so the panel needs no clock. */
  relative: string;
  subject: string;
  /** Not reachable from any remote branch: committed here, never pushed. */
  local: boolean;
};

/** The branch a workspace's HEAD tracks, and how far the two have drifted as
 *  of the last fetch. */
export type BareGitUpstream = {
  name: string;
  /** Commits here the upstream lacks, and the other way round. */
  ahead: number;
  behind: number;
};

/** One file's bytes at one revision, for an image's before/after. */
export type BareGitBlob = {
  /** Base64. Empty when `tooLarge`. */
  content: string;
  size: number;
  /** Past the runner's cap (5MB): nothing was read. */
  tooLarge?: boolean;
};

/** What the scratchpad panel does with one file. Derived from the extension
 *  alone (`helpers/scratchpad.ts`), so an agent picks a renderer by naming the
 *  file rather than by writing a manifest beside it. */
export type ScratchpadKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'html'
  | 'markdown'
  | 'link'
  | 'text';

/** One file on a space's scratchpad. Contents are fetched per item, so a panel
 *  listing a 40MB video costs one small call until something asks to play it. */
export type ScratchpadItem = {
  /** Bare filename. The scratchpad is flat: no separators, ever. */
  name: string;
  kind: ScratchpadKind;
  size: number;
  /** Epoch ms. The panel orders newest first. */
  modifiedAt: number;
  /** Past SCRATCHPAD_MAX_BYTES: listed, never inlined. The panel says so
   *  rather than hanging on a read the transport would take minutes to chunk. */
  tooLarge: boolean;
};

/** One vault backup a runner holds for its owner. No kind and no path: there
 *  is one kind, and the path is the runner's business. See
 *  .specs/mobile-vault.md "Runner backup". */
export type RunnerVaultBackupItem = {
  /** Picked by the runner from its own clock; a client never names a file. */
  name: string;
  size: number;
  /** Epoch ms, from the file. The order comes from the name, not from this. */
  modifiedAt: number;
};

/** The two stores on a runner (.specs/runner-vault.md "Two stores"), each its
 *  own database and files folder behind the same actions. `vault`: private,
 *  read by Local AI (Ollama) only. `runner`: Runner Storage, which Claude and
 *  Codex may read too. A payload with no `store` means the Vault, so an app
 *  from before Runner Storage keeps working. */
export type RunnerStoreName = 'vault' | 'runner';

/** One file in a runner's Vault (.specs/runner-vault.md "Database"): its
 *  Upload row, with the type and size its object has. */
export type RunnerVaultFile = {
  /** Upload.id */
  id: string;
  /** The path, folders and all, as the cloud vault keeps it. */
  name: string;
  size: number;
  contentType: string;
  /** ISO time it was added. */
  createdAt: string;
  ingestStatus: 'PENDING' | 'EMBEDDED' | 'FAILED';
  /** The caller added it: only they may delete it. */
  mine: boolean;
  /** Who added it, when it was not the caller (server user id). */
  addedBy: string | null;
  /** The categories (factiii ids) the runner's Categorize tagged it with.
   *  Absent from a runner from before Categorize. */
  factiiiIds?: number[];
  /** A note kept from Ask (.specs/runner-vault-ask.md "Kept research on the
   *  runner"), not a file: `id` is its Post.uuid and `name` its title. It
   *  opens with `vaultNotes`, never as a download. */
  note?: true;
  /** Which of the runner's stores holds it. Absent from a runner from before
   *  Runner Storage: its Vault. */
  store?: RunnerStoreName;
};

/** One file a runner's Vault found for a search (.specs/runner-vault.md
 *  "Search across vaults"). `distance` is bge-base's cosine distance
 *  (`<=>`), the cloud's model and size, so it ranks beside the cloud's own
 *  hits; null for a file whose name or text has the words. */
export type RunnerVaultHit = RunnerVaultFile & { distance: number | null };

/** How a runner's Vault answered a search. `words`: the name or the text has
 *  them, as the cloud's file search. `meaning`: no such file, so the query was
 *  embedded on the runner and ranked by distance. `names`: Vault search is not
 *  installed (or its embedder did not answer), so only the words pass ran.
 *  `absent`: this runner has no Vault. */
export type RunnerVaultSearchMode = 'words' | 'meaning' | 'names' | 'absent';

/** What Oakbox Ask may run on a runner (.specs/runner-vault-ask.md "Ask with a
 *  runner's model"). Claude and Codex run on the owner's sign-in. */
export type RunnerAskEngine = 'ollama' | 'claude' | 'codex';

/** The models a runner offers the caller for Ask. */
export type RunnerAskModels = {
  /** The Ollama models on the runner: `id` is Ollama's tag, `title` the
   *  Local AI table's name for it, else the tag. */
  ollama: { id: string; title: string }[];
  /** Claude, then Codex, where the runner has the CLI. Always empty for a
   *  shared-vault peer. */
  cli: Exclude<RunnerAskEngine, 'ollama'>[];
  /** Of `cli`, the ones not signed in, so Ask's menu says so. Absent from an
   *  older runner: every CLI it lists reads as signed in. */
  signedOut?: Exclude<RunnerAskEngine, 'ollama'>[];
  /** The runner has Runner Storage, the only store Claude and Codex read
   *  (the Vault is Local AI only). False: they have nothing to read yet.
   *  Absent from a runner from before Runner Storage, where they read its
   *  Vault. */
  runnerStorage?: boolean;
};

/** One turn of a runner Ask, as the app last read it. `text` grows while the
 *  model writes; `sources` are the files it was given to answer from. */
export type RunnerAskState = {
  steps: string[];
  text: string;
  done: boolean;
  error: string | null;
  sources: RunnerVaultFile[];
  /** The note the model kept this turn with its save tool, if any. Absent
   *  from a runner from before the tool. */
  saved?: RunnerVaultNote;
  /** The asker stopped it (`vaultAskCancel`): done, and no answer was
   *  saved. Absent from a runner from before the stop. */
  stopped?: boolean;
};

/** An Ask chat kept on a runner (.specs/runner-vault-ask.md "Runner chats"). It
 *  stays on the model it started on. */
export type RunnerAskChat = {
  id: string;
  /** The first question. */
  title: string;
  engine: RunnerAskEngine;
  /** The Ollama tag; null for Claude and Codex. */
  model: string | null;
  /** The model's name, for the prompt bar. */
  modelTitle: string;
  updatedAt: string;
  /** Why the last turn failed; null once one succeeds. */
  error: string | null;
  /** The last turn was stopped before it answered; false once one answers.
   *  Absent from a runner from before the stop. */
  stopped?: boolean;
  /** The store the chat is kept in and asks about. Absent from a runner
   *  from before Runner Storage: its Vault. */
  store?: RunnerStoreName;
};

/** One message of a runner chat: a question, or an answer with what it did
 *  on the way, how long it took and the files it answered from. */
export type RunnerAskChatMessage = {
  role: 'you' | 'answer';
  text: string;
  steps: string[];
  ms: number | null;
  sources: RunnerVaultFile[];
};

/** The Vault's reading and embedding of its files, on the runner. */
export type RunnerVaultIngest = {
  /** Files waiting to be read, read and searchable, or unreadable. */
  pending: number;
  embedded: number;
  failed: number;
  running: boolean;
  /** The path of the file being read now. */
  current: string | null;
  /** `unsupported`: neither a Mac with Apple silicon (Core ML) nor Linux
   *  (ONNX). */
  embedder: 'ready' | 'missing' | 'unsupported';
};

export type RunnerVaultStatus = {
  /** The caller is the runner's owner, or a member the owner let in. */
  role: 'owner' | 'member';
  files: number;
  bytes: number;
  /** Owner only: the accounts the owner let into this vault. */
  members: string[];
  /** Absent from a runner from before the embedder. */
  ingest?: RunnerVaultIngest;
  /** Runner Storage beside the Vault, on a status read with no `store`:
   *  null while the runner has none yet. Absent from a runner from before
   *  it. */
  runnerStorage?: { files: number; bytes: number } | null;
};

/** A runner's Categorize run (.specs/runner-vault-ask.md "Categorize on the
 *  runner"), as the app last read it. */
export type RunnerCategorizeRun = {
  engine: RunnerAskEngine;
  /** The Ollama tag; null for Claude and Codex. */
  model: string | null;
  running: boolean;
  /** Files in the run, and how many are done. */
  total: number;
  processed: number;
  /** The path of the file being read now. */
  current: string | null;
  /** Seconds left, from the files done so far; null before the first. */
  etaSeconds: number | null;
  stopped: boolean;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

/** One value a category holds on a runner file (PostFactiii), in the shape
 *  `tagDetails` reads: a number, text, and the dates and places written. */
export type RunnerTagEntry = {
  data: string | null;
  number: number | null;
  spaceTimes: { timestamp: string | null; display: string | null }[];
};

/** A runner file's own page (.specs/runner-vault-ask.md "A runner file's page"):
 *  the file, what the runner read off it and the categories its Categorize
 *  gave it, with their values. */
export type RunnerVaultFilePost = {
  file: RunnerVaultFile;
  /** Why reading it failed, when it did. */
  ingestError: string | null;
  /** How its text was read (TEXT_LAYER, OCR, …); null until read. */
  transcriptSource: string | null;
  /** When Categorize last ran over it; null for never. */
  categorizedAt: string | null;
  /** The text read off it, its pages marked, cut at `textLimit`. Empty
   *  until the runner has read it. */
  text: string;
  /** The whole text's length; over `text`'s when it was cut. */
  textChars: number;
  /** Its searchable pieces (content rows). */
  pieces: number;
  /** Its categories by factiii id, each with the values it holds. */
  tags: { factiiiId: number; entries: RunnerTagEntry[] }[];
};

/** A note kept from a runner Ask answer (.specs/runner-vault-ask.md "Kept research
 *  on the runner"): a PRIVATE post with no file, in the runner's Vault. */
export type RunnerVaultNote = {
  /** Post.uuid */
  id: string;
  title: string;
  /** The answer's HTML, as it was kept. */
  body: string;
  /** ISO time it was kept. */
  at: string;
  /** The store it is kept in. Absent from a runner from before Runner
   *  Storage: its Vault. */
  store?: RunnerStoreName;
};

/** Categorize on a runner: what waits, how many files each category tagged,
 *  the models it may run on and the run, if any. */
export type RunnerCategorizeStatus = {
  /** Read files no run has categorized yet. */
  waiting: number;
  /** Files the runner has not read yet (its ingest): Categorize waits on
   *  them. */
  unread: number;
  /** Files per category (factiii id). */
  counts: { factiiiId: number; files: number }[];
  models: RunnerAskModels;
  run: RunnerCategorizeRun | null;
};

/** A running simulator. Only booted devices are listed — a shutdown one has no
 *  display to attach to. See .specs/simulator-panel.md. */
export type SimulatorDevice = {
  udid: string;
  name: string;
  /** Trimmed for display: "iOS 26 4", not the full reverse-DNS runtime id. */
  runtime: string;
};

/**
 * One input event for a simulator.
 *
 * Touch carries 0..1 ratios, not points: the HID layer normalises against the
 * screen itself, so neither end needs to know the device's size. `move` is what
 * separates this from a canned swipe — the simulator tracks the pointer as it
 * travels, which is the difference between scrolling and watching a list jump
 * once on release.
 */
export type SimulatorCommand =
  | { type: 'touch'; phase: 'down' | 'move' | 'up'; x: number; y: number }
  | { type: 'tap'; x: number; y: number }
  | { type: 'text'; text: string }
  /** One key going down or up, as a USB HID usage code. What a hardware
   *  keyboard sends: the device supplies shift, repeat and shortcuts itself. */
  | { type: 'key'; code: number; down: boolean }
  | { type: 'button'; button: 'HOME' | 'LOCK' | 'SIRI' | 'SIDE' | 'APPLE_PAY' }
  /** Face ID / Touch ID. Not HID — a Darwin notification, the same one
   *  Simulator.app's Features menu posts. A non-match is the more useful test:
   *  it is the path an app's error handling actually has to cover. */
  | { type: 'biometric'; kind: 'face' | 'touch'; match: boolean };

/** A command plus the device it is for. Split from `SimulatorCommand` because
 *  `Omit` over a union collapses it, and the panel builds commands without
 *  knowing the udid. */
export type SimulatorInput = SimulatorCommand & { udid: string };

/** What the owner gives one board member on a runner, lowest first. Each
 *  level includes the ones before it (runner-access.ts). */
export const RUNNER_ACCESS_LEVELS = [
  'none',
  'api',
  'terminals',
  'screens'
] as const;
export type RunnerAccessLevel = (typeof RUNNER_ACCESS_LEVELS)[number];

/** Every level the owner gave: board slug -> user id -> level. A board or a
 *  user that is not listed is at 'none'. Lives on the runner (access.json). */
export type RunnerGrants = Record<string, Record<string, RunnerAccessLevel>>;

/** Who the owner let run dangerous jobs without
 *  asking: board slug -> the user ids. Kept beside the levels in access.json,
 *  and counts only for a member who also has the API level there. Anyone
 *  else's call waits for the owner's approval, which is what every file from
 *  before it reads as. */
export type RunnerDangerousGrants = Record<string, string[]>;

/** One board's access as the runner tells it to the asking channel. */
export type RunnerAccessState = {
  /** The asker's own level on this board. The owner reads 'screens'. */
  level: RunnerAccessLevel;
  /** User id -> level on this board. Sent to the owner only; a member gets
   *  an empty map and never learns another member's level. */
  grants: Record<string, RunnerAccessLevel>;
  /** The user ids with the permission on this board. Sent to the owner only,
   *  like `grants`. */
  dangerousGrants?: string[];
};

/** Which part of the product a tool of the environment is for. */
export type EnvironmentFeature =
  | 'boards'
  | 'terminals'
  | 'card-ai'
  | 'secrets'
  | 'containers'
  | 'remote'
  | 'vms';

/** One tool the runner's environment needs, as `environmentStatus` reports
 *  it. No path of the machine: the name, the state and the install command
 *  are what a member may see. */
export type EnvironmentItem = {
  id: string;
  title: string;
  feature: EnvironmentFeature;
  required: boolean;
  state: 'ok' | 'missing';
  /** Who installs a missing item on this host. Null when it is present. */
  fix: EnvironmentFix | null;
};

/** `initialize`: the Initialize button installs it; `password` when it will
 *  ask for the computer's password first (sudo is not passwordless).
 *  `install`: an extra, which its own Install button adds
 *  (`environmentInstall`); `command` is what an app from before that button
 *  shows instead. `hand`: the runner has no package for it here, so a person
 *  installs it, with the command when the runner knows one. */
export type EnvironmentFix =
  | { by: 'initialize'; password: boolean }
  | { by: 'install'; password: boolean; command: string }
  | { by: 'hand'; command?: string };

/** Who has the runner's one video stream (the simulator), as the runner
 *  tells one channel. `mine` is true on the holder's own link only. See
 *  screen-holder.ts. */
export type ScreenHolderView = {
  kind: 'simulator';
  userId: string;
  name: string;
  mine: boolean;
};

/** The image formats an AI question can carry. A GIF is sent as a still. */
export const ASK_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif'
] as const;
export type AskImageType = (typeof ASK_IMAGE_TYPES)[number];

/** An image attached to an Ask Board question: base64 in the request itself.
 *  It is context for one turn, never an upload - nothing reaches S3/R2, and
 *  the runner keeps no copy once the turn ends. */
export type AskImage = { mediaType: AskImageType; data: string };

export const ASK_IMAGE_MAX_COUNT = 4;
/** Per image, decoded. Clients downscale well below this before sending. */
export const ASK_IMAGE_MAX_BYTES = 5_000_000;

/** The largest file a terminal takes as a drop or a paste, decoded. One
 *  number for the client (which refuses before it uploads) and the runner
 *  (which refuses again, on disk, across the chunks). */
export const TERMINAL_DROP_MAX_BYTES = 100_000_000;

/** Shown by the clients when `githubDisconnect` answers `revoked: false`: the
 *  token is gone from the runner but may still be valid at GitHub. */
export const GITHUB_NOT_REVOKED_MESSAGE =
  'Removed here, but not revoked at GitHub. Revoke it at github.com/settings/applications.';

/** Where to revoke the connections a runner holds (a revoked runner keeps
 *  them until they are revoked at the provider). */
export const GITHUB_APPLICATIONS_URL =
  'https://github.com/settings/applications';

/** One turn of the Ask Board conversation as the runner keeps it. */
export type BoardSessionMessage = {
  role: 'user' | 'assistant';
  content: string;
  /** How many images rode with a user turn. The images are not kept. */
  imageCount?: number;
};

/** One Board AI conversation in the session list. */
export type BoardConversationSummary = {
  id: string;
  /** The first question, until the user renames it. */
  title: string;
  /** "List > Card title" when the conversation is about one card, else ''. */
  topic: string;
  /** The last thing the user asked. */
  preview: string;
  provider: AgentProvider | null;
  /** Set aside: out of the open tabs, still resumable from the history. */
  archived: boolean;
  /** A turn is in flight on the runner right now. */
  busy: boolean;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
};

export type BoardAgentActionMap = {
  getConfig: { payload: void; result: ConfigResponse };
  setConfig: { payload: SetConfigPayload; result: { success: boolean } };
  clearToken: {
    payload: { key: 'githubToken' };
    result: { success: boolean };
  };
  ask: {
    payload: {
      question: string;
      boardContext?: string;
      componentSchema?: string;
      /** Provider for a NEW conversation. Locked once the conversation starts
       *  (a claude session and a codex thread aren't interchangeable). */
      provider?: AgentProvider;
      /** Screenshots and images for this turn, piped straight to the model. */
      images?: AskImage[];
      /** Which conversation this turn belongs to; the first question with a
       *  new id starts it. A client older than conversations sends none and
       *  gets the most recently used one. */
      conversationId?: string;
    };
    result: string;
  };
  /** From a client older than conversations: set the current one aside. It
   *  stays in the history; nothing is deleted. */
  resetBoardSession: { payload: void; result: void };
  /** One persisted Ask Board conversation, for hydrating the panel on open. No
   *  id means the most recently used one. */
  boardSession: {
    payload: { conversationId?: string } | void;
    result: {
      messages: BoardSessionMessage[];
      /** Absent from a runner older than conversations. */
      conversationId?: string;
      busy?: boolean;
    };
  };
  /** Every Ask Board conversation of the space, most recently used first. */
  boardSessions: {
    payload: void;
    result: { conversations: BoardConversationSummary[] };
  };
  /** Rename, label with a topic, or set aside / bring back a conversation. */
  boardSessionUpdate: {
    payload: {
      conversationId: string;
      title?: string;
      topic?: string;
      archived?: boolean;
    };
    result: void;
  };
  /** Delete a conversation for good, stopping any turn in flight. */
  boardSessionDelete: { payload: { conversationId: string }; result: void };
  cardExecute: {
    payload: {
      postId: string;
      prompt: string;
      baseBranch: string;
      targetBranch: string;
      taskTitle: string;
      effort: string;
      mode: CardAIMode;
      // Per-job agent provider, defaulting to the space config when absent.
      provider?: AgentProvider;
      /** Terminal mode: its own worktree and branch (a Code session), or
       *  false to run in the board's workspace (a Chat session). Absent: a
       *  worktree whenever the board has a repository, as before. */
      worktree?: boolean;
    };
    result: { taskId: string; postId: string };
  };
  // On-demand live dev-server preview for a completed claude session.
  cardStartPreview: {
    payload: { postId: string };
    result: { previewUrl: string };
  };
  // One-shot on the runner host: combine the selected cards' text into the
  // merged card's title/content. Runs before posts.merge creates the card.
  cardMergeContent: {
    payload: { cards: { title: string; content: string }[] };
    result: { title: string; content: string };
  };
  // Card merge follow-up: take the diffs from the source cards' completed
  // sessions and have Claude reconcile them in a fresh session on the primary
  // card, ending in a normal 'complete' phase (diff review + push).
  cardMergeSessions: {
    payload: {
      primaryPostId: string;
      // Cards whose completed sessions supply the diffs; may include the primary.
      sourcePostIds: string[];
      taskTitle: string;
    };
    result: { taskId: string; postId: string };
  };
  cardSessions: { payload: void; result: Record<string, CardAISessionSummary> };
  cardSession: {
    payload: { postId: string };
    result: CardAISessionFull | null;
  };
  /** End a session. `keepBranch` keeps a terminal's branch when its
   *  worktree goes (the board MCP's end_session does by default); the app's
   *  End leaves it out and deletes the branch. */
  cardDismiss: {
    payload: { postId: string; keepBranch?: boolean };
    result: void;
  };
  setupStatus: {
    payload: void;
    result: { phase: 'idle' | 'running' | 'ready' };
  };
  /** What the environment has and lacks, tool by tool. Read-only. */
  environmentStatus: { payload: void; result: EnvironmentItem[] };
  /** Install one extra of the environment (an `install` fix), streaming its
   *  log and any password request on the setup status channel. Resolves once
   *  it is on the PATH; throws the installer's reason otherwise. Owner only. */
  environmentInstall: { payload: { id: string }; result: { success: boolean } };
  ensureSetup: { payload: void; result: { ready: boolean } };
  cardRemoteBranches: { payload: void; result: string[] };
  /** Worktree names already in use, so the terminal launcher can refuse a
   *  duplicate name up front instead of failing the launch. */
  bareWorkNames: { payload: void; result: string[] };
  // Deploy button entry: does the default branch carry the deploy contract
  // (.agents/skills/deploy/SKILL.md + required-variables.json)? Missing
  // pieces route the UI to the skill creator. See .specs/deploy.md.
  deployStatus: {
    payload: void;
    result: {
      hasSkill: boolean;
      hasVariables: boolean;
      hasChecker: boolean;
      branch: string;
      // Newest unmerged deploy-skill* branch with the full contract; the
      // creator offers to resume it instead of regenerating.
      pendingBranch: string;
      variables: {
        key: string;
        title: string;
        description: string;
        category: string;
        sensitive: boolean;
        // 'file' = a blob under files/, listed with the file secrets. Absent
        // from an older runner, which reads every entry as an env key.
        kind?: 'env' | 'file';
      }[];
    };
  };
  // The Deploy modal's release picker: what is on origin that could ship,
  // newest commit first. The default branch is excluded - it IS production,
  // so a release never starts there. `ahead` = commits the branch would bring
  // to it (0 = already merged), `updated` = its last commit, epoch SECONDS.
  deployBranches: {
    payload: void;
    result: { name: string; ahead: number; updated: number; subject: string }[];
  };
  // Runner secrets store (the AI-safe contract: values are write-only,
  // the wire carries key NAMES and set-status only). NO caching: every
  // operation takes the password and decrypts for that one call.
  deploySecretsStatus: {
    payload: void;
    result: { initialized: boolean };
  };
  deploySecretsInit: {
    payload: { password: string };
    result: { success: boolean };
  };
  // Password check + key names in one call (the settings view's entry).
  // `meta` is the descriptions sidecar (secrets.meta.json): what each key is
  // FOR, never what it is. It rides this call rather than one of its own
  // because the panel wants both at once, and it needs no password of its own.
  deploySecretsList: {
    payload: { password: string };
    result: {
      keys: string[];
      meta: Record<string, SecretMeta>;
      /** File-secret (sops blob) NAMES. Older runners omit it. */
      files?: string[];
      /** Keys the runner supplies itself when the store has no value: GH_TOKEN
       *  and GITHUB_TOKEN, from its GitHub connection. Older runners omit it. */
      provided?: string[];
    };
  };
  deploySecretsSet: {
    payload: { password: string; key: string; value: string };
    result: { success: boolean };
  };
  // Describe a key. No password: this writes no secret material, and sops
  // already leaves key names in cleartext. Omitted fields keep their current
  // text, so saving a title cannot blank a description.
  deploySecretsSetMeta: {
    payload: { key: string } & Partial<SecretMeta>;
    result: { success: boolean };
  };
  deploySecretsUnset: {
    payload: { password: string; key: string };
    result: { success: boolean };
  };
  /** Store a file secret (sops blob at secrets/files/<NAME>.enc), replacing
   *  any with that name. Owner only. `name` is env-style (it becomes the
   *  variable holding the temp file's path); the file is at most 5 MB. */
  deploySecretsSetFile: {
    payload: { password: string; name: string; contentBase64: string };
    result: { success: boolean };
  };
  /** Remove a file secret. Owner only. */
  deploySecretsUnsetFile: {
    payload: { password: string; name: string };
    result: { success: boolean };
  };
  /** The keys inside a file secret that is an env file (a server env such as
   *  PROD_SERVER_ENV): names and masked tails, never a value. `env: false`
   *  for a file that is not one (a `.pem`, a JSON key). Owner only. A runner
   *  that predates this answers "Unknown board-agent action". */
  secretFileEnvKeys: {
    payload: { password: string; name: string };
    result: { env: false } | { env: true; keys: SecretFileEnvKey[] };
  };
  /** Set one key inside an env file secret, in place: the runner changes
   *  that line and re-encrypts the file. A key the file lacks is appended.
   *  `occurrences` over 1 means the key is written more than once and its
   *  last line, the one a reader uses, was changed. Owner only. */
  secretFileEnvSet: {
    payload: { password: string; name: string; key: string; value: string };
    result: { success: boolean; occurrences: number; keys: SecretFileEnvKey[] };
  };
  /** Remove one key from an env file secret: every line that sets it
   *  (`removed`). Owner only. */
  secretFileEnvUnset: {
    payload: { password: string; name: string; key: string };
    result: { success: boolean; removed: number; keys: SecretFileEnvKey[] };
  };
  // Skill creator: the AI analyzes the repo + the owner's described process
  // and drafts SKILL.md + required-variables.json into the host workspace,
  // UNCOMMITTED. The owner previews the skill and its requested secrets,
  // revises, then explicitly approves the push. Long-running; streams via the
  // board log.
  deployCreateSkill: {
    // `provider` is per-run, defaulting to the space config when absent - the
    // same shape cardExecute uses. Every deploy action that spawns an agent
    // takes it, so one pick in the modal covers check/fix, create and run.
    payload: { instructions: string; provider?: AgentProvider };
    result: {
      skill: string;
      // The generated check-environment.sh, for the review UI.
      checker: string;
      // The skill's references/<lane>.md pages (`path` relative to the skill
      // dir), for the review UI. Absent from runners older than this field.
      references?: { path: string; content: string }[];
      variables: {
        key: string;
        title: string;
        description: string;
        // AI-chosen grouping: server, client, database, deploy access...
        category: string;
        sensitive: boolean;
      }[];
    };
  };
  // ── Agent skills (SKILL.md), space-scoped like the deploy family ──
  // `.agents/skills` is the only source of truth; Claude Code reaches it
  // through a `.claude/skills/<name>` symlink, which `claudeLink` tracks.
  // Two scopes, both served by host-skills.ts:
  //   global - the host's own ~/.agents/skills. Written directly; every space
  //            this runner drives sees it.
  //   repo   - committed skills, read at a ref. Edits become a pushed
  //            `skill/*` branch and stay pending until a human merges it.
  skillsList: {
    payload: void;
    result: {
      global: SkillSummary[];
      repo: SkillSummary[];
      /** Whether `.claude/skills` links to `.agents/skills` in each scope.
       *  Anything but `linked` blocks the skills manager until the user
       *  migrates. */
      globalLink: SkillLinkState;
      repoLink: SkillLinkState;
      repoBranch: string;
      // False when the space has no repo configured, so the UI explains the
      // gap rather than showing an empty list that reads as "no skills".
      repoAvailable: boolean;
      // `skill/migrate` while a migration is pushed and unmerged, else ''. The
      // gate stays up until the merge lands, so the UI needs this to explain
      // the wait instead of offering to propose the same branch again.
      repoMigrationBranch: string;
      // Skills that landed on the default branch after that migration was
      // pushed, so its branch no longer moves all of them. Normally empty.
      repoMigrationMissing: string[];
    };
  };
  skillRead: {
    payload: { scope: SkillScope; name: string };
    result: {
      name: string;
      scope: SkillScope;
      content: string;
      errors: string[];
      // Other files in the skill dir. Listed for context; not editable in v1.
      bundleFiles: string[];
      status: SkillStatus;
      pendingBranch: string;
    };
  };
  skillWriteGlobal: {
    payload: { name: string; content: string };
    result: void;
  };
  skillDeleteGlobal: {
    payload: { name: string };
    result: void;
  };
  /** Push the edit to `skill/<name>` and stop. Merging on GitHub is the
   *  approval gate, as with approveDeploySkill and cardFinalize. */
  skillProposeRepo: {
    payload: { name: string; content: string };
    result: { branch: string };
  };
  /** Move skills out of `.claude/skills` and `.codex/skills` into
   *  `.agents/skills`, then replace `.claude/skills` with one symlink. Global
   *  applies at once; repo returns the review branch to merge. */
  skillMigrate: {
    payload: { scope: SkillScope };
    // `pushed` is false when the branch was already open and unchanged, so the
    // UI can say "already waiting" instead of claiming a fresh push.
    result: { branch: string; moved: string[]; pushed: boolean };
  };

  // ── Deploy run (executing the merged skill on the host) ──
  // Start returns immediately; progress rides the 'deploy-run' event +
  // deployRunState. Gates: answers resume the agent session; authorization
  // carries the store password RUNNER-DIRECT (never through the session).
  deployRunStart: {
    payload: {
      provider?: AgentProvider;
      /** Release branch picked in the modal. Omitted (older clients, or no
       *  pick) leaves the skill to ask for it during the run. */
      branch?: string;
    };
    result: { started: boolean };
  };
  /** Run any skill the way deploy runs: same console, gates and
   *  authorization (.specs/skills-tab.md). One run per space at a time,
   *  deploy included, read back through deployRunState. A runner older than
   *  skill runs refuses the action, so a client can never start a deploy by
   *  mistake when it asked for another skill. */
  skillRunStart: {
    payload: {
      scope: SkillScope;
      name: string;
      provider?: AgentProvider;
      /** Update this copy of a library skill instead of running it: the
       *  library's current SKILL.md under the copy's name, and its version
       *  (host-skill-update.ts). A runner older than library versions
       *  ignores it and would run the skill, so the tab offers Update only
       *  when the runner reports origins. */
      libraryUpdate?: { latest: string; version: string };
    };
    result: { started: boolean };
  };
  deployRunState: {
    payload: void;
    result: {
      /** The skill this run follows. Older runners omit it: deploy. */
      skill?: { scope: SkillScope; name: string };
      /** The CLI this run is actually using. Reported rather than inferred:
       *  a reopened modal would otherwise show the space default while the
       *  run is on the other one. Older runners omit it. */
      provider: AgentProvider;
      phase:
        | 'idle'
        | 'running'
        | 'awaiting-input'
        | 'awaiting-auth'
        | 'success'
        | 'failed';
      todos: CardAITodo[];
      logs: CardAILogEntry[];
      question: string;
      pendingCommand: string;
      /** The keys the pending command will receive - the scope the owner is
       *  actually authorizing. Older runners omit it. */
      pendingKeys: string[];
      error: string;
      // Agent-written end-of-run report (text after DEPLOY_COMPLETE/
      // DEPLOY_FAILED): what shipped, what was skipped, owner follow-ups.
      summary: string;
      startedAt: number;
      finishedAt: number;
    };
  };
  deployRunAnswer: {
    payload: { answer: string };
    result: { success: boolean };
  };
  /** Answer a sudo request from Initialize. An empty password denies, and the
   *  install fails with a message instead of hanging. Runner-direct: the
   *  password never reaches the server. */
  setupAuthorize: {
    payload: { password: string };
    result: { success: boolean };
  };
  /** What the global authorization modal renders: the one command waiting on
   *  the owner's store password, wherever in the space it was run from.
   *  `pending: null` means nothing is waiting - the modal closes. */
  secretsAuthState: {
    payload: void;
    result: {
      pending: PendingSecretsAuth | null;
      /** The open unlock window (jobs only), or null when locked. */
      unlocked: SecretsUnlockWindow | null;
    };
  };
  /** Answer a specific pending request. Omitting `password` denies it. The id
   *  must match the request on screen: a wrong-password re-prompt replaces it,
   *  and a stale answer must not resolve its successor. Runner-direct - the
   *  password never reaches the server. */
  secretsAuthAnswer: {
    /** `unlockFor` (minutes, default 120, max 720) opens an unlock window
     *  when the request is a job: later job spawns run without a prompt until
     *  it ends. 0 or absent on a free command = this one spawn only. */
    payload: { id: string; password?: string; unlockFor?: number };
    result: { success: boolean };
  };
  /** The members' dangerous job calls waiting on the runner owner (owner
   *  only). Empty when nothing waits. */
  dangerousApprovalState: {
    payload: void;
    result: { pending: PendingDangerousApproval[] };
  };
  /** The runner owner's answer to one waiting call: approve runs that one
   *  call only; deny ends it as denied. No password: the runner checks the
   *  actor is its owner. False when the id is no longer waiting. */
  dangerousApprovalAnswer: {
    payload: { id: string; approve: boolean };
    result: { success: boolean };
  };
  /** End the unlock window now: the runner wipes the age key from memory. */
  secretsLock: {
    payload: Record<string, never>;
    result: { success: boolean };
  };
  /** Re-wrap the age key under a new password (owner only). No secret value
   *  changes; the old password stops working. */
  secretsChangePassword: {
    payload: { oldPassword: string; newPassword: string };
    result: { success: boolean };
  };
  /** An offline backup of this board's secrets (owner only, never over the
   *  relay): the runner reads the keys, their descriptions and the file
   *  secrets out of the store with `password`, the board password, and seals
   *  them under `passphrase`. The passphrase alone opens the file. */
  secretsExportBackup: {
    payload: { password: string; passphrase: string };
    result: { filename: string; bundle: string };
  };
  /** Read a backup file's secrets (owner only, never over the relay). The
   *  runner unseals `bundle` with `passphrase` and answers with the values.
   *  The one action whose result carries secret values; no board on the
   *  runner is read or changed by it. A backup of the older format, which
   *  also needed a board password, is refused. */
  secretsOpenBackup: {
    payload: { bundle: string; passphrase: string };
    result: OpenedSecretsBackup;
  };
  /** What importing a backup file into THIS board would do (owner only, never
   *  over the relay): each of the backup's secrets beside the board's own, as
   *  masked tails. Nothing is written. `targetPassword` is this board's
   *  password, which reading its store takes; a board with no store has
   *  nothing to read and every `current` is null. A runner that predates this
   *  answers "Unknown board-agent action". */
  secretsImportBackupPlan: {
    payload: SecretsBackupImportRequest;
    result: SecretsBackupImportPlan;
  };
  /** Import the picked secrets of a backup file into THIS board. The runner
   *  opens the backup again, re-checks every pick against the store as it is
   *  now, and encrypts each value to this board's key; no value crosses the
   *  link. A pick the board already holds with another value needs
   *  `conflict`, or the whole import is refused. `targetPassword` is this
   *  board's password, or the password for its new store when it has none. */
  secretsImportBackupApply: {
    payload: SecretsBackupImportRequest & {
      secrets: BackupImportPick[];
      files: BackupImportPick[];
    };
    /** The names written. A pick left out was kept or already equal. */
    result: { secrets: string[]; files: string[] };
  };
  /** What this runner gives the members of this board (runner-access.ts):
   *  one level per member, None, API, Terminals or Screens. Any channel may
   *  read its own level (a member's app hides what it cannot use); only the
   *  owner sets one, and a set moves one member on this board. */
  runnerAccessGet: {
    payload: void;
    result: RunnerAccessState;
  };
  runnerAccessSet: {
    /** One change per call: a member's level, or whether they run
     *  dangerous jobs without the owner's approval per call. */
    payload:
      | { userId: string; level: RunnerAccessLevel }
      | { userId: string; dangerous: boolean };
    result: RunnerAccessState;
  };
  /** What needs the owner on this runner and board (the attention badge).
   *  Owner only. Names and booleans, never a value, and cheap: read from the
   *  clone as last fetched and the store's cleartext key names. */
  attention: { payload: void; result: RunnerAttention };
  /** The runner's always-on service (start at login, restart after a crash).
   *  Owner only, runner-wide: one service per runner, whichever board asks. */
  serviceStatus: { payload: void; result: RunnerServiceState };
  /** Write and load the service. Never starts a second runner beside this
   *  one: the service then starts at the next login. */
  serviceInstall: { payload: void; result: RunnerServiceOutcome };
  /** Delete the service. When the service is what runs this runner, it is
   *  left loaded, so this runner keeps running until the next restart. */
  serviceRemove: { payload: void; result: RunnerServiceOutcome };
  /** The runner's parts and what each is doing. Owner only, runner-wide. */
  partsList: { payload: void; result: RunnerPartsState };
  /** Who is linked to the runner, terminals other people started, the
   *  embedder, the machine's services and every public link. Owner only,
   *  runner-wide (asked with no board). */
  runnerConnections: { payload: void; result: RunnerConnections };
  /** The last lines of a service's, the embedder's or a terminal tab's
   *  output. Owner only, runner-wide; `lines` defaults to 200, at most
   *  2000. */
  runnerLogs: {
    payload: { source: RunnerLogSource; lines?: number };
    result: RunnerLogTail;
  };
  /** Start one part's or one module's action in the background and answer
   *  at once with the list; the part's (or module's) `job` then reports it. */
  partsAct: {
    payload: RunnerPartsActPayload;
    result: RunnerPartsState;
  };
  /** Free up space: a dry run by default, a run with `confirm`. Owner only,
   *  and a run is refused on the relay. */
  machineCleanup: {
    payload: MachineCleanupPayload;
    result: RunnerCleanup;
  };
  /** Nuke this runner (.specs/runner-setup.md "Nuke a runner"): without
   *  `confirm` the plan only; with it and `phrase` exactly NUKE_PHRASE, the
   *  erase starts. Owner only, never on the relay, runner-wide. */
  runnerNuke: {
    payload: RunnerNukePayload;
    result: RunnerNukeResult;
  };
  /** The jobs the default branch declares (.agents/skills/deploy/jobs.json). */
  jobsList: {
    payload: void;
    result: { jobs: RunnerJobInfo[] };
  };
  /** Call a job by name. Never a command: unknown jobs and params that fail
   *  their regex are refused. */
  jobsCall: {
    payload: { job: string; params?: Record<string, string> };
    result: { callId: string };
  };
  /** Cancel a call: a queued or gate-waiting one leaves the queue, a running
   *  one gets SIGTERM (SIGKILL after 10 s). Only the actor who started it or
   *  the runner owner may. `cancelled: false` = it had already ended. */
  jobCancel: {
    payload: { callId: string };
    result: { cancelled: boolean };
  };
  /** Calls that have not ended (queued, waiting-auth, running), from every
   *  path. The owner gets all of them; a member channel only its own. */
  jobsActive: {
    payload: void;
    result: {
      calls: {
        callId: string;
        job: string;
        state: RunnerJobState;
        actor: { userId: string; name: string };
        startedAt: string;
      }[];
    };
  };
  /** A call's state plus its redacted log after `afterSeq`. */
  jobStatus: {
    payload: { callId: string; afterSeq?: number };
    result: {
      state: RunnerJobState;
      exitCode: number | null;
      chunks: { seq: number; text: string }[];
    };
  };
  /** Read the audit log, newest first (owner only). `chainIntact` covers the
   *  whole file, not only the page returned. */
  /** Start the audit log over (owner only). The old log is moved aside on
   *  the runner, not deleted, and the new one opens with an `audit-clear`
   *  line naming who cleared it. */
  auditClear: {
    payload: Record<string, never>;
    result: { cleared: number };
  };
  /** Turn the runner's keep-awake on (until a time, until turned off, or
   *  automatic: while work runs) or off. Runner-wide and the owner's alone.
   *  An older runner ignores `auto` and holds until turned off. */
  keepAwakeSet: {
    payload: {
      on: boolean;
      until: number | null;
      display?: boolean;
      auto?: boolean;
    };
    result: RunnerKeepAwake;
  };
  auditRead: {
    payload: {
      limit?: number;
      beforeTs?: string;
      actorUserId?: string;
      job?: string;
      key?: string;
    };
    result: {
      entries: AuditEntry[];
      chainIntact: boolean;
      firstBrokenTs: string | null;
    };
  };
  /** Encrypted secret updates parked on the runner, waiting for approval. */
  secretsInboxList: {
    payload: void;
    result: { items: SecretsInboxItem[] };
  };
  /** Approve (needs the password) or deny an inbox item. */
  secretsInboxAnswer: {
    payload: {
      id: string;
      password?: string;
      approve: boolean;
      unlockFor?: number;
    };
    result: { success: boolean };
  };
  deployRunCancel: { payload: void; result: { success: boolean } };
  deployRunDismiss: { payload: void; result: { success: boolean } };
  // Run the merged check-environment.sh: a read-only, secret-free preflight
  // proving this machine can run the whole flow ("good to prod push").
  deployCheckEnvironment: {
    payload: void;
    result: {
      ok: boolean;
      checks: { ok: boolean; label: string; detail: string }[];
      output: string;
    };
  };
  // The check failed: AI installs/configures what the failed checks need
  // (env setup only; no repo writes, no secrets), then re-checks.
  // Long-running; streams via the board log.
  deployFixEnvironment: {
    payload: { provider?: AgentProvider };
    result: BoardAgentActionMap['deployCheckEnvironment']['result'];
  };
  // In-flight/settled check+fix state (engine memory), so a reopened modal
  // reattaches instead of losing a running fix.
  deployEnvState: {
    payload: void;
    result: {
      phase: 'idle' | 'checking' | 'fixing' | 'done';
      logs: CardAILogEntry[];
      result: BoardAgentActionMap['deployCheckEnvironment']['result'] | null;
      error: string;
    };
  };
  deployReviseSkill: {
    payload: { feedback: string; provider?: AgentProvider };
    result: BoardAgentActionMap['deployCreateSkill']['result'];
  };
  // Check out a pushed deploy-skill branch (committed as-is) into review;
  // approved revisions become their own commit on that branch.
  deployLoadSkillBranch: {
    payload: { branch: string };
    result: BoardAgentActionMap['deployCreateSkill']['result'];
  };
  // In-flight creator state (engine memory), so a reopened modal reattaches:
  // phase + buffered logs + the last drafted result.
  deployCreatorState: {
    payload: void;
    result: {
      phase: 'idle' | 'working' | 'review';
      logs: CardAILogEntry[];
      draft: BoardAgentActionMap['deployCreateSkill']['result'] | null;
      error: string;
    };
  };
  // Push the previewed draft to a branch; merging it arms the Deploy button.
  deployApproveSkill: {
    payload: void;
    result: { branch: string };
  };
  deployDiscardSkill: {
    payload: void;
    result: { success: boolean };
  };
  // GitHub host-run device-code auth: the frontend passes the public
  // client_id, the host polls GitHub and pushes a `github-auth` event on
  // completion. The token leaves the host once only:
  // on disconnect, to the Factiii server, to be revoked at GitHub.
  githubStartDeviceCode: {
    payload: { clientId: string };
    result: {
      userCode: string;
      verificationUri: string;
      expiresIn: number;
    };
  };
  /** Revokes the token at GitHub (through the Factiii server), then forgets
   *  it on the host whatever came of that. `revoked` false: it is gone here
   *  but may still be valid at GitHub, and the owner should revoke it there.
   *  Absent on a host from before the upstream revoke, which only forgot. */
  githubDisconnect: {
    payload: void;
    result: { success: boolean; revoked?: boolean };
  };
  /** Who the stored GitHub token belongs to; null when not connected. */
  githubIdentity: {
    payload: void;
    result: { login: string; name: string; email: string } | null;
  };
  /** Writable repos for the picker, most-recently-pushed first. With
   *  `connectionId` (owner only), that runner Git connection's, for a board
   *  choosing one before it saves. */
  githubListRepos: {
    payload: { connectionId?: string } | void;
    result: {
      fullName: string;
      cloneUrl: string;
      defaultBranch: string;
      private: boolean;
    }[];
  };
  githubListBranches: {
    payload: { fullName: string; connectionId?: string };
    result: string[];
  };
  // One-click Claude sign-in: start drives `claude auth login` on the host
  // and returns the OAuth URL to open; the pasted code goes back via
  // claudeLoginCode; the outcome arrives on the `claude-auth` event.
  claudeLoginStart: { payload: void; result: { url: string } };
  claudeLoginCode: {
    payload: { code: string };
    result: { success: boolean };
  };
  claudeLoginCancel: { payload: void; result: { success: boolean } };
  claudeLogout: { payload: void; result: { success: boolean } };
  // One-click Codex sign-in: start drives `codex login --device-auth` on the
  // host and returns the verification URL + one-time code to show. The CLI
  // polls OpenAI itself; the outcome arrives on the `codex-auth` event.
  codexLoginStart: { payload: void; result: { url: string; code: string } };
  codexLoginCancel: { payload: void; result: { success: boolean } };
  codexLogout: { payload: void; result: { success: boolean } };
  // The sign-ins above with no board (an empty spaceSlug): Oakbox > Account >
  // Backend's, owner only and never on the relay. The same CLI homes as a
  // board's (agent-homes.ts), so one sign-in serves both. A runner-wide link
  // gets no events, so this is read instead: whether each CLI is signed in,
  // and how its last sign-in from Oakbox went.
  cliSignins: { payload: void; result: RunnerCliSignins };
  // The runner's Git connections (Status > Git, .specs/runner-setup.md
  // "Git connections"): GitHub accounts held once at the runner root, which
  // boards pick from. Runner-wide whether or not a board is named, and the
  // owner's alone. A token never comes back; adding one never rides the
  // relay.
  gitConnections: { payload: void; result: GitConnectionsState };
  gitConnectionAct: {
    payload: GitConnectionActPayload;
    result: GitConnectionsState;
  };
  // The X on a Running jobs row. Only a sign-in or a failed Ask may be closed
  // (activityDismissable); closing a sign-in cancels its flow too.
  activityDismiss: { payload: { id: string }; result: { success: boolean } };
  cardFinalize: {
    payload: {
      postId: string;
      apply: boolean;
      branchName?: string;
      commitMessage?: string;
    };
    result: { applied: boolean; branchName: string };
  };
  cardAnswerQuestion: {
    payload: { postId: string; answer: string };
    result: void;
  };
  cardFeedback: {
    payload: { postId: string; feedback: string };
    result: void;
  };
  cardKill: { payload: { postId: string }; result: void };
  /** Stop a card's headless agent but keep its worktree + conversation so a
   *  terminal can resume the exact thread (terminal takeover). */
  cardHandoff: { payload: { postId: string }; result: void };
  /** Stop the board-level Ask agent and return its resume id + provider, so the
   *  client opens a terminal (on the board key) that resumes the conversation. */
  boardHandoff: {
    /** Which conversation to hand over; none means the most recently used. */
    payload: { conversationId?: string };
    result: { sessionId: string | null; provider: AgentProvider };
  };

  // ── Bare mode: file ops in the card's workspace ──
  bareFsList: {
    payload: { postId: string; path: string };
    result: BareFileNode[];
  };
  bareFsRead: {
    payload: { postId: string; path: string };
    result: { content: string; encoding: 'utf8' | 'base64' };
  };
  bareFsWrite: {
    payload: {
      postId: string;
      path: string;
      content: string;
      encoding: 'utf8' | 'base64';
    };
    result: void;
  };
  bareFsDelete: { payload: { postId: string; path: string }; result: void };
  bareFsMkdir: { payload: { postId: string; path: string }; result: void };
  /** The Explorer's "Upload file…" and a file dropped on a folder: a file
   *  from the user's machine written into the repo at `path`.
   *
   *  Chunked like `terminalDropFile` (same `uploadId` rules, same
   *  TERMINAL_DROP_MAX_BYTES cap, chunks held to `size`): the chunks collect
   *  in a hidden part file in the drops dir, outside the repo, and only the
   *  `last` one moves it to `path`. An existing file there is refused unless
   *  `replace`, so a file made since the client looked is never overwritten.
   *  A runner that predates this answers "Unknown board-agent action". */
  bareFsUpload: {
    payload: {
      postId: string;
      /** Repo path of the file, as for bareFsWrite. */
      path: string;
      content: string;
      /** Client-generated UUID naming the upload these chunks append to. */
      uploadId: string;
      /** Whole file, decoded bytes. */
      size: number;
      last?: boolean;
      /** Overwrite a file already at `path` (the user chose Replace). */
      replace?: boolean;
    };
    result: void;
  };

  /** Drag-and-drop an image onto the terminal: writes the base64 image to the
   *  per-space drops dir and returns the absolute host path to paste.
   *
   *  Sent in chunks, because socket.io drops any single packet over 1MB and a
   *  retina screenshot is bigger than that. Every chunk carries the same
   *  `dropId` and appends to the same file; only the `last` one returns the
   *  path (earlier ones return ''). */
  terminalDropImage: {
    payload: {
      postId: string;
      content: string;
      ext?: string;
      /** Client-generated UUID naming the file this drop appends to. Absent
       *  from a client older than the chunked protocol, which sends the whole
       *  image in one call. */
      dropId?: string;
      /** Closes the drop: prunes old files and returns the path. */
      last?: boolean;
    };
    result: string;
  };

  /** Drag-and-drop or paste any file onto the terminal: appends the base64
   *  chunk to the per-space drops dir and returns the absolute host path to
   *  type (unquoted; the client quotes it with `shellQuotePath`).
   *
   *  Chunked like `terminalDropImage`: every chunk carries the same `dropId`,
   *  `name` and `size`, and only the `last` one returns the path (earlier
   *  ones return ''). The runner keeps the file's own name, made safe, and
   *  picks a free one when the drops dir already holds it. A runner that
   *  predates this answers "Unknown board-agent action". */
  terminalDropFile: {
    payload: {
      postId: string;
      content: string;
      /** Client-generated UUID naming the upload these chunks append to. */
      dropId: string;
      /** The file's name on the client. Untrusted: the runner sanitises it. */
      name: string;
      /** Whole file, decoded bytes. Capped at TERMINAL_DROP_MAX_BYTES; the
       *  chunks may not add up to more, and must add up to exactly this. */
      size: number;
      /** Closes the drop: names the file and returns its path. */
      last?: boolean;
    };
    result: string;
  };

  /** All repo file paths (git-tracked + untracked, gitignore-respecting) for
   * the editor's quick file search. Paths are `/`-prefixed repo-relative. */
  bareFsSearch: {
    payload: { postId: string };
    result: string[];
  };

  /**
   * Snapshot the working tree's git diff against HEAD and move the session into
   * `bare-review`. Frees the user to confirm + push via `cardFinalize`.
   */
  bareReview: {
    payload: { postId: string };
    result: {
      diff: string;
      changedFiles: string[];
      commitMessage: string;
    };
  };

  /**
   * Lightweight peek at the workspace's git state. Does NOT change session
   * phase - used by the git side panel to live-poll while the user is still
   * editing. Covers all three things the panel shows: what is staged, what is
   * not, and what is already committed.
   */
  bareGitStatus: {
    payload: { postId: string };
    result: {
      /** Everything uncommitted (index + working tree) against HEAD. Kept
       *  because a mobile build older than the staged/unstaged split still
       *  reads it. */
      diff: string;
      changedFiles: string[];
      /** Everything below is absent when an older runner answers the call, so
       *  a new client stays readable against one. */
      branch?: string;
      staged?: { files: BareGitFileStatus[]; diff: string };
      unstaged?: { files: BareGitFileStatus[]; diff: string };
      /** Newest first. */
      commits?: BareGitCommit[];
      /** Absent when HEAD tracks no upstream, or from an older runner. */
      upstream?: BareGitUpstream;
      /** What the panel may write here. Absent from a runner older than the
       *  write actions: the panel is then read only. */
      panel?: BareGitPanelInfo;
    };
  };

  /**
   * One working-tree file's two diffs, for the diff pane's line selection:
   * what is included in the next commit (HEAD -> index) and what is not
   * (index -> the file on disk). Read only.
   */
  bareGitFileDiff: {
    payload: { postId: string; path: string };
    result: {
      staged: string;
      unstaged: string;
      /** Whether lines can be moved across (bareGitAct's rule). */
      writable: boolean;
    };
  };

  /**
   * Every write the git panel makes, GitHub Desktop's set: include or exclude
   * files and lines, discard, ignore, commit (and amend), undo and revert a
   * commit, branches (create, switch with or without the changes, rename,
   * delete, merge into the current one), fetch, pull, push or publish, and
   * the stash a switch left behind. `op` is parsed with bareGitOpSchema
   * (validators/runnerGit.ts).
   *
   * Only in the session's own worktree; never a commit or a push on the
   * default branch, and never a force push. Answers with the panel's next
   * state, as the staging calls do.
   */
  bareGitAct: {
    payload: { postId: string; op: BareGitOp };
    result: {
      status: BoardAgentActionMap['bareGitStatus']['result'];
      /** A sentence about what happened that is not an error: a merge that
       *  stopped on conflicts, a push that published the branch. */
      notice?: string;
      /** Undo's commit message, for the commit box to hold again. */
      draft?: { summary: string; description: string };
    };
  };

  /** The patch one commit introduced, fetched when the panel expands it -
   *  history is cheap to list and expensive to diff, so the diff waits for a
   *  click. */
  bareGitCommitDiff: {
    payload: { postId: string; sha: string };
    result: {
      diff: string;
      changedFiles: string[];
      /** changedFiles with each one's status letter. Absent from an older
       *  runner. */
      files?: BareGitFileStatus[];
    };
  };

  /**
   * What this workspace's branch changed against another branch: every file
   * it touched since the two diverged, committed or not pushed alike. The
   * panel's own lists show only what is uncommitted, so a branch whose work is
   * all committed reads as "no changes" without this.
   *
   * One call answers the picker too. `base` absent means "the default": the
   * branch the session was cut from. An empty `base` in the result means there
   * was nothing to compare with.
   */
  bareGitCompare: {
    payload: {
      postId: string;
      base?: string;
      /** View this branch instead of the checked-out one, without checking it
       *  out: one of `branches`. Absent means HEAD. An older runner ignores
       *  it, which the client tells by `head` missing from the result. */
      head?: string;
    };
    result: {
      base: string;
      /** Every branch that can be picked, local and remote, except the
       *  checked-out one. */
      branches: string[];
      files: BareGitFileStatus[];
      diff: string;
      /** Commits here that `base` lacks, and the other way round. */
      ahead: number;
      behind: number;
      /** Everything below is absent from a runner older than branch
       *  viewing. */
      /** The checked-out branch. */
      current?: string;
      /** Which of `branches` are remote-tracking. */
      remoteBranches?: string[];
      /** The branch compared, '' for HEAD. */
      head?: string;
      /** What the head has that `base` lacks, newest first (capped at 100). */
      commits?: BareGitCommit[];
      /** The commits the diff runs between, for fetching either side of a
       *  file with bareGitBlob. */
      mergeBase?: string;
      headSha?: string;
    };
  };

  /**
   * One path's bytes at one revision, so the diff pane can show an image's
   * before and after. `ref` is 'HEAD', 'INDEX' (the staged copy), 'WORKTREE'
   * (the file on disk) or a commit id, optionally with `^` for its parent.
   * Reads only. A path the revision does not have is an error.
   */
  bareGitBlob: {
    payload: { postId: string; ref: string; path: string };
    result: BareGitBlob;
  };

  /**
   * Move paths into the index (`git add`). An empty `paths` stages everything,
   * which is what the section header's + does.
   *
   * Returns the panel's next state rather than void: staging touches only
   * .git/index, and the working-tree watcher prunes .git, so nothing would
   * tell the panel to re-read.
   */
  bareGitStage: {
    payload: { postId: string; paths: string[] };
    result: BoardAgentActionMap['bareGitStatus']['result'];
  };

  /** Take paths back out of the index. Empty `paths` unstages everything. */
  bareGitUnstage: {
    payload: { postId: string; paths: string[] };
    result: BoardAgentActionMap['bareGitStatus']['result'];
  };

  /**
   * List terminal tmux session tab IDs that exist for this card, paired with
   * the label the tab strip shows: the title the foreground program publishes
   * (`pane_title` - claude puts its current task there), falling back to the
   * process name (`pane_current_command` - `bash`, `vim`, ...) when it sets
   * none, so tabs read like VSCode's. Source of truth across modal
   * close/reopen.
   */
  bareListTerminals: {
    payload: { postId: string };
    result: {
      id: string;
      name: string;
      /** tmux is holding the pane open after its process exited
       *  (`remain-on-exit`), so the tab survived a stray `exit`. */
      dead: boolean;
      // No per-tab `stale`: it cost a digest read on the tab strip's poll to
      // draw a dot that was up on every tab. `bareTerminalHealth` answers
      // staleness for a whole board instead.
    }[];
  };

  /**
   * Whether this board's terminals still match what the runner ships. Answers
   * the "your update needs a restart" prompt: `staleTabs` is what a refresh
   * would restart, and `acked` is true once the user has said "skip for this
   * version" to this exact digest.
   *
   * Digest, not runner version: a release that changes nothing about terminals
   * asks nobody, and one that does is caught without anyone maintaining a list.
   */
  bareTerminalHealth: {
    payload: { postIds: string[] };
    result: {
      digest: string;
      acked: boolean;
      staleTabs: { postId: string; tabId: string }[];
    };
  };

  /**
   * The chat view of a terminal session: what the transcript of the card's
   * Claude tab (chatPane.ts) gained since `offset` (chatTranscript.ts). `sessionId`
   * is the conversation `offset` belongs to, '' on the first read. Claude
   * only; the chat falls back to the terminal for a provider it cannot read.
   */
  bareChatTranscript: {
    payload: { postId: string; sessionId: string; offset: number };
    result: ChatTranscript;
  };

  /** Run a chat message as the next turn of the session's headless Claude
   *  (chatRun.ts), or queue it behind the turn running. Closes a Claude open
   *  in the terminal first and carries on its conversation. Resolves once
   *  the turn is under way; the reply comes back through the transcript. */
  bareChatSend: {
    payload: { postId: string; text: string };
    result: void;
  };

  /** Stop the chat's running turn, or with none, the terminal Claude's (Esc
   *  in its tab). */
  bareChatInterrupt: {
    payload: { postId: string };
    result: void;
  };

  /** Open the chat's conversation in the terminal: Claude resumed in the
   *  session's first idle tab, now or once the running turn ends
   *  (chatTerminal.ts). */
  bareChatToTerminal: {
    payload: { postId: string };
    result: ChatTerminalState;
  };

  /** The map behind the chat's /resume: every conversation Claude Code or
   *  Codex recorded for the session's folder, newest first, read from the
   *  CLIs' own session files (chatHistory.ts). */
  bareChatConversations: {
    payload: { postId: string };
    result: ChatConversations;
  };

  /** Carry on a past conversation with the CLI that recorded it, in the
   *  session's first idle tab (`claude --resume <id>`, `codex resume <id>`),
   *  closing whatever agent was open there. A Claude one becomes the chat's
   *  conversation too. */
  bareChatResume: {
    payload: {
      postId: string;
      provider: AgentProvider;
      conversationId: string;
    };
    result: ChatTerminalState;
  };

  /** The chat's shared /clear, /model and /compact, mapped to what the
   *  session's CLI takes (chatCommands.ts). Throws with the reason for one
   *  it cannot take. `message` says what happened. */
  bareChatCommand: {
    payload: { postId: string; command: RunnerChatCommand; arg?: string };
    result: { message: string };
  };

  /** Link a terminal session to a card, or unlink it with '' (the same as
   *  an agent's link_card / unlink_card, session-card-tools.ts). Throws when
   *  there is no such session or `cardId` is not a card's. */
  bareLinkCard: {
    payload: { postId: string; cardId: string };
    result: void;
  };

  /** Record "skip for this version" for the digest the runner is on now, so
   *  the prompt stays down until something about terminals actually changes
   *  again. */
  bareAckTerminalDigest: {
    payload: Record<string, never>;
    result: void;
  };

  /** Restart every stale tab on these posts, keeping each tab. Returns how
   *  many were restarted so the client can say what happened. */
  bareRestartStaleTerminals: {
    payload: { postIds: string[] };
    result: { restarted: number };
  };

  /**
   * Snapshot of the runner-side IDE state: which files are open in the
   * editor tab bar and which of those have unsaved buffers. Used by the
   * client to hydrate on modal mount / browser refresh - the runner is the
   * source of truth so closing the modal doesn't lose tabs or edits.
   */
  bareEditorState: {
    payload: { postId: string };
    result: {
      openedFiles: string[];
      buffers: Record<string, string>;
    };
  };

  /** Add `path` to the runner's opened-files list (idempotent). */
  bareOpenFile: {
    payload: { postId: string; path: string };
    result: void;
  };

  /** Remove `path` from openedFiles and discard any buffered edits for it. */
  bareCloseFile: {
    payload: { postId: string; path: string };
    result: void;
  };

  /**
   * Write the editor's current buffer to the runner. Distinct from
   * `bareFsWrite` - this only holds unsaved edits in memory; the file on
   * disk isn't touched until the user explicitly saves.
   */
  bareBufferSet: {
    payload: { postId: string; path: string; content: string };
    result: void;
  };

  /**
   * Everything the card's terminals are running, with the ports each process
   * listens on. Polled while the task manager is open, so it stays a read: it
   * starts nothing and kills nothing.
   */
  bareListProcesses: {
    payload: { postId: string };
    result: BareProcess[];
  };

  /**
   * Ask one of this card's processes to stop (SIGTERM). Refuses any pid that
   * is not in the card's own tmux process tree, so the panel can never signal
   * something that belongs to the machine or to another card.
   */
  bareKillProcess: {
    payload: { postId: string; pid: number };
    result: void;
  };

  /**
   * Open a public tunnel to a local port via frpc (runs factiii-expose).
   * Returns the live tunnel incl. its public URL.
   */
  bareExpose: {
    payload: { postId: string; port: number; name: string };
    result: ExposedPort;
  };

  /** Tear down a named tunnel (runs factiii-unexpose). */
  bareUnexpose: {
    payload: { postId: string; name: string };
    result: void;
  };

  /** The session's currently-open port tunnels. */
  bareListExposed: {
    payload: { postId: string };
    result: ExposedPort[];
  };

  // ── Scratchpad: the space's display surface (see .specs/scratchpad.md) ──
  //
  // Space-scoped, not per session: a scratchpad outlives the terminal that
  // drew on it, and every session on the board looks at the same one.
  scratchpadList: { payload: Record<string, never>; result: ScratchpadItem[] };
  scratchpadRead: {
    payload: { name: string };
    result: { content: string; encoding: 'base64' };
  };
  /** One byte range, for downloading an item the preview cap refuses to
   *  inline. Reading a 200MB recording as a single base64 string would pin the
   *  channel and the browser's memory; a range at a time streams. */
  scratchpadReadChunk: {
    payload: { name: string; offset: number; length: number };
    result: { content: string; encoding: 'base64' };
  };
  scratchpadDelete: { payload: { name: string }; result: void };
  scratchpadClear: { payload: Record<string, never>; result: void };

  // ── Vault backups: the owner's phone vault, held by the runner ──
  //
  // Runner-wide and owner-only (see .specs/mobile-vault.md "Runner backup"): sent with
  // an empty `spaceSlug`, answered by the daemon itself and not by a board's
  // engine, and never open to a member whatever their level. The bytes
  // are the passphrase-protected package the phone also uploads to our bucket;
  // no passphrase and no key ever travels with them.

  /** Append one base64 chunk to an upload. `offset` is how many bytes the
   *  client has already sent (0 starts the upload); a runner holding any other
   *  amount drops the upload and refuses. On `last` the runner checks `size`,
   *  moves the file into place under a name it picks, prunes old packages and
   *  answers with that name; before that `name` is null. */
  vaultBackupWrite: {
    payload: {
      uploadId: string;
      offset: number;
      content: string;
      last?: boolean;
      /** The whole package's byte count. Checked on `last`. */
      size?: number;
    };
    result: { name: string | null; received: number };
  };
  /** The packages this runner holds, newest first. */
  vaultBackupList: {
    payload: Record<string, never>;
    result: { backups: RunnerVaultBackupItem[] };
  };
  /** One byte range of a package, like `scratchpadReadChunk`. */
  vaultBackupReadChunk: {
    payload: { name: string; offset: number; length: number };
    result: { content: string; encoding: 'base64' };
  };
  vaultBackupDelete: { payload: { name: string }; result: void };

  // ── The Vault (.specs/runner-vault.md "Actions") ──
  //
  // Runner-wide like the backups: an empty `spaceSlug`, answered by the
  // daemon before any board. Open to the owner and to the members the owner
  // let in (the server vouches the share, the runner holds its own list).
  // Never carried by the server's relay: vault files only travel on a direct
  // link.

  // Every one of these takes `store` (RunnerStoreName): which of the
  // runner's two stores it acts on. None is the Vault, except where said:
  // a list, a search, a status and a lookup by id with none read both.

  vaultStatus: {
    payload: { store?: RunnerStoreName };
    result: RunnerVaultStatus;
  };
  /** Newest first. `query` (2+ characters) narrows to files whose path or
   *  text has the words, as the cloud vault's `files` does. `before` is the
   *  last row's id, for the next page.
   *  @deprecated Kept for one runner release: `vaultRpc` `files`
   *  (.specs/vault-router.md → Compatibility). */
  vaultFiles: {
    payload: {
      query?: string;
      limit?: number;
      before?: string;
      store?: RunnerStoreName;
    };
    result: { files: RunnerVaultFile[]; more: boolean };
  };
  /** Oakbox's search, run on the runner (.specs/runner-vault.md "Search
   *  across vaults"): the words in a file's name or text first; with none,
   *  the query embedded here and ranked by `<=>`. The query never leaves the
   *  direct link.
   *  @deprecated Kept for one runner release: `vaultRpc` `search`, or
   *  `files` with `meaning`. */
  vaultSearch: {
    payload: { query: string; limit?: number; store?: RunnerStoreName };
    result: { hits: RunnerVaultHit[]; mode: RunnerVaultSearchMode };
  };
  /** A signed write for one file (an R2-style presigned PUT). */
  vaultUploadStart: {
    payload: {
      name: string;
      size: number;
      contentType: string;
      /** Where the file goes; none is the Vault. */
      store?: RunnerStoreName;
    };
    result: { ticket: string };
  };
  /** One base64 range of a signed write. The last one stores the file and
   *  answers with its row. */
  vaultWrite: {
    payload: {
      ticket: string;
      offset: number;
      content: string;
      last?: boolean;
    };
    result: { received: number; file: RunnerVaultFile | null };
  };
  /** A signed read for one file (an R2-style presigned GET).
   *  @deprecated Kept for one runner release: `vaultRpc` `downloadUrl`,
   *  whose ticket `vaultRead` redeems as before. */
  vaultDownload: {
    payload: { uploadId: string; store?: RunnerStoreName };
    result: { ticket: string; size: number; name: string; contentType: string };
  };
  vaultRead: {
    payload: { ticket: string; offset: number; length: number };
    result: { content: string; encoding: 'base64' };
  };
  /** The caller's own files only; another account's are kept and counted.
   *  @deprecated Kept for one runner release: `vaultRpc` `deleteFiles`. */
  vaultDelete: {
    payload: { uploadIds: string[]; store?: RunnerStoreName };
    result: { deleted: number; kept: number };
  };
  /** One procedure of the shared vault router (@shared/vault-router,
   *  .specs/vault-router.md → Transports), answered by the runner's adapter:
   *  the same procedure, input and output as on the server. `result` is
   *  SuperJSON-encoded, as the server's tRPC transformer encodes it, so one
   *  client link reads both. So far `files`, `search`, `downloadUrl` and
   *  `deleteFiles`. */
  vaultRpc: {
    payload: {
      path: 'files' | 'search' | 'downloadUrl' | 'deleteFiles';
      input?: unknown;
      /** The store the procedure runs on; none is the Vault. */
      store?: RunnerStoreName;
    };
    result: { json: unknown; meta?: unknown };
  };
  /** Owner only: let a vault peer in, or take them out. */
  vaultShareSet: {
    payload: { memberId: string; shared: boolean };
    result: RunnerVaultStatus;
  };
  /** Oakbox Ask on the runner (.specs/runner-vault-ask.md "Ask with a runner's
   *  model"): what the caller may ask with. Claude and Codex for the owner
   *  only. */
  vaultAskModels: {
    payload: Record<string, never>;
    result: RunnerAskModels;
  };
  /** Start one turn: search the Vault, then answer with the picked model.
   *  `history` is the thread so far (the app holds it). Answers at once with
   *  the turn's id; `vaultAskPoll` reads it as it is written. */
  vaultAsk: {
    payload: {
      engine: RunnerAskEngine;
      /** The Ollama tag; none for Claude or Codex. */
      model?: string;
      question: string;
      history?: { role: 'you' | 'answer'; text: string }[];
      /** The runner chat this question continues; none starts one. The
       *  runner then answers from the chat's own messages, not `history`. */
      chatId?: string;
      /** Files added to this question in Ask, by their Vault id: read
       *  before anything the search finds. */
      fileIds?: string[];
      /** Claude's or Codex's model and effort from Account > Backend; none
       *  runs the CLI's defaults. */
      cli?: CliAskSettings;
      /** AI Research's factiii id from Factiii's tree: the tag a note the
       *  model keeps this turn carries. None keeps it untagged. */
      aiResearchId?: number | null;
      /** Factiii's category tree, for the tag and category tools; none
       *  leaves them out. */
      categories?: RunnerCategoryTree;
      /** The store the turn reads. None is the Vault, where only Ollama
       *  may ask; a follow-up (`chatId`) runs in its chat's store. */
      store?: RunnerStoreName;
    };
    /** `chatId`: the chat the turn is saved in, new or continued. */
    result: { askId: string; chatId: string };
  };
  /** The turn so far. Only the account that started it reads it. */
  vaultAskPoll: {
    payload: { askId: string };
    result: RunnerAskState;
  };
  /** Stop a running turn: its Claude or Codex process tree is killed, or its
   *  Ollama request aborted, and nothing of its answer is saved. The account
   *  that started it, or the owner. Answers the turn once it has stopped (a
   *  turn already done is answered as it ended). */
  vaultAskCancel: {
    payload: { askId: string };
    result: RunnerAskState;
  };
  /** The caller's Ask chats on this runner, newest first. Kept in the
   *  runner's Vault database, never on Factiii's server. */
  vaultChats: {
    payload: Record<string, never>;
    result: { chats: RunnerAskChat[] };
  };
  /** One of the caller's chats, with its messages. */
  vaultChat: {
    payload: { chatId: string; store?: RunnerStoreName };
    result: { chat: RunnerAskChat; messages: RunnerAskChatMessage[] };
  };
  /** Delete one of the caller's chats, for good. */
  vaultChatDelete: {
    payload: { chatId: string; store?: RunnerStoreName };
    result: { deleted: boolean };
  };
  /** Categorize on the runner (.specs/runner-vault-ask.md "Categorize on the
   *  runner"), owner only: the category tree comes with the start, the tags
   *  stay on the runner. */
  vaultCategorizeStatus: {
    payload: { store?: RunnerStoreName };
    result: RunnerCategorizeStatus;
  };
  /** Start one run over every file waiting. Answers at once; one at a time. */
  vaultCategorizeStart: {
    payload: RunnerCategorizePayload & { store?: RunnerStoreName };
    result: RunnerCategorizeStatus;
  };
  /** Stop the run: the model call in flight is aborted, and its file stays
   *  waiting. */
  vaultCategorizeCancel: {
    payload: { store?: RunnerStoreName };
    result: RunnerCategorizeStatus;
  };
  /** One file's page, owner only: what was read off it and its categories
   *  (.specs/runner-vault-ask.md "A runner file's page"). */
  vaultFilePost: {
    payload: { uploadId: string; store?: RunnerStoreName };
    result: RunnerVaultFilePost;
  };
  /** The notes kept from runner Ask answers, newest first, owner only.
   *  With `noteId`, that one note alone (a search hit opening it). Ask's
   *  model keeps them with its save tool (vault/ask.ts). */
  vaultNotes: {
    payload: { noteId?: string; store?: RunnerStoreName };
    result: { notes: RunnerVaultNote[] };
  };
  /** Delete one note for good. */
  vaultNoteDelete: {
    payload: { noteId: string; store?: RunnerStoreName };
    result: { deleted: boolean };
  };
  /** Move to… (.specs/runner-vault.md "Two stores"), owner only: copy the
   *  owner's files into the other store, then delete them where they were.
   *  The copy is read and embedded again there; its tags stay behind. Each
   *  file's new row, and why any did not move. */
  vaultMove: {
    payload: { uploadIds: string[]; to: RunnerStoreName };
    result: {
      moved: { from: string; file: RunnerVaultFile }[];
      failed: { uploadId: string; error: string }[];
    };
  };
  /** Oakbox > Account > Backend's models (.specs/runner-vault-ask.md "Oakbox's
   *  backend: setup, sign-ins, models"): what Ollama holds, the table with its fit, machine health
   *  and the last pull or remove. Owner only, runner-wide, never on the
   *  relay. */
  localAiList: {
    payload: Record<string, never>;
    result: RunnerLocalAiModels;
  };
  /** Start pulling any Ollama model, or removing one, in the background,
   *  and answer at once; the list's `job` then reports it. */
  localAiAct: {
    payload: LocalAiActPayload;
    result: RunnerLocalAiModels;
  };
  /** A Factiii AI feature run on the owner's runner instead of on Trons
   *  (.specs/oakbox.md "Backend" → AI features): a prompt in, the answer's
   *  text out, no tools and no Vault. Owner only, runner-wide, never on the
   *  relay. */
  aiPrompt: {
    payload: AiPromptPayload;
    result: { text: string; engine: 'claude' | 'codex' | 'ollama' };
  };
  /** Search ollama.com from the runner, never from Factiii's server: a
   *  query's models, or one model's tags with whether each fits. */
  localAiSearch: {
    payload: LocalAiSearchPayload;
    result: RunnerLocalAiSearch;
  };

  // ── Simulator: the space's iOS simulator panel ──
  //
  // Space-scoped like the scratchpad, and for the same reason: the simulator
  // belongs to the machine, not to whichever terminal happens to be open on it.

  simulatorList: { payload: Record<string, never>; result: SimulatorDevice[] };
  /**
   * Which simulators are booted.
   *
   * A set, not "the booted one": several can run at once, and the panel's
   * auto-open has to fire when a *new* one starts rather than when any is up.
   */
  simulatorStatus: {
    payload: Record<string, never>;
    result: { booted: string[] };
  };
  /** Start pushing frames. Re-attaching with the same options is a no-op; new
   *  options restart the encoder, whose output size is fixed at session start. */
  simulatorAttach: {
    payload: { udid: string; width: number; fps: number; bitrate: number };
    result: void;
  };
  simulatorDetach: { payload: Record<string, never>; result: void };
  simulatorInput: { payload: SimulatorInput; result: void };

  // ── Credential store (runner-wide, owner only) ──
  //
  // Not board-scoped: the store spans every board on the machine, so a member
  // the runner is shared with cannot act on it. The daemon enforces that
  // before dispatch. The connection password itself is gone (runner
  // secureActions.ts).

  /** Current protection state, including the fix text when it isn't usable. */
  secureStatus: { payload: void; result: SecureStoreStatus };
  /** The one use the old connection password still has: release the files an
   *  older runner locked behind it. They are converted and the password is
   *  removed, so the status that comes back usually has none. */
  secureUnlock: { payload: { password: string }; result: SecureStoreStatus };
};

export type BareFileNode = {
  name: string;
  /** Path relative to the repo root. */
  path: string;
  type: 'file' | 'dir';
};

export type ExposedPort = {
  name: string;
  port: number;
  url: string;
};

// The runner owner's view of who and what is on their machine (.specs/
// runner-window.md "Remote connections"). Owner only, runner-wide, asked with
// no board (daemon.ts), like partsList.

/** A person, as the server vouched for a link to the runner. */
export type RunnerPerson = {
  userId: number | null;
  name: string;
  role: 'owner' | 'member';
};

/** One open link to the runner: a browser, the desktop app or a phone. */
export type RunnerLinkView = RunnerPerson & {
  /** Stable while the link is open; opaque. */
  id: string;
  /** `direct`: WebRTC or a tunnel straight to the runner. `socket`: relayed
   *  through factiii.com. */
  transport: 'direct' | 'socket';
  /** The boards the link was vouched for; null: every board (the owner). */
  boards: string[] | null;
  connectedAt: number;
  /** This is the link the question came on. */
  you: boolean;
  /** Terminals this link has open (attached) now. */
  terminals: number;
};

/** A live terminal on the runner that someone other than its owner started. */
export type RunnerRemoteSession = {
  postId: string;
  spaceSlug: string;
  title: string;
  startedBy: RunnerPerson;
  startedAt: number;
  /** The public links it opened, as on the session's own row. */
  exposed: ExposedPort[];
};

/** The runner's embedder (vault search), started on first use and stopped
 *  when idle. */
export type RunnerEmbedderView = {
  state: 'ready' | 'missing' | 'unsupported';
  /** Its process is up now. */
  running: boolean;
  port: number | null;
  /** Files waiting, embedded and failed, from the vault's ingest. */
  pending: number;
  embedded: number;
  failed: number;
  /** What it is embedding now, if anything. */
  current: string | null;
};

/** A public link a terminal opened, with the terminal it belongs to. */
export type RunnerExposedView = ExposedPort & {
  postId: string;
  spaceSlug: string;
  title: string;
};

export type RunnerConnections = {
  links: RunnerLinkView[];
  remoteSessions: RunnerRemoteSession[];
  /** Null when the runner has no embedder part at all. */
  embedder: RunnerEmbedderView | null;
  /** The machine's services (docker, pm2, launchd, listening ports), as
   *  partsList's health reads them. */
  services: RunnerService[];
  /** Every terminal's public links, across boards. */
  exposed: RunnerExposedView[];
  at: number;
};

/** What runnerLogs reads. */
export type RunnerLogSource =
  | { kind: 'service'; service: RunnerService['kind']; name: string }
  | { kind: 'embedder' }
  /** A terminal's tab, as its screen shows now (tmux's scrollback).
   *  No `tabId`: the session's first tab. */
  | { kind: 'session'; spaceSlug: string; postId: string; tabId?: string };

export type RunnerLogTail = {
  /** The last lines, oldest first. Empty when there is nothing to show. */
  text: string;
  /** What was read, for the panel's title ("pm2 logs embedder"). */
  label: string;
  /** Why there is no text, when there is none ("launchd keeps no log"). */
  note?: string;
  at: number;
};

/** One process a card's terminals are running, as the task manager lists it.
 *  Everything a user starts in a tab is a descendant of that tab's shell, which
 *  is what ties a process to a card rather than to the machine. */
export type BareProcess = {
  pid: number;
  /** The tab it belongs to, numbered as bareListTerminals numbers them. */
  tabId: string;
  /** The binary, without its path: 'node', 'claude', 'vite'. */
  command: string;
  /** The full command line. */
  args: string;
  /** Percent of one core, as ps reports it. */
  cpu: number;
  /** Resident memory in KB. */
  memoryKb: number;
  /** How long it has been up: [[dd-]hh:]mm:ss. */
  elapsed: string;
  /** TCP ports it accepts connections on. Empty for most processes. */
  ports: number[];
  /** Connections currently established. The honest stand-in for bandwidth,
   *  which macOS will not report per-process without elevated privileges. */
  connections: number;
};

/**
 * A coalesced batch of working-tree changes made by someone other than the
 * editor - the card's agent, the terminal, or a git operation. Paths are
 * repo-relative and `/`-prefixed, same as `BareFileNode.path`.
 */
export type BareFsChange = {
  added: string[];
  changed: string[];
  removed: string[];
  /** Too many paths to be worth patching (a checkout, an install, a build):
   *  every list is empty and the client should refetch what it displays. */
  resync: boolean;
  /** The watch died under a live session (the OS ran out of watches). What's
   *  on screen is frozen from here, so the UI falls back to a manual refresh
   *  rather than pretending to be live. A session ENDING is silent - its
   *  session-update already says so. */
  stopped?: boolean;
  /** HEAD or a ref moved (a commit, a checkout, a new branch: the agent runs
   *  git itself in this tree). Every list is empty: nothing on disk is named,
   *  only the git panel needs to read again. Older clients take it as an empty
   *  batch, which still wakes their panel. */
  git?: boolean;
};

export type BoardAgentAction = keyof BoardAgentActionMap;

/** Discriminated union - switch on `msg.action` narrows `msg.payload` automatically. */
export type BoardAgentMessage = {
  [A in BoardAgentAction]: {
    action: A;
    spaceSlug: string;
    // Stable board id (slugs can change).
    // Optional for back-compat with older clients that only send the slug;
    // the engine falls back to slug-based naming when absent.
    spaceId?: number;
    payload: BoardAgentActionMap[A]['payload'];
  };
}[BoardAgentAction];

export type BoardAgentEventMap = {
  log: CardAILogEntry;
  status: string;
  'setup-status': string;
  'session-update': CardAISessionSummary;
  'session-removed': { postId: string };
  // Space-level work that isn't a card session (Ask Board, deploy, setup,
  // sign-ins). `state: null` retires the row.
  'activity-update': RunnerActivity;
  // Pushed by the host when the GitHub device-code flow finishes. Carries the
  // resolved identity so the UI can show "Connected as @x" without a refetch.
  'github-auth': {
    status: 'complete' | 'expired' | 'declined' | 'error';
    message?: string;
    login?: string;
  };
  // Pushed by the host when the one-click Claude sign-in finishes (the host
  // drives the CLI itself; the client only opens the URL and relays the code).
  'claude-auth': { status: 'complete' | 'error'; message?: string };
  // Pushed by the host when the one-click Codex device-auth finishes (the CLI
  // polls OpenAI itself; the client only shows the URL + code).
  'codex-auth': { status: 'complete' | 'error'; message?: string };
  // Creator session settled (drafted or failed) - a reopened modal refetches
  // deployCreatorState on this signal.
  'deploy-creator': { phase: 'review' | 'error'; error?: string };
  // Deploy run transitioned; clients refetch deployRunState.
  'deploy-run': { phase: string };
  // Env check/fix settled; clients refetch deployEnvState.
  'deploy-env': { phase: 'done' | 'error' };
  // A command somewhere in this space is waiting on the owner's store
  // password, or has stopped waiting. Carries only whether something is
  // pending; the detail comes from secretsAuthState, so a stale broadcast
  // cannot leave a prompt on screen for an answered request.
  'secrets-auth': { pending: boolean };
  // A write changed which keys the store holds, from any client, the CLI or
  // an import; the attention badge re-asks.
  'secrets-changed': { at: number };
  /** Sent to one member when the owner changed their level on this board. */
  'runner-access': RunnerAccessState;
  // The space's scratchpad changed on disk. Carries no paths: the panel holds a
  // whole flat listing and refetching it is one small call.
  scratchpad: { at: number };
  [key: `log:${string}`]: CardAILogEntry;
  // Working-tree changes for one bare session, keyed by its postId so an open
  // modal only wakes for its own card.
  [key: `bare-fs:${string}`]: BareFsChange;
};

// Setup status lines share one channel (emitSetupStatus). A line carrying this
// prefix is streamed LOG output and accumulates in the setup log block; a plain
// line is the current step label and replaces the previous one. Same split the
// Docker image build used, when BuildKit's own "#" prefix did the marking.
export const SETUP_LOG_PREFIX = '\u0001log ';

// Initialize needs the owner's sudo password to install a system package (or
// to bootstrap Homebrew). A line with this prefix carries the reason and pauses
// setup until `setupAuthorize` answers. ONLY the runner's own toolchain
// commands ever ask: the agent protocol has no path to sudo, deliberately.
export const SETUP_AUTH_PREFIX = '\u0001sudo ';

// An extra's install (`environmentInstall`) on the same channel: its log lines
// and password request carry this prefix ahead of the two above, so the setup
// phase, which is Initialize's, never takes them for its own progress.
export const SETUP_EXTRA_PREFIX = '\u0001extra ';

// The Tailscale extra's sign-in line in that log, from runners 0.33 and
// earlier (0.34 no longer installs Tailscale): the app reads the link after it
// and shows it as a button, since a link in a log cannot be tapped on a phone.
export const TAILNET_SIGNIN_PREFIX = 'Sign in to Tailscale: ';

// ── Bare mode: interactive shell into the card's workspace ──
// Multiplexed over the existing IPC/data-channel transport. Each terminal
// is identified by an opaque sessionId minted by the client; the runner
// does not need to remember it across reconnects.

export type TerminalClientMessage =
  | {
      type: 'terminal';
      op: 'open';
      sessionId: string;
      postId: string;
      cols: number;
      rows: number;
      /**
       * Stable tab key. Maps to a named tmux session, so
       * closing/reopening the modal reattaches to the same shell.
       */
      terminalKey: string;
      /**
       * When set, this tab boots straight into the card's agent conversation
       * (`claude --resume <id>` / `codex resume <id>`) instead of a bare
       * prompt. Only honoured on tmux session *creation* — reopening the
       * modal reattaches to the already-running agent rather than launching
       * a second one. Exiting the agent drops to a normal shell.
       */
      resumeAgentSessionId?: string;
      /** Which CLI owns `resumeAgentSessionId`. Defaults to claude. */
      resumeProvider?: AgentProvider;
      /**
       * This tab belongs to a card and should start a NEW agent pointed at it.
       * The card's text is never sent: the runner writes an opening prompt
       * naming the card's uuid, and the agent reads it through the
       * factiii-board MCP.
       *
       * Ignored when `resumeAgentSessionId` is set — a resumed thread already
       * knows the card — and, like resume, only honoured on tmux session
       * creation.
       */
      briefCard?: boolean;
      /**
       * A new session's first tab, opened on the Terminal: start the board's
       * default for new terminals (Claude Code, Codex, its own command or a
       * plain shell; the runner reads which from the board's settings).
       * Ignored with a resume or a card brief, while the chat holds the
       * conversation, and on a tab that already exists.
       */
      bootDefault?: boolean;
    }
  | { type: 'terminal'; op: 'stdin'; sessionId: string; data: string }
  | {
      type: 'terminal';
      op: 'resize';
      sessionId: string;
      cols: number;
      rows: number;
    }
  | { type: 'terminal'; op: 'close'; sessionId: string }
  /** Destroy the underlying tmux session entirely (used when the user
   *  explicitly closes a tab; plain `close` only detaches). */
  | {
      type: 'terminal';
      op: 'kill';
      postId: string;
      terminalKey: string;
    }
  /** Kill what the tab is running and start a fresh shell in the SAME tmux
   *  session, so the tab keeps its place while the processes in it die.
   *  Unlike `kill`, the tab survives; unlike `close`, the shell does not. */
  | {
      type: 'terminal';
      op: 'restart';
      postId: string;
      terminalKey: string;
    };

export type TerminalServerMessage =
  | { type: 'terminal'; op: 'opened'; sessionId: string }
  | { type: 'terminal'; op: 'stdout'; sessionId: string; data: string }
  | {
      type: 'terminal';
      op: 'exit';
      sessionId: string;
      code: number | null;
      reason?: string;
    }
  | { type: 'terminal'; op: 'error'; sessionId: string; message: string };

/** The name the client opens its detached terminal window under. Shared: the
 *  desktop shell keys on it to tell an app window from a clicked link. */
export const TERMINAL_WINDOW_NAME = 'factiii-terminal';

/** A backup file, its passphrase, and the password of the board it is
 *  imported into. */
type SecretsBackupImportRequest = {
  bundle: string;
  passphrase: string;
  /** The password of the board the backup is imported into. */
  targetPassword: string;
};

/** One secret a backup holds, picked for import. `conflict` decides a name
 *  the board already holds with another value. */
export type BackupImportPick = { name: string; conflict?: 'keep' | 'take' };

/** A backup beside the board it would be imported into. Never a value: a
 *  masked tail for a key, a size for a file. `current` is the board's own
 *  secret of that name, null when it has none; `same` means the two are equal,
 *  so there is nothing to choose. */
export type SecretsBackupImportPlan = {
  board: string;
  createdAt: string;
  secrets: {
    name: string;
    masked: string;
    current: { masked: string; same: boolean } | null;
  }[];
  files: {
    name: string;
    size: number;
    current: { size: number; same: boolean } | null;
  }[];
};

/** A backup file, opened (`secretsOpenBackup`). */
export type OpenedSecretsBackup = {
  /** The board the backup says it is of, and when it was made. */
  board: string;
  createdAt: string;
  secrets: { name: string; value: string; description: string }[];
  /** File secrets. `data` is base64, or null when the file is too large to
   *  send to the page. */
  files: { name: string; size: number; data: string | null }[];
};
