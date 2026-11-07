import { createRequire } from 'node:module';
import path from 'node:path';

import type { SqlDriverAdapter, Transaction } from '@prisma/driver-adapter-utils';

import type { DbReply, DbRequest, DriverOp } from './dbProtocol';
import { type PgliteClient, type PgliteModule, pgliteAdapter } from './pgliteAdapter';

// The Vault's database process: PGlite (Postgres in WebAssembly, with
// pgvector) on `<runner dir>/vault/db`, answering the daemon over IPC.
//
// Its own process so its memory is its own: the daemon starts it with
// `--liftoff-only`, which keeps V8 from compiling the 9 MB WebAssembly module
// a second time with its optimizing compiler, and stops it when the vault has
// been idle a while. Measured on this built file (dist/vault-db.js) on
// 2026-10-29, Node 24.22 on Apple silicon: about 1.0 GB resident once open
// (950 MB footprint), on memory:// or on disk, against about 1.6 GB without
// the flag; the migrations and a router workload add nothing to speak of
// (.specs/runner-vault.md → Database). An earlier note here said about
// 110 MB; that is not what it takes.
//
// PGlite is not part of the runner package. Adding the Vault part installs it
// into its own folder (vaultEngine.ts), and this loads it from there.
//
// It answers two kinds of call: the runner's own SQL in batches (db.ts
// `query`/`batch`), and the Prisma driver adapter's calls for the shared vault
// router (`driver`, .specs/vault-router.md → Decisions → 1): the adapter runs
// here, next to the PGlite it drives (pgliteAdapter.ts), and the Prisma client
// stays in the daemon.

type Tx = {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  exec(sql: string): Promise<unknown>;
};

type Pglite = Tx & {
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

type PgliteLoaded = PgliteModule & {
  PGlite: {
    create(dataDir: string, options: { extensions: object }): Promise<Pglite>;
  };
};

const send = (reply: DbReply) => process.send?.(reply);

async function main(): Promise<void> {
  const [dataDir, engineDir] = process.argv.slice(2);
  if (!dataDir || !engineDir || !process.send) {
    throw new Error('Usage: vault-db <data dir> <engine dir>, as a forked child.');
  }
  const load = createRequire(path.join(engineDir, 'package.json'));
  const pglite = load('@electric-sql/pglite') as PgliteLoaded;
  const { vector } = load('@electric-sql/pglite/vector') as { vector: object };
  const db = await pglite.PGlite.create(dataDir, { extensions: { vector } });
  const adapter = pgliteAdapter(pglite, db as unknown as PgliteClient);
  const driver = driverOf(adapter);

  // One batch at a time, in the order sent: PGlite has one connection, and
  // a batch is one transaction on it.
  //
  // The driver's calls are not queued behind the batches: an interactive
  // transaction is several calls, and a batch waiting on PGlite's own lock
  // for that transaction to end would otherwise hold back the very commit it
  // waits for. PGlite orders them itself, one connection's worth.
  let queue = Promise.resolve();
  process.on('message', (request: DbRequest) => {
    if (request.op === 'driver') {
      void driver(request.driver).then(
        (value) => send({ id: request.id, ok: true, value }),
        (err: unknown) => send(failure(request.id, err))
      );
      return;
    }
    queue = queue.then(async () => {
      try {
        if (request.op === 'close') {
          await db.close();
          send({ id: request.id, ok: true, results: [] });
          process.exit(0);
        }
        const results = await db.transaction(async (tx) => {
          const out: unknown[][] = [];
          for (const statement of request.statements) {
            if (statement.exec) {
              await tx.exec(statement.sql);
              out.push([]);
            } else {
              out.push((await tx.query(statement.sql, statement.params)).rows);
            }
          }
          return out;
        });
        send({ id: request.id, ok: true, results });
      } catch (err) {
        send({
          id: request.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    });
  });
  // The daemon went away: nothing is left to answer.
  process.on('disconnect', () => {
    void db.close().finally(() => process.exit(0));
  });
  send({ id: 0, ok: true, results: [] });
}

/** A failed call, with the adapter's mapped error when it is one. */
function failure(id: number, err: unknown): DbReply {
  const message = err instanceof Error ? err.message : String(err);
  const cause = (err as { name?: string; cause?: unknown } | null)?.cause;
  return (err as { name?: string } | null)?.name === 'DriverAdapterError' && cause
    ? { id, ok: false, error: message, driverError: cause as never }
    : { id, ok: false, error: message };
}

/** The adapter's calls, with its open transactions kept here by id. */
function driverOf(adapter: SqlDriverAdapter): (op: DriverOp) => Promise<unknown> {
  const open = new Map<number, Transaction>();
  let nextTx = 1;
  const on = (tx: number | undefined) => {
    if (tx === undefined) return adapter;
    const found = open.get(tx);
    if (!found) throw new Error('That vault transaction has already ended.');
    return found;
  };
  return async (op) => {
    switch (op.op) {
      case 'queryRaw':
        return on(op.tx).queryRaw(op.query);
      case 'executeRaw':
        return on(op.tx).executeRaw(op.query);
      case 'executeScript':
        return adapter.executeScript(op.script);
      case 'begin': {
        const tx = await adapter.startTransaction(op.isolation);
        const id = nextTx++;
        open.set(id, tx);
        return { tx: id, options: tx.options };
      }
      case 'commit':
      case 'rollback': {
        const tx = on(op.tx) as Transaction;
        open.delete(op.tx);
        return op.op === 'commit' ? tx.commit() : tx.rollback();
      }
      case 'rss':
        return process.memoryUsage().rss;
    }
  };
}

main().catch((err: unknown) => {
  send({ id: 0, ok: false, error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
