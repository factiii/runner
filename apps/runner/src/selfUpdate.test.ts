import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseGithubRelease,
  parseSha256File,
  pickUpdateSource
} from './selfUpdate';

const DL = 'https://github.com/factiii/runner/releases/download/v0.39.0';
const release = (over: Record<string, unknown> = {}) => ({
  tag_name: 'v0.39.0',
  assets: [
    { name: 'factiii-runner-0.39.0.tgz', browser_download_url: `${DL}/factiii-runner-0.39.0.tgz` },
    {
      name: 'factiii-runner-0.39.0.tgz.sha256',
      browser_download_url: `${DL}/factiii-runner-0.39.0.tgz.sha256`
    }
  ],
  ...over
});

describe('pickUpdateSource', () => {
  it('takes npm when it has the newest version', () => {
    assert.equal(pickUpdateSource('0.27.0', '0.39.0', '0.39.0'), 'npm');
    assert.equal(pickUpdateSource('0.27.0', '0.39.0', null), 'npm');
  });

  it('takes GitHub when npm is behind it, as while npm blocks a release', () => {
    assert.equal(pickUpdateSource('0.27.0', '0.27.0', '0.39.0'), 'github');
    assert.equal(pickUpdateSource('0.27.0', null, '0.39.0'), 'github');
  });

  it('never goes back or sideways', () => {
    assert.equal(pickUpdateSource('0.39.0', '0.27.0', '0.39.0'), null);
    assert.equal(pickUpdateSource('0.40.0', '0.39.0', '0.39.0'), null);
    assert.equal(pickUpdateSource('0.39.0', null, null), null);
  });
});

describe('parseGithubRelease', () => {
  it('reads the version and both assets', () => {
    assert.deepEqual(parseGithubRelease(release()), {
      version: '0.39.0',
      tarballUrl: `${DL}/factiii-runner-0.39.0.tgz`,
      sha256Url: `${DL}/factiii-runner-0.39.0.tgz.sha256`
    });
  });

  it('refuses a release without its .sha256', () => {
    const body = release();
    body.assets = body.assets.slice(0, 1);
    assert.equal(parseGithubRelease(body), null);
  });

  it('refuses assets hosted anywhere but this repo', () => {
    const body = release();
    body.assets[0] = {
      name: 'factiii-runner-0.39.0.tgz',
      browser_download_url: 'https://evil.example/factiii-runner-0.39.0.tgz'
    };
    assert.equal(parseGithubRelease(body), null);
  });

  it('refuses a tag that is not a plain version', () => {
    assert.equal(parseGithubRelease(release({ tag_name: 'v0.39.0; rm -rf /' })), null);
    assert.equal(parseGithubRelease(release({ tag_name: 'latest' })), null);
    assert.equal(parseGithubRelease(null), null);
  });
});

describe('parseSha256File', () => {
  const hash = 'a'.repeat(64);
  it('reads sha256sum output and a bare hash', () => {
    assert.equal(parseSha256File(`${hash}  factiii-runner-0.39.0.tgz\n`), hash);
    assert.equal(parseSha256File(hash.toUpperCase()), hash);
  });
  it('is null without a hash', () => {
    assert.equal(parseSha256File('not found'), null);
  });
});
