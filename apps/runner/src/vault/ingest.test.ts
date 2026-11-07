import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { RunnerVaultFile, RunnerVaultStatus } from '@shared/all/domains/electron';
import type { ExtractedPage } from '@shared/all/domains/vaultText';
import { MAX_CONTENT_CHARS } from '@shared/all/helpers/postContent';
import type { EmbedRequest } from '@shared/all/validators';

import { openVaultDb, type VaultDb } from './db';
import { type Embedder, EmbedderError, type EmbedderState } from './embedder';
import { VaultIngest } from './ingest';
import { FsObjectStore } from './objectStore';
import { RunnerVault } from './service';

// The ingest on a real database (PGlite, the generated schema) with a fake
// embedder: PENDING to EMBEDDED, the cloud's rows and vectors, and what
// stays PENDING when the embedder is not there.

const OWNER = { role: 'owner' as const, userId: '1', name: 'Owner' };
const ENGINE = path.resolve(__dirname, '../..');

/** A unit vector that differs per text, so a test can tell rows apart. */
const vectorOf = (seed: string, dim: number) => {
  const v = Array.from({ length: dim }, (_, i) => Math.sin(i + seed.length));
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
};

class FakeEmbedder implements Embedder {
  embeds: EmbedRequest[] = [];
  reads: string[] = [];
  current: EmbedderState = 'ready';
  /** Throw this from the next call. */
  failNext: EmbedderError | null = null;
  pdfPages: ExtractedPage[] = [{ text: 'page one', source: 'TEXT_LAYER' }];

  state() {
    return this.current;
  }
  private take() {
    const fail = this.failNext;
    this.failNext = null;
    if (fail) throw fail;
  }
  async embed(body: EmbedRequest) {
    this.take();
    this.embeds.push(body);
    return vectorOf(body.text ?? body.clipText ?? 'image', body.clipImage ? 512 : 768);
  }
  async read(_bytes: Uint8Array, ext: 'pdf' | 'docx') {
    this.take();
    this.reads.push(ext);
    return this.pdfPages;
  }
  stop() {}
}

let db: VaultDb;
let vault: RunnerVault;
let ingest: VaultIngest;
let embedder: FakeEmbedder;

before(async () => {
  db = await openVaultDb({ dataDir: 'memory://', engineDir: ENGINE });
});
after(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.batch([{ sql: 'DELETE FROM "Post"' }, { sql: 'DELETE FROM "Upload"' }]);
  embedder = new FakeEmbedder();
  const store = new FsObjectStore(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-vault-ingest-')));
  ingest = new VaultIngest(db, store, embedder);
  vault = new RunnerVault(db, store, '1', () => {}, ingest);
});

async function add(name: string, body: Buffer | string, contentType = 'text/plain') {
  const bytes = Buffer.from(body);
  const { ticket } = (await vault.handle(
    'vaultUploadStart',
    { name, size: bytes.length, contentType },
    OWNER
  )) as { ticket: string };
  const { file } = (await vault.handle(
    'vaultWrite',
    { ticket, offset: 0, content: bytes.toString('base64'), last: true },
    OWNER
  )) as { file: RunnerVaultFile };
  return file;
}

const upload = async (id: string) =>
  (
    await db.query<{ ingestStatus: string; ingestError: string | null; transcriptSource: string | null }>(
      'SELECT "ingestStatus", "ingestError", "transcriptSource" FROM "Upload" WHERE "id" = $1',
      [id]
    )
  )[0];

const rowsOf = (id: string) =>
  db.query<{ seq: number; text: string; page: number | null; vectors: number }>(
    `SELECT pc."seq", pc."text", pc."page",
            (SELECT count(*)::int FROM "SearchVector" sv WHERE sv."postContentId" = pc."id") AS "vectors"
       FROM "_postUploads" pu JOIN "PostContent" pc ON pc."postId" = pu."A"
      WHERE pu."B" = $1 ORDER BY pc."seq"`,
    [id]
  );

describe('vault ingest', () => {
  it('reads a text file into the cloud’s rows, one vector per row', async () => {
    const long = `${'The refund is due in March. '.repeat(80)}`.trim();
    const file = await add('Taxes/notes.txt', long);
    await ingest.settled();
    const rows = await rowsOf(file.id);
    assert.ok(rows.length > 1, 'a long file is cut into rows');
    assert.ok(rows.every((r) => r.text.length <= MAX_CONTENT_CHARS && r.vectors === 1));
    assert.deepEqual(
      rows.map((r) => r.seq),
      rows.map((_, i) => i + 1)
    );
    assert.equal(rows.map((r) => r.text).join(''), long);
    const [post] = await db.query<{ content: string }>(
      'SELECT p."content" FROM "_postUploads" pu JOIN "Post" p ON p."id" = pu."A" WHERE pu."B" = $1',
      [file.id]
    );
    assert.equal(post.content, rows[0].text);
    assert.deepEqual(await upload(file.id), {
      ingestStatus: 'EMBEDDED',
      ingestError: null,
      transcriptSource: 'TEXT_LAYER'
    });
    // The vectors are the cloud's halfvec(768), searchable with <=>.
    const [hit] = await db.query<{ distance: number }>(
      `SELECT min(sv."vector" <=> $1::halfvec) AS "distance" FROM "SearchVector" sv`,
      [`[${vectorOf(rows[0].text, 768).join(',')}]`]
    );
    assert.ok(hit.distance < 0.01);
  });

  it('attaches a file it cannot read: its path is embedded as a post', async () => {
    const file = await add('Archive/photos.zip', 'PK', 'application/zip');
    await ingest.settled();
    assert.deepEqual(
      (await rowsOf(file.id)).map((r) => [r.text, r.vectors]),
      [['Archive/photos.zip', 1]]
    );
    assert.equal(embedder.embeds[0].text, 'Post\nArchive/photos.zip\nArchive/photos.zip');
    assert.deepEqual(await upload(file.id), {
      ingestStatus: 'EMBEDDED',
      ingestError: null,
      transcriptSource: null
    });
  });

  it('reads a PDF through the embedder, page numbers kept', async () => {
    embedder.pdfPages = [
      { text: 'first page', source: 'OCR' },
      { text: 'second page', source: 'OCR' }
    ];
    const file = await add('Scans/lease.pdf', '%PDF-1.7', 'application/pdf');
    await ingest.settled();
    assert.deepEqual(embedder.reads, ['pdf']);
    assert.deepEqual(
      (await rowsOf(file.id)).map((r) => r.page),
      [1, 2]
    );
    assert.equal((await upload(file.id)).transcriptSource, 'OCR');
  });

  it('gives a photo its CLIP vector beside its name row', async () => {
    const file = await add('Trips/beach.jpg', Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg');
    await ingest.settled();
    assert.deepEqual(
      (await rowsOf(file.id)).map((r) => r.text),
      ['Photo: Trips/beach.jpg']
    );
    const [media] = await db.query<{ count: number }>(
      'SELECT count(*)::int AS "count" FROM "MediaVector" WHERE "uploadId" = $1',
      [file.id]
    );
    assert.equal(media.count, 1);
    assert.equal((await upload(file.id)).transcriptSource, 'VISION');
  });

  it('marks a file that cannot be read FAILED, with why', async () => {
    const empty = await add('empty.txt', '   ');
    await ingest.settled();
    assert.deepEqual(await upload(empty.id), {
      ingestStatus: 'FAILED',
      ingestError: 'file is empty',
      transcriptSource: null
    });
    embedder.failNext = new EmbedderError('could not read pdf: broken', false);
    const broken = await add('broken.pdf', 'nope', 'application/pdf');
    await ingest.settled();
    assert.equal((await upload(broken.id)).ingestStatus, 'FAILED');
    assert.equal((await upload(broken.id)).ingestError, 'could not read pdf: broken');
  });

  it('leaves files PENDING while the embedder is away, and reads them when it is back', async () => {
    embedder.current = 'missing';
    const file = await add('later.md', '# Later');
    await ingest.settled();
    assert.equal((await upload(file.id)).ingestStatus, 'PENDING');
    const waiting = await ingest.status([1]);
    assert.equal(waiting.embedder, 'missing');
    assert.equal(waiting.pending, 1);

    embedder.current = 'ready';
    embedder.failNext = new EmbedderError('The vault’s embedder did not answer.', true);
    ingest.kick();
    await ingest.settled();
    assert.equal((await upload(file.id)).ingestStatus, 'PENDING', 'a transient failure is not FAILED');

    // The owner's next status read picks up the backlog.
    await vault.handle('vaultStatus', {}, OWNER);
    await ingest.settled();
    assert.equal((await upload(file.id)).ingestStatus, 'EMBEDDED');
    const status = (await vault.handle('vaultStatus', {}, OWNER)) as RunnerVaultStatus;
    assert.deepEqual(
      { ...status.ingest, running: false },
      { pending: 0, embedded: 1, failed: 0, running: false, current: null, embedder: 'ready' }
    );
  });

  it('a file read again replaces its rows and their vectors', async () => {
    const file = await add('notes.txt', 'first version');
    await ingest.settled();
    await db.query(`UPDATE "Upload" SET "ingestStatus" = 'PENDING' WHERE "id" = $1`, [file.id]);
    ingest.kick();
    await ingest.settled();
    const rows = await rowsOf(file.id);
    assert.deepEqual(
      rows.map((r) => [r.text, r.vectors]),
      [['first version', 1]]
    );
    const [all] = await db.query<{ count: number }>(
      'SELECT count(*)::int AS "count" FROM "SearchVector"'
    );
    assert.equal(all.count, 1, 'the old rows’ vectors went with them');
  });
});

describe('kept notes', () => {
  const OWNER_CALLER = () => vault.enter(OWNER);
  const keep = async (title: string, body: string) =>
    vault.keepNote(await OWNER_CALLER(), { title, body, aiResearchId: null });
  const vectorsOf = async (noteId: string) =>
    (
      await db.query<{ count: number }>(
        `SELECT count(*)::int AS "count" FROM "SearchVector" sv
           JOIN "PostContent" pc ON pc."id" = sv."postContentId"
           JOIN "Post" p ON p."id" = pc."postId" WHERE p."uuid" = $1::uuid`,
        [noteId]
      )
    )[0].count;

  it('embeds a note as it is kept, the server’s way: markup gone, title first', async () => {
    const note = await keep('Boiler', '<p>Serviced in <b>March</b>.</p>');
    await ingest.settled();
    assert.equal(await vectorsOf(note.id), 1);
    assert.deepEqual(
      embedder.embeds.map((e) => e.text),
      ['Post\nBoiler\nServiced in March .']
    );
  });

  it('leaves a note kept while the embedder is away, and embeds it on a later run', async () => {
    embedder.current = 'missing';
    const note = await keep('Later', '<p>Kept offline.</p>');
    await ingest.settled();
    assert.equal(await vectorsOf(note.id), 0);

    embedder.current = 'ready';
    embedder.failNext = new EmbedderError('The vault’s embedder did not answer.', true);
    ingest.kick();
    await ingest.settled();
    assert.equal(await vectorsOf(note.id), 0, 'a transient failure leaves it for the next run');

    // The owner's next status read picks up the backlog, as for a file.
    await vault.handle('vaultStatus', {}, OWNER);
    await ingest.settled();
    assert.equal(await vectorsOf(note.id), 1);
  });

  it('backfills a note kept before notes were embedded', async () => {
    // What an older runner left: the post and its row, no vector.
    const [old] = await db.query<{ uuid: string }>(
      `WITH p AS (
         INSERT INTO "Post" ("userId", "title", "content", "status", "updatedAt")
         VALUES (1, 'hey whats u', '<p>Hello.</p>', 'PRIVATE', CURRENT_TIMESTAMP) RETURNING "id", "uuid"
       ), c AS (INSERT INTO "PostContent" ("postId", "seq", "text") SELECT "id", 1, '<p>Hello.</p>' FROM p)
       SELECT "uuid"::text AS "uuid" FROM p`
    );
    const file = await add('done.txt', 'already read');
    await ingest.settled();
    // A run for anything embeds it too; a file's rows are the file's.
    assert.equal(await vectorsOf(old.uuid), 1);
    assert.equal((await upload(file.id)).ingestStatus, 'EMBEDDED');
    assert.equal(embedder.embeds.at(-1)?.text, 'Post\nhey whats u\nHello.');
  });
});
