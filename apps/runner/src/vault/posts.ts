import type {
  RunnerTagEntry,
  RunnerVaultFile,
  RunnerVaultFilePost,
  RunnerVaultNote
} from '@shared/all/domains/electron';
import { joinRows } from '@shared/all/helpers/postContent';
import { runnerNoteFrom } from '@shared/all/helpers/runnerDocument';
import { RUNNER_FILE_TEXT_CHARS } from '@shared/all/validators';

import type { VaultDb } from './db';

// The Vault's posts as Oakbox reads them (.specs/runner-vault-ask.md "A runner
// file's page", "Kept research on the runner"), the owner's alone
// (access.ts):
//
// - A file's page: what the ingest read off it, a page marked where it kept
//   one, cut at RUNNER_FILE_TEXT_CHARS, and the categories Categorize gave it
//   with the values each holds. The cloud's Document screen, from the
//   runner's own tables.
// - Kept notes: what Ask's model kept with its save tool (ask.ts), as the
//   server keeps one (vaultSaveResearch.ts): a PRIVATE top-level post with no
//   file, its one content row the answer, tagged AI Research when the app
//   sends that id. Every file on a runner has an Upload, so a post with none
//   is a note; no factiii id is needed to tell them apart. The ingest embeds
//   its row (ingest.ts), so a search and Ask find it by meaning as they find
//   a file, shaped as a file marked `note` (`noteWords`, `noteMeaning`).

/** The server's list (`savedResearch`): a handful, each with its body. */
const NOTES = 20;

/** A time as the server's Prisma writes it: UTC with no zone. Read back as
 *  ISO text, never through the driver's local-time parse. */
export const utc = (column: string) => `to_char(${column}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const NOTE_COLUMNS = `p."uuid"::text AS "id", p."title", p."content" AS "body", ${utc('p."createdAt"')} AS "at"`;

/** A note: the caller's PRIVATE top-level post with no file behind it. */
const IS_NOTE = `p."userId" = $1 AND p."status" = 'PRIVATE' AND p."parentPostId" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "_postUploads" pu WHERE pu."A" = p."id")`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type NoteRow = { id: string; title: string | null; body: string; at: string };

const toNote = (row: NoteRow): RunnerVaultNote => ({
  id: row.id,
  title: row.title ?? 'Untitled',
  body: row.body,
  at: row.at
});

/** A note as a search and Ask list it: a file's shape, marked `note`.
 *  Waiting for the ingest while its row has no vector. */
const NOTE_FILE_COLUMNS = `p."uuid"::text AS "id", p."title", ${utc('p."createdAt"')} AS "at",
  length(p."content")::int AS "size",
  EXISTS (SELECT 1 FROM "PostContent" pc JOIN "SearchVector" sv ON sv."postContentId" = pc."id"
           WHERE pc."postId" = p."id") AS "embedded"`;

type NoteFileRow = { id: string; title: string | null; at: string; size: number; embedded: boolean };

const toNoteFile = (row: NoteFileRow): RunnerVaultFile => ({
  id: row.id,
  name: row.title ?? 'Untitled',
  size: row.size,
  contentType: 'text/html',
  createdAt: row.at,
  ingestStatus: row.embedded ? 'EMBEDDED' : 'PENDING',
  mine: true,
  addedBy: null,
  note: true
});

export class VaultPosts {
  constructor(private readonly db: VaultDb) {}

  /** One file's page. `file` is its row, already read for the caller. */
  async filePost(file: RunnerVaultFile): Promise<RunnerVaultFilePost> {
    const [upload] = await this.db.query<{
      ingestError: string | null;
      transcriptSource: string | null;
      ontologyAt: string | null;
      postId: number | null;
    }>(
      `SELECT u."ingestError", u."transcriptSource"::text AS "transcriptSource",
              ${utc('u."ontologyAt"')} AS "ontologyAt",
              (SELECT pu."A" FROM "_postUploads" pu JOIN "Post" p ON p."id" = pu."A"
                WHERE pu."B" = u."id" AND p."parentPostId" IS NULL LIMIT 1) AS "postId"
         FROM "Upload" u WHERE u."id" = $1`,
      [file.id]
    );
    const postId = upload?.postId ?? null;
    // Until the ingest reads it, its one row is its path (the attach-only
    // body), not text read off it; a file it could not open stays that way.
    const read = postId !== null && upload.transcriptSource !== null;
    const [rows, tags] = await Promise.all([
      read ? this.rows(postId) : Promise.resolve(null),
      postId === null ? Promise.resolve([]) : this.tags(postId)
    ]);
    return {
      file,
      ingestError: upload?.ingestError ?? null,
      transcriptSource: upload?.transcriptSource ?? null,
      categorizedAt: upload?.ontologyAt ?? null,
      text: rows?.text ?? '',
      textChars: rows?.chars ?? 0,
      pieces: rows?.pieces ?? 0,
      tags
    };
  }

  /** The text's first RUNNER_FILE_TEXT_CHARS, read only as far as that: a
   *  long file's rows past it never leave the database. */
  private async rows(postId: number): Promise<{ text: string; chars: number; pieces: number }> {
    const rows = await this.db.query<{ text: string; chars: number; pieces: number }>(
      `SELECT x."text", x."chars", x."pieces" FROM (
         SELECT pc."text", pc."seq",
                COALESCE(SUM(length(pc."text")) OVER (ORDER BY pc."seq"
                  ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS "before",
                SUM(length(pc."text")) OVER ()::int AS "chars",
                COUNT(*) OVER ()::int AS "pieces"
           FROM "PostContent" pc WHERE pc."postId" = $1) x
        WHERE x."before" < $2
        ORDER BY x."seq" ASC`,
      [postId, RUNNER_FILE_TEXT_CHARS]
    );
    return {
      text: joinRows(rows).slice(0, RUNNER_FILE_TEXT_CHARS),
      chars: rows[0]?.chars ?? 0,
      pieces: rows[0]?.pieces ?? 0
    };
  }

  /** Its categories, each with the values Categorize wrote (PostFactiii and
   *  its SpaceTime rows), in the order they were written. */
  private async tags(postId: number): Promise<RunnerVaultFilePost['tags']> {
    const rows = await this.db.query<{
      factiiiId: number;
      entryId: number | null;
      data: string | null;
      number: number | null;
      timestamp: string | null;
      display: string | null;
    }>(
      // A tag's date is written as UTC with no zone (categorize.ts).
      `SELECT c."factiiiId", t."id" AS "entryId", t."data", t."number", s."display",
              ${utc('s."timestamp"')} AS "timestamp"
         FROM "PostFactiiiCount" c
         LEFT JOIN "PostFactiii" t ON t."postFactiiiCountId" = c."id"
         LEFT JOIN "SpaceTime" s ON s."postFactiiiId" = t."id"
        WHERE c."postId" = $1
        ORDER BY c."id" ASC, t."id" ASC, s."id" ASC`,
      [postId]
    );
    const tags = new Map<number, Map<number, RunnerTagEntry>>();
    for (const row of rows) {
      const entries = tags.get(row.factiiiId) ?? new Map<number, RunnerTagEntry>();
      tags.set(row.factiiiId, entries);
      if (row.entryId === null) continue;
      const entry = entries.get(row.entryId) ?? {
        data: row.data,
        number: row.number === null ? null : Number(row.number),
        spaceTimes: []
      };
      entries.set(row.entryId, entry);
      if (row.timestamp !== null || row.display !== null) {
        entry.spaceTimes.push({ timestamp: row.timestamp, display: row.display });
      }
    }
    return [...tags].map(([factiiiId, entries]) => ({ factiiiId, entries: [...entries.values()] }));
  }

  /** The caller's notes, newest first; with `noteId`, that one alone. */
  async notes(owner: number, noteId?: string): Promise<RunnerVaultNote[]> {
    const rows = await this.db.query<NoteRow>(
      `SELECT ${NOTE_COLUMNS} FROM "Post" p
        WHERE ${IS_NOTE} AND ($2::uuid IS NULL OR p."uuid" = $2::uuid)
        ORDER BY p."createdAt" DESC, p."id" DESC LIMIT ${NOTES}`,
      [owner, noteId ?? null]
    );
    return rows.map(toNote);
  }

  /** The caller's notes whose title or text holds `pattern` (an ILIKE
   *  pattern, as the files' words pass), newest first. */
  async noteWords(owner: number, pattern: string, limit: number): Promise<RunnerVaultFile[]> {
    const rows = await this.db.query<NoteFileRow>(
      `SELECT ${NOTE_FILE_COLUMNS} FROM "Post" p
        WHERE ${IS_NOTE}
          AND (p."title" ILIKE $2 OR EXISTS (
                SELECT 1 FROM "PostContent" pc WHERE pc."postId" = p."id" AND pc."text" ILIKE $2))
        ORDER BY p."createdAt" DESC, p."id" DESC LIMIT $3`,
      [owner, pattern, limit]
    );
    return rows.map(toNoteFile);
  }

  /** The caller's notes ranked by their nearest row to `vector` (a halfvec
   *  literal), as the files' meaning pass ranks a file. */
  async noteMeaning(
    owner: number,
    vector: string,
    limit: number
  ): Promise<(RunnerVaultFile & { distance: number })[]> {
    const rows = await this.db.query<NoteFileRow & { distance: number }>(
      `SELECT ${NOTE_FILE_COLUMNS}, MIN(sv."vector" <=> $2::halfvec)::float8 AS "distance"
         FROM "Post" p
         JOIN "PostContent" pc ON pc."postId" = p."id"
         JOIN "SearchVector" sv ON sv."postContentId" = pc."id"
        WHERE ${IS_NOTE}
        GROUP BY p."id"
        ORDER BY "distance" ASC, p."id" ASC LIMIT $3`,
      [owner, vector, limit]
    );
    return rows.map(({ distance, ...row }) => ({ ...toNoteFile(row), distance: Number(distance) }));
  }

  /** One note's text for Ask, cut at `chars`; null when it is not the
   *  caller's note. */
  async noteText(
    owner: number,
    noteId: string,
    chars: number
  ): Promise<{ file: RunnerVaultFile; text: string } | null> {
    // A model may hand any text in as an id; only a uuid can be a note's.
    if (!UUID.test(noteId)) return null;
    const [row] = await this.db.query<NoteFileRow & { body: string }>(
      `SELECT ${NOTE_FILE_COLUMNS}, p."content" AS "body" FROM "Post" p
        WHERE ${IS_NOTE} AND p."uuid" = $2::uuid`,
      [owner, noteId]
    );
    if (!row) return null;
    const { body, ...file } = row;
    return { file: toNoteFile(file), text: body.slice(0, chars) };
  }

  /** Keep a note: the post, its one content row and its AI Research tag,
   *  together. The title and body are cut as the server cuts them
   *  (`runnerNoteFrom`); the ingest embeds the row once it is kicked. */
  async saveNote(
    input: { title: string; body: string; aiResearchId: number | null },
    owner: number
  ): Promise<RunnerVaultNote> {
    const note = runnerNoteFrom(input.title, input.body);
    if (!note) throw new Error('Nothing to save');
    const [row] = await this.db.query<NoteRow>(
      `WITH p AS (
         INSERT INTO "Post" ("userId", "title", "content", "status", "updatedAt")
         VALUES ($1, $2, $3, 'PRIVATE', CURRENT_TIMESTAMP)
         RETURNING "id", "uuid", "title", "content", "createdAt"
       ), body AS (
         INSERT INTO "PostContent" ("postId", "seq", "text") SELECT "id", 1, $3 FROM p
       ), c AS (
         INSERT INTO "PostFactiiiCount" ("factiiiId", "postId")
         SELECT $4::int, "id" FROM p WHERE $4::int IS NOT NULL RETURNING "id"
       ), t AS (
         INSERT INTO "PostFactiii" ("postFactiiiCountId", "userId", "status", "updatedAt")
         SELECT "id", $1, 'APPROVED', CURRENT_TIMESTAMP FROM c
       )
       SELECT ${NOTE_COLUMNS} FROM p`,
      [owner, note.title, note.body, input.aiResearchId]
    );
    return toNote(row);
  }

  /** Delete one of the caller's notes. Its content row and its tag go with
   *  it (cascade); a file's post is never reached. */
  async deleteNote(noteId: string, owner: number): Promise<boolean> {
    const rows = await this.db.query<{ id: number }>(
      `DELETE FROM "Post" p WHERE ${IS_NOTE} AND p."uuid" = $2::uuid RETURNING p."id"`,
      [owner, noteId]
    );
    return rows.length > 0;
  }
}
