import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ToolPlan } from '@shared/all/helpers/board-agent-core';

import {
  BREW_SHELLENV,
  buildChecks,
  countSimulators,
  type DoctorHost,
  type DoctorUi,
  parsePmset,
  renderResult,
  runDoctor
} from './doctor';
import type { ServiceStatus } from './service';

// The checklist against a made-up machine. No probe here touches the real
// one, and every fix lands in a recorder.

const BINS = [
  'git',
  'redis-server',
  'tmux',
  'script',
  'node',
  'claude',
  'codex',
  'sops',
  'age-keygen',
  'ollama',
  'orb',
  'tailscale',
  'tart'
];

/** Every tool present, except `missing`, which this host installs as given. */
function toolPlans(missing: Record<string, ToolPlan['install']> = {}): ToolPlan[] {
  return BINS.map((bin) => ({
    bin,
    location: bin in missing ? '' : `/opt/homebrew/bin/${bin}`,
    install: bin in missing ? missing[bin] : { command: `brew install ${bin}`, sudo: false }
  }));
}

const SERVICE_ON: ServiceStatus = {
  name: 'com.factiii.runner',
  file: '/Users/jo/Library/LaunchAgents/com.factiii.runner.plist',
  installed: 'yes',
  loaded: true,
  running: true,
  pid: 77,
  command: 'node cli start',
  log: '/Users/jo/.factiii-runner/logs/runner.log'
};

/** A Mac with everything in place; `over` breaks one thing at a time. */
function fakeHost(over: Partial<DoctorHost> = {}): DoctorHost {
  return {
    platform: 'darwin',
    nodeVersion: '24.11.1',
    runnerDir: '/Users/jo/.factiii-runner',
    user: 'jo',
    tools: async () => toolPlans(),
    vaultEngine: () => true,
    vaultEmbedder: () => 'ready',
    localAiModel: async () => ({ state: 'ready', detail: 'Llama 3.1 8B in Ollama' }),
    health: async () => ({
      level: 'ok',
      disks: [{ uses: ['Runner folder'], freeGb: 200, totalGb: 500, level: 'ok' }],
      memory: 'ok',
      warnGb: 20,
      criticalGb: 5
    }),
    dirWritable: () => true,
    fileExists: () => true,
    loginPath: async () => '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin',
    keychain: () => ({ ready: true, keyStore: 'macos-keychain', problem: '', fix: '' }),
    paired: () => true,
    async run(bin, args) {
      if (bin === 'xcode-select') {
        return { code: 0, output: '/Applications/Xcode.app/Contents/Developer\n' };
      }
      if (bin === 'xcodebuild') return { code: 0, output: '' };
      if (bin === 'xcrun') {
        return { code: 0, output: '{"devices":{"iOS-18":[{"udid":"A"},{"udid":"B"}]}}' };
      }
      if (bin === 'defaults') return { code: 0, output: 'jo\n' };
      if (bin === 'pmset') return { code: 0, output: ' sleep                0\n autorestart          1\n' };
      return { code: 1, output: '' };
    },
    service: async () => SERVICE_ON,
    ...over
  };
}

type Recorder = DoctorUi & {
  lines: string[];
  asked: string[];
  installed: string[];
  made: string[];
  opened: string[];
};

/** A UI that answers every question with `answer`, or has no terminal. */
function fakeUi(answer: boolean | null): Recorder {
  const ui: Recorder = {
    lines: [],
    asked: [],
    installed: [],
    made: [],
    opened: [],
    print: (line) => void ui.lines.push(line),
    confirm:
      answer === null
        ? null
        : async (question) => {
            ui.asked.push(question);
            return answer;
          },
    installTool: async (bin) => void ui.installed.push(bin),
    makeDir: (dir) => void ui.made.push(dir),
    openSettings: (url) => void ui.opened.push(url)
  };
  return ui;
}

const state = (results: { id: string; state: string }[], id: string) =>
  results.find((r) => r.id === id)?.state;

describe('the checklist', () => {
  it('is all met on a machine with everything, and exits 0', async () => {
    const ui = fakeUi(true);
    const { results, exitCode } = await runDoctor(buildChecks(fakeHost()), ui, { fix: true });
    assert.equal(exitCode, 0);
    assert.deepEqual(
      results.filter((r) => r.state !== 'met').map((r) => r.id),
      []
    );
    assert.deepEqual(ui.asked, []);
    assert.equal(ui.lines.at(-1), 'Ready. Nothing is missing.');
  });

  it('marks each item required or optional by the feature it serves', () => {
    const { checks } = buildChecks(fakeHost());
    const required = checks.filter((c) => c.required).map((c) => c.id);
    // The connector's own items: every tool belongs to a part (parts.ts).
    assert.deepEqual(required, ['node-version', 'folder', 'keychain', 'pairing']);
    const feature = (id: string) => checks.find((c) => c.id === id)?.feature;
    assert.equal(feature('sops'), 'secrets');
    assert.equal(feature('xcode'), 'simulator panel');
    assert.equal(feature('simulator'), 'simulator panel');
    // The desktop view and its two macOS grants are gone.
    assert.equal(feature('screen-recording'), undefined);
    assert.equal(feature('service'), 'always on');
  });

  it('exits 1 when a required item is unmet', async () => {
    const ui = fakeUi(null);
    const { results, exitCode } = await runDoctor(
      buildChecks(fakeHost({ paired: () => false })),
      ui,
      { fix: true }
    );
    assert.equal(exitCode, 1);
    assert.equal(state(results, 'pairing'), 'unmet');
    assert.equal(ui.lines.at(-1), 'Not ready: Paired with a Factiii account.');
  });

  it('exits 0 with a part’s tool missing: the connector needs none', async () => {
    const host = fakeHost({ tools: async () => toolPlans({ tmux: { command: 'brew install tmux', sudo: false } }) });
    const ui = fakeUi(null);
    const { results, exitCode } = await runDoctor(buildChecks(host), ui, { fix: true });
    assert.equal(exitCode, 0);
    assert.equal(state(results, 'tmux'), 'unmet');
    assert.equal(ui.lines.at(-1), 'Ready. Optional and not set up: tmux.');
  });

  it('exits 0 when only optional items are unmet', async () => {
    const host = fakeHost({
      tools: async () => toolPlans({ sops: { command: 'brew install sops', sudo: false } }),
      service: async () => ({ ...SERVICE_ON, installed: 'no', loaded: false, running: false }),
      async run() {
        return { code: 1, output: '' };
      }
    });
    const { results, exitCode } = await runDoctor(buildChecks(host), fakeUi(null), { fix: true });
    assert.equal(exitCode, 0);
    for (const id of ['sops', 'xcode', 'simulator', 'service', 'login']) {
      assert.equal(state(results, id), 'unmet', id);
    }
    // pmset gave no answer: not known, and never held against the machine.
    assert.equal(state(results, 'power'), 'unknown');
  });

  it('never calls simctl while Xcode still needs its first-launch setup', async () => {
    const calls: string[] = [];
    const base = fakeHost();
    const host = fakeHost({
      async run(bin, args) {
        calls.push(bin);
        if (bin === 'xcodebuild') return { code: 1, output: '' };
        return base.run(bin, args);
      }
    });
    const { results } = await runDoctor(buildChecks(host), fakeUi(null), { fix: true });
    const sim = results.find((r) => r.id === 'simulator');
    assert.equal(sim?.state, 'unmet');
    assert.match(sim?.detail ?? '', /finish setting up/);
    assert.ok(!calls.includes('xcrun'), 'simctl would run xcodebuild -runFirstLaunch, which prompts');
  });

  it('leaves the Mac-only items off a Linux host, and says the keychain is beta there', async () => {
    const host = fakeHost({
      platform: 'linux',
      keychain: () => ({ ready: true, keyStore: 'libsecret', problem: '', fix: '' }),
      async run(bin) {
        return bin === 'loginctl' ? { code: 0, output: 'Linger=no\n' } : { code: 1, output: '' };
      }
    });
    const { results } = await runDoctor(buildChecks(host), fakeUi(null), { fix: true });
    const ids = results.map((r) => r.id);
    for (const id of ['xcode', 'simulator']) {
      assert.ok(!ids.includes(id), id);
    }
    assert.match(results.find((r) => r.id === 'keychain')?.detail ?? '', /beta/);
    const login = results.find((r) => r.id === 'login');
    assert.equal(login?.state, 'unmet');
    assert.deepEqual(login?.fix, {
      kind: 'command',
      note: login?.fix?.kind === 'command' ? login.fix.note : [],
      commands: ['sudo loginctl enable-linger jo']
    });
  });

  it('asks for WSL2 on Windows instead of seven tools that have no build', async () => {
    const host = fakeHost({ platform: 'win32', tools: async () => [] });
    const { results, exitCode } = await runDoctor(buildChecks(host), fakeUi(null), { fix: true });
    assert.equal(exitCode, 1);
    assert.equal(state(results, 'wsl'), 'unmet');
    assert.ok(!results.some((r) => r.id === 'tmux'));
  });
});

describe('Homebrew on the login PATH', () => {
  // mac-mini-m6, 2026-10-25: Homebrew in /opt/homebrew, on no PATH at all.
  it('says so, with the line for ~/.zprofile, and never runs it', async () => {
    const host = fakeHost({ loginPath: async () => '/usr/bin:/bin:/usr/sbin:/sbin' });
    const ui = fakeUi(true);
    const { results, exitCode } = await runDoctor(buildChecks(host), ui, { fix: true });
    assert.equal(exitCode, 0);
    const result = results.find((r) => r.id === 'homebrew-path');
    assert.equal(result?.state, 'unmet');
    assert.equal(result?.detail, 'Homebrew is installed but not on your PATH.');
    assert.ok(
      ui.lines.includes(`${' '.repeat(10)}    ${BREW_SHELLENV}`),
      'the exact line is printed'
    );
    assert.equal(BREW_SHELLENV, 'eval "$(/opt/homebrew/bin/brew shellenv)"');
    assert.deepEqual(ui.asked, []);
  });

  it('is met with no Homebrew, and unknown when the shell gives no PATH', async () => {
    const noBrew = fakeHost({
      fileExists: (file) => file !== '/opt/homebrew/bin/brew',
      loginPath: async () => '/usr/bin:/bin'
    });
    const quiet = fakeHost({ loginPath: async () => null });
    const read = async (host: DoctorHost) =>
      state((await runDoctor(buildChecks(host), fakeUi(null), { fix: false })).results, 'homebrew-path');
    assert.equal(await read(noBrew), 'met');
    assert.equal(await read(quiet), 'unknown');
  });

  it('is not asked off a Mac', () => {
    const { checks } = buildChecks(fakeHost({ platform: 'linux' }));
    assert.ok(!checks.some((c) => c.id === 'homebrew-path'));
  });
});

describe('fixes', () => {
  const missingTools = () =>
    toolPlans({
      tmux: { command: 'brew install tmux', sudo: false },
      sops: { command: 'brew install sops', sudo: false },
      'age-keygen': { command: 'brew install age', sudo: false }
    });

  it('never asks without a terminal', async () => {
    const ui = fakeUi(null);
    const { exitCode } = await runDoctor(
      buildChecks(fakeHost({ tools: async () => missingTools() })),
      ui,
      { fix: true }
    );
    assert.equal(exitCode, 0);
    assert.deepEqual(ui.installed, []);
    assert.ok(ui.lines.some((line) => line.includes('The runner can install it: brew install tmux')));
  });

  it('never asks with --no-fix, terminal or not', async () => {
    const ui = fakeUi(true);
    await runDoctor(buildChecks(fakeHost({ tools: async () => missingTools() })), ui, {
      fix: false
    });
    assert.deepEqual(ui.asked, []);
    assert.deepEqual(ui.installed, []);
  });

  it('installs the tools on a yes, then checks again', async () => {
    let installed = false;
    const ui = fakeUi(true);
    ui.installTool = async (bin) => {
      ui.installed.push(bin);
      installed = true;
    };
    const host = fakeHost({ tools: async () => (installed ? toolPlans() : missingTools()) });
    const { results, exitCode } = await runDoctor(buildChecks(host), ui, { fix: true });
    assert.deepEqual(ui.installed, ['tmux', 'sops', 'age-keygen']);
    assert.deepEqual(ui.asked, ['Fix it for me? [Y/n] ', 'Fix it for me? [Y/n] ', 'Fix it for me? [Y/n] ']);
    assert.equal(exitCode, 0);
    assert.equal(state(results, 'tmux'), 'met');
  });

  it('installs nothing on a no', async () => {
    const ui = fakeUi(false);
    const { exitCode } = await runDoctor(
      buildChecks(fakeHost({ tools: async () => missingTools() })),
      ui,
      { fix: true }
    );
    assert.equal(ui.asked.length, 3);
    assert.deepEqual(ui.installed, []);
    assert.equal(exitCode, 0);
  });

  it('prints a command that needs root, and never runs or offers it', async () => {
    const host = fakeHost({
      platform: 'linux',
      tools: async () =>
        toolPlans({
          tmux: { command: 'sudo apt-get install -y tmux', sudo: true },
          // Debian has no sops package.
          sops: null
        }),
      service: async () => ({ ...SERVICE_ON, installed: 'no', loaded: false, running: false }),
      async run() {
        return { code: 1, output: '' };
      }
    });
    const ui = fakeUi(true);
    const { results } = await runDoctor(buildChecks(host), ui, { fix: true });
    assert.deepEqual(ui.asked, []);
    assert.deepEqual(ui.installed, []);
    assert.deepEqual(ui.made, []);
    assert.deepEqual(ui.opened, []);
    const text = ui.lines.join('\n');
    assert.ok(text.includes('sudo apt-get install -y tmux'));
    assert.ok(text.includes('sudo loginctl enable-linger jo'));
    assert.ok(text.includes('sudo systemctl mask sleep.target'));
    assert.ok(text.includes('factiii-runner service install'));
    assert.ok(text.includes('https://github.com/getsops/sops/releases'));
    assert.equal(results.find((r) => r.id === 'sops')?.fix, undefined);
  });

  it('only prints the sleep, power and auto-login steps on a Mac', async () => {
    const host = fakeHost({
      async run(bin) {
        if (bin === 'pmset') return { code: 0, output: ' sleep                1\n autorestart          0\n' };
        return { code: 1, output: '' };
      }
    });
    const ui = fakeUi(true);
    const { results, exitCode } = await runDoctor(buildChecks(host), ui, { fix: true });
    assert.equal(exitCode, 0);
    assert.equal(state(results, 'power'), 'unmet');
    assert.deepEqual(ui.asked, []);
    const text = ui.lines.join('\n');
    assert.ok(text.includes('sudo pmset -c sleep 0 disksleep 0'));
    assert.ok(text.includes('sudo pmset -a autorestart 1'));
    assert.ok(text.includes('Automatically log in as'));
    assert.ok(text.includes('FileVault'));
  });

  it('creates the runner folder on a yes', async () => {
    let made = false;
    const ui = fakeUi(true);
    ui.makeDir = (dir) => {
      ui.made.push(dir);
      made = true;
    };
    const { exitCode } = await runDoctor(
      buildChecks(fakeHost({ dirWritable: () => made })),
      ui,
      { fix: true }
    );
    assert.deepEqual(ui.made, ['/Users/jo/.factiii-runner']);
    assert.deepEqual(ui.installed, []);
    assert.equal(exitCode, 0);
  });

  it('reports an install that failed and stays unmet', async () => {
    const ui = fakeUi(true);
    ui.installTool = async () => {
      throw new Error('Failed to install tmux with `brew install tmux`.');
    };
    const host = fakeHost({
      tools: async () => toolPlans({ tmux: { command: 'brew install tmux', sudo: false } })
    });
    const { results } = await runDoctor(buildChecks(host), ui, { fix: true });
    assert.equal(state(results, 'tmux'), 'unmet');
    assert.ok(ui.lines.some((line) => line.includes('Failed to install tmux')));
  });
});

describe('report lines', () => {
  it('says what an item is for, whether it is required, and its state', () => {
    assert.deepEqual(
      renderResult({
        id: 'tmux',
        title: 'tmux',
        feature: 'terminals',
        required: true,
        state: 'met',
        detail: '/opt/homebrew/bin/tmux'
      }),
      ['[ok]      tmux  (required: terminals)', '          /opt/homebrew/bin/tmux']
    );
  });
});

describe('probe parsing', () => {
  it('counts simulators across runtimes', () => {
    assert.equal(countSimulators('{"devices":{"a":[{}],"b":[{},{}],"c":[]}}'), 3);
    assert.equal(countSimulators('xcrun: error: unable to find utility "simctl"'), 0);
  });

  it('reads pmset, and a laptop with no autorestart line', () => {
    assert.deepEqual(
      parsePmset('System-wide power settings:\nCurrently in use:\n standby              1\n sleep                0 (sleep prevented by powerd)\n autorestart          1\n disksleep            10\n'),
      { sleep: 0, autorestart: 1 }
    );
    assert.deepEqual(parsePmset(' sleep                10\n'), { sleep: 10, autorestart: null });
  });
});
