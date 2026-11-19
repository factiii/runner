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
 * The text a user's primary device signs over a linked device's id and
 * keys. A client trusts a linked device only with this signature by the
 * user's current primary (the trust rule in .specs/secure-chat.md →
 * Devices). The id is in it (v2) so a linked device cannot name another
 * device's id, to a peer or to a Vault mailbox.
 */
export const e2eeLinkSigningText = (
  userId: number,
  deviceId: number,
  curve25519: string,
  ed25519: string
): string =>
  `factiii-e2ee-link:v2|${userId}|${deviceId}|${curve25519}|${ed25519}`;

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

/** Phone → my linked devices: my mail left this Vault (delivery was turned
 *  off, or moved to another runner). A linked device that was offline for
 *  the whole time delivery was on never saw that address, and rows may wait
 *  for it there: it reads that Vault until `until` (ms). `chatId` is ''. */
export interface SecureVaultMovedEvent extends SecureEventBase {
  t: 'vault-moved';
  runnerId: number;
  mailKey: string;
  until: number;
}

export type SecureEvent =
  | SecureMessageEvent
  | SecureEditEvent
  | SecureDeleteEvent
  | SecureReactionEvent
  | SecureReadEvent
  | SecureChatChangedEvent
  | SecureLinkHistoryEvent
  | SecureLinkDoneEvent
  | SecureVaultMovedEvent;

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

// ── Vault mailbox (.specs/secure-chat.md → Vault mailbox) ───────────────────
// A person who turns on Vault delivery gets every secure chat message through
// their own runner. The sender's device hands the ciphertexts to the runner
// over WebRTC; our server holds none of them, not even in passing. It keeps
// only the signed address below, the WebRTC handshake and contentless wakes.

export const SECURE_VAULT_LIMITS = {
  /** Envelopes in one delivery: one Vault user's devices (their primary and
   *  linked ones). */
  maxEnvelopesPerDeliver: SECURE_LIMITS.maxLinkedDevices + 1,
  /** Deliveries one sender may make to one Vault in `rateWindowMs`. */
  maxDeliveriesPerWindow: 600,
  /** Ciphertext bytes (base64) one sender may deliver in `rateWindowMs`. */
  maxBytesPerWindow: 8 * 1024 * 1024,
  rateWindowMs: 10 * 60 * 1000,
  /** Rows one sender may have waiting in one Vault. */
  maxRowsPerSender: 5_000,
  /** Ciphertext bytes (base64) the whole mailbox may hold. */
  maxMailboxBytes: 256 * 1024 * 1024,
  /** Links open at once from people who come only to deliver mail. */
  maxMailLinks: 50,
  /** The same, from one person (their phone and a few browsers). */
  maxMailLinksPerUser: 4,
  /** A row never collected is deleted after this, as the server's mailbox. */
  mailboxTtlMs: SECURE_LIMITS.mailboxTtlMs,
  /** How often the runner sweeps expired rows. */
  sweepEveryMs: 60 * 60 * 1000,
  /** Rows in one fetch page. */
  fetchPage: 200,
  /** A device's fetch or ack signature is good this long either side of the
   *  runner's clock. */
  authSkewMs: 5 * 60 * 1000,
  /** Wakes one runner may ask the server for in a minute. */
  maxWakesPerMinute: 120
} as const;

/**
 * Where a person's secure chat mail goes: their Vault (`runnerId` and the
 * runner's mailbox key) or, with both null, our server's mailbox. Signed by
 * the person's primary device, so our server cannot point a Vault user's
 * mail at itself or at another runner. `version` only goes up: a sender
 * refuses an older one than it has seen.
 */
export interface SecureVaultAddress {
  userId: number;
  version: number;
  runnerId: number | null;
  /** The runner's mailbox key (Ed25519, unpadded base64): the runner proves
   *  it holds it when a sender connects and when it takes a delivery. */
  mailKey: string | null;
  /** The primary's signature over secureVaultAddressSigningText. */
  signature: string;
  signedByDeviceId: number;
}

/** The exact text the primary signs for its person's Vault address. */
export const secureVaultAddressSigningText = (
  userId: number,
  version: number,
  runnerId: number | null,
  mailKey: string | null
): string =>
  `factiii-vault-address:v1|${userId}|${version}|${runnerId ?? 'server'}|${mailKey ?? ''}`;

/** The DTLS certificate fingerprint a session description names
 *  (`a=fingerprint:sha-256 AB:CD:…`), as `sha-256 AB:CD:…`. Null when it
 *  names none, or names two that differ. WebRTC refuses a DTLS handshake
 *  whose certificate does not match the description it was given, so this
 *  is the certificate at that end of the link. */
export function sdpFingerprint(sdp: string | null | undefined): string | null {
  const found = new Set<string>();
  for (const [, algorithm, value] of (sdp ?? '').matchAll(
    /^a=fingerprint:(\S+)[ \t]+([0-9A-Fa-f:]+)[ \t]*\r?$/gm
  )) {
    if (algorithm && value) {
      found.add(`${algorithm.toLowerCase()} ${value.toUpperCase()}`);
    }
  }
  const [only] = [...found];
  return found.size === 1 && only ? only : null;
}

/** The two certificates of one link to a Vault, each as sdpFingerprint
 *  gives it: the runner's, and that of the device that dialled. */
export interface SecureVaultLinkPrints {
  runner: string;
  peer: string;
}

/** The text a runner signs with its mailbox key when a device says hello:
 *  it is the Vault the address names, for this owner, now (`nonce`), **on
 *  this link**. Each side fills `link` from what its own WebRTC stack was
 *  given: the runner signs its own certificate and the caller's as it took
 *  it from the offer, and the device checks the signature against the
 *  certificate in the answer it took and its own. Someone in the middle of
 *  the handshake (our server is the one that could be) has to give each
 *  side a certificate of its own, so the two never agree and the hello does
 *  not verify. v1 signed the nonce alone. */
export const secureVaultHelloSigningText = (
  ownerUserId: number,
  nonce: string,
  link: SecureVaultLinkPrints
): string =>
  `factiii-vault-hello:v2|${ownerUserId}|${nonce}|${link.runner}|${link.peer}`;

/** The text a runner signs once it has stored a delivery: `digest` is
 *  secureVaultDigestText's SHA-256 (hex), so a receipt is for exactly these
 *  ciphertexts. */
export const secureVaultReceiptSigningText = (
  ownerUserId: number,
  deliveryId: string,
  digest: string
): string => `factiii-vault-receipt:v1|${ownerUserId}|${deliveryId}|${digest}`;

/** What a delivery's digest is taken over: every envelope, in order. */
export const secureVaultDigestText = (
  envelopes: readonly SecureEnvelopeInput[]
): string => envelopes.map((e) => `${e.deviceId}:${e.type}:${e.body}`).join('\n');

/** The text a recipient's device signs to read or empty its Vault mailbox.
 *  Bound to the runner's key, the action and the time. */
export const secureVaultAuthSigningText = (
  userId: number,
  deviceId: number,
  mailKey: string,
  action: 'fetch' | 'ack' | 'setup',
  at: number
): string =>
  `factiii-vault-auth:v1|${userId}|${deviceId}|${mailKey}|${action}|${at}`;

/** A recipient's device, as it proves itself to its own Vault. */
export interface SecureVaultDeviceAuth {
  deviceId: number;
  curve25519: string;
  ed25519: string;
  /** A linked device: the primary's link signature (e2eeLinkSigningText). */
  linkSignature?: string;
  /** ms, the device's clock. */
  at: number;
  /** The device's signature over secureVaultAuthSigningText. */
  signature: string;
}

/** `mailHello`: the runner proves it is the Vault. */
export interface SecureVaultHello {
  payload: { nonce: string };
  result: {
    ownerUserId: number;
    mailKey: string;
    signature: string;
    /** Whether the owner has Vault delivery on at this runner. */
    enabled: boolean;
  };
}

/** `mailSetup`: the owner's primary turns Vault delivery on or off here and
 *  names itself (the runner checks later fetches against it). */
export interface SecureVaultSetup {
  payload: {
    userId: number;
    enabled: boolean;
    primary: { deviceId: number; curve25519: string; ed25519: string };
    /** The primary's self-signature over e2eeDeviceSigningText. */
    primarySignature: string;
    at: number;
    /** The primary's signature over secureVaultAuthSigningText('setup'). */
    signature: string;
  };
  result: { mailKey: string; enabled: boolean };
}

/** `mailDeliver`: ciphertexts for the owner's devices. */
export interface SecureVaultDeliver {
  payload: {
    /** Client-made, random: the receipt names it. */
    deliveryId: string;
    senderDeviceId: number;
    senderCurve25519: string;
    chatId?: string;
    envelopes: SecureEnvelopeInput[];
    notify: boolean;
  };
  result: { stored: number; receipt: string };
}

export interface SecureVaultFetch {
  payload: { auth: SecureVaultDeviceAuth; cursor?: number };
  result: { rows: SecureMailboxRow[]; nextCursor: number | null };
}

export interface SecureVaultAck {
  payload: { auth: SecureVaultDeviceAuth; ids: number[] };
  result: { deleted: number };
}

/** `mailStatus` (owner): what the settings screen shows. */
export interface SecureVaultStatus {
  payload: Record<string, never>;
  result: {
    /** False on a runner whose Node has no SQLite (older than 22.13). */
    available: boolean;
    enabled: boolean;
    mailKey: string | null;
    waiting: number;
    bytes: number;
  };
}

/** Why a runner refused mail, in words the sender's outbox can act on. */
export const VAULT_MAIL_OFF = 'This Vault is not taking messages.';
export const VAULT_MAIL_NOT_MEMBER =
  'This Vault takes messages only from people in a chat with its owner.';
export const VAULT_MAIL_BUSY =
  'This Vault is taking too many messages right now. Try again soon.';
export const VAULT_MAIL_FULL = 'This Vault’s mailbox is full.';
/** No certificate fingerprints could be read for a link, at either end. */
export const VAULT_MAIL_UNBOUND =
  'This link cannot be checked against the Vault’s key, so no mail goes over it.';
/** The server's refusal of a mailbox row for a Vault user. */
export const SECURE_VAULT_ONLY =
  'This person’s messages go only through their Vault.';
