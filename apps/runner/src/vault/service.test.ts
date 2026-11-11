import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { RunnerVaultFile } from '@shared/all/domains/electron';

import { lazyVaultDb, migrate, openVaultDb, type VaultDb } from './db';
import { FsObjectStore } from './objectStore';
import { RunnerVault } from './service';

// The Vault end to end on a real database: PGlite in its own process, on the
// schema generated from the server's, with the cloud vault's rules.

const OWNER = { role: 'owner' as const, userId: '1', name: 'Owner' };
const PEER = { role: 'member' as const, spaceSlugs: [], userId: '2', name: 'Peer', vault: true };
const STRANGER = { ...PEER, userId: '3' };
const ENGINE = path.resolve(__dirname, '../..');

let db: VaultDb;
let vault: RunnerVault;
const reported: string[][] = [];

before(async () => {
  db = await openVaultDb({ dataDir: 'memory://', engineDir: ENGINE });
  const store = new FsObjectStore(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-vault-svc-')));
  vault = new RunnerVault(db, store, '1', (m) => reported.push(m));
});
after(async () => {
  await db.close();
});

async function add(scope: typeof OWNER | typeof PEER, name: string, body: string) {
  const bytes = Buffer.from(body);
  const { ticket } = (await vault.handle(
    'vaultUploadStart',
    { name, size: bytes.length, contentType: 'text/plain' },
    scope
  )) as { ticket: string };
  const half = Math.floor(bytes.length / 2);
  await vault.handle(
    'vaultWrite',
    { ticket, offset: 0, content: bytes.subarray(0, half).toString('base64') },
    scope
  );
  const { file } = (await vault.handle(
    'vaultWrite',
    { ticket, offset: half, content: bytes.subarray(half).toString('base64'), last: true },
    scope
  )) as { file: RunnerVaultFile };
  return file;
}

describe('runner vault', () => {
  it('runs each migration once', async () => {
    assert.deepEqual(await migrate(db), []);
  });

  it('stores a file as the cloud does: Upload, private Post, content row', async () => {
    const file = await add(OWNER, 'Taxes/2026/summary.txt', 'refund due');
    assert.equal(file.name, 'Taxes/2026/summary.txt');
    assert.equal(file.size, 10);
    assert.equal(file.mine, true);
    assert.equal(file.ingestStatus, 'PENDING');
    const [post] = await db.query<{ status: string; text: string }>(
      `SELECT p."status", pc."text" FROM "_postUploads" pu
         JOIN "Post" p ON p."id" = pu."A" JOIN "PostContent" pc ON pc."postId" = p."id"
        WHERE pu."B" = $1`,
      [file.id]
    );
    assert.deepEqual(post, { status: 'PRIVATE', text: 'Taxes/2026/summary.txt' });
  });

  it('keeps out a member the owner has not let in', async () => {
    await assert.rejects(vault.handle('vaultFiles', {}, PEER), /not shared with you/);
  });

  it('lets a peer in, who reads all, adds their own, deletes only their own', async () => {
    await assert.rejects(
      vault.handle('vaultShareSet', { memberId: '2', shared: true }, PEER),
      /not shared/
    );
    const status = (await vault.handle(
      'vaultShareSet',
      { memberId: '2', shared: true },
      OWNER
    )) as { members: string[] };
    assert.deepEqual(status.members, ['2']);
    assert.deepEqual(reported.at(-1), ['2']);
    await assert.rejects(
      vault.handle('vaultShareSet', { memberId: '3', shared: true }, PEER),
      /Only the owner/
    );
    await assert.rejects(vault.handle('vaultFiles', {}, STRANGER), /not shared/);

    const theirs = await add(PEER, 'Recipes/bread.txt', 'flour water salt');
    const { files } = (await vault.handle('vaultFiles', {}, PEER)) as {
      files: RunnerVaultFile[];
    };
    assert.deepEqual(files.map((f) => f.name), ['Recipes/bread.txt', 'Taxes/2026/summary.txt']);
    const ownerRow = files.find((f) => !f.mine);
    assert.equal(ownerRow?.addedBy, '1');

    const outcome = await vault.handle(
      'vaultDelete',
      { uploadIds: files.map((f) => f.id) },
      PEER
    );
    assert.deepEqual(outcome, { deleted: 1, kept: 1 });
    const left = (await vault.handle('vaultFiles', {}, OWNER)) as { files: RunnerVaultFile[] };
    assert.deepEqual(left.files.map((f) => f.name), ['Taxes/2026/summary.txt']);
    assert.ok(!left.files.some((f) => f.id === theirs.id));
  });

  it('searches path and text, contains-style, wildcards literal', async () => {
    await add(OWNER, 'Notes/100%_done.txt', 'x');
    const search = async (query: string) =>
      ((await vault.handle('vaultFiles', { query }, OWNER)) as { files: RunnerVaultFile[] }).files.map(
        (f) => f.name
      );
    assert.deepEqual(await search('TAXES'), ['Taxes/2026/summary.txt']);
    assert.deepEqual(await search('%_'), ['Notes/100%_done.txt']);
    assert.deepEqual(await search('nothing like it'), []);
    // Under two characters is no search: every file.
    assert.equal((await search('t')).length, 2);
  });

  it('pages newest first', async () => {
    const first = (await vault.handle('vaultFiles', { limit: 1 }, OWNER)) as {
      files: RunnerVaultFile[];
      more: boolean;
    };
    assert.equal(first.more, true);
    const next = (await vault.handle(
      'vaultFiles',
      { limit: 1, before: first.files[0].id },
      OWNER
    )) as { files: RunnerVaultFile[]; more: boolean };
    assert.equal(next.more, false);
    assert.notEqual(next.files[0].id, first.files[0].id);
  });

  it('downloads through a read ticket, for anyone in', async () => {
    const { files } = (await vault.handle('vaultFiles', { query: 'taxes' }, OWNER)) as {
      files: RunnerVaultFile[];
    };
    const { ticket, size } = (await vault.handle(
      'vaultDownload',
      { uploadId: files[0].id },
      PEER
    )) as { ticket: string; size: number };
    const { content } = (await vault.handle(
      'vaultRead',
      { ticket, offset: 0, length: size },
      PEER
    )) as { content: string };
    assert.equal(Buffer.from(content, 'base64').toString(), 'refund due');
  });

  it('refuses a write ticket redeemed by someone else', async () => {
    const { ticket } = (await vault.handle(
      'vaultUploadStart',
      { name: 'a.txt', size: 1, contentType: 'text/plain' },
      OWNER
    )) as { ticket: string };
    await assert.rejects(
      vault.handle('vaultWrite', { ticket, offset: 0, content: 'eA==', last: true }, PEER),
      /not yours/
    );
  });

  it('refuses a bad name or payload before anything is stored', async () => {
    await assert.rejects(
      vault.handle('vaultUploadStart', { name: '../x', size: 1, contentType: 't' }, OWNER),
      /Bad file name/
    );
    await assert.rejects(vault.handle('vaultDelete', { uploadIds: ['nope'] }, OWNER));
  });

  it('takes a peer out again', async () => {
    await vault.handle('vaultShareSet', { memberId: '2', shared: false }, OWNER);
    await assert.rejects(vault.handle('vaultStatus', {}, PEER), /not shared/);
    const status = (await vault.handle('vaultStatus', {}, OWNER)) as {
      files: number;
      bytes: number;
    };
    assert.deepEqual([status.files, status.bytes], [2, 11]);
  });
});

describe('lazyVaultDb', () => {
  it('opens on the first call, shares one start, and closes when idle', async () => {
    let opens = 0;
    let closes = 0;
    const fake: VaultDb = {
      query: async <T>() => [] as T[],
      batch: async () => [],
      driver: async () => undefined,
      close: async () => {
        closes += 1;
      },
      alive: () => opens === 1,
      dump: async () => new Uint8Array(0)
    };
    const lazy = lazyVaultDb(async () => {
      opens += 1;
      return fake;
    }, 20);
    assert.equal(lazy.isOpen(), false);
    await Promise.all([lazy.query('a'), lazy.query('b')]);
    assert.equal(opens, 1);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(lazy.isOpen(), false);
    assert.equal(closes, 1);
    await lazy.query('c');
    assert.equal(opens, 2);
    // The second process "died": the next call starts a third.
    await lazy.query('d');
    assert.equal(opens, 3);
    await lazy.close();
  });

  /** A fake process per open, each with its own life. */
  const fakes = () => {
    const made: { alive: boolean }[] = [];
    const openFake = async (): Promise<VaultDb> => {
      const life = { alive: true };
      made.push(life);
      return {
        query: async <T>() => [] as T[],
        batch: async () => [],
        driver: async () => undefined,
        close: async () => {
          life.alive = false;
        },
        alive: () => life.alive,
        dump: async () => new Uint8Array(0)
      };
    };
    return { made, openFake };
  };

  it('calls at once on a process that died start exactly one new one', async () => {
    const { made, openFake } = fakes();
    const lazy = lazyVaultDb(openFake, 1000);
    await lazy.query('a');
    made[0].alive = false;
    await Promise.all([lazy.query('b'), lazy.query('c'), lazy.query('d')]);
    assert.equal(made.length, 2);
    await lazy.query('e');
    assert.equal(made.length, 2);
    await lazy.close();
  });

  it('a start that failed under calls waiting on it is started again once', async () => {
    const { made, openFake } = fakes();
    let opens = 0;
    const lazy = lazyVaultDb(async () => {
      opens += 1;
      if (opens === 1) {
        await new Promise((r) => setTimeout(r, 5));
        throw new Error('did not start');
      }
      return openFake();
    }, 1000);
    const first = lazy.query('a');
    const waiting = Promise.all([lazy.query('b'), lazy.query('c')]);
    await assert.rejects(first, /did not start/);
    // b and c joined the failed start: each tries again, and they share it.
    await waiting;
    await lazy.query('d');
    assert.equal(made.length, 1);
    await lazy.close();
  });

  it('a process that died takes its open transactions with it', async () => {
    const { made, openFake } = fakes();
    const lazy = lazyVaultDb(openFake, 20);
    await lazy.driver({ op: 'begin' });
    await new Promise((r) => setTimeout(r, 60));
    // Under a transaction: not closed when idle.
    assert.equal(lazy.isOpen(), true);
    made[0].alive = false;
    await lazy.query('a');
    assert.equal(made.length, 2);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(lazy.isOpen(), false);
  });
});
