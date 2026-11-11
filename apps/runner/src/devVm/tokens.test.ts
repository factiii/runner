import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  type CodexSyncState,
  pushSpaceTokens,
  syncCodexAuth,
  tokenEnvFile,
  type VmExec
} from './tokens';

describe('tokenEnvFile', () => {
  it('quotes values so a shell reads them back exactly', () => {
    const file = tokenEnvFile({ GH_TOKEN: "gh'o$x", CLAUDE_CODE_OAUTH_TOKEN: 'sk-1' });
    // From a file, not /dev/stdin: Node hands a child its input on a socket
    // on Linux, which `.` cannot open there.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'token-env-'));
    const envFile = path.join(dir, 'tokens.env');
    writeFileSync(envFile, file);
    const out = execFileSync('sh', ['-c', `set -a; . "$1"; printf '%s|%s' "$GH_TOKEN" "$CLAUDE_CODE_OAUTH_TOKEN"`, 'sh', envFile], {
      encoding: 'utf-8'
    });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(out, "gh'o$x|sk-1");
  });

  it('leaves out empty values and ones that cannot be a token', () => {
    assert.equal(tokenEnvFile({ GH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: 'a\nb' }), '');
  });
});

describe('pushSpaceTokens', () => {
  it('sends the tokens on stdin, never on the command line', async () => {
    const calls: { user: string; command: string; input?: string }[] = [];
    const exec: VmExec = async (user, command, input) => {
      calls.push({ user, command, input });
      return { code: 0, stdout: '', stderr: '' };
    };
    await pushSpaceTokens(exec, 'board', { GH_TOKEN: 'ghs_secret' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.user, 'session');
    assert.ok(!calls[0]!.command.includes('ghs_secret'));
    assert.ok(calls[0]!.command.includes('umask 077'));
    assert.ok(calls[0]!.command.includes('/run/factiii-tokens/board.env'));
    assert.equal(calls[0]!.input, "GH_TOKEN='ghs_secret'\n");
  });

  it('throws when the VM will not take them', async () => {
    const exec: VmExec = async () => ({ code: 1, stdout: '', stderr: 'no space' });
    await assert.rejects(pushSpaceTokens(exec, 'b', { GH_TOKEN: 'x' }), /no space/);
  });
});

describe('syncCodexAuth', () => {
  const auth = (access: string, refreshed: string) =>
    JSON.stringify({ tokens: { access_token: access }, last_refresh: refreshed });

  /** A VM holding one file, by path. */
  function fakeVm(initial: string | null) {
    const state = { file: initial };
    const exec: VmExec = async (_user, command, input) => {
      if (command.startsWith('cat ')) {
        return state.file === null
          ? { code: 1, stdout: '', stderr: '' }
          : { code: 0, stdout: state.file, stderr: '' };
      }
      state.file = input ?? '';
      return { code: 0, stdout: '', stderr: '' };
    };
    return { state, exec };
  }

  async function hostFile(content: string | null): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-'));
    const file = path.join(dir, 'auth.json');
    if (content !== null) await fs.writeFile(file, content);
    return file;
  }

  it('pushes the Mac’s sign-in into an empty VM, then calls them the same', async () => {
    const hostPath = await hostFile(auth('a', '2026-11-01T00:00:00Z'));
    const vm = fakeVm(null);
    const state: CodexSyncState = { lastHash: null };
    assert.equal(await syncCodexAuth({ exec: vm.exec, hostPath, vmPath: '/v/auth.json', state }), 'pushed');
    assert.equal(vm.state.file, auth('a', '2026-11-01T00:00:00Z'));
    assert.equal(await syncCodexAuth({ exec: vm.exec, hostPath, vmPath: '/v/auth.json', state }), 'same');
  });

  it('copies a refresh made in the VM back to the Mac, 0600', async () => {
    const hostPath = await hostFile(auth('a', '2026-11-01T00:00:00Z'));
    const vm = fakeVm(null);
    const state: CodexSyncState = { lastHash: null };
    await syncCodexAuth({ exec: vm.exec, hostPath, vmPath: '/v', state });
    vm.state.file = auth('b', '2026-11-02T00:00:00Z');
    assert.equal(await syncCodexAuth({ exec: vm.exec, hostPath, vmPath: '/v', state }), 'pulled');
    assert.equal(await fs.readFile(hostPath, 'utf-8'), auth('b', '2026-11-02T00:00:00Z'));
    assert.equal((await fs.stat(hostPath)).mode & 0o777, 0o600);
  });

  it('pushes a new Mac sign-in over the VM’s unchanged copy', async () => {
    const hostPath = await hostFile(auth('a', '2026-11-01T00:00:00Z'));
    const vm = fakeVm(null);
    const state: CodexSyncState = { lastHash: null };
    await syncCodexAuth({ exec: vm.exec, hostPath, vmPath: '/v', state });
    await fs.writeFile(hostPath, auth('c', '2026-11-03T00:00:00Z'));
    assert.equal(await syncCodexAuth({ exec: vm.exec, hostPath, vmPath: '/v', state }), 'pushed');
    assert.equal(vm.state.file, auth('c', '2026-11-03T00:00:00Z'));
  });

  it('when both changed, keeps the later refresh', async () => {
    const hostPath = await hostFile(auth('a', '2026-11-01T00:00:00Z'));
    const vm = fakeVm(null);
    const state: CodexSyncState = { lastHash: null };
    await syncCodexAuth({ exec: vm.exec, hostPath, vmPath: '/v', state });
    await fs.writeFile(hostPath, auth('host', '2026-11-05T00:00:00Z'));
    vm.state.file = auth('vm', '2026-11-04T00:00:00Z');
    assert.equal(await syncCodexAuth({ exec: vm.exec, hostPath, vmPath: '/v', state }), 'pushed');
    assert.equal(vm.state.file, auth('host', '2026-11-05T00:00:00Z'));
  });

  it('never copies a broken VM file over the Mac’s sign-in', async () => {
    const good = auth('a', '2026-11-01T00:00:00Z');
    const hostPath = await hostFile(good);
    const vm = fakeVm(null);
    const state: CodexSyncState = { lastHash: null };
    await syncCodexAuth({ exec: vm.exec, hostPath, vmPath: '/v', state });
    vm.state.file = '{"half":';
    await syncCodexAuth({ exec: vm.exec, hostPath, vmPath: '/v', state });
    assert.equal(await fs.readFile(hostPath, 'utf-8'), good);
  });
});
