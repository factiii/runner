import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { colimaStartArgv, DevVm, type HostExec, parseLsofPorts, spaceMounts } from './devVm';
import { fakeSpawn } from './fakeSpawn.testutil';
import { readDevVmSettings } from './settings';
import { tunnelArgv } from './tunnel';
import { vmHandle } from './ssh';

describe('colimaStartArgv', () => {
  const argv = colimaStartArgv('default', ['/U/.fr/b1'], { cpus: 6, memoryGiB: 16, diskGiB: 100 }, { activate: true });

  it('mounts only each board’s five folders, so not the home', () => {
    const mounts = argv.flatMap((a, i) => (argv[i - 1] === '--mount' ? [a] : []));
    assert.deepEqual(mounts, [
      '/U/.fr/b1/repo:w',
      '/U/.fr/b1/worktrees:w',
      '/U/.fr/b1/scratchpad:w',
      '/U/.fr/b1/drops',
      '/U/.fr/b1/bin'
    ]);
    assert.ok(argv.includes('--ssh-config=false'));
    assert.deepEqual(argv.slice(0, 3), ['colima', 'start', 'default']);
  });

  it('never mounts the space dir itself (its secrets, keys and sockets)', () => {
    assert.ok(!spaceMounts('/s').some((m) => m.path === '/s' || m.path.includes('secret') || m.path.includes('state')));
  });
});

describe('parseLsofPorts', () => {
  it('reads the listening ports once each', () => {
    const text = [
      'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME',
      'ollama 1 jon 3u IPv4 0x1 0t0 TCP 127.0.0.1:11434 (LISTEN)',
      'nginx 2 jon 6u IPv6 0x2 0t0 TCP *:443 (LISTEN)',
      'nginx 3 jon 7u IPv4 0x3 0t0 TCP *:443 (LISTEN)'
    ].join('\n');
    assert.deepEqual(parseLsofPorts(text), [443, 11434]);
  });
});

describe('tunnelArgv', () => {
  it('forwards each board’s socket into the VM on a connection of its own', () => {
    const vm = vmHandle('dev', { limaHome: '/L', controlDir: '/C' });
    const argv = tunnelArgv(vm, [{ vmPath: '/s/state/secrets.sock', hostPath: '/r/devvm/b.sock' }]);
    assert.ok(argv.includes('ControlPath=none'));
    assert.ok(argv.includes('ExitOnForwardFailure=yes'));
    assert.deepEqual(argv.slice(argv.indexOf('-R'), argv.indexOf('-R') + 2), ['-R', '/s/state/secrets.sock:/r/devvm/b.sock']);
    assert.ok(argv.includes('-N'));
  });
});

describe('readDevVmSettings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devvm-'));

  it('is OFF with no file, and off any OS but macOS', () => {
    assert.deepEqual(readDevVmSettings(dir, 'darwin'), { enabled: false, profile: 'default' });
    fs.writeFileSync(path.join(dir, 'devvm.json'), JSON.stringify({ enabled: true, profile: 'dev' }));
    assert.deepEqual(readDevVmSettings(dir, 'darwin'), { enabled: true, profile: 'dev' });
    assert.deepEqual(readDevVmSettings(dir, 'linux'), { enabled: false, profile: 'default' });
  });

  it('reads anything odd as off, or the default profile', () => {
    fs.writeFileSync(path.join(dir, 'devvm.json'), '{not json');
    assert.equal(readDevVmSettings(dir, 'darwin').enabled, false);
    fs.writeFileSync(path.join(dir, 'devvm.json'), JSON.stringify({ enabled: 'yes', profile: '../x' }));
    assert.deepEqual(readDevVmSettings(dir, 'darwin'), { enabled: false, profile: 'default' });
  });
});

describe('DevVm.ready', () => {
  const okHost: HostExec = async () => ({ code: 0, stdout: '', stderr: '' });
  const base = (spawn: ReturnType<typeof fakeSpawn>['spawn']) =>
    new DevVm({
      configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dv-')),
      settings: { enabled: true, profile: 'dev' },
      homes: { claude: '/nope/claude', codex: '/nope/codex' },
      claudeToken: () => '',
      spaces: () => [],
      spawn,
      hostExec: okHost
    });

  it('fails closed with how to start the VM when it is unreachable', async () => {
    const fake = fakeSpawn(() => ({ code: 255, stderr: 'Connection refused' }));
    const devVm = base(fake.spawn);
    await assert.rejects(devVm.ready(), /not reachable: Connection refused.*colima start dev.*do not fall back/s);
    assert.match(devVm.status() ?? '', /not reachable/);
  });

  it('refuses sessions when the firewall is not in place', async () => {
    const fake = fakeSpawn((call) => {
      if (call.remote.includes('boot_id')) return { stdout: 'boot-1\n' };
      if (call.remote.includes('iptables -C')) return { code: 1 };
      return {};
    });
    await assert.rejects(base(fake.spawn).ready(), /firewall is not in place/);
  });

  it('sets a fresh VM up (boot script as root), then trusts it for a while', async () => {
    const fake = fakeSpawn((call) => (call.remote.includes('boot_id') ? { stdout: 'boot-1\n' } : {}));
    const devVm = base(fake.spawn);
    await devVm.ready();
    const boots = fake.calls.filter((c) => c.remote === 'sudo -n bash -s');
    assert.equal(boots.length, 1);
    assert.match(boots[0]!.stdin, /FACTIII-OUT/);
    const before = fake.calls.length;
    await devVm.ready();
    assert.equal(fake.calls.length, before);
    await devVm.stop();
  });

  it('refuses a board the VM does not serve', async () => {
    const fake = fakeSpawn((call) => (call.remote.includes('boot_id') ? { stdout: 'boot-1\n' } : {}));
    const devVm = base(fake.spawn);
    await assert.rejects(devVm.ready('elsewhere'), /not set up in the dev VM.*devvm rebuild/);
    await devVm.stop();
  });
});
