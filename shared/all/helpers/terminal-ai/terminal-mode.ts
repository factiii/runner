import type { ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';

import type {
  BoardAgentActionMap,
  ExposedPort,
  SessionGitSummary
} from '../../domains/electron';
import { generateCommitMessage } from '../board-agent-core/agent';
import { isCardPostId } from '../board-agent-core/boardTerminal';
import type { ExecTarget } from '../board-agent-core/exec';
import {
  addWorktree,
  claimWorkName,
  extractDiff,
  isGitCheckout,
  isWorktreePath,
  readBranchCompare,
  readCommitDiff,
  readGitBlob,
  readGitPanel,
  readGitSummary,
  setGitIdentity,
  stagePaths,
  unstagePaths
} from '../board-agent-core/git';
import type { GitPanelPolicy } from '../board-agent-core/git-panel-write';
import {
  readFileDiffs,
  readPanelInfo,
  runGitPanelOp
} from '../board-agent-core/git-panel-write';
import type { ModeEngine } from '../board-agent-core/mode';
import type {
  AgentEventSink,
  BaseSession,
  LogEntry,
  SessionSummary
} from '../board-agent-core/session';
import { toSummary } from '../board-agent-core/session';
import type { SpaceCore } from '../board-agent-core/space-core';
import { worktreeFor } from '../board-agent-core/spacePaths';
import type { CardRecord } from '../board-agent-core/state';
import {
  getTerminalAck,
  redisSocketPath,
  setTerminalAck
} from '../board-agent-core/state';
import { tmuxCli } from '../board-agent-core/tmux';
import { putSessionCard, teardownSession } from '../card-ai/card-session';
import { installFrpcHarness, listLiveTunnels } from '../card-ai/frpc';
import { NO_GITHUB_REMOTE } from '../card-ai/gitPanel';
import {
  base64Bytes,
  dropProgressRefusal,
  dropSizeRefusal,
  safeDropId,
  safeDropName,
  uniqueDropName
} from '../terminalDrop';
import {
  activityLine,
  AGENT_ACTIVITY_CHANNEL,
  agentActivityKey,
  hookEvent,
  type PaneAgent,
  parseActivityMessage,
  rollUpAgents
} from './agentActivity';
import {
  AGENT_STATE_CHANNEL,
  type AgentState,
  agentStateKey,
  drainPubSub,
  parseAgentMessage,
  parseAgentState,
  postIdForSessionName,
  sessionNamePrefix
} from './agentState';
import type { ChatHold } from './chatRun';
import { terminalDigest } from './digest';
import { GitRefWatcher } from './gitRefWatcher';
import type { PaneRef, ProcRow } from './processes';
import {
  commandOf,
  panesByPid,
  parsePsTable,
  processesForCard,
  PS_FORMAT,
  socketsFor
} from './processes';
import type { TerminalSession } from './session';
import { parseTerminalTabs, TAB_LIST_FORMAT } from './tabNames';
import { restartTerminalSession, tmuxName } from './terminal';
import type { Subscribe } from './watcher';
import { WorkspaceWatcher } from './watcher';

// What bareFsList's shell answers for a missing folder, in place of a listing.
const FS_ROOT_GONE = '!root-gone';
const FS_DIR_GONE = '!dir-gone';

// Tiny posix-path helpers. Hand-rolled rather than node's `path` so the file
// stays platform-portable.
function posixNormalize(p: string): string {
  const parts = p.split('/').filter(Boolean);
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') {
      if (stack.length) stack.pop();
      continue;
    }
    stack.push(part);
  }
  return '/' + stack.join('/');
}

function posixDirname(p: string): string {
  const i = p.lastIndexOf('/');
  if (i <= 0) return '/';
  return p.slice(0, i);
}

function shEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Decode a base64 payload onto the target's disk, creating its parent dir
 *  first. The payload goes over stdin, never in the command line: a screenshot
 *  or a large file is megabytes of base64, and the OS caps a whole argument
 *  list at ~1MB. Past that the spawn fails with E2BIG.
 *  `append` adds to the file instead of replacing it, and `maxBytes` deletes
 *  the result and fails when the file grows past the cap. */
async function writeBase64File(
  target: ExecTarget,
  abs: string,
  b64: string,
  opts: { append?: boolean; maxBytes?: number } = {}
): Promise<void> {
  const file = shEscape(abs);
  // Unquoted `$(wc -c)` on purpose: BSD wc pads its count with spaces, which
  // `[ -gt ]` will not parse.
  const cap = opts.maxBytes
    ? ` && if [ $(wc -c < ${file}) -gt ${opts.maxBytes} ]; then rm -f ${file}; echo 'file too large' >&2; exit 1; fi`
    : '';
  await target.runWithStdin(
    [
      'bash',
      '-c',
      `mkdir -p ${shEscape(posixDirname(abs))} && base64 -d ${opts.append ? '>>' : '>'} ${file}${cap}`
    ],
    b64,
    `Write ${abs}`
  );
}

function posixBasename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

/** One chunk of a chunked upload (terminalDropFile, bareFsUpload) appended
 *  to its part file. A chunk bigger than the whole file is refused before it
 *  is written, and the part is capped on disk at the declared size (not per
 *  chunk), so the chunks can't add up past it. The part goes on any refusal. */
async function appendUploadChunk(
  target: ExecTarget,
  part: string,
  content: string,
  size: number
): Promise<void> {
  const discard = () => target.run(['rm', '-f', part]).catch(() => undefined);
  const early = dropProgressRefusal({
    declared: size,
    onDisk: base64Bytes(content),
    last: false
  });
  if (early) {
    await discard();
    throw new Error(early);
  }
  try {
    await writeBase64File(target, part, content, {
      append: true,
      maxBytes: size
    });
  } catch (err) {
    await discard();
    throw err;
  }
}

/** Terminal (bare) mode: a user-driven workspace with file/git/editor ops. */
/** Floor between `tmux list-panes` reads when resolving an unknown pane. */
const PANE_REREAD_MS = 1000;

/** How often the tunnels on disk are re-read. `factiii-expose` runs in the
 *  terminal without telling the runner, and a tunnel can die on its own, so
 *  there is nothing to subscribe to. */
const TUNNEL_POLL_MS = 5000;

/** Window a session's git counts are re-read at most once in. An agent's edits
 *  come in bursts — a save, a format, a test run's snapshots — and one read
 *  after the burst says the same as one per file. */
const GIT_SUMMARY_WINDOW_MS = 2000;

const sameGitSummary = (
  a: SessionGitSummary | undefined,
  b: SessionGitSummary
) =>
  !!a &&
  a.ahead === b.ahead &&
  a.behind === b.behind &&
  a.added === b.added &&
  a.removed === b.removed &&
  a.dirty === b.dirty &&
  a.unpushed === b.unpushed;

const sameTunnels = (a: ExposedPort[], b: ExposedPort[]) =>
  a.length === b.length &&
  a.every((t, i) => t.name === b[i]!.name && t.url === b[i]!.url);

/** The checkout a session's git panel reads, '' for none. */
function panelGitDir(session: TerminalSession): string {
  // Where the agent is working, when that is a checkout of its own.
  if (session.workPath && session.workPathGit) return session.workPath;
  return session.workspacePath || '';
}

/** The panel's writes that talk to origin. */
const REMOTE_OPS: ReadonlySet<string> = new Set(['fetch', 'pull', 'push']);

export class TerminalModeEngine implements ModeEngine {
  private sessions = new Map<string, TerminalSession>();
  /** Sessions with a chat turn running (setChatRunning). */
  private chatRunning = new Set<string>();
  /** One working-tree watcher per live bare session, keyed by postId. */
  private watchers = new Map<string, WorkspaceWatcher>();
  /** HEAD and refs of the checkout each session's git panel reads, keyed by
   *  postId: the working-tree watcher prunes .git, and the agent commits and
   *  switches branch in there itself. */
  private gitWatchers = new Map<string, GitRefWatcher>();
  /** Test seam for the ref watchers' OS subscription (see GitRefWatcher). */
  private gitSubscribe?: Subscribe;
  /** Worktree name each session claimed, keyed by postId. Covers the window
   *  `claimWorkName`'s disk scan cannot: a name taken but not yet created. */
  private reservedNames = new Map<string, string>();
  /** Tail of the queue that names finished file drops (terminalDropFile). */
  private dropNaming: Promise<unknown> = Promise.resolve();

  constructor(
    private core: SpaceCore,
    private emitter: AgentEventSink
  ) {}

  // ── agent activity ──

  /** Long-lived `redis-cli subscribe` on the space's own socket. One for every
   *  session: the channel is space-wide and the pane rides in the payload, so
   *  a session starting does not mean re-subscribing. */
  private stateSub: ChildProcess | null = null;
  /** Applies states one at a time; see the comment at the push site. */
  private stateQueue: Promise<void> = Promise.resolve();

  /** Idempotent, like startWatching: re-entering a session must not stack
   *  subscribers. */
  private async startStateSub(): Promise<void> {
    if (this.stateSub) return;
    const target = this.core.target();
    const child = await target
      .spawn([
        'redis-cli',
        '-s',
        redisSocketPath(target),
        'subscribe',
        AGENT_STATE_CHANNEL,
        AGENT_ACTIVITY_CHANNEL
      ])
      .catch(() => null);
    if (!child) return;
    this.stateSub = child;
    let buffer = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      buffer += String(chunk);
      const { messages, rest } = drainPubSub(buffer);
      buffer = rest;
      // Serialised: a message that misses the pane cache awaits tmux, and an
      // unserialised later message would overtake it and then be overwritten
      // by the older state.
      for (const { channel, payload } of messages) {
        const state =
          channel === AGENT_STATE_CHANNEL ? parseAgentMessage(payload) : null;
        const activity =
          channel === AGENT_ACTIVITY_CHANNEL
            ? parseActivityMessage(payload)
            : null;
        if (!state && !activity) continue;
        this.stateQueue = this.stateQueue
          .then(() =>
            state
              ? this.applyPaneState(state.paneId, state.state)
              : this.applyPaneActivity(activity!.paneId, activity!.raw)
          )
          .catch(() => {});
      }
    });
    // A subscriber that dies takes the dots with it, so let the next session
    // start a fresh one rather than leaving a dead handle in place. No
    // redis-cli at all (ENOENT) ends the same way: no dots, runner up.
    const drop = () => {
      if (this.stateSub === child) this.stateSub = null;
    };
    child.once('exit', drop);
    child.once('error', drop);
    void this.hydrateAgentStates();
  }

  /** Read the last reported state for every live session's pane.
   *
   *  Subscribing only catches what happens next. After a runner restart the
   *  sessions come back but no hook has fired yet, so an idle session would
   *  show as working until someone typed in it — which for an idle session may
   *  be never. This is what the hook's SET alongside its PUBLISH is for. */
  private async hydrateAgentStates(): Promise<void> {
    if (this.sessions.size === 0) return;
    await this.refreshPanes();
    const target = this.core.target();
    const read = (key: string) =>
      target
        .sh(`redis-cli -s ${redisSocketPath(target)} get '${key}'`)
        .catch(() => '');
    const touched = new Set<TerminalSession>();
    for (const [paneId, name] of this.paneSessions) {
      const postId = postIdForSessionName(name, this.sessions.keys());
      const session = postId ? this.sessions.get(postId) : null;
      if (!session) continue;
      const raw = await read(agentActivityKey(paneId));
      // The agent that last reported from this pane has exited.
      if (hookEvent(raw) === 'SessionEnd') continue;
      const state = parseAgentState(await read(agentStateKey(paneId)));
      const line = activityLine(raw);
      if (!state && !line) continue;
      // A hook that fired since the subscriber started is newer than redis.
      if (this.paneAgent(session.postId, paneId, false)) continue;
      const agent = this.paneAgent(session.postId, paneId, true)!;
      agent.state = state ?? undefined;
      agent.line = line ?? undefined;
      touched.add(session);
    }
    for (const session of touched) this.rollUp(session);
  }

  /** Called after a session is removed, never before: every stopWatching call
   *  site runs while the session is still in the map, so keying this off
   *  stopWatching would leave the subscriber running for the life of the
   *  process. */
  private releaseStateSub(): void {
    if (this.sessions.size > 0) return;
    this.stateSub?.kill();
    this.stateSub = null;
    if (this.tunnelPoll) clearInterval(this.tunnelPoll);
    this.tunnelPoll = null;
  }

  // ── which terminal opened which public link ──

  private tunnelPoll: ReturnType<typeof setInterval> | null = null;

  /** Idempotent, like startStateSub. Stopped with it, in releaseStateSub. */
  private startTunnelPoll(): void {
    if (this.tunnelPoll) return;
    this.tunnelPoll = setInterval(() => {
      void this.refreshTunnels();
      void this.pruneClosedTabs();
    }, TUNNEL_POLL_MS);
    void this.refreshTunnels();
  }

  /** File every live tunnel under the session whose terminal opened it, and
   *  tell the app about the sessions whose list changed. A tunnel with no
   *  resolvable owner (its tab has closed, or an older `factiii-expose` opened
   *  it) is on no session; the Ports panel still lists it. */
  private async refreshTunnels(): Promise<void> {
    if (this.sessions.size === 0) return;
    const tunnels = await listLiveTunnels(this.core.target()).catch(() => null);
    if (!tunnels) return;
    const byPost = new Map<string, ExposedPort[]>();
    for (const { owner, ...tunnel } of tunnels) {
      if (!owner) continue;
      let name: string | undefined = owner;
      if (owner.startsWith('%')) {
        name = this.paneSessions.get(owner);
        if (!name) {
          await this.refreshPanes();
          name = this.paneSessions.get(owner);
        }
      }
      const postId = name
        ? postIdForSessionName(name, this.sessions.keys())
        : null;
      if (!postId) continue;
      byPost.set(postId, [...(byPost.get(postId) ?? []), tunnel]);
    }
    for (const [postId, session] of this.sessions) {
      if (session.mode !== 'bare') continue;
      const next = byPost.get(postId) ?? [];
      if (sameTunnels(session.exposed ?? [], next)) continue;
      session.exposed = next;
      this.emitter.emitSessionUpdate(session);
    }
  }

  /** pane id -> tmux session name, refreshed only when a pane we have not seen
   *  turns up. Panes outlive individual messages, so re-reading the whole map
   *  per message would be a tmux call per hook. */
  private paneSessions = new Map<string, string>();
  private paneReadAt = 0;

  private async sessionForPane(
    paneId: string
  ): Promise<TerminalSession | null> {
    let name = this.paneSessions.get(paneId);
    if (!name) {
      await this.refreshPanes();
      name = this.paneSessions.get(paneId);
    }
    if (!name) return null;
    const postId = postIdForSessionName(name, this.sessions.keys());
    return (postId && this.sessions.get(postId)) || null;
  }

  // ── several agents in one session ──

  /** postId -> pane -> what that tab's agent last reported. A session's tabs
   *  can each run an agent, and one field per session would show whichever
   *  hooked last — an idle tab hiding one that is waiting on you. */
  private paneAgents = new Map<string, Map<string, PaneAgent>>();

  private paneAgent(
    postId: string,
    paneId: string,
    create: boolean
  ): PaneAgent | undefined {
    let panes = this.paneAgents.get(postId);
    if (!panes && create) {
      panes = new Map();
      this.paneAgents.set(postId, panes);
    }
    let agent = panes?.get(paneId);
    if (!agent && create) {
      agent = { at: Date.now(), tab: 0 };
      panes!.set(paneId, agent);
    }
    return agent;
  }

  /** Fold the session's agents into its one state and line, and tell the app
   *  if either moved. With none left — the last one exited
   *  or its tab closed — the row goes idle and keeps its last line. */
  private rollUp(session: TerminalSession): void {
    const panes = this.paneAgents.get(session.postId) ?? new Map();
    // Tab numbers as the strip shows them: its tabs sorted by id, 1-based.
    const prefix = sessionNamePrefix(session.postId);
    const tabIds = [...this.paneSessions.values()]
      .filter((name) => name.startsWith(prefix))
      .map((name) => name.slice(prefix.length))
      .sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0));
    for (const [paneId, agent] of panes) {
      const name = this.paneSessions.get(paneId);
      agent.tab = name ? tabIds.indexOf(name.slice(prefix.length)) + 1 : 0;
    }
    const rolled = panes.size
      ? rollUpAgents([...panes.values()])
      : {
          state: session.agentState && ('idle' as const),
          line: session.agentActivity
        };
    const { line } = rolled;
    // A chat turn is work too, unless a tab is waiting on a prompt (which
    // still needs you). Its end rolls up again, back to what the tabs say.
    const state =
      this.chatRunning.has(session.postId) && rolled.state !== 'blocked'
        ? ('working' as const)
        : rolled.state;
    // A tab with an agent in it: the git panel's Switch says the agent moves
    // with the branch, and asks first.
    const live = panes.size > 0;
    if (
      session.agentState === state &&
      session.agentActivity === line &&
      session.agentLive === live
    ) {
      return;
    }
    session.agentState = state;
    session.agentActivity = line;
    session.agentLive = live;
    this.emitter.emitSessionUpdate(session);
  }

  private async applyPaneState(
    paneId: string,
    state: AgentState
  ): Promise<void> {
    const session = await this.sessionForPane(paneId);
    if (!session) return;
    const agent = this.paneAgent(session.postId, paneId, true)!;
    agent.state = state;
    agent.at = Date.now();
    this.rollUp(session);
    // A turn ending is when its commits are done. The working-tree watcher
    // never sees a commit — .git is pruned from it — so this counts them,
    // alongside the ref watcher (GitRefWatcher) when one is running.
    if (state === 'idle') this.scheduleGitSummary(session.postId);
  }

  /** Every tool call lands here, so the git counts follow the agent's work
   *  without a poll: an edit, a commit and a test run are each a tool call. */
  private async applyPaneActivity(paneId: string, raw: string): Promise<void> {
    const session = await this.sessionForPane(paneId);
    if (!session) return;
    this.scheduleGitSummary(session.postId);
    // The agent exited and the tab is back to a shell: it no longer counts.
    // Its state message (idle) came first and was already folded in.
    if (hookEvent(raw) === 'SessionEnd') {
      this.paneAgents.get(session.postId)?.delete(paneId);
      this.rollUp(session);
      return;
    }
    const line = activityLine(raw);
    if (!line) return;
    const agent = this.paneAgent(session.postId, paneId, true)!;
    agent.line = line;
    agent.at = Date.now();
    this.rollUp(session);
  }

  /** A tab closed with its agent still running fires no SessionEnd, so its
   *  last state would hold the row (a dead tab stuck on Working). Its pane is
   *  gone from tmux, which is what this checks, on the tunnel poll's beat. */
  private async pruneClosedTabs(): Promise<void> {
    if (this.paneAgents.size === 0) return;
    await this.refreshPanes();
    // A failed tmux read leaves the map empty, which would read as every tab
    // closed and drop every agent at once.
    if (this.paneSessions.size === 0) return;
    for (const [postId, panes] of this.paneAgents) {
      const session = this.sessions.get(postId);
      if (!session) {
        this.paneAgents.delete(postId);
        continue;
      }
      let pruned = false;
      for (const paneId of panes.keys()) {
        if (this.paneSessions.has(paneId)) continue;
        panes.delete(paneId);
        pruned = true;
      }
      if (pruned) this.rollUp(session);
    }
  }

  // ── git counts for the rail ──

  private gitSummaryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** At most one read per window per session, at its end. Not a reset on
   *  each event: a dev server rewriting its build output would hold the read
   *  off for as long as it runs. */
  private scheduleGitSummary(postId: string): void {
    if (this.gitSummaryTimers.has(postId)) return;
    this.gitSummaryTimers.set(
      postId,
      setTimeout(() => {
        this.gitSummaryTimers.delete(postId);
        void this.refreshGitSummary(postId);
      }, GIT_SUMMARY_WINDOW_MS)
    );
  }

  private async refreshGitSummary(postId: string): Promise<void> {
    const session = this.sessions.get(postId);
    // A no-git card runs out of the workspace, which has no branch to count.
    if (!session || session.mode !== 'bare') return;
    const followed =
      session.workPath && session.workPathGit ? session.workPath : '';
    // The board's workspace (where a Chat session starts, and its seeded
    // workPath) is no session's branch: nothing of this session's to count.
    const gitDir =
      followed && followed !== this.core.target().paths.workspace
        ? followed
        : session.workspacePath;
    if (!gitDir) {
      // Moved off a checkout: its count is not this folder's.
      if (session.git) {
        session.git = undefined;
        this.emitter.emitSessionUpdate(session);
      }
      return;
    }
    const cut = session.targetBranch;
    const summary = await readGitSummary(this.core.target(), gitDir, [
      ...(cut ? [`origin/${cut}`, cut] : []),
      'origin/main',
      'origin/master',
      'main',
      'master'
    ]).catch(() => null);
    // Ended while git ran: emitting now would bring a closed session back.
    if (!summary || this.sessions.get(postId) !== session) return;
    if (sameGitSummary(session.git, summary)) return;
    session.git = summary;
    this.emitter.emitSessionUpdate(session);
  }

  /** Rate-limited: a pane that will never resolve — one whose session has
   *  since closed — would otherwise re-list on every message it sent, which is
   *  a tmux subprocess per hook. */
  private async refreshPanes(): Promise<void> {
    const now = Date.now();
    if (now - this.paneReadAt < PANE_REREAD_MS) return;
    this.paneReadAt = now;
    const target = this.core.target();
    const out = await target
      .sh(
        `${tmuxCli(target)} list-panes -a -F '#{pane_id}|#{session_name}' 2>/dev/null || true`
      )
      .catch(() => '');
    this.paneSessions.clear();
    for (const raw of out.split('\n')) {
      const [pane, name] = raw.trim().split('|');
      if (pane && name) this.paneSessions.set(pane, name);
    }
  }

  // ── working-tree watching ──

  /** Start watching a session's tree. Idempotent: re-entering a session (the
   *  modal reopening, a hydrate after restart) must not stack watchers. */
  private startWatching(session: TerminalSession): void {
    const postId = session.postId;
    void this.startStateSub();
    this.startTunnelPoll();
    this.syncGitWatch(session);
    if (this.watchers.has(postId)) return;
    const paths = this.core.target().paths;
    const root = this.workRoot(session);
    if (!root) return;
    if (!session.workPath) void this.seedWorkPath(session, root);
    // An agent that went up to the space root finds the runner's own
    // bookkeeping there. The redis AOF in `state` alone would fire events
    // forever, and `worktrees` would make one card echo every other card's
    // edits. `workspace` is deploy's own full checkout, which `git clean -fd`s
    // itself - watching it means a deploy floods the card with a whole tree of
    // changes.
    const exclude =
      root !== paths.root
        ? []
        : [
            paths.state,
            paths.backups,
            paths.builds,
            paths.bin,
            paths.worktrees,
            paths.repo,
            paths.workspace,
            paths.scratchpad,
            paths.drops
          ];
    const watcher = new WorkspaceWatcher(
      root,
      (change) => {
        this.emitter.emitBareFsChange(postId, change);
        // Edits typed by hand fire no hook, so the tree is the other trigger.
        this.scheduleGitSummary(postId);
      },
      exclude
    );
    this.watchers.set(postId, watcher);
    watcher.start();
    this.scheduleGitSummary(postId);
  }

  /** Say where a session's IDE is from its first snapshot: its own folder
   *  (workRoot: a Code session's worktree, a Chat's workspace) and whether
   *  that is a git checkout, read from the folder itself. Without it the
   *  client guessed git from the board's GitHub connection and hid Source
   *  Control from a chat in a real clone until its agent moved. Not resolved
   *  to the git top: the panel's write rule compares this to workspacePath
   *  as spelled. Yields to the follower or set_work_path if either got there
   *  first. */
  private async seedWorkPath(
    session: TerminalSession,
    root: string
  ): Promise<void> {
    const git = await isGitCheckout(this.core.target(), root);
    if (this.sessions.get(session.postId) !== session) return;
    if (session.workPath) return;
    session.workPath = root;
    session.workPathGit = git;
    // A Chat's workspace becomes the panel's checkout only now.
    this.syncGitWatch(session);
    this.emitter.emitSessionUpdate(session);
  }

  /** Watch HEAD and the refs of the checkout the session's git panel reads,
   *  moving the watch when that checkout changes. Each burst goes to the
   *  client as a `git` batch on the session's bare-fs channel, so the panel
   *  re-reads when the agent commits or switches branch. */
  private syncGitWatch(session: TerminalSession): void {
    const postId = session.postId;
    const dir = panelGitDir(session);
    const existing = this.gitWatchers.get(postId);
    if (existing?.workdir === dir) return;
    if (existing) {
      this.gitWatchers.delete(postId);
      void existing.close();
    }
    if (!dir) return;
    const target = this.core.target();
    const watcher = new GitRefWatcher(
      dir,
      (argv) => target.run(argv),
      () => {
        this.emitter.emitBareFsChange(postId, {
          added: [],
          changed: [],
          removed: [],
          resync: false,
          git: true
        });
        this.scheduleGitSummary(postId);
      },
      this.gitSubscribe
    );
    this.gitWatchers.set(postId, watcher);
    watcher.start();
  }

  /** Silent by design: a session that ends also emits session-update, and a
   *  re-point stops then starts. The one `stopped` the client cares about is
   *  the watcher failing under a live session, which the watcher emits itself. */
  private stopWatching(postId: string): void {
    const pending = this.gitSummaryTimers.get(postId);
    if (pending) clearTimeout(pending);
    this.gitSummaryTimers.delete(postId);
    const gitWatcher = this.gitWatchers.get(postId);
    this.gitWatchers.delete(postId);
    if (gitWatcher) void gitWatcher.close();
    const watcher = this.watchers.get(postId);
    if (!watcher) return;
    this.watchers.delete(postId);
    void watcher.close();
  }

  /** Suppress the change event our own write is about to produce, so a save
   *  never comes back to the editor as an outside edit. Normalized to the form
   *  the watcher emits, since callers spell the path either way. */
  private expectWrite(postId: string, path: string): void {
    this.watchers.get(postId)?.expectWrite(posixNormalize(path));
  }

  // ── Lifecycle / ModeEngine ──

  start(
    base: BaseSession,
    args: { baseBranch: string; worktree: boolean }
  ): void {
    const session: TerminalSession = {
      ...base,
      openedFiles: [],
      buffers: {}
    };
    this.sessions.set(session.postId, session);
    this.emitter.emitSessionUpdate(session);

    const onError = (err: unknown) => {
      if (!this.sessions.has(session.postId)) return;
      session.phase = 'error';
      session.error = err instanceof Error ? err.message : String(err);
      this.emitter.addLog(session, 'error', session.error);
      this.emitter.emitSessionUpdate(session);
    };

    this.runBareSession(session, args.baseBranch, args.worktree).catch(onError);
  }

  listSummaries(): Record<string, SessionSummary> {
    const result: Record<string, SessionSummary> = {};
    for (const [postId, session] of this.sessions) {
      result[postId] = toSummary(session);
    }
    return result;
  }

  get(postId: string): BaseSession | undefined {
    return this.sessions.get(postId);
  }

  /** Link the session to a card, or unlink it with ''. False when there is
   *  no such session. */
  setCardId(postId: string, cardId: string): boolean {
    const session = this.sessions.get(postId);
    if (!session) return false;
    if (session.cardId !== cardId) {
      session.cardId = cardId;
      this.syncCard(session);
      this.emitter.emitSessionUpdate(session);
    }
    return true;
  }

  /** A chat turn (chatRun.ts) started or ended for this session. The turn
   *  runs headless in no tab, so no hook reports it; the roll-up counts it
   *  as working, or the rail showed Idle (or nothing) while the agent ran. */
  setChatRunning(postId: string, running: boolean): void {
    if (running) this.chatRunning.add(postId);
    else this.chatRunning.delete(postId);
    const session = this.sessions.get(postId);
    if (session) this.rollUp(session);
  }

  /** The chat's hold on the conversation moved (chatRun.ts ChatHold): the
   *  terminal says so while Claude is in no tab. */
  setChatHold(postId: string, hold: ChatHold): void {
    const session = this.sessions.get(postId);
    if (!session || (session.chatHold ?? '') === hold) return;
    session.chatHold = hold;
    this.emitter.emitSessionUpdate(session);
  }

  /** The conversation the session's chat runs (chatRun.ts). Kept with the
   *  card, so a restart resumes it, and a primary tab opened fresh resumes it
   *  in the terminal. */
  setAgentSessionId(postId: string, agentSessionId: string): void {
    const session = this.sessions.get(postId);
    if (!session || session.agentSessionId === agentSessionId) return;
    session.agentSessionId = agentSessionId;
    this.syncCard(session);
    this.emitter.emitSessionUpdate(session);
  }

  sessionWithLogs(
    postId: string
  ): (SessionSummary & { logs: LogEntry[] }) | null {
    const session = this.sessions.get(postId);
    if (!session) return null;
    return { ...toSummary(session), logs: session.logs };
  }

  has(postId: string): boolean {
    return this.sessions.has(postId);
  }

  isRunning(postId: string): boolean {
    const s = this.sessions.get(postId);
    return !!s && (s.phase === 'starting' || s.phase === 'bare-active');
  }

  /** Every worktree this engine holds or is about to create: a terminal claims
   *  its name before the tree exists, and has the tree before its record. The
   *  startup sweep must not take either. */
  claimedWorkspaces(): string[] {
    const paths = this.core.target().paths;
    const claimed = [...this.reservedNames.values()].map((name) =>
      worktreeFor(paths, name)
    );
    for (const s of this.sessions.values()) {
      if (s.workspacePath) claimed.push(s.workspacePath);
    }
    return claimed;
  }

  remove(postId: string): void {
    this.stopWatching(postId);
    this.paneAgents.delete(postId);
    this.reservedNames.delete(postId);
    this.sessions.delete(postId);
    this.releaseStateSub();
  }

  async kill(postId: string): Promise<void> {
    let session = this.sessions.get(postId);
    if (!session) {
      for (const [, s] of this.sessions) {
        if (s.taskId === postId) {
          session = s;
          break;
        }
      }
    }
    if (!session) return;

    this.stopWatching(session.postId);
    await teardownSession(session, this.core.target());

    const removedPostId = session.postId;
    this.paneAgents.delete(removedPostId);
    this.reservedNames.delete(removedPostId);
    this.sessions.delete(removedPostId);
    this.releaseStateSub();
    this.emitter.emitSessionRemoved(removedPostId);
  }

  destroy(): void {
    // Nothing per-session to tear down: every card shares the space workspace.
    // The watchers are the exception - they hold OS handles.
    for (const watcher of this.watchers.values()) void watcher.close();
    this.watchers.clear();
    for (const watcher of this.gitWatchers.values()) void watcher.close();
    this.gitWatchers.clear();
    this.reservedNames.clear();
    this.sessions.clear();
  }

  private putCard(s: TerminalSession): Promise<void> {
    return putSessionCard(s, this.core.target());
  }

  private syncCard(s: TerminalSession): void {
    void this.putCard(s);
  }

  /** Rebuild bare sessions from redis after a restart: user-driven, so they come
   *  back `bare-active` (worktree + tmux survive; editor state is lost). */
  hydrate(records: CardRecord[]): void {
    for (const r of records) {
      if (r.mode !== 'bare' || this.sessions.has(r.postId)) continue;
      const session: TerminalSession = {
        taskId: r.taskId,
        postId: r.postId,
        phase: 'bare-active',
        mode: 'bare',
        step: 1,
        logs: [],
        diff: '',
        changedFiles: [],
        commitMessage: '',
        previewUrl: '',
        previewRunning: false,
        reproSteps: '',
        pendingQuestion: '',
        error: '',
        startedAt: r.startedAt,
        taskTitle: r.taskTitle,
        targetBranch: r.targetBranch,
        effort: 'high',
        todos: [],
        provider: r.provider,
        workspacePath: r.worktreePath,
        agentSessionId: r.agentSessionId,
        cardId: r.cardId,
        startedBy: r.startedBy,
        startedVia: r.startedVia,
        openedFiles: [],
        buffers: {}
      };
      this.sessions.set(r.postId, session);
      this.startWatching(session);
      this.emitter.emitSessionUpdate(session);
    }
  }

  /** Register the board Ask conversation as a `bare-active` session under the
   *  board key (upsert) so the standard bare terminal modal resumes it. */
  adoptBoardSession(args: {
    postId: string;
    agentSessionId: string;
    provider: TerminalSession['provider'];
    workspacePath: string;
    taskTitle: string;
  }): void {
    const existing = this.sessions.get(args.postId);
    const session: TerminalSession = existing
      ? {
          ...existing,
          phase: 'bare-active',
          agentSessionId: args.agentSessionId,
          provider: args.provider,
          workspacePath: args.workspacePath,
          taskTitle: args.taskTitle,
          // A new cwd is a new folder: startWatching below seeds it again.
          ...(existing.workspacePath !== args.workspacePath
            ? { workPath: undefined, workPathGit: undefined }
            : {})
        }
      : {
          taskId: args.postId,
          postId: args.postId,
          phase: 'bare-active',
          mode: 'bare',
          step: 1,
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
          taskTitle: args.taskTitle,
          targetBranch: '',
          effort: 'high',
          todos: [],
          provider: args.provider,
          workspacePath: args.workspacePath,
          agentSessionId: args.agentSessionId,
          openedFiles: [],
          buffers: {}
        };
    this.sessions.set(args.postId, session);
    // An upsert can move the board session to a different cwd, so re-point the
    // watcher rather than leaving it on the old one.
    this.stopWatching(args.postId);
    this.startWatching(session);
    this.emitter.emitSessionUpdate(session);
  }

  // ── workspace + Claude CLI, user drives ──

  /** `worktree`: a Code session's own worktree and branch, where the board
   *  has a repository; a Chat session (false) runs in the workspace. */
  private async runBareSession(
    session: TerminalSession,
    baseBranch: string,
    worktree: boolean
  ): Promise<void> {
    const config = this.core.readConfig();

    this.emitter.addLog(session, 'system', 'Preparing environment...');

    // One persistent workspace per space; git gets a worktree, else its root.
    await this.core.ensureSpaceWorkspace();

    if (worktree && config.repoUrl && config.githubToken) {
      const branch = baseBranch || config.mainBranch || 'main';
      // A launcher terminal is named by the user, so the tree and its branch
      // take that name instead of the random session id. A card opened in
      // terminal mode has only the card's title - not the user's to choose,
      // and not unique - so it keeps the task id.
      const workName = isCardPostId(session.postId)
        ? session.taskId
        : await claimWorkName(
            this.core.target(),
            session.taskTitle,
            this.reservedNames.values()
          );
      this.reservedNames.set(session.postId, workName);
      const { path } = await addWorktree(
        this.core.target(),
        workName,
        branch,
        'terminal'
      );
      session.workspacePath = path;
      await setGitIdentity(
        this.core.target(),
        config.gitName,
        config.gitEmail,
        path
      );
      this.emitter.addLog(session, 'system', 'Worktree ready.');
    } else {
      session.workspacePath = '';
      this.emitter.addLog(session, 'system', 'Workspace ready.');
    }
    await this.putCard(session);

    // frpc harness for the Ports UI (factiii-expose/unexpose). Skipped with no
    // frp token configured; expose calls then surface an error.
    if (this.core.canExpose) {
      try {
        await installFrpcHarness({
          target: this.core.target(),
          taskId: session.taskId
        });
      } catch (err) {
        // Non-fatal: the terminal still works without port forwarding.
        this.emitter.addLog(
          session,
          'system',
          `Port forwarding unavailable: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    session.phase = 'bare-active';
    // The tree exists now, so it can be watched. Everything after this point
    // (the agent, the terminal, git) edits it out from under the editor.
    this.startWatching(session);
    this.emitter.emitSessionUpdate(session);
    this.emitter.addLog(
      session,
      'system',
      'Workspace ready. Drive it from the terminal.'
    );
  }

  // ── file ops ──

  private getBareTarget(postId: string): ExecTarget {
    const session = this.sessions.get(String(postId));
    if (!session) throw new Error('No active session for this card.');
    if (session.mode !== 'bare') {
      throw new Error('File ops are only available in Bare mode.');
    }
    if (session.phase !== 'bare-active' && session.phase !== 'bare-review') {
      throw new Error('Workspace is not ready.');
    }
    return this.core.target();
  }

  /** The root for this card's file ops (the IDE): workRoot. */
  private getBareRoot(postId: string): string {
    const session = this.sessions.get(String(postId));
    return session
      ? this.workRoot(session)
      : this.core.target().paths.workspace;
  }

  /** Where the session's IDE looks: the project its agent last worked in
   *  (workPath, which the engine follows), else its worktree, else the
   *  board's workspace, where a session with no worktree runs. Never the
   *  space root by default: that is the runner's own folder (secrets, state,
   *  every other session's worktree). */
  private workRoot(session: TerminalSession): string {
    return (
      session.workPath ||
      session.workspacePath ||
      this.core.target().paths.workspace
    );
  }

  /** What the follower last read for this session (followedPath), or
   *  undefined with no such session. */
  followed(postId: string): string | undefined {
    const session = this.sessions.get(postId);
    return session ? (session.followedPath ?? '') : undefined;
  }

  /** The follower read a new folder for this session. */
  setFollowed(postId: string, path: string): void {
    const session = this.sessions.get(postId);
    if (session) session.followedPath = path;
  }

  /** Point the session's IDE, watcher and git panel at where its agent is
   *  working now. No-op when that is where they already are. */
  setWorkPath(postId: string, workPath: string, isGit: boolean): void {
    const session = this.sessions.get(postId);
    if (!session) return;
    if (session.workPath === workPath && session.workPathGit === isGit) return;
    session.workPath = workPath;
    session.workPathGit = isGit;
    // The watcher is on the old root; starting it again also counts the new
    // folder's changes (or clears the old count).
    this.stopWatching(postId);
    this.startWatching(session);
    this.emitter.emitSessionUpdate(session);
  }

  /** Resolve a repo-relative path under `root`, rejecting anything that
   *  escapes it. */
  private resolveBarePath(rel: string, root: string): string {
    const normalized = posixNormalize('/' + (rel || '').replace(/^\/+/, ''));
    const abs = `${root}${normalized === '/' ? '' : normalized}`;
    if (abs !== root && !abs.startsWith(root + '/')) {
      throw new Error('Path escapes repo root.');
    }
    return abs;
  }

  async bareFsList({
    postId,
    path
  }: BoardAgentActionMap['bareFsList']['payload']): Promise<
    BoardAgentActionMap['bareFsList']['result']
  > {
    const target = this.getBareTarget(postId);
    const root = this.getBareRoot(postId);
    const abs = this.resolveBarePath(path, root);
    const relRoot = abs.slice(root.length) || '/';
    // Portable listing that doesn't lean on GNU find's -printf; loop and
    // classify each entry. .git is hidden from the editor on purpose.
    //
    // Run under `sh`, NOT the login shell `target.sh()` would use: zsh - the
    // default on macOS, so what $SHELL hands the runner - treats a glob that
    // matches nothing as a fatal error and aborts the whole loop with "no
    // matches found: .*". Every folder with no dotfile in it therefore listed
    // as empty. POSIX sh leaves an unmatched glob as its own literal, which the
    // `-e` test below drops.
    //
    // A missing folder answers a marker instead of failing `cd`: the failure
    // came back as "Command failed: sh -c cd ..." with this whole script in
    // it, which is what the IDE showed for a session whose worktree had been
    // removed. Entry lines start with d/ or f/, so a marker can't collide.
    const out = await target.run([
      'sh',
      '-c',
      `if [ ! -d ${shEscape(root)} ]; then echo "${FS_ROOT_GONE}"; exit 0; fi
      if [ ! -d ${shEscape(abs)} ]; then echo "${FS_DIR_GONE}"; exit 0; fi
      cd ${shEscape(abs)} && for f in .* *; do
        case "$f" in
          "."|".."|".git"|"*") continue ;;
        esac
        [ -e "$f" ] || continue
        if [ -d "$f" ]; then echo "d/$f"; else echo "f/$f"; fi
      done | LC_ALL=C sort`
    ]);
    const marker = out.trim();
    if (marker === FS_ROOT_GONE) {
      throw new Error(
        "This session's folder no longer exists (its worktree was removed). End the session and start a new one."
      );
    }
    if (marker === FS_DIR_GONE) {
      throw new Error(`${relRoot} no longer exists.`);
    }
    const entries: BoardAgentActionMap['bareFsList']['result'] = [];
    for (const line of out.split('\n')) {
      if (!line) continue;
      const sep = line.indexOf('/');
      if (sep < 0) continue;
      const ty = line.slice(0, sep);
      const name = line.slice(sep + 1);
      const type: 'file' | 'dir' = ty === 'd' ? 'dir' : 'file';
      entries.push({
        name,
        path: relRoot === '/' ? `/${name}` : `${relRoot}/${name}`,
        type
      });
    }
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return entries;
  }

  async bareFsSearch({
    postId
  }: BoardAgentActionMap['bareFsSearch']['payload']): Promise<
    BoardAgentActionMap['bareFsSearch']['result']
  > {
    const target = this.getBareTarget(postId);
    const root = this.getBareRoot(postId);
    // git ls-files is fast and respects .gitignore; `find` covers a non-repo.
    // Capped so a giant tree can't blow the wire.
    const out = await target.sh(
      `cd ${shEscape(root)} && (git ls-files --cached --others --exclude-standard 2>/dev/null || find . -type f -not -path './.git/*' | sed 's|^\\./||') | head -n 5000`
    );
    const files: string[] = [];
    for (const line of out.split('\n')) {
      const p = line.trim();
      if (p) files.push('/' + p);
    }
    return files;
  }

  async bareFsRead({
    postId,
    path
  }: BoardAgentActionMap['bareFsRead']['payload']): Promise<
    BoardAgentActionMap['bareFsRead']['result']
  > {
    const target = this.getBareTarget(postId);
    const abs = this.resolveBarePath(path, this.getBareRoot(postId));
    // `base64 -w 0` is GNU-only (BSD/macOS spells it -b), so pipe through tr
    // instead of asking base64 to suppress wrapping.
    const b64 = (
      await target.sh(`base64 < ${shEscape(abs)} | tr -d '\n'`)
    ).trim();
    return { content: b64, encoding: 'base64' };
  }

  async bareFsWrite({
    postId,
    path,
    content,
    encoding
  }: BoardAgentActionMap['bareFsWrite']['payload']): Promise<void> {
    const target = this.getBareTarget(postId);
    const abs = this.resolveBarePath(path, this.getBareRoot(postId));
    const b64 =
      encoding === 'base64'
        ? content
        : Buffer.from(content, 'utf-8').toString('base64');
    if (!/^[A-Za-z0-9+/=\n\r]*$/.test(b64)) {
      throw new Error('Invalid base64 payload.');
    }
    this.expectWrite(String(postId), path);
    await writeBase64File(target, abs, b64);
    // File is now on disk in the state the client just sent - any buffered
    // edits for this path are by definition no longer "unsaved".
    const session = this.sessions.get(String(postId));
    if (session) delete session.buffers[path];
  }

  /** Append one chunk of a dropped image to the per-space drops dir
   *  (`paths.root`, OUTSIDE the card worktree so it never touches the repo).
   *  Returns the absolute path on the last chunk, '' before that. */
  async terminalDropImage({
    postId,
    content,
    ext,
    dropId,
    last
  }: BoardAgentActionMap['terminalDropImage']['payload']): Promise<string> {
    const target = this.getBareTarget(postId);
    if (!/^[A-Za-z0-9+/=\n\r]*$/.test(content)) {
      throw new Error('Invalid base64 payload.');
    }
    // Sanitize both halves of the filename to plain alphanumerics so neither
    // can smuggle path or shell characters in.
    const safeExt =
      (ext || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
    // A client older than the chunked protocol sends neither field: it is one
    // whole image per call, so name the file here and close the drop at once.
    const oneShot = !dropId;
    const safeId = oneShot
      ? randomUUID()
      : dropId.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!safeId) throw new Error('Invalid drop id.');
    const dropsDir = target.paths.drops;
    const abs = `${dropsDir}/${safeId}.${safeExt}`;
    // Capped on disk, not per chunk, so the chunks can't add up past the limit.
    await writeBase64File(target, abs, content, {
      append: !oneShot,
      maxBytes: 10_000_000
    });
    if (!last && !oneShot) return '';
    // Best-effort prune so dropped images can't grow unbounded.
    try {
      await target.sh(
        `find ${shEscape(dropsDir)} -type f -mtime +1 -delete 2>/dev/null || true`
      );
    } catch {
      // pruning is best-effort; the drop already succeeded
    }
    return abs;
  }

  /** Append one chunk of a dropped file to the per-space drops dir and, on
   *  the last chunk, give it its own name and return the absolute path (''
   *  before that). The chunks collect in a hidden `.upload-<dropId>.part`, so
   *  a half-sent file never sits under a real name.
   *
   *  The name is the client's, so nothing here trusts it: `safeDropName`
   *  leaves one path segment, and the size is held to the declared one (and
   *  to TERMINAL_DROP_MAX_BYTES) on disk after every chunk. Nothing is
   *  pruned here. */
  async terminalDropFile({
    postId,
    content,
    dropId,
    name,
    size,
    last
  }: BoardAgentActionMap['terminalDropFile']['payload']): Promise<string> {
    const target = this.getBareTarget(postId);
    if (typeof content !== 'string' || !/^[A-Za-z0-9+/=\n\r]*$/.test(content)) {
      throw new Error('Invalid base64 payload.');
    }
    const safeId = safeDropId(dropId);
    if (!safeId) throw new Error('Invalid drop id.');
    const safeName = safeDropName(name);
    const sizeRefusal = dropSizeRefusal(safeName, size);
    if (sizeRefusal) throw new Error(sizeRefusal);
    const dropsDir = target.paths.drops;
    const part = `${dropsDir}/.upload-${safeId}.part`;
    const discard = () => target.run(['rm', '-f', part]).catch(() => undefined);
    await appendUploadChunk(target, part, content, size);
    if (!last) return '';
    const finish = async (): Promise<string> => {
      // Run under `sh`, not the login shell `target.sh()` would use: the
      // first line of the output is read as a number.
      const out = await target.run([
        'sh',
        '-c',
        `wc -c < ${shEscape(part)} && ls -A1 ${shEscape(dropsDir)}`
      ]);
      const [count = '', ...taken] = out.split('\n');
      const refusal = dropProgressRefusal({
        declared: size,
        onDisk: Number(count.trim() || NaN),
        last: true
      });
      if (refusal) {
        await discard();
        throw new Error(refusal);
      }
      const abs = `${dropsDir}/${uniqueDropName(safeName, taken.filter(Boolean))}`;
      // `ln` refuses a name that exists, so a file that appeared since the
      // listing is still never overwritten.
      await target.run(['ln', part, abs]);
      await discard();
      return abs;
    };
    // One naming step at a time: two drops finishing together would read the
    // same listing and pick the same name.
    const named = this.dropNaming.then(finish, finish);
    this.dropNaming = named.catch(() => undefined);
    return named;
  }

  /** Append one chunk of an Explorer upload to a hidden part file in the
   *  drops dir (outside the repo, so the watcher never sees half a file)
   *  and, on the last chunk, move it to `path` in the repo. The same id,
   *  size and progress rules as terminalDropFile; the path is resolved like
   *  bareFsWrite's. */
  async bareFsUpload({
    postId,
    path,
    content,
    uploadId,
    size,
    last,
    replace
  }: BoardAgentActionMap['bareFsUpload']['payload']): Promise<void> {
    const target = this.getBareTarget(postId);
    const root = this.getBareRoot(postId);
    const abs = this.resolveBarePath(path, root);
    if (abs === root) throw new Error('Name the file to upload.');
    if (typeof content !== 'string' || !/^[A-Za-z0-9+/=\n\r]*$/.test(content)) {
      throw new Error('Invalid base64 payload.');
    }
    const safeId = safeDropId(uploadId);
    if (!safeId) throw new Error('Invalid upload id.');
    const name = posixBasename(abs);
    const sizeRefusal = dropSizeRefusal(name, size);
    if (sizeRefusal) throw new Error(sizeRefusal);
    const part = `${target.paths.drops}/.upload-${safeId}.part`;
    const discard = () => target.run(['rm', '-f', part]).catch(() => undefined);
    await appendUploadChunk(target, part, content, size);
    if (!last) return;
    // Under `sh`, not the login shell: the first line is read as a number,
    // the second says what is at the destination now.
    const out = await target.run([
      'sh',
      '-c',
      'wc -c < "$1"; if [ -d "$2" ]; then echo dir; elif [ -e "$2" ]; then echo file; else echo none; fi',
      'sh',
      part,
      abs
    ]);
    const [count = '', there = ''] = out.split('\n').map((l) => l.trim());
    let refusal = dropProgressRefusal({
      declared: size,
      onDisk: Number(count || NaN),
      last: true
    });
    if (!refusal && there === 'dir') refusal = `${name} is a folder here.`;
    if (!refusal && there === 'file' && !replace) {
      refusal = `${name} already exists here.`;
    }
    if (refusal) {
      await discard();
      throw new Error(refusal);
    }
    this.expectWrite(String(postId), path);
    try {
      await target.run(['mkdir', '-p', posixDirname(abs)]);
      await target.run(['mv', '-f', part, abs]);
    } catch (err) {
      await discard();
      throw err;
    }
    // The file on disk is what the user just sent, as after a bareFsWrite.
    const session = this.sessions.get(String(postId));
    if (session) delete session.buffers[path];
  }

  bareEditorState({
    postId: rawPostId
  }: BoardAgentActionMap['bareEditorState']['payload']): BoardAgentActionMap['bareEditorState']['result'] {
    const postId = String(rawPostId);
    const session = this.sessions.get(postId);
    if (!session || session.mode !== 'bare') {
      return { openedFiles: [], buffers: {} };
    }
    return {
      openedFiles: session.openedFiles.slice(),
      buffers: { ...session.buffers }
    };
  }

  bareOpenFile({
    postId: rawPostId,
    path
  }: BoardAgentActionMap['bareOpenFile']['payload']): void {
    const session = this.sessions.get(String(rawPostId));
    if (!session || session.mode !== 'bare') return;
    if (!session.openedFiles.includes(path)) {
      session.openedFiles.push(path);
    }
  }

  bareCloseFile({
    postId: rawPostId,
    path
  }: BoardAgentActionMap['bareCloseFile']['payload']): void {
    const session = this.sessions.get(String(rawPostId));
    if (!session || session.mode !== 'bare') return;
    session.openedFiles = session.openedFiles.filter((p) => p !== path);
    delete session.buffers[path];
  }

  bareBufferSet({
    postId: rawPostId,
    path,
    content
  }: BoardAgentActionMap['bareBufferSet']['payload']): void {
    const session = this.sessions.get(String(rawPostId));
    if (!session || session.mode !== 'bare') return;
    session.buffers[path] = content;
  }

  async bareFsDelete({
    postId,
    path
  }: BoardAgentActionMap['bareFsDelete']['payload']): Promise<void> {
    const target = this.getBareTarget(postId);
    const root = this.getBareRoot(postId);
    const abs = this.resolveBarePath(path, root);
    if (abs === root) {
      throw new Error('Refusing to delete the repo root.');
    }
    await target.sh(`rm -rf ${shEscape(abs)}`);
  }

  async bareFsMkdir({
    postId,
    path
  }: BoardAgentActionMap['bareFsMkdir']['payload']): Promise<void> {
    const target = this.getBareTarget(postId);
    const abs = this.resolveBarePath(path, this.getBareRoot(postId));
    await target.sh(`mkdir -p ${shEscape(abs)}`);
  }

  async bareReview({
    postId: rawPostId
  }: BoardAgentActionMap['bareReview']['payload']): Promise<
    BoardAgentActionMap['bareReview']['result']
  > {
    const postId = String(rawPostId);
    const session = this.sessions.get(postId);
    if (!session) throw new Error('No active session for this card.');
    if (session.mode !== 'bare') {
      throw new Error('bareReview is only valid in Bare mode.');
    }
    if (session.phase !== 'bare-active' && session.phase !== 'bare-review') {
      throw new Error('Workspace is not ready.');
    }

    // No git worktree: no diff to extract; settle into review with empty changes.
    if (!session.workspacePath) {
      session.diff = '';
      session.changedFiles = [];
      session.commitMessage = '';
      session.phase = 'bare-review';
      this.syncCard(session);
      this.emitter.emitSessionUpdate(session);
      return { diff: '', changedFiles: [], commitMessage: '' };
    }

    this.emitter.addLog(session, 'system', 'Extracting changes...');

    const { diff, changedFiles } = await extractDiff(
      this.core.target(),
      session.workspacePath || undefined
    );
    session.diff = diff;
    session.changedFiles = changedFiles;

    if (changedFiles.length > 0) {
      this.emitter.addLog(
        session,
        'system',
        `${changedFiles.length} file${changedFiles.length !== 1 ? 's' : ''} changed.`
      );
      this.emitter.addLog(session, 'system', 'Generating commit message...');
      try {
        session.commitMessage = await generateCommitMessage(
          session.provider,
          this.core.target(),
          diff,
          session.workspacePath || undefined
        );
      } catch {
        // The agent may not be authed in Bare mode; fall back to a placeholder.
        session.commitMessage = 'WIP: changes from bare session';
      }
    } else {
      session.commitMessage = '';
      this.emitter.addLog(session, 'system', 'No files changed.');
    }

    session.phase = 'bare-review';
    this.syncCard(session);
    this.emitter.emitSessionUpdate(session);

    return {
      diff: session.diff,
      changedFiles: session.changedFiles,
      commitMessage: session.commitMessage
    };
  }

  /** The worktree a card's git panel acts on, or '' when the card has none (a
   *  space with no repository has no tree to diff). Throws for a session that isn't
   *  live, so a stale modal gets an error rather than acting on whatever
   *  happens to sit at the space root. */
  private gitWorkdir(rawPostId: string | number): string {
    const session = this.sessions.get(String(rawPostId));
    if (!session) throw new Error('No active session for this card.');
    if (session.mode !== 'bare') {
      throw new Error('Git actions are only valid in Bare mode.');
    }
    if (session.phase !== 'bare-active' && session.phase !== 'bare-review') {
      throw new Error('Workspace is not ready.');
    }
    return panelGitDir(session);
  }

  /** Whether the git panel may write in `workdir`: only the session's own
   *  worktree, under the space's worktrees folder. The panel can be showing
   *  somewhere else (the folder its agent last worked in, which may be the
   *  workspace or another session's tree), and those it only reads. */
  private gitWriteAccess(
    rawPostId: string | number,
    workdir: string
  ): { writable: boolean; reason: string; ownWorktree: boolean } {
    const own = this.sessions.get(String(rawPostId))?.workspacePath || '';
    const ownWorktree =
      !!own &&
      isWorktreePath(this.core.target(), own) &&
      !own.split('/').includes('..');
    if (ownWorktree && workdir === own) {
      return { writable: true, reason: '', ownWorktree };
    }
    // Shown as the panel's read-only banner, so each says what to do instead.
    return {
      writable: false,
      ownWorktree,
      reason: ownWorktree
        ? 'Read-only: this panel is showing a folder other than this session’s worktree. Commit, switch branches and push from the worktree itself.'
        : 'Read-only: this chat works in the board’s shared checkout. Start a Code session to commit, switch branches and push.'
    };
  }

  /** The repository policy the panel's writes follow: the space's default
   *  branch, which no commit or push from the panel lands on. */
  private gitPolicy(): GitPanelPolicy {
    return { defaultBranch: this.core.readConfig().mainBranch || 'main' };
  }

  /** The panel's read plus what it may write, for every answer it gets. */
  private async gitPanelAnswer(
    rawPostId: string | number,
    workdir: string
  ): Promise<BoardAgentActionMap['bareGitStatus']['result']> {
    const target = this.core.target();
    const state = await readGitPanel(target, workdir);
    const panel = await readPanelInfo(
      target,
      workdir,
      this.gitPolicy(),
      this.gitWriteAccess(rawPostId, workdir)
    ).catch(() => undefined);
    return { ...state, ...(panel ? { panel } : {}) };
  }

  async bareGitStatus({
    postId
  }: BoardAgentActionMap['bareGitStatus']['payload']): Promise<
    BoardAgentActionMap['bareGitStatus']['result']
  > {
    const workdir = this.gitWorkdir(postId);
    if (!workdir) return { diff: '', changedFiles: [] };
    return await this.gitPanelAnswer(postId, workdir);
  }

  async bareGitFileDiff({
    postId,
    path
  }: BoardAgentActionMap['bareGitFileDiff']['payload']): Promise<
    BoardAgentActionMap['bareGitFileDiff']['result']
  > {
    const workdir = this.gitWorkdir(postId);
    if (!workdir) return { staged: '', unstaged: '', writable: false };
    return {
      ...(await readFileDiffs(this.core.target(), workdir, path)),
      writable: this.gitWriteAccess(postId, workdir).writable
    };
  }

  /** Every write the git panel makes (git-panel-write.ts). Refused outside
   *  the session's own worktree; the op itself refuses the default branch. */
  async bareGitAct({
    postId,
    op
  }: BoardAgentActionMap['bareGitAct']['payload']): Promise<
    BoardAgentActionMap['bareGitAct']['result']
  > {
    const workdir = this.gitWorkdir(postId);
    if (!workdir) throw new Error('This workspace has no git checkout.');
    const access = this.gitWriteAccess(postId, workdir);
    if (!access.writable) throw new Error(access.reason);
    const result = await runGitPanelOp(
      this.core.target(),
      workdir,
      this.gitPolicy(),
      op
    ).catch((err: unknown) => {
      // Without the board's GitHub connection there is no token to send, and
      // git's own "could not read Username" says nothing about the fix. A
      // public origin still fetches, so only a failure is reworded.
      if (REMOTE_OPS.has(op.kind) && !this.core.readConfig().githubToken) {
        throw new Error(NO_GITHUB_REMOTE);
      }
      throw err;
    });
    return {
      status: await this.gitPanelAnswer(postId, workdir),
      ...result
    };
  }

  /** Both staging calls answer with the panel's next state: the index is
   *  inside .git, which the working-tree watcher prunes, so nothing else would
   *  tell the panel its rows just moved. */
  async bareGitStage({
    postId: rawPostId,
    paths
  }: BoardAgentActionMap['bareGitStage']['payload']): Promise<
    BoardAgentActionMap['bareGitStage']['result']
  > {
    const workdir = this.gitWorkdir(rawPostId);
    if (!workdir) return { diff: '', changedFiles: [] };
    const access = this.gitWriteAccess(rawPostId, workdir);
    if (!access.writable) throw new Error(access.reason);
    await stagePaths(this.core.target(), workdir, paths);
    return await this.gitPanelAnswer(rawPostId, workdir);
  }

  async bareGitUnstage({
    postId: rawPostId,
    paths
  }: BoardAgentActionMap['bareGitUnstage']['payload']): Promise<
    BoardAgentActionMap['bareGitUnstage']['result']
  > {
    const workdir = this.gitWorkdir(rawPostId);
    if (!workdir) return { diff: '', changedFiles: [] };
    const access = this.gitWriteAccess(rawPostId, workdir);
    if (!access.writable) throw new Error(access.reason);
    await unstagePaths(this.core.target(), workdir, paths);
    return await this.gitPanelAnswer(rawPostId, workdir);
  }

  async bareGitCommitDiff({
    postId,
    sha
  }: BoardAgentActionMap['bareGitCommitDiff']['payload']): Promise<
    BoardAgentActionMap['bareGitCommitDiff']['result']
  > {
    const workdir = this.gitWorkdir(postId);
    if (!workdir) return { diff: '', changedFiles: [] };
    return await readCommitDiff(this.core.target(), workdir, sha);
  }

  async bareGitCompare({
    postId,
    base,
    head
  }: BoardAgentActionMap['bareGitCompare']['payload']): Promise<
    BoardAgentActionMap['bareGitCompare']['result']
  > {
    const workdir = this.gitWorkdir(postId);
    if (!workdir) {
      return {
        base: '',
        branches: [],
        files: [],
        diff: '',
        ahead: 0,
        behind: 0
      };
    }
    // The branch the session was cut from first: "what did this terminal
    // change" is the question the panel is being asked.
    const cut = this.sessions.get(String(postId))?.targetBranch;
    const preferred = [
      ...(cut ? [`origin/${cut}`, cut] : []),
      'origin/main',
      'origin/master',
      'main',
      'master'
    ];
    return await readBranchCompare(
      this.core.target(),
      workdir,
      base,
      preferred,
      head
    );
  }

  async bareGitBlob({
    postId,
    ref,
    path
  }: BoardAgentActionMap['bareGitBlob']['payload']): Promise<
    BoardAgentActionMap['bareGitBlob']['result']
  > {
    const workdir = this.gitWorkdir(postId);
    if (!workdir) throw new Error('This workspace has no git checkout.');
    return await readGitBlob(this.core.target(), workdir, ref, path);
  }

  /** `targetOverride` carries the cross-mode lookup, so tabs resolve for cards
   *  this engine doesn't own - the crashed claude sessions users most need. */
  async bareListTerminals(
    { postId: rawPostId }: BoardAgentActionMap['bareListTerminals']['payload'],
    targetOverride?: ExecTarget
  ): Promise<BoardAgentActionMap['bareListTerminals']['result']> {
    const postId = String(rawPostId);
    const session = this.sessions.get(postId);
    // A workspace that isn't up yet fails the exec below and falls through to
    // the empty-list catch.
    const target = session ? this.core.target() : targetOverride;
    if (!target) return [];
    // Mirrors tmuxName(): terminalKey is `${postId}-${tabId}`, so the session
    // prefix is `terminal-<sanitized(postId)>-`.
    const sanitizedPostId = postId.replace(/[^a-zA-Z0-9._-]/g, '_');
    const prefix = `terminal-${sanitizedPostId}-`;
    try {
      // list-panes -a reads every session in one shot, this card's included.
      const stdout = await target.sh(
        `${tmuxCli(target)} list-panes -a -F '${TAB_LIST_FORMAT}' 2>/dev/null || true`
      );
      const rows = parseTerminalTabs(stdout, prefix);
      // No staleness, so no digest read on the strip's 4s poll.
      // `bareTerminalHealth` answers that for a whole board in one call.
      return rows.map(({ id, name, dead }) => ({ id, name, dead }));
    } catch {
      return [];
    }
  }

  /** Terminal tabs across several posts in one sweep, so the sessions view can
   *  ask about a whole board without a round trip per card. */
  private async staleTabsFor(
    target: ExecTarget,
    postIds: string[],
    // Passed in, not recomputed: callers have just worked it out and the
    // plugin read behind it is the one part that is not free.
    current: string
  ): Promise<{ postId: string; tabId: string }[]> {
    if (!current) return [];
    const stdout = await target
      .sh(
        `${tmuxCli(target)} list-panes -a -F '${TAB_LIST_FORMAT}' 2>/dev/null || true`
      )
      .catch(() => '');
    const stale: { postId: string; tabId: string }[] = [];
    for (const postId of postIds) {
      const prefix = `terminal-${postId.replace(/[^a-zA-Z0-9._-]/g, '_')}-`;
      for (const row of parseTerminalTabs(stdout, prefix)) {
        if (row.fp !== current) stale.push({ postId, tabId: row.id });
      }
    }
    return stale;
  }

  async bareTerminalHealth({
    postIds
  }: BoardAgentActionMap['bareTerminalHealth']['payload']): Promise<
    BoardAgentActionMap['bareTerminalHealth']['result']
  > {
    const target = this.core.target();
    const digest = await terminalDigest(target).catch(() => '');
    const acked = await getTerminalAck(target);
    return {
      digest,
      acked: !!digest && acked === digest,
      staleTabs: await this.staleTabsFor(target, postIds, digest)
    };
  }

  async bareAckTerminalDigest(): Promise<void> {
    const target = this.core.target();
    const digest = await terminalDigest(target).catch(() => '');
    if (!digest) return;
    await setTerminalAck(target, digest);
  }

  async bareRestartStaleTerminals({
    postIds
  }: BoardAgentActionMap['bareRestartStaleTerminals']['payload']): Promise<
    BoardAgentActionMap['bareRestartStaleTerminals']['result']
  > {
    const target = this.core.target();
    const digest = await terminalDigest(target).catch(() => '');
    const stale = await this.staleTabsFor(target, postIds, digest);
    for (const { postId, tabId } of stale) {
      // A card with no live session has no worktree, so the space workspace
      // stands in — the same fallback `open` uses.
      let cwd = target.paths.workspace;
      try {
        cwd = this.gitWorkdir(postId) || cwd;
      } catch {
        // Not a live bare session; the fallback is right.
      }
      await restartTerminalSession({
        target,
        postId,
        terminalKey: `${postId}-${tabId}`,
        cwd
      });
    }
    return { restarted: stale.length };
  }

  /** This card's panes: the pid its tree hangs off, and the pane id its
   *  processes carry in their environment. */
  private async panePids(
    target: ExecTarget,
    postId: string
  ): Promise<PaneRef[]> {
    const prefix = `terminal-${postId.replace(/[^a-zA-Z0-9._-]/g, '_')}-`;
    const stdout = await target
      .sh(
        `${tmuxCli(target)} list-panes -a -F '#{session_name}|#{pane_pid}|#{pane_id}' 2>/dev/null || true`
      )
      .catch(() => '');
    const panes: PaneRef[] = [];
    for (const raw of stdout.split('\n')) {
      const line = raw.trim();
      if (!line.startsWith(prefix)) continue;
      const [tabId, rawPid, paneId] = line.slice(prefix.length).split('|');
      const pid = Number(rawPid);
      if (!tabId || !paneId || !Number.isInteger(pid) || pid <= 0) continue;
      panes.push({ tabId, pid, paneId });
    }
    return panes;
  }

  /**
   * Every process this card is running, by pid. Shared with bareKillProcess,
   * so stopping a process accepts exactly the set the panel shows.
   *
   * The `-p <pids>` on the environment call is required, not a saving: macOS
   * omits environments from an unscoped `ps -axeww` — see panesByPid.
   */
  private async cardProcesses(
    target: ExecTarget,
    postId: string
  ): Promise<Map<number, { tabId: string; row: ProcRow }>> {
    const panes = await this.panePids(target, postId);
    if (panes.length === 0) return new Map();

    // One snapshot for every tab: parentage is a property of the whole table,
    // and a second `ps` could disagree with the first mid-walk.
    const table = parsePsTable(
      await target.run(['ps', '-axo', PS_FORMAT]).catch(() => '')
    );

    return processesForCard(panes, table, async (pids) =>
      panesByPid(
        await target
          .run(['ps', 'eww', '-o', 'pid=,command=', '-p', pids.join(',')])
          .catch(() => '')
      )
    );
  }

  async bareListProcesses({
    postId: rawPostId
  }: BoardAgentActionMap['bareListProcesses']['payload']): Promise<
    BoardAgentActionMap['bareListProcesses']['result']
  > {
    const postId = String(rawPostId);
    const target = this.getBareTarget(postId);
    const mine = await this.cardProcesses(target, postId);
    if (mine.size === 0) return [];

    const found: BoardAgentActionMap['bareListProcesses']['result'] =
      Array.from(mine.values(), ({ tabId, row }) => ({
        pid: row.pid,
        tabId,
        command: commandOf(row.args),
        args: row.args,
        cpu: row.cpu,
        memoryKb: row.rssKb,
        elapsed: row.elapsed,
        ports: [],
        connections: 0
      }));

    const sockets = await socketsFor(
      target,
      found.map((p) => p.pid)
    );
    for (const proc of found) {
      const use = sockets.get(proc.pid);
      proc.ports = use?.ports ?? [];
      proc.connections = use?.connections ?? 0;
    }

    return found.sort(
      (a, b) => (Number(a.tabId) || 0) - (Number(b.tabId) || 0) || a.pid - b.pid
    );
  }

  async bareKillProcess({
    postId: rawPostId,
    pid
  }: BoardAgentActionMap['bareKillProcess']['payload']): Promise<void> {
    const postId = String(rawPostId);
    const target = this.getBareTarget(postId);
    if (!Number.isInteger(pid) || pid <= 1) {
      throw new Error('Not a process this card can stop.');
    }
    // Re-derive rather than trusting the pid the panel sent: a stale panel
    // could name a pid that has since been recycled by something else
    // entirely, and this is the one call here that is not a read.
    const mine = await this.cardProcesses(target, postId);
    if (!mine.has(pid)) {
      throw new Error('That process is not running in this card.');
    }
    // TERM, not KILL: a dev server has cleanup to do, and anything that
    // ignores TERM is better killed from the terminal where the user can see
    // what it printed.
    await target.run(['kill', '-TERM', String(pid)]);
  }

  // ── port forwarding (factiii-expose / factiii-unexpose) ──

  async bareExpose({
    postId,
    port,
    name
  }: BoardAgentActionMap['bareExpose']['payload']): Promise<
    BoardAgentActionMap['bareExpose']['result']
  > {
    const target = this.getBareTarget(postId);
    const safeName = name.trim();
    if (!/^[a-zA-Z0-9-]+$/.test(safeName)) {
      throw new Error('Name must be letters, numbers, or dashes.');
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('Port must be between 1 and 65535.');
    }
    // factiii-expose echoes the public URL on success; "command not found"
    // (no frp harness installed) leaves no http line, so we surface that.
    // Not run in a pane, so the script cannot tell whose it is: name a session
    // of this card's, which is all the owner record is resolved to anyway.
    const owner = shEscape(tmuxName(`${postId}-ports`));
    const out = (
      await target.sh(
        `FACTIII_EXPOSE_OWNER=${owner} factiii-expose ${port} ${shEscape(safeName)} 2>&1`
      )
    ).trim();
    const url = out.split('\n').filter(Boolean).pop() || '';
    if (!/^https?:\/\//.test(url)) {
      throw new Error(out || 'Failed to expose port.');
    }
    void this.refreshTunnels();
    return { name: safeName, port, url };
  }

  async bareUnexpose({
    postId,
    name
  }: BoardAgentActionMap['bareUnexpose']['payload']): Promise<void> {
    const target = this.getBareTarget(postId);
    const safeName = name.trim();
    if (!/^[a-zA-Z0-9-]+$/.test(safeName)) {
      throw new Error('Invalid tunnel name.');
    }
    await target.sh(`factiii-unexpose ${shEscape(safeName)} 2>&1 || true`);
    void this.refreshTunnels();
  }

  /** Derived, never remembered: `factiii-expose` is on the agent's PATH, so the
   *  terminal and the agent both open tunnels without telling us, and a runner
   *  restart would forget any list we kept. */
  async bareListExposed({
    postId
  }: BoardAgentActionMap['bareListExposed']['payload']): Promise<
    BoardAgentActionMap['bareListExposed']['result']
  > {
    const session = this.sessions.get(String(postId));
    if (!session || session.mode !== 'bare') return [];
    const tunnels = await listLiveTunnels(this.core.target());
    return tunnels.map(({ name, port, url }) => ({ name, port, url }));
  }
}
