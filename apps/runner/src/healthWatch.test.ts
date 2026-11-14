import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RunnerHealthAlert, RunnerMachineHealth } from '@shared/all/domains/electron';

import { watchMachineHealth } from './healthWatch';

const health: RunnerMachineHealth = {
  level: 'critical',
  disks: [{ uses: ['Runner folder'], freeGb: 3, totalGb: 494, level: 'critical' }],
  memory: 'ok',
  processes: { used: 400, max: 2666, level: 'ok' },
  memoryPressure: 31,
  warnGb: 20,
  criticalGb: 5
};

const alert: RunnerHealthAlert = {
  level: 'critical',
  disk: { freeGb: 3, level: 'critical' },
  memory: 'ok',
  processes: 'ok'
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('watchMachineHealth', () => {
  it('sends the first reading, keeps it for a reconnect and records it', async () => {
    const sent: RunnerHealthAlert[] = [];
    const recorded: RunnerMachineHealth[] = [];
    const watch = watchMachineHealth(
      (a) => sent.push(a),
      async () => health,
      (h) => recorded.push(h)
    );
    await tick();
    assert.deepEqual(sent, [alert]);
    assert.deepEqual(watch.current(), alert);
    assert.deepEqual(recorded, [health]);
  });

  it('sends nothing for a read that fails', async () => {
    const sent: RunnerHealthAlert[] = [];
    const recorded: RunnerMachineHealth[] = [];
    const watch = watchMachineHealth(
      (a) => sent.push(a),
      async () => {
        throw new Error('statfs failed');
      },
      (h) => recorded.push(h)
    );
    await tick();
    assert.deepEqual(sent, []);
    assert.deepEqual(recorded, []);
    assert.equal(watch.current(), null);
  });
});
