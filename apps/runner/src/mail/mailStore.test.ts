import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { VAULT_MAIL_BUSY, VAULT_MAIL_FULL } from '@shared/all/domains/secureChat';

import { DEFAULT_MAIL_LIMITS, MAIL_MIGRATIONS, MailRefusal, openMailStore } from './mailStore';

// The Vault mailbox's store (.specs/secure-chat.md → Vault mailbox): rows per
// device, deleted on ack and at their TTL, and the caps a sender meets.

const HOUR = 60 * 60 * 1000;

function memoryStore(limits = {}, clock = { now: 1_000_000 }) {
  const store = openMailStore(':memory:', { ...DEFAULT_MAIL_LIMITS, ...limits }, () => clock.now);
  assert.ok(store, 'this Node has node:sqlite');
  return { store, clock };
}

const delivery = (senderUserId: number, deviceIds: number[], body = 'QUJD') => ({
  senderUserId,
  senderDeviceId: senderUserId * 10,
  senderCurve25519: 'curve-of-sender',
  chatId: 'chat1',
  envelopes: deviceIds.map((deviceId) => ({ deviceId, type: 1 as const, body }))
});

describe('mail store', () => {
  it('keeps one row per device and hands each device only its own', () => {
    const { store } = memoryStore();
    assert.equal(store.deliver(delivery(7, [100, 101])), 2);
    const mine = store.fetch(100);
    assert.equal(mine.rows.length, 1);
    assert.deepEqual(
      { ...mine.rows[0], id: 0, createdAt: '' },
      {
        id: 0,
        senderUserId: 7,
        senderDeviceId: 70,
        senderCurve25519: 'curve-of-sender',
        chatId: 'chat1',
        type: 1,
        body: 'QUJD',
        createdAt: ''
      }
    );
    assert.equal(store.fetch(102).rows.length, 0);
    assert.equal(mine.nextCursor, null);
  });

  it('deletes a row when its device acks it, and only then', () => {
    const { store } = memoryStore();
    store.deliver(delivery(7, [100, 101]));
    const [row] = store.fetch(100).rows;
    assert.ok(row);
    // Another device cannot ack it away.
    assert.equal(store.ack(101, [row.id]), 0);
    assert.equal(store.fetch(100).rows.length, 1);
    assert.equal(store.ack(100, [row.id]), 1);
    assert.equal(store.fetch(100).rows.length, 0);
    assert.equal(store.stats().waiting, 1);
  });

  it('drops a row nobody collected after its TTL', () => {
    const { store, clock } = memoryStore({ mailboxTtlMs: 30 * 24 * HOUR });
    store.deliver(delivery(7, [100]));
    clock.now += 29 * 24 * HOUR;
    assert.equal(store.sweep(), 0);
    assert.equal(store.fetch(100).rows.length, 1);
    clock.now += 2 * 24 * HOUR;
    // Past its time it is not handed out even before the sweep.
    assert.equal(store.fetch(100).rows.length, 0);
    assert.equal(store.sweep(), 1);
    assert.deepEqual(store.stats(), { waiting: 0, bytes: 0 });
  });

  it('pages a long mailbox by cursor', () => {
    const { store } = memoryStore({ fetchPage: 2 });
    for (let i = 0; i < 5; i++) store.deliver(delivery(7, [100]));
    const first = store.fetch(100);
    assert.equal(first.rows.length, 2);
    assert.ok(first.nextCursor);
    const second = store.fetch(100, first.nextCursor);
    assert.equal(second.rows.length, 2);
    const third = store.fetch(100, second.nextCursor ?? 0);
    assert.equal(third.rows.length, 1);
    assert.equal(third.nextCursor, null);
  });

  it('refuses a sender over the rate, and lets them in again after the window', () => {
    const { store, clock } = memoryStore({ maxDeliveriesPerWindow: 2, rateWindowMs: HOUR });
    store.deliver(delivery(7, [100]));
    store.deliver(delivery(7, [100]));
    assert.throws(
      () => store.deliver(delivery(7, [100])),
      (err: unknown) => err instanceof MailRefusal && err.retry && err.message === VAULT_MAIL_BUSY
    );
    // Someone else is not held back by it.
    assert.equal(store.deliver(delivery(8, [100])), 1);
    clock.now += HOUR + 1;
    assert.equal(store.deliver(delivery(7, [100])), 1);
  });

  it('refuses a sender over the byte rate', () => {
    const { store } = memoryStore({ maxBytesPerWindow: 10 });
    store.deliver(delivery(7, [100], 'A'.repeat(8)));
    assert.throws(() => store.deliver(delivery(7, [100], 'A'.repeat(4))), {
      message: VAULT_MAIL_BUSY
    });
  });

  it('refuses a ciphertext or a delivery that is too large, storing nothing', () => {
    const { store } = memoryStore({ maxEnvelopeBytes: 8, maxEnvelopesPerDeliver: 2 });
    assert.throws(() => store.deliver(delivery(7, [100], 'A'.repeat(9))), MailRefusal);
    assert.throws(() => store.deliver(delivery(7, [100, 101, 102])), MailRefusal);
    assert.equal(store.stats().waiting, 0);
  });

  it('caps what one sender may have waiting and what the mailbox holds', () => {
    const perSender = memoryStore({ maxRowsPerSender: 2 }).store;
    perSender.deliver(delivery(7, [100, 101]));
    assert.throws(() => perSender.deliver(delivery(7, [100])), { message: VAULT_MAIL_FULL });
    assert.equal(perSender.deliver(delivery(8, [100])), 1);

    const whole = memoryStore({ maxMailboxBytes: 10 }).store;
    whole.deliver(delivery(7, [100], 'A'.repeat(8)));
    assert.throws(() => whole.deliver(delivery(8, [100], 'A'.repeat(4))), {
      message: VAULT_MAIL_FULL
    });
    // Acked rows make room again.
    const [row] = whole.fetch(100).rows;
    assert.ok(row);
    whole.ack(100, [row.id]);
    assert.equal(whole.deliver(delivery(8, [100], 'A'.repeat(4))), 1);
  });

  it('keeps rows and settings across a restart, running each migration once', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-store-'));
    const file = path.join(dir, 'mail', 'mail.db');
    try {
      const first = openMailStore(file);
      assert.ok(first);
      first.deliver(delivery(7, [100]));
      first.setSetting('enabled', '1');
      first.close();
      const second = openMailStore(file);
      assert.ok(second);
      assert.equal(second.fetch(100).rows.length, 1);
      assert.equal(second.getSetting('enabled'), '1');
      assert.equal(second.getSetting('missing'), null);
      second.close();
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.ok(MAIL_MIGRATIONS.length > 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
