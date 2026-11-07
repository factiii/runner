import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  AUTO_GRACE_MS,
  type Caffeinate,
  KeepAwake,
  LID_BATTERY_HYSTERESIS,
  LID_LOW_BATTERY,
  type RunnerPower
} from './keepAwake';
import { LidHold, type LidExec, lidWatchScript, NO_GRANT_RETRY_MS } from './lidHold';

const NOW = Date.UTC(2026, 9, 29, 20);
const ON = ['/usr/bin/sudo', '-n', '/usr/bin/pmset', '-a', 'disablesleep', '1'];
const OFF = ['/usr/bin/sudo', '-n', '/usr/bin/pmset', '-a', 'disablesleep', '0'];

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lid-hold-'));

/** A fake machine: `pmset -g` reports `disabled`, sudo answers per `grant`,
 *  and a granted sudo changes `disabled` as pmset would. */
function machine(opts: { grant?: boolean; disabled?: boolean; failPmset?: boolean } = {}) {
  const state = { disabled: opts.disabled ?? false, grant: opts.grant ?? true };
  const calls: string[][] = [];
  const exec: LidExec = async (bin, args) => {
    const argv = [bin, ...args];
    if (bin === 'pmset' && args[0] === '-g') {
      return { code: 0, output: ` SleepDisabled\t\t${state.disabled ? 1 : 0}\n sleep 10\n` };
    }
    calls.push(argv);
    if (!state.grant) return { code: 1, output: 'sudo: a password is required\n' };
    if (opts.failPmset) return { code: 1, output: 'pmset: error\n' };
    state.disabled = args[args.length - 1] === '1';
    return { code: 0, output: '' };
  };
  const watches: string[] = [];
  const dir = tmp();
  let now = NOW;
  const lid = new LidHold({
    marker: path.join(dir, 'lid-hold'),
    lidAwakeFile: path.join(dir, 'lid-awake'),
    exec,
    spawnWatch: (script) => watches.push(script),
    now: () => now,
    pid: 4242,
    log: () => {}
  });
  return {
    state,
    calls,
    watches,
    lid,
    dir,
    marker: path.join(dir, 'lid-hold'),
    lidAwakeFile: path.join(dir, 'lid-awake'),
    advance: (ms: number) => {
      now += ms;
    },
    nowFn: () => now
  };
}

describe('lid hold: take and release', () => {
  it('takes with sudo -n pmset -a disablesleep 1, lets go with 0', async () => {
    const m = machine();
    await m.lid.sync(true, null);
    assert.deepEqual(m.calls, [ON]);
    assert.equal(m.lid.state(), 'holding');
    assert.equal(fs.readFileSync(m.marker, 'utf-8'), '4242');
    // Taken again: nothing new runs.
    await m.lid.sync(true, null);
    assert.deepEqual(m.calls, [ON]);
    await m.lid.sync(false, null);
    assert.deepEqual(m.calls, [ON, OFF]);
    assert.equal(m.lid.state(), 'off');
    assert.equal(m.state.disabled, false);
    assert.equal(fs.existsSync(m.marker), false);
  });

  it('starts one dead-man watcher, at the first take', async () => {
    const m = machine();
    await m.lid.sync(true, null);
    await m.lid.sync(false, null);
    await m.lid.sync(true, null);
    assert.equal(m.watches.length, 1);
    assert.match(m.watches[0], /kill -0 4242/);
  });

  it('with no grant: needs setup, caffeinate only, and tries again only after a while', async () => {
    const m = machine({ grant: false });
    await m.lid.sync(true, null);
    assert.equal(m.lid.state(), 'needs-setup');
    assert.equal(m.lid.holding(), false);
    assert.equal(m.watches.length, 0);
    await m.lid.sync(true, null);
    assert.equal(m.calls.length, 1);
    // Letting go has nothing to turn off, and still says needs setup.
    await m.lid.sync(false, null);
    assert.equal(m.calls.length, 1);
    assert.equal(m.lid.state(), 'needs-setup');
    // Set up meanwhile: the next try after the wait takes it.
    m.state.grant = true;
    m.advance(NO_GRANT_RETRY_MS);
    await m.lid.sync(true, null);
    assert.deepEqual(m.calls.at(-1), ON);
    assert.equal(m.lid.state(), 'holding');
  });

  it('a pmset failure that is not a missing grant says failed, and tries next time', async () => {
    const m = machine({ failPmset: true });
    await m.lid.sync(true, null);
    assert.equal(m.lid.state(), 'failed');
    await m.lid.sync(true, null);
    assert.equal(m.calls.length, 2);
  });

  it('leaves alone a disablesleep 1 it did not set (Factiii Desktop by hand)', async () => {
    const m = machine({ disabled: true });
    await m.lid.sync(true, null);
    assert.equal(m.lid.state(), 'by-hand');
    await m.lid.sync(false, null);
    assert.deepEqual(m.calls, []);
    assert.equal(m.state.disabled, true);
  });

  it('a block lets go and names why', async () => {
    const m = machine();
    await m.lid.sync(true, null);
    await m.lid.sync(true, 'low-battery');
    assert.deepEqual(m.calls, [ON, OFF]);
    assert.equal(m.lid.state(), 'low-battery');
    await m.lid.sync(true, 'hot');
    assert.equal(m.lid.state(), 'hot');
    assert.equal(m.calls.length, 2);
  });
});

describe('lid hold: start watchdog', () => {
  it('turns off a disablesleep 1 nobody holds', async () => {
    const m = machine({ disabled: true });
    fs.writeFileSync(m.marker, '999');
    await m.lid.startup();
    assert.deepEqual(m.calls, [OFF]);
    assert.equal(m.state.disabled, false);
    assert.equal(fs.existsSync(m.marker), false);
  });

  it('leaves the desktop app own Lid closed (its file) on', async () => {
    const m = machine({ disabled: true });
    fs.writeFileSync(m.lidAwakeFile, 'none\n');
    await m.lid.startup();
    assert.deepEqual(m.calls, []);
    assert.equal(m.state.disabled, true);
  });

  it('does nothing when it is off', async () => {
    const m = machine();
    await m.lid.startup();
    assert.deepEqual(m.calls, []);
  });
});

describe('lid hold: dead-man watcher (real sh, fake sudo)', () => {
  function fakeSudo(dir: string) {
    const log = path.join(dir, 'sudo.log');
    const sudo = path.join(dir, 'sudo');
    fs.writeFileSync(sudo, `#!/bin/sh\necho "$*" >> '${log}'\n`, { mode: 0o755 });
    return { sudo, log };
  }

  it('sets 0 once the runner pid is gone and the marker still names it', async () => {
    const dir = tmp();
    const { sudo, log } = fakeSudo(dir);
    const child = spawn('sleep', ['1']);
    const pid = child.pid!;
    const marker = path.join(dir, 'lid-hold');
    fs.writeFileSync(marker, String(pid));
    // Async, so node reaps the sleep when it ends (a zombie still answers
    // kill -0).
    const watcher = spawn('/bin/sh', ['-c', lidWatchScript({ pid, marker, sudo, everyS: 1 })]);
    const code = await new Promise<number | null>((resolve) => watcher.on('exit', resolve));
    assert.equal(code, 0);
    assert.equal(fs.readFileSync(log, 'utf-8'), '-n /usr/bin/pmset -a disablesleep 0\n');
    assert.equal(fs.existsSync(marker), false);
  });

  it('does nothing once the runner let go (no marker) or another took it', () => {
    const dir = tmp();
    const { sudo, log } = fakeSudo(dir);
    const marker = path.join(dir, 'lid-hold');
    // A pid that is not running.
    const gone = spawnSync('true').pid;
    let res = spawnSync('/bin/sh', ['-c', lidWatchScript({ pid: gone, marker, sudo, everyS: 1 })]);
    assert.equal(res.status, 0);
    fs.writeFileSync(marker, '1');
    res = spawnSync('/bin/sh', ['-c', lidWatchScript({ pid: gone, marker, sudo, everyS: 1 })]);
    assert.equal(res.status, 0);
    assert.equal(fs.existsSync(log), false);
    assert.equal(fs.readFileSync(marker, 'utf-8'), '1');
  });
});

describe('keep-awake follows the lid', () => {
  function setup(power: RunnerPower, opts: { grant?: boolean } = {}) {
    const m = machine(opts);
    const work = { sessions: 0, jobs: 0 };
    let hot: boolean | null = false;
    const caffeinate: Caffeinate = () => () => {};
    const p = { ...power };
    const keep = new KeepAwake(path.join(m.dir, 'k.json'), {
      caffeinate,
      now: m.nowFn,
      platform: 'darwin',
      every: () => () => {},
      work: () => work,
      power: async () => ({ ...p }),
      thermal: async () => hot,
      lid: m.lid
    });
    const look = async () => {
      await keep.look();
      await m.lid.settled();
    };
    return {
      m,
      keep,
      work,
      power: p,
      look,
      setHot: (h: boolean | null) => {
        hot = h;
      }
    };
  }

  it('Automatic: takes the lid with the hold, lets go with it', async () => {
    const t = setup({ ac: false, percent: 80 });
    t.keep.set({ on: true, until: null, auto: true });
    await t.look();
    assert.deepEqual(t.m.calls, []);
    t.work.sessions = 1;
    await t.look();
    assert.deepEqual(t.m.calls, [ON]);
    assert.equal(t.keep.state().lid, 'holding');
    t.work.sessions = 0;
    t.m.advance(AUTO_GRACE_MS);
    await t.look();
    assert.deepEqual(t.m.calls, [ON, OFF]);
    assert.equal(t.keep.state().lid, 'off');
  });

  it('While plugged in: on AC takes it, on battery lets go', async () => {
    const t = setup({ ac: true, percent: 90 });
    t.keep.set({ on: true, until: null, ac: true });
    await t.look();
    assert.deepEqual(t.m.calls, [ON]);
    t.power.ac = false;
    await t.look();
    assert.deepEqual(t.m.calls, [ON, OFF]);
  });

  it('Turn off and a timed hold let it go', async () => {
    const t = setup({ ac: true, percent: 90 });
    t.keep.set({ on: true, until: null, ac: true });
    await t.look();
    t.keep.set({ on: true, until: NOW + 3_600_000 });
    await t.m.lid.settled();
    assert.deepEqual(t.m.calls, [ON, OFF]);
    assert.equal(t.keep.state().lid, undefined);
  });

  it('battery low lets go, and takes it again only past the hysteresis', async () => {
    const t = setup({ ac: false, percent: 50 });
    t.work.jobs = 1;
    t.keep.set({ on: true, until: null, auto: true });
    await t.look();
    assert.deepEqual(t.m.calls, [ON]);
    t.power.percent = LID_LOW_BATTERY - 1;
    await t.look();
    assert.deepEqual(t.m.calls, [ON, OFF]);
    assert.equal(t.keep.state().lid, 'low-battery');
    t.power.percent = LID_LOW_BATTERY + 1;
    await t.look();
    assert.equal(t.m.calls.length, 2);
    t.power.percent = LID_LOW_BATTERY + LID_BATTERY_HYSTERESIS;
    await t.look();
    assert.deepEqual(t.m.calls.at(-1), ON);
  });

  it('hot lets go', async () => {
    const t = setup({ ac: false, percent: 80 });
    t.work.jobs = 1;
    t.keep.set({ on: true, until: null, auto: true });
    await t.look();
    t.setHot(true);
    await t.look();
    // The reading that says hot is taken while held; the next sync lets go.
    assert.deepEqual(t.m.calls, [ON, OFF]);
    assert.equal(t.keep.state().lid, 'hot');
  });

  it('no grant: the hold stays caffeinate only, and Status says needs setup', async () => {
    const t = setup({ ac: false, percent: 80 }, { grant: false });
    t.work.jobs = 1;
    t.keep.set({ on: true, until: null, auto: true });
    await t.look();
    assert.equal(t.keep.state().work?.holding, true);
    assert.equal(t.keep.state().lid, 'needs-setup');
  });

  it('a desktop Mac (no battery) never touches it', async () => {
    const t = setup({ ac: true, percent: null });
    t.keep.set({ on: true, until: null, ac: true });
    await t.look();
    assert.deepEqual(t.m.calls, []);
    assert.equal(t.keep.state().lid, undefined);
  });

  it('a runner start turns off a left-over disablesleep 1 before taking the saved hold back', async () => {
    const m = machine({ disabled: true });
    new KeepAwake(path.join(m.dir, 'k.json'), {
      caffeinate: () => () => {},
      now: m.nowFn,
      platform: 'darwin',
      every: () => () => {},
      lid: m.lid
    });
    await m.lid.settled();
    assert.deepEqual(m.calls, [OFF]);
  });
});
