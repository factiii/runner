import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RunnerPartId } from '@shared/all/domains/electron';
import { moduleError } from '@shared/all/helpers/runnerPartsCopy';

import { buildChecks, type DoctorHost, type DoctorResult } from './doctor';
import {
  findPart,
  KEEP_TOOLS,
  MODULES,
  modulesFor,
  PARTS,
  partActions,
  partsFor,
  removableTools,
  resolveRequirements,
  type ServiceState
} from './parts';
import { type PartService, type PartsMachine, PartsManager } from './partsManager';

// The parts registry and its requirement resolution, against made-up doctor
// results and a fake machine. Nothing here probes or installs anything.

const met = (id: string, title = id): DoctorResult => ({
  id,
  title,
  feature: 'test',
  required: false,
  state: 'met',
  detail: `/opt/homebrew/bin/${id}`
});

const missing = (id: string, title = id): DoctorResult => ({
  ...met(id, title),
  state: 'unmet',
  detail: 'Not found on the login PATH.',
  fix: { kind: 'install', tool: id, command: `brew install ${id}` }
});

const ALL_IDS = [...new Set(PARTS.flatMap((p) => p.requires))];
const allMet = () => ALL_IDS.map((id) => met(id));
/** Every requirement met but `gone`, which brew can install. */
const without = (...gone: string[]) =>
  ALL_IDS.map((id) => (gone.includes(id) ? missing(id) : met(id)));

describe('the parts registry', () => {
  it('names every requirement after a doctor check', () => {
    const host: DoctorHost = {
      platform: 'darwin',
      nodeVersion: '24.11.1',
      runnerDir: '/tmp/r',
      user: 'jo',
      tools: async () => [],
      vaultEngine: () => false,
      vaultEmbedder: () => 'missing',
      localAiModel: async () => ({ state: 'missing', model: 'llama3.1:8b', detail: '' }),
      health: async () => ({
        level: 'ok',
        disks: [{ uses: ['Runner folder'], freeGb: 200, totalGb: 500, level: 'ok' }],
        memory: 'ok',
        warnGb: 20,
        criticalGb: 5
      }),
      dirWritable: () => true,
      fileExists: () => false,
      loginPath: async () => null,
      keychain: () => ({ ready: true, keyStore: 'k', problem: '', fix: '' }),
      paired: () => true,
      run: async () => ({ code: 1, output: '' }),
      service: async () => null
    };
    const ids = new Set(buildChecks(host).checks.map((c) => c.id));
    for (const id of ALL_IDS) assert.ok(ids.has(id), `${id} has no check`);
  });

  it('marks only the connector as core, and the connector needs no tool', () => {
    assert.deepEqual(
      PARTS.filter((p) => p.core).map((p) => p.id),
      ['connector']
    );
    assert.deepEqual(findPart('connector').requires, [
      'node-version',
      'folder',
      'keychain',
      'pairing'
    ]);
  });

  it('offers the simulator on macOS only, and only the connector on Windows', () => {
    const ids = (platform: NodeJS.Platform) => partsFor(platform).map((p) => p.id);
    assert.ok(ids('darwin').includes('simulator'));
    assert.ok(!ids('linux').includes('simulator'));
    assert.deepEqual(ids('win32'), ['connector']);
  });
});

describe('requirement resolution', () => {
  it('reads a part as installed when every requirement is met', () => {
    const res = resolveRequirements(findPart('terminals'), allMet());
    assert.equal(res.installed, true);
    assert.deepEqual(res.fixes, []);
  });

  it('never counts an unknown check against a part', () => {
    const results = allMet().map((r) =>
      r.id === 'xcode' ? { ...r, state: 'unknown' as const } : r
    );
    assert.equal(resolveRequirements(findPart('simulator'), results).installed, true);
  });

  it('takes only the missing requirements of that part, and only runner fixes', () => {
    const res = resolveRequirements(findPart('terminals'), without('tmux', 'claude'));
    assert.equal(res.installed, false);
    assert.deepEqual(res.missing.map((r) => r.id), ['tmux']);
    assert.deepEqual(res.fixes.map((r) => r.id), ['tmux']);
    assert.deepEqual(res.manual, []);
  });

  it('leaves root and settings fixes to a person, with the command', () => {
    const results = allMet().map((r) => {
      if (r.id === 'xcode') {
        return {
          ...r,
          title: 'Xcode',
          state: 'unmet' as const,
          fix: {
            kind: 'command' as const,
            note: ['Install Xcode, then:'],
            commands: ['sudo xcode-select -s /Applications/Xcode.app']
          }
        };
      }
      return r;
    });
    const res = resolveRequirements(findPart('simulator'), results);
    assert.deepEqual(res.fixes, []);
    assert.deepEqual(res.manual, [
      'Xcode: Install Xcode, then: sudo xcode-select -s /Applications/Xcode.app'
    ]);
  });

  it('reads a requirement with no check on this machine as missing', () => {
    const results = allMet().filter((r) => r.id !== 'ollama');
    const res = resolveRequirements(findPart('local-ai'), results);
    assert.equal(res.installed, false);
    assert.match(res.manual[0] ?? '', /not available/);
  });
});

describe('what remove may touch', () => {
  it('removes only tools the runner installed', () => {
    assert.deepEqual(removableTools(findPart('terminals'), [], []), []);
    assert.deepEqual(
      removableTools(findPart('terminals'), ['tmux', 'sops'], []),
      ['tmux']
    );
  });

  it('never removes node, git or script', () => {
    const ledger = ['node', 'git', 'script', 'claude'];
    for (const bin of KEEP_TOOLS) assert.ok(ledger.includes(bin));
    assert.deepEqual(removableTools(findPart('claude'), ledger, []), ['claude']);
    assert.deepEqual(removableTools(findPart('terminals'), ledger, []), []);
  });

  it('keeps a tool another installed part still needs', () => {
    const ollamaTwice = { ...findPart('local-ai'), id: 'vault-search' as const };
    assert.deepEqual(
      removableTools(findPart('local-ai'), ['ollama'], [ollamaTwice]),
      []
    );
  });
});

describe('the buttons a part offers', () => {
  const service = (running: boolean, ours: boolean): ServiceState => ({
    running,
    ours,
    memoryMb: null
  });

  it('offers nothing for the connector', () => {
    const res = resolveRequirements(findPart('connector'), []);
    assert.deepEqual(partActions(findPart('connector'), res, [], null), []);
  });

  it('offers Add only when the runner can install something', () => {
    const part = findPart('terminals');
    assert.deepEqual(
      partActions(part, resolveRequirements(part, without('tmux')), [], null),
      ['add']
    );
    const manualOnly = resolveRequirements(
      part,
      allMet().map((r) =>
        r.id === 'tmux'
          ? { ...r, state: 'unmet' as const, fix: undefined }
          : r
      )
    );
    assert.deepEqual(partActions(part, manualOnly, [], null), []);
  });

  it('starts a stopped service and stops only its own', () => {
    const part = findPart('local-ai');
    const res = resolveRequirements(part, allMet());
    assert.deepEqual(partActions(part, res, [], service(false, false)), ['start']);
    assert.deepEqual(partActions(part, res, [], service(true, true)), ['stop']);
    assert.deepEqual(partActions(part, res, [], service(true, false)), []);
    assert.deepEqual(partActions(part, res, ['ollama'], service(true, true)), [
      'stop',
      'remove'
    ]);
  });
});

/** A machine that records what it is asked, with `gone` missing at first.
 *  Installing a `broken` tool fails. */
function fakeMachine(gone: string[], ledger: string[] = [], broken: string[] = []) {
  const state = { gone: new Set(gone), ledger: [...ledger] };
  const calls: string[] = [];
  const svc = { running: false };
  const service: PartService = {
    status: async () => ({ running: svc.running, ours: svc.running, memoryMb: 210 }),
    start: async (onLine) => {
      svc.running = true;
      onLine('Ollama is running.');
    },
    stop: async () => {
      svc.running = false;
      calls.push('stop');
    }
  };
  const machine: PartsMachine = {
    platform: 'darwin',
    results: async () => without(...state.gone),
    fix: async (result, onLine) => {
      calls.push(`install ${result.id}`);
      if (broken.includes(result.id)) throw new Error(`${result.id} did not build.`);
      onLine(`Installed ${result.id}.`);
      state.gone.delete(result.id);
    },
    uninstall: async (bin) => {
      calls.push(`uninstall ${bin}`);
      state.gone.add(bin);
    },
    readLedger: () => [...state.ledger],
    writeLedger: (tools) => {
      state.ledger = [...tools];
    },
    service: (id: RunnerPartId) => (id === 'local-ai' ? service : null)
  };
  return { machine, calls, state, svc };
}

describe('PartsManager', () => {
  it('shows an existing install as installed, and offers nothing to remove', async () => {
    const { machine } = fakeMachine([]);
    const list = await new PartsManager(machine).list();
    assert.ok(list.parts.every((p) => p.installed));
    assert.ok(list.parts.every((p) => !p.actions.includes('remove')));
    assert.ok(list.parts.every((p) => !p.actions.includes('add')));
  });

  it('installs only the picked part’s tools, and records them', async () => {
    const { machine, calls, state } = fakeMachine(['tmux', 'redis-server', 'claude']);
    const manager = new PartsManager(machine);
    const lines: string[] = [];
    assert.equal(await manager.run('terminals', 'add', (l) => lines.push(l)), true);
    // Redis is an extra now, not one of the part's tools.
    assert.deepEqual(calls, ['install tmux']);
    assert.deepEqual(state.ledger, ['tmux']);
    assert.equal(lines.at(-1), 'Terminals and boards is installed.');
    const claude = (await manager.list()).parts.find((p) => p.id === 'claude');
    assert.equal(claude?.installed, false);
  });

  it('runs an app action in the background and reports its job', async () => {
    const { machine } = fakeMachine(['claude']);
    const manager = new PartsManager(machine);
    const first = await manager.act({ partId: 'claude', action: 'add' });
    const job = first.parts.find((p) => p.id === 'claude')?.job;
    assert.equal(job?.action, 'add');
    await new Promise((resolve) => setImmediate(resolve));
    const after = (await manager.list()).parts.find((p) => p.id === 'claude');
    assert.equal(after?.job?.state, 'done');
    assert.equal(after?.installed, true);
    assert.deepEqual(after?.actions, ['remove']);
  });

  it('two requests at once for one part: one runs, the other is refused as busy', async () => {
    const { machine, calls } = fakeMachine(['claude']);
    const manager = new PartsManager(machine);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      // Both read the same list (Add offered) before either starts.
      const results = await Promise.allSettled([
        manager.act({ partId: 'claude', action: 'add' }),
        manager.act({ partId: 'claude', action: 'add' })
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
      const refused = results.find((r) => r.status === 'rejected');
      assert.match(String(refused?.status === 'rejected' && refused.reason), /already busy/);
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(unhandled, []);
      assert.equal(calls.filter((c) => c.startsWith('install')).length, 1);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('two requests at once for one module: the second is refused as busy', async () => {
    const { machine } = fakeMachine(['vault-engine']);
    const manager = new PartsManager(machine);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const results = await Promise.allSettled([
        manager.act({ moduleId: 'private-vault', action: 'add' }),
        manager.act({ moduleId: 'private-vault', action: 'add' })
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
      const refused = results.find((r) => r.status === 'rejected');
      assert.match(String(refused?.status === 'rejected' && refused.reason), /already busy/);
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('refuses an unknown part and an action the part does not offer', async () => {
    const manager = new PartsManager(fakeMachine([]).machine);
    await assert.rejects(manager.act({ partId: 'docker', action: 'add' }));
    await assert.rejects(manager.act({ partId: 'connector', action: 'remove' }));
    await assert.rejects(manager.act({ partId: 'claude', action: 'add' }), /cannot add/);
  });

  it('removes only what it installed, and stops its own service first', async () => {
    const { machine, calls, state, svc } = fakeMachine([], ['ollama', 'node']);
    svc.running = true;
    const manager = new PartsManager(machine);
    const lines: string[] = [];
    assert.equal(await manager.run('local-ai', 'remove', (l) => lines.push(l)), true);
    assert.deepEqual(calls, ['stop', 'uninstall ollama']);
    assert.deepEqual(state.ledger, ['node']);
    // node belongs to claude and codex too, and is never removed anyway.
    assert.equal(await manager.run('claude', 'remove'), true);
    assert.deepEqual(calls, ['stop', 'uninstall ollama']);
  });

  it('starts and stops the Local AI service, and measures it', async () => {
    const { machine } = fakeMachine([]);
    const manager = new PartsManager(machine);
    assert.equal(await manager.run('local-ai', 'start'), true);
    const running = (await manager.list()).parts.find((p) => p.id === 'local-ai');
    assert.equal(running?.running, true);
    assert.equal(running?.memoryNowMb, 210);
    assert.deepEqual(running?.actions, ['stop']);
    assert.equal(await manager.run('local-ai', 'stop'), true);
  });
});

describe('modules', () => {
  const grouped = MODULES.flatMap((m) => m.parts);

  it('puts every part but the flat list’s Vault in exactly one module', () => {
    for (const part of PARTS) {
      const count = grouped.filter((id) => id === part.id).length;
      assert.equal(count, part.covers ? 0 : 1, part.id);
    }
    assert.deepEqual(findPart('vault').covers, ['vault-storage', 'vault-search']);
  });

  it('groups Bare, Coding, Private vault for Oakbox and Local AI, in order', () => {
    assert.deepEqual(
      modulesFor('darwin').map(({ def, parts }) => [def.id, parts.map((p) => p.id)]),
      [
        ['bare', ['connector']],
        ['coding', ['terminals', 'claude', 'codex', 'secrets', 'simulator']],
        ['private-vault', ['vault-storage', 'vault-search']],
        ['local-ai', ['local-ai', 'local-ai-model']]
      ]
    );
    const linux = modulesFor('linux').flatMap(({ parts }) => parts.map((p) => p.id));
    assert.ok(!linux.includes('simulator'));
    assert.ok(linux.includes('vault-search'), 'ONNX on Linux');
    assert.deepEqual(modulesFor('win32').map(({ def }) => def.id), ['bare']);
  });

  it('sends old apps only the part ids they know, and new apps the modules', async () => {
    const list = await new PartsManager(fakeMachine([]).machine).list();
    assert.deepEqual(
      list.parts.map((p) => p.id),
      ['connector', 'terminals', 'claude', 'codex', 'secrets', 'simulator', 'local-ai', 'vault']
    );
    assert.deepEqual(list.modules?.map((m) => m.id), ['bare', 'coding', 'private-vault', 'local-ai']);
    const bare = list.modules?.find((m) => m.id === 'bare');
    assert.equal(bare?.core, true);
    assert.deepEqual(bare?.actions, []);
  });

  it('offers Install all while a sub-part can be added, Remove all while one can go', async () => {
    const { machine } = fakeMachine(['claude'], ['sops']);
    const coding = (await new PartsManager(machine).list()).modules?.find(
      (m) => m.id === 'coding'
    );
    assert.deepEqual(coding?.actions, ['add', 'remove']);
  });
});

describe('module install and remove', () => {
  it('installs the missing sub-parts in order', async () => {
    const { machine, calls } = fakeMachine(['tmux', 'claude', 'codex', 'sops']);
    const manager = new PartsManager(machine);
    assert.equal(await manager.runModule('coding', 'add'), true);
    assert.deepEqual(calls, ['install tmux', 'install claude', 'install codex', 'install sops']);
    const coding = (await manager.list()).modules?.find((m) => m.id === 'coding');
    assert.ok(coding?.parts.every((p) => p.installed));
    assert.deepEqual(coding?.job && { state: coding.job.state, partId: coding.job.partId }, {
      state: 'done',
      partId: null
    });
  });

  it('stops at the first sub-part that fails, and says why', async () => {
    const { machine, calls } = fakeMachine(['tmux', 'claude', 'codex'], [], ['claude']);
    const manager = new PartsManager(machine);
    assert.equal(await manager.runModule('coding', 'add'), false);
    assert.deepEqual(calls, ['install tmux', 'install claude']);
    const coding = (await manager.list()).modules?.find((m) => m.id === 'coding');
    assert.equal(coding?.job?.state, 'failed');
    assert.equal(coding?.job?.partId, 'claude');
    assert.equal(coding && moduleError(coding), 'Stopped at Claude: Still missing: claude.');
    assert.ok(coding?.parts.find((p) => p.id === 'claude')?.job?.lines.includes('claude did not build.'));
  });

  it('removes sub-parts last first', async () => {
    const { machine, calls } = fakeMachine([], ['vault-engine', 'vault-embedder']);
    assert.equal(await new PartsManager(machine).runModule('private-vault', 'remove'), true);
    assert.deepEqual(calls, ['uninstall vault-embedder', 'uninstall vault-engine']);
  });

  it('runs a module from the app in the background, and refuses Bare', async () => {
    const { machine } = fakeMachine(['vault-engine']);
    const manager = new PartsManager(machine);
    const first = await manager.act({ moduleId: 'private-vault', action: 'add' });
    assert.equal(first.modules?.find((m) => m.id === 'private-vault')?.job?.state, 'running');
    await assert.rejects(manager.act({ moduleId: 'bare', action: 'add' }), /cannot add/);
    await assert.rejects(manager.act({ moduleId: 'private-vault', action: 'add' }), /cannot add/);
  });
});

describe('sub-part dependencies', () => {
  it('adds Vault storage before Vault search', async () => {
    const { machine, calls } = fakeMachine(['vault-engine', 'vault-embedder']);
    const manager = new PartsManager(machine);
    const lines: string[] = [];
    assert.equal(await manager.run('vault-search', 'add', (l) => lines.push(l)), true);
    assert.deepEqual(calls, ['install vault-engine', 'install vault-embedder']);
    assert.equal(lines[0], 'Vault search needs Vault storage: adding it first.');
  });

  it('leaves Vault search alone when Vault storage fails', async () => {
    const { machine, calls } = fakeMachine(['vault-engine', 'vault-embedder'], [], ['vault-engine']);
    assert.equal(await new PartsManager(machine).run('vault-search', 'add'), false);
    assert.deepEqual(calls, ['install vault-engine']);
  });

  it('removes Vault search before Vault storage', async () => {
    const { machine, calls } = fakeMachine([], ['vault-engine', 'vault-embedder']);
    assert.equal(await new PartsManager(machine).run('vault-storage', 'remove'), true);
    assert.deepEqual(calls, ['uninstall vault-embedder', 'uninstall vault-engine']);
  });

  it('lets the flat list’s Vault and its sub-parts remove each other’s tools', async () => {
    const { machine, calls } = fakeMachine([], ['vault-engine', 'vault-embedder']);
    assert.equal(await new PartsManager(machine).run('vault', 'remove'), true);
    assert.deepEqual(calls, ['uninstall vault-engine', 'uninstall vault-embedder']);
  });
});

describe('the Local AI model', () => {
  /** fakeMachine plus a model state: `pick` refuses the 32B. */
  function withModel(gone: string[]) {
    const fake = fakeMachine(gone);
    const picks: string[] = [];
    fake.machine.localAi = {
      state: async () => ({
        machine: { memoryGb: 16, unifiedMemory: true, cpu: 'Apple M3', gpu: null, freeDiskGb: 100 },
        recommended: 'llama3.1:8b',
        picked: (picks[picks.length - 1] as 'llama3.2:3b' | undefined) ?? 'llama3.1:8b',
        reason: '16 GB unified memory (Apple M3), so an 8B model at 4-bit, about 4.9 GB.',
        pulled: false,
        models: []
      }),
      pick: async (id) => {
        if (id === 'qwen2.5:32b') throw new Error('Qwen 2.5 32B does not fit this machine.');
        picks.push(id);
      }
    };
    return { ...fake, picks };
  }

  it('sends the pick and its reason, and costs the model row by the pick', async () => {
    const list = await new PartsManager(withModel(['local-ai-model']).machine).list();
    assert.equal(list.localAi?.picked, 'llama3.1:8b');
    const model = list.modules?.find((m) => m.id === 'local-ai')?.parts.find((p) => p.id === 'local-ai-model');
    assert.equal(model?.diskMb, 4_900);
    assert.ok(!list.parts.some((p) => p.id === 'local-ai-model'));
  });

  it('adds Ollama before the model, and picks another model first when asked', async () => {
    const { machine, calls } = withModel(['ollama', 'local-ai-model']);
    assert.equal(await new PartsManager(machine).run('local-ai-model', 'add'), true);
    assert.deepEqual(calls, ['install ollama', 'install local-ai-model']);
    // The CLI's `--model`: picked before the add.
    const other = withModel(['local-ai-model']);
    const manager = new PartsManager(other.machine);
    await manager.pickModel({ moduleId: 'local-ai', action: 'add' }, 'llama3.2:3b');
    assert.deepEqual(other.picks, ['llama3.2:3b']);
    assert.equal((await manager.list()).localAi?.picked, 'llama3.2:3b');
  });

  it('refuses a pick that does not fit, or on any other action', async () => {
    const manager = new PartsManager(withModel(['local-ai-model']).machine);
    await assert.rejects(
      manager.pickModel({ partId: 'local-ai-model', action: 'add' }, 'qwen2.5:32b'),
      /does not fit/
    );
    await assert.rejects(
      manager.pickModel({ partId: 'claude', action: 'add' }, 'llama3.2:3b'),
      /only when adding Local AI/
    );
  });
});

describe('machine health and free up space', () => {
  it('refuses an add the disk has no room for, before installing anything', async () => {
    const { machine, calls } = fakeMachine(['claude']);
    machine.room = (diskMb, what) => ({
      refuse: diskMb > 0 ? `${what} needs about 0.3 GB; 4 GB is free. That would leave under 5 GB. Free up space on the runner first.` : null,
      warn: null
    });
    const lines: string[] = [];
    assert.equal(await new PartsManager(machine).run('claude', 'add', (l) => lines.push(l)), false);
    assert.deepEqual(calls, []);
    assert.match(lines.at(-1) ?? '', /^Claude needs about 0\.3 GB; 4 GB is free/);
  });

  it('asks room for Vault search’s build peak, and lists its final size', async () => {
    const { machine } = fakeMachine(['vault-embedder']);
    const asked: number[] = [];
    machine.room = (diskMb) => {
      asked.push(diskMb);
      return { refuse: null, warn: null };
    };
    const search = findPart('vault-search');
    assert.ok((search.buildDiskMb ?? 0) > search.diskMb);
    const manager = new PartsManager(machine);
    assert.equal(await manager.run('vault-search', 'add'), true);
    assert.deepEqual(asked, [search.buildDiskMb]);
    const listed = (await manager.list()).modules
      ?.flatMap((m) => m.parts)
      .find((p) => p.id === 'vault-search');
    assert.equal(listed?.diskMb, search.diskMb);
  });

  it('warns and still adds when the disk only runs low', async () => {
    const { machine, calls } = fakeMachine(['claude']);
    machine.room = () => ({ refuse: null, warn: 'Disk space will be low after it.' });
    const lines: string[] = [];
    assert.equal(await new PartsManager(machine).run('claude', 'add', (l) => lines.push(l)), true);
    assert.deepEqual(calls, ['install claude']);
    assert.equal(lines[0], 'Disk space will be low after it.');
  });

  it('sends health with the list, dry-runs a cleanup, and runs only on confirm', async () => {
    const { machine } = fakeMachine([]);
    const ran: string[][] = [];
    const item = { id: 'builds:b/builds/old', title: 'Old build output', path: 'b/builds/old', bytes: 2_000 };
    machine.health = async () => ({
      level: 'warn',
      disks: [{ uses: ['Runner folder'], freeGb: 12, totalGb: 500, level: 'warn' }],
      memory: 'ok',
      warnGb: 20,
      criticalGb: 5
    });
    machine.cleanup = {
      plan: async () => (ran.length ? [] : [item]),
      run: async (ids, onLine) => {
        ran.push([...ids]);
        onLine('Removed b/builds/old (2 KB).');
        return 2_000;
      }
    };
    const manager = new PartsManager(machine);
    assert.equal((await manager.list()).health?.level, 'warn');
    const dry = await manager.cleanup({});
    assert.deepEqual(dry, { items: [item], bytes: 2_000, ran: false, lines: [] });
    assert.deepEqual(ran, []);
    const done = await manager.cleanup({ confirm: true, ids: [item.id] });
    assert.deepEqual(ran, [[item.id]]);
    assert.deepEqual(done, { items: [], bytes: 0, ran: true, lines: ['Removed b/builds/old (2 KB).'] });
    await assert.rejects(manager.cleanup({ confirm: 'yes' }));
  });
});

describe('installed outside Factiii', () => {
  it('a part installed with none of its tools from the runner is someone else\'s, and has no Remove', async () => {
    const { describePart } = await import('./parts');
    const terminals = findPart('terminals')!;
    const installed = { installed: true, missing: [], fixes: [], manual: [] };
    const outside = describePart(terminals, installed, [], null, null, []);
    assert.equal(outside.outside, true);
    assert.ok(!outside.actions.includes('remove'));
    const ours = describePart(terminals, installed, ['tmux'], null, null, ['tmux']);
    assert.equal(ours.outside, false);
    assert.ok(ours.actions.includes('remove'));
    // Not installed: neither.
    assert.equal(describePart(terminals, { ...installed, installed: false }, [], null, null, []).outside, false);
  });
});
