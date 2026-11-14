import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

import { RELEASE_PUBLIC_KEY, verifyReleaseSignature } from './releaseKey';

const SCRIPT = path.join(__dirname, '..', 'scripts', 'sign-release.mjs');
// Only in the monorepo: the public mirror carries apps/runner alone.
const RUNNER_SH = path.join(__dirname, '..', '..', 'factiii-web', 'public', 'runner.sh');

const keypair = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString()
  };
};

const tempFile = (contents: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factiii-sign-test-'));
  const file = path.join(dir, 'factiii-runner-0.0.1.tgz');
  fs.writeFileSync(file, contents);
  return { dir, file };
};

describe('RELEASE_PUBLIC_KEY', () => {
  it('is an Ed25519 public key', () => {
    assert.equal(crypto.createPublicKey(RELEASE_PUBLIC_KEY).asymmetricKeyType, 'ed25519');
  });

  it('refuses a signature it did not make', () => {
    const { privatePem } = keypair();
    const data = Buffer.from('x');
    const sig = crypto.sign(null, data, privatePem).toString('base64');
    assert.equal(verifyReleaseSignature(data, sig), false);
    assert.equal(verifyReleaseSignature(data, ''), false);
  });

  it('is the key runner.sh checks with', { skip: !fs.existsSync(RUNNER_SH) }, () => {
    const pem = RELEASE_PUBLIC_KEY.trim().split('\n');
    const script = fs.readFileSync(RUNNER_SH, 'utf8');
    for (const line of pem) assert.ok(script.includes(line), `runner.sh lacks ${line}`);
  });
});

describe('verifyReleaseSignature', () => {
  const { privatePem, publicPem } = keypair();
  const data = Buffer.from('tarball bytes');
  const sig = `${crypto.sign(null, data, privatePem).toString('base64')}\n`;

  it('accepts the signer’s signature, trailing newline and all', () => {
    assert.equal(verifyReleaseSignature(data, sig, publicPem), true);
  });

  it('refuses other bytes, a cut signature and a non-Ed25519 key', () => {
    assert.equal(verifyReleaseSignature(Buffer.from('tarball byteZ'), sig, publicPem), false);
    assert.equal(verifyReleaseSignature(data, sig.slice(0, 40), publicPem), false);
    const rsa = crypto
      .generateKeyPairSync('rsa', { modulusLength: 1024 })
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString();
    assert.equal(verifyReleaseSignature(data, sig, rsa), false);
  });
});

describe('scripts/sign-release.mjs', () => {
  it('exits non-zero, saying why, without RUNNER_RELEASE_SIGNING_KEY', () => {
    const { dir, file } = tempFile('t');
    const env = { ...process.env };
    delete env.RUNNER_RELEASE_SIGNING_KEY;
    const res = spawnSync(process.execPath, [SCRIPT, file], { env, encoding: 'utf8' });
    fs.rmSync(dir, { recursive: true, force: true });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /RUNNER_RELEASE_SIGNING_KEY is not set/);
  });

  it('refuses a key that is not the pinned one and writes no .sig', () => {
    const { dir, file } = tempFile('t');
    const res = spawnSync(process.execPath, [SCRIPT, file], {
      env: { ...process.env, RUNNER_RELEASE_SIGNING_KEY: keypair().privatePem },
      encoding: 'utf8'
    });
    const wroteSig = fs.existsSync(`${file}.sig`);
    fs.rmSync(dir, { recursive: true, force: true });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /does not match the public key pinned/);
    assert.equal(wroteSig, false);
  });

  it('writes a .sig the runner accepts when the key matches', () => {
    const { privatePem, publicPem } = keypair();
    const { dir, file } = tempFile('release bytes');
    // signRelease with this test's public key in place of the pinned one.
    const code = `import { signRelease } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};
      signRelease(process.argv[1], process.env.PRIV, process.env.PUB);`;
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', code, file], {
      env: { ...process.env, PRIV: privatePem, PUB: publicPem },
      encoding: 'utf8'
    });
    const sig = fs.existsSync(`${file}.sig`) ? fs.readFileSync(`${file}.sig`, 'utf8') : '';
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(verifyReleaseSignature(Buffer.from('release bytes'), sig, publicPem), true);
  });
});
