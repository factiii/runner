import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { limitLog, type LogFiles } from './logLimit';

const LOG = '/home/jo/.factiii-runner/logs/runner.log';
const LIMIT = 100;

/** Files as a map of name to content, and a record of what was done. */
function fakeFiles(files: Record<string, string>, failTruncate = false) {
  const done: string[] = [];
  const io: LogFiles = {
    size: (file) => (file in files ? files[file].length : null),
    copy(from, to) {
      done.push(`copy ${from} ${to}`);
      files[to] = files[from];
    },
    truncate(file) {
      if (failTruncate) throw new Error('EPERM: operation not permitted');
      done.push(`truncate ${file}`);
      files[file] = '';
    }
  };
  return { io, files, done };
}

describe('limitLog', () => {
  it('copies a log over the limit to .1 and empties it in place', () => {
    const big = 'x'.repeat(LIMIT + 1);
    const { io, files, done } = fakeFiles({ [LOG]: big });
    assert.equal(limitLog(LOG, io, LIMIT), true);
    assert.deepEqual(files, { [LOG]: '', [`${LOG}.1`]: big });
    // Never a rename: the service manager holds the live file open.
    assert.deepEqual(done, [`copy ${LOG} ${LOG}.1`, `truncate ${LOG}`]);
  });

  it('does nothing at or under the limit', () => {
    const { io, done } = fakeFiles({ [LOG]: 'x'.repeat(LIMIT) });
    assert.equal(limitLog(LOG, io, LIMIT), false);
    assert.deepEqual(done, []);
  });

  it('does nothing when there is no log, as for a runner started by hand', () => {
    const { io, files, done } = fakeFiles({});
    assert.equal(limitLog(LOG, io, LIMIT), false);
    assert.deepEqual(done, []);
    assert.deepEqual(files, {});
  });

  it('swallows a truncate that fails, and leaves the log as it was', () => {
    const big = 'x'.repeat(LIMIT + 1);
    const { io, files } = fakeFiles({ [LOG]: big }, true);
    assert.equal(limitLog(LOG, io, LIMIT), false);
    assert.equal(files[LOG], big);
  });

  it('replaces an earlier .1, so one old file is all there ever is', () => {
    const big = 'new'.repeat(LIMIT);
    const { io, files } = fakeFiles({ [LOG]: big, [`${LOG}.1`]: 'older' });
    assert.equal(limitLog(LOG, io, LIMIT), true);
    assert.deepEqual(files, { [LOG]: '', [`${LOG}.1`]: big });
  });
});
