import type { z } from 'zod';

import type { INGEST_STATUS, VAULT_SOURCE } from './inputs';

// What the shared vault procedures (router.ts) ask of a backend
// (.specs/vault-router.md). The server answers them from Postgres, R2 and its
// embed service; the runner, later, from PGlite, its disk and its local
// embedder. The procedures hold the logic that is the same on both — which
// pass a search takes, how a page is ranked and shaped, what "not found" is —
// and a port holds only what differs: where the rows, objects and vectors are.

/**
 * The shapes a backend puts on the wire, so the server's clients keep reading
 * exactly the types they read before the router existed. Each backend fills
 * these in once, where it builds its adapter.
 */
export type VaultTypes = {
  // One row of the file list as the backend reads it, before the router adds
  // who added it, the skip mark, the chunk count and the distance.
  fileRow: { id: string; name: string | null };
  // A post as a search hands it back. `id` is its uuid.
  post: { id: string };
  // Who added a shared vault's file, for its avatar.
  person: unknown;
  // The file `downloadUrl` found, handed back to be signed.
  file: unknown;
  // What signing a download answers.
  download: unknown;
  // What a delete (or its dry run) answers.
  deleted: unknown;
};

/**
 * VaultAccess: who is calling, resolved by the backend before the router runs
 * (on the server, the session user who passed the premium gate). `vaultUsers`
 * is whose rows this caller reads: themselves first, then the others in a
 * vault shared with them. Reads scope on it; writes keep `userId`, because a
 * row belongs to the one account that made it.
 */
export type VaultCaller = { userId: number; vaultUsers: number[] };

/** How the file list narrows the vault. */
export type FileFilter = {
  ingestStatus?: z.infer<typeof INGEST_STATUS>;
  factiiiId?: number;
  source?: z.infer<typeof VAULT_SOURCE>;
  query?: string;
};

/** Which file rows to read. */
export type FileSelection =
  // A page of the filtered vault, newest added first.
  | { kind: 'page'; filter: FileFilter; offset: number; limit: number }
  // These ids, already scoped by an earlier read.
  | { kind: 'ids'; ids: string[] }
  // These ids, kept only where they are inside the filtered vault.
  | { kind: 'idsWithin'; filter: FileFilter; ids: string[] };

/** The three times a file's "latest" is the greatest of. */
export type FileTimes = {
  id: string;
  createdAt: Date;
  // When Categorize last sorted it.
  ontologyAt: Date | null;
  // Its post's `updatedAt`, which moves when its text is written again.
  postUpdatedAt: Date | null;
};

/** A vault post, by both of its ids: the number joins, the uuid is the DTO's. */
export type RankedPost = { postId: number; uuid: string };

export type PostPage = { offset: number; limit: number };

export type VaultDb<T extends VaultTypes> = {
  /** Whether any file is inside the filtered vault. */
  anyFile(caller: VaultCaller, filter: FileFilter): Promise<boolean>;
  /** Every file of the filtered vault, with the times its rank reads. */
  fileTimes(caller: VaultCaller, filter: FileFilter): Promise<FileTimes[]>;
  /**
   * The vault's files nearest to a query vector by their nearest content row,
   * nearest first, at most `limit`. Candidates only: the router re-applies
   * the full scope to them.
   */
  nearestFiles(
    caller: VaultCaller,
    vector: number[],
    limit: number
  ): Promise<{ id: string; distance: number }[]>;
  /** File rows, newest added first, with who owns each and its chunk count. */
  fileRows(
    caller: VaultCaller,
    selection: FileSelection
  ): Promise<(T['fileRow'] & { userId: number; chunks: number })[]>;
  /** The folder paths this account marked for Categorize to skip. */
  skippedFolders(caller: VaultCaller): Promise<string[]>;

  /** The vault's posts, newest first. */
  recentPosts(caller: VaultCaller, page: PostPage): Promise<RankedPost[]>;
  /** The vault's posts with a content row matching an ILIKE pattern. */
  postsMatching(
    caller: VaultCaller,
    pattern: string,
    page: PostPage
  ): Promise<RankedPost[]>;
  /** The vault's posts by their nearest content row to a query vector. */
  nearestPosts(
    caller: VaultCaller,
    vector: number[],
    page: PostPage
  ): Promise<RankedPost[]>;
  /** The posts as the client renders them. Any order. */
  hydratePosts(caller: VaultCaller, postIds: number[]): Promise<T['post'][]>;

  /** One vault file this caller may open, or null. */
  findFile(caller: VaultCaller, uploadId: string): Promise<T['file'] | null>;
  /** Delete the caller's own files, or count what would go. */
  deleteFiles(
    caller: VaultCaller,
    target: { uploadIds?: string[]; folder?: string[]; dryRun?: true }
  ): Promise<T['deleted']>;
};

/** VaultObjects: where a file's bytes are. */
type VaultObjects<T extends VaultTypes> = {
  signDownload(
    file: T['file'],
    options: { download?: boolean; fallbackUserId: number }
  ): Promise<T['download']>;
};

/** VaultEmbed: the text model a query is turned into a vector by. */
type VaultEmbed = {
  queryVector(text: string, userId: number): Promise<number[]>;
};

/** The people of a shared vault, for the rows another account added. */
type VaultPeople<T extends VaultTypes> = {
  /** Who added each row: null for the caller's own rows. */
  addedBy(
    caller: VaultCaller,
    ownerIds: number[]
  ): Promise<(ownerId: number) => T['person'] | null>;
};

export type VaultPorts<T extends VaultTypes> = {
  db: VaultDb<T>;
  objects: VaultObjects<T>;
  embed: VaultEmbed;
  people: VaultPeople<T>;
};

/** The router's context: the caller, and the backend that answers for it. */
export type VaultContext<T extends VaultTypes> = {
  caller: VaultCaller;
  ports: VaultPorts<T>;
};
