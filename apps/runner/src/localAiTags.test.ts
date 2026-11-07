import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { RunnerLocalAiModels } from '@shared/all/domains/electron';
import type { LocalAiMachine } from '@shared/all/helpers/localAiModels';

import type { LocalAiModelIo } from './localAiModel';
import { LocalAiTags } from './localAiTags';
import type { ParsedOllamaTag } from './ollamaLibrary';
import type { OllamaLibrary } from './ollamaLibraryFetch';
import type { PartService } from './partsManager';

// Oakbox > Account > Backend's models against a fake Ollama: a set of tags
// in memory that `pull` adds to and `rm` takes from, and a fake ollama.com
// with a few of qwen3's tags. Nothing here starts Ollama, pulls a model or
// reaches the network.

const tag = (name: string, sizeGb: number | null, extra: Partial<ParsedOllamaTag> = {}): ParsedOllamaTag => ({
  tag: name,
  aliases: [],
  sizeGb,
  context: '40K',
  input: 'Text',
  cloud: sizeGb === null,
  ...extra
});

// In ollama.com's order, which is not the order search answers in.
const QWEN3 = [
  tag('qwen3:8b', 5.2, { aliases: ['qwen3:latest'] }),
  tag('qwen3:0.6b', 0.523),
  tag('qwen3:235b', 142),
  tag('qwen3:cloud', null)
];

const library: OllamaLibrary = {
  search: async (query) => [
    { name: 'qwen3', description: query, capabilities: ['tools'], sizes: ['8b'], cloud: false, downloads: 1 }
  ],
  tags: async (name) => {
    if (name !== 'qwen3') throw new Error(`ollama.com has no model named ${name}.`);
    return QWEN3;
  },
  lookup: async (t) =>
    QWEN3.find((x) => [x.tag, ...x.aliases].includes(t.includes(':') ? t : `${t}:latest`)) ?? null
};

const machine = (memoryGb: number, freeDiskGb = 200): LocalAiMachine => ({
  memoryGb,
  unifiedMemory: false,
  cpu: 'Intel Core i7',
  gpu: null,
  freeDiskGb
});

function fake(
  opts: {
    memoryGb?: number;
    freeDiskGb?: number;
    held?: string[];
    bin?: string | null;
    failPull?: boolean;
    runnerDir?: string;
  } = {}
) {
  const held = new Set(opts.held ?? []);
  const calls: string[][] = [];
  const server = { running: true };
  const service: PartService = {
    status: async () => ({ running: server.running, ours: false, memoryMb: null }),
    start: async () => {
      calls.push(['serve']);
      server.running = true;
    },
    stop: async () => {
      server.running = false;
    }
  };
  // Lets a test hold a pull open and finish it when it chooses.
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model: LocalAiModelIo = {
    runnerDir: opts.runnerDir ?? '/nonexistent-runner-dir',
    machine: async () => machine(opts.memoryGb ?? 8, opts.freeDiskGb ?? 200),
    modelsDir: '/nonexistent-models-dir',
    resolveBin: async () => (opts.bin === undefined ? '/usr/local/bin/ollama' : opts.bin),
    stream: async (bin, args, onLine) => {
      calls.push([bin, ...args]);
      const [verb, tag] = args;
      if (verb === 'pull') {
        onLine('pulling manifest');
        await gate;
        if (opts.failPull) return 1;
        held.add(tag!.includes(':') ? tag! : `${tag}:latest`);
      } else if (verb === 'rm') {
        held.delete(tag!);
      }
      return 0;
    },
    service
  };
  const tags = new LocalAiTags(
    {
      model,
      installed: () => [...held].sort(),
      health: async () => ({ level: 'ok', disks: [], memory: 'ok', warnGb: 20, criticalGb: 5 }),
      freeDiskGb: () => opts.freeDiskGb ?? 200,
      library
    },
    () => 1000
  );
  return { tags, calls, held, release, server };
}

/** Read the list until the job is no longer running. */
async function settled(tags: LocalAiTags): Promise<RunnerLocalAiModels> {
  for (let i = 0; i < 50; i++) {
    const list = await tags.list();
    if (list.job?.state !== 'running') return list;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('the job never finished');
}

describe('the list', () => {
  it('has what Ollama holds, the table with its fit, and health', async () => {
    const { tags } = fake({ held: ['llama3.2:3b', 'phi3:mini'] });
    const list = await tags.list();
    assert.equal(list.ollama, true);
    assert.deepEqual(list.installed, ['llama3.2:3b', 'phi3:mini']);
    assert.equal(list.recommended, 'llama3.2:3b');
    assert.equal(list.models.length, 6);
    assert.equal(list.models.find((m) => m.id === 'llama3.1:8b')?.fits, false);
    assert.equal(list.health?.level, 'ok');
    assert.equal(list.job, null);
  });

  it('says when Ollama is missing', async () => {
    const { tags } = fake({ bin: null });
    assert.equal((await tags.list()).ollama, false);
    await assert.rejects(tags.act({ action: 'pull', tag: 'llama3.2:1b' }), /Ollama is not installed/);
  });
});

describe('pull', () => {
  it('pulls any Ollama model by name, with no shell, and reports it', async () => {
    const { tags, calls, release, held } = fake({ held: ['llama3.2:3b'] });
    const started = await tags.act({ action: 'pull', tag: 'mistral:7b' });
    assert.equal(started.job?.state, 'running');
    assert.equal(started.job?.tag, 'mistral:7b');
    release();
    const done = await settled(tags);
    assert.equal(done.job?.state, 'done');
    assert.deepEqual(calls, [['/usr/local/bin/ollama', 'pull', 'mistral:7b']]);
    assert.ok(done.job?.lines.includes('pulling manifest'));
    assert.equal(done.job?.lines.at(-1), 'mistral:7b is ready.');
    // Nothing else is removed: the model the runner had stays.
    assert.ok(held.has('llama3.2:3b'));
  });

  it('starts Ollama first when it is down', async () => {
    const { tags, calls, release, server } = fake();
    server.running = false;
    await tags.act({ action: 'pull', tag: 'llama3.2:1b' });
    release();
    await settled(tags);
    assert.deepEqual(calls[0], ['serve']);
  });

  it('refuses a name that is not an Ollama model before anything runs', async () => {
    const { tags, calls } = fake();
    for (const tag of ['--help', 'a;rm -rf /', '../x', '']) {
      await assert.rejects(tags.act({ action: 'pull', tag }));
    }
    await assert.rejects(tags.act({ action: 'upgrade', tag: 'llama3.2:1b' }));
    assert.deepEqual(calls, []);
  });

  it('refuses a table model that does not fit, saying why', async () => {
    const { tags, calls } = fake({ memoryGb: 8 });
    await assert.rejects(
      tags.act({ action: 'pull', tag: 'llama3.1:8b' }),
      /Llama 3.1 8B does not fit this machine\. Needs 16 GB memory/
    );
    assert.deepEqual(calls, []);
  });

  it('refuses any pull when the disk is almost full', async () => {
    const { tags } = fake({ freeDiskGb: 3 });
    await assert.rejects(tags.act({ action: 'pull', tag: 'phi3:mini' }), /Free up space/);
  });

  it('refuses one already there, and a second while one runs', async () => {
    const { tags, release } = fake({ held: ['llama3.2:3b'] });
    await assert.rejects(tags.act({ action: 'pull', tag: 'llama3.2:3b' }), /already on this runner/);
    await tags.act({ action: 'pull', tag: 'llama3.2:1b' });
    await assert.rejects(tags.act({ action: 'pull', tag: 'phi3:mini' }), /still going/);
    release();
    await settled(tags);
  });

  it('two requests at once: one job runs, the other is refused', async () => {
    const { tags, release } = fake({});
    // Both pass the first check before either job is set.
    const both = await Promise.allSettled([
      tags.act({ action: 'pull', tag: 'llama3.2:1b' }),
      tags.act({ action: 'pull', tag: 'phi3:mini' })
    ]);
    assert.deepEqual(both.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    const refused = both.find((r) => r.status === 'rejected');
    assert.match(String(refused?.status === 'rejected' && refused.reason), /still going/);
    release();
    await settled(tags);
  });

  it('fails the job when the pull fails', async () => {
    const { tags, release } = fake({ failPull: true });
    await tags.act({ action: 'pull', tag: 'llama3.2:1b' });
    release();
    const done = await settled(tags);
    assert.equal(done.job?.state, 'failed');
    assert.equal(done.job?.lines.at(-1), 'Llama 3.2 1B did not finish pulling.');
  });
});

describe('remove', () => {
  it('removes a model the runner holds', async () => {
    const { tags, calls, held } = fake({ held: ['llama3.2:3b', 'phi3:mini'] });
    await tags.act({ action: 'remove', tag: 'phi3:mini' });
    const done = await settled(tags);
    assert.equal(done.job?.state, 'done');
    assert.deepEqual(calls, [['/usr/local/bin/ollama', 'rm', 'phi3:mini']]);
    assert.deepEqual([...held], ['llama3.2:3b']);
  });

  it('takes it off the Local AI module\'s pulled list too', async () => {
    const runnerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-local-ai-tags-'));
    const file = path.join(runnerDir, 'parts', 'local-ai-model.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ picked: 'llama3.2:3b', pulled: ['llama3.2:3b'] }));
    const { tags } = fake({ held: ['llama3.2:3b'], runnerDir });
    await tags.act({ action: 'remove', tag: 'llama3.2:3b' });
    assert.equal((await settled(tags)).job?.state, 'done');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), {
      picked: 'llama3.2:3b',
      pulled: []
    });
  });

  it('refuses one that is not there', async () => {
    const { tags, calls } = fake({ held: ['llama3.2:3b'] });
    await assert.rejects(tags.act({ action: 'remove', tag: 'phi3:mini' }), /not on this runner/);
    assert.deepEqual(calls, []);
  });
});

describe('search', () => {
  it('passes a query to ollama.com', async () => {
    const { tags } = fake();
    const found = await tags.search({ query: '  qwen ' });
    assert.equal(found.kind, 'models');
    assert.deepEqual(found.kind === 'models' && found.models.map((m) => [m.name, m.description]), [['qwen3', 'qwen']]);
  });

  it('says for each tag whether it fits, and why not, the ones that fit first', async () => {
    const { tags } = fake({ memoryGb: 8, freeDiskGb: 100 });
    const found = await tags.search({ name: 'qwen3' });
    assert.equal(found.kind, 'tags');
    const rows = found.kind === 'tags' ? found.tags : [];
    assert.deepEqual(
      rows.map((r) => [r.tag, r.fits, r.blocker]),
      [
        ['qwen3:0.6b', true, null],
        ['qwen3:8b', false, 'Needs about 6.3 GB of memory; this machine can give a model 5.3 GB.'],
        ['qwen3:235b', false, 'Needs about 170.4 GB of memory; this machine can give a model 5.3 GB.'],
        ['qwen3:cloud', false, 'Runs on Ollama’s cloud, not on this machine.']
      ]
    );
  });

  it('goes by the disk too', async () => {
    const { tags } = fake({ memoryGb: 64, freeDiskGb: 9 });
    const found = await tags.search({ name: 'qwen3' });
    const rows = found.kind === 'tags' ? found.tags : [];
    // The row shows the name and size, so these lines do not repeat them.
    assert.equal(rows[0]?.blocker, null);
    assert.equal(rows[1]?.blocker, 'It would leave under 5 GB of disk. Free up space on the runner first.');
  });

  it('refuses a name with a path in it, and anything else', async () => {
    const { tags } = fake();
    for (const payload of [{ name: '../x' }, { name: 'a/b/c' }, { name: 'qwen3:8b' }, { query: 'x', name: 'y' }, {}]) {
      await assert.rejects(tags.search(payload));
    }
  });

  it('says plainly when a model is not on ollama.com', async () => {
    const { tags } = fake();
    await assert.rejects(tags.search({ name: 'nothing' }), /ollama.com has no model named nothing/);
  });
});

describe('pull of a searched tag', () => {
  it('goes by its size on ollama.com', async () => {
    const { tags, calls, release } = fake({ memoryGb: 8 });
    await assert.rejects(
      tags.act({ action: 'pull', tag: 'qwen3:latest' }),
      /qwen3:latest does not fit this machine\. Needs about 6\.3 GB of memory/
    );
    await assert.rejects(tags.act({ action: 'pull', tag: 'qwen3:cloud' }), /Ollama’s cloud/);
    assert.deepEqual(calls, []);
    await tags.act({ action: 'pull', tag: 'qwen3:0.6b' });
    release();
    assert.equal((await settled(tags)).job?.state, 'done');
  });

  it('checks the disk by that size', async () => {
    const { tags } = fake({ memoryGb: 512, freeDiskGb: 100 });
    await assert.rejects(tags.act({ action: 'pull', tag: 'qwen3:235b' }), /Free up space/);
  });
});
