import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import type {
  RunnerVaultFile,
  RunnerVaultFilePost,
  RunnerVaultNote
} from '@shared/all/domains/electron';
import type { VouchedScope } from '@shared/all/helpers/board-agent-core/runner-access';
import { RUNNER_FILE_TEXT_CHARS } from '@shared/all/validators';

import { openVaultDb, type VaultDb } from './db';
import { FsObjectStore } from './objectStore';
import { RunnerVault } from './service';

// A runner file's page and the notes kept from Ask (.specs/runner-vault-ask.md "A
// runner file's page", "Kept research on the runner"), on a real PGlite.

const OWNER = { role: 'owner' as const, userId: '1', name: 'Owner' };
const PEER = { role: 'member' as const, spaceSlugs: [], userId: '2', name: 'Peer', vault: true };
const ENGINE = path.resolve(__dirname, '../..');
const AI_RESEARCH = 77;

describe('the Vault’s posts', () => {
  let db: VaultDb;
  let vault: RunnerVault;

  const add = async (name: string): Promise<RunnerVaultFile> => {
    const bytes = Buffer.from('x');
    const { ticket } = (await vault.handle(
      'vaultUploadStart',
      { name, size: bytes.length, contentType: 'text/plain' },
      OWNER
    )) as { ticket: string };
    const { file } = (await vault.handle(
      'vaultWrite',
      { ticket, offset: 0, content: bytes.toString('base64'), last: true },
      OWNER
    )) as { file: RunnerVaultFile };
    return file;
  };

  /** What the ingest leaves: the rows read off the file, page by page. */
  const read = async (fileId: string, rows: { text: string; page: number }[]) => {
    await db.batch([
      {
        sql: `DELETE FROM "PostContent" WHERE "postId" IN (SELECT "A" FROM "_postUploads" WHERE "B" = $1)`,
        params: [fileId]
      },
      {
        sql: `INSERT INTO "PostContent" ("postId", "seq", "text", "page")
              SELECT pu."A", t.seq, t.text, t.page FROM "_postUploads" pu,
                unnest($2::int[], $3::text[], $4::int[]) AS t(seq, text, page)
               WHERE pu."B" = $1`,
        params: [fileId, rows.map((_, i) => i + 1), rows.map((r) => r.text), rows.map((r) => r.page)]
      },
      {
        sql: `UPDATE "Upload" SET "ingestStatus" = 'EMBEDDED', "transcriptSource" = 'TEXT_LAYER' WHERE "id" = $1`,
        params: [fileId]
      }
    ]);
  };

  const post = async (uploadId: string) =>
    (await vault.handle('vaultFilePost', { uploadId }, OWNER)) as RunnerVaultFilePost;
  const notes = async () =>
    ((await vault.handle('vaultNotes', {}, OWNER)) as { notes: RunnerVaultNote[] }).notes;
  /** What Ask's save tool does (ask.ts). */
  const keep = async (
    input: { title: string; body: string; aiResearchId: number | null },
    scope: VouchedScope = OWNER
  ) => vault.keepNote(await vault.enter(scope), input);

  before(async () => {
    db = await openVaultDb({ dataDir: 'memory://', engineDir: ENGINE });
    const store = new FsObjectStore(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-vault-posts-')));
    vault = new RunnerVault(db, store, '1', () => {}, null, null, null);
    await vault.handle('vaultShareSet', { memberId: '2', shared: true }, OWNER);
  });
  after(async () => {
    await db.close();
  });

  it('says a file is not read yet, with no text and no path for text', async () => {
    const file = await add('Bills/power.pdf');
    const page = await post(file.id);
    assert.equal(page.file.name, 'Bills/power.pdf');
    assert.equal(page.file.ingestStatus, 'PENDING');
    assert.equal(page.transcriptSource, null);
    assert.equal(page.text, '');
    assert.equal(page.pieces, 0);
    assert.deepEqual(page.tags, []);
  });

  it('gives the text read off a file and its categories with their values', async () => {
    const file = await add('Bills/water.pdf');
    await read(file.id, [
      { text: 'A water bill', page: 1 },
      { text: '\n\nfor 42.', page: 2 }
    ]);
    // What Categorize writes: Bills (10) with no value, Amount (30) a number,
    // Due (40) a date and a place.
    const [{ postId }] = await db.query<{ postId: number }>(
      'SELECT "A" AS "postId" FROM "_postUploads" WHERE "B" = $1',
      [file.id]
    );
    for (const [factiiiId, number, display, when] of [
      [10, null, null, null],
      [30, 42, null, null],
      [40, null, 'Oban', '2026-08-14T12:00:00.000Z']
    ] as const) {
      await db.query(
        `WITH c AS (
           INSERT INTO "PostFactiiiCount" ("factiiiId", "postId") VALUES ($1, $2) RETURNING "id"
         ), t AS (
           INSERT INTO "PostFactiii" ("postFactiiiCountId", "userId", "status", "number", "updatedAt")
           SELECT "id", 1, 'APPROVED', $3, CURRENT_TIMESTAMP FROM c RETURNING "id"
         )
         INSERT INTO "SpaceTime" ("postFactiiiId", "display", "timestamp", "updatedAt")
         SELECT "id", $4, $5, CURRENT_TIMESTAMP FROM t WHERE $4::text IS NOT NULL`,
        [factiiiId, postId, number, display, when]
      );
    }
    await db.query('UPDATE "Upload" SET "ontologyAt" = CURRENT_TIMESTAMP WHERE "id" = $1', [file.id]);

    const page = await post(file.id);
    assert.equal(page.file.ingestStatus, 'EMBEDDED');
    assert.equal(page.transcriptSource, 'TEXT_LAYER');
    assert.equal(page.text, 'A water bill\n\nfor 42.');
    assert.equal(page.textChars, page.text.length);
    assert.equal(page.pieces, 2);
    assert.ok(page.categorizedAt);
    assert.deepEqual(page.tags, [
      { factiiiId: 10, entries: [{ data: null, number: null, spaceTimes: [] }] },
      { factiiiId: 30, entries: [{ data: null, number: 42, spaceTimes: [] }] },
      {
        factiiiId: 40,
        entries: [
          {
            data: null,
            number: null,
            spaceTimes: [{ timestamp: '2026-08-14T12:00:00.000Z', display: 'Oban' }]
          }
        ]
      }
    ]);
  });

  it('cuts a long file’s text and says how long the whole is', async () => {
    const file = await add('book.txt');
    const row = 'w'.repeat(900);
    const rows = Array.from({ length: 150 }, (_, i) => ({ text: row, page: i + 1 }));
    await read(file.id, rows);
    const page = await post(file.id);
    assert.equal(page.text.length, RUNNER_FILE_TEXT_CHARS);
    assert.equal(page.textChars, 150 * 900);
    assert.equal(page.pieces, 150);
  });

  it('is the owner’s alone, and only for a file in this vault', async () => {
    const file = await add('mine.txt');
    await assert.rejects(vault.handle('vaultFilePost', { uploadId: file.id }, PEER), /Only the owner/);
    await assert.rejects(
      vault.handle('vaultFilePost', { uploadId: '00000000-0000-4000-8000-000000000000' }, OWNER),
      /not in this vault/
    );
  });

  it('keeps a note as a post with no file, tagged AI Research, and lists it', async () => {
    const before = (await vault.handle('vaultFiles', {}, OWNER)) as { files: RunnerVaultFile[] };
    const note = await keep({
      title: 'Power bills',
      body: '<p>They rose 10%.</p>',
      aiResearchId: AI_RESEARCH
    });
    assert.equal(note.title, 'Power bills');
    assert.equal(note.body, '<p>They rose 10%.</p>');
    assert.deepEqual(
      (await notes()).map((n) => n.id),
      [note.id]
    );
    const [tag] = await db.query<{ factiiiId: number; entries: number }>(
      `SELECT c."factiiiId", (SELECT count(*)::int FROM "PostFactiii" t WHERE t."postFactiiiCountId" = c."id") AS "entries"
         FROM "PostFactiiiCount" c JOIN "Post" p ON p."id" = c."postId" WHERE p."uuid" = $1::uuid`,
      [note.id]
    );
    assert.deepEqual(tag, { factiiiId: AI_RESEARCH, entries: 1 });
    // A note is no file.
    const after = (await vault.handle('vaultFiles', {}, OWNER)) as { files: RunnerVaultFile[] };
    assert.equal(after.files.length, before.files.length);

    // One kept with no AI Research id carries no tag.
    const plain = await keep({ title: 'Plain', body: 'Text', aiResearchId: null });
    assert.deepEqual(
      (await notes()).map((n) => n.id),
      [plain.id, note.id]
    );
    // One note by its id, as a search hit opens it.
    assert.deepEqual(
      ((await vault.handle('vaultNotes', { noteId: note.id }, OWNER)) as { notes: RunnerVaultNote[] })
        .notes,
      [note]
    );
  });

  it('cuts a note as the server does, and keeps nothing empty', async () => {
    const long = await keep({ title: `  ${'t'.repeat(300)}`, body: ' <p>x</p> ', aiResearchId: null });
    assert.equal(long.title.length, 200);
    assert.equal(long.body, '<p>x</p>');
    await assert.rejects(keep({ title: 'Empty', body: '<p> </p>', aiResearchId: null }), /Nothing to save/);
    await vault.handle('vaultNoteDelete', { noteId: long.id }, OWNER);
  });

  it('deletes a note, and never a file’s post through it', async () => {
    const [first] = await notes();
    assert.deepEqual(await vault.handle('vaultNoteDelete', { noteId: first.id }, OWNER), {
      deleted: true
    });
    assert.ok(!(await notes()).some((n) => n.id === first.id));
    const [filePost] = await db.query<{ uuid: string }>(
      'SELECT p."uuid"::text AS "uuid" FROM "Post" p JOIN "_postUploads" pu ON pu."A" = p."id" LIMIT 1'
    );
    assert.deepEqual(await vault.handle('vaultNoteDelete', { noteId: filePost.uuid }, OWNER), {
      deleted: false
    });
    assert.equal(
      (await db.query('SELECT 1 FROM "Post" WHERE "uuid" = $1::uuid', [filePost.uuid])).length,
      1
    );
  });

  it('keeps the notes to the owner', async () => {
    await assert.rejects(vault.handle('vaultNotes', {}, PEER), /Only the owner/);
    await assert.rejects(keep({ title: 'x', body: 'y', aiResearchId: null }, PEER), /Only the owner/);
  });
});
