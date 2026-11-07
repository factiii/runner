import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  AUTO_GRACE_MS,
  AUTO_POLL_MS,
  type Caffeinate,
  type Every,
  KeepAwake,
  parsePmsetBatt,
  type RunnerPower
} from './keepAwake';

const NOW = Date.UTC(2026, 9, 24, 20);
const HOUR = 3_600_000;

function fake() {
  const runs: { args: string[]; exit: () => void; stopped: boolean }[] = [];
  const caffeinate: Caffeinate = (args, onExit) => {
    const run = { args, exit: onExit, stopped: false };
    runs.push(run);
    return () => {
      run.stopped = true;
    };
  };
  return { runs, caffeinate };
}

const tmpFile = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'keepawake-')), 'k.json');

describe('keep-awake', () => {
  it('holds until a time, then is off by itself', () => {
    const { runs, caffeinate } = fake();
    const keep = new KeepAwake(tmpFile(), { caffeinate, now: () => NOW, platform: 'darwin' });
    const state = keep.set({ on: true, until: NOW + 2 * HOUR, display: true });
    assert.deepEqual(state, { on: true, until: NOW + 2 * HOUR, display: true });
    assert.deepEqual(runs[0].args, ['-i', '-s', '-w', String(process.pid), '-d', '-t', '7200']);
    runs[0].exit();
    assert.equal(keep.state().on, false);
  });

  it('until turned off has no -t, and off stops it', () => {
    const { runs, caffeinate } = fake();
    const keep = new KeepAwake(tmpFile(), { caffeinate, now: () => NOW, platform: 'darwin' });
    keep.set({ on: true, until: null });
    assert.equal(runs[0].args.includes('-t'), false);
    keep.set({ on: false, until: null });
    assert.equal(runs[0].stopped, true);
    // The stopped one's exit does not touch the new state.
    keep.set({ on: true, until: null });
    runs[0].exit();
    assert.equal(keep.state().on, true);
  });

  it('refuses a past or far-off time, and off a Mac', () => {
    const { caffeinate } = fake();
    const keep = new KeepAwake(tmpFile(), { caffeinate, now: () => NOW, platform: 'darwin' });
    assert.throws(() => keep.set({ on: true, until: NOW - 1 }), /passed/);
    assert.throws(() => keep.set({ on: true, until: NOW + 40 * 24 * HOUR }), /30 days/);
    const linux = new KeepAwake(tmpFile(), { caffeinate, now: () => NOW, platform: 'linux' });
    assert.throws(() => linux.set({ on: true, until: null }), /Mac/);
  });

  it('a restarted runner takes it back up, unless its time has passed', () => {
    const file = tmpFile();
    const first = fake();
    new KeepAwake(file, {
      caffeinate: first.caffeinate,
      now: () => NOW,
      platform: 'darwin'
    }).set({
      on: true,
      until: NOW + HOUR
    });
    const second = fake();
    const again = new KeepAwake(file, {
      caffeinate: second.caffeinate,
      now: () => NOW + HOUR / 2,
      platform: 'darwin'
    });
    assert.equal(again.state().on, true);
    assert.equal(second.runs[0].args.at(-1), '1800');
    const late = fake();
    new KeepAwake(file, {
      caffeinate: late.caffeinate,
      now: () => NOW + 2 * HOUR,
      platform: 'darwin'
    });
    assert.equal(late.runs.length, 0);
  });

  describe('automatic', () => {
    /** A runner with work you set, a clock you move, and a timer you see. */
    function auto(file = tmpFile()) {
      const { runs, caffeinate } = fake();
      const work = { sessions: 0, jobs: 0 };
      const clock = { at: NOW };
      const timers: { ms: number; cancelled: boolean }[] = [];
      const every: Every = (_fn, ms) => {
        const timer = { ms, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      };
      const keep = new KeepAwake(file, {
        caffeinate,
        now: () => clock.at,
        platform: 'darwin',
        work: () => work,
        every
      });
      const live = () => runs.filter((r) => !r.stopped);
      return { keep, runs, live, work, clock, timers, file };
    }

    it('holds while work runs, with no time limit', () => {
      const a = auto();
      a.work.sessions = 2;
      const state = a.keep.set({ on: true, until: null, auto: true });
      assert.equal(state.auto, true);
      assert.deepEqual(state.work, {
        sessions: 2,
        jobs: 0,
        holding: true,
        releaseAt: null
      });
      assert.equal(a.live().length, 1);
      assert.equal(a.live()[0].args.includes('-t'), false);
      assert.equal(a.timers[0].ms, AUTO_POLL_MS);
    });

    it('idle at the start holds nothing', () => {
      const a = auto();
      const state = a.keep.set({ on: true, until: null, auto: true });
      assert.equal(state.on, true);
      assert.equal(state.work?.holding, false);
      assert.equal(a.runs.length, 0);
    });

    it('lets go a grace period after the work stops, then takes it back', () => {
      const a = auto();
      a.work.jobs = 1;
      a.keep.set({ on: true, until: null, auto: true });
      a.work.jobs = 0;
      a.clock.at += AUTO_POLL_MS;
      a.keep.tick();
      // Still in the grace: holding, and says when it lets go.
      assert.equal(a.live().length, 1);
      assert.equal(a.keep.state().work?.releaseAt, NOW + AUTO_GRACE_MS);
      a.clock.at = NOW + AUTO_GRACE_MS;
      a.keep.tick();
      assert.equal(a.live().length, 0);
      assert.equal(a.keep.state().work?.holding, false);
      assert.equal(a.keep.state().on, true);
      // Work again: a new hold.
      a.work.sessions = 1;
      a.clock.at += AUTO_POLL_MS;
      a.keep.tick();
      assert.equal(a.live().length, 1);
      assert.equal(a.runs.length, 2);
    });

    it('work in the grace resets it', () => {
      const a = auto();
      a.work.sessions = 1;
      a.keep.set({ on: true, until: null, auto: true });
      a.work.sessions = 0;
      a.clock.at = NOW + AUTO_GRACE_MS - 1;
      a.work.sessions = 1;
      a.keep.tick();
      a.work.sessions = 0;
      a.clock.at = NOW + AUTO_GRACE_MS + 1;
      a.keep.tick();
      assert.equal(a.live().length, 1);
    });

    it('a hold that dies leaves automatic on, and the next look takes it again', () => {
      const a = auto();
      a.work.sessions = 1;
      a.keep.set({ on: true, until: null, auto: true });
      a.runs[0].exit();
      assert.equal(a.keep.state().on, true);
      assert.equal(a.keep.state().work?.holding, false);
      a.keep.tick();
      assert.equal(a.runs.length, 2);
      assert.equal(a.runs[1].stopped, false);
    });

    it('off stops the hold and the timer', () => {
      const a = auto();
      a.work.sessions = 1;
      a.keep.set({ on: true, until: null, auto: true });
      a.keep.set({ on: false, until: null });
      assert.equal(a.live().length, 0);
      assert.equal(a.timers[0].cancelled, true);
      assert.deepEqual(a.keep.state(), { on: false, until: null, display: false });
      // A timed hold after automatic is a plain one.
      a.keep.set({ on: true, until: NOW + HOUR });
      assert.equal(a.keep.state().auto, undefined);
    });

    it('a restarted runner holds through one grace, then looks', () => {
      const first = auto();
      first.keep.set({ on: true, until: null, auto: true, display: true });
      const saved = JSON.parse(fs.readFileSync(first.file, 'utf-8'));
      assert.deepEqual(saved, { on: true, until: null, display: true, auto: true });
      const again = auto(first.file);
      assert.equal(again.keep.state().auto, true);
      assert.equal(again.live().length, 1);
      assert.equal(again.live()[0].args.includes('-d'), true);
      assert.equal(again.timers.length, 1);
      again.clock.at = NOW + AUTO_GRACE_MS;
      again.keep.tick();
      assert.equal(again.live().length, 0);
      assert.equal(again.keep.state().on, true);
    });

    it('is a Mac runner only, for now', () => {
      const { caffeinate } = fake();
      const linux = new KeepAwake(tmpFile(), {
        caffeinate,
        now: () => NOW,
        platform: 'linux'
      });
      assert.throws(
        () => linux.set({ on: true, until: null, auto: true }),
        /Mac/
      );
    });
  });

  describe('going to sleep', () => {
    function watched(file = tmpFile()) {
      const { runs, caffeinate } = fake();
      const work = { sessions: 0, jobs: 0 };
      const clock = { at: NOW };
      const events: string[] = [];
      const keep = new KeepAwake(file, {
        caffeinate,
        now: () => clock.at,
        platform: 'darwin',
        work: () => work,
        every: () => () => {},
        power: async () => ({ ac: true, percent: 80 }),
        onSleep: (reason) => events.push(`sleep:${reason}`),
        onWake: () => events.push('wake')
      });
      const live = () => runs.filter((r) => !r.stopped);
      return { keep, live, work, clock, events };
    }

    it('automatic says so just before it lets go, and again if work comes back', () => {
      const a = watched();
      a.work.sessions = 1;
      a.keep.set({ on: true, until: null, auto: true });
      a.work.sessions = 0;
      a.clock.at = NOW + AUTO_GRACE_MS;
      a.keep.tick();
      assert.deepEqual(a.events, ['sleep:idle']);
      assert.equal(a.live().length, 0);
      assert.equal(a.keep.lastWork(), NOW);
      // Idle looks after that say nothing more.
      a.keep.tick();
      assert.deepEqual(a.events, ['sleep:idle']);
      a.work.jobs = 1;
      a.keep.tick();
      assert.deepEqual(a.events, ['sleep:idle', 'wake']);
      assert.equal(a.live().length, 1);
    });

    it('a throwing listener does not stop the let-go', () => {
      const { runs, caffeinate } = fake();
      const work = { sessions: 1, jobs: 0 };
      const clock = { at: NOW };
      const keep = new KeepAwake(tmpFile(), {
        caffeinate,
        now: () => clock.at,
        platform: 'darwin',
        work: () => work,
        every: () => () => {},
        onSleep: () => {
          throw new Error('socket gone');
        }
      });
      keep.set({ on: true, until: null, auto: true });
      work.sessions = 0;
      clock.at = NOW + AUTO_GRACE_MS;
      keep.tick();
      assert.equal(runs[0].stopped, true);
    });

    it('a timed hold or turning it off sends nothing', () => {
      const a = watched();
      a.keep.set({ on: true, until: NOW + HOUR });
      a.keep.set({ on: false, until: null });
      assert.deepEqual(a.events, []);
    });
  });

  describe('while plugged in', () => {
    function plugged(file = tmpFile()) {
      const { runs, caffeinate } = fake();
      const power: RunnerPower = { ac: true, percent: 64 };
      const events: string[] = [];
      const keep = new KeepAwake(file, {
        caffeinate,
        now: () => NOW,
        platform: 'darwin',
        every: () => () => {},
        power: async () => ({ ...power }),
        onSleep: (reason) => events.push(`sleep:${reason}`),
        onWake: () => events.push('wake')
      });
      const live = () => runs.filter((r) => !r.stopped);
      return { keep, live, power, events, file };
    }

    it('holds on AC, lets go on battery with a sleep notice, and holds again', async () => {
      const p = plugged();
      const state = p.keep.set({ on: true, until: null, ac: true });
      assert.equal(state.ac, true);
      assert.equal(state.until, null);
      await p.keep.look();
      assert.equal(p.live().length, 1);
      assert.equal(p.live()[0].args.includes('-t'), false);
      assert.deepEqual(p.keep.state().plugged, { ac: true, holding: true });
      p.power.ac = false;
      await p.keep.look();
      assert.equal(p.live().length, 0);
      assert.deepEqual(p.keep.state().plugged, { ac: false, holding: false });
      assert.deepEqual(p.events, ['sleep:battery']);
      assert.deepEqual(p.keep.power(), { ac: false, percent: 64 });
      // Still on battery: no second notice.
      await p.keep.look();
      assert.deepEqual(p.events, ['sleep:battery']);
      p.power.ac = true;
      await p.keep.look();
      assert.equal(p.live().length, 1);
      assert.deepEqual(p.events, ['sleep:battery', 'wake']);
    });

    it('power it cannot read holds, as on a desktop Mac', async () => {
      const p = plugged();
      p.power.ac = null;
      p.power.percent = null;
      p.keep.set({ on: true, until: null, ac: true });
      await p.keep.look();
      assert.equal(p.live().length, 1);
      assert.deepEqual(p.keep.state().plugged, { ac: null, holding: true });
    });

    it('is saved, and a restarted runner takes it back up', async () => {
      const first = plugged();
      first.keep.set({ on: true, until: null, ac: true, display: true });
      const saved = JSON.parse(fs.readFileSync(first.file, 'utf-8'));
      assert.deepEqual(saved, { on: true, until: null, display: true, ac: true });
      const again = plugged(first.file);
      assert.equal(again.keep.state().ac, true);
      await again.keep.look();
      assert.equal(again.live().length, 1);
      assert.equal(again.live()[0].args.includes('-d'), true);
    });

    it('off stops it', async () => {
      const p = plugged();
      p.keep.set({ on: true, until: null, ac: true });
      await p.keep.look();
      p.keep.set({ on: false, until: null });
      assert.equal(p.live().length, 0);
      assert.deepEqual(p.keep.state(), { on: false, until: null, display: false });
    });
  });

  it('reads pmset -g batt', () => {
    assert.deepEqual(
      parsePmsetBatt(
        "Now drawing from 'AC Power'\n -InternalBattery-0 (id=123)\t100%; charged; 0:00 remaining present: true\n"
      ),
      { ac: true, percent: 100 }
    );
    assert.deepEqual(
      parsePmsetBatt(
        "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=123)\t41%; discharging; 3:12 remaining present: true\n"
      ),
      { ac: false, percent: 41 }
    );
    // A desktop Mac: on AC, no battery.
    assert.deepEqual(parsePmsetBatt("Now drawing from 'AC Power'\n"), {
      ac: true,
      percent: null
    });
    assert.deepEqual(parsePmsetBatt("Now drawing from 'UPS Power'\n"), {
      ac: false,
      percent: null
    });
    assert.deepEqual(parsePmsetBatt(''), { ac: null, percent: null });
  });
});
