#!/usr/bin/env node
// Sign a runner release tarball: writes <file>.sig, a base64 Ed25519
// signature over the file's exact bytes, which selfUpdate.ts and
// factiii.com/runner.sh check before installing a GitHub Release.
//
//   RUNNER_RELEASE_SIGNING_KEY=<PKCS#8 PEM> node scripts/sign-release.mjs <file>
//
// Before exiting 0 it verifies its own signature against the public key
// pinned in src/releaseKey.ts, so a wrong or rotated-out secret fails the
// release instead of shipping one that every runner refuses.
// Node's own crypto only. The key is read from the environment and never
// printed or written anywhere.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The pinned public key, read from the one module that holds it. */
export function pinnedPublicKey(file = path.join(RUNNER, 'src', 'releaseKey.ts')) {
  const pem = /-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/.exec(
    fs.readFileSync(file, 'utf8')
  )?.[0];
  if (!pem) throw new Error(`no public key found in ${file}`);
  return `${pem}\n`;
}

/** Sign `file` with `privatePem`, write `<file>.sig`, and check the result
 *  against `publicPem`. Throws (and leaves no .sig) when it does not verify. */
export function signRelease(file, privatePem, publicPem = pinnedPublicKey()) {
  const data = fs.readFileSync(file);
  const key = crypto.createPrivateKey(privatePem);
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('RUNNER_RELEASE_SIGNING_KEY is not an Ed25519 key');
  }
  const sig = crypto.sign(null, data, key);
  if (!crypto.verify(null, data, crypto.createPublicKey(publicPem), sig)) {
    throw new Error(
      'RUNNER_RELEASE_SIGNING_KEY does not match the public key pinned in src/releaseKey.ts; ' +
        'runners would refuse this release'
    );
  }
  const out = `${file}.sig`;
  fs.writeFileSync(out, `${sig.toString('base64')}\n`);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: sign-release.mjs <file>');
    process.exit(2);
  }
  const privatePem = process.env.RUNNER_RELEASE_SIGNING_KEY;
  if (!privatePem) {
    console.error(
      'sign-release: RUNNER_RELEASE_SIGNING_KEY is not set. Without it the release cannot be ' +
        'signed, and runners refuse an unsigned release.'
    );
    process.exit(1);
  }
  try {
    const out = signRelease(file, privatePem);
    console.log(`sign-release: wrote ${out}, verified against the pinned key.`);
  } catch (err) {
    console.error(`sign-release: ${err.message}`);
    process.exit(1);
  }
}
