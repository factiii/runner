// End-to-end encrypted chat (.specs/chat-e2ee.md): the wire formats the
// server and the clients agree on. Nothing here encrypts: the cryptography is
// vodozemac's, behind packages/e2ee-core. These are the shapes around it.

/** Prefix of an encrypted message's stored content. */
export const E2EE_ENVELOPE_PREFIX = 'e2ee:v1:';

/** What the server stores and relays for one encrypted message. Opaque to
 *  it except for the two ids, which route decryption. */
export interface E2eeEnvelope {
  /** Megolm session id. */
  s: string;
  /** The sending E2eeDevice.id. The server checks it is the sender's. */
  d: number;
  /** Megolm ciphertext, base64. */
  c: string;
}

/** An envelope over this size is refused: a chat message, not a file. */
export const E2EE_ENVELOPE_MAX = 65_536;

export const encodeEnvelope = (envelope: E2eeEnvelope): string =>
  E2EE_ENVELOPE_PREFIX + JSON.stringify(envelope);

export function parseEnvelope(content: string): E2eeEnvelope | null {
  if (!content.startsWith(E2EE_ENVELOPE_PREFIX)) return null;
  try {
    const value: unknown = JSON.parse(
      content.slice(E2EE_ENVELOPE_PREFIX.length)
    );
    if (!value || typeof value !== 'object') return null;
    const { s, d, c } = value as Record<string, unknown>;
    if (typeof s !== 'string' || !/^[A-Za-z0-9+/=]{1,128}$/.test(s))
      return null;
    if (typeof d !== 'number' || !Number.isInteger(d) || d <= 0) return null;
    if (typeof c !== 'string' || !/^[A-Za-z0-9+/=]{1,}$/.test(c)) return null;
    return { s, d, c };
  } catch {
    return null;
  }
}

/** What an encrypted message shows where the server would show its text: the
 *  conversation list, a push, the desktop notification. */
export const E2EE_PREVIEW = 'Encrypted message';

/** The plaintext inside a Megolm message. The conversation id is inside the
 *  encryption, so the server cannot move a message to another chat. */
export interface E2eeMessagePayload {
  v: 1;
  conversationId: string;
  body: string;
}

/** The plaintext inside an Olm to-device message: a Megolm room key. */
export interface E2eeRoomKeyPayload {
  type: 'room_key';
  v: 1;
  conversationId: string;
  sessionId: string;
  sessionKey: string;
  /** The device that owns the outbound session. The receiver checks the Olm
   *  session it arrived on belongs to this device. */
  senderDeviceId: number;
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

export const E2EE_LIMITS = {
  /** One-time keys a device may hold on the server. */
  maxOneTimeKeys: 100,
  /** Keep this many uploaded; top up below it. */
  targetOneTimeKeys: 50,
  /** To-device messages in one send. */
  maxToDevicePerSend: 100,
  /** Rotate the outbound Megolm session after this many messages. */
  rotateAfterMessages: 100,
  /** ... or after this long. */
  rotateAfterMs: 7 * 24 * 60 * 60 * 1000,
  /** To-device rows nobody collected are dropped after this long. */
  toDeviceTtlDays: 30
} as const;
