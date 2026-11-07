// Probe for .specs/vault-router.md → Decisions → 1: does Prisma 7 with
// pglite-prisma-adapter cover the vault's queries?
// Run: `pnpm --filter @factiii/runner vault:probe` (generates the client,
// installs the engine, then runs this in-process and forkProbe.ts forked).
import { createRequire } from "node:module";
import path from "node:path";

import type { PGlite as PGliteType } from "@electric-sql/pglite";

import { migrate } from "../src/vault/db";
import type { VaultDb } from "../src/vault/db";
import { Prisma, PrismaClient } from "./generated/client";

/** PGlite and the adapter come from one folder, as the runner loads PGlite
 *  from its engine folder (vault/engine.ts): the adapter tests errors with
 *  `instanceof` against ITS PGlite, so two copies would break P2002. */
export const ENGINE_DIR = path.join(__dirname, "engine");

type Factory = ConstructorParameters<typeof PrismaClient>[0] extends infer O
  ? O extends { adapter?: infer A }
    ? A
    : never
  : never;

export function loadEngine(engineDir: string = ENGINE_DIR) {
  const load = createRequire(path.join(engineDir, "package.json"));
  return {
    PGlite: (load("@electric-sql/pglite") as { PGlite: typeof PGliteType })
      .PGlite,
    vector: (load("@electric-sql/pglite/vector") as { vector: object })
      .vector,
    PrismaPGlite: (
      load("pglite-prisma-adapter") as {
        PrismaPGlite: new (pg: PGliteType) => Factory;
      }
    ).PrismaPGlite,
  };
}

type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];
async function check(name: string, fn: () => Promise<unknown>) {
  try {
    const out = await fn();
    results.push({
      name,
      ok: true,
      detail: JSON.stringify(out, (_k, v) =>
        typeof v === "bigint" ? `${v}n` : v,
      ).slice(0, 160),
    });
  } catch (err) {
    results.push({
      name,
      ok: false,
      detail: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
  }
}

const vec = (n: number, seed: number) =>
  `[${Array.from({ length: n }, (_, i) => Math.sin(seed * 31 + i)).join(",")}]`;

export async function inProcessSetup(): Promise<{
  prisma: PrismaClient;
  done: () => Promise<void>;
}> {
  const { PGlite, vector, PrismaPGlite } = loadEngine();
  const pg = await PGlite.create("memory://", { extensions: { vector } });
  // The runner's own migrations (the same SQL Prisma writes from vault.prisma).
  const db: VaultDb = {
    query: async (sql, params) => (await pg.query(sql, params)).rows as never,
    batch: async (statements) =>
      pg.transaction(async (tx) => {
        const out: unknown[][] = [];
        for (const s of statements) {
          if (s.exec) {
            await tx.exec(s.sql);
            out.push([]);
          } else out.push((await tx.query(s.sql, s.params)).rows);
        }
        return out;
      }),
    close: () => pg.close(),
    alive: () => true,
  };
  await migrate(db);
  const prisma = new PrismaClient({ adapter: new PrismaPGlite(pg) });
  return { prisma, done: () => pg.close() };
}

export async function runChecks(prisma: PrismaClient): Promise<Result[]> {
  const owner = 7;
  const provenance = [101, 102];

  // --- Typed client ------------------------------------------------------
  let postId = 0;
  let uploadId = "";
  await check(
    "typed: create Post + nested PostContent + Upload connect",
    async () => {
      const post = await prisma.post.create({
        data: {
          userId: owner,
          content: "body",
          title: "tax/2026.pdf",
          status: "PRIVATE",
          contentRows: {
            create: [
              { seq: 0, text: "The 100% refund_policy is here" },
              { seq: 1, text: "second row" },
            ],
          },
          uploads: {
            create: {
              key: "vault/7/a.pdf",
              name: "tax/2026.pdf",
              userId: owner,
              type: "DOCUMENT",
              ingestStatus: "EMBEDDED",
              sha256: "abc",
            },
          },
          factiiis: {
            create: {
              factiiiId: 101,
              postFactiiis: { create: { userId: 1, status: "APPROVED" } },
            },
          },
        },
        include: { uploads: true, contentRows: true },
      });
      postId = post.id;
      uploadId = post.uploads[0].id;
      return {
        id: post.id,
        uuid: post.uuid,
        rows: post.contentRows.length,
        createdAt: post.createdAt,
      };
    },
  );

  await check(
    "typed: vaultUploadWhere (relation some + OR + enum in)",
    async () =>
      prisma.upload.findMany({
        where: {
          OR: [
            {
              posts: {
                some: {
                  userId: { in: [owner, 8] },
                  parentPostId: null,
                  status: "PRIVATE",
                  factiiis: { some: { factiiiId: { in: provenance } } },
                },
              },
            },
            { ingestStatus: { in: ["PENDING", "FAILED"] } },
          ],
        },
        select: {
          id: true,
          name: true,
          createdAt: true,
          posts: {
            select: { uuid: true, factiiis: { select: { factiiiId: true } } },
          },
        },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take: 50,
      }),
  );

  await check("typed: name contains insensitive (ILIKE via Prisma)", async () =>
    prisma.upload.findMany({
      where: { name: { contains: "TAX", mode: "insensitive" } },
      select: { id: true },
    }),
  );

  await check("typed: count + groupBy + aggregate", async () => ({
    count: await prisma.upload.count({ where: { userId: owner } }),
    group: await prisma.postContent.groupBy({
      by: ["postId"],
      _count: { _all: true },
    }),
    agg: await prisma.post.aggregate({ _max: { trendingRank: true } }),
  }));

  await check("typed: interactive $transaction (commit)", async () =>
    prisma.$transaction(async (tx) => {
      await tx.upload.update({
        where: { id: uploadId },
        data: { ontologyAt: new Date() },
      });
      return tx.upload.findUnique({
        where: { id: uploadId },
        select: { ontologyAt: true },
      });
    }),
  );

  await check(
    "typed: interactive $transaction (rollback on throw)",
    async () => {
      await prisma
        .$transaction(async (tx) => {
          await tx.upload.update({
            where: { id: uploadId },
            data: { name: "rolled-back" },
          });
          throw new Error("boom");
        })
        .catch(() => undefined);
      const row = await prisma.upload.findUnique({
        where: { id: uploadId },
        select: { name: true },
      });
      if (row?.name === "rolled-back")
        throw new Error("rollback did not happen");
      return row;
    },
  );

  await check("typed: batch $transaction([...])", async () =>
    prisma.$transaction([
      prisma.vaultShare.create({
        data: {
          ownerId: owner,
          memberId: 8,
          status: "ACCEPTED",
          acceptedAt: new Date(),
        },
      }),
      prisma.vaultShare.findMany({ where: { ownerId: owner } }),
    ]),
  );

  await check("typed: unique violation maps to P2002", async () => {
    try {
      await prisma.vaultShare.create({ data: { ownerId: owner, memberId: 8 } });
      throw new Error("no error");
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError) return err.code;
      throw err;
    }
  });

  // --- Raw SQL ------------------------------------------------------------
  await check(
    "raw: $executeRaw INSERT ::halfvec ON CONFLICT (vaultIngest)",
    async () => {
      const rows = await prisma.postContent.findMany({
        where: { postId },
        select: { id: true },
      });
      let n = 0;
      for (const [i, row] of rows.entries()) {
        n += await prisma.$executeRaw`
        INSERT INTO "SearchVector" ("postContentId", "vector", "updatedAt")
        VALUES (${row.id}, ${vec(768, i)}::halfvec, now())
        ON CONFLICT ("postContentId")
        DO UPDATE SET "vector" = EXCLUDED."vector", "updatedAt" = now()`;
      }
      return n;
    },
  );

  await check(
    "raw: $executeRaw ::vector(512) MediaVector",
    async () =>
      prisma.$executeRaw`
      INSERT INTO "MediaVector" ("uploadId", "vector", "updatedAt")
      VALUES (${uploadId}, ${vec(512, 3)}::vector, now())
      ON CONFLICT ("uploadId") DO UPDATE SET "vector" = EXCLUDED."vector", "updatedAt" = now()`,
  );

  const vaultPostSql = (ids: number[]) =>
    ids.length === 0
      ? Prisma.sql`false`
      : Prisma.sql`EXISTS (SELECT 1 FROM "PostFactiiiCount" vprov WHERE vprov."postId" = p."id" AND vprov."factiiiId" IN (${Prisma.join(ids)}))`;
  const scoped = Prisma.sql`
    p."userId" = ${owner} AND p."status" = 'PRIVATE' AND p."parentPostId" IS NULL
    AND ${vaultPostSql(provenance)}
    AND EXISTS (SELECT 1 FROM "_postUploads" pu JOIN "Upload" u ON u."id" = pu."B" WHERE pu."A" = p."id" AND u."status" = 'PUBLISHED')`;

  await check(
    "raw: vaultPostSql + Prisma.join + OFFSET/LIMIT params",
    async () =>
      prisma.$queryRaw`SELECT p."id" AS "postId", p."uuid" FROM "Post" p WHERE ${scoped} ORDER BY p."createdAt" DESC, p."id" DESC OFFSET ${0} LIMIT ${20}`,
  );

  await check(
    "raw: vaultPostSql([]) -> false",
    async () =>
      prisma.$queryRaw`SELECT p."id" FROM "Post" p WHERE ${vaultPostSql([])}`,
  );

  await check("raw: ILIKE with escaped % and _", async () => {
    const like = `%${"100%".replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return prisma.$queryRaw`SELECT p."id" FROM "Post" p WHERE ${scoped} AND EXISTS (SELECT 1 FROM "PostContent" pc WHERE pc."postId" = p."id" AND pc."text" ILIKE ${like})`;
  });

  await check(
    "raw: MIN(<=> ::halfvec) GROUP BY, no cast (search)",
    async () =>
      prisma.$queryRaw`
      SELECT pc."postId", p."uuid", MIN(sv."vector" <=> ${vec(768, 0)}::halfvec) AS distance
      FROM "SearchVector" sv JOIN "PostContent" pc ON pc."id" = sv."postContentId" JOIN "Post" p ON p."id" = pc."postId"
      WHERE ${scoped} GROUP BY pc."postId", p."uuid" ORDER BY distance ASC OFFSET ${0} LIMIT ${20}`,
  );

  await check(
    "raw: MIN(<=>)::float8 + IN(join) (filesByMeaning)",
    async () =>
      prisma.$queryRaw`
      SELECT pu."B" AS "id", MIN(sv."vector" <=> ${vec(768, 1)}::halfvec)::float8 AS "distance"
      FROM "SearchVector" sv JOIN "PostContent" pc ON pc."id" = sv."postContentId"
      JOIN "Post" p ON p."id" = pc."postId" JOIN "_postUploads" pu ON pu."A" = p."id"
      WHERE p."userId" IN (${Prisma.join([owner, 8])}) AND p."status" = 'PRIVATE' AND p."parentPostId" IS NULL
      GROUP BY pu."B" ORDER BY "distance" ASC, pu."B" ASC LIMIT ${200}`,
  );

  await check("raw: SELECT a halfvec column back (extension OID)", async () =>
    prisma.$queryRaw<
      { v: string }[]
    >`SELECT "vector" AS v FROM "SearchVector" LIMIT 1`.then(
      (r) => typeof r[0]?.v + ":" + String(r[0]?.v).slice(0, 30),
    ),
  );

  await check(
    "raw: COUNT(*) bigint + SUM (vaultStorage)",
    async () =>
      prisma.$queryRaw`SELECT COUNT(DISTINCT p."id") AS posts, COUNT(sv."id") AS vectors FROM "Post" p LEFT JOIN "PostContent" pc ON pc."postId" = p."id" LEFT JOIN "SearchVector" sv ON sv."postContentId" = pc."id" WHERE ${scoped}`,
  );

  await check(
    "raw: unnest($1::int[], $2::text[]) array params (runner ingest)",
    async () => {
      const rows = await prisma.postContent.findMany({
        where: { postId },
        select: { id: true },
      });
      return prisma.$executeRawUnsafe(
        `INSERT INTO "SearchVector" ("postContentId", "vector", "updatedAt")
       SELECT t.id, t.v::halfvec, CURRENT_TIMESTAMP FROM unnest($1::int[], $2::text[]) AS t(id, v)
       ON CONFLICT ("postContentId") DO UPDATE SET "vector" = EXCLUDED."vector"`,
        rows.map((r) => r.id),
        rows.map((_r, i) => vec(768, i + 10)),
      );
    },
  );

  await check(
    "raw: $queryRawUnsafe with $n params + halfvec (runner askTools style)",
    async () =>
      prisma.$queryRawUnsafe(
        `SELECT pc."id", (sv."vector" <=> $2::halfvec)::float8 AS "distance" FROM "SearchVector" sv JOIN "PostContent" pc ON pc."id" = sv."postContentId" JOIN "Post" p ON p."id" = pc."postId" WHERE p."userId" = $1 ORDER BY 2 LIMIT 5`,
        owner,
        vec(768, 0),
      ),
  );

  await check(
    "raw: enum cast + uuid param + recursive CTE",
    async () =>
      prisma.$queryRaw`
      WITH RECURSIVE d AS (SELECT id FROM "Post" WHERE uuid = ${(await prisma.post.findUniqueOrThrow({ where: { id: postId } })).uuid}::uuid
        UNION SELECT p.id FROM "Post" p JOIN d ON p."parentPostId" = d.id WHERE p.status <> 'DELETED'::"PostStatus")
      SELECT COUNT(*)::int AS n FROM d`,
  );

  await check(
    "typed: delete cascades (Post -> PostContent -> SearchVector)",
    async () => {
      await prisma.post.delete({ where: { id: postId } });
      return {
        vectors: await prisma.searchVector.count(),
        rows: await prisma.postContent.count(),
      };
    },
  );

  await prisma.$disconnect();
  return results;
}

export function print(r: Result[]): void {
  for (const x of r)
    console.log(`${x.ok ? "WORKS" : "FAILS"}  ${x.name}\n       ${x.detail}`);
}

if (require.main === module) {
  inProcessSetup().then(async ({ prisma, done }) => {
    const r = await runChecks(prisma);
    await done();
    print(r);
    process.exit(r.every((x) => x.ok) ? 0 : 1);
  });
}
