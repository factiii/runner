// Secure chat (.specs/secure-chat.md): the Signal-model encrypted chat. The
// wire formats the server, the engine and both clients agree on. Nothing here
// encrypts: Olm (vodozemac, packages/e2ee-core) does, one ciphertext per
// recipient device. The server relays each one and deletes it on ack.

export const SECURE_LIMITS = {
  /** Members in one secure chat (pairwise encryption, no Sender Keys yet). */
  maxMembers: 50,
  /** Linked devices (web, desktop) per user, besides the primary phone. */
  maxLinkedDevices: 5,
  /** Envelopes in one `secure.send`: members x their devices, plus mine. */
  maxEnvelopesPerSend: 400,
  /** One Olm ciphertext, base64. A chat message, not a file. */
  maxEnvelopeBytes: 65_536,
  /** A mailbox row never collected is deleted after this (Signal: P30D). */
  mailboxTtlMs: 30 * 24 * 60 * 60 * 1000,
  /** A link QR's token lives this long. */
  linkTokenTtlMs: 10 * 60 * 1000,
  /** History the phone sends a newly linked device, per chat. */
  linkHistoryMs: 30 * 24 * 60 * 60 * 1000,
  /** Messages in one link-history event. */
  linkHistoryChunk: 100,
  /** A message body, in characters. */
  maxBodyChars: 10_000,
  /** One-time keys a device may hold on the server. */
  maxOneTimeKeys: 100,
  /** Keep this many uploaded; top up below half of it. */
  targetOneTimeKeys: 50
} as const;

export type SecureChatKind = 'DM' | 'GROUP';
export type SecureMemberRole = 'ADMIN' | 'MEMBER';
export type SecureDeviceKind = 'PRIMARY' | 'LINKED';

/** The QR a browser shows to be linked: `factiii-link:v1:<linkToken>`. */
export const SECURE_LINK_QR_PREFIX = 'factiii-link:v1:';
export const encodeLinkQr = (linkToken: string): string =>
  SECURE_LINK_QR_PREFIX + linkToken;
export function parseLinkQr(text: string): string | null {
  if (!text.startsWith(SECURE_LINK_QR_PREFIX)) return null;
  const token = text.slice(SECURE_LINK_QR_PREFIX.length);
  return /^[A-Za-z0-9_-]{32,128}$/.test(token) ? token : null;
}

/**
 * The exact text a device signs over its own keys, and the server and the
 * peers verify. Versioned and labelled so a signature cannot be replayed as
 * a signature of anything else.
 */
export const e2eeDeviceSigningText = (
  userId: number,
  curve25519: string,
  ed25519: string
): string => `factiii-e2ee-device:v1|${userId}|${curve25519}|${ed25519}`;

/** The text a device signs over each one-time or fallback key it uploads. */
export const e2eeKeySigningText = (
  userId: number,
  curve25519: string,
  keyId: string,
  publicKey: string,
  fallback: boolean
): string =>
  `factiii-e2ee-${fallback ? 'fallback' : 'otk'}:v1|${userId}|${curve25519}|${keyId}|${publicKey}`;

/**
 * The text a user's primary device signs over a linked device's keys. A
 * client trusts a linked device only with this signature by the user's
 * current primary (the trust rule in .specs/secure-chat.md → Devices).
 */
export const e2eeLinkSigningText = (
  userId: number,
  curve25519: string,
  ed25519: string
): string => `factiii-e2ee-link:v1|${userId}|${curve25519}|${ed25519}`;

// ── Events: the plaintext inside one Olm ciphertext ─────────────────────────

interface SecureEventBase {
  v: 1;
  /** Client-made uuid. A message's id is its id everywhere, on every device. */
  id: string;
  chatId: string;
  /** ISO time on the sender's device. */
  sentAt: string;
  /** The sender. The receiver checks both against the Olm session it came
   *  on and the server's senderUserId/senderDeviceId. */
  userId: number;
  deviceId: number;
}

export interface SecureMessageEvent extends SecureEventBase {
  t: 'message';
  body: string;
  /** The id of the message this replies to. */
  replyTo?: string;
}

export interface SecureEditEvent extends SecureEventBase {
  t: 'edit';
  messageId: string;
  body: string;
}

export interface SecureDeleteEvent extends SecureEventBase {
  t: 'delete';
  messageId: string;
}

export interface SecureReactionEvent extends SecureEventBase {
  t: 'reaction';
  messageId: string;
  emoji: string;
  /** false = remove my reaction. */
  add: boolean;
}

export interface SecureReadEvent extends SecureEventBase {
  t: 'read';
  /** Everything up to and including this message is read. */
  messageId: string;
}

/** Members or name changed: re-read `secure.chat` (the server is the source
 *  of truth for membership). */
export interface SecureChatChangedEvent extends SecureEventBase {
  t: 'chat';
}

/** A message as the phone sends it to a newly linked device. */
export interface SecureHistoryMessage {
  id: string;
  userId: number;
  deviceId: number;
  sentAt: string;
  body: string;
  replyTo?: string;
  editedAt?: string;
  deletedAt?: string;
  reactions?: { userId: number; emoji: string }[];
}

/** Phone → a newly linked device of the same user. `chatId` is the chat the
 *  chunk belongs to. */
export interface SecureLinkHistoryEvent extends SecureEventBase {
  t: 'link-history';
  messages: SecureHistoryMessage[];
}

/** Phone → a newly linked device: history is complete. `chatId` is ''. */
export interface SecureLinkDoneEvent extends SecureEventBase {
  t: 'link-done';
}

export type SecureEvent =
  | SecureMessageEvent
  | SecureEditEvent
  | SecureDeleteEvent
  | SecureReactionEvent
  | SecureReadEvent
  | SecureChatChangedEvent
  | SecureLinkHistoryEvent
  | SecureLinkDoneEvent;

export type SecureEventType = SecureEvent['t'];

// ── Router inputs (shared/all/validators/secureChat.ts validates them) ──────

/** One Olm ciphertext for one device. `type` is Olm's message type (0 =
 *  pre-key, 1 = normal). */
export interface SecureEnvelopeInput {
  deviceId: number;
  type: 0 | 1;
  body: string;
}

/** `secure.send`. `chatId` is omitted only for link-history/link-done, which
 *  may go only to the sender's own devices. */
export interface SecureSendInput {
  senderDeviceId: number;
  chatId?: string;
  envelopes: SecureEnvelopeInput[];
  /** Push the recipients ("New encrypted message"). False for edits,
   *  reactions, reads and link events. */
  notify: boolean;
}

/** A mailbox row as `secure.fetch` returns it. */
export interface SecureMailboxRow {
  id: number;
  senderUserId: number;
  senderDeviceId: number;
  senderCurve25519: string;
  chatId: string | null;
  type: 0 | 1;
  body: string;
  createdAt: string;
}

/** What the push and any server-made preview says. */
export const SECURE_PREVIEW = 'New encrypted message';
