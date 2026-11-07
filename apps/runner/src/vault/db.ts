import { type ChildProcess, fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ASK_CHAT_MIGRATIONS } from './askChats';
import type { DbReply, DbRequest, DriverOp, Statement } from './dbProtocol';
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
};

export type VaultDbOptions = {
  /** Where the database lives, or `memory://` for a test. */
  dataDir: string;
  /** The folder PGlite was installed into (vaultEngine.ts). */
  engineDir: string;
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
    [options.dataDir, options.engineDir],
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
    alive: () => child.connected
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
 *  (askChats.ts). */
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
  for (const migration of [...VAULT_MIGRATIONS, ...ASK_CHAT_MIGRATIONS]) {
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
  let current: Promise<VaultDb> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let busy = 0;
  // Interactive transactions the driver holds open in the process: several
  // calls apart, so nothing is busy between them, and the idle close must
  // not end the process under one.
  let openTx = 0;

  const idle = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (busy > 0 || openTx > 0 || !current) return;
      const closing = current;
      current = null;
      void closing.then((db) => db.close()).catch(() => undefined);
    }, idleMs);
    timer.unref();
  };

  const use = async <T>(fn: (db: VaultDb) => Promise<T>): Promise<T> => {
    busy += 1;
    try {
      // A database process that died (killed, out of memory) is started
      // again on the next call, not left failing until the idle close.
      if (current && !(await current.catch(() => null))?.alive()) current = null;
      if (!current) {
        current = open();
        // A failed start is not kept: the next call tries again.
        current.catch(() => {
          current = null;
        });
      }
      return await fn(await current);
    } finally {
      busy -= 1;
      idle();
    }
  };

  return {
    query: <T>(sql: string, params?: unknown[]) =>
      use((db) => db.query<T>(sql, params)),
    batch: (statements) => use((db) => db.batch(statements)),
    driver: async (op) => {
      try {
        const value = await use((db) => db.driver(op));
        if (op.op === 'begin') openTx += 1;
        return value;
      } finally {
        // Ended either way: a failed commit has no transaction left behind.
        if (op.op === 'commit' || op.op === 'rollback') openTx = Math.max(0, openTx - 1);
      }
    },
    close: async () => {
      if (timer) clearTimeout(timer);
      const closing = current;
      current = null;
      if (closing) await (await closing.catch(() => null))?.close();
    },
    alive: () => true,
    // For the tests: whether a database process is held now.
    isOpen: () => current !== null
  };
}
