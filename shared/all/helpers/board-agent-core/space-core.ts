import { chmod, copyFile, mkdir, readFile } from 'fs/promises';
import path from 'path';

import {
  type GitConnectionChoice,
  type PendingSecretsAuth,
  type RunnerJobInfo,
  type RunnerJobState,
  type RunnerJobTargetWait,
  type SecureStoreStatus,
  SETUP_LOG_PREFIX,
  type TerminalDefault
} from '../../domains/electron';
import { likelyStoredAs } from '../similarSecretKey';
import { TERMINAL_FP_OPTION, terminalDigest } from '../terminal-ai/digest';
import { terminalInitScript } from '../terminal-ai/initScript';
import { markOnboardingComplete } from './agent';
import { cliHomes } from './agent-homes';
import { AuditLog } from './audit';
import { type BoardMcpChannel, openBoardMcpRelay } from './board-mcp-relay';
import { writeCodexConfig } from './codex-config';
import { type CodexAccess, resolveCodexAccess } from './codex-permissions';
import { removeDefaultHomeLeftovers } from './default-home-cleanup';
import {
  cleanTerminalCommand,
  resolveTerminalDefault
} from './git-connections';
import {
  allocateSpacePorts,
  type ExecTarget,
  hostTarget,
  isSessionToken,
  spaceSecret
} from './exec';
import {
  buildCloneUrl,
  ensurePrimaryClone,
  listRemoteBranches,
  listWorkNames,
  pruneWorktrees,
  setGitIdentity,
  setPrimaryCloneOrigin,
  setSessionCredentialHelper,
  stripCloneUrlCredentials
} from './git';
import { checkDeployStatus, stripWorkspaceOriginToken } from './host-deploy';
import {
  adoptRunnerKey,
  ensureSecretsDir,
  readSecretMeta,
  spaceKeyDir,
  storedSecretFiles,
  storedSecretKeys
} from './host-secrets';
import { loginCredentialsExist } from './login-exec';
import {
  BOARD_MCP_BIN,
  MARKETPLACE_NAME,
  PLUGIN_ID,
  pluginRoot,
  renderPlugin,
  SECRETS_BIN
} from './plugin';
import { sessionPortBlocks } from './port-blocks';
import {
  type AgentProvider,
  codexMcpName,
  oneDriveMcpName,
  resolveProvider,
  SECRETS_TOKEN_ENV
} from './providers';
import { describeSecret } from './secret-descriptions';
import {
  NO_BOARD_MCP,
  NO_GITHUB,
  NO_TUNNELS,
  type SecretsBridge,
  type SecretsKeyInfo,
  secretsSocketPath,
  startSecretsBridge
} from './secrets-bridge';
import { OPS_FREE_COMMAND_REFUSED } from './ops-link';
import { SecretsGate, UNATTRIBUTED } from './secrets-gate';
import {
  writeClaudeSecretsRules,
  writeCodexSecretsRules
} from './secrets-permission';
import { authorizeAndRun, containedCwd } from './secrets-run';
import { UnlockWindow } from './secrets-window';
import type { AgentEventSink, CardAIConfig, ConfigProvider } from './session';
import { ActivityTracker } from './session';
import { type SessionLinks, withSessionCardTools } from './session-card-tools';
import type { HypervisorHost } from './session-hypervisor';
import { ensureRedis, ensureStateStore } from './state';
import {
  ensureTmuxResurrect,
  keepOneTmuxPane,
  respawnTmuxPane,
  resurrectRestore,
  safeTmuxName,
  setTmuxSessionOption,
  sourceTmuxConf,
  tmuxPanePaths,
  unclaimedTmuxRestores,
  withTmuxRestoreTurn
} from './tmux';
import { ensureToolchain, type RequestSudo } from './toolchain';

/** Thrown at a board MCP caller whose session token is not the session's. */
const SESSION_MISMATCH =
  'This session token is not the one of the session it names. The board tools work for the session the runner started this shell in.';

/** A git URL reduced to host+path, so a clean and a token-bearing clone URL
 *  for the same repo compare equal. */
function repoIdentity(url: string): string {
  return url
    .replace(/^https?:\/\//, '')
    .replace(/^[^@/]*@/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

export interface SpaceCoreOptions {
  spaceSlug: string;
  /** Stable board id (slugs can change). Optional for back-compat with
   *  callers that only have the slug. */
  spaceId?: number;
  emitter: AgentEventSink;
  configProvider: ConfigProvider;
  /** The runner's access token: what the server's board MCP and frps take.
   *  Set on the headless runner; unset on desktop. A function when the token
   *  can change under a running engine (the runner refreshes it), so each use
   *  reads the current one. It is never copied into a session: the board MCP
   *  is relayed by this process over the secrets socket, and a tunnel asks
   *  for it over the same socket when it opens (.specs/runner-link.md, "Runner
   *  credential service"). */
  runnerToken?: string | (() => string);
  /** factiii API base URL, for the server-hosted board MCP. */
  serverUrl?: string;
  /** Ask the owner for their sudo password when Initialize must install a
   *  system package. Only the runner's own toolchain commands use this. */
  requestSudo?: RequestSudo;
  /** Told once per new request on the secrets gate, so a shared runner can ask
   *  the server to push its approvers. Names only ever reach it. */
  onGateOpen?: (request: PendingSecretsAuth) => void;
  /** The runner's owner, server-vouched, as the actor of a job a session ON
   *  this runner calls through the bridge. Absent = an anonymous 'Owner'. */
  ownerActor?: () => { userId: string; name: string };
  /** The runner's boards and access levels, for the board MCP's hypervisor
   *  tools (session-hypervisor.ts). Set by the daemon, which holds every
   *  board's engine; absent on desktop, whose MCP has no hypervisor tools. */
  hypervisor?: HypervisorHost;
  /** Where this board's sessions run, given the host target: the dev VM
   *  (.specs/dev-vm.md, apps/runner/src/devVm) when the runner turns it on.
   *  Absent: on this host, as always. What must stay on the host (sign-ins,
   *  the simulator) asks for `hostTarget()` instead. */
  sessionTarget?: (host: ExecTarget) => ExecTarget;
}

/** What the engine lends the bridge so a session on this runner can call
 *  jobs (secrets-bridge.ts job ops). Set by the engine; null until then. */
export type LocalJobs = {
  list: () => Promise<RunnerJobInfo[]>;
  call: (
    job: string,
    params: Record<string, string>,
    actor: { userId: string; name: string },
    from: string
  ) => Promise<{ callId: string }>;
  status: (
    callId: string,
    afterSeq: number
  ) => {
    state: RunnerJobState;
    exitCode: number | null;
    chunks: { seq: number; text: string }[];
    wait?: RunnerJobTargetWait;
  };
  cancel: (
    callId: string,
    actor: { userId: string; name: string }
  ) => Promise<{ cancelled: boolean }>;
};

/** Shared plumbing for both AI modes: config, workspace, setup, exec target.
 *  One instance, injected into both, so their config reads can't diverge. */
export class SpaceCore {
  readonly spaceSlug: string;
  readonly spaceId: number | null;
  readonly emitter: AgentEventSink;
  readonly configProvider: ConfigProvider;
  private readonly runnerTokenSource?: string | (() => string);
  readonly serverUrl?: string;
  readonly requestSudo?: RequestSudo;
  /** Everything this space's runner does that isn't a card session — Ask Board,
   *  deploys, setup, indexing, sign-ins. Lives here rather than on the engine
   *  so both mode engines and the core's own setup path can report. */
  readonly activity: ActivityTracker;

  // Positive-only cache per provider: true sticks until sign-out, false is
  // re-probed (an in-terminal login can flip it).
  private loggedIn: Partial<Record<AgentProvider, boolean>> = {};

  setLoggedIn(provider: AgentProvider, value: boolean): void {
    this.loggedIn[provider] = value;
  }

  /** The runner's access token as it is right now. Private: nothing outside
   *  reads it, and the two things in here that do (the `board-mcp` and
   *  `tunnel-token` ops of the secrets socket) read it per request and keep
   *  no copy. */
  private accessToken(): string | undefined {
    const source = this.runnerTokenSource;
    return typeof source === 'function' ? source() : source;
  }

  /** Can a session on this host open a public tunnel (`factiii-expose`)?
   *  True on a paired runner, false on desktop, which has no runner token. */
  get canExpose(): boolean {
    return !!this.accessToken();
  }

  constructor(options: SpaceCoreOptions) {
    this.spaceSlug = options.spaceSlug;
    this.spaceId = options.spaceId ?? null;
    this.emitter = options.emitter;
    this.configProvider = options.configProvider;
    this.runnerTokenSource = options.runnerToken;
    this.serverUrl = options.serverUrl;
    this.requestSudo = options.requestSudo;
    this.activity = new ActivityTracker(this.emitter);
    this.onGateOpen = options.onGateOpen;
    this.ownerActor = options.ownerActor;
    this.hypervisor = options.hypervisor;
    this.sessionTargetOf = options.sessionTarget;
    // A window opening releases the jobs queued behind the prompt that opened
    // it, and either edge changes what secretsAuthState reports - so clients
    // refetch on the same signal a prompt change sends.
    this.window.subscribe(() => {
      if (this.window.identity() !== null) {
        this.gate.settleQueued((request) =>
          request.job ? { windowed: true } : null
        );
      }
      this.emitter.emitSecretsAuth({ pending: this.gate.pending() !== null });
    });
    // A row survives the modal being dismissed, so a command blocked on the
    // owner's password is never invisible; the event drives the modal itself.
    this.gate.subscribe(() => this.publishGate(this.gate.pending()));
  }

  /** Tell clients and the server about the request on the gate: this space's
   *  own, or the ops user's (.specs/ops-user.md), whose link calls this on
   *  each change it reports. */
  publishGate(pending: PendingSecretsAuth | null): void {
    if (pending && pending.id !== this.announcedGateId) {
      this.announcedGateId = pending.id;
      this.onGateOpen?.(pending);
    }
    // One row per REQUEST, not per space: when an answer moves the next
    // queued request on screen (a job behind an inbox prompt), the old row
    // is retired and the pending flag drops first, then the new row and
    // the flag arrive. A client that dedups on id or on an unchanged
    // `pending: true` would otherwise never notice a new prompt.
    const shown = this.shownGateId;
    if (shown && shown !== pending?.id) {
      this.activity.clear('secrets-auth', shown);
      this.shownGateId = '';
      if (pending) this.emitter.emitSecretsAuth({ pending: false });
    }
    if (pending) {
      this.activity.set(
        'secrets-auth',
        'awaiting-input',
        'Needs your store password',
        `${pending.origin}: ${pending.command}`,
        pending.id
      );
      this.shownGateId = pending.id;
    }
    this.emitter.emitSecretsAuth({ pending: pending !== null });
  }

  /** The space's authorization gate, and the registry of which sessions may
   *  ask at all (see secrets-gate.ts). Here rather than on the engine because
   *  every session type has a SpaceCore and needs a token minted for it. */
  readonly gate = new SecretsGate();

  /** The space's unlock window (secrets-window.ts): the age key held in memory
   *  for JOB spawns only. Per space, not per runner, so a window opened for
   *  one board's jobs never lets another board's jobs run unasked. */
  readonly window = new UnlockWindow();

  private readonly onGateOpen?: (request: PendingSecretsAuth) => void;
  private readonly ownerActor?: () => { userId: string; name: string };
  private readonly hypervisor?: HypervisorHost;

  /** The engine's jobs, for the bridge's job ops (see LocalJobs). */
  localJobs: LocalJobs | null = null;

  /** Set by the engine when this board's store lives with the ops user
   *  (.specs/ops-user.md): `list` answers from there and `run` is refused. */
  ops: { keyNames: () => Promise<SecretsKeyInfo[]> } | null = null;

  /** The session behind a bridge token, or a thrown refusal: only a session
   *  this runner spawned may call a job through the socket. */
  private bridgeOrigin(token: string): string {
    const origin = token ? this.gate.originFor(token) : null;
    if (!origin) throw new Error(UNATTRIBUTED);
    return origin;
  }

  /**
   * Whether the board MCP's caller proved the session it names: true for a
   * session token that is the one this space gives that session id
   * (exec.ts sessionToken), false for a caller that sent none (a session or a
   * bridge from before the token, or no session at all). A token that does
   * not match is refused outright: that is a session naming another one.
   */
  private verifySessionClaim(session: string, sessionToken: string): boolean {
    if (!session || !sessionToken) return false;
    if (!isSessionToken(this.spaceDir(), session, sessionToken)) {
      throw new Error(SESSION_MISMATCH);
    }
    return true;
  }

  private jobsOrThrow(): LocalJobs {
    if (!this.localJobs) throw new Error('This runner serves no jobs here.');
    return this.localJobs;
  }
  /** The last request handed to onGateOpen, so a re-render of the same
   *  request does not push the approvers twice. */
  private announcedGateId = '';
  /** The request whose activity row is live (see the gate subscriber). */
  private shownGateId = '';

  private auditLog: AuditLog | null = null;

  /** The space's append-only audit log (audit.ts). Lazy: spaceDir() creates
   *  the tree, which the constructor must not. */
  get audit(): AuditLog {
    this.auditLog ??= new AuditLog(this.spaceDir());
    return this.auditLog;
  }

  /** The live deploy run's log sink, so a command it authorizes still lands on
   *  the release timeline now that the bridge is not the run's own. Set by the
   *  engine for the length of a run. */
  deployLog: ((entry: { type: string; content: string }) => void) | null = null;

  private secretsBridge: SecretsBridge | null = null;
  private bridgeStarting: Promise<void> | null = null;

  /** Serve `factiii-secrets` for this space, once. Lazy rather than
   *  constructor-time: the socket lives under `state`, which does not exist
   *  until the workspace is provisioned. Provisioning and reattach both call
   *  it, so the socket is up before anything can reach for it. */
  async ensureSecretsBridge(): Promise<void> {
    if (this.secretsBridge) return;
    this.bridgeStarting ??= this.startSecretsBridgeOnce().finally(() => {
      this.bridgeStarting = null;
    });
    return this.bridgeStarting;
  }

  private async startSecretsBridgeOnce(): Promise<void> {
    const spaceDir = this.spaceDir();
    // The host may have created secrets/ with the default mode; tighten it
    // before anything can be stored there.
    await ensureSecretsDir(spaceDir).catch(() => undefined);
    // Before per-board keys, one key in the runner dir opened every board. A
    // board with secrets stored gets its own copy, once, so its password keeps
    // working (host-secrets.ts adoptRunnerKey).
    await adoptRunnerKey(path.dirname(spaceDir), spaceDir).catch(
      () => undefined
    );
    // Adopt the space token (persisted in <space>/.secret) before the socket
    // takes its first caller. It used to be adopted only when a session
    // spawned, so after a restart a terminal from before it - still holding
    // that token - was refused until something new was opened.
    this.secretsToken();
    this.secretsBridge = await startSecretsBridge({
      spaceDir,
      handlers: {
        run: async ({ command, cwd, keys, files, token, status }) => {
          // Identity first: a request with no token this runner issued never
          // becomes a prompt, because an unattributable password ask is
          // indistinguishable from a real one.
          const origin = token ? this.gate.originFor(token) : null;
          if (!origin) {
            // status() only: stdout carries the COMMAND's output and nothing
            // else, so a caller doing `x=$(factiii-secrets run ...)` must not
            // capture our refusal. 3 is the CLI's "nothing ran".
            status(UNATTRIBUTED);
            return { code: 3, output: '' };
          }
          // The store is the ops user's: a free command would run there with
          // all of it in reach. Same "nothing ran" as a refusal above.
          if (this.ops) {
            status(OPS_FREE_COMMAND_REFUSED);
            return { code: 3, output: '' };
          }
          return authorizeAndRun({
            configDir: spaceKeyDir(spaceDir),
            spaceDir,
            // A step legitimately cds into subdirectories, so the caller's own
            // cwd is right - but only inside the space. Anywhere else is a
            // confused caller, and the workspace is the safe reading.
            cwd: containedCwd(cwd, spaceDir) ?? this.target().paths.workspace,
            command,
            githubToken: this.readConfig().githubToken || undefined,
            keys,
            files,
            origin,
            gate: this.gate,
            // Read only for jobs; a free command here always prompts. Passed
            // so its answer can still open a window for the jobs after it.
            window: this.window,
            audit: this.audit,
            // Every session here is the owner's; the line names the owner.
            auditActor: this.ownerActor?.(),
            via: 'owner-terminal',
            // A deploy-origin command belongs on the release timeline; every
            // other origin has no log of its own and reads the CLI's stderr.
            sendLog: this.deployLog ?? undefined
          });
        },
        list: () => (this.ops ? this.ops.keyNames() : this.secretsKeyInfo()),
        // `factiii-expose` asks for the runner's access token at the moment
        // it opens a tunnel: frps checks it (routers/frpAuth.ts on the
        // server). Only a session this runner spawned gets it, it is read
        // now and not kept here, and the op does nothing else. Desktop has
        // no runner token and so no tunnels.
        tunnelToken: async (token) => {
          this.bridgeOrigin(token);
          const access = this.accessToken();
          if (!access) throw new Error(NO_TUNNELS);
          return access;
        },
        // git's credential helper in a session (`factiii-secrets
        // git-credential`, set in the primary clone's config): the board's
        // GitHub token as it is now. Only a session this runner spawned, and
        // nothing once GitHub is disconnected, so git fails at once
        // everywhere. Read per request, never kept here.
        gitCredential: async (token) => {
          this.bridgeOrigin(token);
          const github = this.readConfig().githubToken;
          if (!github) throw this.notConnectedError(NO_GITHUB);
          return github;
        },
        // The board's tools for one agent (`factiii-board-mcp`, the plugin's
        // stdio MCP server). Only a session this runner spawned, and only on
        // a paired runner: both refusals come before any call to the server.
        // The relay reads the access token for each message it forwards.
        boardMcp: async (token, channel, session, sessionToken) => {
          this.bridgeOrigin(token);
          // Which session is asking: proven by its FACTIII_SESSION_TOKEN, or
          // only claimed by a session from before the token (none sent).
          const verified = this.verifySessionClaim(session, sessionToken);
          if (!this.hasBoardMcp() || !this.serverUrl) {
            throw new Error(NO_BOARD_MCP);
          }
          const upstream = `${this.serverUrl.replace(/\/$/, '')}/mcp/board`;
          const open = (ch: BoardMcpChannel) =>
            openBoardMcpRelay({
              upstream,
              accessToken: () => this.accessToken(),
              channel: ch,
              // A claimed but unproven session is not named: the server
              // would let it spend its routine's Trons on X.
              session: verified ? session : undefined
            });
          // The session tools, where the engine has sessions to link, and
          // the hypervisor's where the runner lends its boards.
          const links = this.sessionLinks;
          const hypervisor = this.hypervisor
            ? { host: this.hypervisor, slug: this.spaceSlug }
            : null;
          return links
            ? withSessionCardTools({
                open,
                channel,
                session,
                verified,
                links,
                hypervisor
              })
            : open(channel);
        },
        // A session on this runner is the owner's: it was spawned on the
        // owner's machine, from the owner's board. It still goes through
        // jobsCall, so the job rules - allowlist, param env, the gate and its
        // window - are the same as for a call relayed by the server.
        jobs: {
          list: async (token) => {
            this.bridgeOrigin(token);
            return this.jobsOrThrow().list();
          },
          call: async (token, job, params) => {
            const origin = this.bridgeOrigin(token);
            const actor = this.ownerActor?.() ?? { userId: '', name: 'Owner' };
            return this.jobsOrThrow().call(job, params, actor, origin);
          },
          status: async (token, callId, afterSeq) => {
            this.bridgeOrigin(token);
            return this.jobsOrThrow().status(callId, afterSeq);
          },
          cancel: async (token, callId) => {
            this.bridgeOrigin(token);
            const actor = this.ownerActor?.() ?? { userId: '', name: 'Owner' };
            return this.jobsOrThrow().cancel(callId, actor);
          }
        }
      }
    });
  }

  /** Key NAMES, status and purpose, no password. The contract declares its
   *  keys in public on the default branch, sops leaves names in cleartext, and
   *  the meta sidecar holds only descriptions - so this reveals nothing the
   *  repo and the files do not already say. */
  private async secretsKeyInfo(): Promise<SecretsKeyInfo[]> {
    const stored = new Set(await storedSecretKeys(this.spaceDir()));
    const meta = await readSecretMeta(this.spaceDir());
    const config = this.readConfig();
    // Best effort: a space with no repo or token still has a store worth
    // listing, it just cannot say which keys the contract asked for.
    const variables = await (config.repoUrl && config.githubToken
      ? checkDeployStatus({
          spaceDir: this.spaceDir(),
          repoUrl: config.repoUrl,
          mainBranch: config.mainBranch,
          githubToken: config.githubToken
        })
          .then((status) => status.variables)
          .catch(() => [])
      : []);
    const declared = new Map(
      variables.filter((v) => v.kind !== 'file').map((v) => [v.key, v])
    );
    const keys: SecretsKeyInfo[] = [...new Set([...declared.keys(), ...stored])]
      .sort()
      .map((key) => ({
        key,
        stored: stored.has(key),
        declared: declared.has(key),
        ...describeSecret(meta[key], declared.get(key))
      }));
    // File secrets (sops blobs) by name, asked for with `--file`: those the
    // store holds plus those the contract declares as `kind: "file"`.
    const declaredFiles = new Map(
      variables.filter((v) => v.kind === 'file').map((v) => [v.key, v])
    );
    const storedFiles = new Set(await storedSecretFiles(this.spaceDir()));
    const files = [...new Set([...declaredFiles.keys(), ...storedFiles])]
      .sort()
      .map(
        (key): SecretsKeyInfo => ({
          key,
          stored: storedFiles.has(key),
          declared: declaredFiles.has(key),
          kind: 'file',
          ...describeSecret(meta[key], declaredFiles.get(key))
        })
      );
    // A declared key the store lacks, beside an undeclared one it holds under
    // a similar name, is likely one credential under the wrong name. Env keys
    // pair with env keys, files with files.
    const withStoredAs = (rows: SecretsKeyInfo[]) => {
      const storedAs = likelyStoredAs(rows);
      return rows.map((r) =>
        storedAs[r.key] ? { ...r, storedAs: storedAs[r.key] } : r
      );
    };
    return [...withStoredAs(keys), ...withStoredAs(files)];
  }

  private spaceSecretsToken = '';

  /**
   * The token every session this space spawns carries, so `factiii-secrets`
   * inside one is attributable and everything else is refused.
   *
   * One per space, not per session: `extraEnv` is the only place every spawn
   * passes through and it cannot tell which session it is building for. A run
   * that DOES know itself - the deploy run - mints its own and overrides this.
   */
  secretsToken(): string {
    if (this.spaceSecretsToken) return this.spaceSecretsToken;
    // From disk, so it is the same value in every process. Terminals outlive
    // the one that spawned them (tmux is its own server) and keep the token
    // they were spawned with; a minted one left them unattributed after every
    // restart.
    this.spaceSecretsToken = this.gate.adoptToken(
      spaceSecret(this.spaceDir()),
      'A session on this board'
    );
    return this.spaceSecretsToken;
  }

  readConfig(): CardAIConfig {
    return this.configProvider.readConfig(this.spaceSlug);
  }

  /** The error for a path that needs the repository or its token and found
   *  none. Stored settings the host cannot read look exactly like that, so the
   *  host's own reason (locked, no keychain) wins over `fallback`. */
  notConnectedError(fallback: string): Error {
    return new Error(
      this.configProvider.configProblem?.(this.spaceSlug) ?? fallback
    );
  }

  /** How this space runs commands: its sessions' target, which is the host's
   *  own unless the runner moved sessions into the dev VM (sessionTarget).
   *  Memoized: the VM's wraps the host's, and both keep state. */
  target(): ExecTarget {
    this.sessionExecTarget ??= this.sessionTargetOf
      ? this.sessionTargetOf(this.hostTarget())
      : this.hostTarget();
    return this.sessionExecTarget;
  }

  /** How this space runs commands ON THIS HOST, whatever target() is: for
   *  what never moves into the dev VM (sign-ins, the simulator). Memoized:
   *  spaceDir() creates the tree on each call and this is reached for dozens
   *  of times per run. */
  hostTarget(): ExecTarget {
    // The codex MCP entry stores the env var NAME, so the token has to be in
    // the environment at run time. Every var here must resolve the same on
    // every call: a spawn freezes what it is handed, and a tmux session keeps
    // it for as long as the tab lives, so a var that is merely LATE is one that
    // terminal never gets.
    this.execTarget ??= hostTarget(
      this.spaceDir(),
      () => {
        const env: Record<string, string> = {};
        // The one check that answers "am I inside a runner, and for which
        // board": the plugin's SessionStart hook (bin/session-context.sh)
        // prints the workspace facts only when this is set, and names it.
        env.FACTIII_SPACE = this.spaceSlug;
        // The board's id, which a rename does not change. A terminal keeps the
        // env it started with, so after a rename FACTIII_SPACE is the old slug;
        // the CLI and the plugin's programs look this id up in the runner's
        // spaces.json for the slug and the name the board has now
        // (apps/runner/src/boardRegistry.ts). Absent on a host that never
        // learned the id.
        if (this.spaceId) env.FACTIII_SPACE_ID = String(this.spaceId);
        // The session's one credential, for both things it reaches over the
        // secrets socket: `factiii-secrets` and the board MCP
        // (`factiii-board-mcp`). Never the runner's access token.
        env[SECRETS_TOKEN_ENV] = this.secretsToken();
        // Where that socket is. Both programs can also find it from inside the
        // space tree, but an agent started somewhere else could not.
        env.FACTIII_SECRETS_SOCK = secretsSocketPath(this.spaceDir());
        return env;
        // The token for the runner's own git calls to origin, read per call so
        // a reconnect is used at once. Not in the env above: no session gets it.
      },
      () => this.readConfig().githubToken || ''
    );
    return this.execTarget;
  }

  /** Does this host offer the board's tools? They are on api.factiii.com and
   *  take the runner's access token, so: a paired runner, not desktop. */
  private hasBoardMcp(): boolean {
    return this.runnerTokenSource !== undefined && !!this.serverUrl;
  }

  isReady(): boolean {
    return this.ready;
  }

  // ── Config ──

  /** The CLI agent this space runs (per-space config, default claude). */
  agentProvider(): AgentProvider {
    return resolveProvider(
      this.configProvider.readConfig(this.spaceSlug).provider
    );
  }

  /** How much Codex may do in this space's sessions (codex-permissions.ts;
   *  per-space config, default standard). */
  codexAccess(): CodexAccess {
    return resolveCodexAccess(
      this.configProvider.readConfig(this.spaceSlug).codexAccess
    );
  }

  /** The space's persisted creds for one provider, read from its state dir. */
  private async probeLoggedIn(provider: AgentProvider): Promise<boolean> {
    if (this.loggedIn[provider]) return true;
    // The host's: sign-ins live on this host (the dev VM's sessions are
    // handed tokens, .specs/dev-vm.md), so a board's signed-in state is here.
    this.loggedIn[provider] = await loginCredentialsExist(
      provider,
      this.hostTarget()
    );
    return this.loggedIn[provider] ?? false;
  }

  async getConfig(): Promise<{
    repoUrl: string;
    mainBranch: string;
    gitName: string;
    gitEmail: string;
    provider: AgentProvider;
    codexAccess: CodexAccess;
    claudeLoggedIn: boolean;
    codexLoggedIn: boolean;
    hasGithubToken: boolean;
    githubTokenHint: string;
    tokensEncrypted: boolean;
    secureStore?: SecureStoreStatus;
    gitConnectionId?: string;
    gitConnections?: GitConnectionChoice[];
    terminalDefault: TerminalDefault;
    terminalCommand: string;
  }> {
    const config = this.configProvider.readConfig(this.spaceSlug);
    return {
      // Which runner Git connection (absent on a board not moved yet), the
      // ones it may pick from, and what its new terminals start.
      gitConnectionId: config.gitConnectionId,
      gitConnections: this.configProvider.gitConnectionChoices?.(),
      terminalDefault: resolveTerminalDefault(config.terminalDefault),
      terminalCommand: config.terminalCommand ?? '',
      repoUrl: config.repoUrl,
      mainBranch: config.mainBranch,
      gitName: config.gitName,
      gitEmail: config.gitEmail,
      provider: resolveProvider(config.provider),
      codexAccess: resolveCodexAccess(config.codexAccess),
      claudeLoggedIn: await this.probeLoggedIn('claude'),
      codexLoggedIn: await this.probeLoggedIn('codex'),
      hasGithubToken: Boolean(config.githubToken),
      githubTokenHint: config.githubToken
        ? `····${config.githubToken.slice(-4)}`
        : '',
      // Absent implementation means no at-rest encryption, not an unknown -
      // the UI must never imply protection this host doesn't provide.
      tokensEncrypted: this.configProvider.tokensEncrypted?.() ?? false,
      // Carries WHY the store isn't usable plus the remedy, so the settings
      // panel can act on it rather than just flag a colour.
      secureStore: this.configProvider.secureStore?.()
    };
  }

  setConfig(partial: {
    repoUrl?: string;
    mainBranch?: string;
    gitName?: string;
    gitEmail?: string;
    githubToken?: string;
    provider?: AgentProvider;
    codexAccess?: CodexAccess;
    gitConnectionId?: string;
    terminalDefault?: TerminalDefault;
    terminalCommand?: string;
  }): { success: boolean } {
    const existing = this.configProvider.readConfig(this.spaceSlug);
    if (
      partial.gitConnectionId &&
      this.configProvider.gitConnectionToken?.(partial.gitConnectionId) == null
    ) {
      throw new Error('That Git connection is not on this runner.');
    }
    const updated: CardAIConfig = {
      repoUrl: partial.repoUrl ?? existing.repoUrl,
      mainBranch: partial.mainBranch ?? existing.mainBranch,
      gitName: partial.gitName ?? existing.gitName,
      gitEmail: partial.gitEmail ?? existing.gitEmail,
      githubToken:
        partial.githubToken?.replace(/\s/g, '') || existing.githubToken,
      provider: partial.provider ?? existing.provider,
      codexAccess:
        partial.codexAccess !== undefined
          ? resolveCodexAccess(partial.codexAccess)
          : existing.codexAccess,
      // A pick replaces the board's identity with the connection's: the
      // provider's readConfig fills both from it.
      gitConnectionId: partial.gitConnectionId ?? existing.gitConnectionId,
      terminalDefault:
        partial.terminalDefault !== undefined
          ? resolveTerminalDefault(partial.terminalDefault)
          : existing.terminalDefault,
      terminalCommand:
        partial.terminalCommand !== undefined
          ? cleanTerminalCommand(partial.terminalCommand)
          : existing.terminalCommand
    };
    this.configProvider.writeConfig(this.spaceSlug, updated);
    // A different repo invalidates the clone and every worktree under it, and
    // only the full provision path wipes those (see repoChanged). A rotated
    // token or new branch needs just the git lane, which the key handles.
    if (
      existing.repoUrl &&
      updated.repoUrl &&
      repoIdentity(existing.repoUrl) !== repoIdentity(updated.repoUrl)
    ) {
      this.ready = false;
    }
    return { success: true };
  }

  spaceDir(): string {
    return this.configProvider.spaceDir(this.spaceSlug);
  }

  /** A runner Git connection's token, for its repo picker; null when the
   *  host has no such connection (or no root connections at all). */
  gitConnectionToken(id: string): string | null {
    return this.configProvider.gitConnectionToken?.(id) ?? null;
  }

  /** Disconnect this board from GitHub. A board on a runner Git connection
   *  lets go of it ('' is none) and the connection stays for the others;
   *  its token is the runner's to remove (Status > Git). */
  clearToken(key: 'githubToken'): { success: boolean } {
    const existing = this.configProvider.readConfig(this.spaceSlug);
    existing[key] = '';
    if (existing.gitConnectionId !== undefined) existing.gitConnectionId = '';
    this.configProvider.writeConfig(this.spaceSlug, existing);
    return { success: true };
  }

  // ── Workspace ──

  setupStatus(): { phase: 'idle' | 'running' | 'ready' } {
    if (this.ready) return { phase: 'ready' };
    if (this.setupPromise) return { phase: 'running' };
    return { phase: 'idle' };
  }

  // ── Persistent per-space workspace: clone, worktrees, card state ──
  // Just a directory, so a restart needs no reattach.

  /** The board's sessions, for the board MCP's session tools: set by the
   *  engine, which holds them. */
  sessionLinks: SessionLinks | null = null;

  private execTarget: ExecTarget | null = null;
  private sessionExecTarget: ExecTarget | null = null;
  private readonly sessionTargetOf?: (host: ExecTarget) => ExecTarget;
  private ready = false;
  private setupPromise: Promise<void> | null = null;
  /** In-flight git lane, so concurrent callers share one run. The fast path
   *  below is not covered by `setupPromise`, and it now provisions git on a
   *  stale key, so two calls that land together (a card start next to the
   *  branch picker) would otherwise fetch into the same clone at once and
   *  fail on git's ref lock. */
  private gitLanePromise: Promise<void> | null = null;
  /** The repo config the primary clone was last provisioned for; null while the
   *  git lane has not completed. `ready` alone never proves a clone exists: the
   *  lane is a no-op on an unconfigured space, so a space that went ready before
   *  its repo was connected would otherwise keep reporting ready with no clone
   *  on disk, and every addWorktree would fail on the missing repo directory. */
  private gitLaneKey: string | null = null;

  /** Identity of the repo config the git lane provisions from, or null when the
   *  space is not git-backed. Any change - a first connect, a rotated token, a
   *  new base branch - yields a new key and so re-runs the lane. */
  private gitLaneKeyFor(config: CardAIConfig): string | null {
    if (!config.repoUrl || !config.githubToken) return null;
    return JSON.stringify([
      config.repoUrl,
      config.mainBranch,
      config.githubToken
    ]);
  }

  /** Whether the primary clone still matches the configured repo. A different
   *  repo means the clone and every worktree belong to the wrong project. */
  private async repoChanged(): Promise<boolean> {
    const config = this.configProvider.readConfig(this.spaceSlug);
    if (!config.repoUrl || !config.githubToken) return false;
    const target = this.target();
    try {
      // By repo identity, so a token rotation isn't read as a repo change. A
      // missing clone isn't a mismatch; ensurePrimaryClone handles it.
      const origin = (
        await target.sh(
          `git -C ${target.paths.repo} remote get-url origin 2>/dev/null || true`
        )
      ).trim();
      return !!origin && repoIdentity(origin) !== repoIdentity(config.repoUrl);
    } catch {
      // no clone / git error: not a mismatch, ensurePrimaryClone handles it.
      return false;
    }
  }

  /** Provision the workspace: tree, card state, fresh clone. Idempotent; even the
   *  fast path refreshes, so a new card branches off current origin. */
  async ensureSpaceWorkspace(
    onStatus?: (msg: string) => void,
    /** Refetch origin so a new card branches off current HEAD. Only the paths
     *  that start work need this; Ask and settings reads do not. */
    refreshGit = false
  ): Promise<void> {
    const status = (msg: string) => {
      onStatus?.(msg);
      this.emitter.emitSetupStatus(msg);
      // Streamed toolchain output is far too noisy for a panel row; only the
      // step labels become the activity's detail line.
      if (msg && !msg.startsWith(SETUP_LOG_PREFIX)) {
        this.activity.set('setup', 'working', 'Setting up space', msg);
      }
    };
    if (this.setupPromise) return this.setupPromise;
    // Provisioning is idempotent but not free: toolchain probes, a git fetch
    // and four MCP registrations per call. Once up, only a git refresh matters.
    if (this.ready) {
      // A stale key means the clone this config needs is not on disk yet: the
      // space reached ready before its repo was connected, or the token has
      // rotated since. That has to re-run whether or not the caller asked for a
      // refresh, or the next addWorktree dies on a missing repo directory.
      const gitLaneStale =
        this.gitLaneKey !==
        this.gitLaneKeyFor(this.configProvider.readConfig(this.spaceSlug));
      if (refreshGit || gitLaneStale) {
        // The fast path emits step labels too, so it opens an activity row —
        // and its `finally` below never runs. Without clearing it here, every
        // card start would leave a "Setting up space" row up forever.
        try {
          await this.runGitLane(status);
          this.activity.clear('setup');
        } catch (err) {
          this.activity.set(
            'setup',
            'error',
            'Setup failed',
            err instanceof Error ? err.message : String(err)
          );
          throw err;
        }
      }
      return;
    }

    this.setupPromise = (async () => {
      try {
        const target = this.target();

        if (await this.repoChanged()) {
          status('Applying configuration change…');
          // The clone and every worktree belong to the old repo.
          await target.sh(
            `rm -rf ${target.paths.repo} ${target.paths.worktrees}`
          );
        }

        // Before provisioning: a missing tmux or git otherwise surfaces far
        // later as an opaque "command not found".
        status('Setting up environment…');
        // The basics, plus this board's provider CLI when it is not Claude.
        const provider = this.readConfig().provider;
        await ensureToolchain(
          target,
          (line) => status(`${SETUP_LOG_PREFIX}${line}`),
          this.requestSudo,
          provider && provider !== 'claude' ? [provider] : []
        );

        status('Preparing workspace…');
        const { paths } = target;
        await target.sh(
          `mkdir -p ${paths.root} ${paths.worktrees} ${paths.state} ${paths.backups} ${paths.builds} ${paths.bin} ${paths.scratchpad}`
        );
        await allocateSpacePorts(this.spaceDir());
        // Before any lane can spawn a session: the socket has to exist by the
        // time something in one reaches for `factiii-secrets`.
        await this.ensureSecretsBridge().catch(() => undefined);
        // Redis is an extra (live agent status): up where it is installed,
        // and first, so the store can copy in what a runner from before kept
        // there.
        await ensureRedis(target).catch(() => {});
        await ensureStateStore(target);
        await Promise.all([
          this.runGitLane(status),
          this.provisionMcpLane(),
          this.provisionPluginLane(),
          this.provisionBinLane(),
          this.provisionSecretsRuleLane(),
          // Covers a host signed in outside the one-click button, which would
          // otherwise meet the wizard the first time it opens a terminal.
          markOnboardingComplete(target).catch(() => {})
        ]);
        await this.restoreTerminals();
        await this.applyTerminalConfig();
        status('');
        this.ready = true;
      } catch (err) {
        // Setup can fail for minutes-old reasons (no disk, bad token). Leave
        // the row up with the reason rather than retiring it silently.
        this.activity.set(
          'setup',
          'error',
          'Setup failed',
          err instanceof Error ? err.message : String(err)
        );
        throw err;
      } finally {
        this.setupPromise = null;
        if (this.ready) this.activity.clear('setup');
      }
    })();
    return this.setupPromise;
  }

  /** provisionGitLane, deduped: a caller arriving mid-run joins that run
   *  instead of starting a second one against the same clone. */
  private runGitLane(status: (msg: string) => void): Promise<void> {
    if (this.gitLanePromise) return this.gitLanePromise;
    const run = this.provisionGitLane(status);
    this.gitLanePromise = run;
    void run
      .catch(() => undefined)
      .finally(() => {
        if (this.gitLanePromise === run) this.gitLanePromise = null;
      });
    return run;
  }

  // Ensure the primary clone is present and fresh (clone or fetch), with a
  // plain origin and the session credential helper. No-op if unconfigured.
  private async provisionGitLane(status: (msg: string) => void): Promise<void> {
    const config = this.configProvider.readConfig(this.spaceSlug);
    const key = this.gitLaneKeyFor(config);
    if (!key) {
      // Not git-backed. Leave the lane unrecorded rather than let this no-op
      // count as provisioned, so connecting a repo later re-runs it.
      this.gitLaneKey = null;
      return;
    }
    status('Updating repository…');
    const target = this.target();
    await ensurePrimaryClone(
      target,
      buildCloneUrl(config.repoUrl),
      config.mainBranch || 'main'
    );
    // Sessions push through the runner (`factiii-secrets git-credential`).
    // Only where the helper is shipped: the runner package and the desktop
    // app both carry the plugin; a source checkout without it keeps the
    // owner's own git credentials.
    if (pluginRoot()) {
      await setSessionCredentialHelper(
        target,
        path.join(target.paths.bin, SECRETS_BIN)
      );
    }
    await setGitIdentity(
      target,
      config.gitName,
      config.gitEmail,
      target.paths.repo
    );
    // Only now: a throw above must leave the lane stale so the next call retries.
    this.gitLaneKey = key;
  }

  /** On a connect: make sure the existing primary clone's `origin` is the
   *  plain URL. No token goes in it any more (a session asks the runner for
   *  the current one), so this only takes out a token an older runner wrote.
   *  Only the remote URL changes: nothing is fetched or checked out. Never
   *  throws, since a clone that cannot be rewritten must not fail the
   *  connect; false tells the caller, and the next lane sets it again. */
  async refreshOriginToken(): Promise<boolean> {
    try {
      const config = this.configProvider.readConfig(this.spaceSlug);
      if (!config.repoUrl || !config.githubToken) return true;
      // A lane in flight sets its own URL last; let it finish first.
      await this.gitLanePromise?.catch(() => undefined);
      // A clone of another repo is wiped by the next full provision, which
      // tells by its origin. Rewriting it here would hide that.
      if (await this.repoChanged()) return true;
      await setPrimaryCloneOrigin(this.target(), buildCloneUrl(config.repoUrl));
      return true;
    } catch {
      // The reason is dropped, not returned: a git error can quote the URL,
      // token and all.
      return false;
    }
  }

  /** For a disconnect: take a token out of `origin` in the existing primary
   *  clone (which every worktree and `skills` share) and in the deploy
   *  checkout, a clone of its own. This runner never writes one there; an
   *  older one did, and a clone it left is migrated here if no lane ran since.
   *  Only the remote URLs change: nothing is fetched or checked out. Never
   *  throws, since a clone that cannot be rewritten must not fail the
   *  disconnect; false tells the caller a URL may still carry a token. */
  async stripOriginToken(): Promise<boolean> {
    let ok = true;
    try {
      // A lane in flight sets its own URL last; let it finish first.
      await this.gitLanePromise?.catch(() => undefined);
      const target = this.target();
      // From the clone's own URL, not the config's repo: a clone of another
      // repo keeps its identity, which is how provisioning tells (repoChanged).
      const origin = (
        await target.sh(
          `git -C ${target.paths.repo} remote get-url origin 2>/dev/null || true`
        )
      ).trim();
      const stripped = stripCloneUrlCredentials(origin);
      if (origin && stripped !== origin) {
        await setPrimaryCloneOrigin(target, stripped);
      }
    } catch {
      // The reason is dropped, not returned: a git error can quote the URL,
      // token and all.
      ok = false;
    }
    try {
      if (!(await stripWorkspaceOriginToken(this.spaceDir()))) ok = false;
    } catch {
      ok = false;
    }
    return ok;
  }

  /** Install the factiii plugin into both CLIs: the hooks behind the session
   *  status dot, the skills this workspace provides, and the board MCP.
   *
   *  Installed at user scope in the RUNNER'S homes (agent-homes.ts): this
   *  process's CLAUDE_CONFIG_DIR and CODEX_HOME, which every command here
   *  inherits. So it loads in every runner session, in any folder, and in none
   *  of the person's own sessions on the machine. A plugin rather than
   *  hand-written config because both CLIs install and upgrade it themselves.
   *
   *  Both CLIs read the same manifest, so one marketplace serves both, and
   *  adding a marketplace or plugin that is already there is a no-op in each —
   *  which is what makes this safe on every ensure. */
  private async provisionPluginLane(): Promise<void> {
    // Rendered rather than installed from the shipped copy: the board MCP
    // entry is added at render time, and only on a paired runner. A host with
    // no runner token (desktop) installs nothing here, as before: a board
    // entry there would be a server that is always refused. See renderPlugin.
    // Once per machine, and before the early return below so the desktop app
    // (no plugin lane) runs it too: take out what an older runner wrote into
    // the person's default homes, where it reached every session they ran:
    // the plugin, the secrets allow rules and the OneDrive MCP entries.
    // The person's default homes are on this host, whatever target() is.
    await removeDefaultHomeLeftovers((cmd) => this.hostTarget().sh(cmd)).catch(
      () => false
    );
    const root = this.hasBoardMcp()
      ? await renderPlugin().catch(() => null)
      : null;
    if (!root) return;
    const q = `'${root}'`;
    const cmd = [
      `claude plugin marketplace add ${q} >/dev/null 2>&1 || true`,
      `claude plugin install ${PLUGIN_ID} --scope user >/dev/null 2>&1 || true`,
      // Both CLIs install by COPYING the plugin into a cache keyed by its
      // version, and that copy is what loads. claude's `install` refuses once
      // something is installed ("already installed"), so without these two an
      // upgrade renders new files into a directory nothing reads again. Codex
      // needs no equivalent: its `add` re-installs from a local marketplace.
      `claude plugin marketplace update ${MARKETPLACE_NAME} >/dev/null 2>&1 || true`,
      `claude plugin update ${PLUGIN_ID} >/dev/null 2>&1 || true`,
      `codex plugin marketplace add ${q} >/dev/null 2>&1 || true`,
      `codex plugin add ${PLUGIN_ID} >/dev/null 2>&1 || true`
    ].join('; ');
    try {
      // The runner's CLI homes are on this host. The dev VM gets a copy of
      // the plugin from them (apps/runner/src/devVm), never a sign-in.
      await this.hostTarget().sh(cmd);
    } catch {
      // Best-effort, like the MCP lane. Without it the terminal still works;
      // the status dot just falls back to "alive" and the skill is missing.
    }
  }

  /** Let `factiii-secrets` past both CLIs' own gates (secrets-permission.ts):
   *  an allow rule merged into claude's user settings, and codex's own rules
   *  file, plus the rest of Codex's home the runner sets (codex-config.ts).
   *  In the homes the CLIs use here (`cliHomes`: the runner's own), so the
   *  person's own sessions get no rule. Only for a CLI whose config
   *  directory exists, so a machine without one gets nothing written for it.
   *  Best-effort, like the plugin lane: without it the CLI asks first, or
   *  claude's classifier refuses. */
  private async provisionSecretsRuleLane(): Promise<void> {
    // The runner's CLI homes, on this host (see the plugin lane).
    const target = this.hostTarget();
    try {
      const { claude: claudeDir, codex: codexDir } = cliHomes();
      const { repo, workspace } = target.paths;
      await Promise.all([
        writeClaudeSecretsRules(target, claudeDir),
        writeCodexSecretsRules(target, codexDir),
        // CLAUDE.md as Codex's project doc, this board's clone (and so each
        // of its worktrees) and workspace trusted, and the one-off "always
        // allow" answers pruned once per Codex home (codex-config.ts).
        writeCodexConfig(target, codexDir, [repo, workspace])
      ]);
    } catch {
      // Nothing to undo: each file is replaced whole by a rename, or not at all.
    }
  }

  /** Stage the plugin's `factiii-secrets` and `factiii-board-mcp` onto the
   *  agent's PATH.
   *
   *  A skill can only teach a command that exists. `paths.bin` is already the
   *  PATH prefix `agentEnv()` hands every spawn (it is how `factiii-expose`
   *  resolves), but nothing put anything there for a deploy run - so the
   *  skill would name a command the shell could not find.
   *
   *  Copied rather than symlinked: an `npm i -g @factiii/runner` upgrade
   *  replaces the package directory, and a link into the old one dangles.
   *  Re-copied whenever the sizes differ, which is what carries an upgrade
   *  through without re-copying on every ensure. */
  private async provisionBinLane(): Promise<void> {
    const source = pluginRoot();
    if (!source) return;
    // The host's bin: the dev VM sees it read-only, so it is staged here.
    const { bin } = this.hostTarget().paths;
    for (const name of [SECRETS_BIN, BOARD_MCP_BIN]) {
      const from = path.join(source, 'factiii', 'bin', name);
      const to = path.join(bin, name);
      try {
        // Contents, not size: the helper speaks a versioned protocol to the
        // bridge, so a same-size edit that did not re-stage would leave the
        // space refusing every request rather than merely running stale docs.
        const [src, staged] = await Promise.all([
          readFile(from),
          readFile(to).catch(() => null)
        ]);
        if (staged?.equals(src)) continue;
        await mkdir(bin, { recursive: true });
        await copyFile(from, to);
        await chmod(to, 0o755);
      } catch {
        // Best effort, like the plugin lane. A missing helper costs the agent
        // that one capability; it must not take the whole space down with it.
      }
    }
  }

  // Clear the OneDrive MCP entries older runners registered for this space
  // with both CLIs. No space registers one any more: the runner OneDrive index
  // was removed. Kept so a host that ran the old code tidies itself on the
  // next ensure. (The per-space board entries from before the board lane moved
  // into the plugin were only ever in the default homes, which
  // default-home-cleanup.ts clears.)
  private async provisionMcpLane(): Promise<void> {
    const oneDriveName = oneDriveMcpName(this.spaceSlug);
    const cmd = [
      // Pre-rename entries, when the name was the same for every space.
      `claude mcp remove factiii-onedrive --scope user >/dev/null 2>&1 || true`,
      `codex mcp remove factiii_onedrive >/dev/null 2>&1 || true`,
      // The runner OneDrive index's per-space entries.
      `claude mcp remove ${oneDriveName} --scope user >/dev/null 2>&1 || true`,
      `codex mcp remove ${codexMcpName(oneDriveName)} >/dev/null 2>&1 || true`
    ].join('; ');
    try {
      await this.hostTarget().sh(cmd);
    } catch {
      // Best-effort: a failure just leaves the stale entries to the next ensure.
    }
  }

  /** Bring a space back up at startup without a full provision, pruning
   *  worktree refs left by crashed runs. False when it never existed: neither
   *  a clone nor a workspace on disk. A board with no repository has only the
   *  workspace, and must come back too, or each restart asks to set it up
   *  again (and its sign-ins wait on that). */
  async reattachSpaceWorkspace(): Promise<boolean> {
    const target = this.target();
    try {
      await target.sh(
        `test -d ${target.paths.repo} || test -d ${target.paths.workspace}`
      );
    } catch {
      return false;
    }
    await this.ensureSecretsBridge().catch(() => undefined);
    await ensureRedis(target).catch(() => {});
    await ensureStateStore(target).catch(() => {});
    await pruneWorktrees(target).catch(() => {});
    // Both lanes, not just MCP: a runner that self-updates and restarts comes
    // straight here, and `ensureSpaceWorkspace` then returns early forever
    // because this sets `ready`. Without these, an upgraded runner keeps
    // serving the OLD staged helper and plugin for the life of the space.
    await Promise.all([
      this.provisionPluginLane(),
      this.provisionBinLane(),
      this.provisionSecretsRuleLane()
    ]);
    await this.provisionMcpLane();
    await this.restoreTerminals();
    await this.applyTerminalConfig();
    this.ready = true;
    return true;
  }

  /** Push a changed tmux config into the server that is already running.
   *
   *  tmux reads `-f` only when it STARTS, so a config a runner update changed
   *  would otherwise sit unread until every session on the host died. Sourcing
   *  it reaches the live sessions and costs no process its life, which is why
   *  this half never has to bother the user - unlike the env half, where a
   *  restart is the only way in.
   *
   *  Runs AFTER the plugin and helper lanes above, deliberately: those are two
   *  of the inputs the digest covers, and recording one before they finish
   *  would stamp a state the runner is about to invalidate. */
  /** Bring this space's tabs back after the tmux server died (a reboot, or a
   *  kill). A runner restart needs none of this — tmux outlives us.
   *
   *  Structure only: every tab returns as a fresh shell.
   *
   *  Each restored pane is respawned, because resurrect rebuilds panes on the
   *  DEFAULT shell with no bin dir on PATH, and stamped, because it saves no
   *  user options and an unstamped session would read as stale on every boot. */
  private async restoreTerminals(): Promise<void> {
    try {
      const target = this.target();
      await ensureTmuxResurrect(target);
      const root = target.paths.root;
      // In turn with every other space on this host: see withTmuxRestoreTurn.
      await withTmuxRestoreTurn(() =>
        this.restoreTerminalsInTurn(target, root)
      );
    } catch {
      // Best effort: the fallback is the single fresh tab users had before.
    }
  }

  private async restoreTerminalsInTurn(
    target: ExecTarget,
    root: string
  ): Promise<void> {
    // Ownership read off the pane's directory rather than stored: ours sit
    // under this space's root, another space's under its sibling. One tmux
    // server serves every space, so the distinction matters.
    //
    // A tab a neighbour's restore rebuilt and nobody has respawned yet is
    // still ours to finish, and not a sign that our tabs are up.
    const unclaimed = unclaimedTmuxRestores(target);
    const before = await tmuxPanePaths(target);
    const mineUp = [...before].some(
      ([name, dir]) =>
        name.startsWith('terminal-') &&
        dir.startsWith(root) &&
        !unclaimed.has(name)
    );
    // The common case: a runner restart leaves everything running.
    if (mineUp) return;

    const mineWaiting = [...unclaimed].some((name) =>
      (before.get(name) ?? '').startsWith(root)
    );
    if (!mineWaiting) {
      const restored = await resurrectRestore(target);
      // Absent a moment ago: one already up may have work running that a
      // respawn would kill without warning.
      for (const name of restored) {
        if (!before.has(name)) unclaimed.add(name);
      }
    }
    const paths = await tmuxPanePaths(target);
    // Ours only: a neighbour's tab would be rebuilt on OUR bin dir and env.
    const revived = [...unclaimed].filter((name) =>
      (paths.get(name) ?? '').startsWith(root)
    );
    if (revived.length === 0) return;
    const digest = await terminalDigest(target).catch(() => '');
    // A tab of a session with its own port block gets that block back, not
    // the board's (port-blocks.ts). Tabs are `terminal-<postId>-<tab>`.
    const blocks = [...sessionPortBlocks(root)].map(
      ([postId, ports]) => [`terminal-${safeTmuxName(postId)}-`, ports] as const
    );
    for (const session of revived) {
      const ports = blocks.find(([prefix]) => session.startsWith(prefix))?.[1];
      unclaimed.delete(session);
      await keepOneTmuxPane(target, session);
      await respawnTmuxPane({
        target,
        session,
        argv: [
          'bash',
          '-c',
          terminalInitScript(
            paths.get(session) || target.paths.workspace,
            target.paths.bin
          )
        ],
        cwd: paths.get(session) || target.paths.workspace,
        env: {
          ...target.stateEnv(),
          ...(ports ? { FACTIII_PORTS: ports.join(',') } : {})
        }
      }).catch(() => {});
      if (digest) {
        await setTmuxSessionOption(target, session, TERMINAL_FP_OPTION, digest);
      }
    }
  }

  private async applyTerminalConfig(): Promise<void> {
    // Unconditional: `source-file` is idempotent and `startTmuxSession`
    // rewrites this file on every attach anyway, so tracking whether it ran
    // would be more state than it saves.
    await sourceTmuxConf(this.target()).catch(() => {
      // No server running means no session to update, and the next one to
      // start reads the file itself.
    });
  }

  async ensureSetup(): Promise<{ ready: boolean }> {
    await this.ensureSpaceWorkspace();
    return { ready: true };
  }

  async bareWorkNames(): Promise<string[]> {
    const config = this.configProvider.readConfig(this.spaceSlug);
    // No repo, no worktrees: every name is free.
    if (!config.githubToken || !config.repoUrl) return [];
    await this.ensureSpaceWorkspace();
    return listWorkNames(this.target());
  }

  async cardRemoteBranches(): Promise<string[]> {
    const config = this.configProvider.readConfig(this.spaceSlug);
    if (!config.githubToken || !config.repoUrl) return [];
    // Branches come from the primary clone's origin, so ensure the workspace
    // (and its clone) exist first, and refetch: a branch pushed since this
    // space was provisioned is otherwise missing from the picker.
    await this.ensureSpaceWorkspace(undefined, true);
    const target = this.target();
    return listRemoteBranches(target, target.paths.repo);
  }

  destroy(): void {
    this.ready = false;
    this.setupPromise = null;
    // Before the socket goes: a caller blocked at the gate would otherwise sit
    // on a prompt nobody is left to answer.
    this.gate.destroy();
    // The key must not outlive the space that held it.
    this.window.destroy();
    void this.secretsBridge?.close();
    this.secretsBridge = null;
    // Nothing survives the process, so no row should claim it is still going.
    this.activity.destroy();
  }
}
