import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { isRunnerBehind } from '@shared/all/helpers/runningJobs';

const PACKAGE_NAME = '@factiii/runner';

// Exit code the daemon worker uses to ask the supervisor to relaunch it after a
// self-update has installed new code on disk. Any other code means a real stop.
export const RESTART_FOR_UPDATE = 75; // EX_TEMPFAIL ("temporary failure, retry")

// Set by the supervisor on the daemon child so the same `start` invocation runs
// the worker instead of recursing into another supervisor.
const WORKER_ENV = 'FACTIII_RUNNER_WORKER';

// Set on a worker the supervisor relaunched because the last one exited with
// RESTART_FOR_UPDATE. Nobody typed that start, so it must not wait at the
// terminal for anything (see shouldPromptForUnlock).
const RELAUNCH_ENV = 'FACTIII_RUNNER_RELAUNCHED_FOR_UPDATE';

export function markWorkerEnv(
  env: NodeJS.ProcessEnv,
  relaunchAfterUpdate = false
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env, [WORKER_ENV]: '1' };
  // Set or cleared, never inherited: a `start` typed inside a terminal that a
  // relaunched worker spawned is a person again.
  if (relaunchAfterUpdate) next[RELAUNCH_ENV] = '1';
  else delete next[RELAUNCH_ENV];
  return next;
}

export function isRelaunchAfterUpdate(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env[RELAUNCH_ENV] === '1';
}

export function isWorker(): boolean {
  return process.env[WORKER_ENV] === '1';
}

/** The signals a person or a shutdown sends. */
const STOP_SIGNALS: (NodeJS.Signals | null)[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * Terminated by a signal (Ctrl-C / SIGTERM) → exit cleanly; otherwise
 * propagate the child's exit code.
 *
 * Any other signal is a crash (the kernel's out-of-memory kill is SIGKILL)
 * and must not read as a clean stop: the service (service.ts) restarts the
 * runner only after a failure.
 */
export function supervisorExitCode(
  status: number | null,
  signal: NodeJS.Signals | null
): number {
  if (signal) return STOP_SIGNALS.includes(signal) ? 0 : 1;
  return status ?? 0;
}

/** Version of the currently-installed package (read from its package.json). */
export function currentVersion(): string {
  try {
    // dist/cli.js (or src/ in tsx dev) sits one level under the package root,
    // next to package.json.
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Install the latest published version globally via npm. Returns true on
 * success. Runs synchronously so the daemon can exit for relaunch right after.
 *
 * Always installs `@latest` rather than a version handed in over the wire: the
 * approving client only decides *whether* to update, never *which* version, so
 * there's no way for a peer to pin an arbitrary/old build or inject into the
 * npm argument.
 */
/**
 * Would the published version even run on this host's Node?
 *
 * The update is approved from a phone or a browser, by someone who cannot see
 * the host's Node version — so the host has to check for them. Installing a
 * version this Node cannot start replaces working code with dead code, and the
 * runner goes offline with no way left to reach it.
 *
 * Only `engines.node` bounds of the shape `>=20` / `<25` / `<=24` are read.
 * An unparseable range means "no opinion" and the update proceeds: refusing on
 * a range we failed to read would strand runners on old versions forever.
 */
function hostSatisfiesTarget(): { ok: boolean; reason: string } {
  let engines = '';
  try {
    const res = spawnSync(
      'npm',
      ['view', `${PACKAGE_NAME}@latest`, 'engines.node'],
      { encoding: 'utf-8', shell: process.platform === 'win32' }
    );
    if (res.status !== 0) return { ok: true, reason: '' };
    engines = (res.stdout ?? '').trim();
  } catch {
    return { ok: true, reason: '' };
  }
  if (!engines) return { ok: true, reason: '' };

  const major = Number(process.versions.node.split('.')[0]);
  if (Number.isNaN(major)) return { ok: true, reason: '' };

  const min = /(?:>=|\^|~)\s*v?(\d+)/.exec(engines);
  if (min && major < Number(min[1])) {
    return {
      ok: false,
      reason: `it needs Node ${engines} and this host runs Node ${process.versions.node}`
    };
  }
  const lessThan = /<\s*v?(\d+)/.exec(engines);
  if (lessThan && major >= Number(lessThan[1])) {
    return {
      ok: false,
      reason: `it needs Node ${engines} and this host runs Node ${process.versions.node}`
    };
  }
  const atMost = /<=\s*v?(\d+)/.exec(engines);
  if (atMost && major > Number(atMost[1])) {
    return {
      ok: false,
      reason: `it needs Node ${engines} and this host runs Node ${process.versions.node}`
    };
  }
  return { ok: true, reason: '' };
}

/** npm's `latest` for the package, or null when npm cannot say. */
function publishedLatest(): string | null {
  try {
    const res = spawnSync('npm', ['view', `${PACKAGE_NAME}@latest`, 'version'], {
      encoding: 'utf-8',
      shell: process.platform === 'win32'
    });
    return res.status === 0 ? (res.stdout ?? '').trim() || null : null;
  } catch {
    return null;
  }
}

export function installLatest(): boolean {
  // Only ever forward. A release unpublished from npm stays "latest" in the
  // server's cache for up to an hour, so the app offers it while npm's own
  // latest is older: installing then put 0.33.0 runners back on 0.27.0, and
  // the banner offered the update again after every relaunch.
  const current = currentVersion();
  const latest = publishedLatest();
  if (latest && !isRunnerBehind(current, latest)) {
    console.error(
      `[update] npm's latest is ${latest} and this runner is on ${current}: ` +
        `nothing newer to install.`
    );
    return false;
  }
  const fit = hostSatisfiesTarget();
  if (!fit.ok) {
    console.error(
      `[update] refusing to install ${PACKAGE_NAME}@latest: ${fit.reason}.` +
        `\n[update] Staying on ${currentVersion()}. Install a supported Node ` +
        `(nvm install 24.11.1) and restart the runner to update.`
    );
    return false;
  }
  console.log(`[update] installing ${PACKAGE_NAME}@latest...`);
  const res = spawnSync('npm', ['install', '-g', `${PACKAGE_NAME}@latest`], {
    stdio: 'inherit',
    // On Windows npm is npm.cmd, which spawnSync can't exec without a shell.
    shell: process.platform === 'win32'
  });
  // EAGAIN: the OS refused a new process, so the user is at the per-user
  // process limit (processWatch.ts), not npm failing.
  if ((res.error as NodeJS.ErrnoException | undefined)?.code === 'EAGAIN') {
    console.error(
      `[update] process limit reached: the OS would not start npm. ` +
        `Close terminals and sessions you no longer use, then update. ` +
        `Staying on ${currentVersion()}.`
    );
    return false;
  }
  if (res.status !== 0) {
    console.error(
      `[update] npm install failed (exit ${res.status ?? 'signal'}). ` +
        `Staying on ${currentVersion()}.`
    );
    return false;
  }
  return true;
}
