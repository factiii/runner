import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import type {
  RunnerCategorizeStatus,
  RunnerVaultFile
} from '@shared/all/domains/electron';
import type { RunnerCategorizePayload } from '@shared/all/validators';

import {
  type CategorizeEngines,
  parseTagAnswer,
  readTree,
  tagFile,
  tagFor,
  VaultCategorize
} from './categorize';
import { openVaultDb, type VaultDb } from './db';
import { FsObjectStore } from './objectStore';
import { RunnerVault } from './service';

// Categorize on the runner (.specs/runner-vault-ask.md "Categorize on the runner"):
// the server's walk with the runner's models, a fake one here, and the tags
// in the Vault's own tables.

const OWNER = { role: 'owner' as const, userId: '1', name: 'Owner' };
const PEER = { role: 'member' as const, spaceSlugs: [], userId: '2', name: 'Peer', vault: true };
const ENGINE = path.resolve(__dirname, '../..');

const node = (id: number, name: string, requirements: string[] = [], slug = name.toLowerCase()) => ({
  id,
  slug,
  name,
  description: `Rule for ${name}.`,
  requirements
});

// Bills (10) > Power (11) > Late (12); Research (20); Amount (30) reads a number.
const TREE: RunnerCategorizePayload['tree'] = {
  nodes: [
    node(10, 'Bills', ['ROOT']),
    node(11, 'Power'),
    node(12, 'Late'),
    node(20, 'Research', ['ROOT']),
    node(30, 'Amount', ['ROOT', 'INTEGER_REQUIRED'])
  ],
  roots: [10, 20, 30],
  edges: [
    { parentId: 10, childId: 11 },
    { parentId: 11, childId: 12 }
  ]
};

/** The ids a prompt asks about, in order. */
const askedIds = (prompt: string) => [...prompt.matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1]));

describe('reading an answer', () => {
  it('takes the JSON a model talks around, and nothing else', () => {
    assert.deepEqual(parseTagAnswer('Sure! {"tags":[{"id":10}]} Hope that helps.'), {
      tags: [{ id: 10 }],
      notResearch: false
    });
    assert.equal(parseTagAnswer('I cannot tell.'), null);
    assert.equal(parseTagAnswer('{"tags": [}'), null);
    assert.equal(parseTagAnswer('{"notResearch": true}')?.notResearch, true);
    // A small model's sloppy list: bare ids and nulls dropped, "10" read as 10.
    assert.deepEqual(parseTagAnswer('{"tags":[12,null,{"id":"10"}]}')?.tags, [{ id: 10 }]);
  });

  it('keeps a tag only when its requirements are met', () => {
    const amount = node(30, 'Amount', ['INTEGER_REQUIRED']);
    assert.equal(tagFor(amount, { id: 30 }), null);
    assert.equal(tagFor(amount, { id: 30, data: 'about ten' }), null);
    assert.deepEqual(tagFor(amount, { id: 30, data: '12.5' }), {
      id: 30,
      data: null,
      number: 12.5,
      place: null,
      when: null
    });
    // No geocoder on a runner: the place is kept as written.
    const trip = node(40, 'Trip', ['LOCATION_REQUIRED', 'TIME_REQUIRED']);
    const tag = tagFor(trip, { id: 40, place: 'Oban, Scotland', date: '2026-08-14' });
    assert.equal(tag?.place, 'Oban, Scotland');
    assert.equal(tag?.when?.toISOString(), '2026-08-14T12:00:00.000Z');
    assert.equal(tagFor(trip, { id: 40, place: 'Oban, Scotland' }), null);
  });
});

describe('the walk', () => {
  it('asks the roots, then only what hangs under a match, round by round', async () => {
    const asked: number[][] = [];
    const answers: Record<string, string> = {
      '10,20,30': '{"tags":[{"id":10},{"id":99},{"id":30,"data":"42"}]}',
      '11': '{"tags":[{"id":11}]}',
      '12': '{"tags":[]}'
    };
    const { tags } = await tagFile(
      { name: 'bill.txt', text: 'Electricity bill, 42 due.' },
      readTree(TREE),
      async (_system, prompt) => {
        const ids = askedIds(prompt);
        asked.push(ids);
        return answers[ids.join(',')] ?? '{"tags":[]}';
      },
      false
    );
    assert.deepEqual(asked, [[10, 20, 30], [11], [12]]);
    // 99 was invented: never written.
    assert.deepEqual(
      tags.map((t) => [t.id, t.number]),
      [
        [10, null],
        [30, 42],
        [11, null]
      ]
    );
  });

  it('never asks under a category that did not match', async () => {
    const asked: number[][] = [];
    await tagFile(
      { name: 'note.txt', text: 'Nothing here.' },
      readTree(TREE),
      async (_system, prompt) => {
        asked.push(askedIds(prompt));
        return '{"tags":[]}';
      },
      false
    );
    assert.deepEqual(asked, [[10, 20, 30]]);
  });

  it('makes a Markdown file research unless the model says it is not', async () => {
    const silent = await tagFile(
      { name: 'ideas.md', text: '# Ideas' },
      readTree(TREE),
      async () => 'no JSON at all',
      false
    );
    assert.deepEqual(
      silent.tags.map((t) => t.id),
      [20]
    );
    const vetoed = await tagFile(
      { name: 'CHANGELOG.md', text: '# 1.0.1' },
      readTree(TREE),
      async () => '{"tags":[],"notResearch":true}',
      false
    );
    assert.deepEqual(vetoed, { tags: [], notResearch: true });
  });

  it('asks a long file a piece at a time, and stops asking what is answered', async () => {
    const pieces: number[][] = [];
    const text = Array.from({ length: 6 }, (_, i) => `Paragraph ${i} ${'word '.repeat(600)}`).join('\n\n');
    await tagFile(
      { name: 'long.txt', text },
      readTree({ ...TREE, roots: [10], edges: [] }),
      async (_system, prompt) => {
        pieces.push(askedIds(prompt));
        return pieces.length === 2 ? '{"tags":[{"id":10}]}' : '{"tags":[]}';
      },
      false
    );
    // Bills matched on the second piece: the rest of the file is not asked.
    assert.deepEqual(pieces, [[10], [10]]);
  });
});

describe('a run on the Vault', () => {
  let db: VaultDb;
  let vault: RunnerVault;
  let categorize: VaultCategorize;
  // The fake model: each question waits on `gate` when one is set.
  let gate: Promise<void> | null = null;
  const engines: CategorizeEngines = {
    models: async () => ({ ollama: [{ id: 'llama3.2:3b', title: 'Llama' }], cli: ['claude'] }),
    ask: async (_engine, _model, _system, prompt, signal) => {
      if (gate) {
        await Promise.race([
          gate,
          new Promise((_, reject) =>
            signal.addEventListener('abort', () => reject(new Error('aborted')))
          )
        ]);
      }
      const ids = askedIds(prompt);
      if (ids.includes(10) && prompt.includes('electricity')) {
        return '{"tags":[{"id":10},{"id":30,"data":"80"}]}';
      }
      if (ids.includes(11)) return '{"tags":[{"id":11}]}';
      return '{"tags":[]}';
    }
  };
  const payload = (over: Partial<RunnerCategorizePayload> = {}): RunnerCategorizePayload => ({
    engine: 'ollama',
    model: 'llama3.2:3b',
    tree: TREE,
    aiResearchId: 77,
    ...over
  });

  const add = async (name: string, body: string): Promise<RunnerVaultFile> => {
    const bytes = Buffer.from(body);
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
    // What the ingest leaves: the text read, the file embedded.
    await db.batch([
      {
        sql: `UPDATE "PostContent" SET "text" = $2 WHERE "postId" IN (
                SELECT "A" FROM "_postUploads" WHERE "B" = $1)`,
        params: [file.id, body]
      },
      {
        sql: `UPDATE "Upload" SET "ingestStatus" = 'EMBEDDED', "transcriptSource" = 'TEXT_LAYER' WHERE "id" = $1`,
        params: [file.id]
      }
    ]);
    return file;
  };

  const status = async () =>
    (await vault.handle('vaultCategorizeStatus', {}, OWNER)) as RunnerCategorizeStatus;
  const settled = async () => {
    for (let i = 0; i < 200; i++) {
      const now = await status();
      if (!now.run?.running) return now;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('The run did not end.');
  };

  before(async () => {
    db = await openVaultDb({ dataDir: 'memory://', engineDir: ENGINE });
    const store = new FsObjectStore(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-vault-cat-')));
    categorize = new VaultCategorize(db, engines);
    vault = new RunnerVault(db, store, '1', () => {}, null, null, categorize);
  });
  after(async () => {
    await db.close();
  });

  it('is the owner’s alone', async () => {
    await vault.handle('vaultShareSet', { memberId: '2', shared: true }, OWNER);
    await assert.rejects(vault.handle('vaultCategorizeStatus', {}, PEER), /Only the owner/);
    await assert.rejects(vault.handle('vaultCategorizeStart', payload(), PEER), /Only the owner/);
  });

  it('counts what waits, tags it, stamps it and counts each category', async () => {
    const bill = await add('Bills/power.txt', 'An electricity bill for 80.');
    const notes = await add('notes.md', '# Thoughts');
    await add('photo.jpg', 'x');
    // A file not read yet does not wait.
    await db.query(`UPDATE "Upload" SET "ingestStatus" = 'PENDING' WHERE "name" = 'photo.jpg'`);
    assert.equal((await status()).waiting, 2);
    assert.equal((await status()).unread, 1);

    await assert.rejects(
      vault.handle('vaultCategorizeStart', payload({ model: 'mistral:7b' }), OWNER),
      /not on this runner/
    );
    await vault.handle('vaultCategorizeStart', payload(), OWNER);
    const done = await settled();
    assert.equal(done.waiting, 0);
    assert.equal(done.run?.processed, 2);
    assert.equal(done.run?.error, null);
    const counts = new Map(done.counts.map((c) => [c.factiiiId, c.files]));
    assert.deepEqual(
      [...counts.entries()].sort((a, b) => a[0] - b[0]),
      [
        [10, 1],
        [11, 1],
        [20, 1],
        [30, 1],
        [77, 1]
      ]
    );

    const { files } = (await vault.handle('vaultFiles', {}, OWNER)) as { files: RunnerVaultFile[] };
    const byName = new Map(files.map((f) => [f.name, f.factiiiIds]));
    assert.deepEqual(byName.get(bill.name)?.sort((a, b) => a - b), [10, 11, 30]);
    // Markdown: Research by default, and AI Research as the cloud's ingest gives it.
    assert.deepEqual(byName.get(notes.name)?.sort((a, b) => a - b), [20, 77]);
    const [amount] = await db.query<{ number: number }>(
      `SELECT t."number" FROM "PostFactiii" t JOIN "PostFactiiiCount" c ON c."id" = t."postFactiiiCountId" WHERE c."factiiiId" = 30`
    );
    assert.equal(amount.number, 80);

    const powered = (await vault.handle('vaultFiles', { factiiiId: 11 }, OWNER)) as {
      files: RunnerVaultFile[];
    };
    assert.deepEqual(
      powered.files.map((f) => f.name),
      [bill.name]
    );
    await assert.rejects(
      vault.handle('vaultCategorizeStart', payload(), OWNER),
      /already categorized/
    );
  });

  it('takes no new file while it runs, runs one at a time, and stops on Cancel', async () => {
    await add('Bills/water.txt', 'A water bill.');
    let open: () => void = () => {};
    gate = new Promise((resolve) => {
      open = resolve;
    });
    await vault.handle('vaultCategorizeStart', payload(), OWNER);
    await assert.rejects(
      vault.handle('vaultUploadStart', { name: 'later.txt', size: 1, contentType: 'text/plain' }, OWNER),
      /Categorize is running/
    );
    await assert.rejects(vault.handle('vaultCategorizeStart', payload(), OWNER), /already running/);
    await vault.handle('vaultCategorizeCancel', {}, OWNER);
    const stopped = await settled();
    assert.equal(stopped.run?.stopped, true);
    assert.equal(stopped.run?.error, null);
    // The file it was on was never written: it still waits.
    assert.equal(stopped.waiting, 1);
    open();
    gate = null;
    // Adding works again.
    await add('later.txt', 'x');
  });

  it('ends with the reason when the model fails, leaving the file waiting', async () => {
    const failing = new VaultCategorize(db, {
      ...engines,
      ask: async () => {
        throw new Error('Ollama did not answer (500).');
      }
    });
    await failing.start(payload(), 1);
    for (let i = 0; i < 100 && failing.running(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const after = await failing.status(1);
    assert.match(after.run?.error ?? '', /Ollama did not answer/);
    assert.equal(after.run?.processed, 0);
    assert.ok(after.waiting >= 1);
  });

  it('skips files deleted during the run instead of failing on them', async () => {
    await add('Bills/gone.txt', 'An electricity bill.');
    const waiting = await db.query<{ id: string }>(
      `SELECT "id" FROM "Upload" WHERE "ontologyAt" IS NULL AND "ingestStatus" = 'EMBEDDED'`
    );
    assert.ok(waiting.length >= 2);
    // The first question deletes every waiting file: the one being asked
    // about then has nothing to write to, and the rest nothing to read.
    let deleted = false;
    const deleting = new VaultCategorize(db, {
      ...engines,
      ask: async () => {
        if (!deleted) {
          deleted = true;
          await vault.handle('vaultDelete', { uploadIds: waiting.map((w) => w.id) }, OWNER);
        }
        return '{"tags":[{"id":10}]}';
      }
    });
    await deleting.start(payload(), 1);
    for (let i = 0; i < 100 && deleting.running(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const done = await deleting.status(1);
    assert.equal(done.run?.error, null);
    assert.equal(done.waiting, 0);
    assert.equal(done.run?.processed, done.run?.total);
  });
});
