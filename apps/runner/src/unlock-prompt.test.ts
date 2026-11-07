import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { isRelaunchAfterUpdate, markWorkerEnv } from './selfUpdate';
import {
  isFirstStartOfVersion,
  shouldPromptForUnlock,
  watchForUnlock
} from './unlockPrompt';

describe('the unlock prompt at start', () => {
  it('asks a person at a terminal, and only when files are locked', () => {
    const person = { isTTY: true, relaunchedAfterUpdate: false };
    assert.equal(shouldPromptForUnlock({ ...person, needsUnlock: true }), true);
    assert.equal(shouldPromptForUnlock({ ...person, needsUnlock: false }), false);
  });

  it('never asks without a terminal', () => {
    assert.equal(
      shouldPromptForUnlock({
        needsUnlock: true,
        isTTY: false,
        relaunchedAfterUpdate: false
      }),
      false
    );
  });

  it('never blocks a relaunch after an update, terminal or not', () => {
    for (const isTTY of [true, false]) {
      assert.equal(
        shouldPromptForUnlock({
          needsUnlock: true,
          isTTY,
          relaunchedAfterUpdate: true
        }),
        false
      );
    }
  });
});

describe('the relaunch mark', () => {
  it('is absent on the launch a person started', () => {
    const env = markWorkerEnv({ PATH: '/bin' });
    assert.equal(isRelaunchAfterUpdate(env), false);
    assert.equal(env.PATH, '/bin');
  });

  it('is set on the relaunch after an update', () => {
    assert.equal(isRelaunchAfterUpdate(markWorkerEnv({}, true)), true);
  });

  it('is cleared rather than inherited by a later plain launch', () => {
    const relaunched = markWorkerEnv({}, true);
    assert.equal(isRelaunchAfterUpdate(markWorkerEnv(relaunched)), false);
  });
});

describe('the first start of a version', () => {
  it('is true once per version, including the update an old supervisor relaunches', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-version-'));
    try {
      // Nothing recorded: the update that brings this code in.
      assert.equal(isFirstStartOfVersion(dir, '0.22.0'), true);
      // A person restarting the same version later is asked at the terminal.
      assert.equal(isFirstStartOfVersion(dir, '0.22.0'), false);
      assert.equal(isFirstStartOfVersion(dir, '0.23.0'), true);
      assert.equal(isFirstStartOfVersion(dir, '0.23.0'), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stays true when the version cannot be recorded', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-version-'));
    try {
      fs.chmodSync(dir, 0o500);
      assert.equal(isFirstStartOfVersion(dir, '0.22.0'), true);
      assert.equal(isFirstStartOfVersion(dir, '0.22.0'), true);
    } finally {
      fs.chmodSync(dir, 0o700);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('watching for an unlock done elsewhere', () => {
  it('fires once when the lock goes, then stops checking', async () => {
    let locked = true;
    let checks = 0;
    let fired = 0;
    watchForUnlock(
      () => {
        checks += 1;
        return locked;
      },
      () => {
        fired += 1;
      },
      5
    );
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(fired, 0);
    assert.ok(checks > 0);

    locked = false;
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(fired, 1);
    const after = checks;
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(checks, after);
  });
});
