import { VAULT_SEARCH_MIN_CHARS } from '@shared/all/domains/vaultSearch';

import type {
  IngestStatus,
  Prisma,
  PrismaClient,
  UploadSource
} from './generated/client';
import type {
  FileFilter,
  FileSelection,
  RankedPost,
  VaultCaller,
  VaultDb,
  VaultTypes
} from './ports';

// The `VaultDb` port in Prisma, once, for both backends (.specs/vault-router.md
// → Decisions → 1). The server runs it on Postgres with its app client; the
// runner on PGlite, through the vendored driver adapter in its database
// process. Typed on the vault-only client (vault.prisma, generated from the
// server's schema by the runner's schemaGen.ts), so a query here can only
// name what both databases have.
//
// What still differs between the two is passed in, never read here:
//   VaultScope   what makes a row a vault row beyond its owner (on the server,
//                an upload ingest wrote; nothing on the runner, where every row
//                is one)
//   VaultSqlTag  Prisma's `sql` and `join`, from the backend's own client, so a
//                fragment is built by the runtime that runs it
//   effects      the posts a search hands back as the client renders them, the
//                skip marks (a server table), and the objects a delete removes

/**
 * The slice of the vault-only client these queries use. Reads, the two
 * bulk deletes and raw SQL: the server's full client assigns to this as it is
 * (its create inputs would not — they keep relations, such as `Post.user`,
 * that the vault schema drops — so no create is named here).
 */
export type VaultPrisma = {
  upload: Pick<PrismaClient['upload'], 'findFirst' | 'findMany' | 'deleteMany'>;
  post: Pick<PrismaClient['post'], 'deleteMany'>;
  $queryRaw: PrismaClient['$queryRaw'];
};

/** Prisma's SQL template helpers, from the client that runs them. */
export type VaultSqlTag = {
  sql: typeof Prisma.sql;
  join: typeof Prisma.join;
};

/** What makes a row a vault row on this backend, beyond who owns it. */
export type VaultScope = {
  /** Which of these accounts' uploads are vault files. */
  uploads(owners: number[]): Promise<Prisma.UploadWhereInput>;
  /** Which of their posts are vault posts, as SQL over `p` ("Post"). */
  posts(): Promise<Prisma.Sql>;
  /**
   * The `source` a file list without one reads. The server's is ONEDRIVE,
   * what every caller meant before uploads existed (inputs.ts VAULT_SOURCE);
   * null reads every source.
   */
  defaultSource: UploadSource | null;
};

/** A file list row as these queries read it. */
export type PrismaFileRow = {
  id: string;
  name: string | null;
  key: string;
  uploadSource: UploadSource;
  ingestStatus: IngestStatus | null;
  ingestError: string | null;
  createdAt: Date;
  /** Its post is PUBLISHED: deleting the file deletes a public post, so the
   *  clients confirm that one on its own (.specs/file-vault.md → Delete). */
  published: boolean;
};

/** The file `downloadUrl` found, for the backend to sign. */
export type PrismaVaultFile = {
  userId: number;
  uploadSource: UploadSource;
  externalId: string | null;
  key: string;
  name: string | null;
};

/** What a delete (or its dry run) answers. `published` is how many of the
 *  matched files are under a PUBLISHED post, so a pick's confirm can say it
 *  takes public posts with it. */
export type DeleteOutcome = {
  deleted: number;
  kept: number;
  matched: number;
  published: number;
};

/** The wire shapes these queries fix; the rest stay the backend's. */
export type PrismaVaultTypes = VaultTypes & {
  fileRow: PrismaFileRow;
  file: PrismaVaultFile;
  deleted: DeleteOutcome;
};

export type PrismaVaultDbOptions<T extends PrismaVaultTypes> = {
  client: VaultPrisma;
  tag: VaultSqlTag;
  scope: VaultScope;
  /** The posts as the client renders them. Any order. */
  hydratePosts: VaultDb<T>['hydratePosts'];
  /** The folder paths this account marked for Categorize to skip. */
  skippedFolders: VaultDb<T>['skippedFolders'];
  /** Delete these objects' bytes. Not fatal (see deleteFiles). */
  deleteObjects(keys: string[]): Promise<void>;
  /** A folder emptied for good: drop its skip marks, if this backend keeps any. */
  folderEmptied(userId: number, path: string): Promise<void>;
};

/** One account, or a shared vault's. */
export const ownedBy = (owners: number[]): number | { in: number[] } =>
  owners.length === 1 ? owners[0] : { in: owners };

// How many ids go into one statement. A folder is uncapped — it is whatever
// the person dropped — and one `IN` of every id in a large vault is a query no
// planner should be asked to hold.
const PAGE = 1000;
const pagesOf = <V>(items: V[]): V[][] =>
  Array.from({ length: Math.ceil(items.length / PAGE) }, (_, i) =>
    items.slice(i * PAGE, (i + 1) * PAGE)
  );

/**
 * The statuses a vault file's post can have: private, or published in place by
 * its owner (.specs/vault-router.md → Privacy levels). On the runner every
 * post is PRIVATE, so the second never matches there.
 */
export const VAULT_POST_STATUSES = ['PRIVATE', 'PUBLISHED'] as const;

// The file's post, which is where its tags and text live. An Upload carries
// none of its own. Private, or published by its owner: publishing a Cloud file
// keeps it in the vault.
const vaultPostOf = (owners: number[]) => ({
  userId: ownedBy(owners),
  parentPostId: null,
  status: { in: [...VAULT_POST_STATUSES] }
});

/**
 * One vault's files, narrowed the ways the UI narrows them. `owners` is the
 * caller's `vaultUsers`: one account, or a shared vault's. The factiii filter
 * reaches through the file's post.
 *
 * `scope.uploads` is what makes it *this user's vault* rather than everything
 * they have ever uploaded (on the server, helpers/vaultFactiiis.ts). `source`
 * only narrows within that: ALL is the whole vault, which is what the
 * standalone app lists, and the Sync tab still asks for the OneDrive half
 * alone.
 */
export const vaultFileWhere = async (
  scope: VaultScope,
  owners: number[],
  input?: FileFilter
): Promise<Prisma.UploadWhereInput> => {
  const source =
    input?.source === 'ALL' ? null : (input?.source ?? scope.defaultSource);
  return {
    userId: ownedBy(owners),
    ...(await scope.uploads(owners)),
    ...(source ? { uploadSource: source } : {}),
    ...(input?.ingestStatus ? { ingestStatus: input.ingestStatus } : {}),
    ...(input?.factiiiId
      ? {
          posts: {
            some: {
              ...vaultPostOf(owners),
              factiiis: { some: { factiiiId: input.factiiiId } }
            }
          }
        }
      : {}),
    // A search: the words are in the file's name, or in the text read out of
    // it. Under AND, because the category filter already holds the `posts`
    // key (and the vault's own scope was an OR until 2026-11-08). Verbatim only: the
    // meaning search is `search`, which answers with posts, not with this
    // list's rows.
    ...(input?.query && input.query.length >= VAULT_SEARCH_MIN_CHARS
      ? {
          AND: [
            {
              OR: [
                { name: { contains: input.query, mode: 'insensitive' } },
                {
                  posts: {
                    some: {
                      ...vaultPostOf(owners),
                      contentRows: {
                        some: {
                          text: { contains: input.query, mode: 'insensitive' }
                        }
                      }
                    }
                  }
                }
              ]
            }
          ]
        }
      : {})
  };
};

const vectorLiteral = (vector: number[]): string => `[${vector.join(',')}]`;

/** The `VaultDb` port on a backend's Prisma client. */
export const prismaVaultDb = <T extends PrismaVaultTypes>(
  options: PrismaVaultDbOptions<T>
): VaultDb<T> => {
  const { client, tag, scope } = options;
  const { sql, join } = tag;

  const filteredWhere = (caller: VaultCaller, filter: FileFilter) =>
    vaultFileWhere(scope, caller.vaultUsers, filter);

  const selectionWhere = async (
    caller: VaultCaller,
    selection: FileSelection
  ): Promise<Prisma.UploadWhereInput> => {
    switch (selection.kind) {
      case 'page':
        return filteredWhere(caller, selection.filter);
      case 'ids':
        return { id: { in: selection.ids } };
      case 'idsWithin':
        return {
          AND: [
            await filteredWhere(caller, selection.filter),
            { id: { in: selection.ids } }
          ]
        };
    }
  };

  // Vault posts only: PRIVATE or published in place by their owner,
  // top-level, inside the backend's scope (on the server, a post carrying a
  // file ingest wrote — not the upload's `uploadSource`, which reads S3 for a
  // post photo too), with a live file.
  //
  // Owner-scoped: the viewer's own posts only. Raw bge query vector on
  // the semantic path, NOT the whitened one unified search uses — whitening
  // centres the public corpus, and this is one person's documents.
  const vaultPostScope = async (
    caller: VaultCaller
  ): Promise<Prisma.Sql> => sql`
    p."userId" = ${caller.userId}
      AND p."status" IN ('PRIVATE', 'PUBLISHED')
      AND p."parentPostId" IS NULL
      AND ${await scope.posts()}
      AND EXISTS (
        SELECT 1 FROM "_postUploads" pu
        JOIN "Upload" u ON u."id" = pu."B"
        WHERE pu."A" = p."id"
          AND u."status" = 'PUBLISHED'
      )
  `;

  // Every query carries the uuid as well as the numeric id. The numeric id
  // is what the batch loader takes and what the vector join is keyed on; the
  // uuid is what comes back on the DTO, and is the only one of the two the
  // router's reorder can match on. Selecting both here is free and is what
  // keeps the two ends of `search` speaking the same language — see the
  // comment on the reorder (router.ts).
  return {
    anyFile: async (caller, filter) =>
      Boolean(
        await client.upload.findFirst({
          where: await filteredWhere(caller, filter),
          select: { id: true }
        })
      ),

    fileTimes: async (caller, filter) =>
      (
        await client.upload.findMany({
          where: await filteredWhere(caller, filter),
          select: {
            id: true,
            createdAt: true,
            ontologyAt: true,
            posts: {
              where: vaultPostOf(caller.vaultUsers),
              select: { updatedAt: true },
              take: 1
            }
          }
        })
      ).map((file) => ({
        id: file.id,
        createdAt: file.createdAt,
        ontologyAt: file.ontologyAt,
        postUpdatedAt: file.posts[0]?.updatedAt ?? null
      })),

    nearestFiles: async (caller, vector, limit) => {
      const rows = await client.$queryRaw<{ id: string; distance: number }[]>`
        SELECT pu."B" AS "id", MIN(sv."vector" <=> ${vectorLiteral(vector)}::halfvec)::float8 AS "distance"
        FROM "SearchVector" sv
        JOIN "PostContent" pc ON pc."id" = sv."postContentId"
        JOIN "Post" p ON p."id" = pc."postId"
        JOIN "_postUploads" pu ON pu."A" = p."id"
        WHERE p."userId" IN (${join(caller.vaultUsers)})
          AND p."status" IN ('PRIVATE', 'PUBLISHED')
          AND p."parentPostId" IS NULL
          AND ${await scope.posts()}
        GROUP BY pu."B"
        ORDER BY "distance" ASC, pu."B" ASC
        LIMIT ${limit}
      `;
      return rows.map((row) => ({
        id: row.id,
        distance: Number(row.distance)
      }));
    },

    fileRows: async (caller, selection) => {
      const rows = await client.upload.findMany({
        where: await selectionWhere(caller, selection),
        select: {
          id: true,
          name: true,
          key: true,
          // Who added it: the avatar on a shared vault's row.
          userId: true,
          // Which retry a failed row offers, as in `folder`.
          uploadSource: true,
          ingestStatus: true,
          ingestError: true,
          createdAt: true,
          // Chunks live on the file's post now, so the count comes from
          // there. Filtered to seq > 0: seq 0 is the post's own summary
          // vector, not a slice of the document, and counting it would
          // report every file as having one chunk more than it does.
          posts: {
            where: vaultPostOf(caller.vaultUsers),
            select: {
              status: true,
              _count: {
                select: {
                  contentRows: { where: { searchVector: { isNot: null } } }
                }
              }
            },
            take: 1
          }
        },
        orderBy: { createdAt: 'desc' },
        ...(selection.kind === 'page'
          ? { skip: selection.offset, take: selection.limit }
          : {})
      });
      return rows.map(({ posts, ...file }) => ({
        ...file,
        published: posts[0]?.status === 'PUBLISHED',
        chunks: posts[0]?._count.contentRows ?? 0
      }));
    },

    skippedFolders: options.skippedFolders,

    recentPosts: async (caller, { offset, limit }) =>
      client.$queryRaw<RankedPost[]>`
        SELECT p."id" AS "postId", p."uuid" FROM "Post" p
        WHERE ${await vaultPostScope(caller)}
        ORDER BY p."createdAt" DESC, p."id" DESC
        OFFSET ${offset} LIMIT ${limit}
      `,

    postsMatching: async (caller, pattern, { offset, limit }) =>
      client.$queryRaw<RankedPost[]>`
        SELECT p."id" AS "postId", p."uuid" FROM "Post" p
        WHERE ${await vaultPostScope(caller)} AND EXISTS (
          SELECT 1 FROM "PostContent" pc
          WHERE pc."postId" = p."id" AND pc."text" ILIKE ${pattern}
        )
        ORDER BY p."createdAt" DESC, p."id" DESC
        OFFSET ${offset} LIMIT ${limit}
      `,

    nearestPosts: async (caller, vector, { offset, limit }) =>
      client.$queryRaw<RankedPost[]>`
        SELECT pc."postId", p."uuid", MIN(sv."vector" <=> ${vectorLiteral(vector)}::halfvec) AS distance
        FROM "SearchVector" sv
        JOIN "PostContent" pc ON pc."id" = sv."postContentId"
        JOIN "Post" p ON p."id" = pc."postId"
        WHERE ${await vaultPostScope(caller)}
        GROUP BY pc."postId", p."uuid"
        ORDER BY distance ASC
        OFFSET ${offset} LIMIT ${limit}
      `,

    hydratePosts: options.hydratePosts,

    // findFirst, not findUnique by id: the vault scope is part of the lookup.
    findFile: async (caller, uploadId) =>
      client.upload.findFirst({
        where: {
          id: uploadId,
          userId: ownedBy(caller.vaultUsers),
          ...(await scope.uploads(caller.vaultUsers))
        },
        select: {
          userId: true,
          uploadSource: true,
          externalId: true,
          key: true,
          name: true
        }
      }),

    deleteFiles: (caller, target) => deleteFiles(options, caller.userId, target)
  };
};

/**
 * Delete this account's own vault files, by id or everything inside a
 * folder, or count what would go (`dryRun`). Only uploaded files go: a synced
 * one is kept and counted, since the next sync would write it back and
 * un-syncing its folder is what removes it.
 */
export const deleteFiles = async (
  options: Pick<
    PrismaVaultDbOptions<PrismaVaultTypes>,
    'client' | 'scope' | 'deleteObjects' | 'folderEmptied'
  >,
  userId: number,
  {
    uploadIds,
    folder,
    dryRun = false
  }: { uploadIds?: string[]; folder?: string[]; dryRun?: boolean }
): Promise<DeleteOutcome> => {
  const { client, scope } = options;
  const rows = await client.upload.findMany({
    where: {
      userId,
      ...(uploadIds ? { id: { in: uploadIds } } : {}),
      // Narrowed in SQL rather than by reading every row of the vault and
      // filtering in memory. `inFolder` below is still what decides — this
      // prefix is a superset of it (it would also catch `Bank statements` for
      // `Bank/`), so it only bounds what is loaded.
      ...(folder && folder.length > 0
        ? { name: { startsWith: `${folder.join('/')}/` } }
        : {}),
      ...(await scope.uploads([userId]))
    },
    select: {
      id: true,
      key: true,
      name: true,
      uploadSource: true,
      posts: { select: { id: true, status: true } }
    }
  });

  // Segment by segment, not `startsWith`: "Bank" must not carry off
  // "Bank statements", and a trailing-slash name is the same file either way.
  const inFolder = (name: string | null): boolean => {
    if (!folder || folder.length === 0) return true;
    const segments = (name ?? '').split('/').filter(Boolean);
    return (
      segments.length > folder.length &&
      folder.every((segment, i) => segments[i] === segment)
    );
  };

  const matched = rows.filter((row) => inFolder(row.name));
  // Files whose post is public: deleting them deletes a published post.
  const published = matched.filter((row) =>
    row.posts.some((post) => post.status === 'PUBLISHED')
  ).length;
  if (dryRun) {
    return {
      deleted: 0,
      kept: matched.filter((row) => row.uploadSource !== 'S3').length,
      matched: matched.length,
      published
    };
  }

  // Synced files are left where they are: the next sync would write them back,
  // and un-syncing the folder is what removes them.
  const mine = matched.filter((row) => row.uploadSource === 'S3');
  const kept = matched.length - mine.length;
  if (mine.length === 0) {
    return { deleted: 0, kept, matched: matched.length, published };
  }

  // In a few statements, not three per file. A file at a time meant a post
  // delete, a row delete and an object delete each waiting on the last — about
  // three round trips per file, so a folder of six hundred took five minutes
  // and outlived the proxy in front of it. The order is the same one the
  // server's `deleteVaultUpload` keeps for one file, and for the same reasons.
  //
  // In pages, because a folder has no size limit.
  const postIds = mine.flatMap((row) => row.posts.map((post) => post.id));
  // Posts first: they hold the text, and their SearchVector rows cascade.
  for (const page of pagesOf(postIds)) {
    await client.post.deleteMany({ where: { id: { in: page } } });
  }
  let deleted = 0;
  for (const page of pagesOf(mine.map((row) => row.id))) {
    const gone = await client.upload.deleteMany({
      where: { id: { in: page } }
    });
    // What the database actually removed, not what was asked for: another tab
    // may have taken some of these between the read above and here.
    deleted += gone.count;
  }
  // Objects last, and not fatally: a row that is already gone must not come
  // back because the bucket was briefly unreachable. An orphaned object costs
  // storage, which is the cheaper of the two mistakes.
  await options
    .deleteObjects(mine.map((row) => row.key))
    .catch(() => undefined);

  // A folder emptied for good takes its skip marks with it (it and any folder
  // under it), so a new folder that later gets the same name is categorized
  // like any other. One whose synced files stayed keeps them.
  if (folder && folder.length > 0 && kept === 0) {
    await options.folderEmptied(userId, folder.join('/'));
  }

  return { deleted, kept, matched: matched.length, published };
};
