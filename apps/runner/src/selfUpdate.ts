import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isRunnerBehind } from '@shared/all/helpers/runningJobs';

import { RELEASE_PUBLIC_KEY, verifyReleaseSignature } from './releaseKey';
import { cancelPendingUpdate, prepareRollback } from './updateSafety';

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
function npmEngines(): string {
  try {
    const res = spawnSync(
      'npm',
      ['view', `${PACKAGE_NAME}@latest`, 'engines.node'],
      { encoding: 'utf-8', shell: process.platform === 'win32' }
    );
    return res.status === 0 ? (res.stdout ?? '').trim() : '';
  } catch {
    return '';
  }
}

function hostSatisfiesTarget(engines: string): { ok: boolean; reason: string } {
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

// ── GitHub Releases: the primary way in ────────────────────────────────────
//
// npm deleted or blocked every release after 0.27.0 (GHSA-9j83-qj34-g5vc), so
// each release is also a GitHub Release on the public source mirror, with the
// same tarball, a .sha256 and an Ed25519 .sig beside it
// (.github/workflows/release-runner.yml). It ships on every merge to main,
// while npm serves a version only once the owner approves it there (npm has no
// automated approval for a staged release), so it is the one runners prefer
// (`pickUpdateSource`). The .sig must verify against the
// key pinned in releaseKey.ts: whoever can publish a release on that repo
// still cannot make a runner install it without the signing key.
// The runner looks that release up itself: the approving client still decides
// only whether to update, never which version or from where.

export const RELEASES_REPO = 'factiii/runner';
const RELEASE_DOWNLOAD_PREFIX = `https://github.com/${RELEASES_REPO}/releases/download/`;
const SEMVER = /^\d+\.\d+\.\d+$/;

export type GithubRelease = {
  version: string;
  tarballUrl: string;
  sha256Url: string;
  /** Null on a release with no .sig (every one before signing began):
   *  downloadVerified then refuses it, saying why. */
  sigUrl: string | null;
};

/** The newest release's version and its assets, from the GitHub API's
 *  `releases/latest` body. Null unless the tag is a plain `vX.Y.Z` and the
 *  tarball and .sha256 are there under this repo's own download path; the
 *  .sig is read the same way, and its absence is downloadVerified's to
 *  refuse. */
export function parseGithubRelease(body: unknown): GithubRelease | null {
  if (!body || typeof body !== 'object') return null;
  const { tag_name: tag, assets } = body as {
    tag_name?: unknown;
    assets?: { name?: unknown; browser_download_url?: unknown }[];
  };
  if (typeof tag !== 'string' || !tag.startsWith('v')) return null;
  const version = tag.slice(1);
  if (!SEMVER.test(version) || !Array.isArray(assets)) return null;
  const tarballName = `factiii-runner-${version}.tgz`;
  const url = (name: string) => {
    const asset = assets.find((a) => a.name === name);
    const href = asset?.browser_download_url;
    return typeof href === 'string' && href.startsWith(RELEASE_DOWNLOAD_PREFIX)
      ? href
      : null;
  };
  const tarballUrl = url(tarballName);
  const sha256Url = url(`${tarballName}.sha256`);
  const sigUrl = url(`${tarballName}.sig`);
  return tarballUrl && sha256Url ? { version, tarballUrl, sha256Url, sigUrl } : null;
}

/** Where an update comes from: the signed GitHub Release when it is newer
 *  than this runner and at least as new as npm, else npm when that is newer
 *  than this runner; null when neither is ahead. A tie goes to GitHub: it
 *  ships on every merge with no step anyone has to take, and its .sig is
 *  checked against the pinned key, while npm serves a version only after the
 *  owner approves it there (Jon, 2026-11-13: the GitHub Release is the
 *  primary channel, npm the secondary). */
export function pickUpdateSource(
  current: string,
  npmLatest: string | null,
  githubLatest: string | null
): 'npm' | 'github' | null {
  const npmAhead = npmLatest !== null && isRunnerBehind(current, npmLatest);
  const githubAhead =
    githubLatest !== null &&
    isRunnerBehind(current, githubLatest) &&
    (npmLatest === null || !isRunnerBehind(githubLatest, npmLatest));
  if (githubAhead) return 'github';
  return npmAhead ? 'npm' : null;
}

/** The first SHA-256 in a .sha256 file (`sha256sum` output or a bare hash). */
export function parseSha256File(text: string): string | null {
  return /\b([a-f0-9]{64})\b/i.exec(text)?.[1]?.toLowerCase() ?? null;
}

type Fetch = typeof fetch;

async function githubLatestRelease(fetchImpl: Fetch = fetch): Promise<GithubRelease | null> {
  try {
    const res = await fetchImpl(
      `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`,
      {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'factiii-runner' },
        signal: AbortSignal.timeout(10_000)
      }
    );
    return res.ok ? parseGithubRelease(await res.json()) : null;
  } catch {
    return null;
  }
}

/** Download the release tarball and check it against its .sha256 and its
 *  .sig (an Ed25519 signature by `publicKey`, the pinned release key unless a
 *  test passes its own). Returns the local file, or null (and says why) when
 *  anything is missing or does not match. */
export async function downloadVerified(
  release: GithubRelease,
  fetchImpl: Fetch = fetch,
  publicKey: string = RELEASE_PUBLIC_KEY
): Promise<string | null> {
  try {
    const sigRes = release.sigUrl
      ? await fetchImpl(release.sigUrl, { signal: AbortSignal.timeout(30_000) })
      : null;
    const sig = sigRes?.ok ? await sigRes.text() : null;
    if (!sig) {
      console.error(
        `[update] the ${release.version} release is not signed (no .sig); not installing it.`
      );
      return null;
    }
    const sumRes = await fetchImpl(release.sha256Url, { signal: AbortSignal.timeout(30_000) });
    const want = sumRes.ok ? parseSha256File(await sumRes.text()) : null;
    if (!want) {
      console.error('[update] the release has no readable .sha256; not installing it.');
      return null;
    }
    const res = await fetchImpl(release.tarballUrl, { signal: AbortSignal.timeout(300_000) });
    if (!res.ok) {
      console.error(`[update] download failed (HTTP ${res.status}).`);
      return null;
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    const got = crypto.createHash('sha256').update(bytes).digest('hex');
    if (got !== want) {
      console.error('[update] the download does not match its .sha256; not installing it.');
      return null;
    }
    if (!verifyReleaseSignature(bytes, sig, publicKey)) {
      console.error(
        `[update] the ${release.version} release's signature does not verify against ` +
          'the pinned release key; not installing it.'
      );
      return null;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factiii-runner-update-'));
    const file = path.join(dir, `factiii-runner-${release.version}.tgz`);
    fs.writeFileSync(file, bytes);
    return file;
  } catch (err) {
    console.error(`[update] download failed: ${(err as Error).message}`);
    return null;
  }
}

/** `engines.node` from inside a downloaded tarball, '' when unreadable. */
function tarballEngines(file: string): string {
  try {
    const res = spawnSync('tar', ['-xzOf', file, 'package/package.json'], {
      encoding: 'utf-8'
    });
    if (res.status !== 0) return '';
    const pkg = JSON.parse(res.stdout) as { engines?: { node?: string } };
    return pkg.engines?.node ?? '';
  } catch {
    return '';
  }
}

/** The installed package's folder, or null on a source run (tsx), which has
 *  no package to pack for a rollback. */
function installedPackageDir(): string | null {
  return __filename.endsWith('.ts') ? null : path.join(__dirname, '..');
}

/** The version an update would install now, or null when nothing newer is
 *  out (or this runner updates with Factiii Desktop). For the automatic
 *  update's check; `installLatest` looks again itself. */
export async function latestAvailable(): Promise<string | null> {
  if (process.env.FACTIII_BUNDLED_RUNNER === '1') return null;
  const current = currentVersion();
  const npmLatest = publishedLatest();
  const github = await githubLatestRelease();
  const source = pickUpdateSource(current, npmLatest, github?.version ?? null);
  if (source === 'github') return github?.version ?? null;
  return source === 'npm' ? npmLatest : null;
}

/**
 * Install the newest release: the GitHub Release, or npm's `latest` when npm
 * is ahead of it (see the GitHub Releases note above). Resolves true on success,
 * and the daemon then exits for the supervisor to relaunch on the new code.
 *
 * Before npm replaces anything, the running version is packed and the runner
 * folder's files copied (updateSafety.ts `prepareRollback`), so the
 * supervisor can put them back when the new version fails to start. With
 * `requireRollback` (the automatic update) no copy means no update; an update
 * the owner approved goes on without one, and says so.
 *
 * Never a version handed in over the wire: the approving client only decides
 * *whether* to update, never *which* version or from where, so no peer can pin
 * an arbitrary or old build or inject into the npm argument. The GitHub path
 * installs only a tarball under this repo's own download URL whose SHA-256
 * matches the release's .sha256 and whose .sig verifies against the pinned
 * release key (releaseKey.ts).
 */
export async function installLatest(
  opts: { runnerDir?: string; requireRollback?: boolean } = {}
): Promise<boolean> {
  // The runner Factiii Desktop carries (Contents/Resources/runner, on the
  // app's Electron) updates with the app: npm would install a second runner
  // beside it that nothing runs.
  if (process.env.FACTIII_BUNDLED_RUNNER === '1') {
    console.error('[update] this runner ships inside Factiii Desktop and updates with the app.');
    return false;
  }
  // Only ever forward. A release unpublished from npm stays "latest" in the
  // server's cache until its next read, so the app offers it while npm's own
  // latest is older: installing then put 0.33.0 runners back on 0.27.0, and
  // the banner offered the update again after every relaunch.
  const current = currentVersion();
  const npmLatest = publishedLatest();
  const github = await githubLatestRelease();
  const source = pickUpdateSource(current, npmLatest, github?.version ?? null);
  if (!source) {
    console.error(
      `[update] npm's latest is ${npmLatest ?? 'unknown'}, the newest GitHub ` +
        `release is ${github?.version ?? 'unknown'}, and this runner is on ` +
        `${current}: nothing newer to install.`
    );
    return false;
  }

  let target = `${PACKAGE_NAME}@latest`;
  let engines = '';
  let tarball: string | null = null;
  if (source === 'github' && github) {
    console.log(`[update] downloading ${github.version} from the GitHub Release...`);
    tarball = await downloadVerified(github);
    if (!tarball) return false;
    target = tarball;
    engines = tarballEngines(tarball);
  } else {
    engines = npmEngines();
  }

  const fit = hostSatisfiesTarget(engines);
  if (!fit.ok) {
    console.error(
      `[update] refusing to install ${source === 'github' ? github?.version : `${PACKAGE_NAME}@latest`}: ${fit.reason}.` +
        `\n[update] Staying on ${current}. Install a supported Node ` +
        `(nvm install 24.11.1) and restart the runner to update.`
    );
    return false;
  }
  if (opts.runnerDir) {
    const pending = prepareRollback(opts.runnerDir, current, installedPackageDir());
    if (!pending.tarball) {
      if (opts.requireRollback) {
        cancelPendingUpdate(opts.runnerDir);
        if (tarball) fs.rmSync(path.dirname(tarball), { recursive: true, force: true });
        console.error(`[update] could not keep a copy of ${current} to roll back to; not updating automatically.`);
        return false;
      }
      console.warn(`[update] could not keep a copy of ${current}: a failed start cannot be rolled back.`);
    }
  }
  console.log(`[update] installing ${source === 'github' ? `${PACKAGE_NAME} ${github?.version} from GitHub` : `${PACKAGE_NAME}@latest`}...`);
  const res = spawnSync('npm', ['install', '-g', target], {
    stdio: 'inherit',
    // On Windows npm is npm.cmd, which spawnSync can't exec without a shell.
    shell: process.platform === 'win32'
  });
  if (tarball) fs.rmSync(path.dirname(tarball), { recursive: true, force: true });
  // EAGAIN: the OS refused a new process, so the user is at the per-user
  // process limit (processWatch.ts), not npm failing.
  if ((res.error as NodeJS.ErrnoException | undefined)?.code === 'EAGAIN') {
    if (opts.runnerDir) cancelPendingUpdate(opts.runnerDir);
    console.error(
      `[update] process limit reached: the OS would not start npm. ` +
        `Close terminals and sessions you no longer use, then update. ` +
        `Staying on ${current}.`
    );
    return false;
  }
  if (res.status !== 0) {
    // npm leaves the old version in place when an install fails.
    if (opts.runnerDir) cancelPendingUpdate(opts.runnerDir);
    console.error(
      `[update] npm install failed (exit ${res.status ?? 'signal'}). ` +
        `Staying on ${current}.`
    );
    return false;
  }
  return true;
}
