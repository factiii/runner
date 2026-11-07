import fs from 'node:fs';
import os from 'node:os';

import type { RunnerServerReadiness } from '@shared/all/domains/electron';
import { readLidGrant } from '@shared/all/helpers/lidGrant';
import {
  LID_AWAKE_FILE,
  parseLidAwakeFile,
  parsePmsetSettings,
  readinessChecks,
  readRemoteAccess
} from '@shared/all/helpers/serverReadiness';

import type { KeepAwake } from './keepAwake';

// The real machine behind "Ready to be a server": `pmset -g`, automatic
// login, FileVault and whether there is a battery. Read-only, and no admin:
// fixing these is the desktop app's, behind macOS's own prompt. Whether the
// lid-closed grant is there is `sudo -n -l`, which lists and never prompts.

type Run = (
  bin: string,
  args: string[],
  opts?: { timeoutMs?: number }
) => Promise<{ code: number; output: string }>;

const READ_TIMEOUT_MS = 3000;
/** These settings rarely change, and health is read every 30 s while Status
 *  is open: four processes a read add up on a Mac near its process cap. */
const CACHE_MS = 60_000;

let cached: { at: number; value: Omit<RunnerServerReadiness, 'keepAwake'> } | null =
  null;

function fileVaultOn(output: string): boolean | null {
  if (/FileVault is On/.test(output)) return true;
  if (/FileVault is Off/.test(output)) return false;
  return null;
}

/** Null off macOS: the checks are a Mac's. */
export async function serverReadiness(
  run: Run,
  keepAwake: KeepAwake
): Promise<RunnerServerReadiness | null> {
  if (process.platform !== 'darwin') return null;
  // Keep-awake is the runner's own state: always live.
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return { ...cached.value, keepAwake: keepAwake.state() };
  }
  const opts = { timeoutMs: READ_TIMEOUT_MS };
  const [pmset, login, fileVault, battery, lidGrant] = await Promise.all([
    run('pmset', ['-g'], opts),
    run(
      'defaults',
      ['read', '/Library/Preferences/com.apple.loginwindow', 'autoLoginUser'],
      opts
    ),
    run('fdesetup', ['status'], opts),
    run('pmset', ['-g', 'batt'], opts),
    readLidGrant((bin, args) => run(bin, args, opts))
  ]);
  const remote = await readRemoteAccess((bin, args) => run(bin, args, opts));
  const reading = pmset.code === 0 ? parsePmsetSettings(pmset.output) : null;
  let lidFile: string | null = null;
  try {
    lidFile = fs.readFileSync(LID_AWAKE_FILE, 'utf-8');
  } catch {
    // No timer was set.
  }
  const lidOn = reading?.sleepDisabled ?? false;
  const value = {
    host: os.hostname(),
    laptop: /InternalBattery/.test(battery.output),
    checks: readinessChecks({
      pmset: reading,
      autoLoginUser: login.code === 0 ? login.output.trim() || null : null,
      fileVault: fileVaultOn(fileVault.output),
      remote
    }),
    tailscaleIp: remote.tailscaleIp,
    screenLocked: remote.screenLocked,
    lidAwake: { on: lidOn, until: lidOn ? parseLidAwakeFile(lidFile) : null },
    lidGrant
  };
  cached = { at: Date.now(), value };
  return { ...value, keepAwake: keepAwake.state() };
}
