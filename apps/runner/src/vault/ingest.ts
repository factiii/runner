import type { RunnerVaultIngest } from '@shared/all/domains/electron';
import type { VaultObjectStore } from '@shared/all/domains/vaultStore';
import type { ExtractedPage } from '@shared/all/domains/vaultText';
import { chunkPages } from '@shared/all/helpers/postContent';

import type { VaultDb } from './db';
import { type Embedder, EmbedderError } from './embedder';
import { extractPages, isPhoto, isReadable, MAX_EXTRACT_BYTES, UnreadableError } from './extract';

// The Vault's ingest (.specs/runner-vault.md "Ingest"): a PENDING upload is
// read, cut into the post's content rows and embedded, one vector per row,
// all on this machine. The cloud's steps and limits (apps/server/src/helpers/
// vaultIngest.ts), so a file ends as the same rows and the same vectors in
// either place; the embedder is the cloud's models (embedderInstall.ts).
//
// Nothing goes to Factiii. With no embedder, or one that does not answer,
// files stay PENDING until it does.
//
// Each run then embeds the kept notes' rows that have no vector yet
// (posts.ts): a note just kept, one kept while the embedder was down, and
// one kept before notes were embedded. A note has no status of its own, so
// "no SearchVector" is its backlog, picked up by whichever run comes next.

/** The cloud's caps (vaultIngest.ts MAX_PAGES, MAX_CHUNKS). */
const MAX_PAGES = 400;
const MAX_CHUNKS = 20_000;
/** Rows embedded between writes, so a long file is not held in memory. */
const VECTOR_BATCH = 64;
const MAX_ERROR = 500;
/** What one note row's vector reads (textEmbed.ts MAX_CHARS): the embedder
 *  keeps 256 tokens. */
const NOTE_EMBED_CHARS = 2000;

type NoteRow = { id: number; text: string; title: string | null; first: boolean };

/** A note row as the server embeds a post's row (textEmbed.ts
 *  indexPostRows): markup stripped, the title on the first row. */
const noteEmbedText = (row: NoteRow): string => {
  const text = row.text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const parts = row.first ? ['Post', row.title?.trim() ?? '', text] : [text];
  return parts.filter(Boolean).join('\n').slice(0, NOTE_EMBED_CHARS);
};

type PendingRow = { id: string; key: string; name: string | null; postId: number | null };

const literal = (vector: number[]) => `[${vector.join(',')}]`;

export class VaultIngest {
  private run: Promise<void> | null = null;
  private current: string | null = null;
  /** Kicked while a run was going: look again when it ends. */
  private again = false;

  constructor(
    private readonly db: VaultDb,
    private readonly store: VaultObjectStore,
    private readonly embedder: Embedder
  ) {}

  /** Read what is PENDING, in the background. One run at a time. */
  kick(): void {
    if (this.embedder.state() !== 'ready') return;
    if (this.run) {
      this.again = true;
      return;
    }
    this.run = this.drain()
      .catch(() => undefined)
      .finally(() => {
        this.run = null;
        this.current = null;
        if (this.again) {
          this.again = false;
          this.kick();
        }
      });
  }

  /** Resolves when the current run (if any) has ended. For the tests. */
  async settled(): Promise<void> {
    while (this.run) await this.run;
  }

  /** The counts for these accounts' files, and what is being read. */
  async status(readers: number[]): Promise<RunnerVaultIngest> {
    const rows = await this.db.query<{ ingestStatus: string | null; count: number }>(
      `SELECT "ingestStatus", count(*)::int AS "count" FROM "Upload"
        WHERE "userId" = ANY($1::int[]) GROUP BY "ingestStatus"`,
      [readers]
    );
    const count = (status: string) => rows.find((r) => r.ingestStatus === status)?.count ?? 0;
    return {
      pending: count('PENDING'),
      embedded: count('EMBEDDED'),
      failed: count('FAILED'),
      running: this.run !== null,
      current: this.current,
      embedder: this.embedder.state()
    };
  }

  private async drain(): Promise<void> {
    // A file read in this run is not picked again in it, whatever it ended as.
    const seen: string[] = [];
    for (;;) {
      const [row] = await this.db.query<PendingRow>(
        `SELECT u."id", u."key", u."name",
                (SELECT pu."A" FROM "_postUploads" pu JOIN "Post" p ON p."id" = pu."A"
                  WHERE pu."B" = u."id" AND p."parentPostId" IS NULL
                  ORDER BY pu."A" LIMIT 1) AS "postId"
           FROM "Upload" u
          WHERE u."ingestStatus" = 'PENDING' AND NOT (u."id" = ANY($1::text[]))
          ORDER BY u."createdAt", u."id" LIMIT 1`,
        [seen]
      );
      if (!row) break;
      seen.push(row.id);
      this.current = row.name ?? row.key;
      try {
        await this.ingest(row);
      } catch (err) {
        // The embedder is down: the file stays PENDING, and so does the rest.
        if (err instanceof EmbedderError && err.transient) return;
        await this.fail(row.id, err);
      }
    }
    await this.drainNotes();
  }

  /** Every kept note's row with no vector, one at a time. The embedder
   *  going down leaves the rest for the next run; a row it refuses is tried
   *  again then. */
  private async drainNotes(): Promise<void> {
    const seen: number[] = [];
    for (;;) {
      const [row] = await this.db.query<NoteRow>(
        `SELECT pc."id", pc."text", p."title",
                pc."seq" = (SELECT MIN(f."seq") FROM "PostContent" f WHERE f."postId" = p."id") AS "first"
           FROM "PostContent" pc
           JOIN "Post" p ON p."id" = pc."postId"
          WHERE p."status" = 'PRIVATE' AND p."parentPostId" IS NULL
            AND NOT EXISTS (SELECT 1 FROM "_postUploads" pu WHERE pu."A" = p."id")
            AND NOT EXISTS (SELECT 1 FROM "SearchVector" sv WHERE sv."postContentId" = pc."id")
            AND NOT (pc."id" = ANY($1::int[]))
          ORDER BY pc."id" LIMIT 1`,
        [seen]
      );
      if (!row) return;
      seen.push(row.id);
      const text = noteEmbedText(row);
      if (!text) continue;
      this.current = row.title ?? 'A note';
      try {
        await this.writeVectors([{ id: row.id, text }]);
      } catch (err) {
        if (err instanceof EmbedderError && err.transient) return;
      }
    }
  }

  /** One file, PENDING to EMBEDDED. Throws a transient EmbedderError to
   *  leave it PENDING, anything else to mark it FAILED. */
  private async ingest(row: PendingRow): Promise<void> {
    if (row.postId === null) throw new UnreadableError('the file has no post');
    const name = row.name ?? row.key;
    const head = await this.store.head(row.key);
    if (!head) throw new UnreadableError('the file is missing from this machine');

    // Nothing to read: the path body slice 2 wrote stays, and is embedded as
    // the cloud embeds an attached file's post ("Post", title, body).
    if (!isReadable(name) || head.size > MAX_EXTRACT_BYTES) {
      const rows = await this.db.query<{ id: number; seq: number; text: string }>(
        'SELECT "id", "seq", "text" FROM "PostContent" WHERE "postId" = $1 ORDER BY "seq"',
        [row.postId]
      );
      await this.writeVectors(
        rows.map((r, i) => ({
          id: r.id,
          text: i === 0 ? ['Post', name, r.text].join('\n') : r.text
        }))
      );
      await this.done(row.id, null);
      return;
    }

    const bytes = await this.store.get(row.key);
    let pages: ExtractedPage[];
    try {
      pages = await extractPages(name, bytes, (b, ext) => this.embedder.read(b, ext));
    } catch (err) {
      // A 4xx from `/read` is the file, not the embedder.
      if (err instanceof EmbedderError && !err.transient) throw new UnreadableError(err.message);
      throw err;
    }
    if (pages.length > MAX_PAGES) throw new UnreadableError(`exceeds page cap (${MAX_PAGES})`);
    const chunks = chunkPages(pages);
    if (chunks.length === 0) throw new UnreadableError('no extractable text');
    if (chunks.length > MAX_CHUNKS) throw new UnreadableError(`exceeds chunk cap (${MAX_CHUNKS})`);

    // The rows replace the path body; their old vectors go with them
    // (cascade). The post's `content` is row 1, as the cloud's upsertVaultPost.
    const [, written] = await this.db.batch([
      { sql: 'DELETE FROM "PostContent" WHERE "postId" = $1', params: [row.postId] },
      {
        sql: `INSERT INTO "PostContent" ("postId", "seq", "text", "page")
              SELECT $1, t.seq, t.text, t.page
                FROM unnest($2::int[], $3::text[], $4::int[]) AS t(seq, text, page)
              RETURNING "id", "seq", "text"`,
        params: [
          row.postId,
          chunks.map((_, i) => i + 1),
          chunks.map((c) => c.text),
          chunks.map((c) => c.page)
        ]
      },
      {
        sql: 'UPDATE "Post" SET "content" = $2, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1',
        params: [row.postId, chunks[0].text]
      }
    ]);
    await this.writeVectors(written as { id: number; text: string }[]);

    // A photo's CLIP vector is its content search. Failing it does not fail
    // the file: its rows are already searchable (the cloud's rule).
    if (isPhoto(name)) {
      try {
        const vector = await this.embedder.embed({
          clipImage: Buffer.from(bytes).toString('base64')
        });
        await this.db.query(
          `INSERT INTO "MediaVector" ("uploadId", "vector", "updatedAt")
           VALUES ($1, $2::vector, CURRENT_TIMESTAMP)
           ON CONFLICT ("uploadId") DO UPDATE SET "vector" = EXCLUDED."vector", "updatedAt" = CURRENT_TIMESTAMP`,
          [row.id, literal(vector)]
        );
      } catch (err) {
        if (err instanceof EmbedderError && err.transient) throw err;
      }
    }
    await this.done(row.id, pages[0]?.source ?? 'TEXT_LAYER');
  }

  /** One bge vector per row, written a batch at a time. */
  private async writeVectors(rows: { id: number; text: string }[]): Promise<void> {
    for (let at = 0; at < rows.length; at += VECTOR_BATCH) {
      const batch = rows.slice(at, at + VECTOR_BATCH);
      const vectors: string[] = [];
      for (const r of batch) vectors.push(literal(await this.embedder.embed({ text: r.text })));
      await this.db.query(
        `INSERT INTO "SearchVector" ("postContentId", "vector", "updatedAt")
         SELECT t.id, t.v::halfvec, CURRENT_TIMESTAMP FROM unnest($1::int[], $2::text[]) AS t(id, v)
         ON CONFLICT ("postContentId") DO UPDATE SET "vector" = EXCLUDED."vector", "updatedAt" = CURRENT_TIMESTAMP`,
        [batch.map((r) => r.id), vectors]
      );
    }
  }

  private async done(uploadId: string, source: ExtractedPage['source'] | null): Promise<void> {
    await this.db.query(
      `UPDATE "Upload" SET "ingestStatus" = 'EMBEDDED', "ingestError" = NULL,
              "transcriptSource" = $2::"TranscriptSource" WHERE "id" = $1`,
      [uploadId, source]
    );
  }

  private async fail(uploadId: string, err: unknown): Promise<void> {
    const reason = (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR);
    await this.db
      .query(`UPDATE "Upload" SET "ingestStatus" = 'FAILED', "ingestError" = $2 WHERE "id" = $1`, [
        uploadId,
        reason
      ])
      .catch(() => undefined);
  }
}
