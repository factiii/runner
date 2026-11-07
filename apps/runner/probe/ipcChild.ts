// Probe child: PGlite + the pglite-prisma-adapter live here, as in dbChild.ts.
// The daemon's Prisma client talks to it at the driver-adapter boundary
// (SqlQuery in, SqlResultSet out: plain data, so IPC can carry it).
// Mode 'prisma-here' instead runs the whole Prisma client + checks in here.
import { createRequire } from "node:module";
import path from "node:path";

type Msg = { id: number; op: string; [k: string]: unknown };

async function main() {
  const [engineDir, mode] = process.argv.slice(2);
  // Loaded the way dbChild.ts loads PGlite: from the engine folder.
  const load = createRequire(path.join(engineDir, "package.json"));
  const { PGlite } = load("@electric-sql/pglite");
  const { vector } = load("@electric-sql/pglite/vector");
  const { PrismaPGlite } = load("pglite-prisma-adapter");
  const pg = await PGlite.create("memory://", { extensions: { vector } });
  const { migrate } = await import("../src/vault/db");
  await migrate({
    query: async (sql: string, params?: unknown[]) =>
      (await pg.query(sql, params)).rows,
    batch: async (
      statements: { sql: string; params?: unknown[]; exec?: boolean }[],
    ) =>
      pg.transaction(
        async (tx: {
          exec(s: string): Promise<unknown>;
          query(s: string, p?: unknown[]): Promise<{ rows: unknown[] }>;
        }) => {
          const out: unknown[][] = [];
          for (const s of statements) {
            if (s.exec) {
              await tx.exec(s.sql);
              out.push([]);
            } else out.push((await tx.query(s.sql, s.params)).rows);
          }
          return out;
        },
      ),
    close: async () => undefined,
    alive: () => true,
  } as never);

  if (mode === "prisma-here") {
    const { PrismaClient } = await import("./generated/client");
    const { runChecks } = await import("./probe");
    const results = await runChecks(
      new PrismaClient({ adapter: new PrismaPGlite(pg) }),
    );
    process.send?.({ id: -1, results, rss: process.memoryUsage().rss });
    return;
  }

  const adapter = await new PrismaPGlite(pg).connect();
  const txs = new Map<
    number,
    {
      queryRaw: Function;
      executeRaw: Function;
      commit: Function;
      rollback: Function;
      options: unknown;
    }
  >();
  let nextTx = 1;
  process.on("message", async (m: Msg) => {
    try {
      const on = m.tx ? txs.get(m.tx as number)! : adapter;
      let result: unknown;
      switch (m.op) {
        case "queryRaw":
          result = await on.queryRaw(m.query);
          break;
        case "executeRaw":
          result = await on.executeRaw(m.query);
          break;
        case "executeScript":
          result = await adapter.executeScript(m.script as string);
          break;
        case "begin": {
          const tx = await adapter.startTransaction(m.isolation);
          const id = nextTx++;
          txs.set(id, tx);
          result = { tx: id, options: tx.options };
          break;
        }
        case "commit":
          await txs.get(m.tx as number)!.commit();
          txs.delete(m.tx as number);
          break;
        case "rollback":
          await txs.get(m.tx as number)!.rollback();
          txs.delete(m.tx as number);
          break;
        case "rss":
          result = process.memoryUsage().rss;
          break;
      }
      process.send?.({ id: m.id, ok: true, result });
    } catch (err) {
      const e = err as { name?: string; message?: string; cause?: unknown };
      process.send?.({
        id: m.id,
        ok: false,
        error: { name: e.name, message: e.message, cause: e.cause },
      });
    }
  });
  process.send?.({ id: 0, ok: true });
}

main().catch((err) => {
  process.send?.({ id: 0, ok: false, error: { message: String(err) } });
  process.exit(1);
});
