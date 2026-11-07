// Probe, forked: the child is started as db.ts starts dbChild.ts
// (--liftoff-only, advanced serialization, PGlite loaded from an engine dir).
//   A) 'prisma-here': Prisma client + adapter + checks all inside the child.
//   B) 'ipc': Prisma client in this (daemon) process; an SqlDriverAdapter that
//      forwards each SqlQuery to the child, where the real adapter runs it.
import { fork } from "node:child_process";
import path from "node:path";

import { DriverAdapterError } from "@prisma/driver-adapter-utils";

import { PrismaClient } from "./generated/client";
import { print, runChecks } from "./probe";

// probe/engine (generate.mjs) stands in for <runner dir>/parts/vault/engine.
const engineDir = path.join(__dirname, "engine");

function start(mode: string) {
  const child = fork(path.join(__dirname, "ipcChild.ts"), [engineDir, mode], {
    execArgv: [...process.execArgv, "--liftoff-only"],
    serialization: "advanced",
  });
  return child;
}

async function modeA() {
  const child = start("prisma-here");
  const msg = await new Promise<{
    results: Parameters<typeof print>[0];
    rss: number;
  }>((resolve) =>
    child.on("message", (m: { id: number; results?: never; rss: number }) => {
      if (m.id === -1) resolve(m as never);
    }),
  );
  console.log(
    `\n=== A) Prisma + adapter inside the forked child (rss ${(msg.rss / 1e6).toFixed(0)} MB) ===`,
  );
  print(msg.results);
  child.kill();
  return msg.results.every((r) => r.ok);
}

async function modeB() {
  const child = start("ipc");
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  await new Promise<void>((resolve, reject) => {
    child.once("message", (m: { ok: boolean; error?: unknown }) =>
      m.ok ? resolve() : reject(m.error),
    );
  });
  child.on(
    "message",
    (m: {
      id: number;
      ok: boolean;
      result?: unknown;
      error?: { message?: string; cause?: unknown };
    }) => {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      // A driver error crosses as its `cause`, and is rebuilt here so Prisma maps
      // it to P2002 and friends exactly as it would in-process.
      else
        p.reject(
          m.error?.cause
            ? new DriverAdapterError(m.error.cause as never)
            : new Error(m.error?.message),
        );
    },
  );
  const call = <T>(op: string, extra: Record<string, unknown> = {}) =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: resolve as never, reject });
      child.send({ id, op, ...extra });
    });

  const queryable = (tx?: number) => ({
    provider: "postgres" as const,
    adapterName: "vault-ipc",
    queryRaw: (query: unknown) => call<never>("queryRaw", { query, tx }),
    executeRaw: (query: unknown) => call<number>("executeRaw", { query, tx }),
  });
  const adapter = {
    ...queryable(),
    executeScript: (script: string) => call<void>("executeScript", { script }),
    startTransaction: async (isolation?: string) => {
      const { tx, options } = await call<{ tx: number; options: never }>(
        "begin",
        { isolation },
      );
      return {
        ...queryable(tx),
        options,
        commit: () => call<void>("commit", { tx }),
        rollback: () => call<void>("rollback", { tx }),
      };
    },
    getConnectionInfo: () => ({ supportsRelationJoins: true }),
    dispose: async () => undefined,
  };
  const factory = {
    provider: "postgres" as const,
    adapterName: "vault-ipc",
    connect: async () => adapter,
  };

  const before = process.memoryUsage().rss;
  const results = await runChecks(
    new PrismaClient({ adapter: factory as never }),
  );
  const childRss = await call<number>("rss");
  console.log(
    `\n=== B) Prisma in the daemon, adapter over IPC to the child (daemon rss ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB, was ${(before / 1e6).toFixed(0)}; child rss ${(childRss / 1e6).toFixed(0)} MB) ===`,
  );
  print(results);
  child.kill();
  return results.every((r) => r.ok);
}

(async () => {
  const a = await modeA();
  const b = await modeB();
  process.exit(a && b ? 0 : 1);
})();
