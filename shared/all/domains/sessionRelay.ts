// Sessions across runners (.specs/card-sessions.md "Across runners", card
// 6336db91): a session on one runner lists, reads, messages and starts
// sessions on another runner, or on the desktop app's local agent, through
// Factiii's server. No runner talks to another: each one already holds a
// socket to the server, which keeps a directory of the live sessions every
// runner reports, checks who may reach what, carries each call to the target
// and holds a message for an offline target. These are the shapes on that
// wire; the payloads are checked by validators/sessionRelay.ts.

/** The longest message_session text, before its header. Under the chat's own
 *  limit (CHAT_SEND_MAX), so the header always fits. */
export const SESSION_MESSAGE_MAX = 16_000;

/** A message to an offline target is held this long, then "expired". */
export const SESSION_MESSAGE_HOLD_DAYS = 7;
export const SESSION_MESSAGE_HOLD_MS =
  SESSION_MESSAGE_HOLD_DAYS * 24 * 60 * 60 * 1000;

/** How long read_session's `wait` may wait for a final summary, in seconds. */
export const SESSION_READ_WAIT_MAX_S = 600;

/** How many messages may wait for one target session at once. */
export const SESSION_MESSAGES_HELD_MAX = 50;

/** Files read_session / message_session bring back from the target session
 *  to the caller's $DROPS_DIR (.specs/card-sessions.md "Across runners",
 *  "Files"). The most one call may bring, in all; a runner may set its own
 *  (FACTIII_SESSION_FILES_MAX_MB), never over SESSION_FILES_MAX_BYTES_CEILING.
 */
export const SESSION_FILES_MAX_BYTES = 50 * 1024 * 1024;
export const SESSION_FILES_MAX_BYTES_CEILING = 500 * 1024 * 1024;
/** How many files one call may name. */
export const SESSION_FILES_PER_CALL = 10;
/** One relayed piece of a file, before base64: under the socket's 1 MB
 *  frame once encoded. */
export const SESSION_FILE_CHUNK_BYTES = 384 * 1024;
/** A chunk as it crosses the relay, base64. */
export const SESSION_FILE_CHUNK_B64_MAX =
  Math.ceil(SESSION_FILE_CHUNK_BYTES / 3) * 4;
/** The most chunks one file may be, at the ceiling. */
export const SESSION_FILE_CHUNKS_MAX = Math.ceil(
  SESSION_FILES_MAX_BYTES_CEILING / SESSION_FILE_CHUNK_BYTES
);

/** A file on the target as it describes it before sending: what the caller
 *  checks every chunk and the whole against. */
export type SessionFileInfo = {
  /** Its name, as it will land (the basename). */
  name: string;
  bytes: number;
  /** Hex sha256 of the whole file. */
  sha256: string;
  chunks: number;
};

/** One file as read_session / message_session report it: landed in the
 *  caller's $DROPS_DIR (`path`), or refused (`error`). */
export type SessionFileResult =
  | { requested: string; path: string; bytes: number; sha256: string }
  | { requested: string; error: string };

/** One runner session's state as list_sessions says it. */
export const RELAY_SESSION_STATES = [
  'starting',
  'working',
  'idle',
  'needs you',
  'error'
] as const;
export type RelaySessionState = (typeof RELAY_SESSION_STATES)[number];

/** Where a message stands. `waiting`: held for an offline target (on the
 *  server) or behind a turn in progress (in the target's inbox).
 *  `delivered`: in the target's chat. `expired`: not delivered in
 *  SESSION_MESSAGE_HOLD_DAYS. `failed`: the target was gone when it came
 *  back. */
export const RELAY_MESSAGE_STATES = [
  'waiting',
  'delivered',
  'expired',
  'failed'
] as const;
export type RelayMessageState = (typeof RELAY_MESSAGE_STATES)[number];

/** Why a message waits in its target's inbox (session-inbox.ts). `busy`: a
 *  turn is running, or a permission prompt is waiting on the person.
 *  `closed`: the session's terminal is not open (it is still starting, or in
 *  review). `unreported`: a CLI is open in a tab and has not said what it is
 *  doing, so nothing is typed into it. */
export const RELAY_MESSAGE_HOLDS = ['busy', 'closed', 'unreported'] as const;
export type RelayMessageHold = (typeof RELAY_MESSAGE_HOLDS)[number];

/** A message's `hold` off the wire: an unknown word (a newer runner's) is no
 *  reason at all, never passed on as one. */
export const parseMessageHold = (
  value: unknown
): RelayMessageHold | undefined =>
  RELAY_MESSAGE_HOLDS.find((hold) => hold === value);

/** A waiting message's `hold` as a clause after the session's name: "it is
 *  on a turn, and reads it when that ends". */
export function messageHoldText(hold: RelayMessageHold | undefined): string {
  switch (hold) {
    case 'closed':
      return 'its terminal is not open yet, and it reads it once that opens';
    case 'unreported':
      return 'the CLI open in its terminal has not reported what it is doing, so nothing is typed over it; it reads it once that CLI reports idle';
    default:
      return 'it is on a turn, and reads it when that ends';
  }
}

/** The desktop app's local agent is named `desktop:<userId>` where a runner is
 *  `r<runnerId>`: one person's desktop apps share one name, since the server
 *  sees them only as that person's sockets. */
export const DESKTOP_TARGET_PREFIX = 'desktop:';
export const runnerTargetId = (runnerId: number) => `r${runnerId}`;
export const desktopTargetId = (userId: number) =>
  `${DESKTOP_TARGET_PREFIX}${userId}`;

/** A session as a runner (or the desktop app) reports it to the server. */
export type RelaySession = {
  id: string;
  title: string;
  state: RelaySessionState;
  mode: 'Chat' | 'Code';
  card: string | null;
};

/** What a runner says it can do, for list_runners. Probed once at start
 *  (apps/runner/src/runnerOffers.ts). */
export type RunnerOffers = {
  /** `darwin arm64`, `linux x64`. */
  os: string;
  /** Tart is installed, so a session can open a macOS or Linux VM. */
  tart: boolean;
  /** Xcode's simulator (`xcrun simctl`). */
  simulator: boolean;
  /** A GPU an agent can use (Apple silicon, or `nvidia-smi`). */
  gpu: boolean;
};

/** One runner (or desktop app) as list_runners shows it. */
export type RelayRunner = {
  /** What `runner` arguments take: `r12` or `desktop:5`. A name works too
   *  when it is unique. */
  id: string;
  name: string;
  kind: 'runner' | 'desktop';
  owner: string;
  /** The boards (slugs) the caller reaches there. */
  boards: string[];
  offers: RunnerOffers | null;
  /** Its owner lets sessions be started there from other runners. Always
   *  false for the desktop app. */
  allowsStarts: boolean;
};

/** One session in list_sessions, from another runner. */
export type RelaySessionRow = RelaySession & {
  board: string;
  runner: string;
  runnerName: string;
};

/** read_session's answer from another runner. */
export type RelayRead = {
  title: string;
  state: RelaySessionState;
  mode: 'Chat' | 'Code';
  card: string | null;
  worktree: string | null;
  /** A Code session's git state; null for Chat; a string when git could not
   *  read it. */
  git: Record<string, unknown> | string | null;
  transcript: string[];
  /** What it said after the last message it was given; '' until it
   *  answers. */
  answer: string;
  /** Messages still in its inbox, waiting for a turn to end. */
  waiting: number;
  /** Why the oldest of them waits. Absent with none waiting, and from a
   *  runner from before this was said. */
  hold?: RelayMessageHold;
};

/** A message the asking session sent, as read_session lists them. */
export type RelayMessageStatus = {
  id: string;
  state: RelayMessageState;
  sentAt: string;
};

/** Who asks, as the calling runner vouches for its session: the person the
 *  session acts for (its startedBy) and the session itself. The server checks
 *  the person may use that runner on that board. */
export type RelayOrigin = {
  actor: { userId: string; name: string };
  from: { board: string; session: string };
};

/** The target's answer to a `runner:session-op` / `desktop:session-op`. */
export type SessionOpAck =
  | { error: string }
  | {
      ok: true;
      read?: RelayRead;
      state?: RelayMessageState;
      /** Why a `waiting` message waits in the target's inbox. */
      hold?: RelayMessageHold;
      sessionId?: string;
      /** A file op's answers: its description, or one chunk (base64). */
      file?: SessionFileInfo;
      chunk?: string;
    };

/** The server's answer to `runner:session-relay`, by op. */
export type SessionRelayAnswer =
  | { error: string }
  | { runners: RelayRunner[] }
  | { sessions: RelaySessionRow[]; unreachable?: string[] }
  | { read: RelayRead; messages: RelayMessageStatus[] }
  | { messageId: string; state: RelayMessageState; hold?: RelayMessageHold }
  | { sessionId: string }
  | { file: SessionFileInfo }
  | { chunk: string };
