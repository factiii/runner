import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { RunnerMachineHealth } from '@shared/all/domains/electron';

import { addSample, HealthHistory, KEEP_MS, parseHistory, SLOT_MS, sampleOf } from './healthHistory';

// The 24 h chart's history against made-up readings and a temporary file.
// Nothing here reads the real machine or the runner folder.

const NOW = 1_800_000_000_000 - (1_800_000_000_000 % SLOT_MS);

const health = (
  freeGb: number,
  pressure: number | null,
  level: RunnerMachineHealth['level'] = 'ok'
): RunnerMachineHealth => ({
  level,
  disks: [
    { uses: ['Runner folder'], freeGb, totalGb: 494, level },
    { uses: ['Ollama models'], freeGb: freeGb + 100, totalGb: 1000, level: 'ok' }
  ],
  memory: 'ok',
  memoryPressure: pressure,
  warnGb: 20,
  criticalGb: 5
});

describe('health history', () => {
  it('keeps the least disk, the most memory and the worst level of a slot', () => {
    let history = addSample([], sampleOf(health(30, 40), NOW + 1_000), NOW + 1_000);
    history = addSample(history, sampleOf(health(4, 20, 'critical'), NOW + 31_000), NOW + 31_000);
    history = addSample(history, sampleOf(health(25, 70), NOW + 61_000), NOW + 61_000);
    assert.deepEqual(history, [{ at: NOW, diskFreeGb: 4, memoryPressure: 70, level: 'critical' }]);
    history = addSample(history, sampleOf(health(25, null), NOW + SLOT_MS), NOW + SLOT_MS);
    assert.equal(history.length, 2);
    assert.deepEqual(history[1], {
      at: NOW + SLOT_MS,
      diskFreeGb: 25,
      memoryPressure: null,
      level: 'ok'
    });
  });

  it('keeps only the last 24 hours, and starts over when the clock goes back', () => {
    let history = addSample([], sampleOf(health(30, 40), NOW), NOW);
    const later = NOW + KEEP_MS + SLOT_MS;
    history = addSample(history, sampleOf(health(30, 40), later), later);
    assert.deepEqual(
      history.map((s) => s.at),
      [later]
    );
    const back = addSample(history, sampleOf(health(30, 40), NOW), NOW);
    assert.deepEqual(
      back.map((s) => s.at),
      [NOW]
    );
  });

  it('is bounded to a day of slots however many readings come', () => {
    let history = addSample([], sampleOf(health(30, 40), NOW), NOW);
    for (let t = NOW; t < NOW + 2 * KEEP_MS; t += 30_000) {
      history = addSample(history, sampleOf(health(30, 40), t), t);
    }
    assert.ok(history.length <= KEEP_MS / SLOT_MS + 1);
  });

  it('trusts nothing in the saved file', () => {
    assert.deepEqual(parseHistory('nope', NOW), []);
    assert.deepEqual(
      parseHistory(
        [
          { at: NOW - SLOT_MS, diskFreeGb: 10, memoryPressure: 50, level: 'warn' },
          { at: NOW - KEEP_MS - 1, diskFreeGb: 10, memoryPressure: 50, level: 'ok' },
          { at: NOW, diskFreeGb: 'x', memoryPressure: 50, level: 'ok' },
          { at: NOW, diskFreeGb: 10, memoryPressure: 50, level: 'bad' },
          null
        ],
        NOW
      ),
      [{ at: NOW - SLOT_MS, diskFreeGb: 10, memoryPressure: 50, level: 'warn' }]
    );
  });

  it('saves when a slot starts, and a restart reads the day back', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-history-'));
    const file = path.join(dir, 'health-history.json');
    let now = NOW + 1_000;
    const history = new HealthHistory(file, () => now);
    assert.deepEqual(history.list(), []);
    history.add(health(12, 55, 'warn'));
    now += 30_000;
    history.add(health(11, 60, 'warn'));
    const reopened = new HealthHistory(file, () => now);
    // Saved at the slot's first reading; the rest of the slot is in memory.
    assert.deepEqual(reopened.list(), [
      { at: NOW, diskFreeGb: 12, memoryPressure: 55, level: 'warn' }
    ]);
    assert.deepEqual(history.list(), [
      { at: NOW, diskFreeGb: 11, memoryPressure: 60, level: 'warn' }
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
