import fs from 'node:fs';

import { atomicWrite, BLOB_KIND, openBlob, sealBlob } from './crypto';

// The encrypted Vault's database (.specs/vault.md "Encryption and the
// Vault key"): PGlite in memory in its own process, and on disk only an encrypted
// dump, `parts/vault/db.sealed` (AES-256-GCM under the master key, crypto.ts
// `sealBlob`). Runner Cloud is the same, at `parts/runner-storage/db.sealed`,
// under the key the runner holds (runnerCloudSeal.ts; the runner keeps it,
// apps/runner/src/vault/runnerCloudKey.ts).
//
// The database itself is the runner's (its PGlite child, apps/runner/src/vault/db.ts):
// it arrives as `open`, which starts an in-memory database from a decrypted
// dump (or a new one for null), so this file needs nothing of the runner's.
//
// Opening decrypts the dump into a new in-memory database. Writes are
// flushed on a debounce: FLUSH_QUIET_MS after the last call, or at most
// FLUSH_MAX_MS after the first unflushed one, and always on close (which the
// lock and the daemon's shutdown call). A flush asks Postgres for its WAL
// position first and writes nothing when nothing changed since the last one,
// so reads cost no dump. A flush waits while the driver holds an interactive
// transaction open, so no dump holds half of one; each dump is written
// atomically (temp, fsync, rename), so a crash leaves the last whole one.
//
// What a crash loses: the writes since the last flush, at most FLUSH_MAX_MS
// of them.

export const FLUSH_QUIET_MS = 5_000;
export const FLUSH_MAX_MS = 60_000;

/** One statement of a batch, as the runner's database takes it
 *  (apps/runner/src/vault/dbProtocol.ts `Statement`). */
export type DbStatement = {
  sql: string;
  params?: unknown[];
  /** Run as a script: several statements, no parameters. */
  exec?: boolean;
};

/** What this file needs of a database: the runner's `VaultDb`
 *  (apps/runner/src/vault/db.ts), with its driver calls as `Op`. */
export type SealableDb<Op extends { op: string }> = {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Every statement in one transaction: all or none. */
  batch(statements: DbStatement[]): Promise<unknown[][]>;
  /** A driver call; `begin`, `commit` and `rollback` are counted, so no dump
   *  holds half a transaction, and `rss` answers the process's memory. */
  driver(op: Op | { op: 'rss' }): Promise<unknown>;
  close(): Promise<void>;
  alive(): boolean;
  /** The data folder as a gzip tarball, which this file encrypts. */
  dump(): Promise<Uint8Array>;
};

export type SealedVaultDbOptions<Op extends { op: string }> = {
  /** A new in-memory database from this dump, or an empty one for null. */
  open: (load: Uint8Array | null) => Promise<SealableDb<Op>>;
  /** The encrypted dump's path. */
  dumpPath: string;
  /** The master key, or a throw (VAULT_LOCKED) when it is not in memory. */
  key: () => Buffer;
  /** Called on every database call: the idle lock's activity. */
  onActivity?: () => void;
  /** The store, in the log's words: the Vault, or Runner Cloud (sealed the
   *  same way under the runner's own key, runnerCloudSeal.ts). */
  what?: string;
  log?: (line: string) => void;
  quietMs?: number;
  maxMs?: number;
};

export type SealedVaultDb<Op extends { op: string }> = SealableDb<Op> & {
  /** Write the dump now if anything changed. */
  flush(): Promise<void>;
  /** For the tests: dumps written. */
  flushes(): number;
};

const LSN_SQL = 'SELECT pg_current_wal_insert_lsn()::text AS "lsn"';
const MB = 1024 * 1024;

export async function openSealedVaultDb<Op extends { op: string }>(
  options: SealedVaultDbOptions<Op>
): Promise<SealedVaultDb<Op>> {
  const { dumpPath, key, what = 'Vault', log = (line) => console.log(`[vault] ${line}`) } = options;
  const quietMs = options.quietMs ?? FLUSH_QUIET_MS;
  const maxMs = options.maxMs ?? FLUSH_MAX_MS;

  let load: Buffer | null = null;
  if (fs.existsSync(dumpPath)) load = openBlob(key(), BLOB_KIND.dump, fs.readFileSync(dumpPath));
  const inner = await options.open(load);
  const loadedBytes = load?.length ?? 0;
  load?.fill(0);
  load = null;

  const lsn = async () => (await inner.query<{ lsn: string }>(LSN_SQL))[0]?.lsn ?? '';
  // A new database has its migrations to keep: the first flush writes it.
  let flushedLsn = loadedBytes > 0 ? await lsn() : '';
  let openTx = 0;
  let quietTimer: NodeJS.Timeout | null = null;
  let maxTimer: NodeJS.Timeout | null = null;
  let flushing: Promise<void> = Promise.resolve();
  let written = 0;
  let closed = false;

  // Memory, measured (the spec's note to revisit if heavy).
  const rss = (await inner.driver({ op: 'rss' }).catch(() => 0)) as number;
  log(
    `${what} ${what === 'Vault' ? 'unlocked' : 'opened'}: ${(loadedBytes / MB).toFixed(1)} MB database in memory, its process ${(rss / MB).toFixed(0)} MB resident.`
  );

  const clearTimers = () => {
    if (quietTimer) clearTimeout(quietTimer);
    if (maxTimer) clearTimeout(maxTimer);
    quietTimer = null;
    maxTimer = null;
  };

  const writeDump = async (checkpoint: boolean) => {
    const at = await lsn();
    if (at === flushedLsn) return;
    // A checkpoint before the last dump keeps the next load short.
    if (checkpoint) await inner.batch([{ sql: 'CHECKPOINT', exec: true }]);
    const plain = Buffer.from(await inner.dump());
    try {
      atomicWrite(dumpPath, sealBlob(key(), BLOB_KIND.dump, plain));
    } finally {
      plain.fill(0);
    }
    flushedLsn = at;
    written += 1;
  };

  const flush = (checkpoint = false): Promise<void> => {
    clearTimers();
    flushing = flushing.then(async () => {
      if (openTx > 0) {
        // Not under an open transaction: try again once it is quiet.
        schedule();
        return;
      }
      await writeDump(checkpoint);
    });
    // One failed flush does not stop the next.
    const current = flushing;
    flushing = flushing.catch((err: unknown) => {
      log(`The ${what} could not be saved: ${err instanceof Error ? err.message : String(err)}`);
    });
    return current;
  };

  function schedule(): void {
    if (closed) return;
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(() => void flush().catch(() => undefined), quietMs);
    quietTimer.unref();
    if (!maxTimer) {
      maxTimer = setTimeout(() => void flush().catch(() => undefined), maxMs);
      maxTimer.unref();
    }
  }

  const after = async <T>(call: Promise<T>): Promise<T> => {
    options.onActivity?.();
    try {
      return await call;
    } finally {
      schedule();
    }
  };

  return {
    query: (sql, params) => after(inner.query(sql, params)),
    batch: (statements) => after(inner.batch(statements)),
    driver: (op) =>
      after(
        (async () => {
          try {
            const value = await inner.driver(op);
            if (op.op === 'begin') openTx += 1;
            return value;
          } finally {
            if (op.op === 'commit' || op.op === 'rollback') openTx = Math.max(0, openTx - 1);
          }
        })()
      ),
    dump: () => inner.dump(),
    alive: () => inner.alive(),
    flush: () => flush(),
    flushes: () => written,
    close: async () => {
      closed = true;
      clearTimers();
      // The last dump is the one that counts: a failure keeps the process,
      // so nothing in memory is lost to a failed lock.
      await flushing;
      openTx = 0;
      await writeDump(true);
      await inner.close();
    }
  };
}
