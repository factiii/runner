import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  e2eeDeviceSigningText,
  e2eeLinkSigningText,
  type SecureVaultDeviceAuth,
  secureVaultAuthSigningText,
  secureVaultDigestText,
  secureVaultHelloSigningText,
  secureVaultReceiptSigningText,
  VAULT_MAIL_NOT_MEMBER,
  VAULT_MAIL_OFF,
  VAULT_MAIL_UNBOUND
} from '@shared/all/domains/secureChat';
import { MAIL_ACTIONS, relaySecretsRefusal } from '@shared/all/helpers/board-agent-core/runner-access';
import type { VouchedScope } from '@shared/all/helpers/board-agent-core/runner-access';

import {
  createDaemonMail,
  isMailOnly,
  mailLinkAllowed,
  resetMailPrimary,
  verifyEd25519
} from './daemonMail';

// The runner's Vault mailbox (.specs/secure-chat.md → Vault mailbox): who may
// deliver, who may read and empty it, and what the runner proves to a sender.

const OWNER_ID = 42;
const b64 = (buf: Buffer) => buf.toString('base64').replace(/=+$/, '');

function makeDevice(deviceId: number) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const ed25519 = b64(Buffer.from(String(publicKey.export({ format: 'jwk' }).x), 'base64url'));
  const curve25519 = b64(crypto.randomBytes(32));
  const sign = (text: string) => b64(crypto.sign(null, Buffer.from(text), privateKey));
  return { deviceId, ed25519, curve25519, sign };
}

const owner: VouchedScope = { role: 'owner', userId: String(OWNER_ID), name: 'Owner' };
const peer = (userId: number): VouchedScope => ({
  role: 'member',
  spaceSlugs: [],
  userId: String(userId),
  name: 'Peer',
  mail: true
});
const stranger: VouchedScope = { role: 'member', spaceSlugs: ['board'], userId: '9', name: 'S' };

/** One link's two session descriptions, as WebRTC writes the certificate. */
const sdp = (fingerprint: string) =>
  `v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 ${fingerprint}\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n`;
const RUNNER_CERT = 'AA:BB:CC:01';
const CALLER_CERT = 'DD:EE:FF:02';
const LINK = { runner: `sha-256 ${RUNNER_CERT}`, peer: `sha-256 ${CALLER_CERT}` };
const onLink = () => ({ local: sdp(RUNNER_CERT), remote: sdp(CALLER_CERT.toLowerCase()) });

const dirs: string[] = [];
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-mail-'));
  dirs.push(dir);
  const wakes: boolean[] = [];
  const clock = { now: Date.now() };
  const mail = createDaemonMail(dir, String(OWNER_ID), {
    wake: (push) => wakes.push(push),
    now: () => clock.now
  });
  mail.bindLink(owner, onLink);
  const hello = mail.handle('mailHello', { nonce: 'n'.repeat(24) }, owner) as {
    mailKey: string;
    signature: string;
    enabled: boolean;
  };
  const primary = makeDevice(1);
  const turn = (enabled: boolean, by = primary, at = clock.now) =>
    mail.handle(
      'mailSetup',
      {
        userId: OWNER_ID,
        enabled,
        primary: { deviceId: by.deviceId, curve25519: by.curve25519, ed25519: by.ed25519 },
        primarySignature: by.sign(e2eeDeviceSigningText(OWNER_ID, by.curve25519, by.ed25519)),
        at,
        signature: by.sign(
          secureVaultAuthSigningText(OWNER_ID, by.deviceId, hello.mailKey, 'setup', at)
        )
      },
      owner
    );
  const auth = (
    device: ReturnType<typeof makeDevice>,
    action: 'fetch' | 'ack',
    extra: Partial<SecureVaultDeviceAuth> = {}
  ): SecureVaultDeviceAuth => ({
    deviceId: device.deviceId,
    curve25519: device.curve25519,
    ed25519: device.ed25519,
    at: clock.now,
    signature: device.sign(
      secureVaultAuthSigningText(OWNER_ID, device.deviceId, hello.mailKey, action, clock.now)
    ),
    ...extra
  });
  const deliver = (scope: VouchedScope, deviceIds: number[], chatId: string | undefined = 'c1') =>
    mail.handle(
      'mailDeliver',
      {
        deliveryId: 'd'.repeat(24),
        senderDeviceId: 500,
        senderCurve25519: b64(crypto.randomBytes(32)),
        ...(chatId && { chatId }),
        envelopes: deviceIds.map((deviceId) => ({ deviceId, type: 1, body: 'QUJD' })),
        notify: true
      },
      scope
    ) as { stored: number; receipt: string };
  return { mail, dir, wakes, clock, hello, primary, turn, auth, deliver };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('daemon mail', () => {
  it('proves it is the Vault: the hello and the receipt verify under its key', () => {
    const t = setup();
    assert.ok(
      verifyEd25519(
        t.hello.mailKey,
        secureVaultHelloSigningText(OWNER_ID, 'n'.repeat(24), LINK),
        t.hello.signature
      )
    );
    assert.equal(t.hello.enabled, false);
    t.turn(true);
    const { stored, receipt } = t.deliver(peer(7), [1]);
    assert.equal(stored, 1);
    const digest = crypto
      .createHash('sha256')
      .update(secureVaultDigestText([{ deviceId: 1, type: 1, body: 'QUJD' }]))
      .digest('hex');
    assert.ok(
      verifyEd25519(
        t.hello.mailKey,
        secureVaultReceiptSigningText(OWNER_ID, 'd'.repeat(24), digest),
        receipt
      )
    );
    // The same key after a restart: the signed address stays good.
    t.mail.close();
    const again = createDaemonMail(t.dir, String(OWNER_ID), { wake: () => undefined });
    again.bindLink(owner, onLink);
    const hello = again.handle('mailHello', { nonce: 'x'.repeat(24) }, owner) as {
      mailKey: string;
      enabled: boolean;
    };
    assert.equal(hello.mailKey, t.hello.mailKey);
    assert.equal(hello.enabled, true);
    again.close();
  });

  it('signs the hello for one link: its own certificate and the caller’s, or nothing', () => {
    const t = setup();
    const nonce = 'm'.repeat(24);
    const hello = (scope: VouchedScope) =>
      (t.mail.handle('mailHello', { nonce }, scope) as { signature: string }).signature;
    // Someone in the middle shows the runner a certificate of its own: the
    // runner signs what it was shown, which is not what the sender holds.
    const relayed = peer(7);
    t.mail.bindLink(relayed, () => ({ local: sdp(RUNNER_CERT), remote: sdp('99:99:99:99') }));
    assert.equal(
      verifyEd25519(t.hello.mailKey, secureVaultHelloSigningText(OWNER_ID, nonce, LINK), hello(relayed)),
      false
    );
    assert.ok(
      verifyEd25519(
        t.hello.mailKey,
        secureVaultHelloSigningText(OWNER_ID, nonce, { ...LINK, peer: 'sha-256 99:99:99:99' }),
        hello(relayed)
      )
    );
    // A link the daemon never named, or one with no certificate in its
    // descriptions (the relay has none), gets no hello at all.
    assert.throws(() => hello(peer(8)), { message: VAULT_MAIL_UNBOUND });
    const bare = peer(9);
    t.mail.bindLink(bare, () => ({ local: sdp(RUNNER_CERT), remote: 'v=0\r\n' }));
    assert.throws(() => hello(bare), { message: VAULT_MAIL_UNBOUND });
    const early = peer(10);
    t.mail.bindLink(early, () => ({ local: null, remote: sdp(CALLER_CERT) }));
    assert.throws(() => hello(early), { message: VAULT_MAIL_UNBOUND });
  });

  it('takes mail only from the owner and people the server vouches are in a chat with them', () => {
    const t = setup();
    t.turn(true);
    assert.throws(() => t.deliver(stranger, [1]), { message: VAULT_MAIL_NOT_MEMBER });
    assert.throws(() => t.mail.handle('mailHello', { nonce: 'n'.repeat(24) }, stranger), {
      message: VAULT_MAIL_NOT_MEMBER
    });
    assert.equal(t.deliver(peer(7), [1]).stored, 1);
    // Outside a chat (link history) only the owner's own devices send.
    assert.throws(() => t.deliver(peer(7), [1], ''), { message: VAULT_MAIL_NOT_MEMBER });
    assert.equal(t.deliver(owner, [2], '').stored, 1);
    t.mail.close();
  });

  it('takes nothing while delivery is off, and keeps what waits for its devices', () => {
    const t = setup();
    assert.throws(() => t.deliver(peer(7), [1]), { message: VAULT_MAIL_OFF });
    t.turn(true);
    t.deliver(peer(7), [1]);
    t.turn(false);
    assert.equal(t.mail.enabled(), false);
    assert.throws(() => t.deliver(peer(7), [1]), { message: VAULT_MAIL_OFF });
    const page = t.mail.handle('mailFetch', { auth: t.auth(t.primary, 'fetch') }, owner) as {
      rows: unknown[];
    };
    assert.equal(page.rows.length, 1);
    t.mail.close();
  });

  it('wakes the owner without content: a push for a peer, a ping for their own device', () => {
    const t = setup();
    t.turn(true);
    t.deliver(peer(7), [1]);
    t.deliver(owner, [2]);
    assert.deepEqual(t.wakes, [true, false]);
    t.mail.close();
  });

  it('hands the mailbox only to the owner’s devices, proved by their own keys', () => {
    const t = setup();
    t.turn(true);
    t.deliver(peer(7), [1, 2]);
    const fetch = (auth: SecureVaultDeviceAuth, scope: VouchedScope = owner) =>
      t.mail.handle('mailFetch', { auth }, scope) as { rows: { id: number }[] };

    // The primary named at setup.
    const mine = fetch(t.auth(t.primary, 'fetch'));
    assert.equal(mine.rows.length, 1);

    // A browser the primary link-signed.
    const linked = makeDevice(2);
    const linkSignature = t.primary.sign(
      e2eeLinkSigningText(OWNER_ID, linked.deviceId, linked.curve25519, linked.ed25519)
    );
    assert.equal(fetch(t.auth(linked, 'fetch', { linkSignature })).rows.length, 1);

    // A device the primary never signed, whatever it claims.
    const rogue = makeDevice(1);
    assert.throws(() => fetch(t.auth(rogue, 'fetch')));
    assert.throws(() => fetch(t.auth(rogue, 'fetch', { linkSignature })));
    // The owner's link alone (what our server vouches) is not enough.
    assert.throws(() =>
      fetch({ ...t.auth(t.primary, 'fetch'), signature: rogue.sign('anything') })
    );
    // A sender's link never reads, even with a good signature.
    assert.throws(() => fetch(t.auth(t.primary, 'fetch'), peer(7)));
    // A signature made for a fetch does not ack, and an old one is refused.
    assert.throws(() =>
      t.mail.handle('mailAck', { auth: t.auth(t.primary, 'fetch'), ids: [mine.rows[0]!.id] }, owner)
    );
    const old = t.auth(t.primary, 'fetch');
    t.clock.now += 6 * 60 * 1000;
    assert.throws(() => fetch(old));

    const acked = t.mail.handle(
      'mailAck',
      { auth: t.auth(t.primary, 'ack'), ids: [mine.rows[0]!.id] },
      owner
    ) as { deleted: number };
    assert.equal(acked.deleted, 1);
    assert.equal(fetch(t.auth(t.primary, 'fetch')).rows.length, 0);
    t.mail.close();
  });

  it('sets up only for the owner, signed by the primary it names', () => {
    const t = setup();
    const other = makeDevice(3);
    assert.throws(() =>
      t.mail.handle(
        'mailSetup',
        {
          userId: OWNER_ID,
          enabled: true,
          primary: {
            deviceId: t.primary.deviceId,
            curve25519: t.primary.curve25519,
            ed25519: t.primary.ed25519
          },
          primarySignature: t.primary.sign(
            e2eeDeviceSigningText(OWNER_ID, t.primary.curve25519, t.primary.ed25519)
          ),
          at: t.clock.now,
          signature: other.sign('not the setup text')
        },
        owner
      )
    );
    assert.equal(t.mail.enabled(), false);
    const status = t.mail.handle('mailStatus', {}, owner) as { enabled: boolean };
    assert.equal(status.enabled, false);
    assert.throws(() => t.mail.handle('mailStatus', {}, peer(7)));
    t.mail.close();
  });

  it('answers to the first phone only, until the pin is reset at the runner', () => {
    const t = setup();
    t.turn(true);
    t.deliver(peer(7), [1]);
    // Our server vouches "owner" and names a key of its own.
    const forged = makeDevice(1);
    assert.throws(() => t.turn(true, forged), { message: /another phone/ });
    assert.throws(() => t.mail.handle('mailFetch', { auth: t.auth(forged, 'fetch') }, owner));
    // The same phone again is fine.
    t.turn(false);
    t.turn(true);
    // A new phone, after `factiii-runner mail-reset`.
    assert.equal(resetMailPrimary(t.dir), true);
    t.turn(true, forged);
    assert.throws(() => t.mail.handle('mailFetch', { auth: t.auth(t.primary, 'fetch') }, owner));
    t.mail.close();
  });

  it('gives a linked device only its own device id', () => {
    const t = setup();
    t.turn(true);
    t.deliver(peer(7), [1, 2]);
    const fetch = (auth: SecureVaultDeviceAuth) =>
      t.mail.handle('mailFetch', { auth }, owner) as { rows: unknown[] };
    const link = (device: ReturnType<typeof makeDevice>) =>
      t.primary.sign(
        e2eeLinkSigningText(OWNER_ID, device.deviceId, device.curve25519, device.ed25519)
      );
    // A linked device that has never fetched, under the id of another that
    // has never fetched either: the phone signed it for its own id only.
    const early = makeDevice(4);
    assert.throws(() =>
      fetch(t.auth({ ...early, deviceId: 2 }, 'fetch', { linkSignature: link(early) }))
    );
    const browser = makeDevice(2);
    assert.equal(fetch(t.auth(browser, 'fetch', { linkSignature: link(browser) })).rows.length, 1);
    // The same linked keys under the phone's id, and another linked device
    // under the browser's.
    const asPhone = { ...browser, deviceId: 1 };
    assert.throws(() => fetch(t.auth(asPhone, 'fetch', { linkSignature: link(browser) })));
    const other = makeDevice(2);
    assert.throws(() => fetch(t.auth(other, 'fetch', { linkSignature: link(other) })));
    assert.equal(fetch(t.auth(browser, 'fetch', { linkSignature: link(browser) })).rows.length, 1);
    // The browser, having read its own mail, under an id no device has
    // fetched under yet. The device that id belongs to still gets in.
    const asThird = { ...browser, deviceId: 3 };
    assert.throws(() => fetch(t.auth(asThird, 'fetch', { linkSignature: link(browser) })));
    const third = makeDevice(3);
    assert.equal(fetch(t.auth(third, 'fetch', { linkSignature: link(third) })).rows.length, 0);
    t.mail.close();
  });

  it('stores a delivery sent again once', () => {
    const t = setup();
    t.turn(true);
    assert.equal(t.deliver(peer(7), [1]).stored, 1);
    assert.equal(t.deliver(peer(7), [1]).stored, 1);
    const page = t.mail.handle('mailFetch', { auth: t.auth(t.primary, 'fetch') }, owner) as {
      rows: unknown[];
    };
    assert.equal(page.rows.length, 1);
    t.mail.close();
  });

  it('never rides the relay, and caps the links of people who only deliver', () => {
    for (const action of MAIL_ACTIONS) {
      assert.ok(relaySecretsRefusal('socket', action, {}), action);
      assert.equal(relaySecretsRefusal('webrtc', action, {}), null);
    }
    assert.equal(isMailOnly(peer(7), false), true);
    assert.equal(isMailOnly(peer(7), true), false);
    assert.equal(isMailOnly(owner, false), false);
    const limits = { maxMailLinks: 3, maxMailLinksPerUser: 2 };
    assert.equal(mailLinkAllowed([{ userId: '7' }], '7', limits), true);
    assert.equal(mailLinkAllowed([{ userId: '7' }, { userId: '7' }], '7', limits), false);
    assert.equal(mailLinkAllowed([{ userId: '7' }, { userId: '7' }], '8', limits), true);
    assert.equal(
      mailLinkAllowed([{ userId: '7' }, { userId: '8' }, { userId: '9' }], '10', limits),
      false
    );
  });
});
