import type { RoutineDueAck, RoutineDueFrame } from '../validators/routines';
import type {
  AgentState,
  BoardAgentActionMap,
  RunnerGrants,
  RunnerJobInfo,
  RunnerJobState
} from './electron';
import type { RunnerSleepSnapshot } from '../validators/runnerParts';
import type { IcePair } from './iceLink';
import type { Post } from './posts';

// UserTag as string union - compatible with both Prisma enum and shared enum
export type SocketUserTag =
  | 'HUMAN'
  | 'BOT'
  | 'GOVERNMENT'
  | 'ACADEMIA'
  | 'BUSINESS'
  | 'NEW'
  | 'WAITLIST'
  | 'VERIFIED';

// ============================================
// WebRTC Signaling Types
// ============================================

export interface RTCSessionDescriptionInit {
  type: 'offer' | 'answer' | 'pranswer' | 'rollback';
  sdp: string;
}

export interface RTCIceCandidateInit {
  candidate: string;
  sdpMLineIndex?: number | null;
  sdpMid?: string | null;
}

// ============================================
// Payload Types
// ============================================

export interface ActivityStatus {
  userId: number;
  lastActive: Date | null;
  isActive: boolean;
}

export interface ScrapeStatusUpdate {
  pendingScrapes: number;
  completedScrapes: number;
  failedScrapes: number;
  processingScrapes: number;
}

// Live cross-post publishing progress, pushed to the author's room as a post
// uploads to a platform. Ephemeral (no DB persistence) — the DB status is the
// source of truth on reload; this just drives the realtime progress bar.
export type CrossPostStage =
  | 'queued'
  | 'fetching'
  | 'uploading'
  | 'publishing'
  | 'processing'
  | 'posted'
  | 'failed';

export interface CrossPostProgress {
  crossPostId: number;
  postUuid: string;
  platform: string;
  stage: CrossPostStage;
  percent: number; // 0–100
}

// Message sender - subset of user data used in socket events
export interface MessageSender {
  id: number;
  name: string | null;
  username: string;
  tag: SocketUserTag;
  avatarKey: string | null;
  robohash: string | null;
}

// Participant in a conversation (sent via socket)
interface SocketConversationParticipant {
  id: number;
  name: string | null;
  username: string;
  avatarKey: string | null;
  robohash: string | null;
  lastActive: Date | null;
  isActive: boolean;
  tag: SocketUserTag;
}

// Last message in conversation (sent via socket)
interface SocketLastMessage {
  id: number;
  content: string;
  edited: boolean;
  /** Deleted for everyone — content is blank and the bubble shows a tombstone. */
  deleted: boolean;
  acknowledged: boolean;
  acknowledgedBy: {
    id: number;
    name: string | null;
    username: string;
  } | null;
  createdAt: Date;
  sender: MessageSender;
}

// Ban info in conversation (sent via socket)
interface SocketBanInfo {
  id: number;
  disputeRejected: boolean;
  isExpired: boolean;
  spaceSlug: string;
  userId: number;
}

// New conversation payload sent via socket. Channels are never announced this
// way (joining is a mutation that returns the full DTO), so the channel
// metadata is optional and clients default it when mapping to ConversationDto.
export interface NewConversationPayload {
  id: string;
  name: string | null;
  kind?: 'DM' | 'GROUP' | 'CHANNEL';
  read: boolean;
  /** Always 0/false here — a conversation you were just added to has nothing
   *  unread yet and cannot already be muted. Present so the payload maps
   *  straight onto ConversationDto without the client inventing defaults. */
  unreadCount?: number;
  muted?: boolean;
  lastMessage: SocketLastMessage | null;
  participants: SocketConversationParticipant[];
  type?: 'REGULAR' | 'BAN_DISPUTE';
  ban?: SocketBanInfo | null;
}

// Member added payload
export interface MemberAddedPayload {
  id: number;
  name: string | null;
  username: string;
  tag: SocketUserTag;
  avatarKey: string | null;
  robohash: string | null;
  lastActive: Date | null;
  isActive: boolean;
}

// Sync room callback responses
export interface CreateRoomResponse {
  roomId?: string;
  error?: string;
}

export interface JoinRoomResponse {
  success?: boolean;
  error?: string;
}

export type BoardScope = 'factiiis' | 'posts' | 'all';

// Realtime payload for the admin search-index backfill (pushed over socket).
type SearchIndexKind =
  | 'post'
  | 'user'
  | 'space'
  | 'factiii'
  | 'product'
  | 'media';
export type SearchIndexProgress = {
  running: boolean;
  processed: number;
  coverage: Record<SearchIndexKind, { total: number; missing: number }>;
};

// Live step of an AI research run, pushed per tool call so the UI can show
// "Searching Wikipedia…" etc. in real time.
export type ResearchProgressSource =
  | 'wikipedia'
  | 'bluesky'
  | 'youtube'
  | 'openalex'
  | 'edgar'
  | 'onedrive'
  // Finding or reading a skill (.specs/skills.md).
  | 'skill'
  // Running code in the sandbox, and the files it made.
  | 'code'
  // Summarizing a long Ask chat's earlier messages, so a follow-up costs less.
  | 'summary'
  | 'web';

export interface ResearchProgress {
  sessionId: string;
  source: ResearchProgressSource;
  label: string;
}

// A research turn runs for minutes, so the final assistant message is pushed
// over the socket instead of held on the HTTP request (which the proxy cuts at
// 60s). Keyed by sessionId so the panel can match its in-flight session.
export interface ResearchResult {
  sessionId: string;
  assistantMessage: string;
  status: string;
  cost: number;
  /** Set when the assistant kept this answer in the user's files. */
  saved?: { postUuid: string; title: string };
  /** The skills the conversation has followed so far (.specs/skills.md). */
  skills?: { uuid: string; title: string }[];
  /** Files the assistant made into the user's vault this turn. */
  files?: ResearchFile[];
  /** Set when the chat's earlier messages were summarized before this answer,
   *  so the thread can say so above the question it answers. */
  summarized?: boolean;
}

// A file the Ask assistant made with code execution, as the answer's file card
// shows it. It travels the same upload pipeline a dropped file does, so it can
// still be `saving` when the turn ends, or held as a `duplicate` of bytes the
// vault already has. `confirm` is a name clash waiting on the person: the
// assistant never replaces a file on its own say-so.
type ResearchFileStatus =
  | 'saving'
  | 'saved'
  | 'confirm'
  | 'duplicate'
  | 'failed'
  | 'discarded';

export interface ResearchFile {
  id: string;
  /** Where it sits in the vault: the Upload's name, folders and all. */
  path: string;
  size: number;
  status: ResearchFileStatus;
  /** The Upload row, once the pipeline has made one. */
  uploadId: string | null;
  error?: string;
}

export interface ResearchError {
  sessionId: string;
  message: string;
}

// ============================================
// Server -> Client Events
// ============================================

export interface ServerToClientEvents {
  // Who holds the vault's upload run, pushed the moment it changes. A vault has
  // one queue and one quota, so a second device must not start a selection
  // while another is sending — and it used to find that out by polling, which
  // meant an idle device never found out at all.
  //
  // `clientId` is the holder, or null when the vault is free. A device compares
  // it with its own id: anything else means someone else has it.
  vaultRunOwner: (owner: { clientId: string | null }) => void;
  // Global / Session
  message: (message: string) => void;
  refreshUser: () => void;
  logout: () => void;
  // Push-approval, to the unauthenticated `pending-<id>` room. Contentless:
  // completeLogin re-checks approval and IP before minting anything.
  loginApproved: () => void;
  // Optional reason (domains/pushApproval.ts). Contentless before, and the
  // shipped binaries still listen with `() => {}` — an extra argument is
  // ignored there, so adding one cannot break them.
  loginDenied: (reason?: string) => void;
  // To the user's own room: a sign-in request of theirs appeared, was
  // approved, or ended. Contentless: a signed-in browser asks
  // authLogin.pendingApproval what, if anything, waits now.
  loginApprovalChanged: () => void;
  tronReward: (quantity: number, title: string) => void;
  notificationCount: (
    count: number,
    detail?: { type: string; username: string }
  ) => void;

  // Conversations
  newMessage: (
    sender: MessageSender,
    conversationId: string,
    message: string,
    messageId: number,
    createdAt: Date,
    attachments?: Array<{
      id: string;
      key: string;
      type: 'IMAGE' | 'VIDEO' | 'DOCUMENT';
      name: string | null;
      // Signed, for a file in the private bucket (MessageAttachment.url).
      url?: string;
    }>,
    /**
     * Set when the message is a thread reply. Listeners rendering the main
     * transcript MUST skip these — a reply belongs in its thread pane, and
     * threads deliberately do not bump the conversation's last message.
     */
    parentId?: number | null
  ) => void;
  newConversation: (conversation: NewConversationPayload) => void;
  conversationNameUpdated: (conversationId: string, name: string) => void;
  memberAdded: (conversationId: string, member: MemberAddedPayload) => void;
  memberRemoved: (conversationId: string, memberId: number) => void;
  banDisputeRejected: (conversationId: string) => void;
  conversationDeleted: (conversationId: string) => void;
  messageAcknowledged: (messageId: number, conversationId: string) => void;
  messageEdited: (
    messageId: number,
    conversationId: string,
    content: string
  ) => void;
  /** Delete for everyone — the message is tombstoned, not removed. */
  messageDeleted: (messageId: number, conversationId: string) => void;
  /**
   * The sender took a delete back inside the restore window. Carries what the
   * tombstone dropped, so every participant shows the message again.
   */
  messageRestored: (
    messageId: number,
    conversationId: string,
    content: string,
    attachments: Array<{
      id: string;
      key: string;
      type: 'IMAGE' | 'VIDEO' | 'DOCUMENT';
      name: string | null;
      // Signed, for a file in the private bucket (MessageAttachment.url).
      url?: string;
    }>
  ) => void;
  /**
   * A reaction was toggled. `count` is the emoji's new total on that message
   * (0 = the last one was removed) so listeners can apply it without refetching;
   * `userId` lets each client decide whether its own `reacted` flag flips.
   */
  messageReaction: (
    messageId: number,
    conversationId: string,
    emoji: string,
    userId: number,
    added: boolean,
    count: number
  ) => void;
  /** A thread gained or lost a reply — `count` is the root's new reply total. */
  threadReplyCount: (
    parentId: number,
    conversationId: string,
    count: number
  ) => void;
  typing: (conversationId: string, senderId: number) => void;
  activity: (status: ActivityStatus, conversationId: string) => void;

  // Posts
  repliesCount: (count: number, postId: string) => void;
  newReply: (post: Post) => void;
  voteCount: (count: number, postId: string) => void;

  // Spaces — scoped by socket.io room (board-${id}, board-layout only), so
  // payloads only carry the actual data the listener needs.
  spaceMeta: () => void;
  spaceMembers: () => void;
  spaceRules: () => void;
  spaceDeleted: () => void;
  // boardUpdate is now a defensive escape hatch — no normal flow emits it.
  boardUpdate: (scope: BoardScope, factiiiId?: number) => void;
  // Admin search-index backfill progress (pushed to the admin who started it).
  searchIndexProgress: (payload: SearchIndexProgress) => void;
  // AI research live steps (pushed to the user running the research).
  researchProgress: (payload: ResearchProgress) => void;
  // The finished research turn (or its failure), pushed when the run completes.
  researchResult: (payload: ResearchResult) => void;
  researchError: (payload: ResearchError) => void;
  postCreated: (post: Post, factiiiId: number) => void;
  postMoved: (post: Post, fromFactiiiId: number, toFactiiiId: number) => void;
  postReordered: (postId: string, factiiiId: number, pos: number) => void;
  postEdited: (post: Post) => void;
  postVoted: (postId: string, count: number) => void;
  postDeleted: (postId: string) => void;
  factiiiReordered: (factiiiId: number, pos: number) => void;

  // WebRTC Device Sync
  peerJoined: () => void;
  peerLeft: () => void;
  syncOffer: (offer: RTCSessionDescriptionInit) => void;
  syncAnswer: (answer: RTCSessionDescriptionInit) => void;
  syncIceCandidate: (candidate: RTCIceCandidateInit) => void;

  // Scrape Status
  scrapeStatusUpdate: (status: ScrapeStatusUpdate) => void;

  // Live cross-post publishing progress (per platform, per post)
  crosspostProgress: (progress: CrossPostProgress) => void;

  verificationSessionChanged: () => void;
  verificationQueueChanged: () => void;
  // One-shot on admin approve. Offline sockets miss it; recovery is backup file or re-verify.
  verificationApproved: (payload: {
    approvedBios: string[];
    approvedAvatars: { id: string; bytes: string }[];
  }) => void;

  // Runner: status changes. `shared` marks a runner the user doesn't own but
  // can use because it's shared to a board they're a member of.
  runnerOnline: (data: {
    socketId: string;
    runnerId: number;
    name: string;
    platform: string;
    shared?: boolean;
  }) => void;
  runnerOffline: (data: { socketId: string; runnerId: number }) => void;
  // The owner revoked this runner from Settings → Connected Apps. The daemon
  // tears down any running jobs (kills processes + removes their containers)
  // and exits. The server still force-disconnects shortly after as a fallback
  // for older runners that don't handle this event.
  runnerRevoked: () => void;

  // Runner reported which private connections it has configured on its host
  // (the fact only, never the token value). Pushed to the owner's user room so
  // the Private connections UI updates live. See RunnerConnectionKind.
  runnerConnectionsUpdated: (data: {
    runnerId: number;
    connections: string[];
  }) => void;

  // Runner: WebRTC signaling (forwarded to runner or UI). `scope` is computed
  // and vouched by the server (never the client) — it tells the runner which
  // boards this connection may see and control. Owner = all boards.
  runnerOffer: (data: {
    fromSocketId: string;
    offer: RTCSessionDescriptionInit;
    scope?: RunnerScope;
    // Correlation id minted by the dialling peer. The same id appears in the
    // caller's report, the server's `[signal]` lines and the runner's report,
    // so one failed handshake can be read end to end instead of guessed at
    // from three logs that never mention each other. Absent from older peers.
    linkId?: string;
    // ICE servers for the runner's side of this connection, minted by the
    // server. Rides along on the offer so the runner needs no extra auth path.
    // Absent on older servers: the runner falls back to STUN.
    iceServers?: {
      urls: string | string[];
      username?: string;
      credential?: string;
    }[];
  }) => void;
  runnerAnswer: (data: {
    fromSocketId: string;
    answer: RTCSessionDescriptionInit;
  }) => void;
  runnerIceCandidate: (data: {
    fromSocketId: string;
    candidate: RTCIceCandidateInit;
  }) => void;

  // Runner: socket-relay link, the client's last resort once every WebRTC path
  // (direct, STUN, TURN) has failed. The caller asks for a
  // link; the server checks the same scope an offer gets and hands it to the
  // runner, which answers `runnerSocketOpened`. After that each data-channel
  // frame rides `runnerSocketData` through the server, in both directions. The
  // server only relays between the two ends of a link it opened.
  runnerSocketOpen: (data: {
    fromSocketId: string;
    linkId: string;
    scope: RunnerScope;
  }) => void;
  runnerSocketOpened: (data: { fromSocketId: string; linkId: string }) => void;
  runnerSocketData: (data: {
    fromSocketId: string;
    linkId: string;
    data: string;
  }) => void;
  // Either end closed the link, or its socket dropped.
  runnerSocketClose: (data: { fromSocketId: string; linkId: string }) => void;

  // Server -> client: the offer was not relayed. The server used to drop it in
  // silence, so the client waited for an answer that could never arrive and
  // reported nothing anywhere. `reason` says which gate refused it.
  runnerSignalError: (data: {
    targetSocketId: string;
    reason: 'no-session' | 'runner-offline' | 'not-shared';
  }) => void;

  // Server -> runner: space `spaceId`'s slug is now `slug` and its name `name`
  // (its name changed). The runner moves what it keeps under the old slug and
  // names the board by `name` from then on (boardRegistry.ts). `name` is absent
  // from a server older than it.
  'runner:space-renamed': (data: {
    spaceId: number;
    slug: string;
    name?: string;
  }) => void;

  // Server -> runner: the access token this connection came in with is past
  // its `exp`, so the connection is good for `runner:token-refresh` and
  // nothing else. Sent once, on connect. The runner refreshes with its refresh
  // token and reconnects.
  'runner:token-expired': () => void;

  // ── Shared runner jobs + secrets gate (.specs/runner-secrets-gate.md) ──
  // Server -> runner, sent only after the server checked that the actor is a
  // member of the space and the runner is shared there (or the actor owns it).
  // `actor` is server-vouched: the runner writes it into its audit log as is.
  // Every one of these uses a socket.io ack, so the server can answer the
  // tRPC call with what the runner said.

  /** The jobs the runner exposes for this space. */
  'runner:job-list': (
    data: { spaceSlug: string; spaceId?: number; actor: RunnerActor },
    ack: (res: RunnerAck<{ jobs: RunnerJobInfo[] }>) => void
  ) => void;
  /** Start a job by name. Never a command. The ack says whether the runner
   *  accepted it (known job, params match); progress arrives as
   *  `runner:job-log` / `runner:job-end` keyed by `callId`. */
  'runner:job-call': (
    data: RunnerJobCall,
    ack: (res: RunnerAck<{ accepted: true }>) => void
  ) => void;
  /** Optional: the runner's own view of a call, for a server that lost its
   *  buffered state (restart). */
  'runner:job-status-request': (
    data: { callId: string; afterSeq?: number },
    ack: (res: RunnerAck<RunnerJobStatus>) => void
  ) => void;
  /** Stop a running (or queued) call. The server already checked that the
   *  actor started it, owns the runner, or owns the space. `cancelled: false`
   *  = the call had already ended. The end still arrives as
   *  `runner:job-end` with state 'cancelled'. */
  'runner:job-cancel': (
    data: { callId: string; actor: RunnerActor },
    ack: (res: RunnerAck<{ cancelled: boolean }>) => void
  ) => void;
  /** An encrypted secret update from a laptop CLI. `ciphertext` is age armor
   *  to the runner's recipient: the server never sees the value. The runner
   *  parks it in its inbox and opens the gate. */
  'runner:secret-submit': (
    data: RunnerSecretSubmit,
    ack: (res: RunnerAck<{ accepted: true }>) => void
  ) => void;
  /** The runner's public age recipient (`age-recipient.txt`) for a space. */
  'runner:recipient-request': (
    data: { spaceSlug: string; spaceId?: number; actor: RunnerActor },
    ack: (res: RunnerAck<{ recipient: string }>) => void
  ) => void;
  /** A Routine is due (.todos/routines.md): open a Chat session on the board
   *  with its prompt, acting for the runner's owner. The server sends it only
   *  to the owner's own runner. The ack names the session, or why not. */
  'runner:routine-due': (
    data: RoutineDueFrame,
    ack: (res: RoutineDueAck) => void
  ) => void;
  /** Read the runner's audit log (owner only; the server checks that). */
  'runner:audit-read': (
    data: {
      spaceSlug: string;
      spaceId?: number;
      query: RunnerAuditQuery;
      actor: RunnerActor;
    },
    ack: (res: RunnerAck<RunnerAuditResult>) => void
  ) => void;
}

/** Who acted, as the server vouches for it. `userId` is the Factiii user id
 *  as a string (the runner audit log keeps ids as strings). */
export type RunnerActor = { userId: string; name: string };

/** A runner's reply to an acked event: the payload, or why it refused. */
export type RunnerAck<T> = T | { error: string };

/** The server's answer to `runner:token-refresh`: a new access token and a
 *  new refresh token (the one that was sent is replaced). `expiresAt` is the
 *  access token's end, ms since the epoch. `reconnect` is true when the
 *  connection was refresh-only (its access token had expired): the runner
 *  must connect again with the new token to come online. */
export type RunnerTokenRefresh = {
  token: string;
  expiresAt: number;
  refreshToken: string;
  reconnect: boolean;
};

/** A refusal of `runner:token-refresh`. `retry` means nothing is wrong with
 *  the token (another refresh for this runner was in flight): ask again. */
export type RunnerTokenRefreshRefusal = { error: string; retry?: true };

export type RunnerJobCall = {
  callId: string;
  spaceSlug: string;
  /** The space's id, so a runner that missed a rename finds the board by it.
   *  Absent from a server older than it. */
  spaceId?: number;
  job: string;
  params: Record<string, string>;
  actor: RunnerActor;
};

type RunnerJobStatus = {
  state: RunnerJobState;
  exitCode: number | null;
  chunks: { seq: number; text: string }[];
};

type RunnerSecretSubmit = {
  submitId: string;
  spaceSlug: string;
  spaceId?: number;
  key: string;
  kind: 'env' | 'file';
  ciphertext: string;
  actor: RunnerActor;
};

type RunnerAuditQuery = BoardAgentActionMap['auditRead']['payload'];
type RunnerAuditResult = BoardAgentActionMap['auditRead']['result'];

/** The states a call can end in. Spelled out rather than extracted from
 *  RunnerJobState so 'cancelled' is checked here whatever electron.ts has. */
export type RunnerJobEndState = 'done' | 'denied' | 'failed' | 'cancelled';

/** Runner -> server: the gate opened on a shared runner and waits for a
 *  password holder. The server turns it into a push to the space's
 *  approvers. Names only — never a value, the password or a path. */
export type RunnerGateOpen = {
  spaceSlug: string;
  requestId: string;
  actor: RunnerActor;
  job: string | null;
  keys: string[];
  /** True when the request is an inbox write (a replaced secret). */
  inbox: boolean;
};

/** A board as `runner:board-names` answers it. */
export type RunnerBoardName = { id: number; slug: string; name: string };

/** A member's dangerous job call waiting on the runner owner. Names only:
 *  the command and the params stay on the runner and reach the owner's app
 *  over its own link, never through a push. */
export type RunnerDangerousApprovalOpen = {
  spaceSlug: string;
  requestId: string;
  actor: RunnerActor;
  job: string;
};

// Who a runner connection is, and which boards they belong to. Computed
// server-side from runner ownership + board membership. The owner sees every
// board on the runner; a member is named for the boards they joined on which
// the runner reported a level for them. What the member may DO there is the
// runner's to decide, from its own grants: the scope carries no level.
// `userId` + `name` name the person on the other end of the channel, so the
// runner can write a server-vouched actor into its audit log.
export type RunnerScope =
  | { role: 'owner'; userId: string; name: string }
  | {
      role: 'member';
      spaceSlugs: string[];
      userId: string;
      name: string;
      /** An accepted peer of the owner's shared vault whom the runner let
       *  into its Vault (.specs/runner-vault.md "Sharing"). */
      vault?: boolean;
    };

// ============================================
// Client -> Server Events
// ============================================

export interface ClientToServerEvents {
  // The device id this socket uploads under (shared/all/helpers/clientId.ts).
  // Sent on connect, so the server can free that device's run when the socket
  // goes — a dropped connection is what tells it the uploader is gone.
  vaultClient: (clientId: string) => void;

  // Room Management
  joinPostStats: (postId: string) => void;
  leavePostStats: (postId: string) => void;
  joinBoardRoom: (spaceId: number) => void;
  leaveBoardRoom: (spaceId: number) => void;

  // Messaging
  typing: (conversationId: string) => void;

  // WebRTC Device Sync
  createSyncRoom: (callback: (response: CreateRoomResponse) => void) => void;
  joinSyncRoom: (
    data: { roomId: string },
    callback: (response: JoinRoomResponse) => void
  ) => void;
  leaveSyncRoom: (data: { roomId: string }) => void;
  syncOffer: (data: {
    roomId: string;
    offer: RTCSessionDescriptionInit;
  }) => void;
  syncAnswer: (data: {
    roomId: string;
    answer: RTCSessionDescriptionInit;
  }) => void;
  syncIceCandidate: (data: {
    roomId: string;
    candidate: RTCIceCandidateInit;
  }) => void;

  // Scrape Updates
  joinScrapeUpdates: () => void;
  leaveScrapeUpdates: () => void;

  // Verification (admin-only). Server-side handlers verify admin status before joining.
  joinVerificationQueue: () => void;
  leaveVerificationQueue: () => void;
  joinVerificationSession: (userId: number) => void;
  leaveVerificationSession: (userId: number) => void;

  // Runner: WebRTC signaling
  runnerOffer: (data: {
    targetSocketId: string;
    offer: RTCSessionDescriptionInit;
    /** See ServerToClientEvents.runnerOffer — one id per handshake attempt. */
    linkId?: string;
  }) => void;
  runnerAnswer: (data: {
    targetSocketId: string;
    answer: RTCSessionDescriptionInit;
  }) => void;
  runnerIceCandidate: (data: {
    targetSocketId: string;
    candidate: RTCIceCandidateInit;
  }) => void;

  // Runner: socket-relay link. See ServerToClientEvents.runnerSocketOpen.
  // `linkId` is minted by the caller, one per attempt, like an offer's.
  runnerSocketOpen: (data: { targetSocketId: string; linkId: string }) => void;
  runnerSocketOpened: (data: {
    targetSocketId: string;
    linkId: string;
  }) => void;
  runnerSocketData: (data: {
    targetSocketId: string;
    linkId: string;
    data: string;
  }) => void;
  runnerSocketClose: (data: { targetSocketId: string; linkId: string }) => void;

  // Runner → server: report which private connections are configured on this
  // host (kinds like "claude"/"git"). The FACT only — token values
  // never leave the runner machine. Sent on connect and after config changes;
  // the server persists it to the Runner row and re-broadcasts to the owner.
  runnerConnections: (data: { connections: string[] }) => void;

  // Runner → server: "I am here, on this version". Sent on connect and every
  // few minutes. The server persists it to the Runner row (`version`,
  // `heartbeatAt`), throttled. Not the online flag: that is the socket itself.
  // A runner build from before this event sends nothing, and its row keeps
  // both fields null.
  'runner:heartbeat': (data: { version: string }) => void;

  // Runner → server: "I am letting this Mac sleep" (.specs/runner-keep-awake.md
  // "Asleep, not Offline"), sent just before keep-awake lets go, with what it
  // was doing. The server keeps the snapshot on the Runner row, and when this
  // socket then drops the runner shows Asleep, not Offline, until it is back.
  // Validated server-side (runnerSleepSnapshotSchema); a bad one is dropped.
  'runner:going-to-sleep': (data: RunnerSleepSnapshot) => void;
  // Runner → server: work came back before the Mac slept, so the snapshot is
  // void. A reconnect clears it too.
  'runner:awake': () => void;

  // Runner → server: trade the runner's refresh token for a new access token
  // and a new refresh token. `refreshToken` is absent only on the first call
  // of a runner paired before refresh tokens, which the valid access token of
  // the handshake authorises. Refused for a revoked runner. A server from
  // before this event never acks, so the runner sends it with a timeout and
  // keeps its token.
  'runner:token-refresh': (
    data: { refreshToken?: string },
    ack: (res: RunnerTokenRefresh | RunnerTokenRefreshRefusal) => void
  ) => void;

  // Runner → server: "the refresh token is in my config file; I read it
  // back". Carries that token as proof; the server checks it is one of this
  // runner's chain. Never sent when the save failed.
  'runner:token-saved': (
    data: { refreshToken: string },
    ack: (res: RunnerAck<{ ok: true }>) => void
  ) => void;

  // Runner → server, on connect: the boards it keeps, by id (spaces.json) and
  // by folder slug. The server answers each one's id, slug and name now, for
  // the boards the runner's owner has joined or the runner holds member levels
  // on; anything else is left out. A board renamed while the runner was
  // offline comes back under its new slug. A server older than this never
  // acks, so the runner asks with a timeout and keeps what it has.
  'runner:board-names': (
    data: { spaceIds: number[]; spaceSlugs: string[] },
    ack: (res: RunnerAck<{ boards: RunnerBoardName[] }>) => void
  ) => void;

  // Runner → server: "I am being nuked: unpair me" (.specs/runner-setup.md
  // "Nuke a runner"). The runner's row is revoked and removed, so it leaves
  // every rail and its tokens stop working. Its other connections are cut;
  // the caller gets the ack, then is cut too. `removed: false` = there was no
  // row left to remove.
  'runner:unpair': (
    data: Record<string, never>,
    ack: (res: RunnerAck<{ removed: boolean }>) => void
  ) => void;

  // Runner → server: what this side of a handshake saw, once it settled. The
  // runner has no session of its own to call the error route with, so it hands
  // the report to the server, which writes it where the caller's report goes.
  runnerLinkReport: (data: {
    linkId: string;
    peerSocketId: string;
    outcome: 'connected' | 'failed';
    detail: string;
    // The candidate pair the link is using, for the server's per-route
    // counters: null when nothing was nominated (a failed handshake), absent
    // on a runner from before the field existed.
    pair?: IcePair | null;
  }) => void;

  // Runner → server: a card's job settled (finished, errored, or is blocked on
  // a question). The server turns this into a push to the runner's owner —
  // unless one of their clients is currently looking at that card (see
  // viewingCard). Carries no job output, just enough to write the notification
  // and deep-link back.
  runnerSessionFinished: (data: {
    spaceSlug: string;
    postId: string;
    taskTitle: string;
    phase: RunnerSessionEndPhase;
  }) => void;

  // Client → server: this client has the card's session open on screen, so a
  // job settling on it needs no push. Left on close/blur; the socket dropping
  // (backgrounded app, closed tab) clears it too, which is exactly when a push
  // IS wanted.
  viewingCard: (data: { postId: string }) => void;
  stopViewingCard: (data: { postId: string }) => void;

  // Client → server: this client has the conversation open on screen, so a
  // message arriving in it needs no push. Same lifetime rules as viewingCard:
  // left on close/minimize/blur, and dropped with the socket.
  viewingConversation: (data: { conversationId: string }) => void;
  stopViewingConversation: (data: { conversationId: string }) => void;

  // Client → server: join `conversation-<id>`, the room that carries a
  // conversation's messages, reactions, edits and thread replies. Sent by a
  // client that joins channels lazily when its user opens one, and again
  // after a reconnect. The server answers whether the socket is in the room;
  // false means the user may not read that conversation.
  joinConversation: (
    conversationId: string,
    ack: (joined: boolean) => void
  ) => void;

  // Runner -> server: shared runner job progress. `text` is already redacted
  // by the runner; the server buffers it (24h) for `runnerJobs.status`.
  'runner:job-log': (data: {
    callId: string;
    seq: number;
    text: string;
  }) => void;
  'runner:job-end': (data: {
    callId: string;
    state: RunnerJobEndState;
    exitCode: number | null;
  }) => void;
  // Runner -> server: a call changed phase before it ended (e.g. it now waits
  // on the secrets gate). The end arrives as `runner:job-end`. A secret
  // update's submitId counts as a callId here and there.
  'runner:job-state': (data: {
    callId: string;
    state: 'queued' | 'waiting-owner' | 'waiting-auth' | 'running';
  }) => void;
  // Runner -> server: the secrets gate opened on a shared runner. The server
  // pushes the space's approvers, at most once per requestId.
  'runner:gate-open': (data: RunnerGateOpen) => void;
  // Runner -> server: a member's call of a dangerous job waits for the
  // runner owner's approval. The server pushes the runner's OWNER only, at
  // most once per requestId. An older server ignores it; the call then waits
  // until the owner opens the app, or ends denied after 10 minutes.
  'runner:dangerous-approval': (data: RunnerDangerousApprovalOpen) => void;
  // Runner -> server: the level the owner gave each board member (Runner
  // Settings). Sent on connect and on every change. The server keeps the last
  // value per connected runner, shows the runner only to members with a
  // level, and refuses a non-owner job call early below the API level; the
  // runner enforces all of it too.
  // `vault`: the accounts the owner let into the runner's Vault.
  'runner:access-state': (data: { grants: RunnerGrants; vault?: string[] }) => void;
}

/**
 * The session phases worth a push. `awaiting-input` is included because it is
 * a stop — the run is parked until the user answers — and the whole point of
 * the notification is to say "this needs you now".
 *
 * The `terminal-` pair are not `CardAISessionPhase` values: a terminal holds
 * `bare-active` from the moment it opens until it is torn down, so its stops
 * are reported by the agent state instead (see `agentSettledPhase`). They ride
 * the same wire because a stop is a stop, whichever field carried it.
 */
export type RunnerSessionEndPhase =
  | 'complete'
  | 'done'
  | 'error'
  | 'awaiting-input'
  | 'bare-review'
  | 'terminal-idle'
  | 'terminal-blocked';

/**
 * What a settled job says when it announces itself. Shared so the phone's push
 * (sent by the server) and the browser notification (raised by the client off
 * its own session feed) read identically — the same event reaching you twice
 * shouldn't look like two different things.
 */
export const SESSION_END_MESSAGE: Record<RunnerSessionEndPhase, string> = {
  complete: 'changes are ready for review',
  done: 'changes pushed',
  error: 'the run hit an error',
  'awaiting-input': 'the agent has a question for you',
  'bare-review': 'terminal changes are ready for review',
  'terminal-idle': 'the terminal finished its work',
  'terminal-blocked': 'the terminal is waiting on your approval'
};

/**
 * The stop a terminal just crossed into, or null if nothing stopped.
 *
 * A terminal's phase never moves when its agent stops, so `isSessionEndPhase`
 * can't see it — the signal is the factiii plugin's agent state leaving
 * `working`. Only a transition counts: the state read at startup (a runner
 * restart, a page refresh replaying live sessions) and a terminal that was
 * already idle have both finished nothing, and neither should buzz.
 *
 * Shared by the runner (which turns it into a push) and the browser notifier,
 * so the two halves of one event can never disagree about what a stop is.
 */
export function agentSettledPhase(
  previous: AgentState | undefined,
  current: AgentState | undefined
): RunnerSessionEndPhase | null {
  if (previous !== 'working' || current === 'working') return null;
  if (current === 'idle') return 'terminal-idle';
  if (current === 'blocked') return 'terminal-blocked';
  return null;
}

/** Whether a phase is one the user should be told about. */
export function isSessionEndPhase(
  phase: string | null | undefined
): phase is RunnerSessionEndPhase {
  return Boolean(phase && phase in SESSION_END_MESSAGE);
}

// Private-connection kinds a runner can report (see reportedConnections on the
// Runner model). Open-ended by design — the server stores whatever strings the
// runner sends; the UI renders known kinds with a label/icon and falls back to
// the raw string for anything new.
export type RunnerConnectionKind = 'claude' | 'git';

// ============================================
// Inter-Server Events (for Socket.io clusters)
// ============================================

export interface InterServerEvents {
  ping: () => void;
}

// ============================================
// Socket Data (per-connection metadata)
// ============================================

/**
 * The value of the `chatRooms` handshake query a client sends to say it joins
 * channel rooms itself. A client that does not send it is joined to every
 * conversation at connect, which keeps builds from before this rule working.
 */
export const LAZY_CHAT_ROOMS = 'lazy';

export interface SocketData {
  userId?: number;
  sessionId?: number;
  /** True when the connection comes from the desktop app, read from the
   *  handshake's user agent. The desktop app raises its own notifications, so
   *  a phone push is skipped while it is the surface in use (sendAlert.ts). */
  isDesktop?: boolean;
  /** The device id this connection uploads to the vault under, if it has said
   *  so (`vaultClient`). Its disconnect is what frees that device's run. */
  vaultClientId?: string;
  /** The client joins channel rooms itself (`joinConversation`), so the
   *  server does not join them at connect. See LAZY_CHAT_ROOMS. */
  lazyChannelRooms?: boolean;
  /** Runner.id, set when the connection authenticated via a runner token. */
  runnerId?: number;
  /** Runner.name, cached from the DB row at handshake time. */
  runnerName?: string;
  /** Runner.platform, cached from the DB row at handshake time. */
  runnerPlatform?: string;
  /** The runner's last `runner:access-state` report, parsed. Undefined until
   *  it reports; lives only as long as the connection. */
  runnerGrants?: RunnerGrants;
  /** From the same report: who the owner let into the runner's Vault. */
  runnerVaultMembers?: string[];
  /** The runner sent `runner:going-to-sleep` on this connection and no
   *  `runner:awake` since: its drop is the Mac sleeping, so it shows Asleep. */
  runnerGoingToSleep?: boolean;
  /** Set INSTEAD of `runnerId` / `userId` when the runner's access token was
   *  past its `exp` and its refresh token can still be used. The connection is
   *  anonymous for every purpose except `runner:token-refresh` and
   *  `runner:token-saved`: it joins no room, is not online and receives no
   *  job. */
  runnerRefreshOnly?: { runnerId: number; userId: number };
}
