import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

// Where the GitHub connection files are sealed, how files an
// older runner sealed under the password vault are converted, and how the
// vault - and the connection password with it - is retired. Every step runs
// in a subprocess under a FAKE home, a FACTIII_RUNNER_DIR and a FAKE
// `security`, so nothing here can reach the real runner folder or Keychain.

/** A `security` stand-in: logs its args, keeps items in a JSON file.
 *  FAKE_KEYCHAIN_BROKEN makes it fail the way a locked keychain does. */
const FAKE_SECURITY = `#!/usr/bin/env node
const fs = require('fs');
const store = process.env.FAKE_KEYCHAIN;
const items = fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, 'utf8')) : {};
const args = process.argv.slice(2);
fs.appendFileSync(store + '.log', JSON.stringify(args) + '\\n');
if (process.env.FAKE_KEYCHAIN_BROKEN) process.exit(1);
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

type Status = {
  ready: boolean;
  unlocked: boolean;
  passwordSupported: boolean;
  passwordEnabled: boolean;
  problem: string;
};

type Converted = { converted: number; left: string[]; retired: boolean };

/** What the probe's `observe` step returns. `envelopes` is alpha github,
 *  beta github, gamma github: 1 keychain, 2 vault, -1 absent. */
type Seen = {
  status: Status;
  vaultFile: boolean;
  retiredVaultFile: boolean;
  envelopes: number[];
  alpha: string;
  beta: string;
  gamma: string;
  alphaProblem: string | null;
  gammaProblem: string | null;
};

type Outcome<T = Status> = { result?: T; error?: string };

/** One runner process: run `steps` in order, get back what each observed. */
type Run = (steps: string[], extraEnv?: Record<string, string>) => unknown[];

/** The same, without waiting for it: a runner that stays alive while the test
 *  does something else in the same directory. */
type Start = (
  steps: string[],
  extraEnv: Record<string, string>
) => Promise<unknown[]>;

/** A temp runner dir with a fake keychain. `body` may start the runner in it
 *  as many times as it likes; each `run` is one process, so two runs are a
 *  restart. `home` is the temp dir, for files the test itself needs. */
async function withRunnerDir(
  body: (run: Run, start: Start, home: string) => void | Promise<void>
): Promise<void> {
  // /tmp, not os.tmpdir(): macOS's per-user tmpdir is too long for a runner
  // dir (the socket limit this dir is checked against).
  const home = fs.mkdtempSync('/tmp/rcs-');
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'security'), FAKE_SECURITY, { mode: 0o755 });
  const runnerDir = path.join(home, '.frd');
  const keychain = path.join(home, 'keychain.json');
  let broken = false;

  const argv = (steps: string[]): string[] => [
    '--import',
    'tsx',
    path.join(__dirname, 'test-fixtures/connection-storage-probe.ts'),
    ...steps
  ];
  const options = (extraEnv: Record<string, string>) => ({
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      FACTIII_RUNNER_DIR: runnerDir,
      FAKE_KEYCHAIN: keychain,
      FAKE_BIN: bin,
      ...extraEnv
    }
  });
  const results = (status: number | null, stdout: string, stderr: string) => {
    assert.equal(status, 0, stderr);
    const out = JSON.parse(stdout) as { configDir: string; results: unknown[] };
    assert.equal(out.configDir, runnerDir);
    return out.results;
  };

  const run: Run = (steps, extraEnv = {}) => {
    broken ||= Boolean(extraEnv.FAKE_KEYCHAIN_BROKEN);
    const res = spawnSync(process.execPath, argv(steps), {
      ...options(extraEnv),
      encoding: 'utf-8'
    });
    return results(res.status, res.stdout, res.stderr);
  };

  const start: Start = (steps, extraEnv) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, argv(steps), options(extraEnv));
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += String(chunk)));
      child.stderr.on('data', (chunk) => (stderr += String(chunk)));
      child.on('error', reject);
      child.on('close', (status) => {
        try {
          resolve(results(status, stdout, stderr));
        } catch (err) {
          reject(err);
        }
      });
    });

  try {
    await body(run, start, home);

    // Proof the fake was the keychain: it was called, only ever for this temp
    // runner's own account, and nothing landed in the default runner dir.
    const calls = fs
      .readFileSync(`${keychain}.log`, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as string[]);
    assert.ok(calls.length > 0, 'the fake security was never called');
    for (const args of calls) {
      assert.match(
        args[args.indexOf('-a') + 1],
        /^config-encryption-key:[0-9a-f]{12}$/
      );
    }
    assert.equal(fs.existsSync(path.join(home, '.factiii-runner')), false);
    if (broken) {
      // An unreachable keychain must never be answered by minting a new key.
      assert.ok(calls.every((args) => args[0] === 'find-generic-password'));
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** Nothing password-related is left for any client to show. */
function assertNoPassword(seen: Seen): void {
  assert.equal(seen.vaultFile, false);
  assert.equal(seen.status.passwordEnabled, false);
  assert.equal(seen.status.passwordSupported, false);
  assert.equal(seen.status.ready, true);
  assert.equal(seen.status.problem, '');
}

// macOS only: the fake stands in for `security`. Elsewhere the runner would
// reach for the host's real keyring tool, which this test must never touch.
describe('connection storage', { skip: process.platform !== 'darwin' }, () => {
  it('(a) no password ever: writes the keychain envelope and never makes a vault', async () => {
    await withRunnerDir((run) => {
      const [seeded, start, seen] = run(['seed-v1', 'start', 'observe']) as [
        { leaksToken: boolean },
        Converted,
        Seen
      ];
      assert.equal(seeded.leaksToken, false);
      assert.deepEqual(start, { converted: 0, left: [], retired: false });
      assert.deepEqual(seen.envelopes, [1, 1, -1]);
      assert.equal(seen.alpha, 'ghp_probe_alpha');
      assert.equal(seen.retiredVaultFile, false);
      assertNoPassword(seen);
    });
  });

  it('(a) no password, files from an older runner: converted at start, vault retired', async () => {
    await withRunnerDir((run) => {
      run(['seed-vault', 'seed-v2']);
      const [start, seen] = run(['start', 'observe']) as [Converted, Seen];
      assert.deepEqual(start, { converted: 2, left: [], retired: true });
      assert.deepEqual(seen.envelopes, [1, 1, -1]);
      assert.equal(seen.alpha, 'ghp_probe_alpha');
      assert.equal(seen.beta, 'ghp_probe_beta');
      assert.equal(seen.retiredVaultFile, true);
      assertNoPassword(seen);
    });
  });

  it('converts a vault-sealed file on a plain read, before any conversion pass', async () => {
    await withRunnerDir((run) => {
      run(['seed-vault', 'seed-v2']);
      const [first, second] = run(['observe', 'observe']) as [Seen, Seen];
      // The first observation looked at the envelopes, then read both.
      assert.deepEqual(first.envelopes, [2, 2, -1]);
      assert.equal(first.alpha, 'ghp_probe_alpha');
      assert.deepEqual(second.envelopes, [1, 1, -1]);
      // Reads alone do not retire the vault; the pass at start does.
      assert.equal(second.vaultFile, true);
    });
  });

  it('(b) password set, nothing in the vault: reads at once, retired at start unasked', async () => {
    await withRunnerDir((run) => {
      run(['seed-vault-password', 'seed-v1']);

      // A restart with the password never entered: everything already reads.
      const [before, start, after] = run(['observe', 'start', 'observe']) as [
        Seen,
        Converted,
        Seen
      ];
      assert.equal(before.status.passwordEnabled, true);
      assert.equal(before.status.unlocked, false);
      assert.equal(before.status.ready, true);
      assert.equal(before.status.passwordSupported, false);
      assert.equal(before.alpha, 'ghp_probe_alpha');
      assert.equal(before.alphaProblem, null);

      // Nothing was sealed under the vault key, so retiring it loses nothing.
      assert.deepEqual(start, { converted: 0, left: [], retired: true });
      assert.deepEqual(after.envelopes, [1, 1, -1]);
      assert.equal(after.alpha, 'ghp_probe_alpha');
      assert.equal(after.beta, 'ghp_probe_beta');
      assert.equal(after.retiredVaultFile, true);
      assertNoPassword(after);

      // And the restart after that has no password to speak of.
      const [again] = run(['start', 'observe']).slice(1) as [Seen];
      assert.equal(again.alpha, 'ghp_probe_alpha');
      assertNoPassword(again);
    });
  });

  it('(c) password set, vault files, locked: says locked, refuses to overwrite, keeps the vault', async () => {
    await withRunnerDir((run) => {
      run(['seed-vault-password', 'seed-v2']);
      const [start, seen, write] = run(['start', 'observe', 'write-alpha']) as [
        Converted,
        Seen,
        Outcome<void> & { untouched: boolean }
      ];
      assert.equal(start.converted, 0);
      assert.equal(start.left.length, 2);
      assert.equal(start.retired, false);

      // The one state in which a client shows an unlock box.
      assert.equal(seen.status.ready, false);
      assert.equal(seen.status.unlocked, false);
      assert.equal(seen.status.passwordEnabled, true);
      assert.equal(seen.status.passwordSupported, true);
      assert.match(
        seen.status.problem,
        /^2 saved connection files are still locked/
      );
      assert.equal(seen.vaultFile, true);
      assert.deepEqual(seen.envelopes, [2, 2, -1]);
      assert.equal(seen.alpha, '');
      assert.match(
        seen.alphaProblem ?? '',
        /locked behind your connection password/
      );

      // A save built on the empty read must not replace the locked file.
      assert.equal(write.error, 'locked');
      assert.equal(write.untouched, true);
    });
  });

  it('(d) one unlock converts every board and removes the password for good', async () => {
    await withRunnerDir((run) => {
      run(['seed-vault-password', 'seed-v2']);

      const [wrong, stillLocked, unlocked, seen] = run([
        'unlock-wrong',
        'observe',
        'unlock',
        'observe'
      ]) as [Outcome, Seen, Outcome, Seen];
      assert.equal(wrong.error, 'bad-password');
      assert.deepEqual(stillLocked.envelopes, [2, 2, -1]);
      assert.equal(stillLocked.vaultFile, true);

      // The answer to the unlock is already the password-free status.
      assert.equal(unlocked.error, undefined);
      assert.equal(unlocked.result?.ready, true);
      assert.equal(unlocked.result?.passwordEnabled, false);
      assert.equal(unlocked.result?.passwordSupported, false);
      assert.deepEqual(seen.envelopes, [1, 1, -1]);
      assert.equal(seen.retiredVaultFile, true);
      assertNoPassword(seen);

      // A restart: no password, nothing to unlock, everything reads.
      const [start, restarted, relock] = run(['start', 'observe', 'unlock']) as [
        Converted,
        Seen,
        Outcome
      ];
      assert.deepEqual(start, { converted: 0, left: [], retired: false });
      assert.equal(restarted.alpha, 'ghp_probe_alpha');
      assert.equal(restarted.beta, 'ghp_probe_beta');
      assertNoPassword(restarted);
      assert.equal(relock.error, 'no-password-set');
    });
  });

  it('(e) a vault file that will not decrypt is kept, named, and keeps the vault', async () => {
    await withRunnerDir((run) => {
      const seeded = run(['seed-vault-password', 'seed-v2', 'seed-v2-bad']);
      const original = (seeded[2] as { bytes: string }).bytes;

      const [unlocked, seen, bytes] = run([
        'unlock',
        'observe',
        'gamma-bytes'
      ]) as [Outcome, Seen, { bytes: string }];
      // The two good files converted; the bad one is exactly as it was.
      assert.equal(unlocked.error, undefined);
      assert.deepEqual(seen.envelopes, [1, 1, 2]);
      assert.equal(bytes.bytes, original);
      assert.equal(seen.alpha, 'ghp_probe_alpha');
      assert.equal(seen.gamma, '');
      assert.match(seen.gammaProblem ?? '', /cannot be decrypted/);
      // The vault is NOT retired while a file may still need it.
      assert.equal(seen.vaultFile, true);
      assert.equal(seen.retiredVaultFile, false);
      assert.equal(seen.status.passwordEnabled, true);

      // After a restart it is the locked state again, for that one file.
      const [start, locked] = run(['start', 'observe']) as [Converted, Seen];
      assert.equal(start.retired, false);
      assert.equal(start.left.length, 1);
      assert.equal(locked.status.passwordSupported, true);
      assert.match(locked.status.problem, /^1 saved connection file is still/);
      assert.equal(locked.alpha, 'ghp_probe_alpha');

      // Reconnecting that board replaces the file, and the vault can go.
      const [, reconnect, retire, done] = run([
        'unlock',
        'reconnect-gamma',
        'start',
        'observe'
      ]) as [Outcome, Outcome<void>, Converted, Seen];
      assert.equal(reconnect.error, undefined);
      assert.deepEqual(retire, { converted: 0, left: [], retired: true });
      assert.equal(done.gamma, 'ghp_probe_gamma');
      assert.deepEqual(done.envelopes, [1, 1, 1]);
      assertNoPassword(done);
    });
  });

  it('a running runner sees an unlock done by another process', async () => {
    await withRunnerDir(async (run, start, home) => {
      run(['seed-vault-password', 'seed-v2']);
      const ready = path.join(home, 'ready');
      const go = path.join(home, 'go');

      // The daemon: looks, then stays alive, then looks again.
      const daemon = start(
        ['observe', 'signal-ready', 'wait-for-go', 'observe'],
        { PROBE_READY_FILE: ready, PROBE_GO_FILE: go }
      );
      while (!fs.existsSync(ready)) {
        await new Promise((r) => setTimeout(r, 50));
      }

      // `factiii-runner password` in a second process, while it is locked.
      const [unlocked] = run(['unlock']) as [Outcome];
      assert.equal(unlocked.error, undefined);
      fs.writeFileSync(go, '');

      const [before, , , after] = (await daemon) as [Seen, unknown, unknown, Seen];
      assert.equal(before.status.ready, false);
      assert.equal(before.status.passwordSupported, true);
      assert.equal(before.alpha, '');
      // Same process, nothing typed into it: ready, readable, no password.
      assert.equal(after.alpha, 'ghp_probe_alpha');
      assert.equal(after.beta, 'ghp_probe_beta');
      assertNoPassword(after);
    });
  });

  it('seals a plaintext legacy file under the keychain key, not the vault, and deletes an old OneDrive connection', async () => {
    await withRunnerDir((run) => {
      const [out] = run(['plaintext-legacy']) as [
        {
          token: string;
          github: number;
          onedrive: number;
          vaultFile: boolean;
        }
      ];
      assert.equal(out.token, 'ghp_probe_alpha');
      assert.equal(out.github, 1);
      // The removed runner OneDrive index's file: nothing reads it, so it goes.
      assert.equal(out.onedrive, -1);
      assert.equal(out.vaultFile, false);
    });
  });

  it('keeps the old file and the vault when the conversion write fails', async () => {
    await withRunnerDir((run) => {
      const [, out] = run(['seed-vault', 'conversion-write-fails']) as [
        unknown,
        {
          whileReadOnly: {
            token: string;
            failed: Converted;
            untouched: boolean;
            dirListing: string[];
            vaultFile: boolean;
          };
          retried: Converted;
          envelope: number;
          token: string;
        }
      ];
      // The read still answers; the file is byte-identical; no temp file is
      // left; and the vault it still needs is not retired.
      assert.equal(out.whileReadOnly.token, 'ghp_probe_alpha');
      assert.equal(out.whileReadOnly.failed.converted, 0);
      assert.equal(out.whileReadOnly.failed.left.length, 1);
      assert.equal(out.whileReadOnly.failed.retired, false);
      assert.equal(out.whileReadOnly.untouched, true);
      assert.deepEqual(out.whileReadOnly.dirListing, ['github.json']);
      assert.equal(out.whileReadOnly.vaultFile, true);
      // And it converts once the directory is writable again.
      assert.deepEqual(out.retried, { converted: 1, left: [], retired: true });
      assert.equal(out.envelope, 1);
      assert.equal(out.token, 'ghp_probe_alpha');
    });
  });

  for (const locked of [false, true]) {
    it(`leaves config.json readable after the plaintext sweep${locked ? ' (password set, locked)' : ''}`, async () => {
      await withRunnerDir((run) => {
        const out = run([...(locked ? ['seed-vault-password'] : []), 'sweep']).at(
          -1
        ) as {
          configEnvelope: number;
          pairing: { authToken: string } | null;
          oldToken: string;
          legacyGone: boolean;
          oldEnvelope: number;
        };
        assert.equal(out.configEnvelope, 1);
        assert.equal(out.pairing?.authToken, 'fake.pairing.token');
        // The superseded per-board store is folded into the board, sealed.
        assert.equal(out.oldToken, 'ghp_probe_alpha');
        assert.equal(out.legacyGone, true);
        assert.equal(out.oldEnvelope, 1);
      });
    });
  }

  it('recovers a pairing config the old sweep sealed in the vault, before retiring it', async () => {
    await withRunnerDir((run) => {
      run(['seed-vault', 'seed-v2-pairing']);
      const [broken, start, fixed] = run(['pairing', 'start', 'pairing']) as [
        { pairing: unknown },
        Converted,
        { pairing: { authToken: string } | null }
      ];
      assert.equal(broken.pairing, null);
      assert.deepEqual(start, { converted: 1, left: [], retired: true });
      assert.equal(fixed.pairing?.authToken, 'fake.pairing.token');
    });
  });

  it('refuses to read or write connections without a keychain', async () => {
    await withRunnerDir((run) => {
      const [out] = run(['no-keychain'], { FAKE_KEYCHAIN_BROKEN: '1' }) as [
        {
          status: Status;
          token: string;
          problem: string | null;
          unconfiguredProblem: string | null;
          write: Outcome<void>;
          betaWritten: boolean;
          untouched: boolean;
        }
      ];
      assert.equal(out.status.ready, false);
      assert.equal(out.status.passwordSupported, false);
      assert.match(
        out.status.problem,
        /^Credentials cannot be stored on this machine/
      );
      // The plaintext file is neither handed back nor rewritten.
      assert.equal(out.token, '');
      assert.match(out.problem ?? '', /no usable keychain/);
      assert.equal(out.untouched, true);
      assert.equal(out.unconfiguredProblem, null);
      assert.equal(out.write.error, 'no-keychain');
      assert.equal(out.betaWritten, false);
    });
  });
});
