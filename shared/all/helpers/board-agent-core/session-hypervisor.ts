// The board MCP's hypervisor tools: list_sessions, start_session,
// message_session, read_session and end_session, which let one agent see,
// start, talk to and end the other sessions (Chat and Code) on the boards its
// person can use (.specs/card-sessions.md, "Session tools (answered by the
// runner)"). Answered by the runner, like link_card (session-card-tools.ts):
// the runner holds the sessions. This file holds the rules; the runner lends it each board
// (HypervisorBoard, the engine's) and who may do what (HypervisorHost, the
// daemon's).
//
// The rules:
// - An agent acts for the person its session acts for (SessionStarter), and
//   can never do more than that person could by hand: list needs the Jobs
//   level on a board, everything else the Shell level, as the same
//   actions do over the data channel (runner-access.ts). The level is read at
//   each call, so a level taken away counts for the next one.
// - A session an agent starts acts for the same person, so it cannot climb
//   either.
// - A session may not end itself here (its person's End does that).
// - At most MCP_SESSION_CAP sessions started through start_session run at
//   once on a board.
// - end_session keeps the branch unless deleteBranch is passed, and refuses a
//   worktree with uncommitted work or commits no remote has unless discard is.
// - Every write is a line in the board's audit log, `via: 'mcp'`, naming the
//   person and the calling session.
//
// Local runner only: the boards and sessions here are this runner's. A
// session on another runner is not listed and cannot be reached (no
// cross-runner relay exists for it yet).

import type { AuditEntry } from '../../domains/electron';
import type { ChatEvent } from '../terminal-ai/chatTranscript';
import { isCardPostId } from './boardTerminal';
import type { WorkState } from './git';
import { type ChannelLevel, levelAtLeast } from './runner-access';
import type { SessionStarter } from './session';

/** How many sessions started through start_session may run at once on one
 *  board. A hand-started session does not count. Small on purpose: each is
 *  a CLI, a worktree and its node_modules on the owner's machine, and an
 *  agent in a loop should hit a wall, not fill the disk. */
export const MCP_SESSION_CAP = 5;

/** How many transcript events read_session returns by default, and at most. */
const READ_DEFAULT = 20;
const READ_MAX = 100;
/** The opening message and message_session text, at most. */
const MESSAGE_MAX = 20_000;

/** A session as these tools see it. */
export type HypervisorSession = {
  id: string;
  title: string;
  /** starting, working, idle, needs you (a permission prompt), error. */
  state: 'starting' | 'working' | 'idle' | 'needs you' | 'error';
  /** Code has its own worktree and branch; Chat runs in the board's
   *  workspace. */
  mode: 'Chat' | 'Code';
  cardId: string | null;
  /** The worktree's path, '' for a Chat session. */
  worktree: string;
  /** Absent: started before this was recorded, the owner's. */
  startedBy?: SessionStarter;
  /** The session that started this one through start_session, if any. */
  startedVia?: string;
};

export type StartArgs = {
  title: string;
  code: boolean;
  baseBranch: string;
  cardId: string | null;
  message: string;
  startedBy: SessionStarter;
  /** The calling session's id. */
  startedVia: string;
};

/** One board on this runner, as the engine lends it. */
export interface HypervisorBoard {
  sessions(): HypervisorSession[];
  /** A Code session needs a repository (and the GitHub connection). */
  hasRepo(): boolean;
  /** Start the session; resolve with its id once it exists. The opening
   *  message goes in once its workspace is ready. */
  start(args: StartArgs): Promise<string>;
  /** Into the session's chat (bareChatSend). Throws when it cannot. */
  send(id: string, text: string): void;
  /** The most recent chat events (bareChatTranscript). */
  transcript(id: string): Promise<ChatEvent[]>;
  /** Git state of a Code session's worktree; null for Chat. Throws when git
   *  cannot read it. */
  work(id: string): Promise<WorkState | null>;
  /** Stop it and remove its worktree. Resolves with what could not be
   *  removed, as sentences. */
  end(id: string, opts: { deleteBranch: boolean }): Promise<string[]>;
  audit(entry: {
    actor: { userId: string; name: string };
    action: AuditEntry['action'];
    detail: string;
  }): Promise<void>;
}

/** The runner: its boards and its access levels. */
export interface HypervisorHost {
  /** This runner's name, for `runner` arguments. */
  runner: string;
  /** Who a session with no startedBy acts for: the runner owner. */
  owner(): SessionStarter;
  boards(): string[];
  board(slug: string): HypervisorBoard | null;
  /** What `starter` may do on `slug` by hand, read now. */
  level(starter: SessionStarter, slug: string): ChannelLevel;
}

/** The calling session. `verified`: it proved `session` with its session
 *  token (exec.ts sessionToken). A caller that did not (a session started
 *  before the token) is held to the board's lowest level, `none`: it acts for
 *  nobody, since the session it names is only its own word. */
export type HypervisorCaller = {
  slug: string;
  session: string;
  verified: boolean;
};

type Loose = Record<string, unknown>;
type Answer = { text: string; isError: boolean };

const sessionArg = {
  board: {
    type: 'string',
    description:
      'The board (its slug, as list_sessions shows it). Omit it to look on every board you can use.'
  },
  session: {
    type: 'string',
    description: 'The session id, as list_sessions shows it.'
  }
} as const;

export const HYPERVISOR_TOOLS = [
  {
    name: 'list_sessions',
    description:
      'Every Chat and Code session on the boards you can use on this runner: board, runner, id, title, state (starting, working, idle, needs you, error), mode (Chat or Code), linked card, worktree, and whether an agent started it. Sessions on other runners are not listed.',
    inputSchema: {
      type: 'object',
      properties: {
        board: {
          type: 'string',
          description: 'Only this board (its slug). Omit for every board.'
        }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  {
    name: 'start_session',
    description: `Start a session on a board, with an opening message for its agent. mode "code" gets its own worktree and branch (named after title, which it then needs), on a board with a repository; "chat" runs in the board's workspace. Optionally linked to a card (cardId, a card uuid). It runs on this runner; another runner cannot be picked yet. At most ${MCP_SESSION_CAP} sessions started this way run at once on a board. Returns the new session's id; the opening message goes in once its workspace is ready, and read_session shows the reply.`,
    inputSchema: {
      type: 'object',
      properties: {
        board: {
          type: 'string',
          description: 'The board (its slug). Omit for this session’s board.'
        },
        mode: { type: 'string', enum: ['chat', 'code'] },
        message: {
          type: 'string',
          description: 'The first thing its agent reads: the task.'
        },
        title: {
          type: 'string',
          description:
            'The session’s name. A Code session’s worktree and branch take it, so it must not be in use.'
        },
        cardId: { type: 'string', format: 'uuid' },
        baseBranch: {
          type: 'string',
          description:
            'Code only: the branch to cut from. Omit for the board’s main branch.'
        },
        runner: {
          type: 'string',
          description:
            'The runner to start it on, by name. Only this runner today; omit it.'
        }
      },
      required: ['mode', 'message'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, openWorldHint: false }
  },
  {
    name: 'message_session',
    description:
      "Send text into another session's chat, as its next message (queued behind a turn in progress). read_session shows the reply.",
    inputSchema: {
      type: 'object',
      properties: { ...sessionArg, text: { type: 'string' } },
      required: ['session', 'text'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, openWorldHint: false }
  },
  {
    name: 'read_session',
    description: `A session's recent chat transcript (its last ${READ_DEFAULT} events, or limit, up to ${READ_MAX}) and, for a Code session, its git state: branch, dirty files, commits ahead of and behind its base, and commits no remote has.`,
    inputSchema: {
      type: 'object',
      properties: {
        ...sessionArg,
        limit: { type: 'integer', minimum: 1, maximum: READ_MAX }
      },
      required: ['session'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  {
    name: 'end_session',
    description:
      'End another session: stop its agent and terminals and remove its worktree. Its branch is kept unless deleteBranch is true. Refused while the worktree has uncommitted work or commits no remote has, unless discard is true (which loses them). A session cannot end itself this way.',
    inputSchema: {
      type: 'object',
      properties: {
        ...sessionArg,
        discard: { type: 'boolean' },
        deleteBranch: { type: 'boolean' }
      },
      required: ['session'],
      additionalProperties: false
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false
    }
  }
] as const;

export const HYPERVISOR_TOOL_NAMES: ReadonlySet<string> = new Set(
  HYPERVISOR_TOOLS.map((t) => t.name)
);

const UNKNOWN_CALLER =
  'This session is not one the runner knows. It may have started before the session tools existed: restart its terminal, then try again.';
const UNVERIFIED_CALLER =
  'This session started before the runner proved which session is asking, so it may not use these tools: restart its terminal, then try again.';

const fail = (text: string): Answer => ({ text, isError: true });
const ok = (text: string): Answer => ({ text, isError: false });
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Who the calling session acts for, or null when it is no session here. */
function callerStarter(
  host: HypervisorHost,
  caller: HypervisorCaller
): SessionStarter | null {
  if (!caller.session) return null;
  const own = host
    .board(caller.slug)
    ?.sessions()
    .find((s) => s.id === caller.session);
  if (!own) return null;
  return own.startedBy ?? host.owner();
}

/** The boards `starter` reaches at `needed`, in the runner's order. */
function reachable(
  host: HypervisorHost,
  starter: SessionStarter,
  needed: 'jobs' | 'shell'
): string[] {
  return host
    .boards()
    .filter((slug) => levelAtLeast(host.level(starter, slug), needed));
}

/** Find the session a call names, on a board the person reaches at
 *  Shell. A board they cannot use says the same as a missing session:
 *  what they cannot see is not confirmed to exist. */
function findTarget(
  host: HypervisorHost,
  starter: SessionStarter,
  args: Loose
): { slug: string; board: HypervisorBoard; session: HypervisorSession } | string {
  const id = str(args.session);
  if (!id) return 'session is required: an id from list_sessions.';
  const wanted = str(args.board);
  const boards = reachable(host, starter, 'shell').filter(
    (slug) => !wanted || slug === wanted
  );
  const hits: {
    slug: string;
    board: HypervisorBoard;
    session: HypervisorSession;
  }[] = [];
  for (const slug of boards) {
    const board = host.board(slug);
    const session = board?.sessions().find((s) => s.id === id);
    if (board && session) hits.push({ slug, board, session });
  }
  if (hits.length === 0) {
    return `No session ${id}${wanted ? ` on ${wanted}` : ''} that you can reach on this runner. list_sessions shows the ones you can.`;
  }
  if (hits.length > 1) {
    return `Session ${id} is on more than one board (${hits.map((h) => h.slug).join(', ')}): pass board.`;
  }
  return hits[0]!;
}

const describeCaller = (caller: HypervisorCaller) =>
  `by session ${caller.session} on ${caller.slug}`;

function listSessions(
  host: HypervisorHost,
  starter: SessionStarter,
  args: Loose
): Answer {
  const wanted = str(args.board);
  const boards = reachable(host, starter, 'jobs').filter(
    (slug) => !wanted || slug === wanted
  );
  if (wanted && boards.length === 0) {
    return fail(`You cannot see the sessions on ${wanted} on this runner.`);
  }
  const sessions = boards.flatMap((slug) =>
    (host.board(slug)?.sessions() ?? []).map((s) => ({
      board: slug,
      runner: host.runner,
      id: s.id,
      title: s.title,
      state: s.state,
      mode: s.mode,
      card: s.cardId,
      worktree: s.worktree || null,
      startedByAgent: s.startedVia ? s.startedVia : null
    }))
  );
  return ok(JSON.stringify({ sessions }, null, 2));
}

async function startSession(
  host: HypervisorHost,
  starter: SessionStarter,
  caller: HypervisorCaller,
  args: Loose
): Promise<Answer> {
  const slug = str(args.board) || caller.slug;
  const runner = str(args.runner);
  if (runner && runner !== host.runner) {
    return fail(
      `Sessions can only be started on this runner (${host.runner}) for now: starting one on ${runner} is not supported yet.`
    );
  }
  if (!levelAtLeast(host.level(starter, slug), 'shell')) {
    return fail(
      `You cannot start sessions on ${slug} on this runner: that takes the Shell level there.`
    );
  }
  const board = host.board(slug);
  if (!board) return fail(`This runner does not serve the board ${slug}.`);
  const mode = str(args.mode);
  if (mode !== 'chat' && mode !== 'code') {
    return fail('mode must be "chat" or "code".');
  }
  const code = mode === 'code';
  const message = str(args.message);
  if (!message) return fail('message is required: the task for its agent.');
  if (message.length > MESSAGE_MAX) {
    return fail(`message is too long (at most ${MESSAGE_MAX} characters).`);
  }
  const title = str(args.title);
  if (code && !title) {
    return fail(
      'A Code session needs a title: its worktree and branch take that name.'
    );
  }
  if (code && !board.hasRepo()) {
    return fail(
      `${slug} has no repository connected, so it cannot have a Code session. Start a chat instead.`
    );
  }
  const cardId = str(args.cardId);
  if (cardId && !isCardPostId(cardId)) {
    return fail('cardId must be a card uuid.');
  }
  const started = board.sessions().filter((s) => s.startedVia).length;
  if (started >= MCP_SESSION_CAP) {
    return fail(
      `${slug} already has ${started} sessions started by agents (the limit is ${MCP_SESSION_CAP}). End one with end_session first.`
    );
  }
  let id: string;
  try {
    id = await board.start({
      title: title || 'Chat',
      code,
      baseBranch: str(args.baseBranch),
      cardId: cardId || null,
      message,
      startedBy: starter,
      startedVia: caller.session
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  await board.audit({
    actor: starter,
    action: 'session-start',
    detail: `${code ? 'Code' : 'Chat'} session ${id} "${title || 'Chat'}"${cardId ? ` on card ${cardId}` : ''}, ${describeCaller(caller)}`
  });
  return ok(
    `Started ${code ? 'Code' : 'Chat'} session ${id} on ${slug} (${host.runner}). The opening message goes in once its workspace is ready; read_session shows the reply.`
  );
}

async function messageSession(
  host: HypervisorHost,
  starter: SessionStarter,
  caller: HypervisorCaller,
  args: Loose
): Promise<Answer> {
  const found = findTarget(host, starter, args);
  if (typeof found === 'string') return fail(found);
  if (found.slug === caller.slug && found.session.id === caller.session) {
    return fail('That is this session: reply here instead.');
  }
  const text = str(args.text);
  if (!text) return fail('text is required.');
  if (text.length > MESSAGE_MAX) {
    return fail(`text is too long (at most ${MESSAGE_MAX} characters).`);
  }
  try {
    found.board.send(found.session.id, text);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  await found.board.audit({
    actor: starter,
    action: 'session-message',
    detail: `to session ${found.session.id} "${found.session.title}", ${describeCaller(caller)}`
  });
  return ok(`Sent to ${found.session.id} on ${found.slug}.`);
}

/** One transcript event as a line an agent reads. */
function eventLine(e: ChatEvent): string {
  switch (e.type) {
    case 'user':
      return `[user] ${e.text}`;
    case 'assistant':
      return `[assistant] ${e.text}`;
    case 'tool':
      return `[tool ${e.name}] ${e.summary}`;
    default:
      return `[${e.isError ? 'tool error' : 'tool result'}] ${e.preview}`;
  }
}

async function readSession(
  host: HypervisorHost,
  starter: SessionStarter,
  args: Loose
): Promise<Answer> {
  const found = findTarget(host, starter, args);
  if (typeof found === 'string') return fail(found);
  const limit = Math.min(
    READ_MAX,
    Math.max(1, Math.floor(Number(args.limit) || READ_DEFAULT))
  );
  const [events, work] = await Promise.all([
    found.board.transcript(found.session.id).catch(() => [] as ChatEvent[]),
    found.board
      .work(found.session.id)
      .catch((err: unknown) =>
        err instanceof Error ? err.message : String(err)
      )
  ]);
  const { session } = found;
  return ok(
    JSON.stringify(
      {
        board: found.slug,
        id: session.id,
        title: session.title,
        state: session.state,
        mode: session.mode,
        card: session.cardId,
        worktree: session.worktree || null,
        git:
          typeof work === 'string'
            ? { error: `git could not read the worktree: ${work}` }
            : work && {
                branch: work.branch,
                dirtyFiles: work.dirtyFiles,
                ahead: work.ahead,
                behind: work.behind,
                unpushed: work.unpushed
              },
        transcript: events.slice(-limit).map(eventLine)
      },
      null,
      2
    )
  );
}

async function endSession(
  host: HypervisorHost,
  starter: SessionStarter,
  caller: HypervisorCaller,
  args: Loose
): Promise<Answer> {
  const found = findTarget(host, starter, args);
  if (typeof found === 'string') return fail(found);
  const { board, session } = found;
  if (found.slug === caller.slug && session.id === caller.session) {
    return fail(
      'A session cannot end itself through end_session. Its person ends it with End.'
    );
  }
  // A Code session gets its worktree while it starts: ended now, the tree
  // would land after the teardown with nothing to remove it.
  if (session.state === 'starting') {
    return fail(
      `${session.id} is still starting. Try again once list_sessions shows it started.`
    );
  }
  const discard = args.discard === true;
  const deleteBranch = args.deleteBranch === true;
  if (!discard && session.mode === 'Code') {
    let work: WorkState | null;
    try {
      work = await board.work(session.id);
    } catch (err) {
      // Any doubt reads as work, as the startup sweep reads it.
      return fail(
        `Not ended: git could not read ${session.worktree} (${err instanceof Error ? err.message : String(err)}), so it may hold work. Pass discard: true to end it anyway.`
      );
    }
    const reasons: string[] = [];
    if (work && work.dirtyFiles.length > 0) {
      reasons.push(
        `${work.dirtyFiles.length} uncommitted file${work.dirtyFiles.length === 1 ? '' : 's'} (${work.dirtyFiles.slice(0, 10).join(', ')}${work.dirtyFiles.length > 10 ? ', …' : ''})`
      );
    }
    if (work && work.unpushed > 0) {
      reasons.push(
        `${work.unpushed} commit${work.unpushed === 1 ? '' : 's'} no remote has`
      );
    }
    if (reasons.length > 0) {
      return fail(
        `Not ended: its worktree has ${reasons.join(' and ')}. Commit and push them first (message_session can ask it to), or pass discard: true to lose them.`
      );
    }
  }
  let left: string[];
  try {
    left = await board.end(session.id, { deleteBranch });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  await board.audit({
    actor: starter,
    action: 'session-end',
    detail: `session ${session.id} "${session.title}"${discard ? ', discarding its work' : ''}${deleteBranch ? ', branch deleted' : ', branch kept'}, ${describeCaller(caller)}`
  });
  const kept =
    session.mode === 'Code' && !deleteBranch ? ' Its branch was kept.' : '';
  return ok(
    left.length
      ? `Ended ${session.id}, but ${left.join(', and ')}.${kept}`
      : `Ended ${session.id} on ${found.slug}.${kept}`
  );
}

/** What a hypervisor call answers. */
export async function callHypervisorTool(
  host: HypervisorHost,
  caller: HypervisorCaller,
  name: string,
  args: Loose
): Promise<Answer> {
  // Unproven: the lowest level, none, so no tool here answers it.
  if (!caller.verified) return fail(UNVERIFIED_CALLER);
  const starter = callerStarter(host, caller);
  if (!starter) return fail(UNKNOWN_CALLER);
  switch (name) {
    case 'list_sessions':
      return listSessions(host, starter, args);
    case 'start_session':
      return startSession(host, starter, caller, args);
    case 'message_session':
      return messageSession(host, starter, caller, args);
    case 'read_session':
      return readSession(host, starter, args);
    case 'end_session':
      return endSession(host, starter, caller, args);
    default:
      return fail(`Unknown tool ${name}.`);
  }
}
