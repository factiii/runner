import crypto from 'crypto';
import os from 'os';
import path from 'path';

// Where a runner keeps ALL its state (config, spaces, secrets, npm-installed
// CLIs, the rendered plugin), and how it names its Keychain item.
//
// Default: ~/.factiii-runner and the Keychain account `config-encryption-key`
// - exactly what every runner used before. FACTIII_RUNNER_DIR moves both, so a
// dev runner (apps/runner `pnpm dev`, ~/.factiii-runner-dev) on the same Mac
// never reads or writes the real runner's files or its Keychain key.

export const RUNNER_DIR_ENV = 'FACTIII_RUNNER_DIR';
const DEFAULT_KEYCHAIN_ACCOUNT = 'config-encryption-key';

/** macOS caps a unix socket path at 104 bytes. The longest socket a runner
 *  makes is `<dir>/<space slug>/state/secrets.sock`; this leaves room for a
 *  40-character slug. */
export const MAX_RUNNER_DIR_LENGTH = 48;

export function defaultRunnerDir(): string {
  return path.join(os.homedir(), '.factiii-runner');
}

/** The env override, validated; null when unset (the default dir). */
function overrideDir(env: NodeJS.ProcessEnv): string | null {
  const raw = env[RUNNER_DIR_ENV]?.trim();
  if (!raw) return null;
  const dir = path.resolve(raw.replace(/^~(?=$|\/)/, os.homedir()));
  if (dir.length > MAX_RUNNER_DIR_LENGTH) {
    throw new Error(
      `${RUNNER_DIR_ENV} is ${dir.length} characters; keep it at ${MAX_RUNNER_DIR_LENGTH} or less so the runner's sockets stay under the 104-byte macOS limit.`
    );
  }
  return dir;
}

/** The runner's state dir: FACTIII_RUNNER_DIR, or ~/.factiii-runner. */
export function runnerDir(env: NodeJS.ProcessEnv = process.env): string {
  return overrideDir(env) ?? defaultRunnerDir();
}

/** The Keychain account for the at-rest key. The default dir keeps the
 *  original account; any other dir gets its own, named by a short hash of the
 *  dir, so two runners never share (or overwrite) one key. */
export function keychainAccount(env: NodeJS.ProcessEnv = process.env): string {
  const dir = overrideDir(env);
  if (!dir || dir === defaultRunnerDir()) return DEFAULT_KEYCHAIN_ACCOUNT;
  const hash = crypto
    .createHash('sha256')
    .update(dir)
    .digest('hex')
    .slice(0, 12);
  return `${DEFAULT_KEYCHAIN_ACCOUNT}:${hash}`;
}
