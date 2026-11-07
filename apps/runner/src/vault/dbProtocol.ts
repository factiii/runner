import type {
  Error as DriverError,
  IsolationLevel,
  SqlQuery
} from '@prisma/driver-adapter-utils';

// What the daemon and the Vault's database process (dbChild.ts) say to each
// other. A batch is one transaction; id 0 is the child's "ready" (or why it
// could not start).
//
// `driver` is the Prisma driver adapter's own calls (.specs/vault-router.md →
// Decisions → 1, option B): the daemon's Prisma client sends each `SqlQuery`
// here, and the adapter beside PGlite (pgliteAdapter.ts) answers it. An
// interactive transaction stays open in the child, by its id, until the
// daemon commits or rolls it back.

export type Statement = {
  sql: string;
  params?: unknown[];
  /** Run as a script: several statements, no parameters (a migration). */
  exec?: boolean;
};

export type DriverOp =
  | { op: 'queryRaw'; query: SqlQuery; tx?: number }
  | { op: 'executeRaw'; query: SqlQuery; tx?: number }
  | { op: 'executeScript'; script: string }
  | { op: 'begin'; isolation?: IsolationLevel }
  | { op: 'commit'; tx: number }
  | { op: 'rollback'; tx: number }
  /** The child's resident memory, in bytes (what the spec measures). */
  | { op: 'rss' };

export type DbRequest =
  | { id: number; op: 'batch'; statements: Statement[] }
  | { id: number; op: 'driver'; driver: DriverOp }
  | { id: number; op: 'close' };

export type DbReply =
  | { id: number; ok: true; results: unknown[][] }
  | { id: number; ok: true; value: unknown }
  // `driverError`: a database error the adapter mapped, for the daemon to
  // rethrow as Prisma's DriverAdapterError (a unique violation is P2002).
  | { id: number; ok: false; error: string; driverError?: DriverError };
