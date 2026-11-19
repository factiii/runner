import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { BoardAgentAction } from '@shared/all/domains/electron';
import {
  e2eeDeviceSigningText,
  e2eeLinkSigningText,
  sdpFingerprint,
  SECURE_VAULT_LIMITS,
  type SecureVaultDeviceAuth,
  secureVaultAuthSigningText,
  secureVaultDigestText,
  secureVaultHelloSigningText,
  secureVaultReceiptSigningText,
  VAULT_MAIL_NOT_MEMBER,
  VAULT_MAIL_OFF,
  VAULT_MAIL_UNBOUND
} from '@shared/all/domains/secureChat';
import type { VouchedScope } from '@shared/all/helpers/board-agent-core/runner-access';
import {
  secureVaultAckSchema,
  secureVaultDeliverSchema,
  secureVaultFetchSchema,
  secureVaultHelloSchema,
  secureVaultSetupSchema
} from '@shared/all/validators';

import { DEFAULT_MAIL_LIMITS, type MailLimits, type MailStore, openMailStore } from './mailStore';

// The runner's side of the Vault mailbox (.specs/secure-chat.md → Vault
// mailbox): the `mail*` actions, answered runner-wide and only on a direct
// link (MAIL_ACTIONS, relaySecretsRefusal).
//
// Who may do what:
// - `mailHello`: anyone the link admits. The runner signs the caller's nonce
//   with its mailbox key, which the owner's signed address names, so a
//   sender knows this is the Vault and not a machine our server picked. It
//   signs the two DTLS certificates of this very link with it (`bindLink`),
//   so the sender also knows nothing sits between it and the Vault: a
//   machine in the middle of the handshake shows each side its own
//   certificate, and the sender's check fails.
// - `mailDeliver`: the owner, and anyone the server vouches as in a secure
//   chat with the owner (`scope.mail`). Rate and size caps per sender
//   (mailStore.ts). Answered with a signed receipt over the ciphertexts.
// - `mailFetch`, `mailAck`: the owner's link, and on top of it one of the
//   owner's devices proving itself with its own key: the primary the owner
//   named at setup, or a device that primary link-signed. Our server vouching
//   "owner" is not enough to read or empty the mailbox.
// - `mailSetup`, `mailStatus`: the owner's link; setup is signed by the
//   primary it names. The first primary is pinned: a setup naming another
//   key is refused until someone at the runner itself forgets the pin
//   (`factiii-runner mail-reset`), so our server, which vouches "owner" and
//   carries the handshake, cannot name a phone of its own.
//
// The runner holds ciphertexts only. It cannot read one, and neither can any
// AI on it: nothing here reaches the Vault's files or database.

const KEY_FILE = 'mail.key';
const DB_FILE = 'mail.db';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

const SETTING_ENABLED = 'enabled';
const SETTING_PRIMARY = 'primary';
/** `device:<id>` holds the ed25519 key first seen under that device id. */
const SETTING_DEVICE = 'device:';
/** `device:key:<ed25519>` holds the device id that key first fetched under
 *  (forgotten with the rest of `device:` on a reset). */
const SETTING_DEVICE_KEY = 'device:key:';

type PinnedPrimary = { deviceId: number; curve25519: string; ed25519: string };

/** vodozemac's unpadded base64. */
const b64 = (buf: Buffer): string => buf.toString('base64').replace(/=+$/, '');

/** Ed25519 over the exact text, key and signature in unpadded base64. False
 *  on anything malformed (the server's verifyEd25519). */
export function verifyEd25519(publicKey: string, text: string, signature: string): boolean {
  try {
    const x = Buffer.from(publicKey, 'base64');
    const sig = Buffer.from(signature, 'base64');
    if (x.length !== 32 || sig.length !== 64) return false;
    const key = crypto.createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: x.toString('base64url') },
      format: 'jwk'
    });
    return crypto.verify(null, Buffer.from(text, 'utf8'), key, sig);
  } catch {
    return false;
  }
}

/** The mailbox key: made once, kept in `<runner dir>/mail/mail.key` for the
 *  runner user only. */
function loadMailKey(dir: string): { publicKey: string; sign: (text: string) => string } {
  const file = path.join(dir, KEY_FILE);
  let privateKey: crypto.KeyObject;
  if (fs.existsSync(file)) {
    privateKey = crypto.createPrivateKey(fs.readFileSync(file, 'utf-8'));
  } else {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    privateKey = crypto.generateKeyPairSync('ed25519').privateKey;
    fs.writeFileSync(file, privateKey.export({ format: 'pem', type: 'pkcs8' }), {
      mode: FILE_MODE
    });
  }
  const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
  return {
    publicKey: b64(Buffer.from(String(jwk.x), 'base64url')),
    sign: (text) => b64(crypto.sign(null, Buffer.from(text, 'utf8'), privateKey))
  };
}

/** Someone who comes only to deliver mail: no board level, not let into
 *  Runner Cloud. `hasOther` is the daemon's answer for those two. */
export const isMailOnly = (scope: VouchedScope, hasOther: boolean): boolean =>
  scope.role === 'member' && scope.mail === true && !hasOther;

/** Whether one more mail-only link may open, given the ones open now. */
export function mailLinkAllowed(
  open: readonly { userId: string }[],
  userId: string,
  limits: { maxMailLinks: number; maxMailLinksPerUser: number } = SECURE_VAULT_LIMITS
): boolean {
  if (open.length >= limits.maxMailLinks) return false;
  return open.filter((s) => s.userId === userId).length < limits.maxMailLinksPerUser;
}

export type DaemonMailOptions = {
  /** Tell the server "wake the owner" (`runner:mail-wake`). */
  wake: (push: boolean) => void;
  now?: () => number;
  limits?: MailLimits;
  /** Tests: `:memory:`. */
  dbFile?: string;
};

/** The session descriptions of one WebRTC link as the runner holds them:
 *  the answer it made (its own certificate) and the offer it took (the
 *  caller's). Read when a hello comes, once the answer exists. */
export type MailLinkDescriptions = () => {
  local: string | null | undefined;
  remote: string | null | undefined;
};

export type DaemonMail = {
  handle: (action: BoardAgentAction, payload: unknown, scope: VouchedScope) => unknown;
  /** Names the link a scope came in on (the daemon makes one scope object
   *  per link). `mailHello` on a scope never bound is refused. */
  bindLink: (scope: VouchedScope, descriptions: MailLinkDescriptions) => void;
  /** Whether the owner has delivery on (a mail-only link is refused off). */
  enabled: () => boolean;
  close: () => void;
};

const NOT_AVAILABLE =
  'This runner cannot hold a mailbox: it needs Node 22.13 or newer. Update Node on the runner.';
const OWNER_ONLY = 'Only the owner of this Vault reads its mailbox.';
const BAD_DEVICE = 'This device is not one of the Vault owner’s devices.';
const OTHER_PRIMARY =
  'This Vault’s mailbox answers to another phone. On the runner, run "factiii-runner mail-reset", then turn Vault delivery on again.';

/** A new phone: forgets the pinned primary and every device id's key, so
 *  the next `mailSetup` pins again. Only someone at the runner can. Waiting
 *  mail and the mailbox key stay. False when there is no mailbox. */
export function resetMailPrimary(runnerDir: string): boolean {
  const file = path.join(runnerDir, 'mail', DB_FILE);
  const store = fs.existsSync(file) ? openMailStore(file) : null;
  if (!store) return false;
  store.deleteSettings(SETTING_PRIMARY);
  store.deleteSettings(SETTING_DEVICE);
  store.close();
  return true;
}

export function createDaemonMail(
  runnerDir: string,
  ownerUserId: string | null,
  options: DaemonMailOptions
): DaemonMail {
  const dir = path.join(runnerDir, 'mail');
  const now = options.now ?? Date.now;
  const limits = options.limits ?? DEFAULT_MAIL_LIMITS;
  const ownerId = Number(ownerUserId);
  let store: MailStore | null | undefined;
  let key: ReturnType<typeof loadMailKey> | null = null;
  const links = new WeakMap<VouchedScope, MailLinkDescriptions>();

  /** Opened on first use: a runner whose owner never turns Vault delivery
   *  on makes no file. */
  const open = (): MailStore => {
    if (store === undefined) {
      store = openMailStore(options.dbFile ?? path.join(dir, DB_FILE), limits, now);
      store?.sweep();
    }
    if (!store) throw new Error(NOT_AVAILABLE);
    return store;
  };
  const exists = () => options.dbFile !== undefined || fs.existsSync(path.join(dir, DB_FILE));
  const mailKey = () => (key ??= loadMailKey(dir));
  const isEnabled = () => {
    if (!exists()) return false;
    try {
      return open().getSetting(SETTING_ENABLED) === '1';
    } catch {
      return false;
    }
  };
  const pinned = (): PinnedPrimary | null => {
    const raw = open().getSetting(SETTING_PRIMARY);
    return raw ? (JSON.parse(raw) as PinnedPrimary) : null;
  };

  const sweeper = setInterval(() => {
    try {
      if (exists()) open().sweep();
    } catch {
      // The next sweep tries again.
    }
  }, SECURE_VAULT_LIMITS.sweepEveryMs);
  sweeper.unref();

  const requireOwner = (scope: VouchedScope) => {
    if (scope.role !== 'owner' || !Number.isSafeInteger(ownerId) || ownerId <= 0) {
      throw new Error(OWNER_ONLY);
    }
  };

  const fresh = (at: number) => Math.abs(now() - at) <= SECURE_VAULT_LIMITS.authSkewMs;

  /** The device behind a fetch or an ack: the pinned primary, or a device
   *  it link-signed, proved by a fresh signature of its own. The link
   *  signature covers the device id with the keys, so a linked device can
   *  name only the id the primary signed for it. Kept as a second check
   *  (a server that lied to the phone about an id at link time): a linked
   *  device never names the primary's device id, a device id answers to
   *  the first key seen under it, and a key answers to one device id. */
  const deviceOf = (auth: SecureVaultDeviceAuth, action: 'fetch' | 'ack'): number => {
    const primary = pinned();
    if (!primary || !fresh(auth.at)) throw new Error(BAD_DEVICE);
    const signed = verifyEd25519(
      auth.ed25519,
      secureVaultAuthSigningText(ownerId, auth.deviceId, mailKey().publicKey, action, auth.at),
      auth.signature
    );
    if (!signed) throw new Error(BAD_DEVICE);
    const isPrimary =
      auth.deviceId === primary.deviceId &&
      auth.ed25519 === primary.ed25519 &&
      auth.curve25519 === primary.curve25519;
    const isLinked =
      !!auth.linkSignature &&
      verifyEd25519(
        primary.ed25519,
        e2eeLinkSigningText(ownerId, auth.deviceId, auth.curve25519, auth.ed25519),
        auth.linkSignature
      );
    if (!isPrimary && !isLinked) throw new Error(BAD_DEVICE);
    if (!isPrimary) {
      if (auth.deviceId === primary.deviceId) throw new Error(BAD_DEVICE);
      const mail = open();
      const known = mail.getSetting(SETTING_DEVICE + auth.deviceId);
      if (known && known !== auth.ed25519) throw new Error(BAD_DEVICE);
      const id = mail.getSetting(SETTING_DEVICE_KEY + auth.ed25519);
      if (id && id !== String(auth.deviceId)) throw new Error(BAD_DEVICE);
      if (!known) mail.setSetting(SETTING_DEVICE + auth.deviceId, auth.ed25519);
      if (!id) mail.setSetting(SETTING_DEVICE_KEY + auth.ed25519, String(auth.deviceId));
    }
    return auth.deviceId;
  };

  const handle = (action: BoardAgentAction, payload: unknown, scope: VouchedScope): unknown => {
    const isOwner = scope.role === 'owner';
    const mayDeliver = isOwner || (scope.role === 'member' && scope.mail === true);
    switch (action) {
      case 'mailHello': {
        if (!mayDeliver) throw new Error(VAULT_MAIL_NOT_MEMBER);
        const { nonce } = secureVaultHelloSchema.parse(payload);
        const descriptions = links.get(scope)?.();
        const runner = sdpFingerprint(descriptions?.local);
        const peer = sdpFingerprint(descriptions?.remote);
        if (!runner || !peer) throw new Error(VAULT_MAIL_UNBOUND);
        const { publicKey, sign } = mailKey();
        return {
          ownerUserId: ownerId,
          mailKey: publicKey,
          signature: sign(secureVaultHelloSigningText(ownerId, nonce, { runner, peer })),
          enabled: isEnabled()
        };
      }
      case 'mailSetup': {
        requireOwner(scope);
        const input = secureVaultSetupSchema.parse(payload);
        const { primary } = input;
        const { publicKey } = mailKey();
        const valid =
          input.userId === ownerId &&
          fresh(input.at) &&
          verifyEd25519(
            primary.ed25519,
            e2eeDeviceSigningText(ownerId, primary.curve25519, primary.ed25519),
            input.primarySignature
          ) &&
          verifyEd25519(
            primary.ed25519,
            secureVaultAuthSigningText(ownerId, primary.deviceId, publicKey, 'setup', input.at),
            input.signature
          );
        if (!valid) throw new Error(BAD_DEVICE);
        const mail = open();
        const held = pinned();
        if (held && held.ed25519 !== primary.ed25519) throw new Error(OTHER_PRIMARY);
        mail.setSetting(SETTING_PRIMARY, JSON.stringify(primary));
        mail.setSetting(SETTING_ENABLED, input.enabled ? '1' : '0');
        return { mailKey: publicKey, enabled: input.enabled };
      }
      case 'mailDeliver': {
        if (!mayDeliver) throw new Error(VAULT_MAIL_NOT_MEMBER);
        if (!isEnabled()) throw new Error(VAULT_MAIL_OFF);
        const input = secureVaultDeliverSchema.parse(payload);
        const senderUserId = Number(scope.userId);
        if (!Number.isSafeInteger(senderUserId) || senderUserId <= 0) {
          throw new Error(VAULT_MAIL_NOT_MEMBER);
        }
        // Outside a chat (link history) only the owner's own devices send.
        if (!input.chatId && !isOwner) throw new Error(VAULT_MAIL_NOT_MEMBER);
        const stored = open().deliver({
          senderUserId,
          senderDeviceId: input.senderDeviceId,
          senderCurve25519: input.senderCurve25519,
          deliveryId: input.deliveryId,
          chatId: input.chatId ?? null,
          envelopes: input.envelopes
        });
        // The owner's own device sent it: their other devices are pinged,
        // nobody is pushed.
        options.wake(input.notify && !isOwner);
        const digest = crypto
          .createHash('sha256')
          .update(secureVaultDigestText(input.envelopes), 'utf8')
          .digest('hex');
        return {
          stored,
          receipt: mailKey().sign(
            secureVaultReceiptSigningText(ownerId, input.deliveryId, digest)
          )
        };
      }
      case 'mailFetch': {
        requireOwner(scope);
        const input = secureVaultFetchSchema.parse(payload);
        const deviceId = deviceOf(input.auth, 'fetch');
        return open().fetch(deviceId, input.cursor);
      }
      case 'mailAck': {
        requireOwner(scope);
        const input = secureVaultAckSchema.parse(payload);
        const deviceId = deviceOf(input.auth, 'ack');
        return { deleted: open().ack(deviceId, input.ids) };
      }
      case 'mailStatus': {
        requireOwner(scope);
        if (!exists()) {
          return { available: true, enabled: false, mailKey: null, waiting: 0, bytes: 0 };
        }
        let mail: MailStore;
        try {
          mail = open();
        } catch {
          return { available: false, enabled: false, mailKey: null, waiting: 0, bytes: 0 };
        }
        return {
          available: true,
          enabled: mail.getSetting(SETTING_ENABLED) === '1',
          mailKey: mailKey().publicKey,
          ...mail.stats()
        };
      }
      default:
        throw new Error(`"${action}" is not a mailbox action.`);
    }
  };

  return {
    handle,
    bindLink: (scope, descriptions) => {
      links.set(scope, descriptions);
    },
    enabled: isEnabled,
    close: () => {
      clearInterval(sweeper);
      store?.close();
      store = undefined;
    }
  };
}
