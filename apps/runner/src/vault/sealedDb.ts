import fs from 'node:fs';

import { atomicWrite, BLOB_KIND, openBlob, sealBlob } from './crypto';
import { openVaultDb, type VaultDb } from './db';

// The encrypted Vault's database (.specs/vault.md "Encryption and the
// Vault key"): PGlite in memory in its own process, and on disk only an encrypted
// dump, `parts/vault/db.sealed` (AES-256-GCM under the master key, crypto.ts
// `sealBlob`).
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

export type SealedVaultDbOptions = {
  engineDir: string;
  /** The encrypted dump's path. */
  dumpPath: string;
  /** The master key, or a throw (VAULT_LOCKED) when it is not in memory. */
  key: () => Buffer;
  /** Called on every database call: the idle lock's activity. */
  onActivity?: () => void;
  log?: (line: string) => void;
  quietMs?: number;
  maxMs?: number;
};

export type SealedVaultDb = VaultDb & {
  /** Write the dump now if anything changed. */
  flush(): Promise<void>;
  /** For the tests: dumps written. */
  flushes(): number;
};

const LSN_SQL = 'SELECT pg_current_wal_insert_lsn()::text AS "lsn"';
const MB = 1024 * 1024;

export async function openSealedVaultDb(options: SealedVaultDbOptions): Promise<SealedVaultDb> {
  const { dumpPath, key, log = (line) => console.log(`[vault] ${line}`) } = options;
  const quietMs = options.quietMs ?? FLUSH_QUIET_MS;
  const maxMs = options.maxMs ?? FLUSH_MAX_MS;

  let load: Buffer | null = null;
  if (fs.existsSync(dumpPath)) load = openBlob(key(), BLOB_KIND.dump, fs.readFileSync(dumpPath));
  const inner = await openVaultDb({ dataDir: 'memory://', engineDir: options.engineDir, load });
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
    `Vault unlocked: ${(loadedBytes / MB).toFixed(1)} MB database in memory, its process ${(rss / MB).toFixed(0)} MB resident.`
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
      log(`The Vault could not be saved: ${err instanceof Error ? err.message : String(err)}`);
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
