import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { checkForAutoUpdate, type AutoUpdateDeps } from './autoUpdate';
import type { RunnerUpdateResult } from '@shared/all/domains/runnerAutoUpdate';

import {
  cancelPendingUpdate,
  decideAfterWorkerExit,
  failedUpdates,
  hasFailed,
  markUpdateHealthy,
  type NpmRun,
  prepareRollback,
  readAutoUpdateState,
  readLastSkip,
  readLastUpdate,
  readPendingUpdate,
  readUpdateSettings,
  recordLastUpdate,
  rollBack,
  setAutoUpdate,
  writeUpdateSettings
} from './updateSafety';

// .specs/runner-setup.md "Updates": on by default, a copy to go back to, and
// a rollback when the new version fails to start. npm is faked; nothing here
// needs macOS.

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'runner-update-'));

/** npm that "packs" by writing the tarball and records what it was asked. */
const fakeNpm = (version: string, ok = true) => {
  const calls: string[][] = [];
  const npm: NpmRun = (args) => {
    calls.push(args);
    if (!ok) return false;
    if (args[0] === 'pack') {
      const dest = args[args.indexOf('--pack-destination') + 1]!;
      fs.writeFileSync(path.join(dest, `factiii-runner-${version}.tgz`), 'tgz');
    }
    return true;
  };
  return { npm, calls };
};

describe('update settings', () => {
  it('are on by default, and off when the owner says so or the env forces it', () => {
    const dir = tmp();
    assert.equal(readUpdateSettings(dir, {}).auto, true);
    writeUpdateSettings(dir, { auto: false });
    assert.equal(readUpdateSettings(dir, {}).auto, false);
    writeUpdateSettings(dir, { auto: true });
    assert.equal(readUpdateSettings(dir, { FACTIII_RUNNER_AUTO_UPDATE: 'off' }).auto, false);
  });
});

describe('autoUpdateGet / autoUpdateSet', () => {
  it('reads on by default with no outcome yet, and the switch writes what the CLI writes', () => {
    const dir = tmp();
    assert.deepEqual(readAutoUpdateState(dir, {}), {
      auto: true,
      forcedByEnv: false,
      bundled: false,
      lastResult: null,
      lastSkip: null
    });
    assert.equal(setAutoUpdate(dir, false, {}).auto, false);
    assert.equal(readUpdateSettings(dir, {}).auto, false);
    assert.equal(setAutoUpdate(dir, true, {}).auto, true);
    assert.equal(readUpdateSettings(dir, {}).auto, true);
  });

  it('says the env forces it off, and refuses the switch then', () => {
    const dir = tmp();
    const env = { FACTIII_RUNNER_AUTO_UPDATE: '0' };
    const state = readAutoUpdateState(dir, env);
    assert.equal(state.auto, false);
    assert.equal(state.forcedByEnv, true);
    assert.throws(() => setAutoUpdate(dir, true, env), /FACTIII_RUNNER_AUTO_UPDATE/);
    // Nothing was saved: without the env it is still on.
    assert.equal(readUpdateSettings(dir, {}).auto, true);
  });

  it('is off and locked on the runner Factiii Desktop carries', () => {
    const dir = tmp();
    const env = { FACTIII_BUNDLED_RUNNER: '1' };
    const state = readAutoUpdateState(dir, env);
    assert.equal(state.auto, false);
    assert.equal(state.bundled, true);
    assert.throws(() => setAutoUpdate(dir, true, env), /Factiii Desktop/);
  });
});

describe('the last outcome', () => {
  it('records an update as installed once the new version is up', () => {
    const dir = tmp();
    prepareRollback(dir, '0.42.0', null, fakeNpm('0.42.0').npm);
    assert.equal(markUpdateHealthy(dir, '1.0.0', 7), true);
    assert.deepEqual(readLastUpdate(dir), {
      kind: 'installed',
      version: '1.0.0',
      from: '0.42.0',
      at: 7
    });
    // A start with nothing pending changes nothing.
    assert.equal(markUpdateHealthy(dir, '1.0.0', 8), false);
    assert.equal(readLastUpdate(dir)?.at, 7);
  });

  it('records a rollback once the old version is back, not when it could not go back', () => {
    const dir = tmp();
    const { npm } = fakeNpm('0.42.0');
    const pending = prepareRollback(dir, '0.42.0', '/pkg', npm);
    rollBack(dir, pending, '1.0.0', 'exited 1 before it was up', npm, 9);
    assert.deepEqual(readLastUpdate(dir), {
      kind: 'rolled-back',
      version: '1.0.0',
      from: '0.42.0',
      at: 9,
      reason: 'exited 1 before it was up'
    });
    const other = tmp();
    rollBack(other, { from: '0.42.0', at: 1, tarball: null }, '1.0.0', 'crash', npm);
    assert.equal(readLastUpdate(other), null);
  });

  it('reads back what was written, and nothing from a file that is not one', () => {
    const dir = tmp();
    const skipped: RunnerUpdateResult = { kind: 'skipped', version: '1.0.0', reason: 'busy', at: 3 };
    recordLastUpdate(dir, skipped);
    assert.deepEqual(readAutoUpdateState(dir, {}).lastSkip, skipped);
    fs.writeFileSync(path.join(dir, 'updates/last.json'), '{"kind":"nope"}');
    assert.equal(readLastUpdate(dir), null);
  });

  it('keeps the last install or rollback when later looks skip a release', () => {
    const dir = tmp();
    const { npm } = fakeNpm('0.42.0');
    const pending = prepareRollback(dir, '0.42.0', '/pkg', npm);
    rollBack(dir, pending, '1.0.0', 'exited 1 before it was up', npm, 9);
    const off: RunnerUpdateResult = { kind: 'skipped', version: '1.1.0', reason: 'off', at: 10 };
    recordLastUpdate(dir, off);
    recordLastUpdate(dir, { ...off, reason: 'busy', at: 11 });
    const state = readAutoUpdateState(dir, {});
    assert.equal(state.lastResult?.kind, 'rolled-back');
    assert.deepEqual(state.lastSkip, { ...off, reason: 'busy', at: 11 });
  });

  it('reads a skip an older runner left in last.json as the last skip', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'updates'));
    const old: RunnerUpdateResult = { kind: 'skipped', version: '1.0.0', reason: 'off', at: 3 };
    fs.writeFileSync(path.join(dir, 'updates/last.json'), JSON.stringify(old));
    assert.equal(readLastUpdate(dir), null);
    assert.deepEqual(readLastSkip(dir), old);
  });
});

describe('prepareRollback', () => {
  it('packs the running version and copies the runner folder’s own files', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'spaces.json'), '{"1":"a"}');
    fs.mkdirSync(path.join(dir, 'board-a'));
    const { npm, calls } = fakeNpm('0.42.0');
    const pending = prepareRollback(dir, '0.42.0', '/pkg', npm, 5);
    assert.equal(pending.from, '0.42.0');
    assert.ok(pending.tarball?.endsWith('factiii-runner-0.42.0.tgz'));
    assert.deepEqual(calls[0]?.slice(0, 2), ['pack', '--ignore-scripts']);
    assert.ok(fs.existsSync(path.join(dir, 'updates/previous/state/spaces.json')));
    assert.ok(!fs.existsSync(path.join(dir, 'updates/previous/state/board-a')));
    assert.deepEqual(readPendingUpdate(dir), pending);
  });

  it('never copies the token or a key, and the copy goes once the update is up', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'spaces.json'), '{}');
    fs.writeFileSync(path.join(dir, 'config.json'), 'token');
    fs.writeFileSync(path.join(dir, 'runner-cloud.key'), 'key');
    prepareRollback(dir, '0.42.0', '/pkg', fakeNpm('0.42.0').npm);
    const state = path.join(dir, 'updates/previous/state');
    assert.deepEqual(fs.readdirSync(state), ['spaces.json']);
    assert.equal(markUpdateHealthy(dir, '1.0.0'), true);
    assert.equal(fs.existsSync(path.join(dir, 'updates/previous')), false);
    // The runner's own files stay where they are.
    assert.equal(fs.readFileSync(path.join(dir, 'runner-cloud.key'), 'utf-8'), 'key');
  });

  it('has no tarball on a source run or when npm fails', () => {
    const dir = tmp();
    assert.equal(prepareRollback(dir, '0.42.0', null, fakeNpm('0.42.0').npm).tarball, null);
    assert.equal(prepareRollback(dir, '0.42.0', '/pkg', fakeNpm('0.42.0', false).npm).tarball, null);
  });

  it('a cancelled or healthy update leaves nothing pending', () => {
    const dir = tmp();
    prepareRollback(dir, '0.42.0', null, fakeNpm('0.42.0').npm);
    cancelPendingUpdate(dir);
    assert.equal(readPendingUpdate(dir), null);
    prepareRollback(dir, '0.42.0', null, fakeNpm('0.42.0').npm);
    assert.equal(markUpdateHealthy(dir), true);
    assert.equal(markUpdateHealthy(dir), false);
  });
});

describe('decideAfterWorkerExit', () => {
  const pending = { from: '0.42.0', at: 1, tarball: '/x.tgz' };
  it('relaunches on the update code, rolls back a failed start, else exits', () => {
    assert.equal(decideAfterWorkerExit({ restartForUpdate: true, exitCode: 75, pending }), 'relaunch');
    assert.equal(decideAfterWorkerExit({ restartForUpdate: false, exitCode: 1, pending }), 'rollback');
    assert.equal(decideAfterWorkerExit({ restartForUpdate: false, exitCode: 0, pending }), 'exit');
    assert.equal(decideAfterWorkerExit({ restartForUpdate: false, exitCode: 1, pending: null }), 'exit');
  });
});

describe('rollBack', () => {
  it('reinstalls the old version, restores files but the token, and skips the failed one', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'spaces.json'), 'old');
    fs.writeFileSync(path.join(dir, 'config.json'), 'old-token');
    const { npm, calls } = fakeNpm('0.42.0');
    const pending = prepareRollback(dir, '0.42.0', '/pkg', npm);
    // The new version rewrote both, and rotated the token.
    fs.writeFileSync(path.join(dir, 'spaces.json'), 'new');
    fs.writeFileSync(path.join(dir, 'config.json'), 'new-token');
    assert.equal(rollBack(dir, pending, '1.0.0', 'exited 1 before it was up', npm, 9), true);
    assert.deepEqual(calls.at(-1), ['install', '-g', pending.tarball]);
    assert.equal(fs.readFileSync(path.join(dir, 'spaces.json'), 'utf-8'), 'old');
    assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'), 'new-token');
    assert.equal(hasFailed(dir, '1.0.0'), true);
    assert.equal(failedUpdates(dir)[0]?.reason, 'exited 1 before it was up');
    assert.equal(readPendingUpdate(dir), null);
    // Once the old version is back, its copy is not needed.
    assert.equal(fs.existsSync(path.join(dir, 'updates/previous')), false);
  });

  it('says it could not when there is no copy, and still records the failure', () => {
    const dir = tmp();
    const ok = rollBack(dir, { from: '0.42.0', at: 1, tarball: null }, '1.0.0', 'crash', fakeNpm('0').npm);
    assert.equal(ok, false);
    assert.equal(hasFailed(dir, '1.0.0'), true);
  });
});

describe('checkForAutoUpdate', () => {
  const deps = (over: Partial<AutoUpdateDeps> = {}) => {
    const applied: string[] = [];
    const d: AutoUpdateDeps = {
      enabled: () => true,
      busy: () => false,
      latest: async () => '1.0.0',
      failed: () => false,
      apply: async (v) => {
        applied.push(v);
      },
      log: () => {},
      ...over
    };
    return { d, applied };
  };

  it('updates when on, idle and something newer is out', async () => {
    const { d, applied } = deps();
    assert.equal(await checkForAutoUpdate(d), 'updating');
    assert.deepEqual(applied, ['1.0.0']);
  });

  it('records why a release it found was not installed', async () => {
    const run = async (over: Partial<AutoUpdateDeps>) => {
      const recorded: RunnerUpdateResult[] = [];
      const { d, applied } = deps({ ...over, record: (r) => recorded.push(r), now: () => 5 });
      const outcome = await checkForAutoUpdate(d);
      return { outcome, recorded, applied };
    };
    const off = await run({ enabled: () => false });
    assert.equal(off.outcome, 'off');
    assert.deepEqual(off.recorded, [{ kind: 'skipped', version: '1.0.0', reason: 'off', at: 5 }]);
    const busy = await run({ busy: () => true });
    assert.equal(busy.outcome, 'busy');
    assert.equal(busy.recorded[0]?.kind === 'skipped' && busy.recorded[0].reason, 'busy');
    const failed = await run({ failed: () => true });
    assert.equal(failed.recorded[0]?.kind === 'skipped' && failed.recorded[0].reason, 'failed-before');
    // Up to date, or updating: nothing to say yet (the new version records
    // itself once it is up).
    assert.deepEqual((await run({ latest: async () => null })).recorded, []);
    const updating = await run({});
    assert.equal(updating.outcome, 'updating');
    assert.deepEqual(updating.recorded, []);
  });

  it('does not look when off with nothing to record', async () => {
    let looked = false;
    const { d } = deps({
      enabled: () => false,
      latest: async () => {
        looked = true;
        return '1.0.0';
      }
    });
    assert.equal(await checkForAutoUpdate(d), 'off');
    assert.equal(looked, false);
  });

  it('does nothing when off, busy, up to date, or on a version that failed here', async () => {
    assert.equal(await checkForAutoUpdate(deps({ enabled: () => false }).d), 'off');
    assert.equal(await checkForAutoUpdate(deps({ busy: () => true }).d), 'busy');
    assert.equal(await checkForAutoUpdate(deps({ latest: async () => null }).d), 'none');
    const { d, applied } = deps({ failed: () => true });
    assert.equal(await checkForAutoUpdate(d), 'skipped-failed');
    assert.deepEqual(applied, []);
  });
});
