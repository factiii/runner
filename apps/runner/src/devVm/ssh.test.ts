import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';

import {
  limaInstance,
  masterArgv,
  remoteCommand,
  SESSION_USER,
  shQuote,
  sshArgv,
  VM_ENV_BIN,
  VM_PATH,
  VM_RUN_BIN,
  vmEnv,
  vmHandle
} from './ssh';

const vm = vmHandle('dev', { limaHome: '/L', controlDir: '/C' });

describe('vmHandle', () => {
  it('names the Lima instance as Colima does', () => {
    assert.equal(limaInstance('default'), 'colima');
    assert.equal(limaInstance('dev'), 'colima-dev');
    assert.equal(vm.sshConfig, '/L/colima-dev/ssh.config');
    assert.equal(vm.host, 'lima-colima-dev');
  });
});

describe('sshArgv', () => {
  it('logs a session in as the unprivileged user, over our own mux, never as a master', () => {
    const argv = sshArgv(vm, 'session');
    assert.deepEqual(argv.slice(0, 3), ['ssh', '-F', '/L/colima-dev/ssh.config']);
    assert.ok(argv.includes('ControlPath=/C/%C'));
    assert.ok(argv.includes('ControlMaster=no'));
    assert.deepEqual(argv.slice(argv.indexOf('-l'), argv.indexOf('-l') + 2), ['-l', SESSION_USER]);
    assert.deepEqual(argv.slice(-2), ['lima-colima-dev', '--']);
    assert.ok(argv.includes('-T'));
  });

  it('logs admin in as the Lima user', () => {
    assert.ok(!sshArgv(vm, 'admin').includes('-l'));
  });

  it('gives a terminal with -tt, and a connection of its own with mux: false', () => {
    assert.ok(sshArgv(vm, 'session', { tty: true }).includes('-tt'));
    const own = sshArgv(vm, 'session', { mux: false });
    assert.ok(own.includes('ControlPath=none'));
    assert.ok(!own.includes('ControlPath=/C/%C'));
  });

  it('starts the master in the background on its own', () => {
    const argv = masterArgv(vm, 'session');
    for (const flag of ['ControlMaster=yes', '-f', '-N']) assert.ok(argv.includes(flag), flag);
  });
});

describe('vmEnv', () => {
  it('drops what describes this host and uses the VM PATH', () => {
    const env = vmEnv({ HOME: '/Users/x', SSH_AUTH_SOCK: '/s', FACTIII_PORTS: '1,2', PATH: '/opt/homebrew/bin' }, '/sp/bin');
    assert.deepEqual(env, { FACTIII_PORTS: '1,2', PATH: VM_PATH });
  });

  it('keeps the space bin first when the caller put it on PATH', () => {
    assert.equal(vmEnv({ PATH: '/sp/bin:/usr/bin' }, '/sp/bin').PATH, `/sp/bin:${VM_PATH}`);
  });

  it('drops names a shell could not carry', () => {
    assert.deepEqual(Object.keys(vmEnv({ 'A-B': 'x', 'ok_1': 'y' }, '/b')), ['ok_1', 'PATH']);
  });
});

describe('remoteCommand', () => {
  it('cds, sources the tokens, then runs env and argv', () => {
    const cmd = remoteCommand(['echo', "it's"], { slug: 'board', cwd: '/w t', env: { A: "x'y" } });
    assert.equal(
      cmd,
      `cd '/w t' 2>/dev/null || cd; exec '${VM_ENV_BIN}' 'board' 'env' 'A=x'\\''y' 'echo' 'it'\\''s'`
    );
  });

  it('supervises and merges stderr when asked', () => {
    const cmd = remoteCommand(['x'], { slug: 'b', supervise: true, mergeStderr: true });
    assert.ok(cmd.includes(`'${VM_RUN_BIN}'`));
    assert.ok(cmd.endsWith(' 2>&1'));
  });

  it('round-trips argv through a real shell', () => {
    const argv = ['printf', '%s|', "a'b", 'c d', '$HOME', '`x`'];
    const quoted = argv.map(shQuote).join(' ');
    assert.equal(execFileSync('sh', ['-c', quoted], { encoding: 'utf-8' }), "a'b|c d|$HOME|`x`|");
  });
});
