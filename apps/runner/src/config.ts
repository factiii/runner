import fs from 'fs';
import path from 'path';

import { CONFIG_DIR as RUNNER_CONFIG_DIR } from './paths';
import { readBootJson, writeBootJson } from './secureFile';

export interface RunnerConfig {
  serverUrl: string;
  authToken: string;
  runnerName: string;
  /** The refresh token (`frr_...`): what buys the next access token, replaced
   *  on every refresh. ON DISK ONLY. The daemon takes it off this object at
   *  start (takeRefreshToken, runnerToken.ts) and keeps it in a variable of
   *  its own, so nothing that receives the config - an engine, a session, a
   *  tunnel, a log line - can carry it. Absent on a runner
   *  paired before refresh tokens until its first refresh. */
  refreshToken?: string;
}

const CONFIG_DIR = RUNNER_CONFIG_DIR;
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// `authToken` is the bearer JWT for this runner - non-expiring from an older
// pairing, expiring and refreshed over the server socket otherwise (the daemon
// writes each new one back here, with the refresh token). It gets the
// same at-rest treatment as the connection tokens - but under the machine
// keychain ONLY, never the owner password. The runner needs this to connect,
// and the unlock prompt arrives over that same connection; putting it in the
// lockable vault would mean a password-protected runner could never come back
// after a restart. Existing plaintext configs migrate on the first read - no
// re-pairing.
export function readRunnerConfig(): RunnerConfig | null {
  return readBootJson<RunnerConfig>(CONFIG_FILE);
}

export function writeRunnerConfig(config: RunnerConfig): void {
  writeBootJson(CONFIG_FILE, config);
}

export function configExists(): boolean {
  return fs.existsSync(CONFIG_FILE);
}
