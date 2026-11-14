import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  downloadVerified,
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
    },
    { name: 'factiii-runner-0.39.0.tgz.sig', browser_download_url: `${DL}/factiii-runner-0.39.0.tgz.sig` }
  ],
  ...over
});

describe('pickUpdateSource', () => {
  it('takes GitHub when it has the newest version, a tie included', () => {
    assert.equal(pickUpdateSource('0.27.0', '0.39.0', '0.39.0'), 'github');
    assert.equal(pickUpdateSource('0.27.0', '0.27.0', '0.39.0'), 'github');
    assert.equal(pickUpdateSource('0.27.0', null, '0.39.0'), 'github');
  });

  it('takes npm only when it is ahead of GitHub, or GitHub cannot say', () => {
    assert.equal(pickUpdateSource('0.27.0', '0.40.0', '0.39.0'), 'npm');
    assert.equal(pickUpdateSource('0.27.0', '0.39.0', null), 'npm');
  });

  it('never goes back or sideways', () => {
    assert.equal(pickUpdateSource('0.39.0', '0.27.0', '0.39.0'), null);
    assert.equal(pickUpdateSource('0.40.0', '0.39.0', '0.39.0'), null);
    assert.equal(pickUpdateSource('0.39.0', null, null), null);
  });
});

describe('parseGithubRelease', () => {
  it('reads the version and the three assets', () => {
    assert.deepEqual(parseGithubRelease(release()), {
      version: '0.39.0',
      tarballUrl: `${DL}/factiii-runner-0.39.0.tgz`,
      sha256Url: `${DL}/factiii-runner-0.39.0.tgz.sha256`,
      sigUrl: `${DL}/factiii-runner-0.39.0.tgz.sig`
    });
  });

  it('reads a release without a .sig, for downloadVerified to refuse', () => {
    const body = release();
    body.assets = body.assets.slice(0, 2);
    assert.equal(parseGithubRelease(body)?.sigUrl, null);
  });

  it('ignores a .sig hosted anywhere but this repo', () => {
    const body = release();
    body.assets[2] = {
      name: 'factiii-runner-0.39.0.tgz.sig',
      browser_download_url: 'https://evil.example/factiii-runner-0.39.0.tgz.sig'
    };
    assert.equal(parseGithubRelease(body)?.sigUrl, null);
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

describe('downloadVerified', () => {
  // A throwaway keypair: the test's public key stands in for the pinned one.
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const tarball = Buffer.from('a release tarball, byte for byte');
  const sign = (data: Buffer, key = privateKey) =>
    `${crypto.sign(null, data, key).toString('base64')}\n`;
  const sha256 = (data: Buffer) => crypto.createHash('sha256').update(data).digest('hex');

  const target = parseGithubRelease(release());
  assert.ok(target);
  const rel = target;

  /** A fetch that serves the release's three files, or 404 for a missing one. */
  const serve = (files: { tgz: Buffer; sha256: string; sig?: string }) =>
    (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === rel.tarballUrl) return new Response(new Uint8Array(files.tgz));
      if (url === rel.sha256Url) return new Response(`${files.sha256}  factiii-runner-0.39.0.tgz\n`);
      if (url === rel.sigUrl && files.sig !== undefined) return new Response(files.sig);
      return new Response('Not Found', { status: 404 });
    }) as typeof fetch;

  /** Run it with console.error captured, cleaning up any file it wrote. */
  async function run(fetchImpl: typeof fetch, r = rel) {
    const errors: string[] = [];
    const original = console.error;
    console.error = (msg: unknown) => errors.push(String(msg));
    try {
      const file = await downloadVerified(r, fetchImpl, publicPem);
      const bytes = file ? fs.readFileSync(file) : null;
      if (file) fs.rmSync(path.dirname(file), { recursive: true, force: true });
      return { file, bytes, errors };
    } finally {
      console.error = original;
    }
  }

  it('installs a tarball with a good signature from the pinned key', async () => {
    const { file, bytes, errors } = await run(
      serve({ tgz: tarball, sha256: sha256(tarball), sig: sign(tarball) })
    );
    assert.ok(file?.endsWith('factiii-runner-0.39.0.tgz'));
    assert.deepEqual(bytes, tarball);
    assert.deepEqual(errors, []);
  });

  it('refuses a release with no .sig', async () => {
    const { file, errors } = await run(serve({ tgz: tarball, sha256: sha256(tarball) }));
    assert.equal(file, null);
    assert.match(errors.join('\n'), /not signed/);
    // Nor when the release lists no .sig asset at all.
    const unsigned = await run(serve({ tgz: tarball, sha256: sha256(tarball) }), {
      ...rel,
      sigUrl: null
    });
    assert.equal(unsigned.file, null);
    assert.match(unsigned.errors.join('\n'), /not signed/);
  });

  it('refuses a signature by any other key', async () => {
    const other = crypto.generateKeyPairSync('ed25519').privateKey;
    const { file, errors } = await run(
      serve({ tgz: tarball, sha256: sha256(tarball), sig: sign(tarball, other) })
    );
    assert.equal(file, null);
    assert.match(errors.join('\n'), /does not verify/);
  });

  it('refuses a garbled signature', async () => {
    const { file } = await run(serve({ tgz: tarball, sha256: sha256(tarball), sig: 'not base64!' }));
    assert.equal(file, null);
  });

  it('refuses tampered bytes even with a matching .sha256', async () => {
    // Whoever swaps the tarball can swap the .sha256 too; only the .sig holds.
    const tampered = Buffer.from('a release tarball, byte for bytE');
    const { file, errors } = await run(
      serve({ tgz: tampered, sha256: sha256(tampered), sig: sign(tarball) })
    );
    assert.equal(file, null);
    assert.match(errors.join('\n'), /does not verify/);
  });

  it('still refuses a download that does not match its .sha256', async () => {
    const { file, errors } = await run(
      serve({ tgz: tarball, sha256: 'b'.repeat(64), sig: sign(tarball) })
    );
    assert.equal(file, null);
    assert.match(errors.join('\n'), /\.sha256/);
  });
});
