import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { RunnerVaultFile } from '@shared/all/domains/electron';
import SuperJSON from 'superjson';

import { openVaultDb, type VaultDb } from './db';
import { FsObjectStore } from './objectStore';
import { RunnerVault } from './service';
import { loadVaultClient, RunnerVaultRouter } from './vaultRouter';
import { vaultIpcAdapter } from './prismaIpc';

// The shared vault router on a runner (.specs/vault-router.md → What is in
// the router): the server's own procedures, run by `vaultRpc` on a real database —
// PGlite in its own process, the Prisma client here, the driver adapter's
// calls crossing between the two (prismaIpc.ts → dbChild.ts).

const OWNER = { role: 'owner' as const, userId: '1', name: 'Owner' };
const PEER = { role: 'member' as const, spaceSlugs: [], userId: '2', name: 'Peer', vault: true };
const STRANGER = { ...PEER, userId: '3' };
const ENGINE = path.resolve(__dirname, '../..');

let db: VaultDb;
let vault: RunnerVault;

before(async () => {
  db = await openVaultDb({ dataDir: 'memory://', engineDir: ENGINE });
  const store = new FsObjectStore(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-vault-rpc-')));
  const router = new RunnerVaultRouter(db, store, null, () => loadVaultClient(ENGINE));
  vault = new RunnerVault(db, store, '1', () => undefined, null, null, null, () => router);
});
after(async () => {
  await db.close();
});

type Scope = typeof OWNER | typeof PEER | typeof STRANGER;

async function add(scope: Scope, name: string, body: string): Promise<RunnerVaultFile> {
  const bytes = Buffer.from(body);
  const { ticket } = (await vault.handle(
    'vaultUploadStart',
    { name, size: bytes.length, contentType: 'text/plain' },
    scope
  )) as { ticket: string };
  const { file } = (await vault.handle(
    'vaultWrite',
    { ticket, offset: 0, content: bytes.toString('base64'), last: true },
    scope
  )) as { file: RunnerVaultFile };
  return file;
}

/** One router call, decoded as a client link decodes it. */
async function rpc<T>(scope: Scope, procedure: string, input?: unknown): Promise<T> {
  const encoded = (await vault.handle('vaultRpc', { path: procedure, input }, scope)) as Parameters<
    typeof SuperJSON.deserialize
  >[0];
  return SuperJSON.deserialize<T>(encoded);
}

type FilesPage = {
  files: {
    id: string;
    name: string | null;
    key: string;
    uploadSource: string;
    ingestStatus: string | null;
    createdAt: Date;
    addedBy: { userId: number } | null;
    skippedBy: string | null;
    _count: { chunks: number };
    distance: number | null;
  }[];
  nextCursor?: number;
};

describe('vaultRpc', () => {
  it('lists the whole vault with the server’s shapes, newest first', async () => {
    await add(OWNER, 'Taxes/2026/summary.txt', 'refund due');
    await add(OWNER, 'Notes/100%_done.txt', 'x');
    const page = await rpc<FilesPage>(OWNER, 'files');
    assert.deepEqual(
      page.files.map((f) => f.name),
      ['Notes/100%_done.txt', 'Taxes/2026/summary.txt']
    );
    const [first] = page.files;
    // Dates come back as dates: the result is SuperJSON, like the server's.
    assert.ok(first.createdAt instanceof Date);
    assert.equal(first.uploadSource, 'S3');
    assert.equal(first.ingestStatus, 'PENDING');
    assert.equal(first.addedBy, null);
    assert.equal(first.skippedBy, null);
    assert.deepEqual(first._count, { chunks: 0 });
    assert.equal(first.distance, null);
    assert.equal(page.nextCursor, undefined);
  });

  it('narrows by the words and pages by offset', async () => {
    const names = async (query: string) =>
      (await rpc<FilesPage>(OWNER, 'files', { query })).files.map((f) => f.name);
    assert.deepEqual(await names('TAXES'), ['Taxes/2026/summary.txt']);
    assert.deepEqual(await names('100%'), ['Notes/100%_done.txt']);
    assert.deepEqual(await names('nothing like it'), []);
    // Not pinned: whether `%` and `_` match literally. The file list's words
    // are Prisma's `contains`, which on 7.10.1 passes them through as ILIKE
    // wildcards, on the server as here (.specs/vault-router.md → Open questions).
    // The deprecated `vaultFiles` escaped them.
    const first = await rpc<FilesPage>(OWNER, 'files', { limit: 1 });
    assert.equal(first.nextCursor, 1);
    const next = await rpc<FilesPage>(OWNER, 'files', { limit: 1, cursor: 1 });
    assert.notEqual(next.files[0].id, first.files[0].id);
  });

  it('checks the procedure’s own input', async () => {
    await assert.rejects(rpc(OWNER, 'files', { limit: 0 }));
    await assert.rejects(rpc(OWNER, 'deleteFiles', {}), /Name the files, or the folder/);
    await assert.rejects(rpc(OWNER, 'nope' as never));
  });

  it('keeps out a stranger, and shows a member the owner’s files as theirs', async () => {
    await assert.rejects(rpc(STRANGER, 'files'), /not shared with you/);
    await vault.handle('vaultShareSet', { memberId: '2', shared: true }, OWNER);
    await add(PEER, 'Recipes/bread.txt', 'flour water salt');
    const page = await rpc<FilesPage>(PEER, 'files');
    assert.equal(page.files.length, 3);
    const owners = page.files.filter((f) => f.addedBy !== null);
    assert.deepEqual(
      owners.map((f) => f.addedBy),
      [{ userId: 1 }, { userId: 1 }]
    );
  });

  it('searches posts: the newest with no query, the words with one', async () => {
    type Found = { posts: { id: string; title: string | null; uploads: { name: string | null }[] }[] };
    const recent = await rpc<Found>(OWNER, 'search', { query: '' });
    // The caller's own posts only, as on the server.
    assert.deepEqual(
      recent.posts.map((p) => p.uploads[0]?.name),
      ['Notes/100%_done.txt', 'Taxes/2026/summary.txt']
    );
    // A file lands with its path as its text (service.ts `write`).
    const words = await rpc<Found>(OWNER, 'search', { query: 'summary' });
    assert.deepEqual(words.posts.map((p) => p.title), ['Taxes/2026/summary.txt']);
    assert.match(words.posts[0].id, /^[0-9a-f-]{36}$/);
    // Nothing has the words, and this runner has no embedder to rank by
    // meaning with: it says so, rather than reaching for the server's.
    await assert.rejects(rpc(OWNER, 'search', { query: 'zebra' }), /not ready on this runner/);
  });

  it('signs a download that vaultRead redeems, for anyone in', async () => {
    const [file] = (await rpc<FilesPage>(OWNER, 'files', { query: 'taxes' })).files;
    const signed = await rpc<{ ticket: string; size: number; name: string }>(PEER, 'downloadUrl', {
      uploadId: file.id
    });
    assert.equal(signed.name, 'Taxes/2026/summary.txt');
    const { content } = (await vault.handle(
      'vaultRead',
      { ticket: signed.ticket, offset: 0, length: signed.size },
      PEER
    )) as { content: string };
    assert.equal(Buffer.from(content, 'base64').toString(), 'refund due');
    await assert.rejects(
      rpc(OWNER, 'downloadUrl', { uploadId: 'not-a-file' }),
      /File not found/
    );
  });

  it('deletes the caller’s own files only, a folder whole, with a dry run first', async () => {
    const ids = (await rpc<FilesPage>(PEER, 'files')).files.map((f) => f.id);
    // The owner's two are not the member's to delete: not matched at all.
    assert.deepEqual(await rpc(PEER, 'deleteFiles', { uploadIds: ids }), {
      deleted: 1,
      kept: 0,
      matched: 1
    });
    assert.deepEqual(await rpc(OWNER, 'deleteFiles', { folder: ['Taxes'], dryRun: true }), {
      deleted: 0,
      kept: 0,
      matched: 1
    });
    assert.equal((await rpc<FilesPage>(OWNER, 'files')).files.length, 2);
    assert.deepEqual(await rpc(OWNER, 'deleteFiles', { folder: ['Taxes'] }), {
      deleted: 1,
      kept: 0,
      matched: 1
    });
    // Its post, content rows and object went with it.
    const [{ posts }] = await db.query<{ posts: number }>(
      `SELECT count(*)::int AS "posts" FROM "Post" WHERE "title" = 'Taxes/2026/summary.txt'`
    );
    assert.equal(posts, 0);
    assert.deepEqual(
      (await rpc<FilesPage>(OWNER, 'files')).files.map((f) => f.name),
      ['Notes/100%_done.txt']
    );
  });
});

describe('the Prisma client over the database process', () => {
  it('maps a unique violation to P2002 and rolls back an interactive transaction', async () => {
    const { PrismaClient } = loadVaultClient(ENGINE);
    const prisma = new PrismaClient({ adapter: vaultIpcAdapter(db) });
    await prisma.vaultShare.create({ data: { ownerId: 7, memberId: 8 } });
    await assert.rejects(
      prisma.vaultShare.create({ data: { ownerId: 7, memberId: 8 } }),
      (err: { code?: string }) => err.code === 'P2002'
    );
    await assert.rejects(
      prisma.$transaction(async (tx) => {
        await tx.vaultShare.create({ data: { ownerId: 9, memberId: 10 } });
        throw new Error('stop');
      }),
      /stop/
    );
    assert.equal(await prisma.vaultShare.count({ where: { ownerId: 9 } }), 0);
    // A runner batch waits for the transaction, not the other way round.
    const [done] = await Promise.all([
      prisma.$transaction(async (tx) => {
        await tx.vaultShare.create({ data: { ownerId: 11, memberId: 12 } });
        return tx.vaultShare.count({ where: { ownerId: 11 } });
      }),
      db.query('SELECT 1')
    ]);
    assert.equal(done, 1);
  });
});
