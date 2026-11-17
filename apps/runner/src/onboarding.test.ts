import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { StartArgs } from '@shared/all/helpers/board-agent-core/session-hypervisor';
import {
  ONBOARDING_MESSAGE,
  onboardingPending,
  readOnboardingStarted,
  requestOnboarding
} from '@shared/all/helpers/runnerOnboarding';

import {
  createOnboardingStarter,
  type OnboardingBoard,
  type ProfileBoardRef,
  watchOnboardingRequest
} from './onboarding';

// The first session after Factiii Desktop's setup (card d26fbbbb step 4).

const owner = { userId: '7', name: 'Jo', role: 'owner' as const };

function setup(profile: ProfileBoardRef | null = { id: 70, slug: 'profile-7' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-'));
  const lines: string[] = [];
  const started: StartArgs[] = [];
  const boards: ProfileBoardRef[] = [];
  let fail: Error | null = null;
  let answer = profile;
  const board: OnboardingBoard = {
    start: async (args) => {
      if (fail) throw fail;
      started.push(args);
      return `bare-${started.length}`;
    },
    audit: async () => undefined
  };
  const start = createOnboardingStarter({
    runnerDir: dir,
    profileBoard: async () => answer,
    board: (ref) => {
      boards.push(ref);
      return board;
    },
    owner: () => owner,
    log: (line) => lines.push(line)
  });
  return {
    dir,
    lines,
    started,
    boards,
    start,
    failNext: (err: Error | null) => {
      fail = err;
    },
    answer: (next: ProfileBoardRef | null) => {
      answer = next;
    }
  };
}

describe('onboarding session', () => {
  it('starts nothing until the Desktop asks', async () => {
    const t = setup();
    assert.equal(await t.start(), null);
    assert.equal(t.started.length, 0);
    assert.equal(t.boards.length, 0);
  });

  it('starts one Chat session with the skill, for the owner, once', async () => {
    const t = setup();
    assert.equal(requestOnboarding(t.dir), 'requested');
    assert.equal(await t.start(), 'bare-1');
    assert.equal(await t.start(), null);
    assert.equal(t.started.length, 1);
    assert.equal(t.started[0]!.code, false);
    assert.equal(t.started[0]!.message, ONBOARDING_MESSAGE);
    assert.match(ONBOARDING_MESSAGE, /runner-onboarding skill/);
    assert.deepEqual(t.started[0]!.startedBy, owner);
    assert.deepEqual(
      { ...readOnboardingStarted(t.dir), at: '' },
      { spaceSlug: 'profile-7', postId: 'bare-1', at: '' }
    );
    assert.equal(onboardingPending(t.dir), false);
    // Asked again (Setup run twice): it already ran.
    assert.equal(requestOnboarding(t.dir), 'started');
  });

  it('starts on the profile board the server names, with no board opened', async () => {
    const t = setup();
    requestOnboarding(t.dir);
    assert.equal(await t.start(), 'bare-1');
    assert.deepEqual(t.boards, [{ id: 70, slug: 'profile-7' }]);
  });

  it('waits while the server cannot name the profile board', async () => {
    const t = setup(null);
    requestOnboarding(t.dir);
    assert.equal(await t.start(), null);
    assert.equal(onboardingPending(t.dir), true);
    assert.equal(t.started.length, 0);
    t.answer({ id: 70, slug: 'profile-7' });
    assert.equal(await t.start(), 'bare-1');
  });

  it('sees the Desktop ask while the runner is online, and a Retry ask again', async () => {
    const t = setup();
    let seen = 0;
    const stop = watchOnboardingRequest(t.dir, () => {
      seen += 1;
    });
    try {
      // fs.watch arms asynchronously (FSEvents on macOS), and a write made
      // before it is armed is never reported. Under a loaded machine (the
      // whole suite in parallel) that gap outlasted the 10 s wait. The Desktop
      // writes long after the runner started watching, so the test writes
      // again every half second until the watch reports one.
      const until = Date.now() + 10_000;
      let nextWrite = 0;
      while (seen === 0 && Date.now() < until) {
        if (Date.now() >= nextWrite) {
          requestOnboarding(t.dir);
          nextWrite = Date.now() + 500;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(seen > 0, 'the watch saw the request');
    } finally {
      stop();
    }
    // Retry rewrites the request, so the watch fires again.
    const read = () => fs.readFileSync(path.join(t.dir, 'onboarding.json'), 'utf-8');
    const before = read();
    requestOnboarding(t.dir, new Date('2030-01-01T00:00:00Z'));
    assert.notEqual(read(), before);
  });

  it('never starts a second session when the first could not be recorded', async () => {
    const t = setup();
    requestOnboarding(t.dir);
    // The started file's temp path is taken, so writing the record throws.
    fs.mkdirSync(path.join(t.dir, `onboarding-started.json.${process.pid}.tmp`));
    assert.equal(await t.start(), 'bare-1');
    assert.match(t.lines.join('\n'), /started session bare-1 on profile-7, but could not record it/);
    // The request is gone, so neither the next connect nor a restart asks again.
    assert.equal(onboardingPending(t.dir), false);
    requestOnboarding(t.dir);
    assert.equal(await t.start(), null);
    assert.equal(t.started.length, 1);
  });

  it('keeps the request when the start fails, for the next try', async () => {
    const t = setup();
    requestOnboarding(t.dir);
    t.failNext(new Error('no workspace yet'));
    assert.equal(await t.start(), null);
    assert.equal(onboardingPending(t.dir), true);
    assert.match(t.lines.join('\n'), /no workspace yet/);
    t.failNext(null);
    assert.equal(await t.start(), 'bare-1');
  });

  it('never starts two at once', async () => {
    const t = setup();
    requestOnboarding(t.dir);
    const [a, b] = await Promise.all([t.start(), t.start()]);
    assert.deepEqual([a, b].filter(Boolean), ['bare-1']);
  });
});
