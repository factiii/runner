import fs from 'node:fs';
import path from 'node:path';

// The decisions around the one unlock a runner with an old connection
// password needs after updating. Nothing of the runner is imported, so they
// can be tested without a daemon or a keychain.

/**
 * Whether `version` has never started in `dir` before, recording it so the
 * next start answers false.
 *
 * The supervisor's relaunch mark cannot cover the update that brings this code
 * in: that relaunch is done by the OLD supervisor, still in memory, which sets
 * no mark. A version that has not run here yet is the same fact seen from the
 * worker, and it is the update that needs the unlock.
 */
export function isFirstStartOfVersion(dir: string, version: string): boolean {
  const file = path.join(dir, 'last-started-version');
  let previous = '';
  try {
    previous = fs.readFileSync(file, 'utf-8').trim();
  } catch {
    // Never recorded.
  }
  if (previous === version) return false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, version);
  } catch {
    // Unwritable: the next start is "first" again, which only skips a prompt.
  }
  return true;
}

/**
 * Whether `start` should stop and ask for the password at the terminal.
 *
 * Only when files are actually locked, and only when a person started this
 * process: a worker the supervisor relaunched after a self-update inherits the
 * terminal but nobody is sitting at it - the owner tapped Update in the app -
 * so waiting there would keep the runner offline. It connects locked instead,
 * and the app asks for the password.
 */
export function shouldPromptForUnlock(opts: {
  needsUnlock: boolean;
  isTTY: boolean;
  relaunchedAfterUpdate: boolean;
}): boolean {
  return opts.needsUnlock && opts.isTTY && !opts.relaunchedAfterUpdate;
}

/**
 * Call `onUnlocked` once `stillLocked` first answers false, checking every
 * `intervalMs`, then stop checking. For an unlock the daemon is not told
 * about: `factiii-runner password` run in another process rewrites the files
 * on disk.
 */
export function watchForUnlock(
  stillLocked: () => boolean,
  onUnlocked: () => void,
  intervalMs: number
): void {
  const timer = setInterval(() => {
    if (stillLocked()) return;
    clearInterval(timer);
    onUnlocked();
  }, intervalMs);
}
