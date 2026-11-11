import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ExecTarget } from '@shared/all/helpers/board-agent-core/exec';
import { hostSpacePaths } from '@shared/all/helpers/board-agent-core/spacePaths';

import { fakeSpawn } from './fakeSpawn.testutil';
import { VM_ENV_BIN, VM_RUN_BIN, vmHandle } from './ssh';
import { vmTarget } from './vmTarget';

const SPACE = '/Users/o/.factiii-runner/b1';
const vm = vmHandle('dev', { limaHome: '/L', controlDir: '/C' });

/** Only what vmTarget reads from the host's target. */
function host(): ExecTarget {
  return {
    paths: hostSpacePaths(SPACE),
    githubToken: () => 'gh',
    stateEnv: () => ({ FACTIII_PORTS: '1,2', HOME: '/Users/o' }),
    agentEnv: () => ({}),
    run: async () => {
      throw new Error('host run');
    },
    sh: async () => {
      throw new Error('host sh');
    },
    runWithStdin: async () => {
      throw new Error('host');
    },
    writeFile: async () => {
      throw new Error('host');
    },
    step: async () => ({ ok: false, stdout: '', stderr: 'host' }),
    spawn: async () => {
      throw new Error('host spawn');
    }
  };
}

function setup(answer: Parameters<typeof fakeSpawn>[0] = () => ({})) {
  const fake = fakeSpawn(answer);
  const events: string[] = [];
  const target = vmTarget(host(), {
    vm,
    slug: 'b1',
    ready: async () => {
      events.push('ready');
    },
    onSessionStart: async () => {
      events.push('session');
    },
    spawn: fake.spawn
  });
  return { target, calls: fake.calls, events };
}

describe('vmTarget', () => {
  it('keeps the host’s paths and env, which mean the same in the VM', () => {
    const { target } = setup();
    assert.equal(target.paths.worktrees, `${SPACE}/worktrees`);
    assert.deepEqual(target.stateEnv(), { FACTIII_PORTS: '1,2', HOME: '/Users/o' });
    assert.ok(target.agentEnv().PATH?.startsWith(`${SPACE}/bin:`));
  });

  it('runs argv in the VM as the session user, with a VM env', async () => {
    const { target, calls, events } = setup(() => ({ stdout: 'out' }));
    const out = await target.run(['git', 'status'], { cwd: `${SPACE}/worktrees/a`, env: { HOME: '/x', K: 'v' } });
    assert.equal(out, 'out');
    assert.deepEqual(events, ['ready']);
    const [call] = calls;
    assert.equal(call!.bin, 'ssh');
    assert.ok(call!.args.includes('factiii'));
    assert.ok(call!.remote.startsWith(`cd '${SPACE}/worktrees/a' 2>/dev/null || cd; exec '${VM_ENV_BIN}' 'b1' 'env'`));
    assert.ok(call!.remote.includes("'K=v'"));
    assert.ok(!call!.remote.includes('HOME='));
    assert.ok(call!.remote.endsWith("'git' 'status'"));
  });

  it('throws with the VM’s stderr on a non-zero exit', async () => {
    const { target } = setup(() => ({ code: 128, stderr: 'fatal: not a git repository' }));
    await assert.rejects(target.run(['git', 'log']), /exit 128\): fatal: not a git repository/);
  });

  it('sh runs a login shell with both streams in one capture', async () => {
    const { target, calls } = setup(() => ({ stdout: 'x' }));
    assert.equal(await target.sh('echo hi'), 'x');
    assert.ok(calls[0]!.remote.includes("'bash' '-lc' 'echo hi' 2>&1"));
  });

  it('writes a file through stdin', async () => {
    const { target, calls } = setup();
    await target.writeFile(`${SPACE}/tmux.conf`, 'set -g mouse on\n');
    assert.equal(calls[0]!.stdin, 'set -g mouse on\n');
    assert.ok(calls[0]!.remote.includes(`'${SPACE}/tmux.conf'`));
  });

  it('step never throws and reports the output', async () => {
    const { target } = setup(() => ({ code: 2, stdout: 'boom' }));
    const res = await target.step('make');
    assert.equal(res.ok, false);
    assert.equal(res.stderr, 'boom');
  });

  it('spawns a session supervised, on a connection of its own, after the tokens', async () => {
    const { target, calls, events } = setup(() => ({ hold: true }));
    await target.spawn(['claude', '-p'], { cwd: `${SPACE}/worktrees/a` });
    assert.deepEqual(events, ['ready', 'session']);
    assert.ok(calls[0]!.remote.includes(`'${VM_RUN_BIN}'`));
    assert.ok(calls[0]!.args.includes('ControlPath=none'));
    assert.ok(calls[0]!.args.includes('-T'));
  });

  it('gives a tmux client a terminal of the asked size', async () => {
    const { target, calls } = setup(() => ({ hold: true }));
    await target.spawnPty!(['tmux', 'new-session', '-A'], { cols: 120, rows: 40 });
    assert.ok(calls[0]!.args.includes('-tt'));
    assert.ok(calls[0]!.remote.includes('stty rows 40 cols 120'));
    assert.ok(!calls[0]!.remote.includes(VM_RUN_BIN));
  });

  it('fails closed: when the VM is not ready nothing runs, here or there', async () => {
    const fake = fakeSpawn();
    const target = vmTarget(host(), {
      vm,
      slug: 'b1',
      ready: async () => {
        throw new Error('The dev VM firewall is not in place');
      },
      spawn: fake.spawn
    });
    await assert.rejects(target.run(['ls']), /firewall/);
    await assert.rejects(target.spawn(['claude']), /firewall/);
    await assert.rejects(target.spawnPty!(['tmux'], { cols: 1, rows: 1 }), /firewall/);
    assert.equal(fake.calls.length, 0);
  });
});
