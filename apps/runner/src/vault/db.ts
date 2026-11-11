import { type ChildProcess, fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ASK_CHAT_MIGRATIONS } from './askChats';
import type { DbLoad, DbReply, DbRequest, DriverOp, Statement } from './dbProtocol';
import { ENGAGEMENT_MIGRATIONS } from './engagement';
import { VAULT_MIGRATIONS } from './migrations.generated';

// The daemon's side of the Vault's database (dbChild.ts). `openVaultDb` starts
// the process and runs the migrations it has not run; `lazyVaultDb` opens it on
// the first call and closes it after a quiet spell, so a runner whose vault
// nobody is using holds no database in memory.

export type VaultDb = {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Every statement in one transaction: all or none. */
  batch(statements: Statement[]): Promise<unknown[][]>;
  /** One call of the Prisma driver adapter in the database process
   *  (prismaIpc.ts). A database error rejects with its `driverError`. */
  driver(op: DriverOp): Promise<unknown>;
  close(): Promise<void>;
  /** The database process is still there to answer. */
  alive(): boolean;
  /** The data folder as a gzip tarball (sealedDb.ts encrypts it). */
  dump(): Promise<Uint8Array>;
};

export type VaultDbOptions = {
  /** Where the database lives, or `memory://` for a test. */
  dataDir: string;
  /** The folder PGlite was installed into (vaultEngine.ts). */
  engineDir: string;
  /** With `memory://`: start from this dump (a sealed Vault's, decrypted),
   *  or null for a new database. Absent: a plain database on `dataDir`. */
  load?: Uint8Array | null;
};

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const START_TIMEOUT_MS = 60_000;
/** A query on one person's vault is milliseconds; this only catches a
 *  process that stopped answering. */
const QUERY_TIMEOUT_MS = 120_000;

/** dbChild beside this file: `.ts` from a checkout, the built `vault-db.js`
 *  next to `cli.js` in the package. */
function childEntry(): string {
  return __filename.endsWith('.ts')
    ? path.join(__dirname, 'dbChild.ts')
    : path.join(__dirname, 'vault-db.js');
}

export async function openVaultDb(options: VaultDbOptions): Promise<VaultDb> {
  if (!options.dataDir.startsWith('memory://')) {
    fs.mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  }
  const child: ChildProcess = fork(
    childEntry(),
    options.load === undefined
      ? [options.dataDir, options.engineDir]
      : [options.dataDir, options.engineDir, '--load'],
    {
      // tsx's loader when run from source; then the flag that keeps the
      // database's memory down (dbChild.ts).
      execArgv: [...process.execArgv, '--liftoff-only'],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    }
  );
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (r: DbReply & { ok: true }) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2000);
  });

  const failAll = (message: string) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(message));
    }
    pending.clear();
  };
  // A fork that cannot start, or a send that races the child's exit, is an
  // 'error' event; unheard, it would take the whole runner down with it.
  child.on('error', (err) => failAll(`The vault database failed: ${err.message}`));

  if (options.load !== undefined) {
    child.send({ op: 'load', data: options.load } satisfies DbLoad);
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('The vault database did not start.'));
    }, START_TIMEOUT_MS);
    const onReady = (reply: DbReply) => {
      if (reply.id !== 0) return;
      clearTimeout(timer);
      child.off('message', onReady);
      if (reply.ok) resolve();
      else reject(new Error(`The vault database did not start: ${reply.error}`));
    };
    child.on('message', onReady);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`The vault database did not start: ${err.message}`));
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `The vault database stopped (exit ${code ?? 'signal'}). ${stderr.trim()}`.trim()
        )
      );
    });
  });

  child.on('message', (reply: DbReply) => {
    const request = pending.get(reply.id);
    if (!request) return;
    pending.delete(reply.id);
    clearTimeout(request.timer);
    if (reply.ok) request.resolve(reply);
    else request.reject(Object.assign(new Error(reply.error), { driverError: reply.driverError }));
  });
  child.on('exit', () => failAll('The vault database stopped.'));

  const send = (request: DistributiveOmit<DbRequest, 'id'>) =>
    new Promise<DbReply & { ok: true }>((resolve, reject) => {
      if (!child.connected) {
        reject(new Error('The vault database is not running.'));
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('The vault database did not answer.'));
      }, QUERY_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      child.send({ ...request, id } as DbRequest);
    });

  const results = (reply: DbReply & { ok: true }) => ('results' in reply ? reply.results : []);
  const db: VaultDb = {
    query: async <T>(sql: string, params?: unknown[]) =>
      (results(await send({ op: 'batch', statements: [{ sql, params }] }))[0] ?? []) as T[],
    batch: async (statements) => results(await send({ op: 'batch', statements })),
    driver: async (op) => {
      const reply = await send({ op: 'driver', driver: op });
      return 'value' in reply ? reply.value : undefined;
    },
    close: async () => {
      if (!child.connected) return;
      await send({ op: 'close' }).catch(() => undefined);
    },
    alive: () => child.connected,
    dump: async () => {
      const reply = await send({ op: 'dump' });
      return 'value' in reply ? (reply.value as Uint8Array) : new Uint8Array(0);
    }
  };

  try {
    await migrate(db);
  } catch (err) {
    child.kill();
    throw err;
  }
  return db;
}

/** Run every migration this database has not run, each in one transaction
 *  with its record: the generated ones, then the runner's own tables
 *  (askChats.ts, engagement.ts). */
export async function migrate(db: VaultDb): Promise<string[]> {
  await db.batch([
    {
      sql: 'CREATE TABLE IF NOT EXISTS "_vault_migrations" ("id" TEXT PRIMARY KEY, "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)'
    }
  ]);
  const done = new Set(
    (await db.query<{ id: string }>('SELECT "id" FROM "_vault_migrations"')).map(
      (row) => row.id
    )
  );
  const ran: string[] = [];
  for (const migration of [...VAULT_MIGRATIONS, ...ASK_CHAT_MIGRATIONS, ...ENGAGEMENT_MIGRATIONS]) {
    if (done.has(migration.id)) continue;
    await db.batch([
      { sql: migration.sql, exec: true },
      { sql: 'INSERT INTO "_vault_migrations" ("id") VALUES ($1)', params: [migration.id] }
    ]);
    ran.push(migration.id);
  }
  return ran;
}

/** A VaultDb that opens on its first call and closes after `idleMs` with
 *  nothing asked. Two calls during the start share one start. */
export function lazyVaultDb(
  open: () => Promise<VaultDb>,
  idleMs: number
): VaultDb & { isOpen(): boolean } {
  // The process held now, and the interactive transactions the driver holds
  // open in it: several calls apart, so nothing is busy between them, and
  // the idle close must not end the process under one. The count is the
  // process's own, so one that died takes its transactions with it.
  type Held = { db: Promise<VaultDb>; openTx: number };
  let current: Held | null = null;
  let timer: NodeJS.Timeout | null = null;
  let busy = 0;

  const idle = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (busy > 0 || !current || current.openTx > 0) return;
      const closing = current;
      current = null;
      void closing.db.then((db) => db.close()).catch(() => undefined);
    }, idleMs);
    timer.unref();
  };

  /** The process to ask, started when there is none. Only the one a call
   *  looked at is let go: another call may have started its replacement
   *  while this one waited, and that one is shared, not started again. */
  const hold = async (): Promise<Held> => {
    const held = current;
    if (held) {
      // A database process that died (killed, out of memory) is started
      // again on the next call, not left failing until the idle close.
      if ((await held.db.catch(() => null))?.alive()) return held;
      if (current === held) current = null;
    }
    if (!current) {
      const opening: Held = { db: open(), openTx: 0 };
      current = opening;
      // A failed start is not kept: the next call tries again.
      opening.db.catch(() => {
        if (current === opening) current = null;
      });
    }
    return current;
  };

  const use = async <T>(fn: (db: VaultDb, held: Held) => Promise<T>): Promise<T> => {
    busy += 1;
    try {
      const held = await hold();
      return await fn(await held.db, held);
    } finally {
      busy -= 1;
      idle();
    }
  };

  return {
    query: <T>(sql: string, params?: unknown[]) =>
      use((db) => db.query<T>(sql, params)),
    batch: (statements) => use((db) => db.batch(statements)),
    driver: (op) =>
      use(async (db, held) => {
        try {
          const value = await db.driver(op);
          if (op.op === 'begin') held.openTx += 1;
          return value;
        } finally {
          // Ended either way: a failed commit has no transaction left behind.
          if (op.op === 'commit' || op.op === 'rollback') {
            held.openTx = Math.max(0, held.openTx - 1);
          }
        }
      }),
    close: async () => {
      if (timer) clearTimeout(timer);
      const closing = current;
      current = null;
      if (closing) await (await closing.db.catch(() => null))?.close();
    },
    alive: () => true,
    dump: () => use((db) => db.dump()),
    // For the tests: whether a database process is held now.
    isOpen: () => current !== null
  };
}
