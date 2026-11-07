import {
  DriverAdapterError,
  type Error as DriverError,
  type SqlDriverAdapter,
  type SqlDriverAdapterFactory,
  type SqlQuery,
  type SqlResultSet,
  type Transaction,
  type TransactionOptions
} from '@prisma/driver-adapter-utils';

import type { VaultDb } from './db';
import type { DriverOp } from './dbProtocol';

// The daemon's half of the Vault's Prisma driver adapter (.specs/vault-router.md
// → Decisions → 1, option B): the Prisma client runs here, and every call it
// makes on its adapter crosses to the database process (dbChild.ts), where the
// real adapter (pgliteAdapter.ts) runs it on PGlite. `SqlQuery` and
// `SqlResultSet` are plain data, so advanced serialization carries them as
// they are.

const ADAPTER_NAME = 'vault-ipc';

/** A call, with a mapped database error rebuilt as Prisma's own, so a unique
 *  violation still reaches the caller as P2002. */
async function call<T>(db: VaultDb, op: DriverOp): Promise<T> {
  try {
    return (await db.driver(op)) as T;
  } catch (err) {
    const driverError = (err as { driverError?: DriverError }).driverError;
    if (driverError) throw new DriverAdapterError(driverError);
    throw err;
  }
}

const queryable = (db: VaultDb, tx?: number) => ({
  provider: 'postgres' as const,
  adapterName: ADAPTER_NAME,
  queryRaw: (query: SqlQuery) => call<SqlResultSet>(db, { op: 'queryRaw', query, tx }),
  executeRaw: (query: SqlQuery) => call<number>(db, { op: 'executeRaw', query, tx })
});

function adapterOver(db: VaultDb): SqlDriverAdapter {
  return {
    ...queryable(db),
    executeScript: (script) => call<void>(db, { op: 'executeScript', script }),
    startTransaction: async (isolation): Promise<Transaction> => {
      const { tx, options } = await call<{ tx: number; options: TransactionOptions }>(db, {
        op: 'begin',
        isolation
      });
      return {
        ...queryable(db, tx),
        options,
        commit: () => call<void>(db, { op: 'commit', tx }),
        rollback: () => call<void>(db, { op: 'rollback', tx })
      };
    },
    getConnectionInfo: () => ({ supportsRelationJoins: true }),
    // The database process is the VaultDb's to close (db.ts lazyVaultDb).
    dispose: async () => undefined
  };
}

/** A Prisma driver adapter factory on the Vault's database process. */
export function vaultIpcAdapter(db: VaultDb): SqlDriverAdapterFactory {
  return {
    provider: 'postgres',
    adapterName: ADAPTER_NAME,
    connect: async () => adapterOver(db)
  };
}
