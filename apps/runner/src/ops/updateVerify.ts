import { execFile } from 'node:child_process';
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';

import { execExitCode } from '@shared/all/helpers/execExitCode';

// What the ops service checks before it installs a Factiii release
// (.specs/ops-user.md, "Updates"), and the swap with its health check and
// rollback. The ops service installs only these; an update that fails a
// check is deleted, never staged.

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (cmd: string, args: string[]) => Promise<ExecResult>;

export type Verdict = { ok: true } | { ok: false; reason: string };

export const realExec: Exec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = execExitCode(err);
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

const TEAM_ID = /^[A-Z0-9]{10}$/;

/**
 * A macOS app bundle: a valid deep signature, the pinned team, a Developer ID
 * Application chain, and Gatekeeper's word that it is notarized.
 * codesign and spctl print their findings on stderr.
 */
export async function verifyMacApp(
  appPath: string,
  opts: { teamId: string; exec?: Exec }
): Promise<Verdict> {
  if (!TEAM_ID.test(opts.teamId)) return { ok: false, reason: 'no team id pinned' };
  const exec = opts.exec ?? realExec;
  const strict = await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  if (strict.code !== 0) {
    return { ok: false, reason: `signature invalid: ${lastLine(strict.stderr)}` };
  }
  const info = await exec('/usr/bin/codesign', ['-dv', '--verbose=4', appPath]);
  const details = `${info.stdout}\n${info.stderr}`;
  const team = /^TeamIdentifier=(.+)$/m.exec(details)?.[1]?.trim();
  if (!team || team === 'not set') return { ok: false, reason: 'unsigned (no team)' };
  if (team !== opts.teamId) return { ok: false, reason: `signed by team ${team}, not ${opts.teamId}` };
  if (!/^Authority=Developer ID Application: /m.test(details)) {
    return { ok: false, reason: 'not a Developer ID Application signature' };
  }
  const gate = await exec('/usr/sbin/spctl', ['--assess', '--type', 'execute', '-vv', appPath]);
  const verdict = `${gate.stdout}\n${gate.stderr}`;
  if (gate.code !== 0 || !/: accepted$/m.test(verdict)) {
    return { ok: false, reason: `Gatekeeper rejected it: ${lastLine(verdict)}` };
  }
  if (!/^source=Notarized Developer ID$/m.test(verdict)) {
    return { ok: false, reason: 'not notarized' };
  }
  return { ok: true };
}

/** A Linux tarball: an ed25519 signature over its sha256, with the public
 *  key pinned in the running release. */
export function verifyLinuxTarball(
  tarball: Buffer,
  signatureBase64: string,
  publicKeyPem: string
): Verdict {
  let key;
  try {
    key = createPublicKey(publicKeyPem);
  } catch {
    return { ok: false, reason: 'no usable public key pinned' };
  }
  if (key.asymmetricKeyType !== 'ed25519') return { ok: false, reason: 'pinned key is not ed25519' };
  const digest = createHash('sha256').update(tarball).digest();
  const signature = Buffer.from(signatureBase64, 'base64');
  return verifySignature(null, digest, key, signature)
    ? { ok: true }
    : { ok: false, reason: 'signature does not match' };
}

/** Windows: `Get-AuthenticodeSignature <exe> | ConvertTo-Json` (Status 0 or
 *  "Valid"), signed by the pinned certificate thumbprint. */
export function verifyAuthenticode(json: string, opts: { thumbprint: string }): Verdict {
  let parsed: { Status?: unknown; SignerCertificate?: { Thumbprint?: unknown } };
  try {
    parsed = JSON.parse(json) as typeof parsed;
  } catch {
    return { ok: false, reason: 'unreadable signature report' };
  }
  if (parsed.Status !== 0 && parsed.Status !== 'Valid') return { ok: false, reason: 'signature not valid' };
  const thumb = String(parsed.SignerCertificate?.Thumbprint ?? '').toUpperCase();
  if (!thumb || thumb !== opts.thumbprint.toUpperCase()) {
    return { ok: false, reason: 'signed by another certificate' };
  }
  return { ok: true };
}

/**
 * Verify, swap, restart, health-check; on a failed check put the previous
 * release back and restart again. Each step is the host's (a rename of
 * /Applications/Factiii.app, launchctl kickstart, `ops health`).
 */
export async function installRelease(steps: {
  verify: () => Promise<Verdict>;
  discard: () => Promise<void>;
  swap: () => Promise<void>;
  restart: () => Promise<void>;
  health: () => Promise<boolean>;
  rollback: () => Promise<void>;
  log?: (line: string) => void;
}): Promise<{ ok: true } | { ok: false; reason: string; rolledBack: boolean }> {
  const log = steps.log ?? (() => undefined);
  const verdict = await steps.verify();
  if (!verdict.ok) {
    await steps.discard();
    log(`update refused: ${verdict.reason}`);
    return { ok: false, reason: verdict.reason, rolledBack: false };
  }
  await steps.swap();
  await steps.restart();
  if (await steps.health()) return { ok: true };
  log('update failed its health check; rolling back');
  await steps.rollback();
  await steps.restart();
  return { ok: false, reason: 'health check failed', rolledBack: true };
}

function lastLine(text: string): string {
  return text.trim().split('\n').pop() ?? '';
}
