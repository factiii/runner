import fs from 'node:fs';
import path from 'node:path';

import {
  SECURE_VAULT_LIMITS,
  type SecureEnvelopeInput,
  type SecureMailboxRow,
  VAULT_MAIL_BUSY,
  VAULT_MAIL_FULL
} from '@shared/all/domains/secureChat';

// The Vault mailbox's store (.specs/secure-chat.md → Vault mailbox): the
// store-and-forward queue of secure chat for this runner's owner, in one
// SQLite file at `<runner dir>/mail/mail.db`. It holds Olm ciphertexts, the
// device each is for, and what the owner's device needs to open one (the
// sender's user id, device id and identity key, and the chat's id). No
// plaintext, no keys. A row is deleted when the device it is for
// acknowledges it, and after 30 days if it never does.
//
// Apart from the Vault's own database on purpose: that one is sealed under
// the Vault key and closed while the Vault is locked, and mail must be taken
// whether or not the owner has unlocked anything. What is here is already
// encrypted end to end.
//
// SQLite is Node's own (`node:sqlite`, Node 22.13 and newer), so there is
// nothing to install or compile. On an older Node the mailbox is not
// available and Vault delivery cannot be turned on at this runner.

/** The few calls of node:sqlite this file makes. */
type Statement = {
  run: (...params: unknown[]) => { changes: number | bigint; lastInsertRowid: number | bigint };
  get: (...params: unknown[]) => Record<string, unknown> | undefined;
  all: (...params: unknown[]) => Record<string, unknown>[];
};
type Database = {
  exec: (sql: string) => void;
  prepare: (sql: string) => Statement;
  close: () => void;
};
type SqliteModule = { DatabaseSync: new (file: string) => Database };

/** Node's SQLite, or null on a Node without it. */
export function loadSqlite(): SqliteModule | null {
  try {
    // A require, not an import: Node 20 has no such module, and the runner
    // must still start there.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('node:sqlite') as SqliteModule;
  } catch {
    return null;
  }
}

/** The mailbox's migrations, in order, each run once and recorded in
 *  `_mail_migrations` (the Vault database's scheme, vault/db.ts). */
export const MAIL_MIGRATIONS: readonly { id: string; sql: string }[] = [
  {
    id: '20261117180000_mailbox',
    sql: `
      CREATE TABLE "Mail" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "recipientDeviceId" INTEGER NOT NULL,
        "senderUserId" INTEGER NOT NULL,
        "senderDeviceId" INTEGER NOT NULL,
        "senderCurve25519" TEXT NOT NULL,
        "chatId" TEXT,
        "messageType" INTEGER NOT NULL,
        "ciphertext" TEXT NOT NULL,
        "bytes" INTEGER NOT NULL,
        "createdAt" INTEGER NOT NULL,
        "expiresAt" INTEGER NOT NULL
      );
      CREATE INDEX "Mail_recipient" ON "Mail" ("recipientDeviceId", "id");
      CREATE INDEX "Mail_expiresAt" ON "Mail" ("expiresAt");
      CREATE INDEX "Mail_sender" ON "Mail" ("senderUserId");
      CREATE TABLE "MailSetting" (
        "key" TEXT PRIMARY KEY,
        "value" TEXT NOT NULL
      );
    `
  },
  {
    // The deliveries taken, so one sent again (its receipt was lost on the
    // way back) is not stored twice.
    id: '20261117200000_delivery_ids',
    sql: `
      CREATE TABLE "MailDelivery" (
        "senderUserId" INTEGER NOT NULL,
        "deliveryId" TEXT NOT NULL,
        "expiresAt" INTEGER NOT NULL,
        PRIMARY KEY ("senderUserId", "deliveryId")
      );
    `
  }
];

export type MailLimits = {
  maxEnvelopesPerDeliver: number;
  maxEnvelopeBytes: number;
  maxDeliveriesPerWindow: number;
  maxBytesPerWindow: number;
  rateWindowMs: number;
  maxRowsPerSender: number;
  maxMailboxBytes: number;
  mailboxTtlMs: number;
  fetchPage: number;
};

/** One Olm ciphertext, base64 (SECURE_LIMITS.maxEnvelopeBytes; not imported
 *  so a test can make it small). */
const MAX_ENVELOPE_BYTES = 65_536;

export const DEFAULT_MAIL_LIMITS: MailLimits = {
  maxEnvelopesPerDeliver: SECURE_VAULT_LIMITS.maxEnvelopesPerDeliver,
  maxEnvelopeBytes: MAX_ENVELOPE_BYTES,
  maxDeliveriesPerWindow: SECURE_VAULT_LIMITS.maxDeliveriesPerWindow,
  maxBytesPerWindow: SECURE_VAULT_LIMITS.maxBytesPerWindow,
  rateWindowMs: SECURE_VAULT_LIMITS.rateWindowMs,
  maxRowsPerSender: SECURE_VAULT_LIMITS.maxRowsPerSender,
  maxMailboxBytes: SECURE_VAULT_LIMITS.maxMailboxBytes,
  mailboxTtlMs: SECURE_VAULT_LIMITS.mailboxTtlMs,
  fetchPage: SECURE_VAULT_LIMITS.fetchPage
};

/** A delivery the mailbox would not take. `retry`: the sender's outbox may
 *  try again later (a rate limit, a full mailbox); else it never will go. */
export class MailRefusal extends Error {
  constructor(
    message: string,
    readonly retry: boolean
  ) {
    super(message);
    this.name = 'MailRefusal';
  }
}

export type MailDelivery = {
  senderUserId: number;
  senderDeviceId: number;
  senderCurve25519: string;
  /** The sender's id for this delivery, the same on every try. */
  deliveryId?: string;
  chatId: string | null;
  envelopes: SecureEnvelopeInput[];
};

export type MailStore = {
  /** Stores every envelope or none. Throws a MailRefusal over a cap. A
   *  `deliveryId` this sender already delivered stores nothing again. */
  deliver: (delivery: MailDelivery) => number;
  /** A device's rows, oldest first, after `cursor`. */
  fetch: (
    deviceId: number,
    cursor?: number
  ) => { rows: SecureMailboxRow[]; nextCursor: number | null };
  /** Deletes rows of this device. Another device's ids are left alone. */
  ack: (deviceId: number, ids: number[]) => number;
  /** Deletes rows past their time. Returns how many. */
  sweep: () => number;
  stats: () => { waiting: number; bytes: number };
  getSetting: (key: string) => string | null;
  setSetting: (key: string, value: string) => void;
  /** Deletes every setting whose key starts with `prefix`. */
  deleteSettings: (prefix: string) => void;
  close: () => void;
};

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Opens (and migrates) the mailbox at `file`, or `:memory:` for a test.
 *  Null when this Node has no SQLite. */
export function openMailStore(
  file: string,
  limits: MailLimits = DEFAULT_MAIL_LIMITS,
  now: () => number = Date.now
): MailStore | null {
  const sqlite = loadSqlite();
  if (!sqlite) return null;
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: DIR_MODE });
  }
  const db = new sqlite.DatabaseSync(file);
  if (file !== ':memory:') fs.chmodSync(file, FILE_MODE);
  migrate(db);

  const insert = db.prepare(
    'INSERT INTO "Mail" ("recipientDeviceId", "senderUserId", "senderDeviceId", "senderCurve25519", "chatId", "messageType", "ciphertext", "bytes", "createdAt", "expiresAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const total = db.prepare('SELECT count(*) AS n, coalesce(sum("bytes"), 0) AS b FROM "Mail"');
  const ofSender = db.prepare('SELECT count(*) AS n FROM "Mail" WHERE "senderUserId" = ?');
  const page = db.prepare(
    'SELECT * FROM "Mail" WHERE "recipientDeviceId" = ? AND "id" > ? AND "expiresAt" > ? ORDER BY "id" ASC LIMIT ?'
  );
  const remove = db.prepare('DELETE FROM "Mail" WHERE "recipientDeviceId" = ? AND "id" = ?');
  const expire = db.prepare('DELETE FROM "Mail" WHERE "expiresAt" <= ?');
  const taken = db.prepare(
    'SELECT 1 FROM "MailDelivery" WHERE "senderUserId" = ? AND "deliveryId" = ?'
  );
  const take = db.prepare(
    'INSERT INTO "MailDelivery" ("senderUserId", "deliveryId", "expiresAt") VALUES (?, ?, ?)'
  );
  const expireTaken = db.prepare('DELETE FROM "MailDelivery" WHERE "expiresAt" <= ?');
  const dropSettings = db.prepare(
    'DELETE FROM "MailSetting" WHERE substr("key", 1, length(?)) = ?'
  );
  const readSetting = db.prepare('SELECT "value" FROM "MailSetting" WHERE "key" = ?');
  const writeSetting = db.prepare(
    'INSERT INTO "MailSetting" ("key", "value") VALUES (?, ?) ON CONFLICT("key") DO UPDATE SET "value" = excluded."value"'
  );

  /** What each sender delivered inside the rate window: in memory only, so
   *  a restart forgets it (the stored-row caps still hold). */
  const recent = new Map<number, { at: number; bytes: number }[]>();
  const windowOf = (senderUserId: number) => {
    const since = now() - limits.rateWindowMs;
    const kept = (recent.get(senderUserId) ?? []).filter((d) => d.at > since);
    recent.set(senderUserId, kept);
    return kept;
  };

  const stats = () => {
    const row = total.get() ?? {};
    return { waiting: Number(row.n ?? 0), bytes: Number(row.b ?? 0) };
  };

  return {
    deliver: (delivery) => {
      const { envelopes, deliveryId } = delivery;
      if (deliveryId && taken.get(delivery.senderUserId, deliveryId)) return envelopes.length;
      if (envelopes.length === 0 || envelopes.length > limits.maxEnvelopesPerDeliver) {
        throw new MailRefusal('Too many copies in one delivery.', false);
      }
      if (envelopes.some((e) => e.body.length > limits.maxEnvelopeBytes)) {
        throw new MailRefusal('A message is too large for this Vault.', false);
      }
      const bytes = envelopes.reduce((sum, e) => sum + e.body.length, 0);
      const window = windowOf(delivery.senderUserId);
      const windowBytes = window.reduce((sum, d) => sum + d.bytes, 0);
      if (
        window.length >= limits.maxDeliveriesPerWindow ||
        windowBytes + bytes > limits.maxBytesPerWindow
      ) {
        throw new MailRefusal(VAULT_MAIL_BUSY, true);
      }
      const waiting = Number(ofSender.get(delivery.senderUserId)?.n ?? 0);
      if (waiting + envelopes.length > limits.maxRowsPerSender) {
        throw new MailRefusal(VAULT_MAIL_FULL, true);
      }
      if (stats().bytes + bytes > limits.maxMailboxBytes) {
        throw new MailRefusal(VAULT_MAIL_FULL, true);
      }
      const at = now();
      db.exec('BEGIN');
      try {
        for (const envelope of envelopes) {
          insert.run(
            envelope.deviceId,
            delivery.senderUserId,
            delivery.senderDeviceId,
            delivery.senderCurve25519,
            delivery.chatId,
            envelope.type,
            envelope.body,
            envelope.body.length,
            at,
            at + limits.mailboxTtlMs
          );
        }
        if (deliveryId) take.run(delivery.senderUserId, deliveryId, at + limits.mailboxTtlMs);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      window.push({ at, bytes });
      return envelopes.length;
    },
    fetch: (deviceId, cursor = 0) => {
      const found = page.all(deviceId, cursor, now(), limits.fetchPage);
      const rows: SecureMailboxRow[] = found.map((r) => ({
        id: Number(r.id),
        senderUserId: Number(r.senderUserId),
        senderDeviceId: Number(r.senderDeviceId),
        senderCurve25519: String(r.senderCurve25519),
        chatId: r.chatId === null ? null : String(r.chatId),
        type: Number(r.messageType) === 0 ? 0 : 1,
        body: String(r.ciphertext),
        createdAt: new Date(Number(r.createdAt)).toISOString()
      }));
      const last = rows[rows.length - 1];
      return {
        rows,
        nextCursor: last && rows.length === limits.fetchPage ? last.id : null
      };
    },
    ack: (deviceId, ids) => {
      let deleted = 0;
      for (const id of ids) deleted += Number(remove.run(deviceId, id).changes);
      return deleted;
    },
    sweep: () => {
      expireTaken.run(now());
      return Number(expire.run(now()).changes);
    },
    stats,
    getSetting: (key) => {
      const row = readSetting.get(key);
      return row ? String(row.value) : null;
    },
    setSetting: (key, value) => {
      writeSetting.run(key, value);
    },
    deleteSettings: (prefix) => {
      dropSettings.run(prefix, prefix);
    },
    close: () => db.close()
  };
}

function migrate(db: Database): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS "_mail_migrations" ("id" TEXT PRIMARY KEY, "appliedAt" INTEGER NOT NULL)'
  );
  const done = new Set(
    db
      .prepare('SELECT "id" FROM "_mail_migrations"')
      .all()
      .map((row) => String(row.id))
  );
  const record = db.prepare('INSERT INTO "_mail_migrations" ("id", "appliedAt") VALUES (?, ?)');
  for (const migration of MAIL_MIGRATIONS) {
    if (done.has(migration.id)) continue;
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      record.run(migration.id, Date.now());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
