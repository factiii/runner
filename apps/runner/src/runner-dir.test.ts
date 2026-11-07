import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  keychainAccount,
  MAX_RUNNER_DIR_LENGTH,
  runnerDir
} from '@shared/all/helpers/board-agent-core/runner-dir';

// FACTIII_RUNNER_DIR lets a dev runner share a Mac with the real one. The
// probe runs under a FAKE home and a FAKE `security`, so this test can never
// touch the real ~/.factiii-runner or the real Keychain item.

/** A `security` stand-in: logs its args, keeps items in a JSON file. */
const FAKE_SECURITY = `#!/usr/bin/env node
const fs = require('fs');
const store = process.env.FAKE_KEYCHAIN;
const items = fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, 'utf8')) : {};
const args = process.argv.slice(2);
fs.appendFileSync(store + '.log', JSON.stringify(args) + '\\n');
const flag = (f) => args[args.indexOf(f) + 1];
const id = flag('-s') + '/' + flag('-a');
if (args[0] === 'find-generic-password') {
  if (!(id in items)) process.exit(44);
  process.stdout.write(items[id] + '\\n');
} else if (args[0] === 'add-generic-password') {
  items[id] = flag('-w');
  fs.writeFileSync(store, JSON.stringify(items));
}
`;

describe('FACTIII_RUNNER_DIR', () => {
  it('keeps every file and the Keychain item away from the default runner', () => {
    // /tmp, not os.tmpdir(): macOS's per-user tmpdir is too long for a runner
    // dir (the socket limit this dir is checked against).
    const home = fs.mkdtempSync('/tmp/rdh-');
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'security'), FAKE_SECURITY, { mode: 0o755 });
    const devDir = path.join(home, '.frd');
    const keychain = path.join(home, 'keychain.json');

    const res = spawnSync(
      process.execPath,
      ['--import', 'tsx', path.join(__dirname, 'test-fixtures/runner-dir-probe.ts')],
      {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf-8',
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}:${process.env.PATH}`,
          FACTIII_RUNNER_DIR: devDir,
          FAKE_KEYCHAIN: keychain
        }
      }
    );
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout) as { configDir: string; roundTrip: boolean };
    assert.equal(out.configDir, devDir);
    assert.equal(out.roundTrip, true);

    // Nothing under the default dir, everything under the dev dir.
    assert.equal(fs.existsSync(path.join(home, '.factiii-runner')), false);
    for (const f of ['config.json', 'access.json', 'npm/probe', 'plugin/probe', 'board/probe']) {
      assert.equal(fs.existsSync(path.join(devDir, f)), true, f);
    }
    // The Keychain was only ever asked for the dev account.
    const calls = fs
      .readFileSync(`${keychain}.log`, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as string[]);
    assert.ok(calls.length > 0);
    for (const args of calls) {
      const account = args[args.indexOf('-a') + 1];
      assert.notEqual(account, 'config-encryption-key');
      assert.match(account, /^config-encryption-key:[0-9a-f]{12}$/);
    }
  });

  it('keeps the default dir and Keychain account when unset', () => {
    assert.equal(runnerDir({}), path.join(os.homedir(), '.factiii-runner'));
    assert.equal(keychainAccount({}), 'config-encryption-key');
  });

  it('gives two dirs two Keychain accounts', () => {
    const a = keychainAccount({ FACTIII_RUNNER_DIR: '/tmp/r-a' });
    const b = keychainAccount({ FACTIII_RUNNER_DIR: '/tmp/r-b' });
    assert.notEqual(a, b);
  });

  it('refuses a dir too long for a macOS socket path', () => {
    const long = `/tmp/${'x'.repeat(MAX_RUNNER_DIR_LENGTH)}`;
    assert.throws(() => runnerDir({ FACTIII_RUNNER_DIR: long }), /104-byte/);
  });
});
