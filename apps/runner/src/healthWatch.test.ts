import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RunnerHealthAlert } from '@shared/all/domains/electron';

import { watchMachineHealth } from './healthWatch';

const alert: RunnerHealthAlert = {
  level: 'critical',
  disk: { freeGb: 3, level: 'critical' },
  memory: 'ok',
  processes: 'ok'
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('watchMachineHealth', () => {
  it('sends the first reading and keeps it for a reconnect', async () => {
    const sent: RunnerHealthAlert[] = [];
    const watch = watchMachineHealth(
      (a) => sent.push(a),
      async () => alert
    );
    await tick();
    assert.deepEqual(sent, [alert]);
    assert.deepEqual(watch.current(), alert);
  });

  it('sends nothing for a read that fails', async () => {
    const sent: RunnerHealthAlert[] = [];
    const watch = watchMachineHealth(
      (a) => sent.push(a),
      async () => {
        throw new Error('statfs failed');
      }
    );
    await tick();
    assert.deepEqual(sent, []);
    assert.equal(watch.current(), null);
  });
});
