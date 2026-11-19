import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { isInStagedShare, stagingPoint } from '@shared/all/domains/desktopStaging';

import { createOpsUpdater, type Release } from './updater';
import { parseLatestMacYml, releaseOffered, stagingIdFile, stagingInstallId } from './updaterMac';

// The ops updater and the staged rollout (.specs/desktop-release.md → Staged
// rollout): it reads `stagingPercentage` from latest-mac.yml and decides as
// electron-updater does, with an id of its own kept in the ops home.

const made: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-staging-'));
  made.push(dir);
  return dir;
}
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

/** An install id whose last four bytes put it `share` of the way from 0 to 1. */
const installAt = (share: number): string => {
  const tail = Math.floor(share * 0xffffffff)
    .toString(16)
    .padStart(8, '0');
  return `3f2b8c1e-5d4a-4e6f-9a7b-0c1d${tail}`;
};

const feed = (staging?: string): string =>
  `version: 1.9.0\nfiles:\n  - url: Factiii-1.9.0-arm64-mac.zip\n    sha512: BBB==\npath: x\n${
    staging === undefined ? '' : `stagingPercentage: ${staging}\n`
  }`;

/** The release a feed with this `stagingPercentage` line parses to. */
const release = (staging?: string): Release => {
  const parsed = parseLatestMacYml(feed(staging));
  assert.ok(parsed);
  return parsed;
};

describe('ops updater: staged rollout', () => {
  it('reads stagingPercentage from the feed, and leaves it out when the feed has none', () => {
    assert.equal(release().stagingPercentage, undefined);
    assert.equal('stagingPercentage' in release(), false);
    assert.equal(release('5').stagingPercentage, '5');
    assert.equal(release("'25'").stagingPercentage, '25');
    assert.equal(release('0').stagingPercentage, '0');
  });

  it('no key: every install updates', () => {
    assert.equal(releaseOffered(release(), installAt(0)), true);
    assert.equal(releaseOffered(release(), installAt(0.99)), true);
  });

  it('0: no install updates, the first one included', () => {
    assert.equal(releaseOffered(release('0'), installAt(0)), false);
    assert.equal(releaseOffered(release('0'), installAt(0.5)), false);
  });

  it('a fixed id is in at 100 and is in or out the same way as the share rises', () => {
    const id = installAt(0.2);
    assert.equal(stagingPoint(id), Math.floor(0.2 * 0xffffffff) / 0xffffffff);
    assert.equal(releaseOffered(release('100'), id), true);
    const answers = [1, 5, 20, 21, 25, 50, 99, 100].map((percent) => releaseOffered(release(String(percent)), id));
    assert.deepEqual(answers, [false, false, false, true, true, true, true, true]);
    // Asked again, the same id gets the same answer.
    assert.equal(releaseOffered(release('5'), id), false);
    assert.equal(releaseOffered(release('25'), id), true);
    assert.equal(releaseOffered(release('100'), installAt(0.99)), true);
  });

  it('a malformed value is treated as no key', () => {
    assert.equal(releaseOffered(release('abc'), installAt(0.99)), true);
    assert.equal(releaseOffered(release('%'), installAt(0.99)), true);
    assert.equal(isInStagedShare(installAt(0.99), ''), true);
    assert.equal(isInStagedShare(installAt(0.99), null), true);
  });

  it('an id that is not a UUID is outside any staged share', () => {
    assert.equal(stagingPoint('nope'), null);
    assert.equal(isInStagedShare('nope', 50), false);
    assert.equal(isInStagedShare('nope', 100), true);
    assert.equal(isInStagedShare('nope', undefined), true);
  });

  it('the id is made once, kept in the ops home, and remade only when the file is not a UUID', () => {
    const home = tmp();
    const first = stagingInstallId(home);
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(fs.readFileSync(stagingIdFile(home), 'utf-8').trim(), first);
    assert.equal(fs.statSync(stagingIdFile(home)).mode & 0o777, 0o600);
    assert.equal(stagingInstallId(home), first);
    fs.writeFileSync(stagingIdFile(home), 'garbage\n');
    const second = stagingInstallId(home);
    assert.notEqual(second, first);
    assert.equal(stagingInstallId(home), second);
  });

  it('an id that cannot be kept is logged, and is outside any staged share', () => {
    const lines: string[] = [];
    const id = stagingInstallId(path.join(tmp(), 'missing'), (line) => lines.push(line));
    assert.equal(stagingPoint(id), null);
    assert.equal(releaseOffered(release('99'), id), false);
    assert.equal(releaseOffered(release('100'), id), true);
    assert.equal(lines.length, 1);
  });

  it('loop: a Mac outside the share installs nothing, asked or not, and installs once the share reaches it', async () => {
    const id = installAt(0.2);
    let latest = release('5');
    const applied: string[] = [];
    let now = 0;
    const updater = createOpsUpdater({
      current: '1.8.49',
      intervalMs: 1_000,
      now: () => now,
      fetchLatest: async () => latest,
      inRollout: (found) => releaseOffered(found, id),
      activeJobs: () => 0,
      stage: async () => ({ ok: true, staged: '/staged/Factiii.app' }),
      apply: async (staged) => {
        applied.push(staged);
      }
    });
    const held = await updater.tick();
    assert.equal(held.phase, 'up-to-date');
    assert.equal(held.latest, null);
    assert.match(held.message ?? '', /1\.9\.0 is rolling out/);
    assert.equal((await updater.updateNow()).phase, 'up-to-date', 'Update now does not skip the share');
    assert.deepEqual(applied, []);

    latest = release('0');
    now = 2_000;
    assert.equal((await updater.tick()).phase, 'up-to-date', 'a pulled feed (0) is offered to nobody');
    assert.deepEqual(applied, []);

    latest = release('25');
    now = 4_000;
    await updater.tick();
    assert.deepEqual(applied, ['/staged/Factiii.app']);
  });

  it('loop: a feed without the key installs as before', async () => {
    const applied: string[] = [];
    const updater = createOpsUpdater({
      current: '1.8.49',
      intervalMs: 1_000,
      now: () => 0,
      fetchLatest: async () => release(),
      inRollout: (found) => releaseOffered(found, installAt(0.99)),
      activeJobs: () => 0,
      stage: async () => ({ ok: true, staged: '/staged/Factiii.app' }),
      apply: async (staged) => {
        applied.push(staged);
      }
    });
    await updater.tick();
    assert.deepEqual(applied, ['/staged/Factiii.app']);
  });
});
