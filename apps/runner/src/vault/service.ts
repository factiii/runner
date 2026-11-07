import { randomUUID } from 'node:crypto';

import type {
  BoardAgentAction,
  BoardAgentActionMap,
  RunnerVaultFile,
  RunnerVaultIngest,
  RunnerVaultNote,
  RunnerVaultStatus
} from '@shared/all/domains/electron';
import { MAX_VAULT_FILE_BYTES, VAULT_SEARCH_MIN_CHARS } from '@shared/all/domains/oakbox';
import type { VouchedScope } from '@shared/all/helpers/board-agent-core/runner-access';
import {
  vaultCategorizeStartSchema,
  vaultDeleteSchema,
  vaultDownloadSchema,
  vaultFilePostSchema,
  vaultFilesSchema,
  vaultNoteDeleteSchema,
  vaultNotesSchema,
  vaultReadSchema,
  vaultRpcSchema,
  vaultSearchSchema,
  vaultShareSetSchema,
  vaultUploadStartSchema,
  vaultWriteSchema
} from '@shared/all/validators';

import {
  deletableRows,
  VAULT_REFUSAL,
  vaultActionAllowed,
  vaultOwnerOnly,
  type VaultRole,
  vaultReaders,
  vaultRole
} from './access';
import { VaultChats } from './askChats';
import { VaultAskTools } from './askTools';
import type { VaultCategorize } from './categorize';
import type { VaultDb } from './db';
import type { Embedder } from './embedder';
import type { VaultIngest } from './ingest';
import type { FsObjectStore } from './objectStore';
import { VaultPosts } from './posts';
import type { RunnerVaultRouter } from './vaultRouter';

// The Vault's actions (.specs/runner-vault.md "Actions"): the cloud vault's
// rows in the runner's own database, and the bytes in its own store. The SQL
// is plain Postgres on the tables Prisma generates from the server's schema
// (vault.prisma), so it runs on the server's database as it is.
//
// A file is an Upload, a PRIVATE top-level Post linked through `_postUploads`,
// and the Post's content rows. A file lands with its path as its text (the
// cloud's attach-only body) and `ingestStatus` PENDING; the ingest
// (ingest.ts) then reads it, writes its rows and embeds them on this machine.
//
// `vaultRpc` is the shared vault router (vaultRouter.ts, .specs/vault-router.md):
// the server's own procedures on this database. `vaultFiles`, `vaultSearch`,
// `vaultDownload` and `vaultDelete` are the same four as this file's own SQL.
// No client sends `vaultRpc` yet: these four are what the web, Oakbox and the
// phone apps call (shared/utils/helpers/runnerVault.ts), so they stay until
// those clients, installed builds included, have moved to it.

const PAGE = 50;
const CATEGORIZE_RUNNING =
  'Categorize is running on this runner. Add files once it has finished, or stop it in Organize.';
const DOWNLOAD_EXPIRES_S = 900;
const NOT_HERE = 'That file is not in this vault.';
export const VAULT_ROUTER_UPDATING =
  'This runner is still updating its Vault. Try again in a minute.';
/** The files one Ask turn reads, and how much of each. About 6k tokens in
 *  all: enough to answer from, small enough for a 1B model's context. */
const ASK_FILES = 4;
const ASK_FILE_CHARS = 6_000;
/** The search box's own cap (vaultSearchSchema). */
const ASK_QUERY_CHARS = 200;
const ASK_TERM_MIN_CHARS = 4;
const ASK_TERMS = 4;
/** Words a question is made of that find every file. */
const ASK_STOP_WORDS = new Set([
  'what', 'when', 'where', 'which', 'who', 'whom', 'whose', 'does', 'have',
  'from', 'that', 'this', 'there', 'their', 'about', 'with', 'into', 'your',
  'mine', 'were', 'will', 'would', 'could', 'should', 'please', 'tell', 'show',
  'find', 'many', 'much', 'last', 'next', 'file', 'files'
]);

/** A question's longer words, longest first: the terms Ask searches one by
 *  one when the whole question finds nothing. Exported for its test. */
export const askTerms = (question: string): string[] =>
  [...new Set(question.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
    .filter((word) => word.length >= ASK_TERM_MIN_CHARS && !ASK_STOP_WORDS.has(word))
    .sort((a, b) => b.length - a.length)
    .slice(0, ASK_TERMS);

/** Who a channel is in the Vault (RunnerVault.enter). */
export type VaultCaller = {
  role: VaultRole;
  members: Set<string>;
  readers: number[];
  caller: string;
};

type UploadRow = {
  id: string;
  name: string | null;
  key: string;
  userId: number;
  createdAt: Date;
  ingestStatus: RunnerVaultFile['ingestStatus'] | null;
};

const UPLOAD_COLUMNS = 'u."id", u."name", u."key", u."userId", u."createdAt", u."ingestStatus"';

/** A substring pattern, with ILIKE's own wildcards taken literally (what
 *  Prisma's `contains` does for the cloud's `files`). */
const containsPattern = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const typeOf = (contentType: string): 'IMAGE' | 'VIDEO' | 'DOCUMENT' => {
  if (contentType.startsWith('image/')) return 'IMAGE';
  if (contentType.startsWith('video/')) return 'VIDEO';
  return 'DOCUMENT';
};

export class RunnerVault {
  private members: Promise<Set<string>> | null = null;
  private chatStore: VaultChats | null = null;
  private postStore: VaultPosts | null = null;
  private toolStore: VaultAskTools | null = null;

  constructor(
    private readonly db: VaultDb,
    private readonly store: FsObjectStore,
    private readonly ownerId: string,
    /** The members changed: the daemon tells the server. */
    private readonly onMembers: (members: string[]) => void,
    /** Reads and embeds what lands PENDING. */
    private readonly ingest: VaultIngest | null = null,
    /** Embeds a search's query, as the ingest embeds the rows. */
    private readonly embedder: Embedder | null = null,
    /** Categorize on this runner (categorize.ts); null where it has no
     *  models to run it on. */
    private readonly categorizer: VaultCategorize | null = null,
    /** The shared vault router on this Vault (vaultRouter.ts). It throws
     *  while its Prisma client is not installed yet; null on a Vault made
     *  without it (the tests of the old actions). */
    private readonly router: (() => RunnerVaultRouter) | null = null
  ) {}

  private categorize(): VaultCategorize {
    if (!this.categorizer) throw new Error('Categorize is not available on this runner.');
    return this.categorizer;
  }

  /** Ask's chats, in this Vault's database (askChats.ts). */
  get chats(): VaultChats {
    return (this.chatStore ??= new VaultChats(this.db));
  }

  /** Ask's research tools over this Vault (askTools.ts). A search's query
   *  is embedded as `search` embeds one; with the embedder not ready or
   *  failing, the tools search by words. */
  get askTools(): VaultAskTools {
    return (this.toolStore ??= new VaultAskTools(this.db, async (text) => {
      if (this.embedder?.state() !== 'ready') return null;
      return this.embedder.embed({ text }).catch(() => null);
    }));
  }

  /** A file's page and the kept notes (posts.ts). */
  private get posts(): VaultPosts {
    return (this.postStore ??= new VaultPosts(this.db));
  }

  /** The ingest's counts over the owner's readers (the owner and whoever
   *  they let in), for the owner's Remote connections. Null with no ingest. */
  async ingestCounts(): Promise<RunnerVaultIngest | null> {
    if (!this.ingest) return null;
    return this.ingest.status(vaultReaders(this.ownerId, await this.memberIds()));
  }

  /** Read what is PENDING, in the background. */
  kickIngest(): void {
    this.ingest?.kick();
  }

  /** The accounts the owner let in: the runner's own half of the share. */
  memberIds(): Promise<Set<string>> {
    if (!this.members) {
      this.members = this.db
        .query<{ memberId: number }>(
          'SELECT "memberId" FROM "VaultShare" WHERE "ownerId" = $1 AND "status" = \'ACCEPTED\'',
          [Number(this.ownerId)]
        )
        .then((rows) => new Set(rows.map((row) => String(row.memberId))));
      this.members.catch(() => {
        this.members = null;
      });
    }
    return this.members;
  }

  /** Who the channel behind `scope` is in this vault: its role, whose files
   *  it reads, and the account it acts as. Throws the refusal. */
  async enter(scope: VouchedScope): Promise<VaultCaller> {
    const members = await this.memberIds();
    const role = vaultRole(scope, members);
    if (!role) throw new Error(VAULT_REFUSAL);
    return {
      role,
      members,
      readers: vaultReaders(this.ownerId, members),
      caller: scope.role === 'owner' ? this.ownerId : scope.userId
    };
  }

  /** Answer one action for the channel behind `scope`. Throws the refusal. */
  async handle(
    action: BoardAgentAction,
    payload: unknown,
    scope: VouchedScope
  ): Promise<unknown> {
    const { role, members, readers, caller } = await this.enter(scope);
    if (!vaultActionAllowed(role, action)) throw new Error(vaultOwnerOnly(action));
    switch (action) {
      case 'vaultStatus':
        return this.status(role, readers, members);
      case 'vaultRpc': {
        if (!this.router) throw new Error(VAULT_ROUTER_UPDATING);
        const { path, input } = vaultRpcSchema.parse(payload);
        // The router's caller: the account it acts as, and whose rows it
        // reads (the owner's and every member's, as below).
        return this.router().call({ userId: Number(caller), vaultUsers: readers }, path, input);
      }
      // `vaultRpc` `files` on the shared router (see the top of this file).
      case 'vaultFiles':
        return this.files(vaultFilesSchema.parse(payload ?? {}), readers, caller, true);
      // `vaultRpc` `search`.
      case 'vaultSearch':
        return this.search(vaultSearchSchema.parse(payload), readers, caller);
      case 'vaultUploadStart': {
        // The cloud's ontology lock: no new file while a run sorts them.
        if (this.categorizer?.running()) throw new Error(CATEGORIZE_RUNNING);
        const file = vaultUploadStartSchema.parse(payload);
        const key = `vault/${caller}/${randomUUID()}/${file.name}`;
        const put = await this.store.presignPut(
          key,
          file.contentType,
          file.size,
          MAX_VAULT_FILE_BYTES
        );
        return { ticket: put.url } satisfies BoardAgentActionMap['vaultUploadStart']['result'];
      }
      case 'vaultWrite':
        return this.write(vaultWriteSchema.parse(payload), caller);
      // `vaultRpc` `downloadUrl`, whose ticket `vaultRead` redeems too.
      case 'vaultDownload':
        return this.download(vaultDownloadSchema.parse(payload).uploadId, readers);
      case 'vaultRead': {
        const { ticket, offset, length } = vaultReadSchema.parse(payload);
        const { bytes } = await this.store.readSigned(ticket, offset, length);
        return {
          content: Buffer.from(bytes).toString('base64'),
          encoding: 'base64'
        } satisfies BoardAgentActionMap['vaultRead']['result'];
      }
      // `vaultRpc` `deleteFiles`.
      case 'vaultDelete':
        return this.remove(vaultDeleteSchema.parse(payload).uploadIds, readers, caller);
      case 'vaultShareSet': {
        const { memberId, shared } = vaultShareSetSchema.parse(payload);
        return this.share(memberId, shared);
      }
      // The owner's alone (access.ts), so the caller is the owner.
      case 'vaultCategorizeStatus':
        return this.categorize().status(Number(caller));
      case 'vaultCategorizeStart':
        return this.categorize().start(
          vaultCategorizeStartSchema.parse(payload),
          Number(caller)
        );
      case 'vaultCategorizeCancel':
        return this.categorize().cancel(Number(caller));
      // The owner's too (access.ts).
      case 'vaultFilePost': {
        const { uploadId } = vaultFilePostSchema.parse(payload);
        const [row] = await this.db.query<UploadRow>(
          `SELECT ${UPLOAD_COLUMNS} FROM "Upload" u WHERE u."id" = $1 AND u."userId" = ANY($2::int[])`,
          [uploadId, readers]
        );
        if (!row) throw new Error(NOT_HERE);
        return this.posts.filePost(await this.toFile(row, caller));
      }
      case 'vaultNotes':
        return {
          notes: await this.posts.notes(Number(caller), vaultNotesSchema.parse(payload ?? {}).noteId)
        };
      case 'vaultNoteDelete':
        return {
          deleted: await this.posts.deleteNote(vaultNoteDeleteSchema.parse(payload).noteId, Number(caller))
        };
      default:
        throw new Error(`Unknown vault action: ${String(action)}`);
    }
  }

  /**
   * Keep a note for Ask's save tool (ask.ts), the owner's alone as every
   * note is (access.ts), then kick the ingest to embed it. An embedder that
   * is not there leaves the row for a later run (ingest.ts `drainNotes`);
   * with none installed the note is found by its words only.
   */
  async keepNote(
    { role, caller }: VaultCaller,
    input: { title: string; body: string; aiResearchId: number | null }
  ): Promise<RunnerVaultNote> {
    if (role !== 'owner') throw new Error(vaultOwnerOnly('vaultNotes'));
    const note = await this.posts.saveNote(input, Number(caller));
    this.ingest?.kick();
    return note;
  }

  private async status(
    role: RunnerVaultStatus['role'],
    readers: number[],
    members: ReadonlySet<string>
  ): Promise<RunnerVaultStatus> {
    const [{ files }] = await this.db.query<{ files: number }>(
      'SELECT count(*)::int AS "files" FROM "Upload" WHERE "userId" = ANY($1::int[])',
      [readers]
    );
    const prefixes = readers.map((id) => `vault/${id}/`);
    const objects = await this.store.list('vault/');
    const bytes = objects
      .filter((o) => prefixes.some((p) => o.key.startsWith(p)))
      .reduce((sum, o) => sum + o.size, 0);
    // A status read also picks up a backlog the embedder was not there for.
    this.ingest?.kick();
    return {
      role,
      files,
      bytes,
      members: role === 'owner' ? [...members] : [],
      ...(this.ingest ? { ingest: await this.ingest.status(readers) } : {})
    };
  }

  private async toFile(row: UploadRow, caller: string): Promise<RunnerVaultFile> {
    const head = await this.store.head(row.key);
    return {
      id: row.id,
      name: row.name ?? row.key,
      size: head?.size ?? 0,
      contentType: head?.contentType ?? 'application/octet-stream',
      createdAt: new Date(row.createdAt).toISOString(),
      ingestStatus: row.ingestStatus ?? 'PENDING',
      mine: String(row.userId) === caller,
      addedBy: String(row.userId) === caller ? null : String(row.userId)
    };
  }

  private async files(
    input: { query?: string; limit?: number; before?: string; factiiiId?: number },
    readers: number[],
    caller: string,
    /** With each file's categories: the list Organize shows. Search and Ask
     *  do not read them. */
    withTags = false
  ): Promise<BoardAgentActionMap['vaultFiles']['result']> {
    const limit = input.limit ?? PAGE;
    const query = input.query?.trim() ?? '';
    const pattern = query.length >= VAULT_SEARCH_MIN_CHARS ? containsPattern(query) : null;
    // The cloud's `files` with `query`: the words in the path, or in the text
    // read out of the file. Newest first, the id breaking a tie.
    const rows = await this.db.query<UploadRow>(
      `SELECT ${UPLOAD_COLUMNS}
         FROM "Upload" u
        WHERE u."userId" = ANY($1::int[])
          AND ($2::text IS NULL
               OR u."name" ILIKE $2
               OR EXISTS (
                 SELECT 1 FROM "_postUploads" pu
                   JOIN "Post" p ON p."id" = pu."A"
                   JOIN "PostContent" pc ON pc."postId" = p."id"
                  WHERE pu."B" = u."id" AND p."parentPostId" IS NULL
                    AND p."status" = 'PRIVATE' AND pc."text" ILIKE $2))
          AND ($3::text IS NULL OR (u."createdAt", u."id") <
               (SELECT b."createdAt", b."id" FROM "Upload" b WHERE b."id" = $3))
          AND ($5::int IS NULL OR EXISTS (
                 SELECT 1 FROM "_postUploads" pu
                   JOIN "PostFactiiiCount" c ON c."postId" = pu."A"
                  WHERE pu."B" = u."id" AND c."factiiiId" = $5))
        ORDER BY u."createdAt" DESC, u."id" DESC
        LIMIT $4`,
      [readers, pattern, input.before ?? null, limit + 1, input.factiiiId ?? null]
    );
    const page = rows.slice(0, limit);
    const tags = withTags ? await this.tagsOf(page.map((row) => row.id)) : null;
    return {
      files: await Promise.all(
        page.map(async (row) => ({
          ...(await this.toFile(row, caller)),
          ...(tags && { factiiiIds: tags.get(row.id) ?? [] })
        }))
      ),
      more: rows.length > limit
    };
  }

  /** The categories Categorize tagged each file with, in one read. */
  private async tagsOf(uploadIds: string[]): Promise<Map<string, number[]>> {
    if (uploadIds.length === 0) return new Map();
    const rows = await this.db.query<{ uploadId: string; factiiiIds: number[] }>(
      `SELECT pu."B" AS "uploadId", array_agg(DISTINCT c."factiiiId") AS "factiiiIds"
         FROM "_postUploads" pu
         JOIN "PostFactiiiCount" c ON c."postId" = pu."A"
        WHERE pu."B" = ANY($1::text[])
        GROUP BY pu."B"`,
      [uploadIds]
    );
    return new Map(rows.map((row) => [row.uploadId, row.factiiiIds.map(Number)]));
  }

  /**
   * Oakbox's search on this machine (.specs/runner-vault.md "Search across
   * vaults"): the cloud search's two passes. The words in a file's name or
   * text own the answer; only when no file has them is the query embedded
   * here and every file ranked by its nearest row (`MIN(<=>)`). Without Vault
   * search, or with an embedder that does not answer, the words pass is the
   * whole answer. The query goes nowhere else. The caller's kept notes are
   * found in both passes, as the cloud's search finds a saved note.
   */
  private async search(
    input: { query: string; limit?: number },
    readers: number[],
    caller: string
  ): Promise<BoardAgentActionMap['vaultSearch']['result']> {
    const limit = input.limit ?? PAGE;
    const words = await this.words(input.query, limit, readers, caller);
    if (words.length > 0) {
      return { hits: words.map((file) => ({ ...file, distance: null })), mode: 'words' };
    }
    if (this.embedder?.state() !== 'ready') return { hits: [], mode: 'names' };
    let vector: number[];
    try {
      vector = await this.embedder.embed({ text: input.query });
    } catch {
      return { hits: [], mode: 'names' };
    }
    const literal = `[${vector.join(',')}]`;
    const rows = await this.db.query<UploadRow & { distance: number }>(
      `SELECT ${UPLOAD_COLUMNS}, MIN(sv."vector" <=> $2::halfvec)::float8 AS "distance"
         FROM "Upload" u
         JOIN "_postUploads" pu ON pu."B" = u."id"
         JOIN "Post" p ON p."id" = pu."A"
         JOIN "PostContent" pc ON pc."postId" = p."id"
         JOIN "SearchVector" sv ON sv."postContentId" = pc."id"
        WHERE u."userId" = ANY($1::int[])
          AND p."parentPostId" IS NULL AND p."status" = 'PRIVATE'
        GROUP BY u."id"
        ORDER BY "distance" ASC, u."id" ASC
        LIMIT $3`,
      [readers, literal, limit]
    );
    const files = await Promise.all(
      rows.map(async ({ distance, ...row }) => ({
        ...(await this.toFile(row, caller)),
        distance: Number(distance)
      }))
    );
    // The caller's notes rank beside the files, nearest first.
    const notes = await this.posts.noteMeaning(Number(caller), literal, limit);
    const hits = [...files, ...notes].sort((a, b) => a.distance - b.distance).slice(0, limit);
    return { hits, mode: 'meaning' };
  }

  /** The words pass: the files whose name or text has `query`, then the
   *  caller's notes whose title or text has it. */
  private async words(
    query: string,
    limit: number,
    readers: number[],
    caller: string
  ): Promise<RunnerVaultFile[]> {
    const { files } = await this.files({ query, limit }, readers, caller);
    const trimmed = query.trim();
    if (trimmed.length < VAULT_SEARCH_MIN_CHARS || files.length >= limit) return files;
    const notes = await this.posts.noteWords(
      Number(caller),
      containsPattern(trimmed),
      limit - files.length
    );
    return [...files, ...notes];
  }

  /**
   * The files Ask reads for a question (.specs/runner-vault-ask.md "Ask with a
   * runner's model"): what Oakbox's search finds for it. A question rarely
   * holds a file's words as one phrase, so when the search finds too few its
   * longer words are tried one by one.
   */
  async askFind(
    question: string,
    { readers, caller }: VaultCaller,
    limit = ASK_FILES
  ): Promise<RunnerVaultFile[]> {
    const found = new Map<string, RunnerVaultFile>();
    const take = (files: RunnerVaultFile[]) => {
      for (const file of files) {
        if (found.size < limit && !found.has(file.id)) found.set(file.id, file);
      }
    };
    const query = question.trim().slice(0, ASK_QUERY_CHARS);
    if (query.length >= VAULT_SEARCH_MIN_CHARS) {
      take((await this.search({ query, limit }, readers, caller)).hits);
    }
    for (const term of askTerms(question)) {
      if (found.size >= limit) break;
      take(await this.words(term, limit, readers, caller));
    }
    return [...found.values()];
  }

  /** One file's text as the ingest read it, `[page N]` where it kept a page,
   *  cut at `chars`; null for a file the caller does not read. A note's id
   *  reads the caller's note. */
  async askText(
    uploadId: string,
    { readers, caller }: VaultCaller,
    chars: number
  ): Promise<{ file: RunnerVaultFile; text: string } | null> {
    const [row] = await this.db.query<UploadRow>(
      `SELECT ${UPLOAD_COLUMNS} FROM "Upload" u WHERE u."id" = $1 AND u."userId" = ANY($2::int[])`,
      [uploadId, readers]
    );
    if (!row) return this.posts.noteText(Number(caller), uploadId, chars);
    const rows = await this.db.query<{ text: string; page: number | null }>(
      `SELECT pc."text", pc."page"
         FROM "_postUploads" pu
         JOIN "Post" p ON p."id" = pu."A"
         JOIN "PostContent" pc ON pc."postId" = p."id"
        WHERE pu."B" = $1 AND p."parentPostId" IS NULL
        ORDER BY pc."seq" ASC`,
      [uploadId]
    );
    const text = rows
      .map((r) => (r.page === null ? r.text : `[page ${r.page}] ${r.text}`))
      .join('\n')
      .slice(0, chars);
    return { file: await this.toFile(row, caller), text };
  }

  /** What a model with no tools (Ollama) answers from: the files `askFind`
   *  finds, ASK_FILE_CHARS of each. */
  async askPassages(
    question: string,
    entered: VaultCaller
  ): Promise<{ file: RunnerVaultFile; text: string }[]> {
    const files = await this.askFind(question, entered);
    const read = await Promise.all(
      files.map((file) => this.askText(file.id, entered, ASK_FILE_CHARS))
    );
    return read.flatMap((passage) => (passage ? [passage] : []));
  }

  private async write(
    input: { ticket: string; offset: number; content: string; last?: boolean },
    caller: string
  ): Promise<BoardAgentActionMap['vaultWrite']['result']> {
    // A ticket names a key under its maker's folder: only they redeem it.
    const { key, received, head } = this.store.writeSigned(
      input.ticket,
      input.offset,
      Buffer.from(input.content, 'base64'),
      input.last === true,
      (ticketKey) => ticketKey.startsWith(`vault/${caller}/`)
    );
    if (!head) return { received, file: null };
    const name = key.split('/').slice(3).join('/');
    const id = randomUUID();
    try {
      // Upload, Post, its one content row and the link, together.
      await this.db.batch([
        {
          sql: `INSERT INTO "Upload" ("id", "key", "name", "userId", "type", "uploadSource", "ingestStatus", "sha256")
                VALUES ($1, $2, $3, $4, $5::"UploadType", 'S3', 'PENDING', $6)`,
          params: [id, key, name, Number(caller), typeOf(head.contentType), head.sha256]
        },
        {
          sql: `WITH post AS (
                  INSERT INTO "Post" ("userId", "title", "content", "status", "updatedAt")
                  VALUES ($1, $2, $2, 'PRIVATE', CURRENT_TIMESTAMP) RETURNING "id"
                ), content AS (
                  INSERT INTO "PostContent" ("postId", "seq", "text")
                  SELECT "id", 1, $2 FROM post
                )
                INSERT INTO "_postUploads" ("A", "B") SELECT "id", $3 FROM post`,
          params: [Number(caller), name, id]
        }
      ]);
    } catch (err) {
      await this.store.delete(key);
      throw err;
    }
    this.ingest?.kick();
    const [row] = await this.db.query<UploadRow>(
      `SELECT ${UPLOAD_COLUMNS} FROM "Upload" u WHERE u."id" = $1`,
      [id]
    );
    return { received, file: await this.toFile(row, caller) };
  }

  private async download(
    uploadId: string,
    readers: number[]
  ): Promise<BoardAgentActionMap['vaultDownload']['result']> {
    const [row] = await this.db.query<UploadRow>(
      `SELECT ${UPLOAD_COLUMNS} FROM "Upload" u WHERE u."id" = $1 AND u."userId" = ANY($2::int[])`,
      [uploadId, readers]
    );
    const head = row ? await this.store.head(row.key) : null;
    if (!row || !head) throw new Error(NOT_HERE);
    const name = row.name ?? row.key;
    return {
      ticket: await this.store.presignGet(row.key, DOWNLOAD_EXPIRES_S, name.split('/').pop()),
      size: head.size,
      name,
      contentType: head.contentType
    };
  }

  private async remove(
    uploadIds: string[],
    readers: number[],
    caller: string
  ): Promise<BoardAgentActionMap['vaultDelete']['result']> {
    const rows = await this.db.query<UploadRow>(
      `SELECT ${UPLOAD_COLUMNS} FROM "Upload" u WHERE u."id" = ANY($1::text[]) AND u."userId" = ANY($2::int[])`,
      [uploadIds, readers]
    );
    const { mine, kept } = deletableRows(rows, caller);
    if (mine.length > 0) {
      const ids = mine.map((row) => row.id);
      // Posts first (a post links to its upload many-to-many, so no cascade
      // reaches it), the rows second, the objects last, as the cloud does.
      await this.db.batch([
        {
          sql: `DELETE FROM "Post" WHERE "id" IN (
                  SELECT pu."A" FROM "_postUploads" pu WHERE pu."B" = ANY($1::text[]))
                AND "userId" = $2 AND "parentPostId" IS NULL`,
          params: [ids, Number(caller)]
        },
        { sql: 'DELETE FROM "Upload" WHERE "id" = ANY($1::text[])', params: [ids] }
      ]);
      await this.store.deleteMany(mine.map((row) => row.key));
    }
    return { deleted: mine.length, kept };
  }

  private async share(memberId: string, shared: boolean): Promise<RunnerVaultStatus> {
    if (memberId === this.ownerId) throw new Error('The owner already opens this vault.');
    await this.db.batch([
      shared
        ? {
            sql: `INSERT INTO "VaultShare" ("ownerId", "memberId", "status", "acceptedAt")
                  VALUES ($1, $2, 'ACCEPTED', CURRENT_TIMESTAMP)
                  ON CONFLICT ("ownerId", "memberId") DO UPDATE SET "status" = 'ACCEPTED'`,
            params: [Number(this.ownerId), Number(memberId)]
          }
        : {
            sql: 'DELETE FROM "VaultShare" WHERE "ownerId" = $1 AND "memberId" = $2',
            params: [Number(this.ownerId), Number(memberId)]
          }
    ]);
    this.members = null;
    const members = await this.memberIds();
    this.onMembers([...members]);
    return this.status('owner', vaultReaders(this.ownerId, members), members);
  }
}
