import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import type {
  BoardAgentActionMap,
  RunnerAskChat,
  RunnerAskModels,
  RunnerAskState,
  RunnerVaultFile,
  RunnerVaultStatus
} from '@shared/all/domains/electron';
import type { VouchedScope } from '@shared/all/helpers/board-agent-core/runner-access';

import type { AskEngines } from './ask';
import type { CategorizeEngines } from './categorize';
import { createDaemonVault, type DaemonVault, mergePages, mergeSearches } from './daemonVault';
import { openVaultDb } from './db';
import type { Embedder } from './embedder';
import { storePaths, VAULT_ENGINE_PACKAGE } from './engine';
import { FsObjectStore, RUNNER_STORAGE_TICKET_SCHEME } from '@shared/vault-core/objectStore';
import { RUNNER_CLOUD_KEY_FILE } from './runnerCloudKey';
import { RunnerVault } from './service';

// The runner's two stores (.specs/runner-vault.md "Two stores") as the daemon
// holds them: the Vault and Runner Cloud, each its own database process and
// files folder, one API. A row lands in the store named, a list and a search
// with none answer from both with each row tagged, and Ask reads the Vault
// with Local AI only.

const OWNER = { role: 'owner' as const, userId: '1', name: 'Owner' };
const STRANGER = { role: 'member' as const, spaceSlugs: [], userId: '3', name: 'S', vault: true };
const runnerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-stores-'));
const ROOT_MODULES = path.resolve(__dirname, '../../../../node_modules');

/** No embedder: files are found by their words. */
const embedder: Embedder = {
  state: () => 'missing',
  embed: () => Promise.reject(new Error('No embedder.')),
  read: () => Promise.reject(new Error('No embedder.')),
  stop: () => undefined
};

/** What the CLI fake was handed, per turn: the MCP server's tool names. */
const cliTurns: string[][] = [];
const engines: AskEngines = {
  ollamaModels: async () => ['llama3.2:3b'],
  ollamaTakesTools: async () => false,
  clis: async () => ['claude', 'codex'],
  ollama: async (_model, _messages, onText) => {
    onText('<p>Local.</p>');
    return '<p>Local.</p>';
  },
  cli: async (_engine, _prompt, mcp) => {
    cliTurns.push(mcp.tools);
    return '<p>From Runner Cloud.</p>';
  }
};
const categorizeEngines: CategorizeEngines = {
  models: async () => ({ ollama: [{ id: 'llama3.2:3b', title: 'Llama 3.2 3B' }], cli: ['claude'] }),
  ask: async () => '{}'
};

let daemon: DaemonVault;

const call = <A extends keyof BoardAgentActionMap>(
  action: A,
  payload: unknown,
  scope: VouchedScope = OWNER
) => daemon.handle(action, payload, scope) as Promise<BoardAgentActionMap[A]['result']>;

async function add(name: string, body: string, store?: 'vault' | 'runner') {
  const bytes = Buffer.from(body);
  const { ticket } = await call('vaultUploadStart', {
    name,
    size: bytes.length,
    contentType: 'text/plain',
    ...(store ? { store } : {})
  });
  const { file } = await call('vaultWrite', {
    ticket,
    offset: 0,
    content: bytes.toString('base64'),
    last: true
  });
  return file as RunnerVaultFile;
}

async function askUntilDone(payload: unknown): Promise<RunnerAskState & { chatId: string }> {
  const { askId, chatId } = await call('vaultAsk', payload);
  for (let i = 0; i < 200; i++) {
    const state = await call('vaultAskPoll', { askId });
    if (state.done) return { ...state, chatId };
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('The turn never finished.');
}

before(() => {
  // The engine as the Vault part installs it: the pinned PGlite, here the
  // workspace's own.
  const modules = path.join(runnerDir, 'parts', 'vault', 'engine', 'node_modules');
  fs.mkdirSync(path.join(modules, '@electric-sql'), { recursive: true });
  fs.symlinkSync(
    path.join(ROOT_MODULES, VAULT_ENGINE_PACKAGE),
    path.join(modules, VAULT_ENGINE_PACKAGE)
  );
  daemon = createDaemonVault(runnerDir, '1', () => undefined, embedder, engines, categorizeEngines);
});
after(async () => {
  await daemon.close();
  fs.rmSync(runnerDir, { recursive: true, force: true });
});

describe('a runner with only its Vault', () => {
  it('says plainly that Claude and Codex have nothing to read', async () => {
    await add('Taxes/refund.txt', 'refund due');
    const models = (await call('vaultAskModels', {})) as RunnerAskModels;
    assert.equal(models.runnerStorage, false);
    assert.deepEqual(models.cli, ['claude', 'codex']);
    await assert.rejects(
      call('vaultAsk', { engine: 'claude', question: 'refund?', store: 'runner' }),
      /no Runner Cloud yet, so Claude and Codex have nothing to read/
    );
    // A read does not make it.
    assert.deepEqual(await call('vaultFiles', { store: 'runner' }), { files: [], more: false });
    assert.equal(fs.existsSync(path.dirname(storePaths(runnerDir, 'runner').db)), false);
    const status = (await call('vaultStatus', {})) as RunnerVaultStatus;
    assert.equal(status.runnerStorage, null);
  });

  it('refuses Claude and Codex on the Vault, before any model runs', async () => {
    for (const engine of ['claude', 'codex']) {
      await assert.rejects(
        call('vaultAsk', { engine, question: 'refund?' }),
        /read by Local AI on this runner only/
      );
      await assert.rejects(
        call('vaultAsk', { engine, question: 'refund?', store: 'vault' }),
        /read by Local AI on this runner only/
      );
    }
    assert.deepEqual(cliTurns, []);
  });

  it('refuses a store it does not know, rather than reading it as the Vault', async () => {
    await assert.rejects(call('vaultFiles', { store: 'cloud' }));
  });
});

describe('a runner with both stores', () => {
  let inVault: RunnerVaultFile;
  let inRunner: RunnerVaultFile;

  before(async () => {
    inVault = await add('Health/policy-vault.txt', 'policy in the vault');
    // A moment apart, so newest first is one order.
    await new Promise((resolve) => setTimeout(resolve, 5));
    inRunner = await add('Work/policy-runner.txt', 'policy in runner storage', 'runner');
  });

  it('lands each row in the store named, in its own folder and database', async () => {
    assert.equal(inVault.store, 'vault');
    assert.equal(inRunner.store, 'runner');
    // Sealed from its first file (runnerCloudKey.ts): a key file, the
    // encrypted dump, no plaintext database.
    const runnerRoot = path.dirname(storePaths(runnerDir, 'runner').db);
    assert.ok(fs.existsSync(path.join(runnerRoot, 'keys.json')));
    assert.equal(fs.existsSync(storePaths(runnerDir, 'runner').db), false);
    const vaultOnly = await call('vaultFiles', { store: 'vault' });
    assert.ok(vaultOnly.files.every((f) => f.store === 'vault'));
    assert.ok(vaultOnly.files.some((f) => f.id === inVault.id));
    assert.ok(!vaultOnly.files.some((f) => f.id === inRunner.id));
    const runnerOnly = await call('vaultFiles', { store: 'runner' });
    assert.deepEqual(
      runnerOnly.files.map((f) => [f.id, f.store]),
      [[inRunner.id, 'runner']]
    );
    // The Vault's file is not in Runner Cloud's folder.
    const runnerObjects = fs.readdirSync(storePaths(runnerDir, 'runner').objects);
    const vaultObjects = fs.readdirSync(storePaths(runnerDir, 'vault').objects);
    assert.equal(runnerObjects.filter((f) => !f.endsWith('.json')).length, 1);
    assert.ok(!runnerObjects.some((f) => vaultObjects.includes(f)));
  });

  it('lists both stores with no store named, newest first, each row tagged', async () => {
    const { files, more } = await call('vaultFiles', {});
    assert.equal(more, false);
    assert.deepEqual(
      files.map((f) => [f.name, f.store]),
      [
        ['Work/policy-runner.txt', 'runner'],
        ['Health/policy-vault.txt', 'vault'],
        ['Taxes/refund.txt', 'vault']
      ]
    );
    // A page goes on across the stores.
    const first = await call('vaultFiles', { limit: 1 });
    assert.deepEqual(first.files.map((f) => f.id), [inRunner.id]);
    assert.equal(first.more, true);
    const next = await call('vaultFiles', { limit: 1, before: inRunner.id });
    assert.deepEqual(next.files.map((f) => f.id), [inVault.id]);
  });

  it('searches both stores with no store named, each hit tagged', async () => {
    const { hits, mode } = await call('vaultSearch', { query: 'policy' });
    assert.equal(mode, 'words');
    assert.deepEqual(
      hits.map((h) => h.store).sort(),
      ['runner', 'vault']
    );
    const runnerHits = await call('vaultSearch', { query: 'policy', store: 'runner' });
    assert.deepEqual(runnerHits.hits.map((h) => h.id), [inRunner.id]);
  });

  it('counts Runner Cloud beside the Vault, and Ask knows it is there', async () => {
    const status = (await call('vaultStatus', {})) as RunnerVaultStatus;
    assert.equal(status.files, 2);
    assert.deepEqual(status.runnerStorage, { files: 1, bytes: 24 });
    const models = (await call('vaultAskModels', {})) as RunnerAskModels;
    assert.equal(models.runnerStorage, true);
  });

  it('opens and deletes a file by id from whichever store holds it', async () => {
    const extra = await add('Work/scratch.txt', 'scratch', 'runner');
    const download = await call('vaultDownload', { uploadId: extra.id });
    assert.match(download.ticket, /^runner-storage:/);
    const read = await call('vaultRead', { ticket: download.ticket, offset: 0, length: 7 });
    assert.equal(Buffer.from(read.content, 'base64').toString(), 'scratch');
    assert.deepEqual(await call('vaultDelete', { uploadIds: [extra.id] }), { deleted: 1, kept: 0 });
  });

  it('lets Claude and Codex ask about Runner Cloud, never the Vault', async () => {
    for (const engine of ['claude', 'codex']) {
      const state = await askUntilDone({ engine, question: 'policy?', store: 'runner' });
      assert.equal(state.error, null);
      assert.equal(state.text, '<p>From Runner Cloud.</p>');
    }
    assert.equal(cliTurns.length, 2);
    await assert.rejects(
      call('vaultAsk', { engine: 'claude', question: 'policy?' }),
      /read by Local AI on this runner only/
    );
    // Local AI reads the Vault.
    const local = await askUntilDone({ engine: 'ollama', model: 'llama3.2:3b', question: 'policy?' });
    assert.equal(local.error, null);
    assert.ok(local.sources.every((f) => f.store === 'vault'));
  });

  it('lists both stores’ chats, and follows a chat up in its own store', async () => {
    const { chats } = (await call('vaultChats', {})) as { chats: RunnerAskChat[] };
    assert.deepEqual(
      [...new Set(chats.map((c) => `${c.engine}:${c.store}`))].sort(),
      ['claude:runner', 'codex:runner', 'ollama:vault']
    );
    const claudeChat = chats.find((c) => c.engine === 'claude');
    assert.ok(claudeChat);
    // No store named: the runner finds the chat's own.
    const followUp = await askUntilDone({
      engine: 'claude',
      question: 'and the date?',
      chatId: claudeChat.id
    });
    assert.equal(followUp.error, null);
    const { chat } = await call('vaultChat', { chatId: claudeChat.id });
    assert.equal(chat.store, 'runner');
  });

  it('offers Categorize on the Vault with Local AI only', async () => {
    const status = await call('vaultCategorizeStatus', {});
    assert.deepEqual(status.models.cli, []);
    await assert.rejects(
      call('vaultCategorizeStart', {
        engine: 'claude',
        tree: { nodes: [], roots: [], edges: [] },
        aiResearchId: null
      }),
      /read by Local AI on this runner only/
    );
    const runner = await call('vaultCategorizeStatus', { store: 'runner' });
    assert.deepEqual(runner.models.cli, ['claude']);
  });

  it('moves a file to the other store as a copy, then deletes the original', async () => {
    const note = await add('Work/move-me.txt', 'move me to the vault', 'runner');
    const { moved, failed } = await call('vaultMove', { uploadIds: [note.id], to: 'vault' });
    assert.deepEqual(failed, []);
    assert.equal(moved[0]?.from, note.id);
    assert.equal(moved[0]?.file.store, 'vault');
    assert.equal(moved[0]?.file.name, 'Work/move-me.txt');
    const runnerIds = (await call('vaultFiles', { store: 'runner' })).files.map((f) => f.id);
    assert.ok(!runnerIds.includes(note.id));
    const download = await call('vaultDownload', { uploadId: moved[0]!.file.id, store: 'vault' });
    const read = await call('vaultRead', { ticket: download.ticket, offset: 0, length: 20 });
    assert.equal(Buffer.from(read.content, 'base64').toString(), 'move me to the vault');
    await assert.rejects(
      call('vaultMove', { uploadIds: [note.id], to: 'runner' }, STRANGER),
      /Only the owner/
    );
  });

  it('keeps out of Runner Cloud anyone the Vault keeps out', async () => {
    await assert.rejects(call('vaultFiles', { store: 'runner' }, STRANGER), /not shared with you/);
  });
});

describe('who the owner lets in', () => {
  // Runner Cloud only, never the Vault (.specs/vault.md rule 2).
  it('reaches Runner Cloud only, with no store named or with one', async () => {
    const vaultFile = (await call('vaultFiles', { store: 'vault' })).files[0];
    assert.ok(vaultFile);
    const status = await call('vaultShareSet', { memberId: '3', shared: true });
    // The whole status, as a status read gives it: the Vault's counts, and
    // who is let into Runner Cloud.
    assert.deepEqual(status.members, ['3']);
    assert.ok(status.runnerStorage);
    assert.deepEqual(daemon.members(), ['3']);
    assert.equal(daemon.isMember('3'), true);
    assert.deepEqual((await call('vaultStatus', {})).members, ['3']);

    const { files } = await call('vaultFiles', {}, STRANGER);
    assert.ok(files.length > 0);
    assert.ok(files.every((f) => f.store === 'runner'));
    const { hits } = await call('vaultSearch', { query: 'policy' }, STRANGER);
    assert.deepEqual([...new Set(hits.map((h) => h.store))], ['runner']);
    const theirs = (await call('vaultStatus', {}, STRANGER)) as RunnerVaultStatus;
    assert.equal(theirs.role, 'member');
    assert.deepEqual(theirs.members, []);

    // The Vault, named or by id, is never theirs.
    for (const [action, payload] of [
      ['vaultFiles', { store: 'vault' }],
      ['vaultStatus', { store: 'vault' }],
      ['vaultSearch', { query: 'policy', store: 'vault' }],
      ['vaultDownload', { uploadId: vaultFile.id, store: 'vault' }],
      ['vaultUploadStart', { name: 'x.txt', size: 1, contentType: 'text/plain', store: 'vault' }],
      ['vaultAskModels', { store: 'vault' }]
    ] as const) {
      await assert.rejects(daemon.handle(action, payload, STRANGER), /a Vault is never shared/, action);
    }
    await assert.rejects(call('vaultDownload', { uploadId: vaultFile.id }, STRANGER), /not in this vault/);

    // A member's file with no store named lands in Runner Cloud.
    const bytes = Buffer.from('from a friend');
    const { ticket } = await call(
      'vaultUploadStart',
      { name: 'Friend/hello.txt', size: bytes.length, contentType: 'text/plain' },
      STRANGER
    );
    assert.match(ticket, /^runner-storage:/);
    const { file } = await call('vaultWrite', { ticket, offset: 0, content: bytes.toString('base64'), last: true }, STRANGER);
    assert.equal(file?.store, 'runner');
    // The owner sees it, but cannot move it: it would be copied into the
    // owner's Vault and kept where it is, its delete being its adder's.
    const vaultBefore = (await call('vaultFiles', { store: 'vault' })).files.length;
    const refused = await call('vaultMove', { uploadIds: [file!.id], to: 'vault' });
    assert.deepEqual(refused.moved, []);
    assert.match(refused.failed[0]?.error ?? '', /Only the person who added it/);
    assert.equal((await call('vaultFiles', { store: 'vault' })).files.length, vaultBefore);
    assert.ok((await call('vaultFiles', { store: 'runner' })).files.some((f) => f.id === file!.id));

    // Only the owner changes who is in.
    await assert.rejects(call('vaultShareSet', { memberId: '4', shared: true }, STRANGER), /Only the owner/);
    await call('vaultShareSet', { memberId: '3', shared: false });
    assert.deepEqual(daemon.members(), []);
    await assert.rejects(call('vaultFiles', {}, STRANGER), /not shared with you/);
  });
});

describe('a runner from before Runner Cloud was encrypted and the Vault owner only', () => {
  const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-stores-old-'));
  const engineDir = path.join(oldDir, 'parts', 'vault', 'engine');
  const runnerRoot = path.join(oldDir, 'parts', 'runner-storage');
  let old: DaemonVault;
  let reported: string[][] = [];

  /** Every byte under a folder, to look for plaintext. */
  const bytesUnder = (dir: string): Buffer =>
    Buffer.concat(
      fs.readdirSync(dir, { withFileTypes: true }).map((entry) => {
        const at = path.join(dir, entry.name);
        return entry.isDirectory() ? bytesUnder(at) : fs.readFileSync(at);
      })
    );

  before(async () => {
    const modules = path.join(engineDir, 'node_modules');
    fs.mkdirSync(path.join(modules, '@electric-sql'), { recursive: true });
    fs.symlinkSync(path.join(ROOT_MODULES, VAULT_ENGINE_PACKAGE), path.join(modules, VAULT_ENGINE_PACKAGE));
    // The Vault's share table held who was let in.
    const vaultDb = await openVaultDb({ dataDir: storePaths(oldDir, 'vault').db, engineDir });
    await vaultDb.batch([
      {
        sql: `INSERT INTO "VaultShare" ("ownerId", "memberId", "status", "acceptedAt")
              VALUES (1, 3, 'ACCEPTED', CURRENT_TIMESTAMP)`
      }
    ]);
    await vaultDb.close();
    // Runner Cloud in the clear, with one file.
    const plainDb = await openVaultDb({ dataDir: storePaths(oldDir, 'runner').db, engineDir });
    const plain = new RunnerVault(
      plainDb,
      new FsObjectStore(storePaths(oldDir, 'runner').objects, Date.now, RUNNER_STORAGE_TICKET_SCHEME),
      '1',
      () => undefined,
      null,
      null,
      null,
      null,
      { storeName: 'runner' }
    );
    const bytes = Buffer.from('OLD-CLOUD-MARKER in the clear');
    const { ticket } = (await plain.handle(
      'vaultUploadStart',
      { name: 'Old/plain.txt', size: bytes.length, contentType: 'text/plain' },
      OWNER
    )) as { ticket: string };
    await plain.handle('vaultWrite', { ticket, offset: 0, content: bytes.toString('base64'), last: true }, OWNER);
    await plainDb.close();
    assert.equal(bytesUnder(runnerRoot).includes(Buffer.from('OLD-CLOUD-MARKER')), true);

    old = createDaemonVault(oldDir, '1', (members) => reported.push(members), embedder, engines, categorizeEngines);
    await old.load();
  });
  after(async () => {
    await old.close();
    fs.rmSync(oldDir, { recursive: true, force: true });
  });

  it('encrypts Runner Cloud in place on the first start, under a key the runner keeps', async () => {
    assert.ok(fs.existsSync(path.join(runnerRoot, 'keys.json')));
    assert.equal(fs.existsSync(path.join(runnerRoot, 'db')), false);
    assert.equal(bytesUnder(runnerRoot).includes(Buffer.from('OLD-CLOUD-MARKER')), false);
    // Off the runner's own folder the key is the 0600 file, never a Keychain.
    const keyFile = path.join(oldDir, RUNNER_CLOUD_KEY_FILE);
    assert.ok(fs.existsSync(keyFile));
    if (process.platform !== 'win32') assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
    // Nothing lost: the file is listed and reads back.
    const { files } = (await old.handle('vaultFiles', { store: 'runner' }, OWNER)) as BoardAgentActionMap['vaultFiles']['result'];
    assert.deepEqual(files.map((f) => f.name), ['Old/plain.txt']);
    const head = (await old.handle('vaultDownload', { uploadId: files[0]!.id }, OWNER)) as BoardAgentActionMap['vaultDownload']['result'];
    const read = (await old.handle('vaultRead', { ticket: head.ticket, offset: 0, length: 64 }, OWNER)) as BoardAgentActionMap['vaultRead']['result'];
    assert.equal(Buffer.from(read.content, 'base64').toString(), 'OLD-CLOUD-MARKER in the clear');
  });

  it('moves who was let in out of the Vault, into Runner Cloud', async () => {
    assert.deepEqual(old.members(), ['3']);
    assert.deepEqual(reported.at(-1), ['3']);
    const status = (await old.handle('vaultStatus', {}, OWNER)) as RunnerVaultStatus;
    assert.deepEqual(status.members, ['3']);
    // They read Runner Cloud, and the Vault refuses them.
    const theirs = (await old.handle('vaultFiles', {}, STRANGER)) as BoardAgentActionMap['vaultFiles']['result'];
    assert.deepEqual(theirs.files.map((f) => f.store), ['runner']);
    await assert.rejects(old.handle('vaultFiles', { store: 'vault' }, STRANGER), /a Vault is never shared/);
    // The Vault's own table is empty now.
    await old.close();
    const vaultDb = await openVaultDb({ dataDir: storePaths(oldDir, 'vault').db, engineDir });
    try {
      assert.deepEqual(await vaultDb.query('SELECT * FROM "VaultShare"'), []);
    } finally {
      await vaultDb.close();
    }
    // A restart reads the list from Runner Cloud, sealed.
    reported = [];
    old = createDaemonVault(oldDir, '1', (members) => reported.push(members), embedder, engines, categorizeEngines);
    await old.load();
    assert.deepEqual(old.members(), ['3']);
  });
});

describe('merging two stores', () => {
  it('ranks word matches over meaning, a store’s own order kept on a tie', () => {
    const hit = (id: string, distance: number | null) =>
      ({ id, distance }) as BoardAgentActionMap['vaultSearch']['result']['hits'][number];
    const merged = mergeSearches(
      [
        { hits: [hit('v1', 0.3), hit('v2', 0.5)], mode: 'meaning' },
        { hits: [hit('r1', null)], mode: 'words' }
      ],
      2
    );
    assert.deepEqual(merged.hits.map((h) => h.id), ['r1', 'v1']);
    assert.equal(merged.mode, 'words');
  });

  it('pages newest first, and says there is more past the limit', () => {
    const file = (id: string, createdAt: string) => ({ id, createdAt }) as RunnerVaultFile;
    const page = mergePages(
      [
        { files: [file('a', '2026-11-08T03:00:00.000Z'), file('b', '2026-11-08T01:00:00.000Z')], more: false },
        { files: [file('c', '2026-11-08T02:00:00.000Z')], more: false }
      ],
      2
    );
    assert.deepEqual(page.files.map((f) => f.id), ['a', 'c']);
    assert.equal(page.more, true);
  });
});
