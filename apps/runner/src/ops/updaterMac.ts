import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import type { Release, StageResult } from './updater';
import { type Exec, installRelease, realExec, type Verdict, verifyMacApp } from './updateVerify';

// The macOS half of the ops updater (updater.ts): where releases come from,
// how one is staged and verified, and the swap helper. The app bundle is
// factiii-ops' own (the setup chowned it) but /Applications is not, so the
// swap renames the bundle's Contents, not the bundle: `Factiii.app/Contents`
// goes to `<ops home>/releases/previous/Contents` (same volume) and the
// staged release's Contents take its place. Rollback is the same two renames
// back.

const RELEASES = 'https://github.com/factiii/desktop-releases/releases';
/** The health check's window after a restart (spec: 60 s). */
const HEALTH_MS = 60_000;

/** `latest-mac.yml` (electron-builder): the version and the arm64 zip. */
export function parseLatestMacYml(text: string): Release | null {
  const version = /^version:\s*['"]?([0-9][0-9A-Za-z.-]*)['"]?\s*$/m.exec(text)?.[1];
  if (!version) return null;
  const files = [...text.matchAll(/^\s*-\s*url:\s*(\S+)\s*\n\s*sha512:\s*(\S+)/gm)];
  const zip = files.find(([, url]) => /arm64.*\.zip$/.test(url ?? '')) ?? files.find(([, url]) => /\.zip$/.test(url ?? ''));
  if (!zip?.[1] || !zip[2] || !/^[\w.-]+$/.test(zip[1])) return null;
  return { version, url: `${RELEASES}/download/v${version}/${zip[1]}`, sha512: zip[2] };
}

export async function fetchLatestMac(fetchImpl: typeof fetch = fetch): Promise<Release | null> {
  const res = await fetchImpl(`${RELEASES}/latest/download/latest-mac.yml`, {
    headers: { 'user-agent': 'factiii-ops' },
    signal: AbortSignal.timeout(15_000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseLatestMacYml(await res.text());
}

/** The bundle's CFBundleShortVersionString, or null. */
export function bundleVersion(app: string): string | null {
  try {
    const plist = fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf-8');
    return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The team that signed the running app: the one a release must match.
 *  An unsigned (dev) build has none, so it installs no update. */
export async function runningTeam(app: string, exec: Exec = realExec): Promise<string | null> {
  const info = await exec('/usr/bin/codesign', ['-dv', '--verbose=4', app]);
  const team = /^TeamIdentifier=(.+)$/m.exec(`${info.stdout}\n${info.stderr}`)?.[1]?.trim();
  return team && team !== 'not set' ? team : null;
}

export function releaseDirs(opsHome: string): { root: string; staged: string; previous: string; failed: string } {
  const root = path.join(opsHome, 'releases');
  return {
    root,
    staged: path.join(root, 'staged'),
    previous: path.join(root, 'previous'),
    failed: path.join(root, 'failed')
  };
}

/** Download, hash, unpack and verify. Anything that fails is deleted. */
export async function stageMacRelease(opts: {
  release: Release;
  opsHome: string;
  app: string;
  fetchImpl?: typeof fetch;
  exec?: Exec;
}): Promise<StageResult> {
  const exec = opts.exec ?? realExec;
  const dirs = releaseDirs(opts.opsHome);
  fs.rmSync(dirs.staged, { recursive: true, force: true });
  fs.mkdirSync(dirs.staged, { recursive: true, mode: 0o700 });
  const refuse = (reason: string): StageResult => {
    fs.rmSync(dirs.staged, { recursive: true, force: true });
    return { ok: false, reason };
  };
  const team = await runningTeam(opts.app, exec);
  if (!team) return refuse('the running app is not signed by a team (a dev build installs no updates)');
  const res = await (opts.fetchImpl ?? fetch)(opts.release.url, { signal: AbortSignal.timeout(15 * 60_000) });
  if (!res.ok) return refuse(`download failed (HTTP ${res.status})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (createHash('sha512').update(bytes).digest('base64') !== opts.release.sha512) {
    return refuse('the download does not match its sha512');
  }
  const zip = path.join(dirs.staged, 'release.zip');
  fs.writeFileSync(zip, bytes, { mode: 0o600 });
  const unzip = await exec('/usr/bin/ditto', ['-x', '-k', zip, dirs.staged]);
  fs.rmSync(zip, { force: true });
  if (unzip.code !== 0) return refuse(`could not unpack it: ${unzip.stderr.trim()}`);
  const bundle = fs.readdirSync(dirs.staged).find((f) => f.endsWith('.app'));
  if (!bundle) return refuse('the zip holds no app');
  const staged = path.join(dirs.staged, bundle);
  const verdict = await verifyMacApp(staged, { teamId: team, exec });
  if (!verdict.ok) return refuse(verdict.reason);
  return { ok: true, staged };
}

/** Start the swap helper (`ops apply-update`) from the running release. It
 *  outlives this process (the plist's AbandonProcessGroup), stops it, and
 *  launchd's KeepAlive starts the new one. */
export function spawnApplyHelper(opts: { app: string; staged: string; opsHome: string; runDir: string }): void {
  const log = fs.openSync(path.join(opts.opsHome, 'logs', 'update.log'), 'a', 0o600);
  const child = spawn(
    process.execPath,
    [
      path.resolve(process.argv[1] ?? ''),
      'ops',
      'apply-update',
      '--app',
      opts.app,
      '--staged',
      opts.staged,
      '--home',
      opts.opsHome,
      '--run',
      opts.runDir,
      '--pid',
      String(process.pid)
    ],
    { detached: true, stdio: ['ignore', log, log], env: process.env }
  );
  child.unref();
}

/** Every token newer than `since` and the socket answering with a
 *  challenge: the new release loaded its boards and serves. */
export async function opsHealthy(runDir: string, since: number, socketPath: string): Promise<boolean> {
  const tokens = path.join(runDir, 'boards');
  let files: string[] = [];
  try {
    files = fs.readdirSync(tokens).filter((f) => f.endsWith('.token'));
  } catch {
    return false;
  }
  if (!files.length || !files.every((f) => fs.statSync(path.join(tokens, f)).mtimeMs >= since)) return false;
  return new Promise((resolve) => {
    const conn = net.createConnection(socketPath);
    const done = (ok: boolean) => {
      conn.destroy();
      resolve(ok);
    };
    conn.once('data', (chunk: Buffer) => done(chunk.toString('utf-8').includes('"challenge"')));
    conn.once('error', () => done(false));
    setTimeout(() => done(false), 5_000);
  });
}

/** `ops apply-update`: verify again, swap, restart, health, roll back. */
export async function applyMacUpdate(opts: {
  app: string;
  staged: string;
  opsHome: string;
  runDir: string;
  pid: number;
  exec?: Exec;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  healthy?: (since: number) => Promise<boolean>;
}): Promise<Awaited<ReturnType<typeof installRelease>>> {
  const dirs = releaseDirs(opts.opsHome);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const contents = path.join(opts.app, 'Contents');
  let restartedAt = 0;
  const restart = async () => {
    restartedAt = Date.now();
    try {
      process.kill(opts.pid, 'SIGTERM');
    } catch {
      // Already gone: launchd is starting the next one.
    }
  };
  return installRelease({
    verify: async (): Promise<Verdict> => {
      const team = await runningTeam(opts.app, opts.exec);
      return team ? verifyMacApp(opts.staged, { teamId: team, exec: opts.exec }) : { ok: false, reason: 'no team pinned' };
    },
    discard: async () => fs.rmSync(dirs.staged, { recursive: true, force: true }),
    swap: async () => {
      fs.rmSync(dirs.previous, { recursive: true, force: true });
      fs.mkdirSync(dirs.previous, { recursive: true, mode: 0o700 });
      fs.renameSync(contents, path.join(dirs.previous, 'Contents'));
      fs.renameSync(path.join(opts.staged, 'Contents'), contents);
      fs.rmSync(dirs.staged, { recursive: true, force: true });
    },
    restart,
    health: async () => {
      const healthy = opts.healthy ?? ((since: number) => opsHealthy(opts.runDir, since, path.join(opts.runDir, 'ops.sock')));
      for (let waited = 0; waited < HEALTH_MS; waited += 2_000) {
        await sleep(2_000);
        if (await healthy(restartedAt)) return true;
      }
      return false;
    },
    rollback: async () => {
      fs.rmSync(dirs.failed, { recursive: true, force: true });
      fs.mkdirSync(dirs.failed, { recursive: true, mode: 0o700 });
      fs.renameSync(contents, path.join(dirs.failed, 'Contents'));
      fs.renameSync(path.join(dirs.previous, 'Contents'), contents);
      // The restart after a rollback stops the failed release, whose pid is
      // the one launchd runs now; the helper does not know it, so it asks
      // launchd's job to stop through the service's own pid file.
      opts.pid = readServicePid(opts.runDir) ?? opts.pid;
    },
    log: opts.log
  });
}

/** `ops serve` writes its pid beside the socket, for the update helper. */
export function servicePidFile(runDir: string): string {
  return path.join(runDir, 'ops.pid');
}

function readServicePid(runDir: string): number | null {
  try {
    const pid = Number(fs.readFileSync(servicePidFile(runDir), 'utf-8').trim());
    return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}
