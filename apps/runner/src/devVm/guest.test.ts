import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';

import {
  BLOCKED_V4,
  bootScript,
  firewallScript,
  isolationTestScript,
  provisionScript
} from './guest';
import { SESSION_USER, VM_TOKEN_DIR } from './ssh';

const layout = {
  runnerDir: '/Users/o/.factiii-runner',
  spaceDirs: ['/Users/o/.factiii-runner/b1'],
  claudeHome: '/Users/o/.factiii-runner/agent-home/claude',
  codexHome: '/Users/o/.factiii-runner/agent-home/codex'
};

/** bash -n: the script parses. */
function parses(script: string): void {
  execFileSync('bash', ['-n'], { input: script });
}

describe('firewallScript', () => {
  const fw = firewallScript();
  const lines = fw.split('\n');
  const at = (needle: string) => lines.findIndex((l) => l.includes(needle));

  it('lets DNS to the gateway through before it refuses the gateway', () => {
    const dns = at('-A FACTIII-OUT -d "$GW" -p udp --dport 53 -j RETURN');
    const reject = at('-A FACTIII-OUT -d "$GW" -j REJECT');
    assert.ok(dns >= 0 && reject > dns);
  });

  it('refuses every private block, for sessions and for containers', () => {
    for (const net of BLOCKED_V4) {
      assert.ok(fw.includes(`iptables -A FACTIII-OUT -d ${net} -j REJECT`), net);
      assert.ok(fw.includes(`iptables -A FACTIII-FWD -d ${net} -j REJECT`), net);
    }
    assert.ok(fw.includes('iptables -I DOCKER-USER 1 -j FACTIII-FWD'));
  });

  it('applies to every uid (no owner match), and is idempotent', () => {
    assert.ok(!fw.includes('--uid-owner'));
    assert.ok(fw.includes('iptables -C OUTPUT -j FACTIII-OUT 2>/dev/null || iptables -I OUTPUT 1 -j FACTIII-OUT'));
    parses(fw);
  });
});

describe('bootScript', () => {
  const boot = bootScript(layout);

  it('refuses a VM with no session user, puts tokens on tmpfs, mounts Codex on tmpfs', () => {
    assert.ok(boot.includes(`id -u ${SESSION_USER}`));
    assert.ok(boot.includes(`install -d -m 700 -o ${SESSION_USER} -g ${SESSION_USER} ${VM_TOKEN_DIR}`));
    assert.ok(boot.includes(`mount -t tmpfs`) && boot.includes(layout.codexHome));
    parses(boot);
  });

  it('prints the boot id last', () => {
    assert.ok(boot.trimEnd().endsWith('cat /proc/sys/kernel/random/boot_id'));
  });
});

describe('provisionScript', () => {
  const script = provisionScript(layout);

  it('gives the session user no sudo and no docker', () => {
    assert.ok(script.includes(`gpasswd -d ${SESSION_USER} docker`));
    assert.ok(script.includes(`gpasswd -d ${SESSION_USER} sudo`));
    assert.ok(script.includes(`rm -f /etc/sudoers.d/${SESSION_USER}`));
  });

  it('checks every download it installs', () => {
    assert.equal((script.match(/sha256sum -c -/g) ?? []).length, 2);
  });

  it('lets the narrow path replace a stale socket', () => {
    assert.ok(script.includes('StreamLocalBindUnlink yes'));
    parses(script);
  });
});

describe('isolationTestScript', () => {
  const script = isolationTestScript({
    hostHome: '/Users/o',
    runnerDir: layout.runnerDir,
    spaceDirs: layout.spaceDirs,
    allowedMounts: ['/Users/o/.factiii-runner/b1/repo'],
    hostPorts: [53, 11434],
    lanHosts: ['192.168.1.9'],
    narrowSockets: ['/Users/o/.factiii-runner/b1/state/secrets.sock']
  });

  it('probes the Mac’s secrets, home mount, sudo, ports and the narrow path', () => {
    for (const needle of [
      '/Users/o/.ssh',
      '/Users/o/Library/Keychains',
      '/Users/o/.factiii-runner/config.json',
      '/Users/o/.factiii-runner/b1/.session-key',
      'the Mac home is mounted',
      'sudo -n true',
      "'11434'",
      "'192.168.1.9'",
      'narrow path refuses $op',
      'tunnel-token'
    ]) {
      assert.ok(script.includes(needle), needle);
    }
    parses(script);
  });
});
