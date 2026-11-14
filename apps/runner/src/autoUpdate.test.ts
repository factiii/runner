import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AUTO_UPDATE_ANNOUNCED_SPREAD_MS,
  AUTO_UPDATE_BUSY_RETRY_MS,
  AUTO_UPDATE_EVERY_MS,
  AUTO_UPDATE_FIRST_CHECK_MS,
  type AutoUpdateDeps,
  startAutoUpdate
} from './autoUpdate';

// The automatic update's schedule: a look after start, one within the minute
// of an announced release (`runner:release`), and the daily fallback. The
// timers are the test's: each one set is recorded and fired by hand.

type Timer = { fn: () => void; ms: number; cleared: boolean; unref?: () => void };

function harness(over: Partial<AutoUpdateDeps> = {}) {
  const timers: Timer[] = [];
  let looks = 0;
  let release: (() => void) | null = null;
  const deps: AutoUpdateDeps = {
    enabled: () => true,
    busy: () => false,
    latest: async () => {
      looks += 1;
      return null;
    },
    failed: () => false,
    apply: async () => undefined,
    log: () => undefined,
    setTimer: (fn, ms) => {
      const t: Timer = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      (t as Timer).cleared = true;
    },
    random: () => 0.5,
    ...over
  };
  const live = () => timers.filter((t) => !t.cleared);
  /** Fire the one live timer and let its look finish. */
  const fire = async () => {
    const [t] = live();
    assert.ok(t, 'a timer is set');
    t.cleared = true;
    t.fn();
    await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    deps,
    timers,
    live,
    fire,
    looks: () => looks,
    hold: () => new Promise<void>((resolve) => (release = resolve)),
    release: () => release?.()
  };
}

describe('the automatic update schedule', () => {
  it('looks after start, then once a day', async () => {
    const h = harness();
    startAutoUpdate(h.deps);
    assert.deepEqual(h.live().map((t) => t.ms), [AUTO_UPDATE_FIRST_CHECK_MS]);
    await h.fire();
    assert.equal(h.looks(), 1);
    assert.deepEqual(h.live().map((t) => t.ms), [AUTO_UPDATE_EVERY_MS]);
  });

  it('looks within the minute of an announced release, then goes back to daily', async () => {
    const h = harness();
    const auto = startAutoUpdate(h.deps);
    auto.soon();
    // The look after start is replaced, not added to.
    assert.deepEqual(h.live().map((t) => t.ms), [AUTO_UPDATE_ANNOUNCED_SPREAD_MS / 2]);
    await h.fire();
    assert.equal(h.looks(), 1);
    assert.deepEqual(h.live().map((t) => t.ms), [AUTO_UPDATE_EVERY_MS]);
  });

  it('looks again after a look that was under way when the release was announced', async () => {
    const h = harness();
    const gate = h.hold();
    h.deps.latest = async () => {
      await gate;
      return null;
    };
    const auto = startAutoUpdate(h.deps);
    const [first] = h.live();
    first!.cleared = true;
    first!.fn();
    // Under way: it may have read the release list before the release.
    auto.soon();
    assert.equal(h.live().length, 0);
    h.release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(h.live().map((t) => t.ms), [AUTO_UPDATE_ANNOUNCED_SPREAD_MS / 2]);
  });

  it('a busy runner keeps its busy retry', async () => {
    const h = harness({ busy: () => true, latest: async () => '9.9.9' });
    const auto = startAutoUpdate(h.deps);
    auto.soon();
    await h.fire();
    assert.deepEqual(h.live().map((t) => t.ms), [AUTO_UPDATE_BUSY_RETRY_MS]);
  });

  it('a stopped schedule hears nothing', () => {
    const h = harness();
    const auto = startAutoUpdate(h.deps);
    auto.stop();
    auto.soon();
    assert.equal(h.live().length, 0);
  });
});
