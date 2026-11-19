// The board MCP's hypervisor tools: list_runners, list_sessions,
// start_session, message_session, read_session and end_session, which let
// one agent see, start, talk to and end the other sessions (Chat and Code) on
// the boards its person can use (.specs/card-sessions.md, "Session tools
// (answered by the runner)" and "Across runners"). Answered by the runner,
// like link_card (session-card-tools.ts): the runner holds the sessions. This
// file holds the rules; the runner lends it each board (HypervisorBoard, the
// engine's), who may do what (HypervisorHost, the daemon's) and, for the
// other runners and the desktop app, the server's relay (HypervisorRemote).
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
// - A message lands in the target's inbox (session-inbox.ts) and never cuts a
//   turn short. At most SESSION_MESSAGE_MAX characters, at most
//   MESSAGES_PER_MINUTE a minute from one session, and never one that holds a
//   secret (secretScan.ts).
// - Every write is a line in the board's audit log, `via: 'mcp'`, naming the
//   person and the calling session.
//
// Other runners (and the desktop app's local agent) are reached through the
// server (HypervisorRemote): it checks the person may use both sides, carries
// the call, and holds a message for an offline target. On the target the
// call is answered by answerSessionOp below, under the target's own levels;
// a start there needs its owner's "Allow sessions to be started from other
// runners", and the session runs with the target runner's own permissions.
// end_session reaches this runner's sessions only.
//
// read_session and message_session can bring files back from the target
// session to the caller's $DROPS_DIR (`files`), here or over the relay, under
// the same access as the read; the transfer's rules are session-files.ts's.
// Each file is a line in both boards' audit logs.

import type { AuditEntry } from '../../domains/electron';
import {
  messageHoldText,
  parseMessageHold,
  type RelayMessageHold,
  type RelayMessageState,
  type RelayMessageStatus,
  type RelayOrigin,
  type RelayRead,
  type RelayRunner,
  type RelaySessionRow,
  type RunnerOffers,
  SESSION_FILES_MAX_BYTES,
  SESSION_FILES_PER_CALL,
  SESSION_MESSAGE_HOLD_DAYS,
  SESSION_MESSAGE_MAX,
  SESSION_READ_WAIT_MAX_S,
  type SessionFileInfo,
  type SessionFileResult,
  type SessionOpAck
} from '../../domains/sessionRelay';
import type { SessionOp } from '../../validators/sessionRelay';
import { findSecret } from '../secretScan';
import type { ChatEvent } from '../terminal-ai/chatTranscript';
import { isCardPostId } from './boardTerminal';
import type { WorkState } from './git';
import { type ChannelLevel, levelAtLeast } from './runner-access';
import type { SessionStarter } from './session';
import {
  describeSourceFileStamped,
  fetchFiles,
  filesArg,
  type FileSource,
  type FileSourceRules,
  localFileSource,
  readSourceChunk,
  type SourceFileStamp
} from './session-files';

/** How many sessions started through start_session may run at once on one
 *  board. A hand-started session does not count. Small on purpose: each is
 *  a CLI, a worktree and its node_modules on the owner's machine, and an
 *  agent in a loop should hit a wall, not fill the disk. */
export const MCP_SESSION_CAP = 5;

/** How many messages one session may send a minute, here and across
 *  runners (the server counts the relayed ones again, aiRateLimit.ts). */
export const MESSAGES_PER_MINUTE = 30;
const MINUTE_MS = 60_000;

/** message_session's `expiresIn`, in minutes: at most the inbox's own hold. */
const EXPIRES_IN_MAX_MIN = SESSION_MESSAGE_HOLD_DAYS * 24 * 60;

/** How many transcript events read_session returns by default, and at most. */
const READ_DEFAULT = 20;
const READ_MAX = 100;
/** How often read_session's `wait` looks again: here, and over the relay. */
const WAIT_POLL_MS = 5_000;
const WAIT_POLL_REMOTE_MS = 10_000;
/** The longest summary read_session's `wait` returns: the end of it. */
const SUMMARY_MAX = 20_000;

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
  /** The runner whose session started this one, across the relay. */
  startedByRunner?: string;
};

export type StartArgs = {
  title: string;
  code: boolean;
  baseBranch: string;
  cardId: string | null;
  message: string;
  startedBy: SessionStarter;
  /** The calling session's id (`<runner>/<session>` from another runner). */
  startedVia: string;
  /** Started from another runner: its name. */
  startedByRunner?: string;
};

/** One board on this runner, as the engine lends it. */
export interface HypervisorBoard {
  sessions(): HypervisorSession[];
  /** A Code session needs a repository (and the GitHub connection). */
  hasRepo(): boolean;
  /** Start the session; resolve with its id once it exists. The opening
   *  message goes in once its workspace is ready. */
  start(args: StartArgs): Promise<string>;
  /** Into the session's inbox (session-inbox.ts): in its chat now when that
   *  cuts no turn short, else once its turn ends. Resolves with where it
   *  stands after the first try. Throws when the inbox is full. */
  message(
    id: string,
    text: string,
    opts?: {
      /** The sender's id for it (a relayed message keeps the server's). */
      id?: string;
      /** How long it may wait before it is expired, when the sender set one. */
      holdMs?: number;
      /** The sending session here (`<board>/<session>`): who may cancel it. */
      from?: string;
    }
  ): Promise<{ id: string; state: RelayMessageState; hold?: RelayMessageHold }>;
  /** Take back a message `from` sent that still waits in an inbox here.
   *  False when it is not waiting any more, or not that sender's. */
  cancel?(messageId: string, from: string): Promise<boolean>;
  /** Messages still waiting in the session's inbox. */
  waiting(id: string): number;
  /** Why the oldest of them waits. */
  hold?(id: string): RelayMessageHold | undefined;
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
  /** The folders a session's files may be sent from, its workspace first
   *  (session-files.ts). Absent: this board sends no files. */
  fileRoots?(id: string): string[];
  /** Where files brought back to a session here land: the board's
   *  $DROPS_DIR. Absent: this board takes no files. */
  dropsDir?(): string;
}

/** The other runners and the desktop app, through the server's relay
 *  (`runner:session-relay`). Each call throws the server's or the target's
 *  refusal as its message. */
export interface HypervisorRemote {
  runners(origin: RelayOrigin): Promise<RelayRunner[]>;
  sessions(
    origin: RelayOrigin,
    board?: string
  ): Promise<{ sessions: RelaySessionRow[]; unreachable?: string[] }>;
  read(
    origin: RelayOrigin,
    target: { runner: string; board: string; session: string; limit: number }
  ): Promise<{ read: RelayRead; messages: RelayMessageStatus[] }>;
  message(
    origin: RelayOrigin,
    target: { runner: string; board: string; session: string; text: string }
  ): Promise<{
    messageId: string;
    state: RelayMessageState;
    hold?: RelayMessageHold;
  }>;
  start(
    origin: RelayOrigin,
    target: { runner: string; board: string; start: RemoteStart }
  ): Promise<{ sessionId: string }>;
  /** A file on a session there: its description (`part: 'info'`), then each
   *  chunk by index (base64). Absent: an older relay, no files. */
  file?(
    origin: RelayOrigin,
    target: {
      runner: string;
      board: string;
      session: string;
      path: string;
      part: 'info' | number;
    }
  ): Promise<{ file: SessionFileInfo } | { chunk: string }>;
}

/** start_session's arguments as they cross the relay. */
export type RemoteStart = {
  mode: 'chat' | 'code';
  message: string;
  title?: string;
  cardId?: string;
  baseBranch?: string;
};

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
  /** What this runner offers, for list_runners. */
  offers?(): RunnerOffers;
  /** "Allow sessions to be started from other runners" (Runner > Activity),
   *  read now. Absent: off. */
  allowRemoteStarts?(): boolean;
  /** The server's relay to the other runners. Absent (the desktop app, or a
   *  test): this runner only. */
  remote?: HypervisorRemote | null;
  /** Files between sessions (session-files.ts): the most one call brings,
   *  and the folders nothing is ever sent from (the Vault's). Absent: no
   *  files, either way. */
  files?: {
    maxBytes: number;
    forbidden: string[];
    isVaultFile?(realPath: string): boolean;
  };
  /** For read_session's `wait`; real timers when absent. */
  sleep?(ms: number): Promise<void>;
  now?(): number;
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

const filesProp = {
  files: {
    type: 'array',
    items: { type: 'string' },
    maxItems: SESSION_FILES_PER_CALL,
    description: `Files on that session to bring back to your $DROPS_DIR (paths relative to its workspace, or inside its board's drops, scratchpad or builds). At most ${SESSION_FILES_PER_CALL}, ${SESSION_FILES_MAX_BYTES / (1024 * 1024)} MB in all by default. Never from the Vault, never an env file or a text file holding a secret. The answer's files lists where each landed (a new name, never over a file there) or why not.`
  }
} as const;

const sessionArg = {
  board: {
    type: 'string',
    description:
      'The board (its slug, as list_sessions shows it). Omit it to look on every board you can use.'
  },
  session: {
    type: 'string',
    description: 'The session id, as list_sessions shows it.'
  },
  runner: {
    type: 'string',
    description:
      'Where the session runs, as list_sessions shows it (`runner`: an id like r12 or desktop:5, or a runner name). Omit it for this runner; a session not here is looked for on the others.'
  }
} as const;

export const HYPERVISOR_TOOLS = [
  {
    name: 'list_runners',
    description:
      'The runners on your boards that are online now, and the desktop app on your computer: this runner first, then each other one you can reach, with the boards you reach there and what it offers (os, Tart VMs, the iOS simulator, a GPU), and whether its owner lets sessions be started there from other runners. Its `id` is what the other tools take as `runner`.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  {
    name: 'list_sessions',
    description:
      'Every Chat and Code session on the boards you can use, on this runner and on the other runners and desktop app you can reach: board, runner (where it runs) and runnerName, id, title, state (starting, working, idle, needs you, error), mode (Chat or Code), linked card, and, on this runner, worktree and whether an agent started it.',
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
    description: `Start a session on a board, with an opening message for its agent. mode "code" gets its own worktree and branch (named after title, which it then needs), on a board with a repository; "chat" runs in the board's workspace. Optionally linked to a card (cardId, a card uuid). runner picks another runner (an id from list_runners), whose owner must allow sessions started from other runners; it runs there with that runner's own permissions. At most ${MCP_SESSION_CAP} sessions started this way run at once on a board. Returns the new session's id; the opening message goes in once its workspace is ready, and read_session (with wait) shows the reply.`,
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
            'The runner to start it on: an id from list_runners (or a unique name). Omit for this runner.'
        }
      },
      required: ['mode', 'message'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, openWorldHint: false }
  },
  {
    name: 'message_session',
    description: `Send text to another session, on this runner or another. It lands in that session's inbox and goes in as its next message once any turn in progress has ended: it never interrupts one. A session on an offline runner gets it when that runner is back (held ${SESSION_MESSAGE_HOLD_DAYS} days, then expired). At most ${SESSION_MESSAGE_MAX} characters and ${MESSAGES_PER_MINUTE} a minute; never a secret. Returns the message's state: delivered, or waiting with the reason (on a turn, its terminal not open yet, or a CLI that has not reported what it is doing). expiresIn (minutes) drops a message still waiting after that long, so it cannot go in after the work is done another way; cancel_message takes a waiting one back. Both are for a session on this runner only. read_session shows the reply. files brings files from that session to your $DROPS_DIR as the message is sent; for files it makes in answer, use read_session with wait and files.`,
    inputSchema: {
      type: 'object',
      properties: {
        ...sessionArg,
        text: { type: 'string' },
        expiresIn: {
          type: 'integer',
          minimum: 1,
          maximum: EXPIRES_IN_MAX_MIN,
          description:
            'Minutes the message may wait in the inbox before it is dropped (expired). A session on this runner only.'
        },
        ...filesProp
      },
      required: ['session', 'text'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, openWorldHint: false }
  },
  {
    name: 'cancel_message',
    description:
      "Take back a message you sent with message_session that is still waiting in a session's inbox on this runner, so it is never delivered. message is the id message_session returned. Only the session that sent it can; one already delivered, expired or held for another runner cannot be taken back.",
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The message id, as message_session returned it.'
        }
      },
      required: ['message'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, openWorldHint: false }
  },
  {
    name: 'read_session',
    description: `A session's recent chat transcript (its last ${READ_DEFAULT} events, or limit, up to ${READ_MAX}), on this runner or another, and, for a Code session, its git state: branch, dirty files, commits ahead of and behind its base, and commits no remote has. wait (seconds, up to ${SESSION_READ_WAIT_MAX_S}) waits for it to finish its turn and adds its final answer as summary. files brings files from it to your $DROPS_DIR (after the wait, if any).`,
    inputSchema: {
      type: 'object',
      properties: {
        ...sessionArg,
        limit: { type: 'integer', minimum: 1, maximum: READ_MAX },
        wait: { type: 'integer', minimum: 1, maximum: SESSION_READ_WAIT_MAX_S },
        ...filesProp
      },
      required: ['session'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  {
    name: 'end_session',
    description:
      'End another session on this runner: stop its agent and terminals and remove its worktree. Its branch is kept unless deleteBranch is true. Refused while the worktree has uncommitted work or commits no remote has, unless discard is true (which loses them). A session cannot end itself this way, and one on another runner is ended there.',
    inputSchema: {
      type: 'object',
      properties: {
        board: sessionArg.board,
        session: sessionArg.session,
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
const NO_RELAY =
  'Other runners cannot be reached from here: this runner has no link to Factiii right now.';

const fail = (text: string): Answer => ({ text, isError: true });
const ok = (text: string): Answer => ({ text, isError: false });
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const errText = (err: unknown) =>
  err instanceof Error ? err.message : String(err);
const pretty = (value: unknown) => JSON.stringify(value, null, 2);

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

const originOf = (
  starter: SessionStarter,
  caller: HypervisorCaller
): RelayOrigin => ({
  actor: { userId: starter.userId, name: starter.name },
  from: { board: caller.slug, session: caller.session }
});

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

/** `runner` names this runner: empty, or its name. */
const isHere = (host: HypervisorHost, runner: string) =>
  !runner || runner === host.runner;

/** Messages each calling session sent in the last minute, per host. */
const sentAt = new WeakMap<HypervisorHost, Map<string, number[]>>();

/** Count one message from `caller`; the refusal when it is one too many. */
function takeMessageSlot(
  host: HypervisorHost,
  caller: HypervisorCaller
): string | null {
  const now = host.now?.() ?? Date.now();
  let windows = sentAt.get(host);
  if (!windows) {
    windows = new Map();
    sentAt.set(host, windows);
  }
  const key = `${caller.slug}/${caller.session}`;
  const recent = (windows.get(key) ?? []).filter((t) => now - t < MINUTE_MS);
  if (recent.length >= MESSAGES_PER_MINUTE) {
    windows.set(key, recent);
    const wait = Math.ceil((MINUTE_MS - (now - recent[0]!)) / 1000);
    return `Rate limited: a session may send ${MESSAGES_PER_MINUTE} messages a minute. Try again in ${wait} s; do not retry before then.`;
  }
  recent.push(now);
  windows.set(key, recent);
  return null;
}

/** What is wrong with a message's text, or null. The same check runs on the
 *  server for one it relays, and on the target. */
export function messageRefusal(text: string): string | null {
  if (!text) return 'text is required.';
  if (text.length > SESSION_MESSAGE_MAX) {
    return `text is too long (at most ${SESSION_MESSAGE_MAX} characters).`;
  }
  const secret = findSecret(text);
  if (secret) {
    return `Not sent: the text holds what looks like ${secret}. Sessions never pass secrets to each other: leave it out, or have the other session read it from its own secrets.`;
  }
  return null;
}

/** What the target's agent reads ahead of a message, so it knows who asks
 *  and how to answer. */
export function messageHeader(from: {
  runner: string;
  runnerId?: string;
  board: string;
  session: string;
  name: string;
}): string {
  const where = from.runnerId
    ? `${from.runner} (${from.runnerId})`
    : from.runner;
  const reply = `message_session { session: "${from.session}", board: "${from.board}"${from.runnerId ? `, runner: "${from.runnerId}"` : ''} }`;
  return `[Message from session ${from.session} on ${where}, board ${from.board}, for ${from.name}. To answer, call ${reply}.]`;
}

/** Find the session a call names, on a board the person reaches at
 *  Shell. A board they cannot use says the same as a missing session:
 *  what they cannot see is not confirmed to exist. */
function findTarget(
  host: HypervisorHost,
  starter: SessionStarter,
  args: Loose
):
  | { slug: string; board: HypervisorBoard; session: HypervisorSession }
  | string {
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

/** A session the call names, here or on another runner. Another runner is
 *  asked when `runner` names one, or when the session is not here and the
 *  directory has exactly one by that id. */
async function locate(
  host: HypervisorHost,
  starter: SessionStarter,
  caller: HypervisorCaller,
  args: Loose
): Promise<
  | { here: ReturnType<typeof findTarget> }
  | { remote: { runner: string; board: string; session: string } }
> {
  const runner = str(args.runner);
  if (isHere(host, runner)) {
    const here = findTarget(host, starter, args);
    if (typeof here !== 'string' || runner || !host.remote) return { here };
    // Not here: one by that id elsewhere is the one meant.
    const id = str(args.session);
    const wanted = str(args.board);
    const listed = await host.remote
      .sessions(originOf(starter, caller), wanted || undefined)
      .catch(() => null);
    const hits = (listed?.sessions ?? []).filter((s) => s.id === id);
    if (hits.length !== 1) return { here };
    return {
      remote: { runner: hits[0]!.runner, board: hits[0]!.board, session: id }
    };
  }
  const board = str(args.board);
  const session = str(args.session);
  if (!session)
    return { here: 'session is required: an id from list_sessions.' };
  if (!board) {
    return {
      here: 'board is required for a session on another runner: its slug, as list_sessions shows it.'
    };
  }
  return { remote: { runner, board, session } };
}

const describeCaller = (caller: HypervisorCaller) =>
  `by session ${caller.session} on ${caller.slug}`;

async function listRunners(
  host: HypervisorHost,
  starter: SessionStarter,
  caller: HypervisorCaller
): Promise<Answer> {
  const here = {
    id: host.runner,
    name: host.runner,
    kind: 'runner',
    here: true,
    boards: reachable(host, starter, 'shell'),
    offers: host.offers?.() ?? null,
    allowsStarts: true
  };
  if (!host.remote) return ok(pretty({ runners: [here], note: NO_RELAY }));
  try {
    const others = await host.remote.runners(originOf(starter, caller));
    return ok(pretty({ runners: [here, ...others] }));
  } catch (err) {
    return ok(
      pretty({
        runners: [here],
        note: `The other runners could not be listed: ${errText(err)}`
      })
    );
  }
}

async function listSessions(
  host: HypervisorHost,
  starter: SessionStarter,
  caller: HypervisorCaller,
  args: Loose
): Promise<Answer> {
  const wanted = str(args.board);
  const boards = reachable(host, starter, 'jobs').filter(
    (slug) => !wanted || slug === wanted
  );
  const sessions: Record<string, unknown>[] = boards.flatMap((slug) =>
    (host.board(slug)?.sessions() ?? []).map((s) => ({
      board: slug,
      runner: host.runner,
      runnerName: host.runner,
      id: s.id,
      title: s.title,
      state: s.state,
      mode: s.mode,
      card: s.cardId,
      worktree: s.worktree || null,
      startedByAgent: s.startedVia ? s.startedVia : null,
      ...(s.startedByRunner ? { startedByRunner: s.startedByRunner } : {})
    }))
  );
  let note: string | undefined;
  if (host.remote) {
    try {
      const remote = await host.remote.sessions(
        originOf(starter, caller),
        wanted || undefined
      );
      sessions.push(...remote.sessions);
      if (remote.unreachable?.length) {
        note = `Not reachable now: ${remote.unreachable.join(', ')}.`;
      }
    } catch (err) {
      note = `The other runners' sessions could not be listed: ${errText(err)}`;
    }
  }
  if (wanted && boards.length === 0 && sessions.length === 0) {
    return fail(`You cannot see the sessions on ${wanted}.`);
  }
  return ok(pretty(note ? { sessions, note } : { sessions }));
}

/** What is wrong with a start's arguments on `board`, or null. The same for
 *  a start here and one relayed from another runner. */
function startRefusal(
  board: HypervisorBoard,
  slug: string,
  args: RemoteStart
): string | null {
  const code = args.mode === 'code';
  if (args.mode !== 'chat' && !code) return 'mode must be "chat" or "code".';
  const message = args.message.trim();
  if (!message) return 'message is required: the task for its agent.';
  const refused = messageRefusal(message);
  if (refused) return refused.replace('text', 'message');
  const title = (args.title ?? '').trim();
  if (code && !title) {
    return 'A Code session needs a title: its worktree and branch take that name.';
  }
  if (code && !board.hasRepo()) {
    return `${slug} has no repository connected, so it cannot have a Code session. Start a chat instead.`;
  }
  if (args.cardId && !isCardPostId(args.cardId)) {
    return 'cardId must be a card uuid.';
  }
  const started = board.sessions().filter((s) => s.startedVia).length;
  if (started >= MCP_SESSION_CAP) {
    return `${slug} already has ${started} sessions started by agents (the limit is ${MCP_SESSION_CAP}). End one with end_session first.`;
  }
  return null;
}

async function startSession(
  host: HypervisorHost,
  starter: SessionStarter,
  caller: HypervisorCaller,
  args: Loose
): Promise<Answer> {
  const slug = str(args.board) || caller.slug;
  const runner = str(args.runner);
  const start: RemoteStart = {
    mode: str(args.mode) as RemoteStart['mode'],
    message: str(args.message),
    ...(str(args.title) ? { title: str(args.title) } : {}),
    ...(str(args.cardId) ? { cardId: str(args.cardId) } : {}),
    ...(str(args.baseBranch) ? { baseBranch: str(args.baseBranch) } : {})
  };
  if (!isHere(host, runner)) {
    if (!host.remote) return fail(NO_RELAY);
    if (start.mode !== 'chat' && start.mode !== 'code') {
      return fail('mode must be "chat" or "code".');
    }
    const refused = messageRefusal(start.message);
    if (refused) return fail(refused.replace('text', 'message'));
    try {
      const { sessionId } = await host.remote.start(originOf(starter, caller), {
        runner,
        board: slug,
        start
      });
      const board = host.board(caller.slug);
      await board?.audit({
        actor: starter,
        action: 'session-start',
        detail: `${start.mode === 'code' ? 'Code' : 'Chat'} session ${sessionId} "${start.title || 'Chat'}" on runner ${runner}, board ${slug}${start.cardId ? `, card ${start.cardId}` : ''}, ${describeCaller(caller)}`
      });
      return ok(
        `Started ${start.mode === 'code' ? 'Code' : 'Chat'} session ${sessionId} on ${slug} (${runner}). It runs there with that runner's own permissions. read_session { runner: "${runner}", board: "${slug}", session: "${sessionId}", wait: 600 } waits for its answer.`
      );
    } catch (err) {
      return fail(errText(err));
    }
  }
  if (!levelAtLeast(host.level(starter, slug), 'shell')) {
    return fail(
      `You cannot start sessions on ${slug} on this runner: that takes the Shell level there.`
    );
  }
  const board = host.board(slug);
  if (!board) return fail(`This runner does not serve the board ${slug}.`);
  const refused = startRefusal(board, slug, start);
  if (refused) return fail(refused);
  const code = start.mode === 'code';
  let id: string;
  try {
    id = await board.start({
      title: start.title || 'Chat',
      code,
      baseBranch: start.baseBranch ?? '',
      cardId: start.cardId ?? null,
      message: start.message,
      startedBy: starter,
      startedVia: caller.session
    });
  } catch (err) {
    return fail(errText(err));
  }
  await board.audit({
    actor: starter,
    action: 'session-start',
    detail: `${code ? 'Code' : 'Chat'} session ${id} "${start.title || 'Chat'}"${start.cardId ? ` on card ${start.cardId}` : ''}, ${describeCaller(caller)}`
  });
  return ok(
    `Started ${code ? 'Code' : 'Chat'} session ${id} on ${slug} (${host.runner}). The opening message goes in once its workspace is ready; read_session shows the reply.`
  );
}

/** A target the call found: a session here, or one over the relay. */
type Located =
  | {
      here: {
        slug: string;
        board: HypervisorBoard;
        session: HypervisorSession;
      };
    }
  | { remote: { runner: string; board: string; session: string } };

/** What may be sent from `session` on `board` here, or null when this
 *  runner or that board sends no files. */
function sourceRules(
  host: HypervisorHost,
  board: HypervisorBoard,
  sessionId: string
): FileSourceRules | null {
  if (!host.files || !board.fileRoots) return null;
  return {
    roots: board.fileRoots(sessionId),
    forbidden: host.files.forbidden,
    isVaultFile: host.files.isVaultFile,
    maxBytes: host.files.maxBytes
  };
}

/** read_session's `files` (and why there are none). */
const filesField = (brought: SessionFileResult[] | string) =>
  typeof brought === 'string'
    ? { files: [], filesNote: brought }
    : { files: brought };

const fileLine = (f: SessionFileInfo) =>
  `"${f.name}" (${f.bytes} bytes, sha256 ${f.sha256.slice(0, 16)}…)`;

/** Bring `requested` from the target to the caller's $DROPS_DIR, each one a
 *  line in the caller's board's audit log (and the target's: here, below;
 *  across runners, answerSessionOp there). The refusal of the whole as a
 *  string. */
async function bringFiles(
  host: HypervisorHost,
  starter: SessionStarter,
  caller: HypervisorCaller,
  found: Located,
  requested: string[]
): Promise<SessionFileResult[] | string> {
  const mine = host.board(caller.slug);
  const dropsDir = mine?.dropsDir?.();
  if (!host.files || !mine || !dropsDir) {
    return 'This runner takes no files from sessions.';
  }
  let source: FileSource;
  let from: string;
  if ('remote' in found) {
    const remote = host.remote;
    if (!remote?.file)
      return 'Files cannot be brought from other runners here.';
    const target = found.remote;
    const origin = originOf(starter, caller);
    source = {
      info: async (path) => {
        const res = await remote.file!(origin, {
          ...target,
          path,
          part: 'info'
        });
        if (!('file' in res))
          throw new Error(`${target.runner} did not describe ${path}.`);
        return res.file;
      },
      chunk: async (path, part) => {
        const res = await remote.file!(origin, { ...target, path, part });
        if (!('chunk' in res))
          throw new Error(`${target.runner} sent no data for ${path}.`);
        return res.chunk;
      }
    };
    from = `session ${target.session} on runner ${target.runner}, board ${target.board}`;
  } else {
    const target = found.here;
    const rules = sourceRules(host, target.board, target.session.id);
    if (!rules) return `${target.slug} sends no files.`;
    const local = localFileSource(rules);
    const to = `to session ${caller.session} on ${caller.slug}`;
    const audit = (detail: string) =>
      target.board
        .audit({ actor: starter, action: 'session-file-send', detail })
        .catch(() => undefined);
    source = {
      info: async (path) => {
        try {
          const info = await local.info(path);
          await audit(
            `${fileLine(info)} from session ${target.session.id}, ${to}`
          );
          return info;
        } catch (err) {
          await audit(
            `"${path}" from session ${target.session.id} refused (${errText(err)}), ${to}`
          );
          throw err;
        }
      },
      chunk: local.chunk
    };
    from = `session ${target.session.id} on ${target.slug}`;
  }
  const results = await fetchFiles(source, requested, {
    dropsDir,
    maxBytes: host.files.maxBytes
  });
  for (const r of results) {
    await mine
      .audit({
        actor: starter,
        action: 'session-file-receive',
        detail:
          'path' in r
            ? `"${r.requested}" (${r.bytes} bytes, sha256 ${r.sha256.slice(0, 16)}…) from ${from}, landed at ${r.path}, ${describeCaller(caller)}`
            : `"${r.requested}" from ${from} refused (${r.error}), ${describeCaller(caller)}`
      })
      .catch(() => undefined);
  }
  return results;
}

async function messageSession(
  host: HypervisorHost,
  starter: SessionStarter,
  caller: HypervisorCaller,
  args: Loose
): Promise<Answer> {
  const text = str(args.text);
  const refused = messageRefusal(text);
  if (refused) return fail(refused);
  const files = filesArg(args.files);
  if (typeof files === 'string') return fail(files);
  /** The answer, with the files it brought when it was asked for some. */
  const answer = async (said: string, found: Located): Promise<Answer> => {
    if (files.length === 0) return ok(said);
    const brought = await bringFiles(host, starter, caller, found, files);
    return ok(pretty({ message: said, ...filesField(brought) }));
  };
  const expiresIn = expiresInArg(args.expiresIn);
  if (typeof expiresIn === 'string') return fail(expiresIn);
  const found = await locate(host, starter, caller, args);
  if ('remote' in found) {
    if (!host.remote) return fail(NO_RELAY);
    if (expiresIn !== null) {
      return fail(
        `expiresIn is for a session on this runner: ${found.remote.session} is on ${found.remote.runner}, where a message is held ${SESSION_MESSAGE_HOLD_DAYS} days. Send it without expiresIn.`
      );
    }
    const limited = takeMessageSlot(host, caller);
    if (limited) return fail(limited);
    try {
      const sent = await host.remote.message(originOf(starter, caller), {
        ...found.remote,
        text
      });
      await host.board(caller.slug)?.audit({
        actor: starter,
        action: 'session-message',
        detail: `to session ${found.remote.session} on runner ${found.remote.runner}, board ${found.remote.board} (message ${sent.messageId}, ${sent.state}), ${describeCaller(caller)}`
      });
      return await answer(
        sent.state === 'waiting'
          ? `Held for ${found.remote.session} on ${found.remote.runner}: ${remoteHoldText(parseMessageHold(sent.hold))} (held ${SESSION_MESSAGE_HOLD_DAYS} days). Message ${sent.messageId}.`
          : `Delivered to ${found.remote.session} on ${found.remote.runner} (${found.remote.board}): it reads it once any turn in progress ends. Message ${sent.messageId}.`,
        found
      );
    } catch (err) {
      return fail(errText(err));
    }
  }
  const target = found.here;
  if (typeof target === 'string') return fail(target);
  if (target.slug === caller.slug && target.session.id === caller.session) {
    return fail('That is this session: reply here instead.');
  }
  const limited = takeMessageSlot(host, caller);
  if (limited) return fail(limited);
  let sent: Awaited<ReturnType<HypervisorBoard['message']>>;
  try {
    sent = await target.board.message(
      target.session.id,
      `${messageHeader({ runner: host.runner, board: caller.slug, session: caller.session, name: starter.name })}\n\n${text}`,
      {
        from: senderKey(caller),
        ...(expiresIn === null ? {} : { holdMs: expiresIn * MINUTE_MS })
      }
    );
  } catch (err) {
    return fail(errText(err));
  }
  await target.board.audit({
    actor: starter,
    action: 'session-message',
    detail: `to session ${target.session.id} "${target.session.title}" (message ${sent.id}, ${sent.state}${sent.state === 'waiting' && sent.hold ? `: ${sent.hold}` : ''}), ${describeCaller(caller)}`
  });
  return answer(
    sent.state === 'waiting'
      ? `In ${target.session.id}'s inbox on ${target.slug}, not delivered yet: ${messageHoldText(sent.hold)}.${expiresIn === null ? '' : ` Dropped if it still waits in ${expiresIn} min.`} cancel_message { message: "${sent.id}" } takes it back. Message ${sent.id}.`
      : `Sent to ${target.session.id} on ${target.slug}. Message ${sent.id}.`,
    { here: target }
  );
}

/** Who a message is from, as its inbox keeps it: the one session that may
 *  cancel it. */
const senderKey = (caller: HypervisorCaller) =>
  `${caller.slug}/${caller.session}`;

/** message_session's `expiresIn`: whole minutes, null when not given, or why
 *  it is refused. */
function expiresInArg(value: unknown): number | null | string {
  if (value === undefined || value === null) return null;
  const minutes = Number(value);
  if (
    !Number.isInteger(minutes) ||
    minutes < 1 ||
    minutes > EXPIRES_IN_MAX_MIN
  ) {
    return `expiresIn is whole minutes, 1 to ${EXPIRES_IN_MAX_MIN}.`;
  }
  return minutes;
}

/** Why a message for a session on another runner waits. With no reason from
 *  there (the runner is offline, or from before it said): either. */
const remoteHoldText = (hold: RelayMessageHold | undefined) =>
  hold
    ? messageHoldText(hold)
    : 'it is offline or not ready for a message (on a turn, or its terminal not open), and gets it as soon as it can';

/** Take back a message this session sent that still waits in an inbox on
 *  this runner. */
async function cancelMessage(
  host: HypervisorHost,
  starter: SessionStarter,
  caller: HypervisorCaller,
  args: Loose
): Promise<Answer> {
  const id = str(args.message);
  if (!id) return fail('message is the id message_session returned.');
  for (const slug of host.boards()) {
    const board = host.board(slug);
    if (!board?.cancel) continue;
    if (!(await board.cancel(id, senderKey(caller)).catch(() => false))) {
      continue;
    }
    await board.audit({
      actor: starter,
      action: 'session-message',
      detail: `cancelled message ${id} while it waited, ${describeCaller(caller)}`
    });
    return ok(`Cancelled message ${id}: it will not be delivered.`);
  }
  return fail(
    `No message ${id} of yours is waiting on ${host.runner}: it was delivered, expired or cancelled already, or it is held for another runner (that one cannot be taken back).`
  );
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

/** What the session said after the last message it was given: its answer.
 *  Empty while it has not answered yet. The end is kept when it must be
 *  cut, since that is where a summary is. */
export function lastAnswer(events: ChatEvent[], max = SUMMARY_MAX): string {
  let lastUser = -1;
  events.forEach((e, i) => {
    if (e.type === 'user') lastUser = i;
  });
  if (lastUser < 0) return '';
  return events
    .slice(lastUser + 1)
    .flatMap((e) => (e.type === 'assistant' ? [e.text.trim()] : []))
    .filter(Boolean)
    .join('\n\n')
    .slice(-max);
}

/** A session on a board here, as read_session answers it, here or across
 *  the relay. */
async function readView(
  board: HypervisorBoard,
  session: HypervisorSession,
  limit: number
): Promise<RelayRead> {
  const [events, work] = await Promise.all([
    board.transcript(session.id).catch(() => [] as ChatEvent[]),
    board.work(session.id).catch((err: unknown) => errText(err))
  ]);
  return {
    title: session.title,
    state: session.state,
    mode: session.mode,
    card: session.cardId,
    worktree: session.worktree || null,
    git:
      typeof work === 'string'
        ? `git could not read the worktree: ${work}`
        : work && {
            branch: work.branch,
            dirtyFiles: work.dirtyFiles,
            ahead: work.ahead,
            behind: work.behind,
            unpushed: work.unpushed
          },
    transcript: events.slice(-limit).map(eventLine),
    answer: lastAnswer(events),
    waiting: board.waiting(session.id),
    hold: board.hold?.(session.id)
  };
}

/** Its turn is over: idle (or stopped on an error) with nothing left in its
 *  inbox. */
const settled = (read: RelayRead, held: number) =>
  (read.state === 'idle' || read.state === 'error') &&
  read.waiting === 0 &&
  held === 0;

async function readSession(
  host: HypervisorHost,
  starter: SessionStarter,
  caller: HypervisorCaller,
  args: Loose
): Promise<Answer> {
  const limit = Math.min(
    READ_MAX,
    Math.max(1, Math.floor(Number(args.limit) || READ_DEFAULT))
  );
  const waitS = Math.min(
    SESSION_READ_WAIT_MAX_S,
    Math.max(0, Math.floor(Number(args.wait) || 0))
  );
  const now = () => host.now?.() ?? Date.now();
  const sleep = (ms: number) =>
    host.sleep?.(ms) ?? new Promise<void>((r) => setTimeout(r, ms));
  const deadline = now() + waitS * 1000;
  const files = filesArg(args.files);
  if (typeof files === 'string') return fail(files);
  const found = await locate(host, starter, caller, args);

  // One look: the read, the messages still held for it, and where it runs.
  let look: () => Promise<{
    read: RelayRead;
    messages?: RelayMessageStatus[];
    where: Record<string, string>;
  }>;
  if ('remote' in found) {
    const remote = host.remote;
    if (!remote) return fail(NO_RELAY);
    const target = found.remote;
    look = async () => {
      const { read, messages } = await remote.read(originOf(starter, caller), {
        ...target,
        limit
      });
      return {
        read,
        messages,
        where: {
          board: target.board,
          runner: target.runner,
          id: target.session
        }
      };
    };
  } else {
    const target = found.here;
    if (typeof target === 'string') return fail(target);
    look = async () => {
      // Read again each time: its state moves while we wait.
      const session =
        target.board.sessions().find((s) => s.id === target.session.id) ?? null;
      if (!session) throw new Error(`${target.session.id} has ended.`);
      return {
        read: await readView(target.board, session, limit),
        where: { board: target.slug, runner: host.runner, id: session.id }
      };
    };
  }

  let seen: Awaited<ReturnType<typeof look>>;
  try {
    seen = await look();
    if (waitS > 0) {
      // A turn seen running counts: what it says when it stops is the
      // summary. Already settled with an answer: that one.
      for (;;) {
        const held =
          seen.messages?.filter((m) => m.state === 'waiting').length ?? 0;
        if (settled(seen.read, held) && seen.read.answer) break;
        if (now() >= deadline) break;
        await sleep('remote' in found ? WAIT_POLL_REMOTE_MS : WAIT_POLL_MS);
        seen = await look();
      }
    }
  } catch (err) {
    return fail(errText(err));
  }
  const { read, messages, where } = seen;
  const held = messages?.filter((m) => m.state === 'waiting').length ?? 0;
  const done = settled(read, held) && Boolean(read.answer);
  // After the wait: the files its turn made are there by then.
  let brought: SessionFileResult[] | string = [];
  if (files.length > 0) {
    brought = await bringFiles(
      host,
      starter,
      caller,
      'remote' in found
        ? found
        : { here: found.here as Exclude<typeof found.here, string> },
      files
    );
  }
  return ok(
    pretty({
      ...where,
      title: read.title,
      state: read.state,
      mode: read.mode,
      card: read.card,
      worktree: read.worktree,
      git: typeof read.git === 'string' ? { error: read.git } : read.git,
      inboxWaiting: read.waiting,
      ...(read.waiting > 0
        ? {
            inboxNote: `Not delivered yet: ${messageHoldText(parseMessageHold(read.hold))}.`
          }
        : {}),
      ...(messages ? { messages } : {}),
      transcript: read.transcript,
      ...(waitS > 0
        ? done
          ? { summary: read.answer }
          : {
              summary: null,
              note: `Still ${read.state} after ${waitS} s: read it again later.`
            }
        : {}),
      ...(files.length > 0 ? filesField(brought) : {})
    })
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
        `Not ended: git could not read ${session.worktree} (${errText(err)}), so it may hold work. Pass discard: true to end it anyway.`
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
    return fail(errText(err));
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
    case 'list_runners':
      return listRunners(host, starter, caller);
    case 'list_sessions':
      return listSessions(host, starter, caller, args);
    case 'start_session':
      return startSession(host, starter, caller, args);
    case 'message_session':
      return messageSession(host, starter, caller, args);
    case 'cancel_message':
      return cancelMessage(host, starter, caller, args);
    case 'read_session':
      return readSession(host, starter, caller, args);
    case 'end_session':
      return endSession(host, starter, caller, args);
    default:
      return fail(`Unknown tool ${name}.`);
  }
}

/**
 * A call the server relayed from a session on another runner (`runner:
 * session-op`), answered here under this runner's own rules: the person it
 * acts for needs the Shell level on the board here, as by hand; a start also
 * needs the owner's "Allow sessions to be started from other runners", and
 * runs with this runner's own permissions. Every message and start is a line
 * in this board's audit log, naming the person and where it came from (the
 * sending runner logs its own).
 */
export async function answerSessionOp(
  host: HypervisorHost,
  op: SessionOp
): Promise<SessionOpAck> {
  const owner = host.owner();
  const starter: SessionStarter = {
    userId: op.actor.userId,
    name: op.actor.name,
    role: owner.userId && owner.userId === op.actor.userId ? 'owner' : 'member'
  };
  const from = `from session ${op.from.session} on runner ${op.from.runner}, board ${op.from.board}`;
  if (!levelAtLeast(host.level(starter, op.spaceSlug), 'shell')) {
    return {
      error: `${op.actor.name} cannot reach sessions on ${op.spaceSlug} on ${host.runner}: that takes the Shell level there.`
    };
  }
  const board = host.board(op.spaceSlug);
  if (!board)
    return { error: `${host.runner} does not serve ${op.spaceSlug}.` };

  if (op.op === 'start') {
    if (!host.allowRemoteStarts?.()) {
      return {
        error: `${host.runner}'s owner has not allowed sessions to be started from other runners (Runner > Activity, "Allow sessions to be started from other runners").`
      };
    }
    const refused = startRefusal(board, op.spaceSlug, op.start);
    if (refused) return { error: refused };
    const code = op.start.mode === 'code';
    const title = op.start.title || 'Chat';
    try {
      const sessionId = await board.start({
        title,
        code,
        baseBranch: op.start.baseBranch ?? '',
        cardId: op.start.cardId ?? null,
        message: `${messageHeader({ ...op.from, name: op.actor.name })}\n\n${op.start.message}`,
        startedBy: starter,
        startedVia: `${op.from.runner}/${op.from.session}`,
        startedByRunner: op.from.runner
      });
      await board.audit({
        actor: starter,
        action: 'session-start',
        detail: `${code ? 'Code' : 'Chat'} session ${sessionId} "${title}"${op.start.cardId ? ` on card ${op.start.cardId}` : ''}, ${from}`
      });
      return { ok: true, sessionId };
    } catch (err) {
      return { error: errText(err) };
    }
  }

  const session = board.sessions().find((s) => s.id === op.session);
  if (!session) {
    return {
      error: `No session ${op.session} on ${op.spaceSlug} on ${host.runner}.`
    };
  }
  if (op.op === 'read') {
    return { ok: true, read: await readView(board, session, op.limit) };
  }
  if (op.op === 'file')
    return answerFileOp(host, board, session, starter, op, from);
  const refused = messageRefusal(op.text);
  if (refused) return { error: refused };
  try {
    const sent = await board.message(
      session.id,
      `${messageHeader({ ...op.from, name: op.actor.name })}\n\n${op.text}`,
      { id: op.messageId }
    );
    await board.audit({
      actor: starter,
      action: 'session-message',
      detail: `to session ${session.id} "${session.title}" (message ${op.messageId}, ${sent.state}), ${from}`
    });
    return { ok: true, state: sent.state, hold: sent.hold };
  } catch (err) {
    return { error: errText(err) };
  }
}

/** How long a file's description lets its chunks be asked for, from the
 *  last one asked. */
const FILE_TICKET_MS = 5 * 60_000;
/** A file described to one caller: its chunks go only to that caller, only
 *  while the file is the one the secret scan read (`stamp`). */
type FileTicket = { stamp: SourceFileStamp; chunks: number; until: number };
/** Per host, the files described across runners (answerFileOp). */
const fileTickets = new WeakMap<HypervisorHost, Map<string, FileTicket>>();

/** A file op relayed from a session on another runner: describe the file
 *  (`info`, a line in this board's audit log, sent or refused) or send one
 *  chunk. The path is checked on every call (session-files.ts), and nothing
 *  in the Vault is ever sent. A chunk goes only for a file described to the
 *  same person and session a short while ago and unchanged since, so no
 *  chunk skips the description's secret scan and audit line. */
async function answerFileOp(
  host: HypervisorHost,
  board: HypervisorBoard,
  session: HypervisorSession,
  starter: SessionStarter,
  op: Extract<SessionOp, { op: 'file' }>,
  from: string
): Promise<SessionOpAck> {
  const rules = sourceRules(host, board, session.id);
  if (!rules) return { error: `${host.runner} sends no files.` };
  const tickets = fileTickets.get(host) ?? new Map<string, FileTicket>();
  fileTickets.set(host, tickets);
  const now = Date.now();
  for (const [k, t] of tickets) if (t.until < now) tickets.delete(k);
  const key = JSON.stringify([
    op.actor.userId,
    op.from.runnerId,
    op.from.session,
    op.spaceSlug,
    session.id,
    op.path
  ]);
  if (op.part !== 'info') {
    const ticket = tickets.get(key);
    if (!ticket) {
      return {
        error: `${op.path} was not described to this session first, or that was too long ago: ask for it again.`
      };
    }
    if (op.part >= ticket.chunks) {
      return {
        error: `${op.path} has ${ticket.chunks} chunks, not ${op.part + 1}.`
      };
    }
    try {
      const chunk = readSourceChunk(
        rules,
        op.path,
        op.part,
        undefined,
        ticket.stamp
      );
      ticket.until = now + FILE_TICKET_MS;
      return { ok: true, chunk };
    } catch (err) {
      tickets.delete(key);
      return { error: errText(err) };
    }
  }
  tickets.delete(key);
  const to = `to ${from.replace(/^from /, '')}`;
  try {
    const { info: file, stamp } = describeSourceFileStamped(rules, op.path);
    tickets.set(key, {
      stamp,
      chunks: file.chunks,
      until: now + FILE_TICKET_MS
    });
    await board
      .audit({
        actor: starter,
        action: 'session-file-send',
        detail: `${fileLine(file)} from session ${session.id}, ${to}`
      })
      .catch(() => undefined);
    return { ok: true, file };
  } catch (err) {
    await board
      .audit({
        actor: starter,
        action: 'session-file-send',
        detail: `"${op.path}" from session ${session.id} refused (${errText(err)}), ${to}`
      })
      .catch(() => undefined);
    return { error: errText(err) };
  }
}
