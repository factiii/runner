import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { RunnerVaultFile, RunnerVaultNote } from '@shared/all/domains/electron';
import type { VouchedScope } from '@shared/all/helpers/board-agent-core/runner-access';
import {
  describeToolCall,
  describeToolResult,
  researchToolDefs,
  researchToolNames
} from '@shared/all/helpers/researchTools';
import type { EmbedRequest, RunnerCategoryTree } from '@shared/all/validators';

import { startVaultMcp } from './askMcp';
import { askResearchTools, type AskToolsContext } from './askTools';
import { openVaultDb, type VaultDb } from './db';
import type { Embedder, EmbedderState } from './embedder';
import { FsObjectStore } from './objectStore';
import { RunnerVault, type VaultCaller } from './service';

// Ask's research tools on a runner (askTools.ts), on a real Vault database:
// the cloud's file tools by their shared definition, what each answers in
// the cloud's shape, how a call reads in the work line, whose rows they read,
// and the MCP server that serves them to Claude and Codex.

const OWNER = { role: 'owner' as const, userId: '1', name: 'Owner' };
const PEER = { role: 'member' as const, spaceSlugs: [], userId: '2', name: 'Peer', vault: true };
const ENGINE = path.resolve(__dirname, '../..');
const DIM = 768;

/** A unit vector along `axis`. */
const toward = (axis: number): number[] =>
  Array.from({ length: DIM }, (_, i) => (i === axis ? 1 : 0));

class AxisEmbedder implements Embedder {
  current: EmbedderState = 'ready';
  state() {
    return this.current;
  }
  async embed(_body: EmbedRequest) {
    return toward(0);
  }
  async read(): Promise<never> {
    throw new Error('not used');
  }
  stop() {}
}

/** Medical (root) > Dental; Finance (root). */
const TREE: RunnerCategoryTree = {
  nodes: [
    { id: 10, slug: 'medical', name: 'Medical', description: 'Health records', requirements: ['ROOT'] },
    { id: 11, slug: 'dental', name: 'Dental', description: null, requirements: [] },
    { id: 20, slug: 'finance', name: 'Finance', description: 'Invoices and taxes', requirements: ['ROOT'] }
  ],
  roots: [10, 20],
  edges: [{ parentId: 10, childId: 11 }]
};

let db: VaultDb;
let vault: RunnerVault;
const embedder = new AxisEmbedder();
let xray: RunnerVaultFile;
let peerFile: RunnerVaultFile;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-vault-asktools-'));

async function add(name: string, text: string, scope: VouchedScope, axis: number, tags: number[] = []) {
  const bytes = Buffer.from(text);
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
  const [{ postId }] = await db.query<{ postId: number }>(
    'SELECT "A" AS "postId" FROM "_postUploads" WHERE "B" = $1',
    [file.id]
  );
  await db.query('UPDATE "PostContent" SET "text" = $2, "page" = 1 WHERE "postId" = $1', [postId, text]);
  await db.query(
    `INSERT INTO "SearchVector" ("postContentId", "vector", "updatedAt")
     SELECT pc."id", $2::halfvec, CURRENT_TIMESTAMP FROM "PostContent" pc WHERE pc."postId" = $1`,
    [postId, `[${toward(axis).join(',')}]`]
  );
  for (const factiiiId of tags) {
    await db.query('INSERT INTO "PostFactiiiCount" ("factiiiId", "postId") VALUES ($1, $2)', [factiiiId, postId]);
  }
  return file;
}

/** One turn's tools for `scope`, with the steps they wrote and the files
 *  they read. */
async function turn(scope: VouchedScope, over: Partial<AskToolsContext> = {}) {
  const entered: VaultCaller = await vault.enter(scope);
  const steps: string[] = [];
  const read: RunnerVaultFile[] = [];
  const saved: RunnerVaultNote[] = [];
  const tools = askResearchTools({
    tools: vault.askTools,
    entered,
    read: (id, chars) => vault.askText(id, entered, chars),
    categories: TREE,
    save:
      entered.role === 'owner'
        ? async (title, body) => {
            const note = await vault.keepNote(entered, { title, body, aiResearchId: null });
            saved.push(note);
            return note;
          }
        : null,
    step: (label) => steps.push(label),
    onRead: (file) => read.push(file),
    ...over
  });
  const call = async (name: string, input: unknown) => JSON.parse(await tools.call(name, input)) as unknown;
  return { tools, call, steps, read, saved };
}

before(async () => {
  db = await openVaultDb({ dataDir: 'memory://', engineDir: ENGINE });
  vault = new RunnerVault(db, new FsObjectStore(path.join(tmp, 'objects')), '1', () => {}, null, embedder);
  await vault.handle('vaultShareSet', { memberId: '2', shared: true }, OWNER);
  xray = await add('Health/xray.txt', 'Chest x-ray, clear. Dr Patel.', OWNER, 0, [10, 11]);
  await add('Taxes/2025.txt', 'Tax return 2025. Refund 120.', OWNER, 5, [20]);
  peerFile = await add('Peer/teeth.txt', 'Dental cleaning in March.', PEER, 3, [11]);
});
after(async () => {
  await db.close();
});

describe('Ask research tools on a runner', () => {
  it('offers the cloud’s file tools by their one definition, and no web or skill tool', async () => {
    const { tools } = await turn(OWNER);
    assert.deepEqual(tools.defs, researchToolDefs(researchToolNames('files')));
    assert.ok(tools.defs.every((def) => def.input_schema.type === 'object'));
    // No tree: no tag tools. A member: no save tool.
    assert.deepEqual(
      (await turn(OWNER, { categories: undefined })).tools.defs.map((d) => d.name),
      ['search_my_files', 'list_my_files', 'save_research', 'read_my_file']
    );
    assert.ok(!(await turn(PEER)).tools.defs.some((d) => d.name === 'save_research'));
  });

  it('searches by meaning, nearest first, in the cloud’s hit shape, labelled as the cloud labels it', async () => {
    const { call, steps } = await turn(OWNER);
    const hits = (await call('search_my_files', { query: 'lungs' })) as {
      uploadId: string;
      name: string;
      page: number;
      text: string;
      distance: number;
    }[];
    assert.equal(hits[0]?.uploadId, xray.id);
    assert.equal(hits[0]?.name, 'Health/xray.txt');
    assert.equal(hits[0]?.page, 1);
    assert.ok(hits[0].distance < 0.01);
    assert.deepEqual(steps, ['Searching your files for “lungs”', 'Found “lungs” in Health/xray.txt, Taxes/2025.txt +1 more']);
  });

  it('searches the words with exact, and by them when no embedder is there', async () => {
    const { call } = await turn(OWNER);
    const exact = (await call('search_my_files', { query: 'refund', exact: true })) as { name: string }[];
    assert.deepEqual(exact.map((h) => h.name), ['Taxes/2025.txt']);
    embedder.current = 'missing';
    try {
      // The question's longer words, one by one, as Oakbox's search falls back.
      const words = (await call('search_my_files', { query: 'when was the cleaning' })) as { name: string }[];
      assert.deepEqual(words.map((h) => h.name), ['Peer/teeth.txt']);
    } finally {
      embedder.current = 'ready';
    }
  });

  it('lists and reads the files the caller reads, never another’s', async () => {
    const owner = await turn(OWNER);
    const files = (await owner.call('list_my_files', {})) as { name: string; type: string; chunks: number }[];
    assert.deepEqual(files.map((f) => f.name).sort(), ['Health/xray.txt', 'Peer/teeth.txt', 'Taxes/2025.txt']);
    assert.equal(files[0]?.type, 'DOCUMENT');
    assert.equal(files[0]?.chunks, 1);
    assert.deepEqual(await owner.call('read_my_file', { uploadId: xray.id }), {
      name: 'Health/xray.txt',
      text: '[page 1] Chest x-ray, clear. Dr Patel.',
      truncated: false
    });
    assert.deepEqual(owner.read.map((f) => f.id), [xray.id]);
    assert.deepEqual(owner.steps.slice(-2), ['Opening a file', 'Read Health/xray.txt']);
    // An id it does not read: the cloud's answer, and its label.
    assert.deepEqual(await owner.call('read_my_file', { uploadId: 'nope' }), { error: 'No such file for this user.' });
    assert.equal(owner.steps.at(-1), 'Could not open that file');
  });

  it('answers the tag and category tools from the tree the app sent, counted on the runner', async () => {
    const { call, steps } = await turn(OWNER);
    assert.deepEqual(await call('list_my_tags', {}), [
      { name: 'Dental', posts: 2 },
      { name: 'Finance', posts: 1 },
      { name: 'Medical', posts: 1 }
    ]);
    const tagged = (await call('search_my_tags', { factiii: 'dental' })) as {
      uploadId: string;
      title: string;
      factiiis: string;
    }[];
    assert.deepEqual(
      tagged.map((t) => [t.title, t.factiiis]).sort(),
      [
        ['Health/xray.txt', 'Dental, Medical'],
        ['Peer/teeth.txt', 'Dental']
      ]
    );
    assert.deepEqual(await call('search_my_tags', { factiii: 'Nope' }), []);
    // "invoice" finds Finance by its rule; Dental hangs under Medical.
    assert.deepEqual(await call('list_my_ontology', { query: 'invoice' }), {
      entries: [{ name: 'Finance', rule: 'Invoices and taxes', files: 1, under: [] }],
      total: 1,
      nextCursor: null
    });
    const page = (await call('list_my_ontology', { limit: 1 })) as {
      entries: { name: string; files: number; under: string[] }[];
      nextCursor: number | null;
    };
    assert.deepEqual(page.entries, [{ name: 'Finance', rule: 'Invoices and taxes', files: 1, under: [] }]);
    assert.equal(page.nextCursor, 1);
    const medical = (await call('list_my_ontology', { query: 'medical' })) as {
      entries: { files: number; under: string[] }[];
    };
    assert.deepEqual([medical.entries[0]?.files, medical.entries[0]?.under], [1, ['Dental']]);
    assert.ok(steps.includes('Checked 3 tags'));
    assert.ok(steps.includes('Nothing is tagged “Nope”'));
  });

  it('keeps a note for the owner only, and refuses a bad input or an unknown tool in words', async () => {
    const owner = await turn(OWNER);
    const kept = (await owner.call('save_research', { title: 'X-ray', body: '<p>Clear.</p>' })) as {
      postUuid: string;
      title: string;
    };
    assert.deepEqual(kept, { postUuid: owner.saved[0]?.id, title: 'X-ray' });
    assert.equal(owner.steps.at(-1), 'Saved “X-ray” to your files');
    // A note is found by its words, as the cloud finds one: no uploadId.
    const found = (await owner.call('search_my_files', { query: 'Clear.', exact: true })) as {
      uploadId: string | null;
      name: string;
    }[];
    assert.ok(found.some((h) => h.uploadId === null && h.name === 'X-ray'));
    await vault.handle('vaultNoteDelete', { noteId: kept.postUuid }, OWNER);

    const peer = await turn(PEER);
    assert.match(await peer.tools.call('save_research', { title: 't', body: 'b' }), /^Tool failed: no tool named save_research/);
    assert.match(await peer.tools.call('read_my_file', {}), /^Tool failed: Bad input for read_my_file: uploadId/);
    assert.match(await peer.tools.call('search_wikipedia', { query: 'x' }), /^Tool failed: no tool named/);
    // A member reads its own files and the owner's, as Oakbox's search does.
    const peerHits = (await peer.call('search_my_files', { query: 'Dental cleaning', exact: true })) as {
      uploadId: string;
    }[];
    assert.deepEqual(peerHits.map((h) => h.uploadId), [peerFile.id]);
  });

  it('labels every call as the cloud’s describeToolCall and describeToolResult do', async () => {
    const { tools, steps } = await turn(OWNER);
    const out = await tools.call('list_my_files', {});
    assert.deepEqual(steps, [
      describeToolCall('list_my_files', {}).label,
      describeToolResult('list_my_files', {}, out)
    ]);
  });

  it('serves the same tools over MCP, behind the turn’s token', async () => {
    const { tools } = await turn(OWNER, { categories: undefined });
    const mcp = await startVaultMcp(tools);
    const rpc = async (method: string, params: unknown, token = mcp.token) => {
      const res = await fetch(mcp.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
      });
      return res.status === 200 ? ((await res.json()) as { result: Record<string, unknown> }).result : res.status;
    };
    try {
      assert.deepEqual(mcp.tools, ['search_my_files', 'list_my_files', 'save_research', 'read_my_file']);
      const listed = (await rpc('tools/list', {})) as {
        tools: { name: string; inputSchema: unknown; annotations: { readOnlyHint: boolean } }[];
      };
      assert.deepEqual(
        listed.tools.map((t) => [t.name, t.inputSchema, t.annotations.readOnlyHint]),
        tools.defs.map((d) => [d.name, d.input_schema, d.name !== 'save_research'])
      );
      const read = (await rpc('tools/call', { name: 'read_my_file', arguments: { uploadId: xray.id } })) as {
        content: { text: string }[];
        isError: boolean;
      };
      assert.equal(read.isError, false);
      assert.match(read.content[0]?.text ?? '', /Chest x-ray/);
      const bad = (await rpc('tools/call', { name: 'list_my_tags', arguments: {} })) as { isError: boolean };
      assert.equal(bad.isError, true);
      assert.equal(await rpc('tools/list', {}, 'wrong'), 401);
    } finally {
      mcp.close();
    }
  });
});
