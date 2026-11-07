import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import type {
  BoardAgentActionMap,
  RunnerVaultFile
} from '@shared/all/domains/electron';
import {
  RELAY_VAULT_REFUSAL,
  relaySecretsRefusal,
  type VouchedScope
} from '@shared/all/helpers/board-agent-core/runner-access';
import type { EmbedRequest } from '@shared/all/validators';

import type { AskEngines } from './ask';
import type { CategorizeEngines } from './categorize';
import { createDaemonVault } from './daemonVault';
import { openVaultDb, type VaultDb } from './db';
import type { Embedder, EmbedderState } from './embedder';
import { FsObjectStore } from './objectStore';
import { RunnerVault } from './service';

// Oakbox's search on a runner (.specs/runner-vault.md "Search across vaults"),
// on a real database: who may search, the words pass, the ranking by `<=>`,
// and the name match it falls back to without Vault search.

const OWNER = { role: 'owner' as const, userId: '1', name: 'Owner' };
const PEER = { role: 'member' as const, spaceSlugs: [], userId: '2', name: 'Peer', vault: true };
const STRANGER = { ...PEER, userId: '3' };
const ENGINE = path.resolve(__dirname, '../..');
const DIM = 768;

type Result = BoardAgentActionMap['vaultSearch']['result'];

/** A unit vector pointing mostly along `axis`, a little along `lean`. */
const toward = (axis: number, lean = 0, by = 0): number[] => {
  const v = Array.from({ length: DIM }, () => 0);
  v[axis] = 1;
  v[lean] += by;
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
};

class QueryEmbedder implements Embedder {
  current: EmbedderState = 'ready';
  fail = false;
  queries: string[] = [];
  state() {
    return this.current;
  }
  async embed(body: EmbedRequest) {
    if (this.fail) throw new Error('embedder down');
    this.queries.push(body.text ?? '');
    return toward(0);
  }
  async read(): Promise<never> {
    throw new Error('not used');
  }
  stop() {}
}

let db: VaultDb;
let vault: RunnerVault;
let embedder: QueryEmbedder;

before(async () => {
  db = await openVaultDb({ dataDir: 'memory://', engineDir: ENGINE });
});
after(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.batch([
    { sql: 'DELETE FROM "Post"' },
    { sql: 'DELETE FROM "Upload"' },
    { sql: 'DELETE FROM "VaultShare"' }
  ]);
  embedder = new QueryEmbedder();
  const store = new FsObjectStore(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-vault-search-')));
  vault = new RunnerVault(db, store, '1', () => {}, null, embedder);
});

async function add(name: string, vector?: number[], scope: VouchedScope = OWNER) {
  const bytes = Buffer.from(name);
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
  // The ingest's vector for the file's one row, set by hand.
  if (vector) {
    await db.query(
      `INSERT INTO "SearchVector" ("postContentId", "vector", "updatedAt")
       SELECT pc."id", $2::halfvec, CURRENT_TIMESTAMP
         FROM "_postUploads" pu JOIN "PostContent" pc ON pc."postId" = pu."A"
        WHERE pu."B" = $1`,
      [file.id, `[${vector.join(',')}]`]
    );
  }
  return file;
}

const search = (query: string, scope: VouchedScope = OWNER) =>
  vault.handle('vaultSearch', { query }, scope) as Promise<Result>;

describe('runner vault search', () => {
  it('answers a word match first, as the cloud does, with no distance', async () => {
    await add('Taxes/refund.txt', toward(1));
    await add('Recipes/bread.txt', toward(0));
    const { hits, mode } = await search('refund');
    assert.equal(mode, 'words');
    assert.deepEqual(
      hits.map((h) => [h.name, h.distance]),
      [['Taxes/refund.txt', null]]
    );
    assert.deepEqual(embedder.queries, [], 'a word match embeds nothing');
  });

  it('ranks by distance on the runner when no file has the words', async () => {
    await add('far.txt', toward(5));
    await add('near.txt', toward(0, 5, 0.2));
    await add('nearest.txt', toward(0));
    await add('unread.txt');
    const { hits, mode } = await search('something else');
    assert.equal(mode, 'meaning');
    assert.deepEqual(embedder.queries, ['something else']);
    assert.deepEqual(
      hits.map((h) => h.name),
      ['nearest.txt', 'near.txt', 'far.txt'],
      'nearest first; a file with no vector is not ranked'
    );
    const [nearest, near, far] = hits.map((h) => h.distance ?? -1);
    assert.ok(nearest < 0.01 && near > nearest && far > near && far <= 1.01);
  });

  it('falls back to the name match without Vault search', async () => {
    await add('Letters/bank.txt', toward(0));
    embedder.current = 'missing';
    assert.deepEqual(
      (await search('bank')).hits.map((h) => h.name),
      ['Letters/bank.txt']
    );
    const { hits, mode } = await search('money');
    assert.equal(mode, 'names');
    assert.deepEqual(hits, []);
    assert.deepEqual(embedder.queries, []);
  });

  it('falls back to the name match when the embedder does not answer', async () => {
    await add('a.txt', toward(0));
    embedder.fail = true;
    assert.deepEqual(await search('meaning'), { hits: [], mode: 'names' });
  });

  it('refuses anyone the owner did not let in, and finds a peer’s files for a member', async () => {
    await assert.rejects(search('anything', PEER), /not shared with you/);
    await vault.handle('vaultShareSet', { memberId: '2', shared: true }, OWNER);
    await assert.rejects(search('anything', STRANGER), /not shared with you/);
    await add('Peer/notes.txt', toward(0), PEER);
    const own = await search('notes');
    assert.deepEqual(
      own.hits.map((h) => [h.name, h.mine]),
      [['Peer/notes.txt', false]]
    );
    const theirs = await search('notes', PEER);
    assert.equal(theirs.hits[0]?.mine, true);
  });

  it('finds the caller’s kept notes by words and by meaning, marked as notes', async () => {
    await add('Taxes/refund.txt', toward(5));
    const note = await vault.keepNote(await vault.enter(OWNER), {
      title: 'Boiler service',
      body: '<p>The boiler was serviced in March.</p>',
      aiResearchId: null
    });
    // The ingest's vector for its row, set by hand.
    await db.query(
      `INSERT INTO "SearchVector" ("postContentId", "vector", "updatedAt")
       SELECT pc."id", $2::halfvec, CURRENT_TIMESTAMP
         FROM "PostContent" pc JOIN "Post" p ON p."id" = pc."postId" WHERE p."uuid" = $1::uuid`,
      [note.id, `[${toward(0).join(',')}]`]
    );
    const words = await search('boiler');
    assert.equal(words.mode, 'words');
    assert.deepEqual(
      words.hits.map((h) => [h.id, h.name, h.note, h.ingestStatus]),
      [[note.id, 'Boiler service', true, 'EMBEDDED']]
    );
    const meaning = await search('heating upkeep');
    assert.equal(meaning.mode, 'meaning');
    assert.deepEqual(
      meaning.hits.map((h) => h.name),
      ['Boiler service', 'Taxes/refund.txt'],
      'the note ranks beside the files, nearest first'
    );
    // A note is its keeper's: a member searching finds none of the owner's.
    await vault.handle('vaultShareSet', { memberId: '2', shared: true }, OWNER);
    assert.deepEqual(
      (await search('heating upkeep', PEER)).hits.map((h) => h.name),
      ['Taxes/refund.txt']
    );
    assert.ok(!(await search('boiler', PEER)).hits.some((h) => h.note));
  });

  it('refuses a query too short to be a search', async () => {
    await assert.rejects(search('a'));
  });

  it('is never carried by the relay', () => {
    assert.equal(relaySecretsRefusal('socket', 'vaultSearch', { query: 'x' }), RELAY_VAULT_REFUSAL);
    assert.equal(relaySecretsRefusal('webrtc', 'vaultSearch', { query: 'x' }), null);
  });
});

describe('a runner with no Vault', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-no-vault-'));
  const noAsk: AskEngines = {
    ollamaModels: async () => [],
    ollamaTakesTools: async () => false,
    clis: async () => [],
    ollama: async () => '',
    cli: async () => ''
  };
  const noCategorize: CategorizeEngines = {
    models: async () => ({ ollama: [], cli: [] }),
    ask: async () => ''
  };
  const daemon = createDaemonVault(
    dir,
    '1',
    () => {},
    new QueryEmbedder(),
    noAsk,
    noCategorize
  );

  it('tells its owner it has none, so the app leaves it out quietly', async () => {
    assert.deepEqual(await daemon.handle('vaultSearch', { query: 'tax' }, OWNER), {
      hits: [],
      mode: 'absent'
    });
  });

  it('still refuses someone it never let in', async () => {
    await assert.rejects(daemon.handle('vaultSearch', { query: 'tax' }, STRANGER), /not shared/);
  });

  it('answers the other actions as before', async () => {
    await assert.rejects(daemon.handle('vaultStatus', {}, OWNER), /has no Vault yet/);
  });
});
