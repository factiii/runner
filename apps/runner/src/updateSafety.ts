import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type {
  RunnerAutoUpdateState,
  RunnerUpdateResult
} from '@shared/all/domains/runnerAutoUpdate';

// Self-update you can trust (.specs/runner-setup.md "Updates"): on by
// default, a copy to go back to before anything is replaced, and a rollback
// when the new version fails to start.
//
// Before `npm install -g` replaces the runner, `prepareRollback` packs the
// running version into `<runner dir>/updates/previous/` with a copy of the
// runner folder's own top-level files (spaces, access, parts, port blocks,
// ...; never the token or a key, NEVER_COPIED) and writes `pending.json`. The
// new version clears both once it is up (`markUpdateHealthy`: connected to
// the server, or alive for HEALTHY_AFTER_MS). If the worker dies before that,
// the supervisor, which is still the old code in memory, puts the old version
// and its files back (`rollBack`, which then deletes the copy), records the
// version as failed so automatic updates skip it, and starts the old version
// again.
//
// The last outcome is kept for Software > "Update automatically"
// (`readAutoUpdateState`): the last install or rollback in `last.json`, the
// last skip and why in `last-skip.json`, so a skip every few hours never
// overwrites what the last update did.
//
// Only node built-ins here (and types): the supervisor calls rollBack after
// npm has replaced the files on disk, so nothing may be loaded lazily from
// them.

/** A new version that has run this long without crashing is up. */
export const HEALTHY_AFTER_MS = 2 * 60_000;

/** Files a rollback never puts back: `config.json` holds the runner token,
 *  which the new version may already have rotated (an old refresh token
 *  sent again ends the pairing, .specs/runner-link.md "Reuse"). */
const NEVER_RESTORED = new Set(['config.json']);

/** Files never copied into `updates/previous/`: those a rollback does not put
 *  back, and the runner's keys (`runner-cloud.key`, RUNNER_CLOUD_KEY_FILE in
 *  vault/runnerCloudKey.ts; Windows' `config-key.dpapi`; the sealed
 *  `age-identity.enc`), which an update leaves where they are. A copy would
 *  only be a second copy of a secret on disk. */
const NEVER_COPIED = new Set([
  ...NEVER_RESTORED,
  'runner-cloud.key',
  'config-key.dpapi',
  'age-identity.enc'
]);

/** A top-level file bigger than this is not the runner's own state. */
const MAX_STATE_FILE_BYTES = 5 * 1024 * 1024;

/** How many failed versions are remembered. */
const MAX_FAILED = 10;

export type PendingUpdate = {
  /** The version being replaced. */
  from: string;
  /** When the install started (ms). */
  at: number;
  /** The packed copy of `from`, if one could be made. */
  tarball: string | null;
};

export type FailedUpdate = { version: string; at: number; reason: string };

export type UpdateSettings = { auto: boolean };

/** Runs `npm` with these arguments; true on exit 0. */
export type NpmRun = (args: string[], cwd?: string) => boolean;

const updatesDir = (runnerDir: string) => path.join(runnerDir, 'updates');
const previousDir = (runnerDir: string) => path.join(updatesDir(runnerDir), 'previous');
const pendingFile = (runnerDir: string) => path.join(updatesDir(runnerDir), 'pending.json');
const failedFile = (runnerDir: string) => path.join(updatesDir(runnerDir), 'failed.json');
const settingsFile = (runnerDir: string) => path.join(updatesDir(runnerDir), 'settings.json');
const lastFile = (runnerDir: string) => path.join(updatesDir(runnerDir), 'last.json');
const lastSkipFile = (runnerDir: string) => path.join(updatesDir(runnerDir), 'last-skip.json');

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export const realNpm: NpmRun = (args, cwd) => {
  const res = spawnSync('npm', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf-8',
    // On Windows npm is npm.cmd, which spawnSync can't exec without a shell.
    shell: process.platform === 'win32'
  });
  return res.status === 0;
};

// ── Settings ────────────────────────────────────────────────────────────

/** `FACTIII_RUNNER_AUTO_UPDATE` is `0`/`off`/`false`: off on this machine,
 *  whatever the saved setting says. */
export function autoUpdateForcedOff(env: NodeJS.ProcessEnv = process.env): boolean {
  const forced = env.FACTIII_RUNNER_AUTO_UPDATE?.trim().toLowerCase();
  return forced === '0' || forced === 'off' || forced === 'false';
}

/** Whether the runner updates itself. On unless the owner turned it off
 *  (`factiii-runner update auto off`, or the Software tab's switch) or
 *  `FACTIII_RUNNER_AUTO_UPDATE` is `0`/`off`/`false`. */
export function readUpdateSettings(
  runnerDir: string,
  env: NodeJS.ProcessEnv = process.env
): UpdateSettings {
  if (autoUpdateForcedOff(env)) return { auto: false };
  const saved = readJson<Partial<UpdateSettings>>(settingsFile(runnerDir));
  return { auto: saved?.auto !== false };
}

export function writeUpdateSettings(runnerDir: string, settings: UpdateSettings): void {
  writeJson(settingsFile(runnerDir), settings);
}

// ── The last outcome ────────────────────────────────────────────────────

const isUpdateResult = (r: unknown): r is RunnerUpdateResult => {
  if (!r || typeof r !== 'object') return false;
  const { kind, version, at } = r as Record<string, unknown>;
  return (
    (kind === 'installed' || kind === 'rolled-back' || kind === 'skipped') &&
    typeof version === 'string' &&
    typeof at === 'number'
  );
};

const readResult = (file: string): RunnerUpdateResult | null => {
  const last = readJson<unknown>(file);
  return isUpdateResult(last) ? last : null;
};

/** The last install or rollback. */
export function readLastUpdate(runnerDir: string): RunnerUpdateResult | null {
  const last = readResult(lastFile(runnerDir));
  return last?.kind === 'skipped' ? null : last;
}

/** The last look that found a release and did not install it. A runner
 *  from before `last-skip.json` wrote its skips to `last.json`. */
export function readLastSkip(runnerDir: string): RunnerUpdateResult | null {
  const skip = readResult(lastSkipFile(runnerDir));
  if (skip?.kind === 'skipped') return skip;
  const old = readResult(lastFile(runnerDir));
  return old?.kind === 'skipped' ? old : null;
}

/** Best effort: a record that cannot be written never stops an update. A
 *  skip goes to its own file, so it never replaces an install or rollback. */
export function recordLastUpdate(runnerDir: string, result: RunnerUpdateResult): void {
  try {
    writeJson(result.kind === 'skipped' ? lastSkipFile(runnerDir) : lastFile(runnerDir), result);
  } catch {
    // The update itself is what matters.
  }
}

/** What Software > "Update automatically" shows (`autoUpdateGet`). */
export function readAutoUpdateState(
  runnerDir: string,
  env: NodeJS.ProcessEnv = process.env
): RunnerAutoUpdateState {
  const bundled = env.FACTIII_BUNDLED_RUNNER === '1';
  return {
    auto: !bundled && readUpdateSettings(runnerDir, env).auto,
    forcedByEnv: autoUpdateForcedOff(env),
    bundled,
    lastResult: readLastUpdate(runnerDir),
    lastSkip: readLastSkip(runnerDir)
  };
}

/** The owner's switch (`autoUpdateSet`): saved as `update auto on|off`
 *  saves it. Refused where the switch would change nothing. */
export function setAutoUpdate(
  runnerDir: string,
  auto: boolean,
  env: NodeJS.ProcessEnv = process.env
): RunnerAutoUpdateState {
  if (env.FACTIII_BUNDLED_RUNNER === '1') {
    throw new Error('This runner comes with Factiii Desktop and updates with the app.');
  }
  if (autoUpdateForcedOff(env)) {
    throw new Error(
      'FACTIII_RUNNER_AUTO_UPDATE turns automatic updates off on this machine. Remove it from the runner’s environment first.'
    );
  }
  writeUpdateSettings(runnerDir, { auto });
  return readAutoUpdateState(runnerDir, env);
}

// ── Failed versions ─────────────────────────────────────────────────────

export function failedUpdates(runnerDir: string): FailedUpdate[] {
  const list = readJson<unknown>(failedFile(runnerDir));
  if (!Array.isArray(list)) return [];
  return list.filter(
    (f): f is FailedUpdate =>
      !!f &&
      typeof (f as FailedUpdate).version === 'string' &&
      typeof (f as FailedUpdate).at === 'number'
  );
}

export function hasFailed(runnerDir: string, version: string): boolean {
  return failedUpdates(runnerDir).some((f) => f.version === version);
}

function recordFailed(runnerDir: string, failed: FailedUpdate): void {
  const rest = failedUpdates(runnerDir).filter((f) => f.version !== failed.version);
  writeJson(failedFile(runnerDir), [failed, ...rest].slice(0, MAX_FAILED));
}

// ── Before the install ──────────────────────────────────────────────────

export function readPendingUpdate(runnerDir: string): PendingUpdate | null {
  const pending = readJson<PendingUpdate>(pendingFile(runnerDir));
  return pending && typeof pending.from === 'string' ? pending : null;
}

/** The runner folder's own top-level files: small regular files only, never
 *  a folder (boards, the Vault, logs) or a socket, nor the token or a key
 *  (NEVER_COPIED). */
function stateFiles(runnerDir: string): string[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(runnerDir);
  } catch {
    return [];
  }
  return names.filter((name) => {
    if (NEVER_COPIED.has(name)) return false;
    try {
      const stat = fs.lstatSync(path.join(runnerDir, name));
      return stat.isFile() && stat.size <= MAX_STATE_FILE_BYTES;
    } catch {
      return false;
    }
  });
}

/**
 * Make the way back before an update: pack the running version
 * (`packageDir`, the installed package) and copy the runner folder's
 * top-level files, then write `pending.json`. Returns the pending record;
 * its `tarball` is null when the version could not be packed (a source run,
 * or npm failing), and the caller decides whether to go on without it.
 */
export function prepareRollback(
  runnerDir: string,
  current: string,
  packageDir: string | null,
  npm: NpmRun = realNpm,
  now = Date.now()
): PendingUpdate {
  const dir = previousDir(runnerDir);
  fs.rmSync(dir, { recursive: true, force: true });
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  for (const name of stateFiles(runnerDir)) {
    try {
      fs.copyFileSync(path.join(runnerDir, name), path.join(stateDir, name));
      fs.chmodSync(path.join(stateDir, name), 0o600);
    } catch {
      // A file that went away is not state to restore.
    }
  }
  let tarball: string | null = null;
  if (packageDir) {
    // --ignore-scripts: the installed package has no build to run, and a
    // prepack script would rebuild from sources it does not ship.
    const packed = npm(['pack', '--ignore-scripts', '--pack-destination', dir], packageDir);
    const file = path.join(dir, `factiii-runner-${current}.tgz`);
    if (packed && fs.existsSync(file)) tarball = file;
  }
  const pending: PendingUpdate = { from: current, at: now, tarball };
  writeJson(pendingFile(runnerDir), pending);
  return pending;
}

const removePending = (runnerDir: string) =>
  fs.rmSync(pendingFile(runnerDir), { force: true });

/** The copy of the old version and its files, once nothing can go back to
 *  it. Best effort: a copy left behind is replaced by the next update's. */
const removePrevious = (runnerDir: string) => {
  try {
    fs.rmSync(previousDir(runnerDir), { recursive: true, force: true });
  } catch {
    // The update's outcome stands either way.
  }
};

/** The install did not happen: nothing to roll back to. */
export function cancelPendingUpdate(runnerDir: string): void {
  removePending(runnerDir);
  removePrevious(runnerDir);
}

/** The new version is up: the update stays, and the copy of the old one
 *  goes. With `version` (the one now running) it is recorded as the last
 *  outcome. */
export function markUpdateHealthy(
  runnerDir: string,
  version?: string,
  now = Date.now()
): boolean {
  const pending = readPendingUpdate(runnerDir);
  if (!pending) return false;
  cancelPendingUpdate(runnerDir);
  if (version) {
    recordLastUpdate(runnerDir, { kind: 'installed', version, from: pending.from, at: now });
  }
  return true;
}

// ── After the worker exits ──────────────────────────────────────────────

export type WorkerExitDecision = 'relaunch' | 'rollback' | 'exit';

/** What the supervisor does when its worker exits: relaunch on the update
 *  exit code, roll back a worker that failed before it was up after an
 *  update, else stop with the worker's code. */
export function decideAfterWorkerExit(input: {
  restartForUpdate: boolean;
  exitCode: number;
  pending: PendingUpdate | null;
}): WorkerExitDecision {
  if (input.restartForUpdate) return 'relaunch';
  if (input.exitCode !== 0 && input.pending) return 'rollback';
  return 'exit';
}

/**
 * Put the version from before the update back: install its packed copy,
 * restore the runner folder's files (but `config.json`), and record
 * `failedVersion` so automatic updates skip it; once the old version is back,
 * that is the last outcome too. True when the old version is
 * installed again.
 */
export function rollBack(
  runnerDir: string,
  pending: PendingUpdate,
  failedVersion: string,
  reason: string,
  npm: NpmRun = realNpm,
  now = Date.now()
): boolean {
  recordFailed(runnerDir, { version: failedVersion, at: now, reason });
  // Only pending.json: the copy is what goes back below.
  removePending(runnerDir);
  if (!pending.tarball || !fs.existsSync(pending.tarball)) return false;
  if (!npm(['install', '-g', pending.tarball])) return false;
  const stateDir = path.join(previousDir(runnerDir), 'state');
  let names: string[] = [];
  try {
    names = fs.readdirSync(stateDir);
  } catch {
    // No copy: the files stay as the new version left them.
  }
  for (const name of names) {
    if (NEVER_RESTORED.has(name)) continue;
    try {
      fs.copyFileSync(path.join(stateDir, name), path.join(runnerDir, name));
    } catch {
      // Best effort: the rest still go back.
    }
  }
  removePrevious(runnerDir);
  // Only once the old version is back: the line says the runner went back.
  recordLastUpdate(runnerDir, {
    kind: 'rolled-back',
    version: failedVersion,
    from: pending.from,
    at: now,
    reason
  });
  return true;
}
