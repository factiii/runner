import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type FindingsJobActivity, type FindingsJobOutcome, FindingsJob } from './findingsJob';

// The scheduled Findings job (findingsJob.ts): when it runs and what its
// Running jobs row says. The run itself is engagement.test.ts's.

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const job = (run: () => Promise<FindingsJobOutcome>, afterPushMs = 20) => {
  const rows: FindingsJobActivity[] = [];
  const findings = new FindingsJob({ run, onActivity: (row) => rows.push(row), afterPushMs });
  return { findings, rows };
};

describe('the Findings job', () => {
  it('runs once after a burst of pushes', async () => {
    let runs = 0;
    const { findings, rows } = job(async () => {
      runs++;
      return { state: 'computed', computedAt: 1 };
    });
    findings.pushed();
    findings.pushed();
    findings.pushed();
    await tick(60);
    findings.stop();
    assert.equal(runs, 1);
    // Working while it ran, then the row is cleared.
    assert.deepEqual(
      rows.map((row) => row.state),
      ['working', null]
    );
  });

  it('joins a run already going instead of starting a second', async () => {
    let runs = 0;
    const { findings } = job(async () => {
      runs++;
      await tick(10);
      return { state: 'unchanged' };
    });
    const [a, b] = await Promise.all([findings.runNow(), findings.runNow()]);
    assert.equal(runs, 1);
    assert.deepEqual(a, { state: 'unchanged' });
    assert.equal(a, b);
  });

  it('leaves an error row when a run fails, and the next run clears it', async () => {
    let fail = true;
    const { findings, rows } = job(async () => {
      if (fail) throw new Error('The Vault database did not answer.');
      return { state: 'locked' };
    });
    assert.deepEqual(await findings.runNow(), {
      state: 'failed',
      error: 'The Vault database did not answer.'
    });
    assert.deepEqual(rows.at(-1), { state: 'error', detail: 'The Vault database did not answer.' });
    fail = false;
    assert.deepEqual(await findings.runNow(), { state: 'locked' });
    assert.deepEqual(rows.at(-1), { state: null, detail: '' });
  });

  it('stop cancels a run waiting on a push', async () => {
    let runs = 0;
    const { findings } = job(async () => {
      runs++;
      return { state: 'no-data' };
    });
    findings.start();
    findings.pushed();
    findings.stop();
    await tick(40);
    assert.equal(runs, 0);
  });
});
