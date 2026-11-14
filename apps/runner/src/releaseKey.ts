import crypto from 'node:crypto';

/**
 * The public half of the key that signs every GitHub Release of the runner
 * (.github/workflows/release-runner.yml, scripts/sign-release.mjs). A runner
 * installs a release from GitHub only when `factiii-runner-<v>.tgz.sig` is an
 * Ed25519 signature by this key over the tarball's exact bytes: the .sha256
 * beside it proves only that the download is whole, not who made it.
 *
 * The private key is the RUNNER_RELEASE_SIGNING_KEY Actions secret on
 * jsnyder10/factiii; the owner keeps its backup outside the repo. Rotating
 * it means pinning the new key here in a release still signed by the old one,
 * so every runner trusts the new key only through a release it already
 * trusts.
 *
 * scripts/sign-release.mjs reads the key from this file, and
 * apps/factiii-web/public/runner.sh carries a copy (releaseKey.test.ts keeps
 * the two in step).
 */
export const RELEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA5SeTCl4AhL9iRX/CbQ6n4l9KNdmedqcWeg97fqjBDN4=
-----END PUBLIC KEY-----
`;

/** An Ed25519 signature is always 64 bytes. */
const SIGNATURE_BYTES = 64;

/** Is `sigText` (the .sig file: base64, whitespace allowed) a valid
 *  signature by `publicKey` over `data`? False on anything unreadable. */
export function verifyReleaseSignature(
  data: Buffer,
  sigText: string,
  publicKey: string = RELEASE_PUBLIC_KEY
): boolean {
  try {
    const compact = sigText.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return false;
    const sig = Buffer.from(compact, 'base64');
    if (sig.length !== SIGNATURE_BYTES) return false;
    const key = crypto.createPublicKey(publicKey);
    if (key.asymmetricKeyType !== 'ed25519') return false;
    return crypto.verify(null, data, key, sig);
  } catch {
    return false;
  }
}
