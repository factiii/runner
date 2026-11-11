import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  fitModels,
  type LocalAiMachine,
  modelReason,
  recommendModel
} from '@shared/all/helpers/localAiModels';

import {
  forgetPulledModel,
  type LocalAiModelIo,
  localAiState,
  modelCheck,
  modelPresent,
  ollamaModelsDir,
  pickModel,
  pullModel,
  removeModels,
  removeUnusedModel,
  unusedModels
} from './localAiModel';
import type { PartService } from './partsManager';

// The Local AI model: the fixed table against made-up machines, and the pick,
// pull and remove against a fake Ollama in a temp folder. Nothing here reads
// the real machine, starts Ollama or pulls a model.

const mac = (memoryGb: number, freeDiskGb = 200): LocalAiMachine => ({
  memoryGb,
  unifiedMemory: true,
  cpu: 'Apple M3 Pro',
  gpu: null,
  freeDiskGb
});

const pc = (memoryGb: number, gpu: LocalAiMachine['gpu'] = null): LocalAiMachine => ({
  memoryGb,
  unifiedMemory: false,
  cpu: 'Intel Core i7',
  gpu,
  freeDiskGb: 200
});

describe('the model table', () => {
  it('picks the largest model each machine size fits', () => {
    const pick = (m: LocalAiMachine) => recommendModel(m)?.id ?? null;
    assert.equal(pick(mac(4)), 'llama3.2:1b');
    assert.equal(pick(mac(8)), 'llama3.2:3b');
    assert.equal(pick(mac(16)), 'llama3.1:8b');
    assert.equal(pick(mac(18)), 'llama3.1:8b');
    assert.equal(pick(mac(36)), 'qwen2.5:14b');
    assert.equal(pick(mac(64)), 'qwen2.5:32b');
    assert.equal(pick(mac(128)), 'llama3.3:70b');
  });

  it('says why, in the machine’s own terms', () => {
    assert.equal(
      modelReason(mac(16)),
      '16 GB unified memory (Apple M3 Pro), so an 8B model at 4-bit, about 4.9 GB.'
    );
    assert.equal(
      modelReason(pc(16)),
      '16 GB memory, no GPU it can use, so an 8B model at 4-bit, about 4.9 GB. It runs on the CPU, so answers are slower.'
    );
  });

  it('counts a discrete GPU’s own memory', () => {
    const machine = pc(16, { name: 'NVIDIA GeForce RTX 4090', memoryGb: 24 });
    assert.equal(recommendModel(machine)?.id, 'qwen2.5:14b');
    assert.match(modelReason(machine), /and NVIDIA GeForce RTX 4090 with 24 GB, so a 14B model/);
  });

  it('steps down when the disk, not the memory, is short', () => {
    const machine = mac(16, 8);
    assert.equal(recommendModel(machine)?.id, 'llama3.2:3b');
    assert.match(modelReason(machine), /fits an 8B model .* but only 8 GB is free on disk, so a 3B model/);
  });

  it('says a machine too small for any model is, and points to Claude and Codex', () => {
    for (const machine of [mac(2), mac(64, 3)]) {
      assert.equal(recommendModel(machine), null);
      assert.match(modelReason(machine), /too small for a local model\. Use Claude or Codex/);
    }
  });

  it('marks every row that does not fit, with why', () => {
    const rows = fitModels(mac(16));
    assert.deepEqual(
      rows.map((r) => r.fits),
      [true, true, true, false, false, false]
    );
    assert.equal(rows[3].blocker, 'Needs 24 GB memory; this machine has 16 GB.');
  });
});

/** A fake Ollama: `pull` writes the manifest, `rm` deletes it. */
function fakeOllama(machine: LocalAiMachine, opts: { bin?: string | null; failPull?: boolean } = {}) {
  const runnerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-local-ai-'));
  const modelsDir = path.join(runnerDir, 'ollama-models');
  const calls: string[] = [];
  const server = { running: false };
  const manifest = (id: string) => {
    const [name, tag] = id.split(':');
    return path.join(modelsDir, 'manifests', 'registry.ollama.ai', 'library', name, tag);
  };
  const service: PartService = {
    status: async () => ({ running: server.running, ours: server.running, memoryMb: null }),
    start: async () => {
      calls.push('serve');
      server.running = true;
    },
    stop: async () => {
      server.running = false;
    }
  };
  const io: LocalAiModelIo = {
    runnerDir,
    machine: async () => machine,
    modelsDir,
    resolveBin: async () => (opts.bin === undefined ? '/opt/homebrew/bin/ollama' : opts.bin),
    stream: async (_bin, [verb, id], onLine) => {
      calls.push(`${verb} ${id}`);
      if (verb === 'pull') {
        if (opts.failPull) return 1;
        onLine('pulling manifest');
        fs.mkdirSync(path.dirname(manifest(id)), { recursive: true });
        fs.writeFileSync(manifest(id), '{}');
      } else if (verb === 'rm') {
        fs.rmSync(manifest(id), { force: true });
      }
      return 0;
    },
    service
  };
  return { io, calls, manifest, server };
}

describe('pick, pull and remove', () => {
  it('pulls the recommended model, starting Ollama for it', async () => {
    const { io, calls } = fakeOllama(mac(16));
    assert.equal((await modelCheck(io)).state, 'missing');
    const lines: string[] = [];
    await pullModel(io, (l) => lines.push(l));
    assert.deepEqual(calls, ['serve', 'pull llama3.1:8b']);
    assert.equal(lines[0], '16 GB unified memory (Apple M3 Pro), so an 8B model at 4-bit, about 4.9 GB.');
    const state = await localAiState(io);
    assert.equal(state.picked, 'llama3.1:8b');
    assert.equal(state.pulled, true);
    assert.deepEqual(await modelCheck(io), { state: 'ready', detail: 'Llama 3.1 8B in Ollama' });
  });

  it('lets the owner pick a smaller model, and removes the one it pulled before', async () => {
    const { io, calls } = fakeOllama(mac(16));
    await pullModel(io, () => {});
    await pickModel(io, 'llama3.2:3b');
    assert.equal((await localAiState(io)).pulled, false);
    await pullModel(io, () => {});
    assert.deepEqual(calls.slice(-2), ['pull llama3.2:3b', 'rm llama3.1:8b']);
    assert.equal(modelPresent(io.modelsDir, 'llama3.1:8b'), false);
    assert.equal(modelPresent(io.modelsDir, 'llama3.2:3b'), true);
  });

  it('refuses a model that does not fit', async () => {
    const { io } = fakeOllama(mac(16));
    await assert.rejects(pickModel(io, 'qwen2.5:32b'), /does not fit this machine\. Needs 48 GB memory/);
    assert.equal((await localAiState(io)).picked, 'llama3.1:8b');
  });

  it('leaves a too-small machine to Claude and Codex, and pulls nothing', async () => {
    const { io, calls } = fakeOllama(mac(2));
    const check = await modelCheck(io);
    assert.equal(check.state, 'too-small');
    await assert.rejects(pullModel(io, () => {}), /Use Claude or Codex/);
    assert.deepEqual(calls, []);
  });

  it('fails a pull that did not finish, and one with no Ollama', async () => {
    await assert.rejects(pullModel(fakeOllama(mac(16), { failPull: true }).io, () => {}), /did not finish/);
    await assert.rejects(pullModel(fakeOllama(mac(16), { bin: null }).io, () => {}), /Add the Local AI part in the runner's Software tab/);
  });

  it('removes only the models it pulled', async () => {
    const { io, calls, manifest } = fakeOllama(mac(16));
    // The owner's own model, pulled outside the runner.
    fs.mkdirSync(path.dirname(manifest('llama3.2:1b')), { recursive: true });
    fs.writeFileSync(manifest('llama3.2:1b'), '{}');
    await pullModel(io, () => {});
    await removeModels(io, () => {});
    assert.deepEqual(calls.slice(-1), ['rm llama3.1:8b']);
    assert.equal(modelPresent(io.modelsDir, 'llama3.2:1b'), true);
  });

  it('refuses a pull once the disk filled up since the pick, before pulling', async () => {
    const machine = mac(16);
    const { io, calls } = fakeOllama(machine);
    await pickModel(io, 'llama3.1:8b');
    machine.freeDiskGb = 7;
    await assert.rejects(pullModel(io, () => {}), /does not fit now\. Needs 9\.9 GB free disk; 7 GB is free/);
    assert.deepEqual(calls, []);
  });

  it('warns when a pull leaves the disk low', async () => {
    const { io } = fakeOllama(mac(16, 15));
    const lines: string[] = [];
    await pullModel(io, (l) => lines.push(l));
    assert.equal(lines[0], 'Disk space will be low after Llama 3.1 8B: 15 GB is free.');
  });

  it('offers to remove only a model it pulled and no longer picks', async () => {
    const { io, calls, manifest } = fakeOllama(mac(16));
    for (const id of ['llama3.2:1b', 'llama3.2:3b', 'llama3.1:8b']) {
      fs.mkdirSync(path.dirname(manifest(id)), { recursive: true });
      fs.writeFileSync(manifest(id), '{}');
    }
    // An `ollama rm` of 8B failed after 3B was pulled; 1B is the owner's own.
    fs.mkdirSync(path.join(io.runnerDir, 'parts'), { recursive: true });
    fs.writeFileSync(
      path.join(io.runnerDir, 'parts', 'local-ai-model.json'),
      JSON.stringify({ picked: 'llama3.2:3b', pulled: ['llama3.2:3b', 'llama3.1:8b'] })
    );
    assert.deepEqual(unusedModels(io).map((m) => m.id), ['llama3.1:8b']);
    assert.equal(await removeUnusedModel(io, 'llama3.2:3b', () => {}), false);
    assert.equal(await removeUnusedModel(io, 'llama3.2:1b', () => {}), false);
    assert.equal(await removeUnusedModel(io, 'llama3.1:8b', () => {}), true);
    assert.deepEqual(calls, ['serve', 'rm llama3.1:8b']);
    assert.deepEqual(unusedModels(io), []);
    assert.equal(modelPresent(io.modelsDir, 'llama3.2:3b'), true);
  });
});

describe('a model removed elsewhere', () => {
  it('leaves the pulled list, so Setup\'s remove does not fail on it', async () => {
    const { io, calls, manifest } = fakeOllama(mac(16));
    await pullModel(io, () => {});
    // Oakbox > Account > Backend's remove: `ollama rm` outside this module.
    fs.rmSync(manifest('llama3.1:8b'));
    forgetPulledModel(io.runnerDir, 'llama3.1:8b');
    forgetPulledModel(io.runnerDir, 'phi3:mini');
    await removeModels(io, () => {});
    assert.deepEqual(calls, ['serve', 'pull llama3.1:8b']);
    // The pick stays the owner's.
    assert.equal((await localAiState(io)).picked, 'llama3.1:8b');
  });
});

describe('Ollama\'s models folder', () => {
  const own = path.join(os.homedir(), '.ollama', 'models');
  const service = '/usr/share/ollama/.ollama/models';

  it('is the Linux service\'s folder when only it exists', () => {
    assert.equal(ollamaModelsDir('linux', (dir) => dir === service), service);
  });

  it('is the user\'s own folder when it exists, or off Linux', () => {
    assert.equal(ollamaModelsDir('linux', () => true), own);
    assert.equal(ollamaModelsDir('darwin', (dir) => dir === service), own);
  });
});
