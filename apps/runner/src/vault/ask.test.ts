import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import type {
  BoardAgentActionMap,
  RunnerAskModels,
  RunnerAskState,
  RunnerVaultFile,
  RunnerVaultNote
} from '@shared/all/domains/electron';
import type { ExecTarget } from '@shared/all/helpers/board-agent-core/exec';
import {
  RELAY_VAULT_REFUSAL,
  relaySecretsRefusal,
  type VouchedScope
} from '@shared/all/helpers/board-agent-core/runner-access';

import { type AskEngines, type AskMessage, VaultAsk } from './ask';
import {
  cliAnswer,
  cliRunSettings,
  ollamaBaseUrl,
  ollamaChat,
  ollamaModelsOnDisk,
  ollamaTakesTools
} from './askEngines';
import { openVaultDb, type VaultDb } from './db';
import { FsObjectStore } from './objectStore';
import { askTerms, RunnerVault } from './service';

// Oakbox Ask with a runner's own model (.specs/runner-vault-ask.md "Ask with a
// runner's model"), on a real Vault database: who may ask with what, the
// search it answers from, and the answer from a fake Ollama (over HTTP, as
// the real one) and a fake Claude CLI (stream-json on stdout, as the real one).

const OWNER = { role: 'owner' as const, userId: '1', name: 'Owner' };
const PEER = { role: 'member' as const, spaceSlugs: [], userId: '2', name: 'Peer', vault: true };
const STRANGER = { ...PEER, userId: '3' };
const ENGINE = path.resolve(__dirname, '../..');

let db: VaultDb;
let vault: RunnerVault;
/** The same rows as Runner Storage, the store Claude and Codex may read
 *  (.specs/runner-vault-ask.md "Which store Ask reads"). */
let storage: RunnerVault;
/** A file no question's words find: only an added one reaches the model. */
let recipe: RunnerVaultFile;
let ollama: http.Server;
let ollamaUrl = '';
/** What the fake Ollama was sent, last request first. */
type OllamaBody = {
  model: string;
  messages: (AskMessage | { role: 'tool'; content: string; tool_name: string })[];
  tools?: { function: { name: string } }[];
};
const ollamaBodies: OllamaBody[] = [];
/** Set when a slow request's connection closed before it answered. */
let ollamaAborted = false;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-vault-ask-'));

/** The fake CLI, both kinds: records its argv and stdin, uses the Vault's
 *  MCP server from its config the way the real one does (initialize, list,
 *  search, read), then answers as `claude -p --output-format stream-json`
 *  or `codex exec --json` prints. */
const FAKE_CLI = path.join(tmp, 'cli.js');
const CLI_SEEN = path.join(tmp, 'cli-seen.json');
/** Where a slow fake CLI writes its pid, for a stop to be checked. */
const CLI_PID = path.join(tmp, 'cli-pid');
/** A question with this in it never finishes on its own, on either fake. */
const SLOW = 'take your time';
fs.writeFileSync(
  FAKE_CLI,
  `const argv = process.argv.slice(2);
const codex = argv[0] === 'exec';
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', async () => {
  if (input.includes(${JSON.stringify(SLOW)})) {
    require('fs').writeFileSync(${JSON.stringify(CLI_PID)}, String(process.pid));
    process.stdout.write(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '<p>Let me see' } } }) + '\\n');
    setInterval(() => {}, 1000);
    return;
  }
  let url, token;
  if (codex) {
    const at = argv.find((a) => a.startsWith('mcp_servers.factiii-vault.url='));
    url = JSON.parse(at.split('=').slice(1).join('='));
    token = process.env.FACTIII_VAULT_MCP_TOKEN;
  } else {
    const server = JSON.parse(argv[argv.indexOf('--mcp-config') + 1]).mcpServers['factiii-vault'];
    url = server.url;
    token = server.headers.Authorization.slice('Bearer '.length);
  }
  let id = 0;
  const rpc = async (method, params) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params })
    });
    return (await res.json()).result;
  };
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake' } });
  const tools = (await rpc('tools/list', {})).tools.map((t) => t.name);
  const hits = (await rpc('tools/call', { name: 'search_my_files', arguments: { query: 'policy number' } })).content[0].text;
  const fileId = JSON.parse(hits)[0].uploadId;
  const file = (await rpc('tools/call', { name: 'read_my_file', arguments: { uploadId: fileId } })).content[0].text;
  // Asked to keep it: saves twice at once, as a model may.
  const saves = /keep this/.test(input)
    ? await Promise.all([1, 2].map(() =>
        rpc('tools/call', { name: 'save_research', arguments: { title: 'Policy', body: '<p>AB-123</p>' } })
      ).map((p) => p.then((r) => r.content[0].text)))
    : [];
  require('fs').writeFileSync(${JSON.stringify(CLI_SEEN)}, JSON.stringify({ argv, input, tools, hits, file, saves }));
  const out = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
  const answer = '<p>The policy number is AB-123 (insurance.txt).</p>';
  if (codex) {
    out({ type: 'thread.started', thread_id: 't1' });
    out({ type: 'item.completed', item: { type: 'agent_message', text: answer } });
    return;
  }
  for (const text of ['<p>The policy number is ', 'AB-123 (insurance.txt).</p>']) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
  }
  out({ type: 'result', result: answer });
});
`
);

/** An exec target whose `claude` and `codex` are the fake, signed in. */
const fakeTarget = {
  agentEnv: () => ({}),
  sh: async (cmd: string) => (cmd.includes('auth status') ? '{"loggedIn":true}' : ''),
  spawn: async (argv: string[], opts?: { cwd?: string; env?: Record<string, string> }) =>
    spawn(process.execPath, [FAKE_CLI, ...argv.slice(1)], {
      cwd: opts?.cwd,
      env: { ...process.env, ...opts?.env }
    })
} as unknown as ExecTarget;

type Seen = {
  argv: string[];
  input: string;
  tools: string[];
  hits: string;
  file: string;
  saves: string[];
};
const seen = (): Seen => JSON.parse(fs.readFileSync(CLI_SEEN, 'utf-8')) as Seen;

function engines(over: Partial<AskEngines> = {}): AskEngines {
  return {
    ollamaModels: async () => ['llama3.2:3b', 'llama3.1:8b'],
    ollamaTakesTools: async () => false,
    clis: async () => ['claude', 'codex'],
    ollama: (model, messages, onText, tools, signal) =>
      ollamaChat(ollamaUrl, model, messages, onText, fetch, tools, signal),
    cli: (engine, prompt, vault, onText, settings, signal) =>
      cliAnswer(fakeTarget, engine, prompt, vault, onText, settings, signal),
    ...over
  };
}

/** A file in the Vault with `text` as the ingest would have read it. */
async function add(name: string, text: string): Promise<RunnerVaultFile> {
  const bytes = Buffer.from(text);
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
  await db.query(
    `UPDATE "PostContent" SET "text" = $2, "page" = 1
      WHERE "postId" = (SELECT "A" FROM "_postUploads" WHERE "B" = $1)`,
    [file.id, text]
  );
  return file;
}

/** Ask, then read the turn until it is done. */
async function ask(
  asker: VaultAsk,
  payload: unknown,
  scope: VouchedScope
): Promise<RunnerAskState & { chatId: string }> {
  const { askId, chatId } = (await asker.handle('vaultAsk', payload, scope)) as {
    askId: string;
    chatId: string;
  };
  for (let i = 0; i < 200; i++) {
    const state = (await asker.handle('vaultAskPoll', { askId }, scope)) as RunnerAskState;
    if (state.done) return { ...state, chatId };
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('The turn never finished.');
}

before(async () => {
  db = await openVaultDb({ dataDir: 'memory://', engineDir: ENGINE });
  const objects = new FsObjectStore(path.join(tmp, 'objects'));
  vault = new RunnerVault(db, objects, '1', () => {});
  storage = new RunnerVault(db, objects, '1', () => {}, null, null, null, null, {
    storeName: 'runner',
    members: () => vault.memberIds()
  });
  await vault.handle('vaultShareSet', { memberId: '2', shared: true }, OWNER);
  await add('Insurance/insurance.txt', 'Home insurance. Policy number AB-123. Renews in May.');
  recipe = await add('Recipes/bread.txt', 'Flour, water, salt and yeast.');
  // A fake Ollama: checks what it was sent, answers in three pieces. With
  // tools and "keep this" asked, it calls save_research first, as llama3.2
  // does, then answers once it has the result.
  ollama = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = JSON.parse(raw) as OllamaBody;
      ollamaBodies.unshift(body);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const line = (event: unknown) => res.write(`${JSON.stringify(event)}\n`);
      const tool = body.messages.find((m) => m.role === 'tool');
      // Writes a piece, then waits for ever: only a stop ends it.
      if (body.messages.at(-1)?.content.includes(SLOW)) {
        line({ message: { role: 'assistant', content: '<p>Let me see' }, done: false });
        res.on('close', () => {
          ollamaAborted = !res.writableEnded;
        });
        return;
      }
      if (body.tools && !tool && /keep this/.test(body.messages.at(-1)?.content ?? '')) {
        line({
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { function: { name: 'save_research', arguments: { title: 'Policy', body: '<p>AB-123</p>' } } }
            ]
          },
          done: false
        });
        res.end(`${JSON.stringify({ done: true })}\n`);
        return;
      }
      const pieces = tool
        ? ['<p>Kept it.</p>']
        : ['<p>It is ', 'AB-123', ' (insurance.txt, page 1).</p>'];
      for (const content of pieces) line({ message: { role: 'assistant', content }, done: false });
      res.end(`${JSON.stringify({ done: true })}\n`);
    });
  });
  await new Promise<void>((resolve) => ollama.listen(0, '127.0.0.1', resolve));
  ollamaUrl = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`;
});
after(async () => {
  ollama.close();
  await db.close();
});

describe('Ask on a runner', () => {
  it('is never carried by the relay', () => {
    for (const action of ['vaultAskModels', 'vaultAsk', 'vaultAskPoll'] as const) {
      assert.equal(relaySecretsRefusal('socket', action, {}), RELAY_VAULT_REFUSAL);
      assert.equal(relaySecretsRefusal('webrtc', action, {}), null);
    }
  });

  it('offers the owner Ollama, Claude and Codex, and a peer Ollama only', async () => {
    const asker = new VaultAsk(vault, engines());
    const mine = (await asker.handle('vaultAskModels', {}, OWNER)) as RunnerAskModels;
    assert.deepEqual(mine.ollama, [
      { id: 'llama3.2:3b', title: 'Llama 3.2 3B' },
      { id: 'llama3.1:8b', title: 'Llama 3.1 8B' }
    ]);
    assert.deepEqual(mine.cli, ['claude', 'codex']);
    const theirs = (await asker.handle('vaultAskModels', {}, PEER)) as RunnerAskModels;
    assert.equal(theirs.ollama.length, 2);
    assert.deepEqual(theirs.cli, []);
    await assert.rejects(asker.handle('vaultAskModels', {}, STRANGER), /not shared with you/);
  });

  it('refuses a peer Claude and Codex, before anything is read', async () => {
    let read = false;
    const asker = new VaultAsk(
      vault,
      engines({
        cli: async () => {
          read = true;
          return '';
        }
      })
    );
    for (const engine of ['claude', 'codex']) {
      await assert.rejects(
        asker.handle('vaultAsk', { engine, question: 'What is my policy number?' }, PEER),
        /only the owner asks with them/
      );
    }
    assert.equal(read, false);
    await assert.rejects(
      asker.handle('vaultAsk', { engine: 'ollama', model: 'llama3.1:8b', question: 'policy' }, STRANGER),
      /not shared with you/
    );
  });

  it('refuses the owner Claude and Codex on the Vault, before anything is read', async () => {
    let read = false;
    const asker = new VaultAsk(
      vault,
      engines({
        cli: async () => {
          read = true;
          return '';
        }
      })
    );
    for (const engine of ['claude', 'codex']) {
      await assert.rejects(
        asker.handle('vaultAsk', { engine, question: 'What is my policy number?' }, OWNER),
        /read by Local AI on this runner only/
      );
    }
    // A Claude chat kept in the Vault from before: its follow-up runs on
    // Claude, so it is refused too, whatever the payload says.
    const [{ id: chatId }] = await db.query<{ id: string }>(
      `INSERT INTO "RunnerAskChat" ("id", "userId", "title", "engine", "model")
       VALUES (gen_random_uuid()::text, 1, 'old', 'claude', NULL) RETURNING "id"`
    );
    await assert.rejects(
      asker.handle(
        'vaultAsk',
        { engine: 'ollama', model: 'llama3.2:3b', question: 'and now?', chatId },
        OWNER
      ),
      /read by Local AI on this runner only/
    );
    await db.query('DELETE FROM "RunnerAskChat" WHERE "id" = $1', [chatId]);
    assert.equal(read, false);
  });

  it('lets the owner ask Claude and Codex about Runner Storage', async () => {
    const asker = new VaultAsk(
      storage,
      engines({ cli: async (_engine, _prompt, mcp) => `<p>Read through ${mcp.tools.length} tools.</p>` })
    );
    for (const engine of ['claude', 'codex']) {
      const state = await ask(asker, { engine, question: 'What is my policy number?' }, OWNER);
      assert.equal(state.error, null);
      assert.match(state.text, /Read through \d+ tools/);
    }
  });

  it('answers a peer with Ollama from the files it found, streamed, citing them', async () => {
    const asker = new VaultAsk(vault, engines());
    const state = await ask(
      asker,
      {
        engine: 'ollama',
        model: 'llama3.1:8b',
        question: 'What is my policy number?',
        history: [
          { role: 'you', text: 'Hi' },
          { role: 'answer', text: '<p>Hello.</p>' }
        ]
      },
      PEER
    );
    assert.equal(state.error, null);
    assert.equal(state.text, '<p>It is AB-123 (insurance.txt, page 1).</p>');
    assert.deepEqual(
      state.sources.map((f) => f.name),
      ['Insurance/insurance.txt']
    );
    assert.deepEqual(state.steps, [
      'Searching your vault on this runner',
      'Reading 1 file',
      'Asking Llama 3.1 8B'
    ]);
    // Ollama got the file's text in its instructions, the thread, then the
    // question.
    const [sent] = ollamaBodies;
    assert.equal(sent?.model, 'llama3.1:8b');
    assert.match(sent?.messages[0]?.content ?? '', /<file name="Insurance\/insurance.txt">\n\[page 1\] Home insurance\. Policy number AB-123/);
    assert.doesNotMatch(sent?.messages[0]?.content ?? '', /yeast/);
    assert.deepEqual(
      sent?.messages.slice(1).map((m) => m.role),
      ['user', 'assistant', 'user']
    );
  });

  it('answers the owner with Claude, which searches and reads through the Vault MCP', async () => {
    const asker = new VaultAsk(storage, engines());
    const state = await ask(asker, { engine: 'claude', question: 'What is my policy number?' }, OWNER);
    assert.equal(state.error, null);
    assert.equal(state.text, '<p>The policy number is AB-123 (insurance.txt).</p>');
    // Each tool call is two steps, labelled as the cloud labels them; the
    // file it read is the source.
    assert.deepEqual(state.steps, [
      'Asking Claude',
      'Searching your files for “policy number”',
      'Found “policy number” in Insurance/insurance.txt',
      'Opening a file',
      'Read Insurance/insurance.txt'
    ]);
    assert.deepEqual(
      state.sources.map((f) => f.name),
      ['Insurance/insurance.txt']
    );
    const { argv, input, tools, hits, file } = seen();
    // The cloud's file tools, with no tag tools when no tree came with it.
    assert.deepEqual(tools, ['search_my_files', 'list_my_files', 'save_research', 'read_my_file']);
    assert.match(hits, /"name":"Insurance\/insurance\.txt"/);
    assert.match(file, /\[page 1\] Home insurance\. Policy number AB-123/);
    // The prompt carries no file: the model fetched it.
    assert.doesNotMatch(input, /AB-123/);
    assert.match(input, /The question: What is my policy number\?/);
    // Locked down: `dontAsk` (plan mode blocked the Vault's tools too), the
    // Vault's tools only, no built-in tool at all, no other MCP server, never
    // a bypass.
    assert.equal(argv[0], '-p');
    assert.equal(argv[argv.indexOf('--output-format') + 1], 'stream-json');
    assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(argv[argv.indexOf('--tools') + 1], '');
    assert.equal(
      argv[argv.indexOf('--allowedTools') + 1],
      'mcp__factiii-vault__search_my_files,mcp__factiii-vault__list_my_files,mcp__factiii-vault__save_research,mcp__factiii-vault__read_my_file'
    );
    assert.ok(argv.includes('--strict-mcp-config'));
    assert.match(argv[argv.indexOf('--disallowedTools') + 1] ?? '', /Bash,Read/);
    assert.ok(!argv.some((a) => /dangerously|bypass/.test(a)));
    // Nothing chosen in Account > Backend: the CLI's own model and effort.
    assert.ok(!argv.includes('--model') && !argv.includes('--effort'));
  });

  it('runs Claude and Codex on the model and effort chosen in Account > Backend', async () => {
    const asker = new VaultAsk(storage, engines());
    await ask(
      asker,
      { engine: 'claude', question: 'policy', cli: { model: 'sonnet', effort: 'max' } },
      OWNER
    );
    let { argv } = seen();
    assert.equal(argv[argv.indexOf('--model') + 1], 'sonnet');
    assert.equal(argv[argv.indexOf('--effort') + 1], 'max');

    await ask(
      asker,
      { engine: 'codex', question: 'policy', cli: { model: 'gpt-6-luna', effort: 'low' } },
      OWNER
    );
    ({ argv } = seen());
    assert.ok(argv.includes('model="gpt-6-luna"'));
    assert.ok(argv.includes('model_reasoning_effort="low"'));
    assert.ok(!argv.includes('--model'));
  });

  it('refuses settings that are not the engine’s own', async () => {
    const asker = new VaultAsk(storage, engines());
    // Claude's model on Codex, and text that is on no list.
    for (const payload of [
      { engine: 'codex', question: 'policy', cli: { model: 'sonnet', effort: null } },
      { engine: 'claude', question: 'policy', cli: { model: 'opus; rm -rf ~', effort: null } },
      {
        engine: 'ollama',
        model: 'llama3.2:3b',
        question: 'policy',
        cli: { model: null, effort: 'low' }
      }
    ]) {
      await assert.rejects(asker.handle('vaultAsk', payload, OWNER));
    }
    // And what reaches the run is read against the list again.
    assert.deepEqual(cliRunSettings('codex', { model: 'sonnet', effort: null } as never), {
      codexConfig: []
    });
    assert.deepEqual(cliRunSettings('claude', { model: null, effort: 'high' }), {
      effort: 'high',
      codexConfig: []
    });
  });

  it('answers the owner with Codex in a read-only sandbox, through the same tools', async () => {
    const asker = new VaultAsk(storage, engines());
    const state = await ask(asker, { engine: 'codex', question: 'What is my policy number?' }, OWNER);
    assert.equal(state.error, null);
    assert.equal(state.text, '<p>The policy number is AB-123 (insurance.txt).</p>');
    assert.equal(state.steps[0], 'Asking Codex');
    const { argv } = seen();
    // The permission flags come right after `exec` (codex-permissions.ts), so
    // only the subcommand's place is fixed.
    assert.equal(argv[0], 'exec');
    assert.ok(argv.includes('--json'));
    assert.equal(argv[argv.indexOf('--sandbox') + 1], 'read-only');
    assert.ok(!argv.some((a) => /dangerously|bypass/.test(a)));
    // Never asks: the Vault's tools approved and the only ones on, its shell
    // and web search off.
    assert.ok(argv.includes('approval_policy="never"'));
    assert.ok(argv.includes('mcp_servers.factiii-vault.default_tools_approval_mode="approve"'));
    assert.ok(argv.some((a) => a.startsWith('mcp_servers.factiii-vault.enabled_tools=["search_my_files"')));
    assert.ok(argv.includes('features.shell_tool=false'));
    assert.ok(argv.includes('web_search="disabled"'));
    // The token rides in the env, not on the command line.
    assert.ok(argv.includes('mcp_servers.factiii-vault.bearer_token_env_var="FACTIII_VAULT_MCP_TOKEN"'));
  });

  it('keeps the Vault MCP to its token, and closes it with the turn', async () => {
    let mcpUrl = '';
    const asker = new VaultAsk(
      storage,
      engines({
        cli: async (_engine, _prompt, mcp) => {
          mcpUrl = mcp.url;
          const res = await fetch(mcp.url, {
            method: 'POST',
            headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
            body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
          });
          assert.equal(res.status, 401);
          return '<p>ok</p>';
        }
      })
    );
    await ask(asker, { engine: 'claude', question: 'policy' }, OWNER);
    await assert.rejects(fetch(mcpUrl, { method: 'POST', body: '{}' }));
  });

  it('refuses a model the runner does not have, and a turn that is not yours', async () => {
    const asker = new VaultAsk(storage, engines({ clis: async () => ['claude'] }));
    await assert.rejects(
      asker.handle('vaultAsk', { engine: 'ollama', model: 'qwen2.5:32b', question: 'policy' }, OWNER),
      /not on this runner/
    );
    await assert.rejects(
      asker.handle('vaultAsk', { engine: 'codex', question: 'policy' }, OWNER),
      /Codex is not added/
    );
    const { askId } = (await asker.handle(
      'vaultAsk',
      { engine: 'ollama', model: 'llama3.2:3b', question: 'policy' },
      OWNER
    )) as { askId: string };
    await assert.rejects(asker.handle('vaultAskPoll', { askId }, PEER), /gone/);
  });

  it('reads the files added to the question first, by id, waiting while they are read', async () => {
    // Still being read: the turn waits, then answers from what there is.
    const waiting = new VaultAsk(vault, engines(), Date.now, 30);
    const state = await ask(
      waiting,
      { engine: 'ollama', model: 'llama3.2:3b', question: 'What is my policy number?', fileIds: [recipe.id] },
      OWNER
    );
    assert.equal(state.error, null);
    assert.equal(state.steps[0], 'Waiting for your runner to read the files you added');
    assert.deepEqual(
      state.sources.map((f) => f.name),
      ['Recipes/bread.txt', 'Insurance/insurance.txt']
    );
    const content = ollamaBodies[0]?.messages[0]?.content ?? '';
    assert.ok(content.indexOf('yeast') < content.indexOf('AB-123'));
    assert.ok(content.indexOf('yeast') > 0);

    // Read: no wait. An id the caller does not read is left out.
    await db.query(`UPDATE "Upload" SET "ingestStatus" = 'EMBEDDED' WHERE "id" = $1`, [recipe.id]);
    const read = await ask(
      new VaultAsk(vault, engines()),
      {
        engine: 'ollama',
        model: 'llama3.2:3b',
        question: 'Where is the zebra?',
        fileIds: [recipe.id, '00000000-0000-4000-8000-000000000000']
      },
      OWNER
    );
    assert.deepEqual(read.steps.slice(0, 2), ['Searching your vault on this runner', 'Reading 1 file']);
    assert.deepEqual(
      read.sources.map((f) => f.name),
      ['Recipes/bread.txt']
    );
    await db.query(`UPDATE "Upload" SET "ingestStatus" = 'PENDING' WHERE "id" = $1`, [recipe.id]);
  });

  it('names the added files to Claude, to read first', async () => {
    await ask(new VaultAsk(storage, engines(), Date.now, 0), { engine: 'claude', question: 'policy', fileIds: [recipe.id] }, OWNER);
    assert.match(seen().input, new RegExp(`Read them with read_my_file first:\\n\\nuploadId: ${recipe.id}\\nname: Recipes/bread.txt`));
  });

  it('refuses more files than a question takes', async () => {
    const ids = Array.from({ length: 11 }, () => recipe.id);
    await assert.rejects(
      new VaultAsk(vault, engines()).handle('vaultAsk', { engine: 'ollama', model: 'llama3.2:3b', question: 'policy', fileIds: ids }, OWNER)
    );
  });

  it('says so when no file matches, and still asks the model', async () => {
    const asker = new VaultAsk(vault, engines());
    const state = await ask(asker, { engine: 'ollama', model: 'llama3.2:3b', question: 'Where is the zebra?' }, OWNER);
    assert.deepEqual(state.sources, []);
    assert.equal(state.steps[1], 'No file in the vault matched the question.');
  });

  it('keeps a note with Claude’s save_research, once a turn, and says so', async () => {
    const asker = new VaultAsk(storage, engines());
    const state = await ask(
      asker,
      { engine: 'claude', question: 'What is my policy number? keep this', aiResearchId: 77 },
      OWNER
    );
    assert.equal(state.error, null);
    assert.equal(state.saved?.title, 'Policy');
    // Each call is labelled, as the cloud labels it; both are answered with
    // the one note, in the cloud's tool's shape.
    assert.equal(state.steps.filter((step) => step === 'Saved “Policy” to your files').length, 2);
    const { saves } = seen();
    assert.deepEqual(
      saves.map((text) => JSON.parse(text) as { postUuid: string }),
      [
        { postUuid: state.saved?.id, title: 'Policy' },
        { postUuid: state.saved?.id, title: 'Policy' }
      ]
    );
    const { notes } = (await vault.handle('vaultNotes', {}, OWNER)) as { notes: RunnerVaultNote[] };
    assert.equal(notes.filter((n) => n.title === 'Policy').length, 1);
    const [tag] = await db.query<{ factiiiId: number }>(
      `SELECT c."factiiiId" FROM "PostFactiiiCount" c JOIN "Post" p ON p."id" = c."postId" WHERE p."uuid" = $1::uuid`,
      [state.saved?.id]
    );
    assert.equal(tag?.factiiiId, 77);
    await vault.handle('vaultNoteDelete', { noteId: state.saved?.id }, OWNER);
  });

  it('keeps a note through Ollama’s tool calling, where the model takes tools', async () => {
    const asker = new VaultAsk(vault, engines({ ollamaTakesTools: async () => true }));
    const state = await ask(
      asker,
      { engine: 'ollama', model: 'llama3.2:3b', question: 'keep this as a note' },
      OWNER
    );
    assert.equal(state.error, null);
    assert.equal(state.text, '<p>Kept it.</p>');
    assert.equal(state.saved?.title, 'Policy');
    assert.equal(state.steps.at(-1), 'Saved “Policy” to your files');
    // The call, then its result handed back with the tool's name.
    const [second, first] = ollamaBodies;
    assert.deepEqual(first?.tools?.map((t) => t.function.name), [
      'search_my_files',
      'list_my_files',
      'save_research',
      'read_my_file'
    ]);
    assert.match(first?.messages[0]?.content ?? '', /call save_research/);
    const result = second?.messages.at(-1);
    assert.equal(result?.role, 'tool');
    assert.deepEqual(JSON.parse(result?.content ?? '{}'), { postUuid: state.saved?.id, title: 'Policy' });
    await vault.handle('vaultNoteDelete', { noteId: state.saved?.id }, OWNER);
  });

  it('offers no tool to a model without tools, and no save tool to a peer, and says why', async () => {
    const plain = await ask(
      new VaultAsk(vault, engines()),
      { engine: 'ollama', model: 'llama3.2:3b', question: 'keep this as a note' },
      OWNER
    );
    assert.equal(plain.saved, undefined);
    assert.equal(ollamaBodies[0]?.tools, undefined);
    assert.match(ollamaBodies[0]?.messages[0]?.content ?? '', /this model cannot keep notes/);

    const peer = await ask(
      new VaultAsk(vault, engines({ ollamaTakesTools: async () => true })),
      { engine: 'ollama', model: 'llama3.2:3b', question: 'keep this as a note' },
      PEER
    );
    assert.equal(peer.saved, undefined);
    // A peer searches and reads with the rest.
    const [asked] = ollamaBodies;
    assert.deepEqual(asked?.tools?.map((t) => t.function.name), [
      'search_my_files',
      'list_my_files',
      'read_my_file'
    ]);
    assert.match(ollamaBodies[0]?.messages[0]?.content ?? '', /only the owner of this runner keeps notes/);
  });

  it('reports a model that fails as the turn’s error', async () => {
    const asker = new VaultAsk(
      vault,
      engines({
        ollama: async () => {
          throw new Error('Ollama did not answer (500).');
        }
      })
    );
    const state = await ask(asker, { engine: 'ollama', model: 'llama3.2:3b', question: 'policy' }, OWNER);
    assert.equal(state.error, 'Ollama did not answer (500).');
  });
});

describe('Runner chats', () => {
  type Chats = BoardAgentActionMap['vaultChats']['result'];
  type Chat = BoardAgentActionMap['vaultChat']['result'];
  const LLAMA = { engine: 'ollama', model: 'llama3.1:8b' };

  it('are never carried by the relay', () => {
    for (const action of ['vaultChats', 'vaultChat', 'vaultChatDelete'] as const) {
      assert.equal(relaySecretsRefusal('socket', action, {}), RELAY_VAULT_REFUSAL);
    }
  });

  it('saves a turn as a chat of the asker’s own, with its steps and sources', async () => {
    const asker = new VaultAsk(vault, engines());
    const { chatId } = await ask(asker, { ...LLAMA, question: 'What is my policy number?' }, PEER);
    const { chats } = (await asker.handle('vaultChats', {}, PEER)) as Chats;
    const listed = chats.find((c) => c.id === chatId);
    assert.equal(listed?.title, 'What is my policy number?');
    assert.equal(listed?.modelTitle, 'Llama 3.1 8B');
    const { messages } = (await asker.handle('vaultChat', { chatId }, PEER)) as Chat;
    assert.deepEqual(
      messages.map((m) => [m.role, m.text]),
      [
        ['you', 'What is my policy number?'],
        ['answer', '<p>It is AB-123 (insurance.txt, page 1).</p>']
      ]
    );
    assert.equal(messages[1]?.steps.at(-1), 'Asking Llama 3.1 8B');
    assert.deepEqual(messages[1]?.sources.map((f) => f.name), ['Insurance/insurance.txt']);
    assert.equal(typeof messages[1]?.ms, 'number');
    // The owner's list is the owner's own: a peer's chat is not in it, and
    // they cannot open, continue or delete it.
    const owner = (await asker.handle('vaultChats', {}, OWNER)) as Chats;
    assert.ok(!owner.chats.some((c) => c.id === chatId));
    await assert.rejects(asker.handle('vaultChat', { chatId }, OWNER), /not on this runner/);
    await assert.rejects(
      asker.handle('vaultAsk', { ...LLAMA, question: 'And?', chatId }, OWNER),
      /not on this runner/
    );
    const kept = (await asker.handle('vaultChatDelete', { chatId }, OWNER)) as { deleted: boolean };
    assert.equal(kept.deleted, false);
    await assert.rejects(asker.handle('vaultChats', {}, STRANGER), /not shared with you/);
  });

  it('continues a chat on its own model, from its stored thread', async () => {
    const asker = new VaultAsk(vault, engines());
    const { chatId } = await ask(asker, { ...LLAMA, question: 'What is my policy number?' }, OWNER);
    // The payload's model and history are not the chat's: the chat's win.
    const next = await ask(
      asker,
      { engine: 'ollama', model: 'llama3.2:3b', question: 'When does it renew?', chatId, history: [] },
      OWNER
    );
    assert.equal(next.chatId, chatId);
    const [sent] = ollamaBodies;
    assert.equal(sent?.model, 'llama3.1:8b');
    assert.deepEqual(
      sent?.messages.slice(1).map((m) => [m.role, m.content]),
      [
        ['user', 'What is my policy number?'],
        ['assistant', '<p>It is AB-123 (insurance.txt, page 1).</p>'],
        ['user', 'When does it renew?']
      ]
    );
    const { messages } = (await asker.handle('vaultChat', { chatId }, OWNER)) as Chat;
    assert.deepEqual(messages.map((m) => m.role), ['you', 'answer', 'you', 'answer']);
    const { chats } = (await asker.handle('vaultChats', {}, OWNER)) as Chats;
    assert.equal(chats[0]?.id, chatId);
  });

  it('keeps why a turn failed, and deletes a chat for good', async () => {
    const asker = new VaultAsk(
      vault,
      engines({
        ollama: async () => {
          throw new Error('Ollama did not answer (500).');
        }
      })
    );
    const { chatId } = await ask(asker, { ...LLAMA, question: 'policy' }, OWNER);
    const { chat, messages } = (await asker.handle('vaultChat', { chatId }, OWNER)) as Chat;
    assert.equal(chat.error, 'Ollama did not answer (500).');
    assert.deepEqual(messages.map((m) => m.role), ['you']);
    const gone = (await asker.handle('vaultChatDelete', { chatId }, OWNER)) as { deleted: boolean };
    assert.equal(gone.deleted, true);
    await assert.rejects(asker.handle('vaultChat', { chatId }, OWNER), /not on this runner/);
    const left = await db.query('SELECT 1 FROM "RunnerAskMessage" WHERE "chatId" = $1', [chatId]);
    assert.equal(left.length, 0);
  });
});

describe('Stopping a turn', () => {
  type Chat = BoardAgentActionMap['vaultChat']['result'];

  /** Start a slow turn, and wait until the model has written something. */
  async function slow(asker: VaultAsk, payload: object, scope: VouchedScope) {
    const started = (await asker.handle(
      'vaultAsk',
      { question: `What is my policy number? ${SLOW}`, ...payload },
      scope
    )) as { askId: string; chatId: string };
    for (let i = 0; i < 300; i++) {
      const state = (await asker.handle('vaultAskPoll', { askId: started.askId }, scope)) as RunnerAskState;
      if (state.text) return started;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('The model never started writing.');
  }

  it('aborts the Ollama request, keeps no answer, and says the turn stopped', async () => {
    ollamaAborted = false;
    const asker = new VaultAsk(vault, engines());
    const { askId, chatId } = await slow(asker, { engine: 'ollama', model: 'llama3.2:3b' }, OWNER);
    const state = (await asker.handle('vaultAskCancel', { askId }, OWNER)) as RunnerAskState;
    assert.equal(state.done, true);
    assert.equal(state.stopped, true);
    assert.equal(state.error, null);
    // The connection to Ollama closed before it finished: it stops generating.
    for (let i = 0; i < 100 && !ollamaAborted; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(ollamaAborted, true);
    const { chat, messages } = (await asker.handle('vaultChat', { chatId }, OWNER)) as Chat;
    assert.equal(chat.stopped, true);
    assert.equal(chat.error, null);
    assert.deepEqual(messages.map((m) => m.role), ['you']);
    // A follow-up runs as usual, and the chat no longer reads as stopped.
    const next = await ask(asker, { engine: 'ollama', model: 'llama3.2:3b', question: 'policy', chatId }, OWNER);
    assert.equal(next.stopped, undefined);
    assert.match(next.text, /AB-123/);
    const after = (await asker.handle('vaultChat', { chatId }, OWNER)) as Chat;
    assert.equal(after.chat.stopped, false);
    assert.deepEqual(after.messages.map((m) => m.role), ['you', 'you', 'answer']);
  });

  it('kills the Claude process, and stops no turn but the caller’s own', async () => {
    fs.rmSync(CLI_PID, { force: true });
    const asker = new VaultAsk(storage, engines());
    const { askId, chatId } = await slow(asker, { engine: 'claude' }, OWNER);
    const pid = Number(fs.readFileSync(CLI_PID, 'utf-8'));
    // Someone else's turn reads as gone, as a poll does.
    await assert.rejects(asker.handle('vaultAskCancel', { askId }, PEER), /gone/);
    const state = (await asker.handle('vaultAskCancel', { askId }, OWNER)) as RunnerAskState;
    assert.equal(state.stopped, true);
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
    const { chat } = (await asker.handle('vaultChat', { chatId }, OWNER)) as Chat;
    assert.equal(chat.stopped, true);
    // Stopping a turn that is over answers it as it ended.
    const again = (await asker.handle('vaultAskCancel', { askId }, OWNER)) as RunnerAskState;
    assert.equal(again.stopped, true);
  });

  it('lets the owner stop a peer’s turn', async () => {
    const asker = new VaultAsk(vault, engines());
    const { askId } = await slow(asker, { engine: 'ollama', model: 'llama3.2:3b' }, PEER);
    const state = (await asker.handle('vaultAskCancel', { askId }, OWNER)) as RunnerAskState;
    assert.equal(state.stopped, true);
  });

  it('is never carried by the relay', () => {
    assert.equal(relaySecretsRefusal('socket', 'vaultAskCancel', {}), RELAY_VAULT_REFUSAL);
    assert.equal(relaySecretsRefusal('webrtc', 'vaultAskCancel', {}), null);
  });
});

describe('Ask helpers', () => {
  it('searches a question by its longer words', () => {
    assert.deepEqual(askTerms('What is my policy number for the house?'), ['policy', 'number', 'house']);
  });

  it('reads Ollama’s address as Ollama does', () => {
    assert.equal(ollamaBaseUrl({}), 'http://127.0.0.1:11434');
    assert.equal(ollamaBaseUrl({ OLLAMA_HOST: '0.0.0.0' }), 'http://127.0.0.1:11434');
    assert.equal(ollamaBaseUrl({ OLLAMA_HOST: '0.0.0.0:9000' }), 'http://127.0.0.1:9000');
    assert.equal(ollamaBaseUrl({ OLLAMA_HOST: 'http://box.local:11434' }), 'http://box.local:11434');
  });

  it('lists the models in Ollama’s folder by their tags', () => {
    const dir = path.join(tmp, 'models');
    for (const at of ['library/llama3.1/8b', 'library/llama3.2/1b', 'someone/tuned/latest']) {
      const file = path.join(dir, 'manifests', 'registry.ollama.ai', at);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{}');
    }
    assert.deepEqual(ollamaModelsOnDisk(dir), ['llama3.1:8b', 'llama3.2:1b', 'someone/tuned:latest']);
    assert.deepEqual(ollamaModelsOnDisk(path.join(tmp, 'none')), []);
  });

  it('reads whether an Ollama model takes tools off its capabilities', async () => {
    const show = (body: unknown, status = 200) =>
      (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
    assert.equal(await ollamaTakesTools('http://x', 'm', show({ capabilities: ['completion', 'tools'] })), true);
    assert.equal(await ollamaTakesTools('http://x', 'm', show({ capabilities: ['completion'] })), false);
    // An Ollama too old to say, or one that fails.
    assert.equal(await ollamaTakesTools('http://x', 'm', show({})), false);
    assert.equal(await ollamaTakesTools('http://x', 'm', show({}, 404)), false);
  });

  it('stops offering tools after a few rounds, so the model must answer', async () => {
    const bodies: { tools?: unknown }[] = [];
    const looping = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { tools?: unknown };
      bodies.push(body);
      const message = body.tools
        ? { content: '', tool_calls: [{ function: { name: 'again', arguments: '{"n":1}' } }] }
        : { content: 'done' };
      return new Response(`${JSON.stringify({ message })}\n`, { status: 200 });
    }) as typeof fetch;
    const args: unknown[] = [];
    const answer = await ollamaChat('http://x', 'm', [], () => {}, looping, {
      defs: [
        {
          name: 'list_my_files',
          description: 'd',
          input_schema: { type: 'object', properties: {} }
        }
      ],
      call: async (_name, a) => {
        args.push(a);
        return 'ok';
      }
    });
    assert.equal(answer, 'done');
    assert.equal(bodies.length, 5);
    assert.equal(bodies.at(-1)?.tools, undefined);
    // A JSON-string `arguments` is read as the object it holds.
    assert.deepEqual(args[0], { n: 1 });
  });

  it('fails a streamed error from Ollama', async () => {
    const fake = (async () =>
      new Response(`${JSON.stringify({ error: 'model not found' })}\n`, { status: 200 })) as typeof fetch;
    await assert.rejects(ollamaChat('http://x', 'm', [], () => {}, fake), /model not found/);
  });
});
