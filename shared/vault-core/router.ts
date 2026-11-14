import { VAULT_SEARCH_MIN_CHARS } from '@shared/all/domains/vaultSearch';
import { initTRPC, TRPCError } from '@trpc/server';

import {
  deleteFilesInput,
  downloadUrlInput,
  type FilesInput,
  filesInput,
  searchInput
} from './inputs';
import type { FileFilter, FileTimes, VaultContext, VaultTypes } from './ports';
import { skipCovering } from './skippedFolders';

// One set of vault procedures for every backend (.specs/vault-router.md).
// Each backend builds the router once with its own wire shapes and calls it
// through `createCaller` with its ports: the server from its `onedriveEmbed`
// procedures, which keep their names, inputs and outputs, and (later) the
// runner from its `vaultRpc` action.
//
// Nothing here reads a table, a bucket or a model directly — that is what the
// ports are for — so nothing here can tell which backend it is running on.

/** How many files the meaning pass ranks before the list's own filters
 *  (a category) narrow them to a page. */
export const MEANING_CANDIDATES = 200;

const filterOf = (input: FilesInput): FileFilter => ({
  ingestStatus: input?.ingestStatus,
  factiiiId: input?.factiiiId,
  source: input?.source,
  query: input?.query
});

/**
 * One page of the vault's file ids, latest first, where a file's time is the
 * later of when it was added and when it last changed. An upload row keeps no
 * time of its own last change, so "changed" is read from the two times the
 * backend does keep for it: `ontologyAt`, stamped when Categorize last sorted
 * it, and its post's `updatedAt`, which moves when its text is written again
 * (a changed file read a second time).
 *
 * Ranked here and not in SQL: Prisma cannot order by the greater of columns
 * on two tables, and the vault's scope is a Prisma filter that a second, raw
 * copy would drift from. So it reads the three times for the whole scope on
 * every page: narrow rows, but all of them.
 */
export const latestFileIds = (
  all: FileTimes[],
  offset: number,
  limit: number
): string[] =>
  all
    .map((file) => ({
      id: file.id,
      at: Math.max(
        file.createdAt.getTime(),
        file.ontologyAt?.getTime() ?? 0,
        file.postUpdatedAt?.getTime() ?? 0
      )
    }))
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
    .slice(offset, offset + limit)
    .map((file) => file.id);

// Escape LIKE metacharacters so a query containing % or _ matches those
// characters instead of acting as a wildcard.
export const containsPattern = (query: string): string =>
  `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export const createVaultRouter = <T extends VaultTypes>() => {
  const t = initTRPC.context<VaultContext<T>>().create();
  const procedure = t.procedure;

  return t.router({
    files: procedure.input(filesInput).query(async ({ ctx, input }) => {
      const { caller } = ctx;
      const { db, embed, people } = ctx.ports;
      const offset = input?.cursor ?? 0;
      const limit = input?.limit ?? 50;
      const filter = filterOf(input);
      const query = input?.query ?? '';
      // No file has the words: the first page is the files nearest in
      // meaning instead, and there is no second.
      //
      // Oakbox's search when no file has the words: the files ranked by
      // their nearest content row to the query (`MIN(<=>)`, the `search`
      // procedure's semantic pass), nearest first. Candidates come from the
      // vault's accounts; the full scope is re-applied below, so a peer's
      // non-vault post never gets through. Same model and size as a
      // runner's Vault, so a runner's distances rank beside these
      // (.specs/runner-vault.md "Search across vaults").
      const byMeaning =
        input?.meaning === true &&
        query.length >= VAULT_SEARCH_MIN_CHARS &&
        offset === 0 &&
        !(await db.anyFile(caller, filter))
          ? // An embedder that does not answer leaves the words' empty
            // answer, not an error over the whole list.
            await (async () =>
              db.nearestFiles(
                caller,
                await embed.queryVector(query, caller.userId),
                MEANING_CANDIDATES
              ))().catch(() => null)
          : null;
      const distanceOf = new Map(
        byMeaning?.map((hit) => [hit.id, hit.distance])
      );
      const latest =
        input?.order === 'latest' && !byMeaning
          ? latestFileIds(await db.fileTimes(caller, filter), offset, limit)
          : null;
      const ranked = latest ?? byMeaning?.map((hit) => hit.id) ?? null;
      const found = await db.fileRows(
        caller,
        byMeaning
          ? {
              kind: 'idsWithin',
              filter: { ...filter, query: undefined },
              ids: byMeaning.map((hit) => hit.id)
            }
          : latest
            ? { kind: 'ids', ids: latest }
            : { kind: 'page', filter, offset, limit }
      );
      // A 'latest' or a meaning page comes back in the order its ids were
      // ranked in.
      const rows = ranked
        ? ranked
            .flatMap((id) => found.filter((row) => row.id === id))
            .slice(0, limit)
        : found;
      // This list is flat, so it has no folder rows to carry the mark
      // Categorize skips by (helpers/vaultSkippedFolders): each file says
      // which mark covers the folder it is in, as `folder` says of a folder.
      const marks = await db.skippedFolders(caller);
      const addedBy = await people.addedBy(
        caller,
        rows.map((row) => row.userId)
      );
      // Reshaped to the `_count.chunks` the list has always rendered, so the
      // move onto posts stays invisible to the client.
      const files = rows.map(({ chunks, userId, ...file }) => ({
        ...file,
        // A shared vault's file that another account added: who, for its
        // avatar. Delete, retry and the folder marks act on the caller's own
        // files only, so a client offers them where this is null.
        addedBy: addedBy(userId),
        skippedBy: skipCovering(
          marks,
          (file.name ?? '').split('/').slice(0, -1).join('/')
        ),
        _count: { chunks },
        // bge-base's cosine distance on a meaning page; null where the
        // words matched, or on no search.
        distance: distanceOf.get(file.id) ?? null
      }));
      const nextCursor =
        !byMeaning && files.length === limit ? offset + limit : undefined;
      return { files, nextCursor };
    }),

    // Direct first, semantic only as a fallback.
    //
    // If the query string appears verbatim anywhere in the viewer's documents,
    // those pages ARE the answer and nothing else is returned. Only when
    // nothing contains the words does the search fall back to meaning.
    //
    // The order matters for cost as much as for relevance: the direct pass
    // needs no query vector, so an exact-match search never calls the embedder
    // at all — no round trip from EC2 across the tunnel to the Mac Mini, no
    // ANE slot taken from a running folder sync.
    //
    // The mode is decided per query, not per page: a cheap existence probe
    // runs first, so scrolling can't start appending semantic results
    // underneath a list of direct ones.
    //
    // The direct pass matches content rows. A phrase that straddles two rows
    // is missed by it and picked up by the semantic fallback.
    //
    // Search the vault and return POSTS.
    //
    // Chunks are how the matching is done, never what comes back. A
    // `SearchVector` row is a slice of a document with an embedding on it, so
    // it is the right unit to compare a query against and the wrong unit to
    // show: one file would come back three times, as three fragments of
    // itself. Every pass ranks chunks, collapses them to the best chunk per
    // post, and hands back the posts in that order, hydrated through the same
    // DTO the feed uses so the client can render them with PostItem like any
    // other post.
    //
    // Three modes, one shape:
    //   no query   newest synced first
    //   direct     the words appear verbatim, so those posts ARE the answer
    //              and nothing is embedded (no embedder round trip at all)
    //   semantic   nothing contains the words, so fall back to meaning
    search: procedure.input(searchInput).query(async ({ ctx, input }) => {
      const { caller } = ctx;
      const { db, embed } = ctx.ports;
      const { query, cursor, limit } = input;
      const page = { offset: cursor, limit };

      const ranked = await (async () => {
        if (query.length < 2) return db.recentPosts(caller, page);

        const direct = await db.postsMatching(
          caller,
          containsPattern(query),
          page
        );
        // A verbatim hit anywhere means the direct pass owns the answer. Only
        // an empty FIRST page falls through, or scrolling would start
        // appending semantic results underneath direct ones.
        if (direct.length > 0 || cursor > 0) return direct;

        return db.nearestPosts(
          caller,
          await embed.queryVector(query, caller.userId),
          page
        );
      })();

      const postIds = ranked.map((r) => r.postId);
      const posts = await db.hydratePosts(caller, postIds);
      // The batch loader does not promise the order it was given, and rank is
      // the whole point of a search.
      //
      // Keyed on the uuid, because `PostDto.id` IS the uuid — the numeric id
      // never leaves the server. This used to look up `String(r.postId)` in
      // the same map, which is a numeric id stringified against a map of
      // uuids: it matched nothing, ever, so this procedure answered
      // `posts: []` for every query on every client while still returning a
      // `nextCursor`, which made it read as an empty vault rather than as a
      // broken search. Fixed 2026-09-11, found while building the Oakbox web
      // client.
      const byUuid = new Map(posts.map((post) => [post.id, post]));
      const ordered = ranked
        .map((r) => byUuid.get(r.uuid))
        .filter((post): post is T['post'] => post !== undefined);

      return {
        posts: ordered,
        nextCursor: postIds.length === limit ? cursor + limit : undefined
      };
    }),

    // Several files, or everything inside a folder (inputs.ts).
    deleteFiles: procedure.input(deleteFilesInput).mutation(({ ctx, input }) =>
      ctx.ports.db.deleteFiles(ctx.caller, {
        uploadIds: input.uploadIds,
        folder: input.folder,
        dryRun: input.dryRun
      })
    ),

    // A short-lived URL the client downloads from directly — bytes never
    // proxy through the backend either way. Which URL depends on where the
    // file actually lives; same call for all of them, because the caller
    // holds an uploadId and has no reason to know the difference.
    downloadUrl: procedure
      .input(downloadUrlInput)
      .mutation(async ({ ctx, input }) => {
        // The vault scope is part of the lookup. A post photo or an avatar is
        // this user's upload too, and signing one from here would hand the
        // vault's own route a URL to a file the vault does not hold. Not found
        // is the right answer for both an id that isn't theirs and one that
        // isn't in the vault.
        //
        // A shared vault's file opens for its peers too, by the same scope.
        const file = await ctx.ports.db.findFile(ctx.caller, input.uploadId);
        if (!file) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'File not found' });
        }
        return ctx.ports.objects.signDownload(file, {
          download: input.download,
          fallbackUserId: ctx.caller.userId
        });
      })
  });
};

export type VaultRouter<T extends VaultTypes> = ReturnType<
  typeof createVaultRouter<T>
>;
